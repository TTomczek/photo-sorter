const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('authenticated collection scan, review, safe apply, and conflict-aware restore', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-e2e-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  const external = path.join(temporary, 'outside.jpg');
  await fs.mkdir(path.join(root, 'trip'), { recursive: true });
  await fs.writeFile(path.join(root, 'trip', 'photo.jpg'), 'original-photo');
  await fs.writeFile(path.join(root, 'trip', 'clip.mp4'), 'video-content');
  await fs.writeFile(path.join(root, 'trip', 'document.pdf'), 'not-media');
  await fs.writeFile(external, 'outside-media');
  await fs.mkdir(path.join(root, 'deleted'), { recursive: true });
  await fs.writeFile(path.join(root, 'deleted', 'photo.jpg'), 'pre-existing-file');
  try { await fs.symlink(external, path.join(root, 'linked.jpg')); } catch {}

  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Weekend');
  const registeredRootId = await app.addRoot(collectionId, root);
  assert.equal(await app.addRoot(collectionId, root), registeredRootId);
  const anotherCollectionId = app.createCollection('Other');
  await assert.rejects(app.addRoot(anotherCollectionId, path.join(root, 'trip')), /overlaps/);
  const port = await app.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = '';

  const api = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
    });
    const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (setCookies.length) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };

  const unauthorized = await api('/api/collections');
  assert.equal(unauthorized.response.status, 401);
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'a secure test password' }) });
  assert.equal(login.response.status, 200);
  const otherDevice = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(otherDevice.cookie ? { Cookie: otherDevice.cookie } : {}),
        ...(options.headers || {}),
      },
    });
    const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (setCookies.length) otherDevice.cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };
  otherDevice.cookie = '';
  const secondLogin = await otherDevice('/api/login', {
    method: 'POST', body: JSON.stringify({ password: 'a secure test password' }),
  });
  assert.equal(secondLogin.response.status, 200);

  const collection = await api('/api/collections');
  assert.equal(collection.body.collections[0].name, 'Weekend');
  const network = await api('/api/network');
  assert.equal(network.response.status, 200);
  assert.ok(network.body.addresses.every((address) => address.qrDataUrl.startsWith('data:image/png;base64,')));
  assert.deepEqual((await api('/api/settings')).body, {
    defaultSort: 'capture-asc',
    previewCacheLimitMb: 2048,
  });
  const cachedPreviewName = `${'a'.repeat(64)}.jpg`;
  const cachedPreviewPath = path.join(dataDirectory, 'previews', cachedPreviewName);
  await fs.mkdir(path.dirname(cachedPreviewPath), { recursive: true });
  await fs.writeFile(cachedPreviewPath, 'cached');
  app.db.prepare(`
    INSERT INTO preview_cache(cache_key, filename, size, last_accessed) VALUES (?, ?, ?, ?)
  `).run('a'.repeat(64), cachedPreviewName, 5, Date.now());
  const savedSettings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ defaultSort: 'filename', previewCacheLimitMb: 0 }),
  });
  assert.deepEqual(savedSettings.body, { defaultSort: 'filename', previewCacheLimitMb: 0 });
  await assert.rejects(fs.stat(cachedPreviewPath), { code: 'ENOENT' });
  assert.equal((await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ defaultSort: 'invalid', previewCacheLimitMb: -1 }),
  })).response.status, 400);
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ defaultSort: 'capture-asc', previewCacheLimitMb: 2048 }),
  });
  assert.equal((await api('/api/preferences')).body.lastCollectionId, null);
  assert.equal((await api('/api/preferences', {
    method: 'PUT', body: JSON.stringify({ lastCollectionId: collectionId }),
  })).body.collectionId, collectionId);
  assert.equal((await api('/api/preferences')).body.lastCollectionId, collectionId);
  assert.equal((await otherDevice('/api/preferences')).body.lastCollectionId, null);
  const savedPosition = await api('/api/device-state', {
    method: 'PUT',
    body: JSON.stringify({ collectionId, category: 'unseen', sort: 'capture-asc', mediaId: null, offset: 0 }),
  });
  assert.equal(savedPosition.body.state.sort, 'capture-asc');
  assert.equal((await api(`/api/device-state?collectionId=${collectionId}`)).body.state.category, 'unseen');
  assert.equal((await otherDevice(`/api/device-state?collectionId=${collectionId}`)).body.state, null);
  const arbitraryRoot = await api('/api/roots', { method: 'POST', body: JSON.stringify({ path: '/etc' }) });
  assert.equal(arbitraryRoot.response.status, 404);
  const unseen = await api(`/api/media?collectionId=${collectionId}&category=unseen`);
  assert.equal(unseen.body.total, 2);
  assert.deepEqual(new Set(unseen.body.items.map((item) => item.kind)), new Set(['image', 'video']));
  assert.equal(unseen.body.items.some((item) => item.relative_path.includes('linked')), false);

  const photo = unseen.body.items.find((item) => item.relative_path.endsWith('photo.jpg'));
  assert.equal((await api(`/api/media/${photo.id}/preview`)).response.status, 404);
  const preview = await api(`/api/media/${photo.id}/content`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(preview.response.status, 206);
  assert.equal(preview.body, 'orig');
  assert.equal(preview.response.headers.get('content-range'), 'bytes 0-3/14');
  const traversal = await api('/api/media/../../outside.jpg/content');
  assert.equal(traversal.response.status, 404);

  const decision = await api(`/api/media/${photo.id}/decision`, {
    method: 'PUT', body: JSON.stringify({ category: 'delete' }),
  });
  assert.equal(decision.response.status, 409);
  const lock = await api(`/api/media/${photo.id}/lock`, { method: 'POST' });
  assert.equal(lock.response.status, 200);
  const competingLock = await otherDevice(`/api/media/${photo.id}/lock`, { method: 'POST' });
  assert.equal(competingLock.response.status, 409);
  const competingDecision = await otherDevice(`/api/media/${photo.id}/decision`, {
    method: 'PUT', body: JSON.stringify({ category: 'keep' }),
  });
  assert.equal(competingDecision.response.status, 409);
  const savedItemPosition = await api('/api/device-state', {
    method: 'PUT',
    body: JSON.stringify({ collectionId, category: 'unseen', sort: 'capture-asc', mediaId: photo.id, offset: 0 }),
  });
  assert.equal(savedItemPosition.body.state.mediaId, photo.id);
  const decisionSaved = await api(`/api/media/${photo.id}/decision`, {
    method: 'PUT', body: JSON.stringify({ category: 'delete' }),
  });
  assert.equal(decisionSaved.response.status, 200);
  const undone = await api('/api/decisions/undo', { method: 'POST', body: '{}' });
  assert.equal(undone.body.changed, true);
  assert.equal(undone.body.category, 'unseen');
  const redone = await api('/api/decisions/redo', { method: 'POST', body: '{}' });
  assert.equal(redone.body.changed, true);
  assert.equal(redone.body.category, 'delete');
  app.db.prepare('UPDATE media_locks SET expires_at = ? WHERE media_id = ?').run(Date.now() - 1, photo.id);
  const expiredLockDecision = await api(`/api/media/${photo.id}/decision`, {
    method: 'PUT', body: JSON.stringify({ category: 'keep' }),
  });
  assert.equal(expiredLockDecision.response.status, 409);
  assert.equal((await otherDevice(`/api/media/${photo.id}/lock`, { method: 'POST' })).response.status, 200);
  await otherDevice(`/api/media/${photo.id}/lock`, { method: 'DELETE' });
  await api(`/api/media/${photo.id}/lock`, { method: 'POST' });
  const invalidDecision = await api(`/api/media/${photo.id}/decision`, {
    method: 'PUT', body: JSON.stringify({ category: 'purge' }),
  });
  assert.equal(invalidDecision.response.status, 400);
  assert.equal(await fs.readFile(path.join(root, 'trip', 'photo.jpg'), 'utf8'), 'original-photo');

  const unownedPlan = await api('/api/apply/plan', {
    method: 'POST', body: JSON.stringify({ collectionId }),
  });
  assert.equal(unownedPlan.body.requiresOutputFolderConsent, true);
  const missingConsent = await api('/api/apply/confirm', {
    method: 'POST',
    body: JSON.stringify({ planId: unownedPlan.body.id, confirm: true }),
  });
  assert.equal(missingConsent.response.status, 400);
  assert.equal(await fs.readFile(path.join(root, 'trip', 'photo.jpg'), 'utf8'), 'original-photo');

  const plan = await api('/api/apply/plan', { method: 'POST', body: JSON.stringify({ collectionId }) });
  const applied = await api('/api/apply/confirm', {
    method: 'POST',
    body: JSON.stringify({ planId: plan.body.id, confirm: true, reuseOutputFolders: true }),
  });
  assert.equal(applied.body.results[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(root, 'deleted', 'trip', 'photo.jpg'), 'utf8'), 'original-photo');
  assert.equal(await fs.readFile(path.join(root, 'deleted', 'photo.jpg'), 'utf8'), 'pre-existing-file');

  app.db.prepare('INSERT INTO apply_batches(id, created_at) VALUES (?, ?)')
    .run('empty-failed-batch', new Date(Date.now() + 1000).toISOString());
  const restored = await api('/api/restore', { method: 'POST', body: '{}' });
  assert.equal(restored.body.batchId, applied.body.batchId);
  assert.equal(restored.body.results[0].status, 'restored');
  assert.equal(await fs.readFile(path.join(root, 'trip', 'photo.jpg'), 'utf8'), 'original-photo');

  const nextPlan = await api('/api/apply/plan', { method: 'POST', body: JSON.stringify({ collectionId }) });
  const nextApply = await api('/api/apply/confirm', {
    method: 'POST',
    body: JSON.stringify({ planId: nextPlan.body.id, confirm: true }),
  });
  assert.equal(nextApply.body.results[0].status, 'moved');
  await fs.writeFile(path.join(root, 'trip', 'photo.jpg'), 'new-file-at-original');
  const conflict = await api('/api/restore', { method: 'POST', body: '{}' });
  assert.equal(conflict.body.results[0].status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'trip', 'photo.jpg'), 'utf8'), 'new-file-at-original');
  assert.equal((await api('/api/audit')).body.events.some((event) => event.action === 'decision_changed'), true);
  assert.equal((await api('/api/audit/export')).body.events.length > 0, true);
  const clearedAudit = await api('/api/audit', { method: 'DELETE', body: '{}' });
  assert.ok(clearedAudit.body.clearedCount > 0);
  assert.deepEqual((await api('/api/audit')).body.events.map((event) => event.action), ['audit_cleared']);
});

test('a symlinked output directory cannot redirect an apply outside its registered root', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-symlink-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  const externalOutput = path.join(temporary, 'external-output');
  await fs.mkdir(root);
  await fs.mkdir(externalOutput);
  await fs.writeFile(path.join(root, 'keep-safe.jpg'), 'original');
  await fs.writeFile(path.join(externalOutput, 'keep-safe.jpg'), 'outside-original');
  try {
    await fs.symlink(externalOutput, path.join(root, 'deleted'), 'dir');
  } catch {
    await fs.rm(temporary, { recursive: true, force: true });
    return t.skip('Directory symlinks are unavailable.');
  }
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Safe collection');
  await app.addRoot(collectionId, root);
  const item = app.listMedia({ collectionId, category: 'unseen' }).items[0];
  app.setDecision(item.id, 'delete');
  const plan = await app.planApply(collectionId);
  const result = await app.confirmApply(plan.id, { confirm: true, reuseOutputFolders: true });
  assert.equal(result.stoppedOnFailure, true);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error, /real directory/);
  assert.equal(await fs.readFile(path.join(root, 'keep-safe.jpg'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(externalOutput, 'keep-safe.jpg'), 'utf8'), 'outside-original');
});

test('replacing a registered root with a symlink cannot expose its new target', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-root-symlink-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  const originalDirectory = path.join(temporary, 'registered-photos');
  const externalDirectory = path.join(temporary, 'external-photos');
  await fs.mkdir(root);
  await fs.mkdir(externalDirectory);
  await fs.writeFile(path.join(root, 'inside.jpg'), 'registered-original');
  await fs.writeFile(path.join(externalDirectory, 'inside.jpg'), 'outside-secret');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Root identity');
  const rootId = await app.addRoot(collectionId, root);
  await fs.rename(root, originalDirectory);
  try {
    await fs.symlink(externalDirectory, root, 'dir');
  } catch {
    return t.skip('Directory symlinks are unavailable.');
  }
  await assert.rejects(app.scanRoot(rootId), /original directory/);

  const port = await app.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a secure test password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const item = app.listMedia({ collectionId, category: 'unseen' }).items[0];
  const preview = await fetch(`${baseUrl}/api/media/${item.id}/content`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 403);
  assert.equal(await fs.readFile(path.join(externalDirectory, 'inside.jpg'), 'utf8'), 'outside-secret');
});

test('root removal and collection archival preserve history while releasing active root ownership', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-collections-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'remember.jpg'), 'history');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const originalCollection = app.createCollection('Original');
  const registeredRoot = await app.addRoot(originalCollection, root);
  const media = app.listMedia({ collectionId: originalCollection, category: 'unseen' }).items[0];
  app.setDecision(media.id, 'keep');
  const nestedRoot = path.join(root, 'nested');
  await fs.mkdir(nestedRoot);
  const replacementCollection = app.createCollection('Replacement');
  await assert.rejects(app.addRoot(replacementCollection, nestedRoot), /overlaps/);

  const port = await app.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a secure test password' }),
  });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  app.archiveCollection(originalCollection);
  const replacementRoot = await app.addRoot(replacementCollection, nestedRoot);
  assert.ok(replacementRoot);
  await assert.rejects(async () => app.restoreCollection(originalCollection), /overlaps/);
  app.archiveCollection(replacementCollection);
  assert.equal(app.listCollections().some((item) => item.id === replacementCollection), false);
  assert.equal(app.listArchivedCollections().some((item) => item.id === replacementCollection), true);
  app.restoreCollection(originalCollection);
  assert.equal(app.db.prepare('SELECT category FROM media WHERE id = ?').get(media.id).category, 'keep');

  const removeResponse = await fetch(
    `http://127.0.0.1:${port}/api/collections/${originalCollection}/roots/${registeredRoot}`,
    { method: 'DELETE', headers: { Cookie: cookies } },
  );
  assert.equal(removeResponse.status, 200);
  assert.equal(app.listMedia({ collectionId: originalCollection, category: 'keep' }).total, 0);
  assert.equal(await app.addRoot(originalCollection, root), registeredRoot);
  assert.equal(app.db.prepare('SELECT category FROM media WHERE id = ?').get(media.id).category, 'keep');

  const exported = app.exportAudit();
  assert.ok(exported.events.some((event) => event.action === 'root_removed'));
  const cleared = app.clearAudit();
  assert.ok(cleared.clearedCount > 0);
  assert.deepEqual(app.listAudit().map((event) => event.action), ['audit_cleared']);
});

test('background scans expose incremental progress and finish indexing without blocking the caller', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-scan-progress-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  await Promise.all(Array.from({ length: 300 }, (_, index) =>
    fs.writeFile(path.join(root, `image-${index}.jpg`), `photo-${index}`)));
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Large collection');
  const rootId = await app.addRoot(collectionId, root, { waitForScan: false });
  const initial = app.listScanStatus(collectionId);
  assert.equal(initial.length, 1);
  assert.ok(['queued', 'running'].includes(initial[0].status));
  assert.ok(app.listMedia({ collectionId, category: 'unseen', limit: 1 }).items.length <= 1);

  await app.scanRoot(rootId);
  const completed = app.listScanStatus(collectionId)[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.indexed, 300);
  assert.equal(completed.visited, 300);
  app.db.prepare('UPDATE media SET capture_at = ? WHERE relative_path = ?').run('2020-01-02T00:00:00.000Z', 'image-1.jpg');
  app.db.prepare('UPDATE media SET capture_at = ? WHERE relative_path = ?').run('2020-01-01T00:00:00.000Z', 'image-2.jpg');
  assert.equal(app.listMedia({ collectionId, category: 'unseen', sort: 'capture-asc', limit: 1 }).items[0].relative_path, 'image-2.jpg');

  const port = await app.listen(0);
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a secure test password' }),
  });
  const cookies = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const baseUrl = `http://127.0.0.1:${port}`;
  const queued = await fetch(`${baseUrl}/api/rescan`, {
    method: 'POST',
    headers: { Cookie: cookies, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collectionId }),
  });
  assert.equal(queued.status, 202);
  const progressResponse = await fetch(`${baseUrl}/api/scans?collectionId=${collectionId}`, {
    headers: { Cookie: cookies },
  });
  assert.equal(progressResponse.status, 200);
  await app.scanRoot(rootId);
  const progress = await fetch(`${baseUrl}/api/scans?collectionId=${collectionId}`, {
    headers: { Cookie: cookies },
  });
  assert.equal((await progress.json()).scans[0].status, 'completed');
});

test('root watcher indexes additions, resets changed-file decisions, and hides removals', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-watch-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  const original = path.join(root, 'original.jpg');
  await fs.writeFile(original, 'before');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Watched');
  const rootId = await app.addRoot(collectionId, root);
  if (!app.rootWatchers.has(rootId)) return t.skip('Recursive filesystem watching is unavailable.');
  const originalItem = app.listMedia({ collectionId, category: 'unseen' }).items[0];
  app.setDecision(originalItem.id, 'keep');

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('Timed out waiting for filesystem watcher reconciliation.');
  };

  const added = path.join(root, 'added.jpg');
  await fs.writeFile(added, 'new');
  await waitFor(() => app.listMedia({ collectionId, category: 'unseen' }).total === 1);
  const changed = path.join(root, 'original.jpg');
  await fs.writeFile(changed, 'changed-content');
  await waitFor(() => {
    const row = app.db.prepare('SELECT size, category FROM media WHERE id = ?').get(originalItem.id);
    return row.size === Buffer.byteLength('changed-content') && row.category === null;
  });
  await fs.unlink(added);
  await waitFor(() => app.db.prepare('SELECT present FROM media WHERE relative_path = ?').get('added.jpg').present === 0);
  assert.equal(app.db.prepare('SELECT present FROM media WHERE relative_path = ?').get('added.jpg').present, 0);
  assert.equal(app.db.prepare('SELECT category FROM media WHERE id = ?').get(originalItem.id).category, null);
});

test('confirmed apply reconciles category changes by moving and restoring files', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-reconcile-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(path.join(root, 'trip'), { recursive: true });
  const original = path.join(root, 'trip', 'photo.jpg');
  await fs.writeFile(original, 'original');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Reconcile');
  await app.addRoot(collectionId, root);
  const item = app.listMedia({ collectionId, category: 'unseen' }).items[0];
  app.setDecision(item.id, 'delete');

  const apply = async (plan) => app.confirmApply(plan.id, { confirm: true, reuseOutputFolders: true });
  const firstPlan = await app.planApply(collectionId);
  assert.equal(firstPlan.moveCount, 1);
  assert.equal((await apply(firstPlan)).results[0].status, 'moved');
  const deleted = path.join(root, 'deleted', 'trip', 'photo.jpg');
  const unsure = path.join(root, 'unsure', 'trip', 'photo.jpg');
  assert.equal(await fs.readFile(deleted, 'utf8'), 'original');
  await app.scanRoot(app.db.prepare('SELECT id FROM roots WHERE collection_id = ?').get(collectionId).id);
  assert.equal(app.listMedia({ collectionId, category: 'delete' }).total, 1);

  app.setDecision(item.id, 'unsure');
  assert.equal(await fs.readFile(deleted, 'utf8'), 'original');
  const recategorizePlan = await app.planApply(collectionId);
  assert.equal(recategorizePlan.recategorizeCount, 1);
  assert.equal((await apply(recategorizePlan)).results[0].status, 'recategorized');
  assert.equal(await fs.readFile(unsure, 'utf8'), 'original');
  assert.equal(await fs.access(deleted).then(() => true, () => false), false);

  app.setDecision(item.id, 'keep');
  const restorePlan = await app.planApply(collectionId);
  assert.equal(restorePlan.restoreCount, 1);
  assert.equal((await apply(restorePlan)).results[0].status, 'restored');
  assert.equal(await fs.readFile(original, 'utf8'), 'original');
  assert.equal(await fs.access(unsure).then(() => true, () => false), false);
});

test('filesystem watcher retries after a transient setup failure', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-watch-retry-'));
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  const app = await new PhotoSorter({ dataDirectory: path.join(temporary, 'data') }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection('Retry');
  const rootId = await app.addRoot(collectionId, root, { waitForScan: false });
  app.closeRootWatcher(rootId);
  const originalWatch = fsSync.watch;
  let calls = 0;
  fsSync.watch = (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('transient watcher failure');
    return originalWatch(...args);
  };
  try {
    app.watchRoot(rootId);
  } finally {
    fsSync.watch = originalWatch;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(calls, 1);
  assert.equal(app.rootWatchers.has(rootId), true);
  assert.equal(app.watchRetryTimers.has(rootId), false);
});
