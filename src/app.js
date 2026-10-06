const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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

function numberedDestination(destination, exists) {
  const extension = path.extname(destination);
  const stem = destination.slice(0, destination.length - extension.length);
  let index = 1;
  let candidate = destination;
  while (exists(candidate)) candidate = `${stem} (${index++})${extension}`;
  return candidate;
}

class PhotoSorter {
  constructor({ dataDirectory = defaultDataDirectory(), uiDirectory = path.join(__dirname, 'ui') } = {}) {
    this.dataDirectory = dataDirectory;
    this.uiDirectory = uiDirectory;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.applyPlans = new Map();
    this.db = null;
    this.server = null;
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
        UNIQUE(collection_id, path)
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
    return this;
  }

  close() {
    if (this.server) this.server.close();
    if (this.db) this.db.close();
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
        (SELECT COUNT(*) FROM media m JOIN roots r ON r.id = m.root_id WHERE r.collection_id = c.id) AS item_count,
        (SELECT COUNT(*) FROM roots r WHERE r.collection_id = c.id AND r.online = 0) AS offline_roots
      FROM collections c WHERE c.active = 1 ORDER BY c.created_at
    `).all();
  }

  async addRoot(collectionId, selectedPath) {
    const collection = this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId);
    if (!collection) throw new Error('Collection not found.');
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) throw new Error('Invalid selected folder.');
    const canonicalPath = await fs.realpath(selectedPath);
    const rootStat = await fs.stat(canonicalPath);
    if (!rootStat.isDirectory()) throw new Error('Selected path is not a directory.');
    const activeRoots = this.db.prepare(`
      SELECT r.id, r.path, r.collection_id FROM roots r
      JOIN collections c ON c.id = r.collection_id WHERE c.active = 1
    `).all();
    for (const root of activeRoots) {
      if (!pathsOverlap(root.path, canonicalPath)) continue;
      if (root.collection_id === collectionId && comparePaths(root.path, canonicalPath)) return root.id;
      throw new Error('This folder overlaps a root in an active collection.');
    }
    const id = crypto.randomUUID();
    const readOnly = (rootStat.mode & 0o222) === 0;
    this.db.prepare('INSERT INTO roots(id, collection_id, path, read_only) VALUES (?, ?, ?, ?)')
      .run(id, collectionId, canonicalPath, readOnly ? 1 : 0);
    this.log('root_added', { collectionId, rootId: id, path: canonicalPath, readOnly });
    await this.scanRoot(id);
    return id;
  }

  async scanRoot(rootId) {
    const root = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(rootId);
    if (!root) throw new Error('Root not found.');
    let base;
    try {
      base = await fs.realpath(root.path);
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
      while (directories.length) {
        const directory = directories.pop();
        let entries;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          this.log('scan_error', { rootId, path: directory, message: error.message });
          continue;
        }
        for (const entry of entries) {
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
            const stat = await fs.stat(fullPath);
            if (!isWithin(base, fullPath)) continue;
            const relativePath = path.relative(base, fullPath);
            upsert.run(crypto.createHash('sha256').update(`${rootId}\0${relativePath}`).digest('hex'),
              rootId, relativePath, stat.size, Math.trunc(stat.mtimeMs));
            entriesVisited += 1;
          } catch (error) {
            this.log('scan_error', { rootId, path: fullPath, message: error.message });
          }
        }
      }
      this.db.prepare('UPDATE roots SET online = 1 WHERE id = ?').run(rootId);
      this.log('scan_completed', { rootId, path: base, indexed: entriesVisited });
      return entriesVisited;
    } catch (error) {
      this.db.prepare('UPDATE roots SET online = 0 WHERE id = ?').run(rootId);
      this.log('scan_error', { rootId, path: root.path, message: error.message });
      throw error;
    }
  }

  async rescanCollection(collectionId) {
    const roots = this.db.prepare('SELECT id FROM roots WHERE collection_id = ?').all(collectionId);
    let indexed = 0;
    for (const root of roots) indexed += await this.scanRoot(root.id);
    return indexed;
  }

  listMedia({ collectionId, category, offset = 0, limit = 60 }) {
    const filters = ['r.collection_id = ?'];
    const values = [collectionId];
    if (category === 'unseen') filters.push('m.category IS NULL');
    else if (CATEGORIES.has(category)) {
      filters.push('m.category = ?');
      values.push(category === 'unseen' ? null : category);
    }
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
      ORDER BY m.modified_at ASC, m.relative_path COLLATE NOCASE ASC
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
      SELECT m.category, r.collection_id FROM media m JOIN roots r ON r.id = m.root_id WHERE m.id = ?
    `).get(mediaId);
    if (!item) throw new Error('Media item not found.');
    const next = category === 'unseen' ? null : category;
    this.db.prepare('UPDATE media SET category = ? WHERE id = ?').run(next, mediaId);
    this.log('decision_changed', { mediaId, previous: item.category, category: next, collectionId: item.collection_id });
  }

  listAudit(limit = 200) {
    return this.db.prepare('SELECT id, action, details, created_at FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit).map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }

  mediaPath(mediaId) {
    const item = this.db.prepare(`
      SELECT m.id, m.root_id, m.relative_path, r.path FROM media m
      JOIN roots r ON r.id = m.root_id WHERE m.id = ?
    `).get(mediaId);
    if (!item) return null;
    const fullPath = path.resolve(item.path, item.relative_path);
    if (!isWithin(item.path, fullPath)) return null;
    return { ...item, fullPath };
  }

  async planApply(collectionId) {
    const media = this.db.prepare(`
      SELECT m.id, m.root_id, m.relative_path, m.category, r.path, r.read_only
      FROM media m JOIN roots r ON r.id = m.root_id
      WHERE r.collection_id = ? AND m.category IN ('delete', 'unsure')
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
      try {
        const currentRoot = await fs.realpath(operation.root);
        const currentSource = await fs.realpath(operation.source);
        if (!comparePaths(currentRoot, operation.root) || !isWithin(currentRoot, currentSource)) {
          throw new Error('Source no longer resolves inside its registered root.');
        }
        const stat = await fs.stat(currentSource);
        if (!stat.isFile()) throw new Error('Source is not a regular file.');
        const output = path.dirname(operation.destination).split(path.sep).includes('deleted')
          ? path.join(operation.root, 'deleted')
          : path.join(operation.root, 'unsure');
        await fs.mkdir(output, { recursive: true });
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
          try { require('node:fs').accessSync(candidate); return true; } catch { return false; }
        });
        const destinationParent = await fs.realpath(path.dirname(destination));
        if (!isWithin(currentRoot, destinationParent)) throw new Error('Destination escaped its registered root.');
        const destinationDevice = (await fs.stat(destinationParent)).dev;
        if (stat.dev !== destinationDevice) throw new Error('Cross-volume moves are not supported.');
        const row = this.db.prepare('INSERT INTO apply_operations(batch_id, media_id, root_id, from_path, to_path, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(batchId, operation.mediaId, operation.rootId, currentSource, destination, operation.category, 'planned');
        await fs.rename(currentSource, destination);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('completed', row.lastInsertRowid);
        results.push({ source: currentSource, destination, status: 'moved' });
      } catch (error) {
        results.push({ source: operation.source, destination: operation.destination, status: 'failed', error: error.message });
        this.log('apply_failed', { batchId, moved: results.filter((result) => result.status === 'moved'), failed: results.at(-1) });
        return { batchId, results, stoppedOnFailure: true };
      }
    }
    this.log('apply_completed', { batchId, results });
    return { batchId, results, stoppedOnFailure: false };
  }

  async restoreLatest() {
    const batch = this.db.prepare('SELECT id FROM apply_batches ORDER BY created_at DESC LIMIT 1').get();
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
        const movedFile = await fs.realpath(operation.to_path);
        if (!isWithin(await fs.realpath(root), movedFile)) throw new Error('Moved file is outside the registered root.');
        try {
          await fs.access(operation.from_path);
          throw new Error('Original path is occupied; refusing to overwrite.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.mkdir(path.dirname(operation.from_path), { recursive: true });
        await fs.rename(operation.to_path, operation.from_path);
        this.db.prepare('UPDATE apply_operations SET status = ? WHERE id = ?').run('restored', operation.id);
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
        if (entry.internal || entry.family !== 'IPv4') continue;
        addresses.push({ name, address: entry.address, url: `http://${entry.address}:${port}` });
      }
    }
    return addresses;
  }

  async listen(port = Number(process.env.PHOTO_SORTER_PORT) || 43127) {
    const { createServer } = require('node:http');
    this.server = createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) this.sendJson(response, error.status || 400, { error: error.message });
        else response.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', resolve);
    });
    return this.server.address().port;
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

  requireSession(request) {
    const token = this.sessionToken(request);
    if (!token || !this.sessions.has(token)) throw Object.assign(new Error('Authentication required.'), { status: 401 });
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
        const token = crypto.randomBytes(32).toString('hex');
        this.sessions.set(token, Date.now());
        return this.sendJson(response, 201, { authenticated: true }, {
          'Set-Cookie': `photo_sorter_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
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
        const token = crypto.randomBytes(32).toString('hex');
        this.sessions.set(token, Date.now());
        return this.sendJson(response, 200, { authenticated: true }, {
          'Set-Cookie': `photo_sorter_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        const token = this.sessionToken(request);
        if (token) this.sessions.delete(token);
        return this.sendJson(response, 200, { authenticated: false }, {
          'Set-Cookie': 'photo_sorter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/network') {
        return this.sendJson(response, 200, { addresses: this.localAddresses(this.server.address().port) });
      }
      this.requireSession(request);
      if (request.method === 'GET' && url.pathname === '/api/collections') {
        return this.sendJson(response, 200, { collections: this.listCollections() });
      }
      if (request.method === 'POST' && url.pathname === '/api/collections') {
        const { name } = await this.readJson(request);
        return this.sendJson(response, 201, { id: this.createCollection(name) });
      }
      if (request.method === 'GET' && url.pathname === '/api/media') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const category = url.searchParams.get('category') || 'unseen';
        if (!CATEGORIES.has(category)) throw new Error('Invalid category.');
        const result = this.listMedia({
          collectionId: url.searchParams.get('collectionId'),
          category,
          offset,
          limit,
        });
        return this.sendJson(response, 200, result);
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/content$/i);
      if (request.method === 'GET' && mediaMatch) return this.serveMedia(mediaMatch[1], request, response);
      const decisionMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/decision$/i);
      if (request.method === 'PUT' && decisionMatch) {
        const { category } = await this.readJson(request);
        this.setDecision(decisionMatch[1], category);
        return this.sendJson(response, 200, { saved: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/apply/plan') {
        const { collectionId } = await this.readJson(request);
        return this.sendJson(response, 200, await this.planApply(collectionId));
      }
      if (request.method === 'POST' && url.pathname === '/api/rescan') {
        const { collectionId } = await this.readJson(request);
        if (!this.db.prepare('SELECT id FROM collections WHERE id = ? AND active = 1').get(collectionId)) {
          throw new Error('Collection not found.');
        }
        return this.sendJson(response, 200, { indexed: await this.rescanCollection(collectionId) });
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
      return this.sendJson(response, 404, { error: 'Not found.' });
    }
    return this.serveUi(url.pathname, response);
  }

  async serveMedia(mediaId, request, response) {
    const item = this.mediaPath(mediaId);
    if (!item) return this.sendJson(response, 404, { error: 'Media item not found.' });
    let resolved;
    try {
      resolved = await fs.realpath(item.fullPath);
      if (!isWithin(await fs.realpath(item.path), resolved)) return this.sendJson(response, 403, { error: 'Media is outside its registered root.' });
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
      return require('node:fs').createReadStream(resolved, { start, end }).pipe(response);
    }
    response.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    return require('node:fs').createReadStream(resolved).pipe(response);
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
  isWithin,
  numberedDestination,
  pathsOverlap,
};
