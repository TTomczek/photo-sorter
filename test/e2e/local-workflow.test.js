const test = require('node:test');
const assert = require('node:assert/strict');
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
    app.close();
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
  assert.equal((await api('/api/preferences')).body.lastCollectionId, null);
  assert.equal((await api('/api/preferences', {
    method: 'PUT', body: JSON.stringify({ lastCollectionId: collectionId }),
  })).body.collectionId, collectionId);
  assert.equal((await api('/api/preferences')).body.lastCollectionId, collectionId);
  assert.equal((await otherDevice('/api/preferences')).body.lastCollectionId, null);
  const savedPosition = await api('/api/device-state', {
    method: 'PUT',
    body: JSON.stringify({ collectionId, category: 'unseen', sort: 'date-asc', mediaId: null, offset: 0 }),
  });
  assert.equal(savedPosition.body.state.sort, 'date-asc');
  assert.equal((await api(`/api/device-state?collectionId=${collectionId}`)).body.state.category, 'unseen');
  assert.equal((await otherDevice(`/api/device-state?collectionId=${collectionId}`)).body.state, null);
  const arbitraryRoot = await api('/api/roots', { method: 'POST', body: JSON.stringify({ path: '/etc' }) });
  assert.equal(arbitraryRoot.response.status, 404);
  const unseen = await api(`/api/media?collectionId=${collectionId}&category=unseen`);
  assert.equal(unseen.body.total, 2);
  assert.deepEqual(new Set(unseen.body.items.map((item) => item.kind)), new Set(['image', 'video']));
  assert.equal(unseen.body.items.some((item) => item.relative_path.includes('linked')), false);

  const photo = unseen.body.items.find((item) => item.relative_path.endsWith('photo.jpg'));
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
    body: JSON.stringify({ collectionId, category: 'unseen', sort: 'date-asc', mediaId: photo.id, offset: 0 }),
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
    app.close();
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
    app.close();
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
    app.close();
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
