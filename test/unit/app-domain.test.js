const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PhotoSorter, defaultDataDirectory } = require('../../src/app');

async function createSorter(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-domain-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'alpha.jpg'), 'alpha');
  await fs.writeFile(path.join(root, 'bravo.png'), 'bravo');
  await fs.writeFile(path.join(root, 'charlie.mp4'), 'charlie');
  const app = await new PhotoSorter({ dataDirectory: path.join(temporary, 'data') }).initialize();
  await new Promise((resolve) => setImmediate(resolve));
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection(' Domain collection ');
  await app.addRoot(collectionId, root);
  return { app, collectionId, root };
}

test('password setup and changes validate strength, store salted hashes, and authenticate correctly', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-password-'));
  const app = await new PhotoSorter({ dataDirectory: temporary }).initialize();
  const originalPassword = 'A sufficiently strong password! 42';
  const replacementPassword = 'Another secure password! 42';
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await assert.rejects(app.createPassword('too-short'), /at least 12 characters/);
  for (const weakPassword of [
    'a sufficiently long 123!',
    'A SUFFICIENTLY LONG 123!',
    'A sufficiently long password!',
    'A sufficiently long password 123',
  ]) {
    await assert.rejects(app.createPassword(weakPassword), /uppercase letter.*special character/);
  }
  await app.createPassword(originalPassword);
  const account = app.db.prepare('SELECT salt, password_hash FROM account WHERE id = 1').get();
  assert.notEqual(account.password_hash, originalPassword);
  assert.notEqual(account.salt, account.password_hash);
  assert.equal(await app.authenticate(originalPassword), true);
  assert.equal(await app.authenticate('incorrect password'), false);
  await assert.rejects(app.changePassword('incorrect password', replacementPassword), /Current password is incorrect/);
  await assert.rejects(app.changePassword(originalPassword, 'short'), /at least 12 characters/);
  await app.changePassword(originalPassword, replacementPassword);
  const changedAccount = app.db.prepare('SELECT salt, password_hash FROM account WHERE id = 1').get();
  assert.notEqual(changedAccount.salt, account.salt);
  assert.equal(await app.authenticate(originalPassword), false);
  assert.equal(await app.authenticate(replacementPassword), true);
  await assert.rejects(app.createPassword('another sufficiently long password'), /already been completed/);
});

test('collection/media queries honor capture fallback, filename order, category filters and bounded pagination', async (t) => {
  const { app, collectionId } = await createSorter(t);
  const collection = app.listCollections().find((entry) => entry.id === collectionId);
  assert.equal(collection.name, 'Domain collection');
  const byName = app.listMedia({ collectionId, category: 'unseen', sort: 'filename' });
  assert.equal(byName.total, 3);
  assert.deepEqual(byName.items.map((item) => item.relative_path), ['alpha.jpg', 'bravo.png', 'charlie.mp4']);
  assert.equal(byName.items.find((item) => item.relative_path === 'charlie.mp4').kind, 'video');

  const [alpha, bravo, charlie] = byName.items;
  app.db.prepare('UPDATE media SET capture_at = ? WHERE id = ?').run('2024-02-01T00:00:00.000Z', alpha.id);
  app.db.prepare('UPDATE media SET capture_at = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', bravo.id);
  app.db.prepare('UPDATE media SET modified_at = ? WHERE id = ?').run(Date.parse('2025-01-01T00:00:00Z'), charlie.id);

  assert.deepEqual(app.listMedia({ collectionId, category: 'unseen', sort: 'capture-asc' })
    .items.map((item) => item.id), [bravo.id, alpha.id, charlie.id]);
  assert.deepEqual(app.listMedia({ collectionId, category: 'unseen', sort: 'capture-desc' })
    .items.map((item) => item.id), [charlie.id, alpha.id, bravo.id]);

  const page = app.listMedia({ collectionId, category: 'unseen', sort: 'filename', offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.offset, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, bravo.id);
  assert.throws(() => app.listMedia({ collectionId, category: 'unseen', sort: 'random' }), /Invalid sort order/);
});

test('library filters search path prefixes and bound type, root, and date results', async (t) => {
  const { app, collectionId } = await createSorter(t);
  const roots = app.listRoots(collectionId);
  const items = app.listMedia({ collectionId, category: 'all', sort: 'filename' }).items;
  const alpha = items.find((item) => item.relative_path === 'alpha.jpg');
  const bravo = items.find((item) => item.relative_path === 'bravo.png');
  const charlie = items.find((item) => item.relative_path === 'charlie.mp4');
  app.db.prepare('UPDATE media SET capture_at = ? WHERE id = ?')
    .run('2024-02-01T12:00:00.000Z', alpha.id);
  app.db.prepare('UPDATE media SET modified_at = ? WHERE id = ?')
    .run(Date.parse('2024-01-10T00:00:00.000Z'), bravo.id);
  app.db.prepare('UPDATE media SET modified_at = ? WHERE id = ?')
    .run(Date.parse('2024-03-10T00:00:00.000Z'), charlie.id);

  const byPrefixAndKind = app.listMedia({
    collectionId, category: 'all', search: 'BR', kind: 'image', rootId: roots[0].id,
  });
  assert.deepEqual(byPrefixAndKind.items.map((item) => item.relative_path), ['bravo.png']);
  assert.equal(app.listMedia({
    collectionId, category: 'all', search: '%', sort: 'filename',
  }).total, 0);
  assert.deepEqual(app.listMedia({
    collectionId, category: 'all', fromDate: '2024-02-01', toDate: '2024-02-01',
  }).items.map((item) => item.relative_path), ['alpha.jpg']);
  assert.deepEqual(app.listMedia({
    collectionId, category: 'all', kind: 'video',
  }).items.map((item) => item.relative_path), ['charlie.mp4']);
  assert.throws(() => app.listMedia({
    collectionId, category: 'all', rootId: 'another-collection-root',
  }), /Root not found in this collection/);
  assert.throws(() => app.listMedia({
    collectionId, category: 'all', fromDate: '2024-02-30',
  }), /Invalid date filter/);
  assert.throws(() => app.listMedia({
    collectionId, category: 'all', fromDate: '2024-03-01', toDate: '2024-02-01',
  }), /Start date must be on or before end date/);
});

test('legacy SQLite data is upgraded with versioned migrations and remains usable', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-migration-'));
  const filename = path.join(temporary, 'photo-sorter.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE roots (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id),
      path TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 1, read_only INTEGER NOT NULL DEFAULT 0,
      UNIQUE(collection_id, path)
    );
    CREATE TABLE media (
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), relative_path TEXT NOT NULL,
      size INTEGER NOT NULL, modified_at INTEGER NOT NULL, category TEXT,
      UNIQUE(root_id, relative_path)
    );
    CREATE TABLE apply_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES apply_batches(id),
      media_id TEXT NOT NULL, root_id TEXT NOT NULL, from_path TEXT NOT NULL, to_path TEXT NOT NULL,
      category TEXT NOT NULL, status TEXT NOT NULL
    );
    INSERT INTO collections VALUES ('legacy-collection', 'Legacy', 0, '2024-01-01T00:00:00.000Z');
    INSERT INTO roots(id, collection_id, path) VALUES ('legacy-root', 'legacy-collection', 'C:/legacy');
    INSERT INTO media(id, root_id, relative_path, size, modified_at, category)
      VALUES ('legacy-video', 'legacy-root', 'clip.MP4', 42, 1704067200000, 'keep');
  `);
  legacy.close();
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));

  const app = await new PhotoSorter({ dataDirectory: temporary }).initialize();
  assert.equal(app.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.deepEqual(
    { ...app.db.prepare('SELECT id, active FROM roots WHERE id = ?').get('legacy-root') },
    { id: 'legacy-root', active: 1 },
  );
  assert.deepEqual(
    { ...app.db.prepare('SELECT id, category, kind, present FROM media WHERE id = ?').get('legacy-video') },
    { id: 'legacy-video', category: 'keep', kind: 'video', present: 1 },
  );
  assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photo_health_items'").get());
  await app.close();

  const reopened = await new PhotoSorter({ dataDirectory: temporary }).initialize();
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM media').get().count, 1);
  await reopened.close();
});

test('unsupported recursive watching switches to periodic scan recovery', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-watch-fallback-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'first.jpg'), 'first');
  const error = Object.assign(new Error('Recursive watching is not supported'), {
    code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
  });
  const app = await new PhotoSorter({
    dataDirectory: path.join(temporary, 'data'),
    watchFactory: () => { throw error; },
    watchFallbackIntervalMs: 20,
  }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection('Fallback');
  const rootId = await app.addRoot(collectionId, root);
  const fallback = app.listScanStatus(collectionId)[0];
  assert.equal(fallback.watch.mode, 'polling');
  assert.equal(fallback.watch.error, error.message);

  await fs.writeFile(path.join(root, 'second.jpg'), 'second');
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const count = app.listMedia({ collectionId, category: 'all' }).total;
    if (count === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(app.listMedia({ collectionId, category: 'all' }).total, 2);
  assert.equal(app.listScanStatus(collectionId)[0].rootId, rootId);
});

test('failed root scans retain a visible error and can be retried only in their collection', async (t) => {
  const { app, collectionId, root } = await createSorter(t);
  const [registeredRoot] = app.listRoots(collectionId);
  const rootId = registeredRoot.id;
  await fs.rm(root, { recursive: true });
  await assert.rejects(app.scanRoot(rootId));

  const [scan] = app.listScanStatus(collectionId);
  assert.equal(scan.status, 'failed');
  assert.equal(scan.online, 0);
  assert.equal(scan.errorCount, 1);
  assert.equal(scan.errors[0].path, registeredRoot.path);
  assert.match(scan.errors[0].message, /ENOENT/);
  assert.throws(() => app.startRootScan('different-collection', rootId), /Root not found in this collection/);
  assert.deepEqual(app.startRootScan(collectionId, rootId), { started: true, rootId });
});

test('partial scans report individual unreadable folders and retain incomplete presence information', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-partial-scan-'));
  const root = path.join(temporary, 'library');
  const blocked = path.join(root, 'unreadable');
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(root, 'visible.jpg'), 'visible');
  await fs.writeFile(path.join(blocked, 'hidden.jpg'), 'hidden');
  const denied = Object.assign(new Error('Permission denied by test fixture'), { code: 'EACCES' });
  let denyDirectory = false;
  let blockedPath = blocked;
  const scanFs = {
    realpath: fs.realpath.bind(fs),
    lstat: fs.lstat.bind(fs),
    readdir: async (directory, options) => {
      if (denyDirectory && directory === blockedPath) throw denied;
      return fs.readdir(directory, options);
    },
  };
  const app = await new PhotoSorter({
    dataDirectory: path.join(temporary, 'data'),
    scanFs,
  }).initialize();
  await new Promise((resolve) => setImmediate(resolve));
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection('Partial scan');
  const rootId = await app.addRoot(collectionId, root);
  const registeredRoot = app.listRoots(collectionId)[0].path;
  blockedPath = path.join(registeredRoot, 'unreadable');
  denyDirectory = true;
  await app.scanRoot(rootId);

  const [scan] = app.listScanStatus(collectionId);
  assert.equal(scan.status, 'completed');
  assert.equal(scan.errorCount, 1);
  assert.deepEqual(scan.errors.map((issue) => issue.path), [path.join(registeredRoot, 'unreadable')]);
  assert.equal(scan.errors[0].message, denied.message);
  assert.equal(app.listMedia({ collectionId, category: 'all' }).total, 2);
});

test('review queue orders unseen first and defers repeated unsure decisions to the pass tail', async (t) => {
  const { app, collectionId } = await createSorter(t);
  const items = app.listMedia({ collectionId, category: 'unseen', sort: 'filename' }).items;
  const [alpha, bravo, charlie] = items;

  app.claimMediaLock(alpha.id, 'device-a');
  app.setDeviceDecision(alpha.id, 'unsure', 'device-a');
  assert.deepEqual(app.listMedia({ collectionId, category: 'review', sort: 'filename' })
    .items.map((item) => item.relative_path), ['bravo.png', 'charlie.mp4', 'alpha.jpg']);

  app.claimMediaLock(bravo.id, 'device-a');
  app.setDeviceDecision(bravo.id, 'unsure', 'device-a');
  assert.deepEqual(app.listMedia({ collectionId, category: 'review', sort: 'filename' })
    .items.map((item) => item.relative_path), ['charlie.mp4', 'alpha.jpg', 'bravo.png']);

  app.claimMediaLock(alpha.id, 'device-a');
  app.setDeviceDecision(alpha.id, 'unsure', 'device-a');
  assert.deepEqual(app.listMedia({ collectionId, category: 'review', sort: 'filename' })
    .items.map((item) => item.relative_path), ['charlie.mp4', 'bravo.png', 'alpha.jpg']);
  assert.equal(app.saveDeviceState('device-a', collectionId, {
    category: 'review', sort: 'filename', mediaId: charlie.id, offset: 0,
  }).category, 'review');
});

test('device state, category decisions, history and expiring locks stay scoped and validated', async (t) => {
  const { app, collectionId } = await createSorter(t);
  const items = app.listMedia({ collectionId, category: 'unseen', sort: 'filename' }).items;
  const [item] = items;

  assert.equal(app.getLastCollection('device-a'), null);
  assert.deepEqual(app.setLastCollection('device-a', collectionId), { collectionId });
  assert.equal(app.getLastCollection('device-a'), collectionId);
  assert.equal(app.getLastCollection('device-b'), null);

  const state = app.saveDeviceState('device-a', collectionId, {
    category: 'all', sort: 'date-desc', mediaId: item.id, offset: 60,
  });
  assert.deepEqual({ ...state }, {
    category: 'all', sort: 'capture-desc', mediaId: item.id, offset: 60,
  });
  assert.throws(() => app.saveDeviceState('device-a', collectionId, {
    category: 'purge', sort: 'filename', mediaId: item.id, offset: 0,
  }), /Invalid review position/);
  assert.throws(() => app.saveDeviceState('device-a', collectionId, {
    category: 'unseen', sort: 'filename', mediaId: 'outside-item', offset: 0,
  }), /Media item not found/);

  app.claimMediaLock(item.id, 'device-a');
  assert.throws(() => app.claimMediaLock(item.id, 'device-b'), { status: 409 });
  app.setDeviceDecision(item.id, 'keep', 'device-a');
  assert.equal(app.listMedia({ collectionId, category: 'keep' }).total, 1);
  const allItems = app.listMedia({ collectionId, category: 'all' });
  assert.equal(allItems.total, 3);
  assert.equal(allItems.items.find((candidate) => candidate.id === item.id).category, 'keep');
  app.setDeviceDecision(item.id, 'delete', 'device-a');
  assert.equal(app.listMedia({ collectionId, category: 'delete' }).total, 1);
  assert.equal((await app.changeDecisionHistory('device-a', 'undo')).category, 'unseen');
  assert.equal(app.db.prepare('SELECT category FROM media WHERE id = ?').get(item.id).category, null);
  assert.equal((await app.changeDecisionHistory('device-a', 'undo')).changed, false);

  app.db.prepare('UPDATE media_locks SET expires_at = ? WHERE media_id = ?').run(Date.now() - 1, item.id);
  assert.throws(() => app.setDeviceDecision(item.id, 'delete', 'device-a'), { status: 409 });
  app.claimMediaLock(item.id, 'device-b');
  app.setDeviceDecision(item.id, 'unseen', 'device-b');
  assert.equal(app.listMedia({ collectionId, category: 'unseen' }).total, 3);
  assert.ok(app.listAudit().some((event) => event.action === 'decision_changed'));
});

test('custom app-data directory overrides platform defaults without leaking environment state', (t) => {
  const previous = process.env.PHOTO_SORTER_DATA_DIR;
  const override = path.join(os.tmpdir(), 'photo-sorter-custom-data');
  t.after(() => {
    if (previous === undefined) delete process.env.PHOTO_SORTER_DATA_DIR;
    else process.env.PHOTO_SORTER_DATA_DIR = previous;
  });
  process.env.PHOTO_SORTER_DATA_DIR = override;
  assert.equal(defaultDataDirectory(), path.resolve(override));
});
