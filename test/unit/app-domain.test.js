const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter, defaultDataDirectory } = require('../../src/app');

async function createSorter(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-domain-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'alpha.jpg'), 'alpha');
  await fs.writeFile(path.join(root, 'bravo.png'), 'bravo');
  await fs.writeFile(path.join(root, 'charlie.mp4'), 'charlie');
  const app = await new PhotoSorter({ dataDirectory: path.join(temporary, 'data') }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection(' Domain collection ');
  await app.addRoot(collectionId, root);
  return { app, collectionId, root };
}

test('password setup validates strength, stores only a salted hash, and authenticates correctly', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-password-'));
  const app = await new PhotoSorter({ dataDirectory: temporary }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await assert.rejects(app.createPassword('too-short'), /at least 12 characters/);
  await app.createPassword('a password with enough length');
  const account = app.db.prepare('SELECT salt, password_hash FROM account WHERE id = 1').get();
  assert.notEqual(account.password_hash, 'a password with enough length');
  assert.notEqual(account.salt, account.password_hash);
  assert.equal(await app.authenticate('a password with enough length'), true);
  assert.equal(await app.authenticate('incorrect password'), false);
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

test('device state, category decisions, history and expiring locks stay scoped and validated', async (t) => {
  const { app, collectionId } = await createSorter(t);
  const items = app.listMedia({ collectionId, category: 'unseen', sort: 'filename' }).items;
  const [item] = items;

  assert.equal(app.getLastCollection('device-a'), null);
  assert.deepEqual(app.setLastCollection('device-a', collectionId), { collectionId });
  assert.equal(app.getLastCollection('device-a'), collectionId);
  assert.equal(app.getLastCollection('device-b'), null);

  const state = app.saveDeviceState('device-a', collectionId, {
    category: 'unseen', sort: 'date-desc', mediaId: item.id, offset: 60,
  });
  assert.deepEqual({ ...state }, {
    category: 'unseen', sort: 'capture-desc', mediaId: item.id, offset: 60,
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
  assert.equal((await app.changeDecisionHistory('device-a', 'undo')).category, 'unseen');
  assert.equal((await app.changeDecisionHistory('device-a', 'redo')).category, 'keep');

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
