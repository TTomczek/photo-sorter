const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('authenticated clients can populate bounded JPEG preview cache without accepting stale media', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-preview-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'photo.jpg'), 'original-image-content');
  await fs.writeFile(path.join(root, 'clip.mp4'), 'video-poster-content');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('a secure test password');
  const collectionId = app.createCollection('Preview test');
  const rootId = await app.addRoot(collectionId, root);
  const port = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  let cookie = '';

  const api = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, {
      ...options,
      headers: {
        ...(options.body && !Buffer.isBuffer(options.body) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
    });
    const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    if (setCookies.length) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    return {
      response,
      body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null,
    };
  };

  assert.equal((await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'a secure test password' }),
  })).response.status, 200);
  const media = await api(`/api/media?collectionId=${collectionId}&category=unseen`);
  assert.equal(media.body.items.length, 2);
  const item = media.body.items.find((candidate) => candidate.kind === 'image');
  const video = media.body.items.find((candidate) => candidate.kind === 'video');
  const preview = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const route = `/api/media/${encodeURIComponent(item.id)}/preview`;
  const videoRoute = `/api/media/${encodeURIComponent(video.id)}/preview`;

  const unauthorized = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      'If-Match': `${item.size}:${item.modified_at}`,
    },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(unauthorized.status, 401);

  const wrongType = await api(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'If-Match': `${item.size}:${item.modified_at}` },
    body: preview,
  });
  assert.equal(wrongType.response.status, 415);

  const malformedJpeg = await api(route, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${item.size}:${item.modified_at}` },
    body: Buffer.from([0, 1, 2, 3]),
  });
  assert.equal(malformedJpeg.response.status, 400);

  const oversized = await api(route, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${item.size}:${item.modified_at}` },
    body: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.response.status, 413);

  const saved = await api(route, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${item.size}:${item.modified_at}` },
    body: preview,
  });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.stored, true);
  const cached = await api(route);
  assert.equal(cached.response.status, 200);
  assert.equal(cached.response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await cached.response.arrayBuffer()), preview);
  assert.equal(await fs.readFile(path.join(root, 'photo.jpg'), 'utf8'), 'original-image-content');

  const poster = await api(videoRoute, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${video.size}:${video.modified_at}` },
    body: preview,
  });
  assert.deepEqual(poster.body, { stored: true });
  assert.equal((await api(videoRoute)).response.status, 200);

  await fs.writeFile(path.join(root, 'photo.jpg'), 'changed-image-content-with-a-different-size');
  assert.equal((await api(route)).response.status, 404);
  const stale = await api(route, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${item.size}:${item.modified_at}` },
    body: preview,
  });
  assert.equal(stale.response.status, 409);

  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ defaultSort: 'capture-asc', previewCacheLimitMb: 0 }),
  });
  await app.scanRoot(rootId);
  const refreshed = await api(`/api/media?collectionId=${collectionId}&category=unseen`);
  const currentItem = refreshed.body.items.find((candidate) => candidate.kind === 'image');
  const uncached = await api(`/api/media/${encodeURIComponent(currentItem.id)}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'If-Match': `${currentItem.size}:${currentItem.modified_at}` },
    body: preview,
  });
  assert.deepEqual(uncached.body, { stored: false });
});
