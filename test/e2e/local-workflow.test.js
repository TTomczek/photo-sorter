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
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };

  const unauthorized = await api('/api/collections');
  assert.equal(unauthorized.response.status, 401);
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'a secure test password' }) });
  assert.equal(login.response.status, 200);

  const collection = await api('/api/collections');
  assert.equal(collection.body.collections[0].name, 'Weekend');
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
  assert.equal(decision.response.status, 200);
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

  const restored = await api('/api/restore', { method: 'POST', body: '{}' });
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
