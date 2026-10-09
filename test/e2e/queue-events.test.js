const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('authenticated queue event streams publish shared decision changes promptly', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-events-'));
  const dataDirectory = path.join(temporary, 'data');
  const root = path.join(temporary, 'photos');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'photo.jpg'), 'event-test-photo');
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await app.createPassword('A secure test password! 42');
  const collectionId = app.createCollection('Queue events');
  await app.addRoot(collectionId, root);
  const port = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;

  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'A secure test password! 42' }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
  const mediaResponse = await fetch(`${origin}/api/media?collectionId=${collectionId}&category=unseen`, {
    headers: { Cookie: cookie },
  });
  const item = (await mediaResponse.json()).items[0];
  const eventResponse = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie } });
  assert.equal(eventResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = eventResponse.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();

  const lock = await fetch(`${origin}/api/media/${item.id}/lock`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(lock.status, 200);
  const decision = await fetch(`${origin}/api/media/${item.id}/decision`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'keep' }),
  });
  assert.equal(decision.status, 200);
  const event = await reader.read();
  const message = new TextDecoder().decode(event.value);
  assert.match(message, /event: queue/);
  assert.match(message, new RegExp(`"collectionId":"${collectionId}"`));

  const logout = await fetch(`${origin}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 200);
});
