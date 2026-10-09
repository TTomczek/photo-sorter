const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isIP } = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const exifr = require('exifr');
const QRCode = require('qrcode');
const { PasskeyService } = require('./passkeys');
const {
  PHASH_MAX_DISTANCE,
  analyzeImage,
  fileSha256,
  hashBuckets,
  hashDistance,
} = require('./photo-health');

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.png',
  '.tif', '.tiff', '.webp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.3gp', '.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.mts', '.webm', '.wmv',
]);
const CATEGORIES = new Set(['keep', 'delete', 'unsure', 'unseen']);
const REVIEW_CATEGORIES = new Set([...CATEGORIES, 'all', 'review']);
const OUTPUT_MARKER = '.photo-sorter-output';
const SORT_ORDERS = new Set(['capture-asc', 'capture-desc', 'filename', 'date-asc', 'date-desc']);
const MAX_STORED_SCAN_ERRORS = 500;
const RECURSIVE_WATCH_UNSUPPORTED = new Set([
  'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
  'ERR_FS_WATCH_RECURSIVE_NOT_SUPPORTED',
]);

function isRecursiveWatchUnsupported(error) {
  return RECURSIVE_WATCH_UNSUPPORTED.has(error.code)
    || /recursive.{0,30}(not supported|unsupported)|(?:not supported|unsupported).{0,30}recursive/i.test(error.message);
}

function normalizeCaptureDate(metadata) {
  const value = metadata?.DateTimeOriginal || metadata?.CreateDate || metadata?.DateCreated;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isOutputRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized.startsWith('deleted/') || normalized.startsWith('unsure/');
}

async function readCaptureDate(filename) {
  try {
    const metadata = await withExifReader(
      filename,
      ['DateTimeOriginal', 'CreateDate', 'DateCreated'],
      (reader) => reader.parse(),
    );
    return normalizeCaptureDate(metadata);
  } catch {
    return null;
  }
}

async function withExifReader(filename, options, read) {
  const reader = new exifr.Exifr(options);
  let closing;
  try {
    await reader.read(filename);
    if (reader.file?.close) {
      const close = reader.file.close.bind(reader.file);
      reader.file.close = () => {
        closing ||= close();
        return closing;
      };
    }
    return await read(reader);
  } finally {
    if (reader.file?.close) await (closing || reader.file.close());
  }
}

function defaultDataDirectory() {
  if (process.env.PHOTO_SORTER_DATA_DIR) return path.resolve(process.env.PHOTO_SORTER_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'photo-sorter');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'photo-sorter');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'photo-sorter');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsOverlap(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

function comparePaths(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isLocalNetworkAddress(address) {
  if (isIP(address) === 6) return /^(fc|fd|fe[89ab])/i.test(address);
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 192 && second === 168
    || first === 172 && second >= 16 && second <= 31
    || first === 169 && second === 254;
}

function numberedDestination(destination, exists) {
  const extension = path.extname(destination);
  const stem = destination.slice(0, destination.length - extension.length);
  let index = 1;
  let candidate = destination;
  while (exists(candidate)) candidate = `${stem} (${index++})${extension}`;
  return candidate;
}

async function pathExists(filename) {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function moveWithoutOverwrite(source, destination) {
  await fs.link(source, destination);
  await fs.unlink(source);
}

function hasColumn(db, table, columnName) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === columnName);
}

function ensureColumn(db, table, columnName, definition) {
  if (!hasColumn(db, table, columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`);
  }
}

function migrateDatabase(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const currentVersion = db.prepare('PRAGMA user_version').get().user_version;
  const migrations = [
    {
      version: 1,
      apply: () => db.exec(`
        CREATE TABLE IF NOT EXISTS account (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          salt TEXT NOT NULL,
          password_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS roots (
          id TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL REFERENCES collections(id),
          path TEXT NOT NULL,
          online INTEGER NOT NULL DEFAULT 1,
          read_only INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          UNIQUE(collection_id, path)
        );
        CREATE TABLE IF NOT EXISTS scan_jobs (
          root_id TEXT PRIMARY KEY REFERENCES roots(id),
          status TEXT NOT NULL,
          visited INTEGER NOT NULL DEFAULT 0,
          indexed INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES roots(id),
          relative_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          category TEXT,
          unsure_reviewed_at INTEGER NOT NULL DEFAULT 0,
          capture_at TEXT,
          present INTEGER NOT NULL DEFAULT 1,
          last_seen_scan TEXT,
          UNIQUE(root_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS media_root_category ON media(root_id, category);
        CREATE TABLE IF NOT EXISTS device_state (
          device_id TEXT NOT NULL,
          collection_id TEXT NOT NULL REFERENCES collections(id),
          category TEXT NOT NULL DEFAULT 'unseen',
          sort_order TEXT NOT NULL DEFAULT 'capture-asc',
          media_id TEXT,
          page_offset INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(device_id, collection_id)
        );
        CREATE TABLE IF NOT EXISTS media_locks (
          media_id TEXT PRIMARY KEY REFERENCES media(id),
          device_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS decision_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          media_id TEXT NOT NULL REFERENCES media(id),
          device_id TEXT NOT NULL,
          previous_category TEXT,
          next_category TEXT,
          undone INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS decision_history_device ON decision_history(device_id, id DESC);
        CREATE TABLE IF NOT EXISTS device_preferences (
          device_id TEXT NOT NULL,
          preference_key TEXT NOT NULL,
          preference_value TEXT NOT NULL,
          PRIMARY KEY(device_id, preference_key)
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS preview_cache (
          cache_key TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          size INTEGER NOT NULL,
          last_accessed INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apply_batches (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apply_operations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL REFERENCES apply_batches(id),
          media_id TEXT NOT NULL,
          root_id TEXT NOT NULL,
          from_path TEXT NOT NULL,
          to_path TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          operation_type TEXT NOT NULL DEFAULT 'move',
          reverses_operation_id INTEGER
        );
      `),
    },
    {
      version: 2,
      apply: () => {
        ensureColumn(db, 'roots', 'active', 'INTEGER NOT NULL DEFAULT 1');
        ensureColumn(db, 'media', 'capture_at', 'TEXT');
        ensureColumn(db, 'media', 'unsure_reviewed_at', 'INTEGER NOT NULL DEFAULT 0');
        ensureColumn(db, 'media', 'present', 'INTEGER NOT NULL DEFAULT 1');
        ensureColumn(db, 'media', 'last_seen_scan', 'TEXT');
        ensureColumn(db, 'apply_operations', 'operation_type', "TEXT NOT NULL DEFAULT 'move'");
        ensureColumn(db, 'apply_operations', 'reverses_operation_id', 'INTEGER');
        db.exec(`
          CREATE INDEX IF NOT EXISTS media_capture_order
          ON media(root_id, category, COALESCE(julianday(capture_at), modified_at / 86400000.0 + 2440587.5),
            modified_at, relative_path COLLATE NOCASE) WHERE present = 1;
          CREATE INDEX IF NOT EXISTS media_modified_order
          ON media(root_id, category, modified_at, relative_path COLLATE NOCASE) WHERE present = 1;
          CREATE INDEX IF NOT EXISTS media_filename_order
          ON media(root_id, category, relative_path COLLATE NOCASE) WHERE present = 1;
          CREATE INDEX IF NOT EXISTS media_review_order
          ON media(root_id, category, unsure_reviewed_at) WHERE present = 1;
          INSERT OR IGNORE INTO app_settings(setting_key, setting_value) VALUES ('default_sort', 'capture-asc');
          INSERT OR IGNORE INTO app_settings(setting_key, setting_value) VALUES ('preview_cache_limit_mb', '2048');
        `);
      },
    },
    {
      version: 3,
      apply: () => {
        ensureColumn(db, 'media', 'kind', "TEXT NOT NULL DEFAULT 'image'");
        ensureColumn(db, 'scan_jobs', 'error_count', 'INTEGER NOT NULL DEFAULT 0');
        db.exec(`
          UPDATE media SET kind = CASE
            WHEN lower(relative_path) GLOB '*.3gp' OR lower(relative_path) GLOB '*.avi'
              OR lower(relative_path) GLOB '*.m4v' OR lower(relative_path) GLOB '*.mkv'
              OR lower(relative_path) GLOB '*.mov' OR lower(relative_path) GLOB '*.mp4'
              OR lower(relative_path) GLOB '*.mpeg' OR lower(relative_path) GLOB '*.mpg'
              OR lower(relative_path) GLOB '*.mts' OR lower(relative_path) GLOB '*.webm'
              OR lower(relative_path) GLOB '*.wmv' THEN 'video' ELSE 'image' END;
          CREATE TABLE IF NOT EXISTS scan_errors (
            root_id TEXT NOT NULL REFERENCES roots(id),
            path TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(root_id, path)
          );
          CREATE INDEX IF NOT EXISTS media_kind_filter ON media(root_id, kind, category) WHERE present = 1;
          CREATE INDEX IF NOT EXISTS media_path_search ON media(relative_path COLLATE NOCASE) WHERE present = 1;
        `);
      },
    },
    {
      version: 4,
      apply: () => db.exec(`
        CREATE TABLE IF NOT EXISTS photo_health_settings (
          collection_id TEXT PRIMARY KEY REFERENCES collections(id),
          enabled INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS photo_health_items (
          media_id TEXT PRIMARY KEY REFERENCES media(id),
          size INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          sha256 TEXT,
          phash TEXT,
          width INTEGER,
          height INTEGER,
          blur_score REAL,
          is_blurry INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          analyzed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS photo_health_hash
          ON photo_health_items(sha256, kind, status);
        CREATE TABLE IF NOT EXISTS photo_health_groups (
          id TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL REFERENCES collections(id),
          match_type TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS photo_health_groups_collection
          ON photo_health_groups(collection_id, match_type, id);
        CREATE TABLE IF NOT EXISTS photo_health_members (
          media_id TEXT PRIMARY KEY REFERENCES media(id),
          group_id TEXT NOT NULL REFERENCES photo_health_groups(id) ON DELETE CASCADE,
          strength REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS photo_health_members_group
          ON photo_health_members(group_id, media_id);
        CREATE TABLE IF NOT EXISTS photo_health_hash_buckets (
          collection_id TEXT NOT NULL REFERENCES collections(id),
          bucket TEXT NOT NULL,
          media_id TEXT NOT NULL REFERENCES media(id),
          PRIMARY KEY(collection_id, bucket, media_id)
        );
        CREATE INDEX IF NOT EXISTS photo_health_hash_bucket_media
          ON photo_health_hash_buckets(media_id);
      `),
    },
  ];
  if (currentVersion > migrations.at(-1).version) {
    throw new Error(`Database schema version ${currentVersion} is newer than this application supports.`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.apply();
      db.exec(`PRAGMA user_version = ${migration.version}; COMMIT`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

class PhotoSorter {
  constructor({
    dataDirectory = defaultDataDirectory(),
    uiDirectory = path.join(__dirname, 'ui'),
    watchFactory = (rootPath, options, listener) => fsSync.watch(rootPath, options, listener),
    scanFs = fs,
    watchFallbackIntervalMs = 300_000,
  } = {}) {
    this.dataDirectory = dataDirectory;
    this.uiDirectory = uiDirectory;
    this.watchFactory = watchFactory;
    this.scanFs = scanFs;
    this.watchFallbackIntervalMs = watchFallbackIntervalMs;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.passkeys = null;
    this.applyPlans = new Map();
    this.activeScans = new Map();
    this.scanQueue = [];
    this.queuedScans = new Set();
    this.pendingScans = new Set();
    this.scanWaiters = new Map();
    this.maxConcurrentScans = 2;
    this.rootWatchers = new Map();
    this.watchModes = new Map();
    this.watchFallbackTimers = new Map();
    this.watchRetryTimers = new Map();
    this.watchRetryAttempts = new Map();
    this.scanDebounceTimers = new Map();
    this.photoHealthTimer = null;
    this.photoHealthBusy = false;
    this.eventStreams = new Set();
    this.closed = false;
    this.db = null;
    this.server = null;
    this.servers = [];
    this.port = null;
  }

  async initialize() {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dataDirectory, 'photo-sorter.sqlite'));
    migrateDatabase(this.db);
    this.db.prepare("UPDATE photo_health_items SET status = 'pending' WHERE status = 'processing'").run();
    this.passkeys = new PasskeyService(this.db);
    await this.recoverApplyOperations();
    this.photoHealthTimer = setInterval(() => {
      this.processPhotoHealthQueue().catch((error) => {
        if (!this.closed) console.error('Photo Health analysis failed:', error);
      });
    }, 250);
    this.photoHealthTimer.unref();
    setImmediate(() => {
      if (this.closed || !this.db) return;
      const roots = this.db.prepare(`
        SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
        WHERE r.active = 1 AND c.active = 1
      `).all();
      for (const root of roots) this.startScan(root.id);
      for (const root of roots) this.watchRoot(root.id);
    });
    return this;
  }

  async recoverApplyOperations() {
    const pending = this.db.prepare("SELECT * FROM apply_operations WHERE status = 'planned'").all();
    for (const operation of pending) {
      try {
        const root = this.db.prepare('SELECT path FROM roots WHERE id = ?').get(operation.root_id)?.path;
        if (!root || !isWithin(root, operation.from_path) || !isWithin(root, operation.to_path)) {
          throw new Error('Journal paths are outside the registered root.');
        }
        const canonicalRoot = await fs.realpath(root);
        if (!comparePaths(canonicalRoot, root)) throw new Error('Registered root no longer resolves to its original directory.');
        for (const filename of [operation.from_path, operation.to_path]) {
          const parent = await fs.realpath(path.dirname(filename));
          if (!isWithin(canonicalRoot, parent)) throw new Error('Journal path parent escaped its registered root.');
        }
        const sourceExists = await pathExists(operation.from_path);
        const destinationExists = await pathExists(operation.to_path);
        if (sourceExists) {
          const stat = await fs.lstat(operation.from_path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Journal source is not a regular file.');
        }
        if (destinationExists) {
          const stat = await fs.lstat(operation.to_path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Journal destination is not a regular file.');
        }
        if (!sourceExists && destinationExists) {
          if (operation.operation_type === 'restore') {
            let reversedMove = operation.reverses_operation_id === null
              || operation.reverses_operation_id === undefined
              ? undefined
              : this.db.prepare(`
                SELECT id, status, from_path, to_path FROM apply_operations
                WHERE id = ? AND operation_type = 'move' AND media_id = ? AND root_id = ?
              `).get(operation.reverses_operation_id, operation.media_id, operation.root_id);
            if (!reversedMove || !comparePaths(reversedMove.from_path, operation.to_path)
              || !comparePaths(reversedMove.to_path, operation.from_path)) {
              reversedMove = this.db.prepare(`
                SELECT id, status, from_path, to_path FROM apply_operations
                WHERE operation_type = 'move' AND media_id = ? AND root_id = ?
                  AND status IN ('completed', 'restored')
                ORDER BY id DESC
              `).all(operation.media_id, operation.root_id)
                .find((candidate) => comparePaths(candidate.from_path, operation.to_path)
                  && comparePaths(candidate.to_path, operation.from_path));
            }
            if (!reversedMove || !['completed', 'restored'].includes(reversedMove.status)) {
              throw new Error('Restore journal does not reference a completed move.');
            }
            if (reversedMove.status === 'completed') {
              this.db.prepare("UPDATE apply_operations SET status = 'restored' WHERE id = ?")
                .run(reversedMove.id);
            }
          }
          this.db.prepare("UPDATE apply_operations SET status = 'completed' WHERE id = ?").run(operation.id);
          this.db.prepare('UPDATE media SET relative_path = ?, present = 1 WHERE id = ?')
            .run(path.relative(root, operation.to_path), operation.media_id);
          this.log(operation.operation_type === 'restore' ? 'restore_recovered' : 'apply_recovered', {
            batchId: operation.batch_id, mediaId: operation.media_id, status: 'completed',
          });
        } else {
          const reason = sourceExists && destinationExists
            ? 'Both paths exist; preserving both because the interrupted link cannot be attributed safely.'
            : 'Neither path exists.';
          this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(operation.id);
          this.log(operation.operation_type === 'restore' ? 'restore_recovered' : 'apply_recovered', {
            batchId: operation.batch_id, mediaId: operation.media_id, status: 'failed', reason,
          });
        }
      } catch (error) {
        this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(operation.id);
        this.log(operation.operation_type === 'restore' ? 'restore_recovered' : 'apply_recovered', {
          batchId: operation.batch_id, mediaId: operation.media_id, status: 'failed', reason: error.message,
        });
      }
    }
  }

  close() {
    this.closed = true;
    if (this.photoHealthTimer) clearInterval(this.photoHealthTimer);
    this.photoHealthTimer = null;
    for (const stream of this.eventStreams) {
      clearInterval(stream.heartbeat);
      stream.response.end();
    }
    this.eventStreams.clear();
    for (const watcher of this.rootWatchers.values()) watcher.close();
    this.rootWatchers.clear();
    for (const timer of this.watchFallbackTimers.values()) clearInterval(timer);
    this.watchFallbackTimers.clear();
    this.watchModes.clear();
    for (const timer of this.watchRetryTimers.values()) clearTimeout(timer);
    this.watchRetryTimers.clear();
    this.watchRetryAttempts.clear();
    for (const timer of this.scanDebounceTimers.values()) clearTimeout(timer);
    this.scanDebounceTimers.clear();
    const closingServers = this.servers.map((server) => new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(resolve);
    }));
    const now = new Date().toISOString();
    if (this.db) {
      this.db.prepare(`
        UPDATE scan_jobs SET status = 'cancelled', completed_at = ?
        WHERE status IN ('queued', 'running')
      `).run(now);
    }
    for (const rootId of this.queuedScans) {
      this.scanWaiters.get(rootId)?.resolve(0);
      this.scanWaiters.delete(rootId);
    }
    this.queuedScans.clear();
    this.scanQueue = [];
    this.pendingScans.clear();
    const closeDatabase = () => {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    };
    if (this.activeScans.size || closingServers.length) {
      return Promise.allSettled([...this.activeScans.values(), ...closingServers]).then(closeDatabase);
    }
    closeDatabase();
    return Promise.resolve();
  }

  log(action, details) {
    this.db.prepare('INSERT INTO audit(action, details, created_at) VALUES (?, ?, ?)')
      .run(action, JSON.stringify(details), new Date().toISOString());
  }

  publishQueueChange(collectionId = null) {
    const payload = `event: queue\ndata: ${JSON.stringify({ collectionId })}\n\n`;
    for (const stream of this.eventStreams) {
      if (stream.collectionId && collectionId && stream.collectionId !== collectionId) continue;
      if (stream.response.destroyed || stream.response.writableEnded) continue;
      stream.response.write(payload);
    }
  }

  closeEventStreamsForSession(token) {
    for (const stream of this.eventStreams) {
      if (stream.token !== token) continue;
      clearInterval(stream.heartbeat);
      this.eventStreams.delete(stream);
      if (!stream.response.destroyed && !stream.response.writableEnded) {
        stream.response.write('event: auth-expired\ndata: {}\n\n');
      }
      stream.response.end();
    }
  }

  isSetupComplete() {
    return Boolean(this.db.prepare('SELECT id FROM account WHERE id = 1').get());
  }

  async createPassword(password) {
    if (this.isSetupComplete()) throw new Error('Password setup has already been completed.');
    this.validatePassword(password);
    const credentials = await this.derivePasswordCredentials(password);
    this.db.prepare('INSERT INTO account(id, salt, password_hash) VALUES (1, ?, ?)')
      .run(credentials.salt, credentials.passwordHash);
    this.log('account_created', {});
  }

  async derivePasswordCredentials(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString('hex')));
    });
    return { salt, passwordHash: hash };
  }

  validatePassword(password) {
    if (typeof password !== 'string' || Array.from(password).length < 12) {
      throw new Error('Use a password of at least 12 characters.');
    }
    if (Buffer.byteLength(password) > 1024) throw new Error('Password must not exceed 1024 bytes.');
    if (!/\p{Lu}/u.test(password) || !/\p{Ll}/u.test(password)
      || !/\p{N}/u.test(password) || !/[^\p{L}\p{N}\s]/u.test(password)) {
      throw new Error('Password must include an uppercase letter, a lowercase letter, a number, and a special character.');
    }
  }

  async authenticate(password) {
    const account = this.db.prepare('SELECT salt, password_hash FROM account WHERE id = 1').get();
    if (!account || typeof password !== 'string') return false;
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, account.salt, 64, (error, derived) => error ? reject(error) : resolve(derived));
    });
    return crypto.timingSafeEqual(actual, Buffer.from(account.password_hash, 'hex'));
  }

  async changePassword(currentPassword, newPassword) {
    if (!await this.authenticate(currentPassword)) {
      throw Object.assign(new Error('Current password is incorrect.'), { status: 401 });
    }
    this.validatePassword(newPassword);
    const credentials = await this.derivePasswordCredentials(newPassword);
    this.db.prepare('UPDATE account SET salt = ?, password_hash = ? WHERE id = 1')
      .run(credentials.salt, credentials.passwordHash);
    this.log('password_changed', {});
  }

  createCollection(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      throw new Error('Collection name must be between 1 and 80 characters.');
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO collections(id, name, created_at) VALUES (?, ?, ?)')
      .run(id, name.trim(), new Date().toISOString());
    this.log('collection_created', { collectionId: id, name: name.trim() });
    return id;
  }

  listCollections() {
    return this.db.prepare(`
      SELECT c.id, c.name, c.active,
        (SELECT COUNT(*) FROM media m JOIN roots r ON r.id = m.root_id WHERE r.collection_id = c.id AND r.active = 1 AND m.present = 1) AS item_count,
        (SELECT COUNT(*) FROM roots r WHERE r.collection_id = c.id AND r.active = 1 AND r.online = 0) AS offline_roots
      FROM collections c WHERE c.active = 1 ORDER BY c.created_at
    `).all();
  }

  listRoots(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    return this.db.prepare(`
      SELECT id, path, online, read_only FROM roots
      WHERE collection_id = ? AND active = 1 ORDER BY path COLLATE NOCASE
    `).all(collectionId);
  }

  watchRoot(rootId) {
    if (this.closed || this.rootWatchers.has(rootId) || this.watchFallbackTimers.has(rootId)) return;
    this.watchModes.set(rootId, { mode: 'starting', error: null });
    const root = this.db.prepare(`
      SELECT r.path FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId);
    if (!root) return;
    try {
      const watcher = this.watchFactory(root.path, { recursive: true }, () => this.scheduleScan(rootId));
      watcher.on('error', (error) => {
        watcher.close();
        if (this.rootWatchers.get(rootId) === watcher) this.rootWatchers.delete(rootId);
        if (isRecursiveWatchUnsupported(error)) this.startWatchFallback(rootId, root.path, error);
        else this.scheduleWatchRetry(rootId, root.path, error);
      });
      this.rootWatchers.set(rootId, watcher);
      this.watchModes.set(rootId, { mode: 'recursive', error: null });
      clearTimeout(this.watchRetryTimers.get(rootId));
      this.watchRetryTimers.delete(rootId);
      this.watchRetryAttempts.delete(rootId);
      this.log('watch_ready', { rootId, path: root.path, mode: 'recursive' });
    } catch (error) {
      if (isRecursiveWatchUnsupported(error)) this.startWatchFallback(rootId, root.path, error);
      else this.scheduleWatchRetry(rootId, root.path, error);
    }
  }

  startWatchFallback(rootId, rootPath, error) {
    if (this.closed || this.watchFallbackTimers.has(rootId)) return;
    const active = this.db?.prepare(`
      SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId);
    if (!active) return;
    clearTimeout(this.watchRetryTimers.get(rootId));
    this.watchRetryTimers.delete(rootId);
    this.watchModes.set(rootId, { mode: 'polling', error: error.message });
    this.log('watch_fallback', {
      rootId, path: rootPath, message: error.message, intervalMs: this.watchFallbackIntervalMs,
    });
    const timer = setInterval(() => {
      if (this.closed) return;
      try {
        this.startScan(rootId);
      } catch (scanError) {
        this.log('watch_poll_error', { rootId, path: rootPath, message: scanError.message });
      }
    }, this.watchFallbackIntervalMs);
    timer.unref?.();
    this.watchFallbackTimers.set(rootId, timer);
  }

  scheduleWatchRetry(rootId, rootPath, error) {
    if (this.closed || this.watchRetryTimers.has(rootId)) return;
    const active = this.db?.prepare(`
      SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId);
    if (!active) return;
    const attempt = (this.watchRetryAttempts.get(rootId) || 0) + 1;
    this.watchRetryAttempts.set(rootId, attempt);
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempt - 1, 6)));
    this.watchModes.set(rootId, { mode: 'retrying', error: error.message, retryInMs: delay });
    this.log('watch_error', { rootId, path: rootPath, message: error.message, retryInMs: delay });
    const timer = setTimeout(() => {
      this.watchRetryTimers.delete(rootId);
      this.watchRoot(rootId);
    }, delay);
    timer.unref?.();
    this.watchRetryTimers.set(rootId, timer);
  }

  scheduleScan(rootId) {
    if (this.closed) return;
    const root = this.db.prepare(`
      SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId);
    if (!root) return;
    clearTimeout(this.scanDebounceTimers.get(rootId));
    const timer = setTimeout(() => {
      this.scanDebounceTimers.delete(rootId);
      if (!this.closed) this.startScan(rootId);
    }, 500);
    this.scanDebounceTimers.set(rootId, timer);
  }

  closeRootWatcher(rootId) {
    this.rootWatchers.get(rootId)?.close();
    this.rootWatchers.delete(rootId);
    clearTimeout(this.watchRetryTimers.get(rootId));
    this.watchRetryTimers.delete(rootId);
    this.watchRetryAttempts.delete(rootId);
    clearInterval(this.watchFallbackTimers.get(rootId));
    this.watchFallbackTimers.delete(rootId);
    this.watchModes.delete(rootId);
    clearTimeout(this.scanDebounceTimers.get(rootId));
    this.scanDebounceTimers.delete(rootId);
  }

  async removeRoot(collectionId, rootId) {
    const root = this.db.prepare(`
      SELECT r.id, r.path FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.collection_id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId, collectionId);
    if (!root) throw new Error('Root not found.');
    this.db.prepare('UPDATE roots SET active = 0 WHERE id = ?').run(rootId);
    this.closeRootWatcher(rootId);
    this.db.prepare('DELETE FROM media_locks WHERE media_id IN (SELECT id FROM media WHERE root_id = ?)').run(rootId);
    this.log('root_removed', { collectionId, rootId, path: root.path });
    return { removed: true };
  }

  archiveCollection(collectionId) {
    const collection = this.db.prepare('SELECT id, name FROM collections WHERE id = ? AND active = 1').get(collectionId);
    if (!collection) throw new Error('Collection not found.');
    this.db.prepare('UPDATE collections SET active = 0 WHERE id = ?').run(collectionId);
    for (const root of this.db.prepare('SELECT id FROM roots WHERE collection_id = ?').all(collectionId)) {
      this.closeRootWatcher(root.id);
    }
    this.log('collection_archived', { collectionId, name: collection.name });
    return { archived: true };
  }

  restoreCollection(collectionId) {
    const collection = this.db.prepare('SELECT id, name FROM collections WHERE id = ? AND active = 0').get(collectionId);
    if (!collection) throw new Error('Archived collection not found.');
    const roots = this.db.prepare('SELECT id, path FROM roots WHERE collection_id = ? AND active = 1').all(collectionId);
    const activeRoots = this.db.prepare(`
      SELECT r.id, r.path FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.active = 1 AND c.active = 1
    `).all();
    for (const candidate of roots) {
      for (const activeRoot of activeRoots) {
        if (pathsOverlap(candidate.path, activeRoot.path)) {
          throw new Error(`Cannot restore collection because root ${candidate.path} overlaps an active collection.`);
        }
      }
    }
    this.db.prepare('UPDATE collections SET active = 1 WHERE id = ?').run(collectionId);
    for (const root of roots) {
      this.watchRoot(root.id);
      this.startScan(root.id);
    }
    this.log('collection_restored', { collectionId, name: collection.name });
    return { restored: true };
  }

  listArchivedCollections() {
    return this.db.prepare(`
      SELECT id, name, created_at FROM collections WHERE active = 0 ORDER BY created_at
    `).all();
  }

  getLastCollection(deviceId) {
    const value = this.db.prepare(`
      SELECT preference_value FROM device_preferences
      WHERE device_id = ? AND preference_key = 'last_collection_id'
    `).get(deviceId)?.preference_value;
    return value || null;
  }

  setLastCollection(deviceId, collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    this.db.prepare(`
      INSERT INTO device_preferences(device_id, preference_key, preference_value)
      VALUES (?, 'last_collection_id', ?)
      ON CONFLICT(device_id, preference_key) DO UPDATE SET preference_value = excluded.preference_value
    `).run(deviceId, collectionId);
    return { collectionId };
  }

  getSettings() {
    const settings = Object.fromEntries(this.db.prepare('SELECT setting_key, setting_value FROM app_settings')
      .all().map((row) => [row.setting_key, row.setting_value]));
    return {
      defaultSort: settings.default_sort || 'capture-asc',
      previewCacheLimitMb: Number(settings.preview_cache_limit_mb || 2048),
    };
  }

  async saveSettings(values) {
    const { defaultSort, previewCacheLimitMb } = values;
    if (!['capture-asc', 'capture-desc', 'filename'].includes(defaultSort)
      || !Number.isSafeInteger(previewCacheLimitMb) || previewCacheLimitMb < 0 || previewCacheLimitMb > 102_400) {
      throw new Error('Invalid settings.');
    }
    this.db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?')
      .run(defaultSort, 'default_sort');
    this.db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?')
      .run(String(previewCacheLimitMb), 'preview_cache_limit_mb');
    await this.enforcePreviewCacheLimit();
    this.log('settings_changed', { defaultSort, previewCacheLimitMb });
    return this.getSettings();
  }

  async enforcePreviewCacheLimit() {
    const limitMb = this.getSettings().previewCacheLimitMb;
    let size = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS size FROM preview_cache').get().size;
    const candidates = this.db.prepare(`
      SELECT cache_key, filename, size FROM preview_cache ORDER BY last_accessed ASC
    `).all();
    for (const entry of candidates) {
      if (size <= limitMb * 1024 * 1024) break;
      this.db.prepare('DELETE FROM preview_cache WHERE cache_key = ?').run(entry.cache_key);
      if (/^[0-9a-f]{64}\.jpg$/.test(entry.filename)) {
        await fs.rm(path.join(this.dataDirectory, 'previews', entry.filename), { force: true });
      }
      size -= entry.size;
    }
  }

  async getPreview(mediaId) {
    const item = this.mediaPath(mediaId);
    if (!item) return null;
    let resolved;
    try {
      const root = await fs.realpath(item.path);
      if (!comparePaths(root, item.path) || !isWithin(root, item.fullPath)) return null;
      resolved = await fs.realpath(item.fullPath);
      if (!isWithin(root, resolved)) return null;
    } catch {
      return null;
    }
    const stat = await fs.stat(resolved);
    const extension = path.extname(resolved).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(extension);
    if (!isImage && !VIDEO_EXTENSIONS.has(extension)) return null;
    const cacheKey = crypto.createHash('sha256')
      .update(`${item.id}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
    const cached = this.db.prepare('SELECT filename, size FROM preview_cache WHERE cache_key = ?').get(cacheKey);
    if (cached && /^[0-9a-f]{64}\.jpg$/.test(cached.filename)) {
      try {
        const cachedPath = path.join(this.dataDirectory, 'previews', cached.filename);
        const cachedStat = await fs.lstat(cachedPath);
        if (!cachedStat.isFile() || cachedStat.size !== cached.size) throw new Error('Cached preview is invalid.');
        const buffer = await fs.readFile(cachedPath);
        this.db.prepare('UPDATE preview_cache SET last_accessed = ? WHERE cache_key = ?').run(Date.now(), cacheKey);
        return buffer;
      } catch {
        this.db.prepare('DELETE FROM preview_cache WHERE cache_key = ?').run(cacheKey);
        if (/^[0-9a-f]{64}\.jpg$/.test(cached.filename)) {
          await fs.rm(path.join(this.dataDirectory, 'previews', cached.filename), { force: true });
        }
      }
    }
    if (!isImage) return null;
    const thumbnail = await withExifReader(
      resolved,
      exifr.thumbnailOnlyOptions,
      (reader) => reader.extractThumbnail(),
    ).catch(() => null);
    if (!thumbnail) return null;
    const buffer = Buffer.from(thumbnail);
    if (!buffer.length || buffer.length > 50 * 1024 * 1024) return null;
    const limitMb = this.getSettings().previewCacheLimitMb;
    if (limitMb === 0) return buffer;
    const directory = path.join(this.dataDirectory, 'previews');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${cacheKey}.jpg`;
    const filenamePath = path.join(directory, filename);
    try {
      await fs.writeFile(filenamePath, buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO preview_cache(cache_key, filename, size, last_accessed)
      VALUES (?, ?, ?, ?)
    `).run(cacheKey, filename, buffer.length, Date.now());
    await this.enforcePreviewCacheLimit();
    const current = this.db.prepare('SELECT 1 FROM preview_cache WHERE cache_key = ?').get(cacheKey);
    if (!current) await fs.rm(filenamePath, { force: true });
    return buffer;
  }

  async saveGeneratedPreview(mediaId, buffer, expectedVersion) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > 8 * 1024 * 1024
      || buffer[0] !== 0xff || buffer[1] !== 0xd8
      || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
      throw Object.assign(new Error('Generated preview must be a valid-sized JPEG image.'), { status: 400 });
    }
    const item = this.mediaPath(mediaId);
    if (!item) throw Object.assign(new Error('Media item not found.'), { status: 404 });
    if (expectedVersion !== `${item.size}:${item.modified_at}`) {
      throw Object.assign(new Error('Media changed; rescan before generating a preview.'), { status: 409 });
    }
    const extension = path.extname(item.fullPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
      throw Object.assign(new Error('Only photo and video previews can be generated.'), { status: 415 });
    }
    const root = await fs.realpath(item.path);
    if (!comparePaths(root, item.path) || !isWithin(root, item.fullPath)) {
      throw Object.assign(new Error('Registered root no longer resolves to its original directory.'), { status: 403 });
    }
    const resolved = await fs.realpath(item.fullPath);
    if (!isWithin(root, resolved)) {
      throw Object.assign(new Error('Media is outside its registered root.'), { status: 403 });
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size !== item.size || stat.mtimeMs !== item.modified_at) {
      throw Object.assign(new Error('Media changed; rescan before generating a preview.'), { status: 409 });
    }
    const limitMb = this.getSettings().previewCacheLimitMb;
    if (limitMb === 0) return { stored: false };
    const cacheKey = crypto.createHash('sha256')
      .update(`${item.id}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
    const directory = path.join(this.dataDirectory, 'previews');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${cacheKey}.jpg`;
    const filenamePath = path.join(directory, filename);
    let storedSize = buffer.length;
    try {
      await fs.writeFile(filenamePath, buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      storedSize = (await fs.stat(filenamePath)).size;
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO preview_cache(cache_key, filename, size, last_accessed)
      VALUES (?, ?, ?, ?)
    `).run(cacheKey, filename, storedSize, Date.now());
    await this.enforcePreviewCacheLimit();
    return {
      stored: Boolean(this.db.prepare('SELECT 1 FROM preview_cache WHERE cache_key = ?').get(cacheKey)),
    };
  }

  async addRoot(collectionId, selectedPath, { waitForScan = true } = {}) {
    const collection = this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId);
    if (!collection) throw new Error('Collection not found.');
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) throw new Error('Invalid selected folder.');
    const canonicalPath = await fs.realpath(selectedPath);
    const rootStat = await fs.stat(canonicalPath);
    if (!rootStat.isDirectory()) throw new Error('Selected path is not a directory.');
    const activeRoots = this.db.prepare(`
      SELECT r.id, r.path, r.collection_id FROM roots r
      JOIN collections c ON c.id = r.collection_id WHERE c.active = 1 AND r.active = 1
    `).all();
    for (const root of activeRoots) {
      if (!pathsOverlap(root.path, canonicalPath)) continue;
      if (root.collection_id === collectionId && comparePaths(root.path, canonicalPath)) return root.id;
      throw new Error('This folder overlaps a root in an active collection.');
    }
    const retainedRoot = this.db.prepare(`
      SELECT id FROM roots WHERE collection_id = ? AND path = ? AND active = 0
    `).get(collectionId, canonicalPath);
    if (retainedRoot) {
      this.db.prepare('UPDATE roots SET active = 1, online = 1, read_only = ? WHERE id = ?')
        .run((rootStat.mode & 0o222) === 0 ? 1 : 0, retainedRoot.id);
      this.log('root_readded', { collectionId, rootId: retainedRoot.id, path: canonicalPath });
      this.watchRoot(retainedRoot.id);
      if (waitForScan) await this.scanRoot(retainedRoot.id);
      else this.startScan(retainedRoot.id);
      return retainedRoot.id;
    }
    const id = crypto.randomUUID();
    const readOnly = (rootStat.mode & 0o222) === 0;
    this.db.prepare('INSERT INTO roots(id, collection_id, path, read_only) VALUES (?, ?, ?, ?)')
      .run(id, collectionId, canonicalPath, readOnly ? 1 : 0);
    this.log('root_added', { collectionId, rootId: id, path: canonicalPath, readOnly });
    this.watchRoot(id);
    if (waitForScan) await this.scanRoot(id);
    else this.startScan(id);
    return id;
  }

  startScan(rootId) {
    if (this.activeScans.has(rootId) || this.queuedScans.has(rootId)) {
      this.pendingScans.add(rootId);
      return { started: false, rootId };
    }
    const root = this.db.prepare('SELECT id FROM roots WHERE id = ? AND active = 1').get(rootId);
    if (!root) throw new Error('Root not found.');
    this.db.prepare(`
      INSERT INTO scan_jobs(root_id, status, visited, indexed, error, started_at, completed_at)
      VALUES (?, 'queued', 0, 0, NULL, NULL, NULL)
      ON CONFLICT(root_id) DO UPDATE SET status = 'queued', visited = 0, indexed = 0,
        error = NULL, started_at = NULL, completed_at = NULL
    `).run(rootId);
    let resolveTask;
    let rejectTask;
    const task = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    task.catch(() => {});
    this.scanWaiters.set(rootId, { task, resolve: resolveTask, reject: rejectTask });
    this.queuedScans.add(rootId);
    this.scanQueue.push(rootId);
    this.pumpScanQueue();
    return { started: true, rootId };
  }

  scanRoot(rootId) {
    if (this.scanWaiters.has(rootId)) return this.scanWaiters.get(rootId).task;
    if (this.activeScans.has(rootId)) return this.activeScans.get(rootId);
    if (!this.queuedScans.has(rootId)) this.startScan(rootId);
    return this.scanWaiters.get(rootId)?.task || Promise.resolve(0);
  }

  pumpScanQueue() {
    while (!this.closed && this.activeScans.size < this.maxConcurrentScans && this.scanQueue.length) {
      const rootId = this.scanQueue.shift();
      this.queuedScans.delete(rootId);
      const waiter = this.scanWaiters.get(rootId);
      if (!waiter) continue;
      const task = new Promise((resolve) => setImmediate(resolve))
        .then(() => this.performScanRoot(rootId))
        .then((result) => {
          waiter.resolve(result);
          return result;
        }, (error) => {
          waiter.reject(error);
          waiter.resolve(0);
          return 0;
        })
        .finally(() => {
          this.activeScans.delete(rootId);
          this.scanWaiters.delete(rootId);
          this.pumpScanQueue();
          if (!this.closed && this.pendingScans.delete(rootId)) this.startScan(rootId);
        });
      this.activeScans.set(rootId, task);
    }
  }

  startCollectionScan(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    const roots = this.db.prepare('SELECT id FROM roots WHERE collection_id = ? AND active = 1').all(collectionId);
    return roots.map((root) => this.startScan(root.id));
  }

  startRootScan(collectionId, rootId) {
    const root = this.db.prepare(`
      SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.collection_id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId, collectionId);
    if (!root) throw new Error('Root not found in this collection.');
    return this.startScan(rootId);
  }

  listScanStatus(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    return this.db.prepare(`
      SELECT r.id AS rootId, r.path, r.online, s.status, s.visited, s.indexed, s.error,
        s.error_count AS errorCount,
        s.started_at AS startedAt, s.completed_at AS completedAt
      FROM roots r LEFT JOIN scan_jobs s ON s.root_id = r.id
      WHERE r.collection_id = ? AND r.active = 1 ORDER BY r.path COLLATE NOCASE
    `).all(collectionId).map((scan) => ({
      ...scan,
      status: scan.status || 'idle',
      visited: scan.visited || 0,
      indexed: scan.indexed || 0,
      errorCount: scan.errorCount || 0,
      watch: this.watchModes.get(scan.rootId) || { mode: 'starting', error: null },
      errors: this.db.prepare(`
        SELECT path, message FROM scan_errors WHERE root_id = ?
        ORDER BY created_at DESC, path COLLATE NOCASE LIMIT 10
      `).all(scan.rootId),
    }));
  }

  getPhotoHealthStatus(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    const settings = this.db.prepare(`
      SELECT enabled, paused, updated_at AS updatedAt
      FROM photo_health_settings WHERE collection_id = ?
    `).get(collectionId);
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN h.status IN ('analyzed', 'unsupported', 'failed')
          AND h.size = m.size AND h.modified_at = m.modified_at THEN 1 ELSE 0 END) AS processed,
        SUM(CASE WHEN h.status = 'unsupported' AND h.size = m.size AND h.modified_at = m.modified_at
          THEN 1 ELSE 0 END) AS unsupported,
        SUM(CASE WHEN h.status = 'failed' AND h.size = m.size AND h.modified_at = m.modified_at
          THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN h.is_blurry = 1 AND h.status = 'analyzed'
          AND h.size = m.size AND h.modified_at = m.modified_at THEN 1 ELSE 0 END) AS blurry
      FROM media m JOIN roots r ON r.id = m.root_id
      LEFT JOIN photo_health_items h ON h.media_id = m.id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1
    `).get(collectionId);
    const errors = this.db.prepare(`
      SELECT m.relative_path AS path, h.status, h.error
      FROM photo_health_items h JOIN media m ON m.id = h.media_id
      JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1
        AND h.status IN ('unsupported', 'failed') AND h.size = m.size AND h.modified_at = m.modified_at
      ORDER BY h.analyzed_at DESC, m.relative_path COLLATE NOCASE LIMIT 10
    `).all(collectionId);
    const total = totals.total || 0;
    const processed = totals.processed || 0;
    return {
      enabled: Boolean(settings?.enabled),
      paused: Boolean(settings?.paused),
      status: !settings?.enabled ? 'disabled' : settings.paused ? 'paused' : total === processed ? 'completed' : 'running',
      total,
      processed,
      pending: Math.max(0, total - processed),
      unsupported: totals.unsupported || 0,
      failed: totals.failed || 0,
      blurry: totals.blurry || 0,
      updatedAt: settings?.updatedAt || null,
      errors,
    };
  }

  setPhotoHealthState(collectionId, action) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    if (!['enable', 'pause', 'resume'].includes(action)) throw new Error('Invalid Photo Health action.');
    const enabled = action === 'enable' ? 1 : 1;
    const paused = action === 'pause' ? 1 : 0;
    this.db.prepare(`
      INSERT INTO photo_health_settings(collection_id, enabled, paused, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET enabled = excluded.enabled,
        paused = excluded.paused, updated_at = excluded.updated_at
    `).run(collectionId, enabled, paused, new Date().toISOString());
    this.log('photo_health_state_changed', { collectionId, action });
    this.publishQueueChange(collectionId);
    return this.getPhotoHealthStatus(collectionId);
  }

  clearPhotoHealthResult(mediaId) {
    const groups = this.db.prepare('SELECT group_id FROM photo_health_members WHERE media_id = ?').all(mediaId);
    for (const { group_id: groupId } of groups) {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM photo_health_members WHERE group_id = ?')
        .get(groupId).count;
      if (count <= 2) this.db.prepare('DELETE FROM photo_health_groups WHERE id = ?').run(groupId);
      else this.db.prepare('DELETE FROM photo_health_members WHERE media_id = ?').run(mediaId);
    }
    this.db.prepare('DELETE FROM photo_health_hash_buckets WHERE media_id = ?').run(mediaId);
  }

  async processPhotoHealthQueue() {
    if (this.closed || this.photoHealthBusy || !this.db) return;
    const state = this.db.prepare(`
      SELECT s.collection_id AS collectionId
      FROM photo_health_settings s JOIN collections c ON c.id = s.collection_id
      WHERE s.enabled = 1 AND s.paused = 0 AND c.active = 1
      ORDER BY s.updated_at, s.collection_id LIMIT 1
    `).get();
    if (!state) return;
    const media = this.db.prepare(`
      SELECT m.id, m.root_id AS rootId, m.relative_path AS relativePath, m.size,
        m.modified_at AS modifiedAt, m.kind, r.path AS rootPath
      FROM media m JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1
        AND NOT EXISTS (
          SELECT 1 FROM photo_health_items h WHERE h.media_id = m.id
            AND h.size = m.size AND h.modified_at = m.modified_at
            AND h.status IN ('analyzed', 'unsupported', 'failed')
        )
      ORDER BY m.root_id, m.relative_path COLLATE NOCASE LIMIT 1
    `).get(state.collectionId);
    if (!media) return;
    this.photoHealthBusy = true;
    try {
      await this.analyzePhotoHealthItem(state.collectionId, media);
    } finally {
      this.photoHealthBusy = false;
    }
  }

  async analyzePhotoHealthItem(collectionId, media) {
    this.clearPhotoHealthResult(media.id);
    this.db.prepare(`
      INSERT INTO photo_health_items(media_id, size, modified_at, kind, status)
      VALUES (?, ?, ?, ?, 'processing')
      ON CONFLICT(media_id) DO UPDATE SET size = excluded.size, modified_at = excluded.modified_at,
        kind = excluded.kind, status = 'processing', sha256 = NULL, phash = NULL, width = NULL,
        height = NULL, blur_score = NULL, is_blurry = 0, error = NULL, analyzed_at = NULL
    `).run(media.id, media.size, media.modifiedAt, media.kind);
    let status = 'failed';
    let errorMessage = null;
    try {
      const canonicalRoot = await fs.realpath(media.rootPath);
      if (!comparePaths(canonicalRoot, media.rootPath)) throw new Error('Registered root no longer resolves to its original directory.');
      const filename = path.resolve(canonicalRoot, media.relativePath);
      if (!isWithin(canonicalRoot, filename)) throw new Error('Indexed path is outside its registered root.');
      const linkStat = await fs.lstat(filename);
      const resolvedPath = await fs.realpath(filename);
      if (!linkStat.isFile() || linkStat.isSymbolicLink() || !isWithin(canonicalRoot, resolvedPath)) {
        throw new Error('Indexed file is no longer a regular file inside its registered root.');
      }
      if (linkStat.size !== media.size || linkStat.mtimeMs !== media.modifiedAt) {
        throw new Error('File changed before analysis. Rescan the collection to update its index.');
      }
      const result = media.kind === 'image'
        ? await analyzeImage(resolvedPath)
        : { sha256: await fileSha256(resolvedPath), phash: null, width: null, height: null, blurScore: null, isBlurry: false };
      const finalStat = await fs.stat(resolvedPath);
      if (finalStat.size !== media.size || finalStat.mtimeMs !== media.modifiedAt) {
        throw new Error('File changed during analysis. Rescan the collection to update its index.');
      }
      if (!this.db.prepare(`
        SELECT 1 FROM photo_health_settings WHERE collection_id = ? AND enabled = 1 AND paused = 0
      `).get(collectionId)) {
        this.db.prepare("UPDATE photo_health_items SET status = 'pending' WHERE media_id = ?").run(media.id);
        return;
      }
      const analyzedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE photo_health_items SET status = 'analyzed', sha256 = ?, phash = ?, width = ?, height = ?,
          blur_score = ?, is_blurry = ?, error = NULL, analyzed_at = ?
        WHERE media_id = ?
      `).run(result.sha256, result.phash, result.width, result.height, result.blurScore,
        result.isBlurry ? 1 : 0, analyzedAt, media.id);
      this.recordPhotoHealthMatches(collectionId, media, result);
      this.log('photo_health_item_analyzed', {
        collectionId, mediaId: media.id, blurry: Boolean(result.isBlurry),
      });
    } catch (error) {
      const unsupported = media.kind === 'image' && !['ENOENT', 'EACCES', 'EPERM'].includes(error.code);
      status = unsupported ? 'unsupported' : 'failed';
      errorMessage = error.message;
      this.db.prepare(`
        UPDATE photo_health_items SET status = ?, error = ?, analyzed_at = ? WHERE media_id = ?
      `).run(status, errorMessage, new Date().toISOString(), media.id);
      this.log('photo_health_item_error', { collectionId, mediaId: media.id, status, error: errorMessage });
    }
    this.publishQueueChange(collectionId);
  }

  recordPhotoHealthMatches(collectionId, media, result) {
    const exactMatches = this.db.prepare(`
      SELECT h.media_id AS mediaId FROM photo_health_items h
      JOIN media m ON m.id = h.media_id JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1 AND m.kind = ?
        AND h.status = 'analyzed' AND h.sha256 = ? AND h.media_id != ?
        AND h.size = m.size AND h.modified_at = m.modified_at
    `).all(collectionId, media.kind, result.sha256, media.id);
    const distances = new Map(exactMatches.map((match) => [match.mediaId, 0]));
    if (media.kind === 'image') {
      const candidates = this.db.prepare(`
        SELECT DISTINCT h.media_id AS mediaId, h.phash, h.width, h.height
        FROM photo_health_hash_buckets b JOIN photo_health_items h ON h.media_id = b.media_id
        JOIN media m ON m.id = h.media_id JOIN roots r ON r.id = m.root_id
        WHERE b.collection_id = ? AND b.bucket IN (?, ?, ?, ?) AND b.media_id != ?
          AND r.active = 1 AND m.present = 1 AND m.kind = 'image' AND h.status = 'analyzed'
          AND h.size = m.size AND h.modified_at = m.modified_at
        LIMIT 500
      `).all(collectionId, ...hashBuckets(result.phash), media.id);
      for (const candidate of candidates) {
        if (distances.has(candidate.mediaId)) continue;
        const oldRatio = candidate.width / candidate.height;
        const newRatio = result.width / result.height;
        if (Math.abs(oldRatio - newRatio) / Math.max(oldRatio, newRatio) > 0.01) continue;
        const distance = hashDistance(result.phash, candidate.phash);
        if (distance <= PHASH_MAX_DISTANCE) distances.set(candidate.mediaId, distance);
      }
      for (const bucket of hashBuckets(result.phash)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO photo_health_hash_buckets(collection_id, bucket, media_id) VALUES (?, ?, ?)
        `).run(collectionId, bucket, media.id);
      }
    }
    if (!distances.size) return;
    const groupIds = new Set();
    for (const mediaId of distances.keys()) {
      const groupId = this.db.prepare('SELECT group_id AS id FROM photo_health_members WHERE media_id = ?').get(mediaId)?.id;
      if (groupId) groupIds.add(groupId);
    }
    const targetGroupId = [...groupIds].sort()[0] || crypto.randomUUID();
    const oldTypes = groupIds.size ? this.db.prepare(`
      SELECT match_type AS matchType FROM photo_health_groups WHERE id IN (${[...groupIds].map(() => '?').join(',')})
    `).all(...groupIds) : [];
    const matchType = distances.has([...distances.keys()].find((id) => distances.get(id) === 0))
      || oldTypes.some((group) => group.matchType === 'exact') ? 'exact' : 'similar';
    this.db.prepare(`
      INSERT OR IGNORE INTO photo_health_groups(id, collection_id, match_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(targetGroupId, collectionId, matchType, new Date().toISOString());
    for (const groupId of groupIds) {
      if (groupId === targetGroupId) continue;
      this.db.prepare('UPDATE photo_health_members SET group_id = ? WHERE group_id = ?').run(targetGroupId, groupId);
      this.db.prepare('DELETE FROM photo_health_groups WHERE id = ?').run(groupId);
    }
    if (matchType === 'exact') {
      this.db.prepare("UPDATE photo_health_groups SET match_type = 'exact' WHERE id = ?").run(targetGroupId);
    }
    for (const [mediaId, distance] of distances) {
      this.db.prepare(`
        INSERT INTO photo_health_members(media_id, group_id, strength) VALUES (?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET group_id = excluded.group_id,
          strength = MAX(photo_health_members.strength, excluded.strength)
      `).run(mediaId, targetGroupId, 1 - (distance / 64));
    }
    this.db.prepare(`
      INSERT INTO photo_health_members(media_id, group_id, strength) VALUES (?, ?, 1)
      ON CONFLICT(media_id) DO UPDATE SET group_id = excluded.group_id, strength = 1
    `).run(media.id, targetGroupId);
  }

  listPhotoHealthFindings(collectionId, {
    type = 'all', handled = 'open', offset = 0, limit = 30,
  } = {}) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    if (!['all', 'duplicate', 'blur'].includes(type)) throw new Error('Invalid Photo Health finding type.');
    if (!['open', 'handled', 'all'].includes(handled)) throw new Error('Invalid handled filter.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid Photo Health page.');
    }
    const duplicateHandled = handled === 'open'
      ? 'AND SUM(CASE WHEN m.category IS NULL THEN 1 ELSE 0 END) > 0'
      : handled === 'handled' ? 'AND SUM(CASE WHEN m.category IS NULL THEN 1 ELSE 0 END) = 0' : '';
    const blurHandled = handled === 'open'
      ? 'AND m.category IS NULL'
      : handled === 'handled' ? 'AND m.category IS NOT NULL' : '';
    const duplicateQuery = type === 'blur' ? `
      SELECT NULL AS groupId, 'duplicate' AS type, NULL AS mediaId, NULL AS reason,
        NULL AS strength, 0 AS memberCount, 0 AS handled, NULL AS label, NULL AS category WHERE 0
    ` : `
      SELECT g.id AS groupId, 'duplicate' AS type, NULL AS mediaId,
        CASE g.match_type WHEN 'exact' THEN 'Exact file match'
          ELSE 'Very similar image framing and content' END AS reason,
        MAX(pm.strength) AS strength, COUNT(*) AS memberCount,
        CASE WHEN SUM(CASE WHEN m.category IS NULL THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END AS handled,
        NULL AS label, NULL AS category
      FROM photo_health_groups g
      JOIN photo_health_members pm ON pm.group_id = g.id
      JOIN media m ON m.id = pm.media_id
      JOIN roots r ON r.id = m.root_id
      JOIN photo_health_items h ON h.media_id = m.id AND h.status = 'analyzed'
        AND h.size = m.size AND h.modified_at = m.modified_at
      WHERE g.collection_id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1
      GROUP BY g.id, g.match_type
      HAVING COUNT(*) >= 2 ${duplicateHandled}
    `;
    const blurQuery = type === 'duplicate' ? `
      SELECT NULL AS groupId, 'blur' AS type, NULL AS mediaId, NULL AS reason,
        NULL AS strength, 0 AS memberCount, 0 AS handled, NULL AS label, NULL AS category WHERE 0
    ` : `
      SELECT NULL AS groupId, 'blur' AS type, m.id AS mediaId,
        'Low edge sharpness (score ' || printf('%.2f', h.blur_score) || ')' AS reason,
        NULL AS strength, 1 AS memberCount, CASE WHEN m.category IS NULL THEN 0 ELSE 1 END AS handled,
        m.relative_path AS label, m.category AS category
      FROM photo_health_items h
      JOIN media m ON m.id = h.media_id JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1 AND m.kind = 'image'
        AND h.status = 'analyzed' AND h.is_blurry = 1 AND h.size = m.size AND h.modified_at = m.modified_at
        ${blurHandled}
    `;
    const query = `
      WITH findings AS (${duplicateQuery} UNION ALL ${blurQuery})
      SELECT * FROM findings ORDER BY type, groupId, mediaId LIMIT ? OFFSET ?
    `;
    const values = [];
    if (type !== 'blur') values.push(collectionId, collectionId);
    if (type !== 'duplicate') values.push(collectionId);
    const items = this.db.prepare(query).all(...values, limit, offset);
    const countQuery = `
      WITH findings AS (${duplicateQuery} UNION ALL ${blurQuery})
      SELECT COUNT(*) AS total FROM findings
    `;
    const total = this.db.prepare(countQuery).get(...values).total;
    return { items, total, offset, limit };
  }

  listPhotoHealthGroup(collectionId, groupId, { offset = 0, limit = 100 } = {}) {
    if (!this.db.prepare(`
      SELECT 1 FROM photo_health_groups WHERE id = ? AND collection_id = ?
    `).get(groupId, collectionId)) throw new Error('Duplicate group not found in this collection.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid Photo Health page.');
    }
    const params = [groupId, collectionId];
    const items = this.db.prepare(`
      SELECT m.id, m.relative_path AS relativePath, m.size, m.modified_at AS modifiedAt,
        m.category, m.kind, pm.strength
      FROM photo_health_members pm JOIN media m ON m.id = pm.media_id
      JOIN roots r ON r.id = m.root_id
      JOIN photo_health_items h ON h.media_id = m.id AND h.status = 'analyzed'
        AND h.size = m.size AND h.modified_at = m.modified_at
      WHERE pm.group_id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1
      ORDER BY m.relative_path COLLATE NOCASE LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM photo_health_members pm JOIN media m ON m.id = pm.media_id
      JOIN roots r ON r.id = m.root_id
      JOIN photo_health_items h ON h.media_id = m.id AND h.status = 'analyzed'
        AND h.size = m.size AND h.modified_at = m.modified_at
      WHERE pm.group_id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1
    `).get(...params).count;
    return { items, total, offset, limit };
  }

  decidePhotoHealthGroup(collectionId, groupId, keepIds, deviceId) {
    if (!Array.isArray(keepIds) || keepIds.length < 1 || keepIds.length > 100
      || keepIds.some((id) => typeof id !== 'string') || new Set(keepIds).size !== keepIds.length) {
      throw new Error('Choose between one and 100 photos to keep.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare(`
        SELECT 1 FROM photo_health_groups WHERE id = ? AND collection_id = ?
      `).get(groupId, collectionId)
        || !this.db.prepare('SELECT 1 FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
        throw new Error('Duplicate group not found in this collection.');
      }
      const memberFilter = `
        FROM photo_health_members pm JOIN media m ON m.id = pm.media_id
        JOIN roots r ON r.id = m.root_id
        JOIN photo_health_items h ON h.media_id = m.id AND h.status = 'analyzed'
          AND h.size = m.size AND h.modified_at = m.modified_at
        WHERE pm.group_id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1
      `;
      const memberCount = this.db.prepare(`SELECT COUNT(*) AS count ${memberFilter}`).get(groupId, collectionId).count;
      const selectedCount = this.db.prepare(`
        SELECT COUNT(*) AS count ${memberFilter} AND m.id IN (${keepIds.map(() => '?').join(',')})
      `).get(groupId, collectionId, ...keepIds).count;
      if (!memberCount || selectedCount !== keepIds.length) {
        throw new Error('Every selected photo must belong to this duplicate group.');
      }
      this.db.prepare('DELETE FROM media_locks WHERE expires_at <= ?').run(Date.now());
      const conflict = this.db.prepare(`
        SELECT l.media_id FROM media_locks l JOIN photo_health_members pm ON pm.media_id = l.media_id
        JOIN media m ON m.id = pm.media_id JOIN roots r ON r.id = m.root_id
        WHERE pm.group_id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1
          AND l.device_id != ? AND l.expires_at > ? LIMIT 1
      `).get(groupId, collectionId, deviceId, Date.now());
      if (conflict) {
        throw Object.assign(new Error('A photo in this duplicate group is being reviewed on another device.'), { status: 409 });
      }
      this.db.prepare('DELETE FROM decision_history WHERE device_id = ? AND undone = 1').run(deviceId);
      const selected = keepIds.map(() => '?').join(',');
      const nextCategory = `CASE WHEN m.id IN (${selected}) THEN 'keep' ELSE 'delete' END`;
      const at = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO decision_history(media_id, device_id, previous_category, next_category, created_at)
        SELECT m.id, ?, m.category, ${nextCategory}, ?
        ${memberFilter} AND COALESCE(m.category, '') != ${nextCategory}
      `).run(deviceId, ...keepIds, at, groupId, collectionId, ...keepIds);
      this.db.prepare(`
        UPDATE media SET category = CASE WHEN id IN (${selected}) THEN 'keep' ELSE 'delete' END
        WHERE id IN (SELECT pm.media_id FROM photo_health_members pm
          JOIN roots r ON r.id = (SELECT root_id FROM media WHERE id = pm.media_id)
          JOIN photo_health_items h ON h.media_id = pm.media_id AND h.status = 'analyzed'
          JOIN media indexed_media ON indexed_media.id = pm.media_id
            AND h.size = indexed_media.size AND h.modified_at = indexed_media.modified_at
          WHERE pm.group_id = ? AND r.collection_id = ? AND r.active = 1)
          AND present = 1
      `).run(...keepIds, groupId, collectionId);
      this.log('photo_health_group_decided', {
        collectionId, groupId, keptCount: keepIds.length, memberCount,
      });
      this.publishQueueChange(collectionId);
      this.db.exec('COMMIT');
      return { changed: true, keptCount: keepIds.length, deletedCount: memberCount - keepIds.length };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async performScanRoot(rootId) {
    const root = this.db.prepare('SELECT * FROM roots WHERE id = ? AND active = 1').get(rootId);
    if (!root) throw new Error('Root not found.');
    this.db.prepare(`
      INSERT INTO scan_jobs(root_id, status, visited, indexed, error_count, started_at)
      VALUES (?, 'running', 0, 0, 0, ?)
      ON CONFLICT(root_id) DO UPDATE SET status = 'running', visited = 0, indexed = 0,
        error = NULL, error_count = 0, started_at = excluded.started_at, completed_at = NULL
    `).run(rootId, new Date().toISOString());
    this.db.prepare('DELETE FROM scan_errors WHERE root_id = ?').run(rootId);
    this.log('scan_started', { rootId, path: root.path });
    let base;
    try {
      base = await this.scanFs.realpath(root.path);
      if (!comparePaths(base, root.path)) throw new Error('Registered root no longer resolves to its original directory.');
      const directories = [base];
      const upsert = this.db.prepare(`
        INSERT INTO media(id, root_id, relative_path, size, modified_at, category, capture_at, present, last_seen_scan, kind)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(root_id, relative_path) DO UPDATE SET
          category = CASE WHEN media.size != excluded.size OR media.modified_at != excluded.modified_at
            THEN NULL ELSE media.category END,
          size = excluded.size, modified_at = excluded.modified_at, capture_at = excluded.capture_at,
          present = 1, last_seen_scan = excluded.last_seen_scan, kind = excluded.kind
      `);
      let entriesVisited = 0;
      let scanErrors = 0;
      let storedScanErrors = 0;
      const scanId = crypto.randomUUID();
      let entriesExamined = 0;
      const recordScanError = (filename, error) => {
        scanErrors += 1;
        if (storedScanErrors < MAX_STORED_SCAN_ERRORS) {
          this.db.prepare(`
            INSERT INTO scan_errors(root_id, path, message, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(root_id, path) DO UPDATE SET message = excluded.message, created_at = excluded.created_at
          `).run(rootId, filename, error.message, new Date().toISOString());
          storedScanErrors += 1;
        }
        this.log('scan_error', { rootId, path: filename, message: error.message });
      };
      const updateProgress = (status, error = null) => {
        this.db.prepare(`
          UPDATE scan_jobs SET status = ?, visited = ?, indexed = ?, error = ?, error_count = ?,
            completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
          WHERE root_id = ?
        `).run(status, entriesExamined, entriesVisited, error, scanErrors,
          status, status === 'running' ? null : new Date().toISOString(), rootId);
        if (status !== 'running' || entriesExamined % 512 === 0) {
          this.publishQueueChange(root.collection_id);
        }
      };
      while (directories.length) {
        if (this.closed || !this.db.prepare('SELECT 1 FROM roots WHERE id = ? AND active = 1').get(rootId)) {
          if (!this.closed) {
            updateProgress('cancelled');
            this.log('scan_cancelled', { rootId, path: base });
          }
          return entriesVisited;
        }
        const directory = directories.pop();
        let entries;
        try {
          const directoryStat = await this.scanFs.lstat(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
            || !isWithin(base, await this.scanFs.realpath(directory))) continue;
          entries = await this.scanFs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          recordScanError(directory, error);
          continue;
        }
        for (const entry of entries) {
          entriesExamined += 1;
          if (entriesExamined % 128 === 0) {
            updateProgress('running');
            await new Promise((resolve) => setImmediate(resolve));
            if (this.closed) return entriesVisited;
          }
          if (entry.isSymbolicLink()) continue;
          const fullPath = path.join(directory, entry.name);
          if (directory === base && (entry.name === 'deleted' || entry.name === 'unsure')) continue;
          if (entry.isDirectory()) {
            directories.push(fullPath);
            continue;
          }
          if (!entry.isFile()) continue;
          const extension = path.extname(entry.name).toLowerCase();
          const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : null;
          if (!kind) continue;
          try {
            const stat = await this.scanFs.lstat(fullPath);
            const resolvedPath = await this.scanFs.realpath(fullPath);
            if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(base, resolvedPath)) continue;
            const relativePath = path.relative(base, fullPath);
            const captureDate = IMAGE_EXTENSIONS.has(extension) ? await readCaptureDate(resolvedPath) : null;
            upsert.run(crypto.createHash('sha256').update(`${rootId}\0${relativePath}`).digest('hex'),
              rootId, relativePath, stat.size, stat.mtimeMs, captureDate, scanId, kind);
            entriesVisited += 1;
          } catch (error) {
            recordScanError(fullPath, error);
          }
        }
      }
      if (this.closed) return entriesVisited;
      if (!this.db.prepare('SELECT 1 FROM roots WHERE id = ? AND active = 1').get(rootId)) {
        updateProgress('cancelled');
        return entriesVisited;
      }
      this.db.prepare('UPDATE roots SET online = 1 WHERE id = ?').run(rootId);
      if (scanErrors === 0) {
        this.db.prepare(`
          UPDATE media SET present = CASE
            WHEN last_seen_scan = ?
              OR relative_path GLOB 'deleted/*' OR relative_path GLOB 'deleted\\*'
              OR relative_path GLOB 'unsure/*' OR relative_path GLOB 'unsure\\*'
            THEN 1 ELSE 0 END
          WHERE root_id = ?
        `).run(scanId, rootId);
      }
      updateProgress('completed');
      this.log('scan_completed', { rootId, path: base, indexed: entriesVisited, errors: scanErrors });
      return entriesVisited;
    } catch (error) {
      if (!this.closed) {
        this.db.prepare('UPDATE roots SET online = 0 WHERE id = ?').run(rootId);
        this.db.prepare('DELETE FROM scan_errors WHERE root_id = ?').run(rootId);
        this.db.prepare(`
          INSERT INTO scan_errors(root_id, path, message, created_at) VALUES (?, ?, ?, ?)
        `).run(rootId, root.path, error.message, new Date().toISOString());
        this.db.prepare(`
          INSERT INTO scan_jobs(root_id, status, error, error_count, started_at, completed_at)
          VALUES (?, 'failed', ?, 1, ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET status = 'failed', error = excluded.error,
            error_count = 1, completed_at = excluded.completed_at
        `).run(rootId, error.message, new Date().toISOString(), new Date().toISOString());
        this.log('scan_error', { rootId, path: root.path, message: error.message });
      }
      throw error;
    }
  }

  async rescanCollection(collectionId) {
    const roots = this.db.prepare('SELECT id FROM roots WHERE collection_id = ? AND active = 1').all(collectionId);
    const results = await Promise.allSettled(roots.map((root) => this.scanRoot(root.id)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), `${failures.length} root scan(s) failed.`);
    }
    return results.reduce((indexed, result) => indexed + result.value, 0);
  }

  listMedia({
    collectionId,
    category,
    sort = 'capture-asc',
    offset = 0,
    limit = 60,
    search = '',
    fromDate = '',
    toDate = '',
    kind = '',
    rootId = '',
  }) {
    const filters = ['r.collection_id = ?', 'r.active = 1', 'c.active = 1', 'm.present = 1'];
    const values = [collectionId];
    if (typeof search !== 'string' || search.length > 160) throw new Error('Invalid search query.');
    const normalizedSearch = search.trim();
    if (normalizedSearch) {
      const escapedSearch = normalizedSearch.replace(/[\\%_]/g, '\\$&');
      filters.push("m.relative_path LIKE ? ESCAPE '\\'");
      values.push(`${escapedSearch}%`);
    }
    const parseFilterDate = (value) => {
      if (value === '') return null;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Invalid date filter.');
      }
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
        throw new Error('Invalid date filter.');
      }
      return timestamp / 86400000 + 2440587.5;
    };
    const fromJulian = parseFilterDate(fromDate);
    const toJulian = parseFilterDate(toDate);
    if (fromJulian !== null && toJulian !== null && fromJulian > toJulian) {
      throw new Error('Start date must be on or before end date.');
    }
    const captureDateExpression = 'COALESCE(julianday(m.capture_at), m.modified_at / 86400000.0 + 2440587.5)';
    if (fromJulian !== null) {
      filters.push(`${captureDateExpression} >= ?`);
      values.push(fromJulian);
    }
    if (toJulian !== null) {
      filters.push(`${captureDateExpression} < ?`);
      values.push(toJulian + 1);
    }
    if (kind) {
      if (!['image', 'video'].includes(kind)) throw new Error('Invalid media type.');
      filters.push('m.kind = ?');
      values.push(kind);
    }
    if (rootId) {
      if (!this.db.prepare(`
        SELECT 1 FROM roots WHERE id = ? AND collection_id = ? AND active = 1
      `).get(rootId, collectionId)) throw new Error('Root not found in this collection.');
      filters.push('r.id = ?');
      values.push(rootId);
    }
    if (category === 'unseen') filters.push('m.category IS NULL');
    else if (category === 'review') filters.push("(m.category IS NULL OR m.category = 'unsure')");
    else if (CATEGORIES.has(category)) {
      filters.push('m.category = ?');
      values.push(category === 'unseen' ? null : category);
    }
    const orderBy = {
      'capture-asc': 'COALESCE(julianday(m.capture_at), m.modified_at / 86400000.0 + 2440587.5) ASC, m.modified_at ASC, m.relative_path COLLATE NOCASE ASC',
      'capture-desc': 'COALESCE(julianday(m.capture_at), m.modified_at / 86400000.0 + 2440587.5) DESC, m.modified_at DESC, m.relative_path COLLATE NOCASE ASC',
      'date-asc': 'm.modified_at ASC, m.relative_path COLLATE NOCASE ASC',
      'date-desc': 'm.modified_at DESC, m.relative_path COLLATE NOCASE ASC',
      filename: 'm.relative_path COLLATE NOCASE ASC',
    }[sort];
    if (!orderBy) throw new Error('Invalid sort order.');
    const reviewOrder = category === 'review'
      ? "CASE WHEN m.category IS NULL THEN 0 ELSE 1 END ASC, m.unsure_reviewed_at ASC, "
      : '';
    const items = this.db.prepare(`
      SELECT m.id, m.relative_path, m.size, m.modified_at, m.capture_at, m.category, m.kind,
        r.online, r.read_only
      FROM media m JOIN roots r ON r.id = m.root_id JOIN collections c ON c.id = r.collection_id
      WHERE ${filters.join(' AND ')}
      ORDER BY ${reviewOrder}${orderBy}
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM media m JOIN roots r ON r.id = m.root_id JOIN collections c ON c.id = r.collection_id
      WHERE ${filters.join(' AND ')}
    `).get(...values).count;
    return { items, total, offset, limit };
  }

  setMediaCategory(mediaId, category) {
    const next = category === 'unseen' ? null : category;
    this.db.prepare(`
      UPDATE media SET category = ?,
        unsure_reviewed_at = CASE WHEN ? = 'unsure'
          THEN MAX(?, COALESCE((SELECT MAX(unsure_reviewed_at) FROM media WHERE category = 'unsure'), 0) + 1)
          ELSE unsure_reviewed_at END
      WHERE id = ?
    `).run(next, category, Date.now(), mediaId);
  }

  setDecision(mediaId, category) {
    if (!CATEGORIES.has(category)) throw new Error('Invalid category.');
    const item = this.db.prepare(`
      SELECT m.category, r.collection_id FROM media m JOIN roots r ON r.id = m.root_id
      JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND r.active = 1 AND c.active = 1 AND m.present = 1
    `).get(mediaId);
    if (!item) throw new Error('Media item not found.');
    this.setMediaCategory(mediaId, category);
    this.log('decision_changed', { mediaId, previous: item.category, category, collectionId: item.collection_id });
  }

  getDeviceState(deviceId, collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    return this.db.prepare(`
      SELECT category,
        CASE sort_order WHEN 'date-asc' THEN 'capture-asc' WHEN 'date-desc' THEN 'capture-desc' ELSE sort_order END AS sort,
        media_id AS mediaId, page_offset AS offset
      FROM device_state WHERE device_id = ? AND collection_id = ?
    `).get(deviceId, collectionId) || null;
  }

  saveDeviceState(deviceId, collectionId, state) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    const category = state.category;
    const sort = state.sort === 'date-asc' ? 'capture-asc'
      : state.sort === 'date-desc' ? 'capture-desc' : state.sort;
    const offset = state.offset;
    if (!REVIEW_CATEGORIES.has(category)
      || !SORT_ORDERS.has(sort)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000) {
      throw new Error('Invalid review position.');
    }
    const mediaId = state.mediaId === null || state.mediaId === '' ? null : state.mediaId;
    if (mediaId !== null && (typeof mediaId !== 'string'
      || !this.db.prepare(`SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id
        WHERE m.id = ? AND r.collection_id = ? AND r.active = 1 AND m.present = 1`)
        .get(mediaId, collectionId))) {
      throw new Error('Media item not found in this collection.');
    }
    this.db.prepare(`
      INSERT INTO device_state(device_id, collection_id, category, sort_order, media_id, page_offset, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, collection_id) DO UPDATE SET
        category = excluded.category, sort_order = excluded.sort_order, media_id = excluded.media_id,
        page_offset = excluded.page_offset, updated_at = excluded.updated_at
    `).run(deviceId, collectionId, category, sort, mediaId, offset, new Date().toISOString());
    return this.getDeviceState(deviceId, collectionId);
  }

  claimMediaLock(mediaId, deviceId) {
    if (!this.db.prepare(`
      SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND m.present = 1 AND r.active = 1 AND c.active = 1
    `).get(mediaId)) {
      throw new Error('Media item not found.');
    }
    const now = Date.now();
    this.db.prepare('DELETE FROM media_locks WHERE expires_at <= ?').run(now);
    this.db.prepare(`
      INSERT INTO media_locks(media_id, device_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET device_id = excluded.device_id, expires_at = excluded.expires_at
      WHERE media_locks.device_id = excluded.device_id OR media_locks.expires_at <= ?
    `).run(mediaId, deviceId, now + 60_000, now);
    const lock = this.db.prepare('SELECT device_id FROM media_locks WHERE media_id = ?').get(mediaId);
    if (lock?.device_id !== deviceId) {
      throw Object.assign(new Error('This item is being reviewed on another device.'), { status: 409 });
    }
    return { locked: true, expiresIn: 60 };
  }

  releaseMediaLock(mediaId, deviceId) {
    this.db.prepare('DELETE FROM media_locks WHERE media_id = ? AND device_id = ?').run(mediaId, deviceId);
    return { released: true };
  }

  setDeviceDecision(mediaId, category, deviceId) {
    const lock = this.db.prepare('SELECT device_id, expires_at FROM media_locks WHERE media_id = ?').get(mediaId);
    if (!lock || lock.device_id !== deviceId || lock.expires_at <= Date.now()) {
      throw Object.assign(new Error('The review lock expired or belongs to another device. Reopen this item to continue.'), { status: 409 });
    }
    if (!CATEGORIES.has(category)) throw new Error('Invalid category.');
    const item = this.db.prepare(`
      SELECT m.category, r.collection_id FROM media m JOIN roots r ON r.id = m.root_id
      JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND r.active = 1 AND c.active = 1 AND m.present = 1
    `).get(mediaId);
    if (!item) throw new Error('Media item not found.');
    const next = category === 'unseen' ? null : category;
    if (item.category === next) {
      if (category === 'unsure') {
        this.setMediaCategory(mediaId, category);
        this.publishQueueChange(item.collection_id);
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO decision_history(media_id, device_id, previous_category, next_category, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(mediaId, deviceId, item.category, next, new Date().toISOString());
    this.db.prepare('DELETE FROM decision_history WHERE device_id = ? AND undone = 1').run(deviceId);
    this.setMediaCategory(mediaId, category);
    this.log('decision_changed', { mediaId, previous: item.category, category: next, collectionId: item.collection_id });
    this.publishQueueChange(item.collection_id);
  }

  async changeDecisionHistory(deviceId, direction) {
    const undone = direction === 'redo' ? 1 : 0;
    const entry = this.db.prepare(`
      SELECT h.* FROM decision_history h
      WHERE h.device_id = ? AND h.undone = ?
      ORDER BY h.id DESC LIMIT 1
    `).get(deviceId, undone);
    if (!entry) return { changed: false, message: `There is no decision to ${direction}.` };
    this.claimMediaLock(entry.media_id, deviceId);
    const item = this.db.prepare(`
      SELECT m.category, r.collection_id FROM media m JOIN roots r ON r.id = m.root_id WHERE m.id = ?
    `).get(entry.media_id);
    const expected = direction === 'undo' ? entry.next_category : null;
    if (!item || item.category !== expected) {
      throw Object.assign(new Error('This decision changed on another device; history was not altered.'), { status: 409 });
    }
    const category = direction === 'undo' ? null : entry.next_category;
    this.setMediaCategory(entry.media_id, category || 'unseen');
    if (direction === 'undo') {
      this.db.prepare('UPDATE decision_history SET undone = 1 WHERE media_id = ? AND device_id = ?')
        .run(entry.media_id, deviceId);
    } else {
      this.db.prepare('UPDATE decision_history SET undone = 0 WHERE id = ?').run(entry.id);
    }
    this.log(direction === 'undo' ? 'decision_undone' : 'decision_redone', {
      mediaId: entry.media_id, category,
    });
    this.publishQueueChange(item.collection_id);
    return { changed: true, mediaId: entry.media_id, category: category || 'unseen' };
  }

  listAudit(limit = 200) {
    return this.db.prepare('SELECT id, action, details, created_at FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit).map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }

  exportAudit() {
    const events = this.db.prepare('SELECT id, action, details, created_at FROM audit ORDER BY id')
      .all().map((row) => ({ ...row, details: JSON.parse(row.details) }));
    return { exportedAt: new Date().toISOString(), events };
  }

  clearAudit() {
    const clearedCount = this.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
    this.db.prepare('DELETE FROM audit').run();
    this.log('audit_cleared', { clearedCount });
    return { clearedCount };
  }

  mediaPath(mediaId) {
    const item = this.db.prepare(`
      SELECT m.id, m.root_id, m.relative_path, m.size, m.modified_at, r.path FROM media m
      JOIN roots r ON r.id = m.root_id JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND r.active = 1 AND c.active = 1 AND m.present = 1
    `).get(mediaId);
    if (!item) return null;
    const fullPath = path.resolve(item.path, item.relative_path);
    if (!isWithin(item.path, fullPath)) return null;
    return { ...item, fullPath };
  }

  async planApply(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    const media = this.db.prepare(`
      SELECT m.id, m.root_id, m.relative_path, m.category, r.path, r.read_only,
        (SELECT o.from_path FROM apply_operations o
          WHERE o.media_id = m.id AND o.operation_type = 'move' AND o.status = 'completed'
          ORDER BY o.id DESC LIMIT 1) AS latest_from,
        (SELECT o.to_path FROM apply_operations o
          WHERE o.media_id = m.id AND o.operation_type = 'move' AND o.status = 'completed'
          ORDER BY o.id DESC LIMIT 1) AS latest_to,
        (SELECT o.category FROM apply_operations o
          WHERE o.media_id = m.id AND o.operation_type = 'move' AND o.status = 'completed'
          ORDER BY o.id DESC LIMIT 1) AS latest_category
      FROM media m JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.present = 1
        AND (m.category IN ('delete', 'unsure')
          OR m.relative_path GLOB 'deleted/*' OR m.relative_path GLOB 'deleted\\*'
          OR m.relative_path GLOB 'unsure/*' OR m.relative_path GLOB 'unsure\\*')
      ORDER BY m.relative_path
    `).all(collectionId);
    const operations = [];
    let readOnlySkipped = 0;
    for (const item of media) {
      const source = path.resolve(item.path, item.relative_path);
      if (!isWithin(item.path, source)) continue;
      if (item.read_only) {
        readOnlySkipped += 1;
        continue;
      }
      const isInOutput = isOutputRelativePath(item.relative_path);
      const wasApplied = isInOutput && item.latest_to && comparePaths(source, item.latest_to);
      let type;
      let targetCategory;
      let relativePath;
      let destination;
      if (wasApplied) {
        if (item.category === item.latest_category) continue;
        if (item.category === 'delete' || item.category === 'unsure') {
          type = 'recategorize';
          targetCategory = item.category;
          const completedOperations = this.db.prepare(`
            SELECT from_path FROM apply_operations
            WHERE media_id = ? AND operation_type = 'move' AND status IN ('completed', 'restored') ORDER BY id
          `).all(item.id);
          const original = completedOperations.find((entry) => isWithin(item.path, entry.from_path)
            && !isWithin(path.join(item.path, 'deleted'), entry.from_path)
            && !isWithin(path.join(item.path, 'unsure'), entry.from_path));
          relativePath = original ? path.relative(item.path, original.from_path)
            : path.relative(path.join(item.path, item.latest_category), item.latest_from);
          destination = path.join(item.path, targetCategory === 'delete' ? 'deleted' : 'unsure', relativePath);
        } else {
          type = 'restore';
          targetCategory = item.category || 'unseen';
          const completedOperations = this.db.prepare(`
            SELECT from_path FROM apply_operations
            WHERE media_id = ? AND operation_type = 'move' AND status IN ('completed', 'restored') ORDER BY id
          `).all(item.id);
          const original = completedOperations.find((entry) => isWithin(item.path, entry.from_path)
            && !isWithin(path.join(item.path, 'deleted'), entry.from_path)
            && !isWithin(path.join(item.path, 'unsure'), entry.from_path));
          destination = original?.from_path || path.resolve(item.path, item.latest_from);
          relativePath = path.relative(item.path, destination);
        }
      } else {
        if (isInOutput) continue;
        if (item.category !== 'delete' && item.category !== 'unsure') continue;
        type = 'move';
        targetCategory = item.category;
        relativePath = item.relative_path;
        destination = path.join(item.path, targetCategory === 'delete' ? 'deleted' : 'unsure', relativePath);
      }
      if (!isWithin(item.path, destination) || comparePaths(source, destination)) continue;
      const targetIsOutput = targetCategory === 'delete' || targetCategory === 'unsure';
      const categoryDirectory = targetIsOutput
        ? path.join(item.path, targetCategory === 'delete' ? 'deleted' : 'unsure') : null;
      let existingOutput = false;
      if (categoryDirectory) existingOutput = await pathExists(categoryDirectory);
      let owned = false;
      if (existingOutput && categoryDirectory) {
        try {
          const marker = await fs.readFile(path.join(categoryDirectory, OUTPUT_MARKER), 'utf8');
          owned = marker === 'photo-sorter-output-v1\n';
        } catch {}
      }
      operations.push({
        type,
        mediaId: item.id,
        rootId: item.root_id,
        root: item.path,
        relativePath,
        category: targetCategory,
        source,
        destination,
        needsReuseConfirmation: Boolean(categoryDirectory && existingOutput && !owned),
        restoreConflict: type === 'restore' && await pathExists(destination),
      });
    }
    const id = crypto.randomUUID();
    this.applyPlans.set(id, { collectionId, operations, createdAt: Date.now() });
    return {
      id,
      moveCount: operations.length,
      restoreCount: operations.filter((item) => item.type === 'restore').length,
      recategorizeCount: operations.filter((item) => item.type === 'recategorize').length,
      restoreConflictCount: operations.filter((item) => item.restoreConflict).length,
      readOnlySkipped,
      requiresOutputFolderConsent: operations.some((item) => item.needsReuseConfirmation),
      examples: operations.slice(0, 5).map(({ source, destination }) => ({ source, destination })),
    };
  }

  async confirmApply(planId, { confirm, reuseOutputFolders }) {
    const plan = this.applyPlans.get(planId);
    this.applyPlans.delete(planId);
    if (!plan || Date.now() - plan.createdAt > 10 * 60 * 1000) throw new Error('Apply plan expired; create a new summary.');
    if (confirm !== true) throw new Error('Apply requires explicit confirmation.');
    if (plan.operations.some((item) => item.needsReuseConfirmation) && reuseOutputFolders !== true) {
      throw new Error('Confirm reuse of the existing deleted/unsure folders before applying.');
    }
    const batchId = crypto.randomUUID();
    this.db.prepare('INSERT INTO apply_batches(id, created_at) VALUES (?, ?)').run(batchId, new Date().toISOString());
    const results = [];
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      let operationId;
      let effectiveDestination = operation.destination;
      try {
        const rootIsActive = this.db.prepare(`
          SELECT 1 FROM roots r JOIN collections c ON c.id = r.collection_id
          WHERE r.id = ? AND r.active = 1 AND c.active = 1
        `).get(operation.rootId);
        if (!rootIsActive) throw new Error('The root or collection is no longer active.');
        const currentRoot = await fs.realpath(operation.root);
        const currentSource = await fs.realpath(operation.source);
        if (!comparePaths(currentRoot, operation.root) || !isWithin(currentRoot, currentSource)) {
          throw new Error('Source no longer resolves inside its registered root.');
        }
        const stat = await fs.lstat(operation.source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source is not a regular file.');
        const targetIsOutput = operation.category === 'delete' || operation.category === 'unsure';
        if (targetIsOutput) {
          const output = path.join(operation.root, operation.category === 'delete' ? 'deleted' : 'unsure');
          const outputExisted = await pathExists(output);
          await fs.mkdir(output, { recursive: true });
          const outputStat = await fs.lstat(output);
          if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('Output folder must be a real directory.');
          if (!isWithin(currentRoot, await fs.realpath(output))) throw new Error('Output folder is outside its registered root.');
          const markerPath = path.join(output, OUTPUT_MARKER);
          let outputOwned = false;
          try {
            const marker = await fs.readFile(markerPath, 'utf8');
            if (marker !== 'photo-sorter-output-v1\n') throw new Error('Output folder marker is invalid.');
            outputOwned = true;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          if (outputExisted && !outputOwned && reuseOutputFolders !== true) {
            throw new Error('Existing output folder requires explicit reuse confirmation; review a new apply summary.');
          }
          if (!outputOwned) {
            await fs.writeFile(markerPath, 'photo-sorter-output-v1\n', { flag: 'wx', mode: 0o600 });
          }
        }
        const parent = path.dirname(operation.destination);
        await fs.mkdir(parent, { recursive: true });
        const destination = operation.type === 'restore'
          ? operation.destination
          : numberedDestination(operation.destination, (candidate) => {
            try { fsSync.lstatSync(candidate); return true; } catch (error) { return error.code !== 'ENOENT'; }
          });
        effectiveDestination = destination;
        if (operation.type === 'restore' && await pathExists(destination)) {
          throw new Error('Original path is occupied; refusing to overwrite.');
        }
        if (!isWithin(currentRoot, destination)) throw new Error('Destination is outside its registered root.');
        const destinationParent = await fs.realpath(path.dirname(destination));
        if (!isWithin(currentRoot, destinationParent)) throw new Error('Destination escaped its registered root.');
        const destinationDevice = (await fs.stat(destinationParent)).dev;
        if (stat.dev !== destinationDevice) throw new Error('Cross-volume moves are not supported.');
        const row = this.db.prepare(`INSERT INTO apply_operations
          (batch_id, media_id, root_id, from_path, to_path, category, status, operation_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'move')`)
          .run(batchId, operation.mediaId, operation.rootId, currentSource, destination, operation.category, 'planned');
        operationId = row.lastInsertRowid;
        await moveWithoutOverwrite(currentSource, destination);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('completed', operationId);
        this.db.prepare('UPDATE media SET relative_path = ?, present = 1 WHERE id = ?')
          .run(path.relative(currentRoot, destination), operation.mediaId);
        results.push({
          source: currentSource,
          destination,
          status: operation.type === 'restore' ? 'restored' : operation.type === 'recategorize' ? 'recategorized' : 'moved',
        });
      } catch (error) {
        let sourceExists = true;
        let destinationExists = false;
        try {
          sourceExists = await pathExists(operation.source);
          destinationExists = await pathExists(effectiveDestination);
        } catch {}
        if (operationId && !sourceExists && destinationExists) {
          const status = operation.type === 'restore' ? 'restored'
            : operation.type === 'recategorize' ? 'recategorized' : 'moved';
          this.db.prepare("UPDATE apply_operations SET status = 'completed' WHERE id = ?").run(operationId);
          this.db.prepare('UPDATE media SET relative_path = ?, present = 1 WHERE id = ?')
            .run(path.relative(operation.root, effectiveDestination), operation.mediaId);
          results.push({ source: operation.source, destination: effectiveDestination, status });
          continue;
        }
        if (operationId) {
          this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(operationId);
        }
        results.push({
          source: operation.source,
          destination: effectiveDestination,
          status: 'failed',
          error: error.message,
        });
        for (const unattempted of plan.operations.slice(index + 1)) {
          results.push({ source: unattempted.source, destination: unattempted.destination, status: 'not_attempted' });
        }
        this.log('apply_failed', {
          batchId,
          completed: results.filter((result) => ['moved', 'restored', 'recategorized'].includes(result.status)),
          failed: results.find((result) => result.status === 'failed'),
          notAttempted: results.filter((result) => result.status === 'not_attempted'),
        });
        this.publishQueueChange(plan.collectionId);
        return { batchId, results, stoppedOnFailure: true };
      }
    }
    this.log('apply_completed', { batchId, results });
    this.publishQueueChange(plan.collectionId);
    return { batchId, results, stoppedOnFailure: false };
  }

  async restoreLatest() {
    const batch = this.db.prepare(`
      SELECT b.id FROM apply_batches b
      WHERE EXISTS (SELECT 1 FROM apply_operations o
        WHERE o.batch_id = b.id AND o.operation_type = 'move' AND o.status = 'completed')
      ORDER BY b.created_at DESC, b.id DESC LIMIT 1
    `).get();
    if (!batch) return { results: [], message: 'There is no apply batch to restore.' };
    const operations = this.db.prepare(`
      SELECT * FROM apply_operations
      WHERE batch_id = ? AND operation_type = 'move' AND status = 'completed' ORDER BY id DESC
    `).all(batch.id);
    const results = [];
    for (const operation of operations) {
      let restoreOperationId;
      try {
        const root = this.db.prepare('SELECT path FROM roots WHERE id = ?').get(operation.root_id)?.path;
        if (!root || !isWithin(root, operation.from_path) || !isWithin(root, operation.to_path)) {
          throw new Error('Restore path is outside the registered root.');
        }
        const canonicalRoot = await fs.realpath(root);
        if (!comparePaths(canonicalRoot, root)) throw new Error('Registered root no longer resolves to its original directory.');
        const movedStat = await fs.lstat(operation.to_path);
        if (!movedStat.isFile() || movedStat.isSymbolicLink()) throw new Error('Moved file is not a regular file.');
        const movedFile = await fs.realpath(operation.to_path);
        if (!isWithin(canonicalRoot, movedFile)) throw new Error('Moved file is outside the registered root.');
        if (await pathExists(operation.from_path)) {
          throw new Error('Original path is occupied; refusing to overwrite.');
        }
        await fs.mkdir(path.dirname(operation.from_path), { recursive: true });
        const restoreParent = await fs.realpath(path.dirname(operation.from_path));
        if (!isWithin(canonicalRoot, restoreParent)) throw new Error('Restore destination escaped its registered root.');
        if (movedStat.dev !== (await fs.stat(restoreParent)).dev) throw new Error('Cross-volume moves are not supported.');
        const row = this.db.prepare(`INSERT INTO apply_operations
          (batch_id, media_id, root_id, from_path, to_path, category, status, operation_type, reverses_operation_id)
          VALUES (?, ?, ?, ?, ?, ?, 'planned', 'restore', ?)`)
          .run(batch.id, operation.media_id, operation.root_id, operation.to_path, operation.from_path,
            operation.category, operation.id);
        restoreOperationId = row.lastInsertRowid;
        await moveWithoutOverwrite(operation.to_path, operation.from_path);
        this.db.prepare("UPDATE apply_operations SET status = 'completed' WHERE id = ?").run(restoreOperationId);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('restored', operation.id);
        this.db.prepare('UPDATE media SET relative_path = ?, present = 1 WHERE id = ?')
          .run(path.relative(root, operation.from_path), operation.media_id);
        results.push({ source: operation.to_path, destination: operation.from_path, status: 'restored' });
      } catch (error) {
        let sourceExists = true;
        let destinationExists = false;
        try {
          sourceExists = await pathExists(operation.to_path);
          destinationExists = await pathExists(operation.from_path);
        } catch {}
        if (restoreOperationId && !sourceExists && destinationExists) {
          this.db.prepare("UPDATE apply_operations SET status = 'completed' WHERE id = ?").run(restoreOperationId);
          this.db.prepare("UPDATE apply_operations SET status = 'restored' WHERE id = ?").run(operation.id);
          this.db.prepare('UPDATE media SET relative_path = ?, present = 1 WHERE id = ?')
            .run(path.relative(this.db.prepare('SELECT path FROM roots WHERE id = ?').get(operation.root_id).path,
              operation.from_path), operation.media_id);
          results.push({ source: operation.to_path, destination: operation.from_path, status: 'restored' });
          continue;
        }
        if (restoreOperationId) {
          this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(restoreOperationId);
        }
        results.push({ source: operation.to_path, destination: operation.from_path, status: 'conflict', error: error.message });
      }
    }
    this.log('restore_completed', { batchId: batch.id, results });
    this.publishQueueChange();
    return { batchId: batch.id, results };
  }

  localAddresses(port) {
    const addresses = [];
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.internal || entry.family !== 'IPv4' || !isLocalNetworkAddress(entry.address)) continue;
        addresses.push({ name, address: entry.address, url: `http://${entry.address}:${port}` });
      }
    }
    return addresses;
  }

  async listen(port = Number(process.env.PHOTO_SORTER_PORT) || 43127) {
    const { createServer } = require('node:http');
    const privateAddresses = [...new Set(Object.values(os.networkInterfaces()).flatMap((entries) =>
      (entries || []).filter((entry) => !entry.internal && entry.family === 'IPv4'
        && isLocalNetworkAddress(entry.address)).map((entry) => entry.address)))];
    const bindAddresses = ['127.0.0.1', ...privateAddresses];
    const makeServer = () => createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) this.sendJson(response, error.status || 400, { error: error.message });
        else response.destroy();
      });
    });
    for (let index = 0; index < bindAddresses.length; index += 1) {
      const server = makeServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(index === 0 ? port : this.port, bindAddresses[index], resolve);
        });
        this.servers.push(server);
        if (index === 0) {
          this.server = server;
          this.port = server.address().port;
        }
      } catch (error) {
        server.close();
        if (index === 0) {
          this.close();
          throw error;
        }
      }
    }
    return this.port;
  }

  sendJson(response, status, value, headers = {}) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      ...headers,
    });
    response.end(body);
  }

  async readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async readImageBuffer(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        throw Object.assign(new Error('Generated preview is too large.'), { status: 413 });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  sessionToken(request) {
    const cookie = request.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)photo_sorter_session=([A-Fa-f0-9]+)/);
    return match?.[1];
  }

  deviceId(request) {
    const cookie = request.headers.cookie || '';
    return cookie.match(/(?:^|;\s*)photo_sorter_device=([A-Fa-f0-9]{32})/)?.[1];
  }

  issueSession(request) {
    const deviceId = this.deviceId(request) || crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { deviceId, createdAt: Date.now() });
    const secure = this.passkeys?.configuredOrigin()?.origin === request.headers.origin ? '; Secure' : '';
    const cookies = [`photo_sorter_session=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`];
    if (!this.deviceId(request) || secure) {
      cookies.push(`photo_sorter_device=${deviceId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000${secure}`);
    }
    return { deviceId, headers: { 'Set-Cookie': cookies } };
  }

  requireSession(request) {
    const token = this.sessionToken(request);
    const session = token && this.sessions.get(token);
    if (!session) throw Object.assign(new Error('Authentication required.'), { status: 401 });
    return session;
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'GET' && url.pathname === '/api/setup-status') {
        return this.sendJson(response, 200, { setupComplete: this.isSetupComplete() });
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        const token = this.sessionToken(request);
        return this.sendJson(response, 200, { authenticated: Boolean(token && this.sessions.has(token)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/passkeys/status') {
        return this.sendJson(response, 200, this.passkeys.status());
      }
      if (request.method === 'POST' && url.pathname === '/api/setup') {
        const hostname = (request.headers.host || '').split(':')[0].toLowerCase();
        const address = request.socket.remoteAddress || '';
        if (!['localhost', '127.0.0.1', '::1'].includes(hostname) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
          return this.sendJson(response, 403, { error: 'Initial setup is only available in the host desktop app.' });
        }
        const { password } = await this.readJson(request);
        await this.createPassword(password);
        const session = this.issueSession(request);
        return this.sendJson(response, 201, { authenticated: true }, session.headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        const address = request.socket.remoteAddress || 'unknown';
        const attempt = this.loginAttempts.get(address) || { count: 0, retryAfter: 0 };
        if (Date.now() < attempt.retryAfter) return this.sendJson(response, 429, { error: 'Too many attempts. Try again later.' });
        const { password } = await this.readJson(request);
        if (!await this.authenticate(password)) {
          attempt.count += 1;
          if (attempt.count >= 5) { attempt.count = 0; attempt.retryAfter = Date.now() + 60_000; }
          this.loginAttempts.set(address, attempt);
          return this.sendJson(response, 401, { error: 'Incorrect password.' });
        }
        this.loginAttempts.delete(address);
        const session = this.issueSession(request);
        return this.sendJson(response, 200, { authenticated: true }, session.headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/passkeys/authentication/options') {
        if (!this.isSetupComplete()) {
          return this.sendJson(response, 403, { error: 'Complete host setup before using passkeys.' });
        }
        return this.sendJson(response, 200, await this.passkeys.authenticationOptions(request));
      }
      if (request.method === 'POST' && url.pathname === '/api/passkeys/authentication/verify') {
        if (!this.isSetupComplete()) {
          return this.sendJson(response, 403, { error: 'Complete host setup before using passkeys.' });
        }
        await this.passkeys.verifyAuthentication(request, await this.readJson(request));
        const session = this.issueSession(request);
        return this.sendJson(response, 200, { authenticated: true }, session.headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        const token = this.sessionToken(request);
        if (token) {
          this.sessions.delete(token);
          this.closeEventStreamsForSession(token);
        }
        const secure = this.passkeys?.configuredOrigin()?.origin === request.headers.origin ? '; Secure' : '';
        return this.sendJson(response, 200, { authenticated: false }, {
          'Set-Cookie': `photo_sorter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/network') {
        const addresses = await Promise.all(this.localAddresses(this.port).map(async (address) => ({
          ...address,
          qrDataUrl: await QRCode.toDataURL(address.url, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 180,
          }),
        })));
        return this.sendJson(response, 200, { addresses });
      }
      const session = this.requireSession(request);
      if (request.method === 'PUT' && url.pathname === '/api/password') {
        const { currentPassword, newPassword } = await this.readJson(request);
        await this.changePassword(currentPassword, newPassword);
        const currentToken = this.sessionToken(request);
        for (const token of this.sessions.keys()) {
          if (token === currentToken) continue;
          this.sessions.delete(token);
          this.closeEventStreamsForSession(token);
        }
        return this.sendJson(response, 200, { changed: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        const collectionId = url.searchParams.get('collectionId');
        if (collectionId && !this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
          return this.sendJson(response, 404, { error: 'Collection not found.' });
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const stream = {
          response,
          token: this.sessionToken(request),
          collectionId,
          heartbeat: setInterval(() => {
            if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
          }, 20_000),
        };
        stream.heartbeat.unref?.();
        this.eventStreams.add(stream);
        response.on('close', () => {
          clearInterval(stream.heartbeat);
          this.eventStreams.delete(stream);
        });
        response.write(': connected\n\n');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/passkeys') {
        return this.sendJson(response, 200, { passkeys: this.passkeys.list() });
      }
      if (request.method === 'POST' && url.pathname === '/api/passkeys/registration/options') {
        return this.sendJson(response, 200, await this.passkeys.registrationOptions(request, session.deviceId));
      }
      if (request.method === 'POST' && url.pathname === '/api/passkeys/registration/verify') {
        return this.sendJson(response, 201, await this.passkeys.verifyRegistration(
          request, session.deviceId, await this.readJson(request),
        ));
      }
      const passkeyMatch = url.pathname.match(/^\/api\/passkeys\/([A-Za-z0-9_-]+)$/);
      if (request.method === 'DELETE' && passkeyMatch) {
        return this.sendJson(response, 200, this.passkeys.remove(passkeyMatch[1]));
      }
      if (request.method === 'GET' && url.pathname === '/api/collections') {
        return this.sendJson(response, 200, { collections: this.listCollections() });
      }
      if (request.method === 'POST' && url.pathname === '/api/collections') {
        const { name } = await this.readJson(request);
        return this.sendJson(response, 201, { id: this.createCollection(name) });
      }
      if (request.method === 'GET' && url.pathname === '/api/collections/archived') {
        return this.sendJson(response, 200, { collections: this.listArchivedCollections() });
      }
      const collectionAction = url.pathname.match(/^\/api\/collections\/([0-9a-f-]+)\/(archive|restore)$/i);
      if (request.method === 'POST' && collectionAction) {
        const [, collectionId, action] = collectionAction;
        const result = action === 'archive'
          ? this.archiveCollection(collectionId) : this.restoreCollection(collectionId);
        return this.sendJson(response, 200, result);
      }
      const collectionRoots = url.pathname.match(/^\/api\/collections\/([0-9a-f-]+)\/roots$/i);
      if (request.method === 'GET' && collectionRoots) {
        return this.sendJson(response, 200, { roots: this.listRoots(collectionRoots[1]) });
      }
      const rootAction = url.pathname.match(/^\/api\/collections\/([0-9a-f-]+)\/roots\/([0-9a-f-]+)$/i);
      if (request.method === 'DELETE' && rootAction) {
        return this.sendJson(response, 200, await this.removeRoot(rootAction[1], rootAction[2]));
      }
      if (request.method === 'GET' && url.pathname === '/api/preferences') {
        return this.sendJson(response, 200, { lastCollectionId: this.getLastCollection(session.deviceId) });
      }
      if (request.method === 'PUT' && url.pathname === '/api/preferences') {
        const { lastCollectionId } = await this.readJson(request);
        return this.sendJson(response, 200, this.setLastCollection(session.deviceId, lastCollectionId));
      }
      if (request.method === 'GET' && url.pathname === '/api/device-state') {
        return this.sendJson(response, 200, {
          state: this.getDeviceState(session.deviceId, url.searchParams.get('collectionId')),
        });
      }
      if (request.method === 'PUT' && url.pathname === '/api/device-state') {
        const body = await this.readJson(request);
        return this.sendJson(response, 200, {
          state: this.saveDeviceState(session.deviceId, body.collectionId, body),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/photo-health/status') {
        return this.sendJson(response, 200, this.getPhotoHealthStatus(url.searchParams.get('collectionId')));
      }
      if (request.method === 'POST' && url.pathname === '/api/photo-health/state') {
        const { collectionId, action } = await this.readJson(request);
        return this.sendJson(response, 200, this.setPhotoHealthState(collectionId, action));
      }
      if (request.method === 'GET' && url.pathname === '/api/photo-health/findings') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return this.sendJson(response, 200, this.listPhotoHealthFindings(
          url.searchParams.get('collectionId'),
          {
            type: url.searchParams.get('type') || 'all',
            handled: url.searchParams.get('handled') || 'open',
            offset,
            limit,
          },
        ));
      }
      const healthGroup = url.pathname.match(/^\/api\/photo-health\/groups\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && healthGroup) {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return this.sendJson(response, 200, this.listPhotoHealthGroup(
          url.searchParams.get('collectionId'), healthGroup[1], { offset, limit },
        ));
      }
      const healthGroupDecision = url.pathname.match(/^\/api\/photo-health\/groups\/([0-9a-f-]+)\/decisions$/i);
      if (request.method === 'POST' && healthGroupDecision) {
        const { collectionId, keepIds } = await this.readJson(request);
        return this.sendJson(response, 200, this.decidePhotoHealthGroup(
          collectionId, healthGroupDecision[1], keepIds, session.deviceId,
        ));
      }
      if (request.method === 'POST' && ['/api/decisions/undo', '/api/decisions/redo'].includes(url.pathname)) {
        const direction = url.pathname.endsWith('/undo') ? 'undo' : 'redo';
        return this.sendJson(response, 200, await this.changeDecisionHistory(session.deviceId, direction));
      }
      if (request.method === 'GET' && url.pathname === '/api/media') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const category = url.searchParams.get('category') || 'unseen';
        const sort = url.searchParams.get('sort') || 'capture-asc';
        if (!REVIEW_CATEGORIES.has(category)) throw new Error('Invalid category.');
        const result = this.listMedia({
          collectionId: url.searchParams.get('collectionId'),
          category,
          sort,
          offset,
          limit,
          search: url.searchParams.get('q') || '',
          fromDate: url.searchParams.get('from') || '',
          toDate: url.searchParams.get('to') || '',
          kind: url.searchParams.get('kind') || '',
          rootId: url.searchParams.get('rootId') || '',
        });
        return this.sendJson(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/scans') {
        return this.sendJson(response, 200, {
          scans: this.listScanStatus(url.searchParams.get('collectionId')),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return this.sendJson(response, 200, this.getSettings());
      }
      if (request.method === 'PUT' && url.pathname === '/api/settings') {
        return this.sendJson(response, 200, await this.saveSettings(await this.readJson(request)));
      }
      const previewMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/preview$/i);
      if (request.method === 'POST' && previewMatch) {
        if (!/^image\/jpeg(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return this.sendJson(response, 415, { error: 'Generated preview must use image/jpeg.' });
        }
        const preview = await this.readImageBuffer(request);
        const expectedVersion = request.headers['if-match'] || '';
        return this.sendJson(response, 201, await this.saveGeneratedPreview(
          previewMatch[1], preview, expectedVersion,
        ));
      }
      if (request.method === 'GET' && previewMatch) {
        const preview = await this.getPreview(previewMatch[1]);
        if (!preview) return this.sendJson(response, 404, { error: 'Preview is unavailable.' });
        response.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': preview.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return response.end(preview);
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/content$/i);
      if (request.method === 'GET' && mediaMatch) return this.serveMedia(mediaMatch[1], request, response);
      const lockMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/lock$/i);
      if (request.method === 'POST' && lockMatch) {
        return this.sendJson(response, 200, this.claimMediaLock(lockMatch[1], session.deviceId));
      }
      if (request.method === 'DELETE' && lockMatch) {
        return this.sendJson(response, 200, this.releaseMediaLock(lockMatch[1], session.deviceId));
      }
      const decisionMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/decision$/i);
      if (request.method === 'PUT' && decisionMatch) {
        const { category } = await this.readJson(request);
        this.setDeviceDecision(decisionMatch[1], category, session.deviceId);
        return this.sendJson(response, 200, { saved: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/apply/plan') {
        const { collectionId } = await this.readJson(request);
        return this.sendJson(response, 200, await this.planApply(collectionId));
      }
      if (request.method === 'POST' && url.pathname === '/api/rescan') {
        const { collectionId, rootId } = await this.readJson(request);
        const scans = rootId ? [this.startRootScan(collectionId, rootId)] : this.startCollectionScan(collectionId);
        return this.sendJson(response, 202, { scans });
      }
      if (request.method === 'POST' && url.pathname === '/api/apply/confirm') {
        const body = await this.readJson(request);
        return this.sendJson(response, 200, await this.confirmApply(body.planId, body));
      }
      if (request.method === 'POST' && url.pathname === '/api/restore') {
        return this.sendJson(response, 200, await this.restoreLatest());
      }
      if (request.method === 'GET' && url.pathname === '/api/audit') {
        return this.sendJson(response, 200, { events: this.listAudit() });
      }
      if (request.method === 'GET' && url.pathname === '/api/audit/export') {
        return this.sendJson(response, 200, this.exportAudit());
      }
      if (request.method === 'DELETE' && url.pathname === '/api/audit') {
        return this.sendJson(response, 200, this.clearAudit());
      }
      return this.sendJson(response, 404, { error: 'Not found.' });
    }
    return this.serveUi(url.pathname, response);
  }

  async serveMedia(mediaId, request, response) {
    const item = this.mediaPath(mediaId);
    if (!item) return this.sendJson(response, 404, { error: 'Media item not found.' });
    let resolved;
    try {
      const canonicalRoot = await fs.realpath(item.path);
      if (!comparePaths(canonicalRoot, item.path)) {
        return this.sendJson(response, 403, { error: 'Registered root no longer resolves to its original directory.' });
      }
      resolved = await fs.realpath(item.fullPath);
      if (!isWithin(canonicalRoot, resolved)) return this.sendJson(response, 403, { error: 'Media is outside its registered root.' });
    } catch {
      return this.sendJson(response, 404, { error: 'Media is unavailable.' });
    }
    const stat = await fs.stat(resolved);
    const extension = path.extname(resolved).toLowerCase();
    const mime = {
      '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.heic': 'image/heic',
      '.heif': 'image/heif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
      '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp', '.3gp': 'video/3gpp',
      '.avi': 'video/x-msvideo', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
      '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
      '.mts': 'video/mp2t', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
    }[extension] || 'application/octet-stream';
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = Number(range[1] || 0);
      const end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
      if (start > end || start >= stat.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return response.end();
      }
      response.writeHead(206, {
        'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return this.pipeMedia(resolved, response, { start, end });
    }
    response.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    return this.pipeMedia(resolved, response);
  }

  pipeMedia(filename, response, range) {
    const stream = fsSync.createReadStream(filename, range);
    stream.on('error', () => {
      if (response.headersSent) response.destroy();
      else this.sendJson(response, 404, { error: 'Media became unavailable.' });
    });
    return stream.pipe(response);
  }

  async serveUi(pathname, response) {
    const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const filename = path.resolve(this.uiDirectory, requested);
    if (!isWithin(this.uiDirectory, filename)) return this.sendJson(response, 404, { error: 'Not found.' });
    try {
      const stat = await fs.stat(filename);
      if (!stat.isFile()) return this.sendJson(response, 404, { error: 'Not found.' });
      const mime = filename.endsWith('.css') ? 'text/css; charset=utf-8'
        : filename.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : filename.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8'
            : filename.endsWith('.svg') ? 'image/svg+xml'
              : 'text/html; charset=utf-8';
      response.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      require('node:fs').createReadStream(filename).pipe(response);
    } catch {
      this.sendJson(response, 404, { error: 'Not found.' });
    }
  }
}

module.exports = {
  CATEGORIES,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  PhotoSorter,
  defaultDataDirectory,
  isLocalNetworkAddress,
  isWithin,
  normalizeCaptureDate,
  numberedDestination,
  pathsOverlap,
};
