const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PhotoSorter } = require('../../src/app');

test('authenticated Photo Health APIs share collection progress and stage safe group decisions', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-health-api-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  const source = await sharp(Buffer.from(
    '<svg width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="20" fill="#123456"/></svg>',
  )).png().toBuffer();
  await fs.writeFile(path.join(root, 'first.png'), source);
  await fs.writeFile(path.join(root, 'second.png'), source);

  const app = await new PhotoSorter({ dataDirectory: path.join(temporary, 'data') }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('A secure test password! 42');
  const collectionId = app.createCollection('Health API');
  await app.addRoot(collectionId, root);
  const baseUrl = `http://127.0.0.1:${await app.listen(0)}`;
  const createApi = () => {
    const client = { cookie: '' };
    client.request = async (route, options = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(client.cookie ? { Cookie: client.cookie } : {}),
          ...options.headers,
        },
      });
      const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
      if (cookies.length) client.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
      return {
        response,
        body: response.headers.get('content-type')?.includes('application/json')
          ? await response.json() : await response.text(),
      };
    };
    return client;
  };
  const phone = createApi();
  assert.equal((await phone.request(`/api/photo-health/status?collectionId=${collectionId}`)).response.status, 401);
  assert.equal((await phone.request('/api/login', {
    method: 'POST', body: JSON.stringify({ password: 'A secure test password! 42' }),
  })).response.status, 200);
  const desktop = createApi();
  assert.equal((await desktop.request('/api/login', {
    method: 'POST', body: JSON.stringify({ password: 'A secure test password! 42' }),
  })).response.status, 200);

  const enabled = await phone.request('/api/photo-health/state', {
    method: 'POST', body: JSON.stringify({ collectionId, action: 'enable' }),
  });
  assert.equal(enabled.body.enabled, true);
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = (await desktop.request(`/api/photo-health/status?collectionId=${collectionId}`)).body;
    if (status.pending === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.status, 'completed');
  assert.equal(status.total, 2);
  const page = await desktop.request(`/api/photo-health/findings?collectionId=${collectionId}&type=duplicate&limit=10`);
  assert.equal(page.body.total, 1);
  assert.equal(page.body.items[0].reason, 'Exact file match');
  const group = await phone.request(`/api/photo-health/groups/${page.body.items[0].groupId}?collectionId=${collectionId}`);
  assert.equal(group.body.total, 2);
  const decision = await phone.request(`/api/photo-health/groups/${page.body.items[0].groupId}/decisions`, {
    method: 'POST',
    body: JSON.stringify({ collectionId, keepIds: [group.body.items[0].id] }),
  });
  assert.deepEqual(decision.body, { changed: true, keptCount: 1, deletedCount: 1 });
  assert.equal((await desktop.request(`/api/photo-health/findings?collectionId=${collectionId}&handled=open`))
    .body.total, 0);
  assert.equal((await desktop.request(`/api/photo-health/findings?collectionId=${collectionId}&handled=handled`))
    .body.total, 1);
  assert.equal((await phone.request('/api/photo-health/state', {
    method: 'POST', body: JSON.stringify({ collectionId, action: 'pause' }),
  })).body.paused, true);
  assert.equal((await desktop.request(`/api/photo-health/status?collectionId=${collectionId}`)).body.paused, true);
  assert.equal((await phone.request('/api/photo-health/state', {
    method: 'POST', body: JSON.stringify({ collectionId, action: 'resume' }),
  })).body.paused, false);
  assert.equal((await fs.readFile(path.join(root, 'first.png'))).equals(source), true);
  assert.equal((await fs.readFile(path.join(root, 'second.png'))).equals(source), true);
});
