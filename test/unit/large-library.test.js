const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('large-library listing returns a bounded page near the end of 200,000 indexed items', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-large-library-'));
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const collectionId = app.createCollection('Large library');
  const rootId = 'fixture-root';
  app.db.prepare('INSERT INTO roots(id, collection_id, path) VALUES (?, ?, ?)')
    .run(rootId, collectionId, path.join(dataDirectory, 'virtual-root'));
  const insert = app.db.prepare(`
    INSERT INTO media(id, root_id, relative_path, size, modified_at, present)
    VALUES (?, ?, ?, 1, 0, 1)
  `);
  app.db.exec('BEGIN');
  try {
    for (let index = 0; index < 200_000; index += 1) {
      const filename = String(index).padStart(6, '0');
      insert.run(`media-${filename}`, rootId, `photo-${filename}.jpg`);
    }
    app.db.exec('COMMIT');
  } catch (error) {
    app.db.exec('ROLLBACK');
    throw error;
  }

  const page = app.listMedia({
    collectionId,
    category: 'unseen',
    sort: 'filename',
    offset: 199_940,
    limit: 60,
  });
  assert.equal(page.total, 200_000);
  assert.equal(page.items.length, 60);
  assert.equal(page.items[0].relative_path, 'photo-199940.jpg');
  assert.equal(page.items.at(-1).relative_path, 'photo-199999.jpg');
  const searchResults = app.listMedia({
    collectionId,
    category: 'unseen',
    sort: 'filename',
    search: 'photo-19999',
    limit: 60,
  });
  assert.equal(searchResults.total, 10);
  assert.equal(searchResults.items.length, 10);
  assert.equal(searchResults.items[0].relative_path, 'photo-199990.jpg');
  assert.equal(searchResults.items.at(-1).relative_path, 'photo-199999.jpg');

  app.db.prepare("UPDATE media SET category = 'unsure', unsure_reviewed_at = 1 WHERE id = ?")
    .run('media-199999');
  const reviewPage = app.listMedia({
    collectionId,
    category: 'review',
    sort: 'filename',
    offset: 199_940,
    limit: 60,
  });
  assert.equal(reviewPage.total, 200_000);
  assert.equal(reviewPage.items.length, 60);
  assert.equal(reviewPage.items.at(-1).relative_path, 'photo-199999.jpg');

  const createGroup = app.db.prepare(`
    INSERT INTO photo_health_groups(id, collection_id, match_type, created_at) VALUES (?, ?, 'exact', ?)
  `);
  const addMember = app.db.prepare('INSERT INTO photo_health_members(media_id, group_id, strength) VALUES (?, ?, 1)');
  const addAnalysis = app.db.prepare(`
    INSERT INTO photo_health_items(media_id, size, modified_at, kind, status, sha256, analyzed_at)
    VALUES (?, 1, 0, 'image', 'analyzed', ?, ?)
  `);
  const analyzedAt = new Date().toISOString();
  app.db.exec('BEGIN');
  try {
    for (let index = 0; index < 200; index += 2) {
      const groupId = `health-group-${String(index).padStart(3, '0')}`;
      createGroup.run(groupId, collectionId, analyzedAt);
      for (let member = index; member < index + 2; member += 1) {
        const mediaId = `media-${String(member).padStart(6, '0')}`;
        addMember.run(mediaId, groupId);
        addAnalysis.run(mediaId, `sha-${member}`, analyzedAt);
      }
    }
    app.db.exec('COMMIT');
  } catch (error) {
    app.db.exec('ROLLBACK');
    throw error;
  }
  const status = app.getPhotoHealthStatus(collectionId);
  assert.equal(status.total, 200_000);
  const startedAt = performance.now();
  const healthPage = app.listPhotoHealthFindings(collectionId, { type: 'duplicate', limit: 30 });
  const elapsed = performance.now() - startedAt;
  assert.equal(healthPage.total, 100);
  assert.equal(healthPage.items.length, 30);
  assert.equal(app.listPhotoHealthFindings(collectionId, {
    type: 'duplicate', limit: 30, offset: 30,
  }).items.length, 30);
  const groupPage = app.listPhotoHealthGroup(collectionId, healthPage.items[0].groupId, { limit: 1 });
  assert.equal(groupPage.total, 2);
  assert.equal(groupPage.items.length, 1);
  t.diagnostic(`Photo Health page over 200,000 indexed items returned 30 of 100 groups in ${elapsed.toFixed(1)} ms.`);

  const popularCategory = app.createCategory(collectionId, 'Popular');
  const lessUsedCategory = app.createCategory(collectionId, 'Less used');
  app.db.prepare('UPDATE media SET category = ? WHERE root_id = ? AND id < ?')
    .run(popularCategory.id, rootId, 'media-150000');
  app.db.prepare('UPDATE media SET category = ? WHERE root_id = ? AND id >= ?')
    .run(lessUsedCategory.id, rootId, 'media-150000');
  const categoriesStartedAt = performance.now();
  const categories = app.listCategories(collectionId);
  const categoriesElapsed = performance.now() - categoriesStartedAt;
  assert.deepEqual(categories.map(({ id, assignedCount }) => [id, assignedCount]), [
    [popularCategory.id, 150_000],
    [lessUsedCategory.id, 50_000],
  ]);
  t.diagnostic(`Category ordering over 200,000 assignments returned ${categories.length} categories in ${categoriesElapsed.toFixed(1)} ms.`);
});
