const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isIP } = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.png',
  '.tif', '.tiff', '.webp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.3gp', '.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.mts', '.webm', '.wmv',
]);
const CATEGORIES = new Set(['keep', 'delete', 'unsure', 'unseen']);
const OUTPUT_MARKER = '.photo-sorter-output';

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
  try {
    await fs.unlink(source);
  } catch (error) {
    try { await fs.unlink(destination); } catch {}
    throw error;
  }
}

class PhotoSorter {
  constructor({ dataDirectory = defaultDataDirectory(), uiDirectory = path.join(__dirname, 'ui') } = {}) {
    this.dataDirectory = dataDirectory;
    this.uiDirectory = uiDirectory;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.applyPlans = new Map();
    this.activeScans = new Map();
    this.scanQueue = [];
    this.queuedScans = new Set();
    this.scanWaiters = new Map();
    this.maxConcurrentScans = 2;
    this.closed = false;
    this.db = null;
    this.server = null;
    this.servers = [];
    this.port = null;
  }

  async initialize() {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dataDirectory, 'photo-sorter.sqlite'));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
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
        UNIQUE(root_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS media_root_category ON media(root_id, category);
      CREATE TABLE IF NOT EXISTS device_state (
        device_id TEXT NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        category TEXT NOT NULL DEFAULT 'unseen',
        sort_order TEXT NOT NULL DEFAULT 'date-asc',
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
        status TEXT NOT NULL
      );
    `);
    const rootColumns = this.db.prepare('PRAGMA table_info(roots)').all().map((column) => column.name);
    if (!rootColumns.includes('active')) this.db.exec('ALTER TABLE roots ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    await this.recoverApplyOperations();
    setImmediate(() => {
      if (this.closed || !this.db) return;
      const roots = this.db.prepare(`
        SELECT r.id FROM roots r JOIN collections c ON c.id = r.collection_id
        WHERE r.active = 1 AND c.active = 1
      `).all();
      for (const root of roots) this.startScan(root.id);
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
        let sourceExists = true;
        let destinationExists = true;
        try { await fs.access(operation.from_path); } catch (error) { if (error.code === 'ENOENT') sourceExists = false; else throw error; }
        try { await fs.access(operation.to_path); } catch (error) { if (error.code === 'ENOENT') destinationExists = false; else throw error; }
        if (!sourceExists && destinationExists) {
          this.db.prepare("UPDATE apply_operations SET status = 'completed' WHERE id = ?").run(operation.id);
          this.db.prepare('UPDATE media SET relative_path = ? WHERE id = ?')
            .run(path.relative(root, operation.to_path), operation.media_id);
          this.log('apply_recovered', { batchId: operation.batch_id, mediaId: operation.media_id, status: 'completed' });
        } else {
          this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(operation.id);
          this.log('apply_recovered', {
            batchId: operation.batch_id,
            mediaId: operation.media_id,
            status: 'failed',
            reason: sourceExists && destinationExists ? 'Both paths exist.' : 'Neither path exists.',
          });
        }
      } catch (error) {
        this.db.prepare("UPDATE apply_operations SET status = 'failed' WHERE id = ?").run(operation.id);
        this.log('apply_recovered', { batchId: operation.batch_id, mediaId: operation.media_id, status: 'failed', reason: error.message });
      }
    }
  }

  close() {
    this.closed = true;
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

  isSetupComplete() {
    return Boolean(this.db.prepare('SELECT id FROM account WHERE id = 1').get());
  }

  async createPassword(password) {
    if (this.isSetupComplete()) throw new Error('Password setup has already been completed.');
    this.validatePassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString('hex')));
    });
    this.db.prepare('INSERT INTO account(id, salt, password_hash) VALUES (1, ?, ?)').run(salt, hash);
    this.log('account_created', {});
  }

  validatePassword(password) {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
      throw new Error('Use a password of at least 12 characters.');
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
        (SELECT COUNT(*) FROM media m JOIN roots r ON r.id = m.root_id WHERE r.collection_id = c.id AND r.active = 1) AS item_count,
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

  async removeRoot(collectionId, rootId) {
    const root = this.db.prepare(`
      SELECT r.id, r.path FROM roots r JOIN collections c ON c.id = r.collection_id
      WHERE r.id = ? AND r.collection_id = ? AND r.active = 1 AND c.active = 1
    `).get(rootId, collectionId);
    if (!root) throw new Error('Root not found.');
    this.db.prepare('UPDATE roots SET active = 0 WHERE id = ?').run(rootId);
    this.db.prepare('DELETE FROM media_locks WHERE media_id IN (SELECT id FROM media WHERE root_id = ?)').run(rootId);
    this.log('root_removed', { collectionId, rootId, path: root.path });
    return { removed: true };
  }

  archiveCollection(collectionId) {
    const collection = this.db.prepare('SELECT id, name FROM collections WHERE id = ? AND active = 1').get(collectionId);
    if (!collection) throw new Error('Collection not found.');
    this.db.prepare('UPDATE collections SET active = 0 WHERE id = ?').run(collectionId);
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
      if (waitForScan) await this.scanRoot(retainedRoot.id);
      else this.startScan(retainedRoot.id);
      return retainedRoot.id;
    }
    const id = crypto.randomUUID();
    const readOnly = (rootStat.mode & 0o222) === 0;
    this.db.prepare('INSERT INTO roots(id, collection_id, path, read_only) VALUES (?, ?, ?, ?)')
      .run(id, collectionId, canonicalPath, readOnly ? 1 : 0);
    this.log('root_added', { collectionId, rootId: id, path: canonicalPath, readOnly });
    if (waitForScan) await this.scanRoot(id);
    else this.startScan(id);
    return id;
  }

  startScan(rootId) {
    if (this.activeScans.has(rootId) || this.queuedScans.has(rootId)) return { started: false, rootId };
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

  listScanStatus(collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    return this.db.prepare(`
      SELECT r.id AS rootId, r.path, r.online, s.status, s.visited, s.indexed, s.error,
        s.started_at AS startedAt, s.completed_at AS completedAt
      FROM roots r LEFT JOIN scan_jobs s ON s.root_id = r.id
      WHERE r.collection_id = ? AND r.active = 1 ORDER BY r.path COLLATE NOCASE
    `).all(collectionId).map((scan) => ({
      ...scan,
      status: scan.status || 'idle',
      visited: scan.visited || 0,
      indexed: scan.indexed || 0,
    }));
  }

  async performScanRoot(rootId) {
    const root = this.db.prepare('SELECT * FROM roots WHERE id = ? AND active = 1').get(rootId);
    if (!root) throw new Error('Root not found.');
    this.db.prepare(`
      INSERT INTO scan_jobs(root_id, status, visited, indexed, started_at)
      VALUES (?, 'running', 0, 0, ?)
      ON CONFLICT(root_id) DO UPDATE SET status = 'running', visited = 0, indexed = 0,
        error = NULL, started_at = excluded.started_at, completed_at = NULL
    `).run(rootId, new Date().toISOString());
    let base;
    try {
      base = await fs.realpath(root.path);
      if (!comparePaths(base, root.path)) throw new Error('Registered root no longer resolves to its original directory.');
      const directories = [base];
      const upsert = this.db.prepare(`
        INSERT INTO media(id, root_id, relative_path, size, modified_at, category)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(root_id, relative_path) DO UPDATE SET
          category = CASE WHEN media.size != excluded.size OR media.modified_at != excluded.modified_at
            THEN NULL ELSE media.category END,
          size = excluded.size, modified_at = excluded.modified_at
      `);
      let entriesVisited = 0;
      let entriesExamined = 0;
      const updateProgress = (status, error = null) => {
        this.db.prepare(`
          UPDATE scan_jobs SET status = ?, visited = ?, indexed = ?, error = ?,
            completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
          WHERE root_id = ?
        `).run(status, entriesExamined, entriesVisited, error,
          status, status === 'running' ? null : new Date().toISOString(), rootId);
      };
      while (directories.length) {
        if (this.closed || !this.db.prepare('SELECT 1 FROM roots WHERE id = ? AND active = 1').get(rootId)) {
          if (!this.closed) updateProgress('cancelled');
          return entriesVisited;
        }
        const directory = directories.pop();
        let entries;
        try {
          const directoryStat = await fs.lstat(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
            || !isWithin(base, await fs.realpath(directory))) continue;
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          this.log('scan_error', { rootId, path: directory, message: error.message });
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
            const stat = await fs.lstat(fullPath);
            if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(base, await fs.realpath(fullPath))) continue;
            const relativePath = path.relative(base, fullPath);
            upsert.run(crypto.createHash('sha256').update(`${rootId}\0${relativePath}`).digest('hex'),
              rootId, relativePath, stat.size, stat.mtimeMs);
            entriesVisited += 1;
          } catch (error) {
            this.log('scan_error', { rootId, path: fullPath, message: error.message });
          }
        }
      }
      this.db.prepare('UPDATE roots SET online = 1 WHERE id = ?').run(rootId);
      updateProgress('completed');
      this.log('scan_completed', { rootId, path: base, indexed: entriesVisited });
      return entriesVisited;
    } catch (error) {
      if (!this.closed) {
        this.db.prepare('UPDATE roots SET online = 0 WHERE id = ?').run(rootId);
        this.db.prepare(`
          INSERT INTO scan_jobs(root_id, status, error, started_at, completed_at)
          VALUES (?, 'failed', ?, ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET status = 'failed', error = excluded.error,
            completed_at = excluded.completed_at
        `).run(rootId, error.message, new Date().toISOString(), new Date().toISOString());
        this.log('scan_error', { rootId, path: root.path, message: error.message });
      }
      throw error;
    }
  }

  async rescanCollection(collectionId) {
    const roots = this.db.prepare('SELECT id FROM roots WHERE collection_id = ? AND active = 1').all(collectionId);
    let indexed = 0;
    for (const root of roots) {
      try { indexed += await this.scanRoot(root.id); } catch {}
    }
    return indexed;
  }

  listMedia({ collectionId, category, sort = 'date-asc', offset = 0, limit = 60 }) {
    const filters = ['r.collection_id = ?', 'r.active = 1'];
    const values = [collectionId];
    if (category === 'unseen') filters.push('m.category IS NULL');
    else if (CATEGORIES.has(category)) {
      filters.push('m.category = ?');
      values.push(category === 'unseen' ? null : category);
    }
    const orderBy = {
      'date-asc': 'm.modified_at ASC, m.relative_path COLLATE NOCASE ASC',
      'date-desc': 'm.modified_at DESC, m.relative_path COLLATE NOCASE ASC',
      filename: 'm.relative_path COLLATE NOCASE ASC',
    }[sort];
    if (!orderBy) throw new Error('Invalid sort order.');
    const items = this.db.prepare(`
      SELECT m.id, m.relative_path, m.size, m.modified_at, m.category,
        CASE WHEN lower(m.relative_path) GLOB '*.mp4' OR lower(m.relative_path) GLOB '*.mov'
          OR lower(m.relative_path) GLOB '*.m4v' OR lower(m.relative_path) GLOB '*.webm'
          OR lower(m.relative_path) GLOB '*.avi' OR lower(m.relative_path) GLOB '*.mkv'
          OR lower(m.relative_path) GLOB '*.mpeg' OR lower(m.relative_path) GLOB '*.mpg'
          OR lower(m.relative_path) GLOB '*.3gp' OR lower(m.relative_path) GLOB '*.wmv'
          OR lower(m.relative_path) GLOB '*.mts' THEN 'video' ELSE 'image' END AS kind,
        r.online, r.read_only
      FROM media m JOIN roots r ON r.id = m.root_id
      WHERE ${filters.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM media m JOIN roots r ON r.id = m.root_id
      WHERE ${filters.join(' AND ')}
    `).get(...values).count;
    return { items, total, offset, limit };
  }

  setDecision(mediaId, category) {
    if (!CATEGORIES.has(category)) throw new Error('Invalid category.');
    const item = this.db.prepare(`
      SELECT m.category, r.collection_id FROM media m JOIN roots r ON r.id = m.root_id
      JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND r.active = 1 AND c.active = 1
    `).get(mediaId);
    if (!item) throw new Error('Media item not found.');
    const next = category === 'unseen' ? null : category;
    this.db.prepare('UPDATE media SET category = ? WHERE id = ?').run(next, mediaId);
    this.log('decision_changed', { mediaId, previous: item.category, category: next, collectionId: item.collection_id });
  }

  getDeviceState(deviceId, collectionId) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    return this.db.prepare(`
      SELECT category, sort_order AS sort, media_id AS mediaId, page_offset AS offset
      FROM device_state WHERE device_id = ? AND collection_id = ?
    `).get(deviceId, collectionId) || null;
  }

  saveDeviceState(deviceId, collectionId, state) {
    if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
      throw new Error('Collection not found.');
    }
    const category = state.category;
    const sort = state.sort;
    const offset = state.offset;
    if (!CATEGORIES.has(category)
      || !['date-asc', 'date-desc', 'filename'].includes(sort)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000) {
      throw new Error('Invalid review position.');
    }
    const mediaId = state.mediaId === null || state.mediaId === '' ? null : state.mediaId;
    if (mediaId !== null && (typeof mediaId !== 'string'
      || !this.db.prepare('SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id WHERE m.id = ? AND r.collection_id = ?')
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
    if (!this.db.prepare('SELECT id FROM media WHERE id = ?').get(mediaId)) {
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
      WHERE m.id = ? AND r.active = 1 AND c.active = 1
    `).get(mediaId);
    if (!item) throw new Error('Media item not found.');
    const next = category === 'unseen' ? null : category;
    if (item.category === next) return;
    this.db.prepare(`
      INSERT INTO decision_history(media_id, device_id, previous_category, next_category, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(mediaId, deviceId, item.category, next, new Date().toISOString());
    this.db.prepare('DELETE FROM decision_history WHERE device_id = ? AND undone = 1').run(deviceId);
    this.db.prepare('UPDATE media SET category = ? WHERE id = ?').run(next, mediaId);
    this.log('decision_changed', { mediaId, previous: item.category, category: next, collectionId: item.collection_id });
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
    const item = this.db.prepare('SELECT category FROM media WHERE id = ?').get(entry.media_id);
    const expected = direction === 'undo' ? entry.next_category : entry.previous_category;
    if (!item || item.category !== expected) {
      throw Object.assign(new Error('This decision changed on another device; history was not altered.'), { status: 409 });
    }
    const category = direction === 'undo' ? entry.previous_category : entry.next_category;
    this.db.prepare('UPDATE media SET category = ? WHERE id = ?').run(category, entry.media_id);
    this.db.prepare('UPDATE decision_history SET undone = ? WHERE id = ?').run(direction === 'undo' ? 1 : 0, entry.id);
    this.log(direction === 'undo' ? 'decision_undone' : 'decision_redone', {
      mediaId: entry.media_id, category,
    });
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
      SELECT m.id, m.root_id, m.relative_path, r.path FROM media m
      JOIN roots r ON r.id = m.root_id JOIN collections c ON c.id = r.collection_id
      WHERE m.id = ? AND r.active = 1 AND c.active = 1
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
      SELECT m.id, m.root_id, m.relative_path, m.category, r.path, r.read_only
      FROM media m JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND r.active = 1 AND m.category IN ('delete', 'unsure')
        AND m.relative_path NOT LIKE 'deleted/%' AND m.relative_path NOT LIKE 'unsure/%'
      ORDER BY m.relative_path
    `).all(collectionId);
    const operations = [];
    for (const item of media) {
      const categoryDirectory = path.join(item.path, item.category === 'delete' ? 'deleted' : 'unsure');
      const source = path.resolve(item.path, item.relative_path);
      if (!isWithin(item.path, source) || item.read_only) continue;
      let existingOutput = false;
      try {
        await fs.access(categoryDirectory);
        existingOutput = true;
      } catch {}
      let owned = false;
      if (existingOutput) {
        try {
          const marker = await fs.readFile(path.join(categoryDirectory, OUTPUT_MARKER), 'utf8');
          owned = marker === 'photo-sorter-output-v1\n';
        } catch {}
      }
      operations.push({
        mediaId: item.id,
        rootId: item.root_id,
        root: item.path,
        relativePath: item.relative_path,
        category: item.category,
        source,
        destination: path.join(categoryDirectory, item.relative_path),
        needsReuseConfirmation: existingOutput && !owned,
      });
    }
    const id = crypto.randomUUID();
    this.applyPlans.set(id, { collectionId, operations, createdAt: Date.now() });
    return {
      id,
      moveCount: operations.length,
      readOnlySkipped: media.filter((item) => item.read_only).length,
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
    for (const operation of plan.operations) {
      let operationId;
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
        const stat = await fs.stat(currentSource);
        if (!stat.isFile()) throw new Error('Source is not a regular file.');
        const output = path.join(operation.root, operation.category === 'delete' ? 'deleted' : 'unsure');
        await fs.mkdir(output, { recursive: true });
        const outputStat = await fs.lstat(output);
        if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('Output folder must be a real directory.');
        if (!isWithin(currentRoot, await fs.realpath(output))) throw new Error('Output folder is outside its registered root.');
        const markerPath = path.join(output, OUTPUT_MARKER);
        try {
          const marker = await fs.readFile(markerPath, 'utf8');
          if (marker !== 'photo-sorter-output-v1\n') throw new Error('Output folder marker is invalid.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (operation.needsReuseConfirmation && reuseOutputFolders !== true) {
            throw new Error('Existing output folder requires explicit reuse confirmation.');
          }
          await fs.writeFile(markerPath, 'photo-sorter-output-v1\n', { flag: 'wx', mode: 0o600 });
        }
        const parent = path.dirname(operation.destination);
        await fs.mkdir(parent, { recursive: true });
        const destination = numberedDestination(operation.destination, (candidate) => {
          try { fsSync.lstatSync(candidate); return true; } catch (error) { return error.code !== 'ENOENT'; }
        });
        const destinationParent = await fs.realpath(path.dirname(destination));
        if (!isWithin(currentRoot, destinationParent)) throw new Error('Destination escaped its registered root.');
        const destinationDevice = (await fs.stat(destinationParent)).dev;
        if (stat.dev !== destinationDevice) throw new Error('Cross-volume moves are not supported.');
        const row = this.db.prepare('INSERT INTO apply_operations(batch_id, media_id, root_id, from_path, to_path, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(batchId, operation.mediaId, operation.rootId, currentSource, destination, operation.category, 'planned');
        operationId = row.lastInsertRowid;
        await moveWithoutOverwrite(currentSource, destination);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('completed', operationId);
        this.db.prepare('UPDATE media SET relative_path = ? WHERE id = ?')
          .run(path.relative(currentRoot, destination), operation.mediaId);
        results.push({ source: currentSource, destination, status: 'moved' });
      } catch (error) {
        if (operationId) this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('failed', operationId);
        results.push({ source: operation.source, destination: operation.destination, status: 'failed', error: error.message });
        this.log('apply_failed', { batchId, moved: results.filter((result) => result.status === 'moved'), failed: results.at(-1) });
        return { batchId, results, stoppedOnFailure: true };
      }
    }
    this.log('apply_completed', { batchId, results });
    return { batchId, results, stoppedOnFailure: false };
  }

  async restoreLatest() {
    const batch = this.db.prepare(`
      SELECT b.id FROM apply_batches b
      WHERE EXISTS (SELECT 1 FROM apply_operations o WHERE o.batch_id = b.id AND o.status = 'completed')
      ORDER BY b.created_at DESC LIMIT 1
    `).get();
    if (!batch) return { results: [], message: 'There is no apply batch to restore.' };
    const operations = this.db.prepare(`
      SELECT * FROM apply_operations WHERE batch_id = ? AND status = 'completed' ORDER BY id DESC
    `).all(batch.id);
    const results = [];
    for (const operation of operations) {
      try {
        const root = this.db.prepare('SELECT path FROM roots WHERE id = ?').get(operation.root_id)?.path;
        if (!root || !isWithin(root, operation.from_path) || !isWithin(root, operation.to_path)) {
          throw new Error('Restore path is outside the registered root.');
        }
        const canonicalRoot = await fs.realpath(root);
        if (!comparePaths(canonicalRoot, root)) throw new Error('Registered root no longer resolves to its original directory.');
        const movedFile = await fs.realpath(operation.to_path);
        if (!isWithin(canonicalRoot, movedFile)) throw new Error('Moved file is outside the registered root.');
        if (await pathExists(operation.from_path)) {
          throw new Error('Original path is occupied; refusing to overwrite.');
        }
        await fs.mkdir(path.dirname(operation.from_path), { recursive: true });
        const restoreParent = await fs.realpath(path.dirname(operation.from_path));
        if (!isWithin(canonicalRoot, restoreParent)) throw new Error('Restore destination escaped its registered root.');
        const movedStat = await fs.stat(movedFile);
        if (movedStat.dev !== (await fs.stat(restoreParent)).dev) throw new Error('Cross-volume moves are not supported.');
        await moveWithoutOverwrite(operation.to_path, operation.from_path);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('restored', operation.id);
        this.db.prepare('UPDATE media SET relative_path = ? WHERE id = ?')
          .run(path.relative(root, operation.from_path), operation.media_id);
        results.push({ source: operation.to_path, destination: operation.from_path, status: 'restored' });
      } catch (error) {
        results.push({ source: operation.to_path, destination: operation.from_path, status: 'conflict', error: error.message });
      }
    }
    this.log('restore_completed', { batchId: batch.id, results });
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
    const cookies = [`photo_sorter_session=${token}; HttpOnly; SameSite=Strict; Path=/`];
    if (!this.deviceId(request)) {
      cookies.push(`photo_sorter_device=${deviceId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000`);
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
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        const token = this.sessionToken(request);
        if (token) this.sessions.delete(token);
        return this.sendJson(response, 200, { authenticated: false }, {
          'Set-Cookie': 'photo_sorter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/network') {
        return this.sendJson(response, 200, { addresses: this.localAddresses(this.port) });
      }
      const session = this.requireSession(request);
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
      if (request.method === 'POST' && ['/api/decisions/undo', '/api/decisions/redo'].includes(url.pathname)) {
        const direction = url.pathname.endsWith('/undo') ? 'undo' : 'redo';
        return this.sendJson(response, 200, await this.changeDecisionHistory(session.deviceId, direction));
      }
      if (request.method === 'GET' && url.pathname === '/api/media') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const category = url.searchParams.get('category') || 'unseen';
        const sort = url.searchParams.get('sort') || 'date-asc';
        if (!CATEGORIES.has(category)) throw new Error('Invalid category.');
        const result = this.listMedia({
          collectionId: url.searchParams.get('collectionId'),
          category,
          sort,
          offset,
          limit,
        });
        return this.sendJson(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/scans') {
        return this.sendJson(response, 200, {
          scans: this.listScanStatus(url.searchParams.get('collectionId')),
        });
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
        const { collectionId } = await this.readJson(request);
        return this.sendJson(response, 202, { scans: this.startCollectionScan(collectionId) });
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
        : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      response.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  numberedDestination,
  pathsOverlap,
};
