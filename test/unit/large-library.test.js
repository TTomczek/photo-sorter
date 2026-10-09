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
});
