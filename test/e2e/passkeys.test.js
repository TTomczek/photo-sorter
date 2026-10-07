const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('passkey APIs enforce the configured origin and preserve password login', async (t) => {
  const priorOrigin = process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
  const priorRpId = process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
  process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = 'https://photos.example.test';
  process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = 'example.test';
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-passkeys-'));
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
    if (priorOrigin === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
    else process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = priorOrigin;
    if (priorRpId === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
    else process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = priorRpId;
  });
  await app.createPassword('a secure test password');
  const port = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  let cookie = '';

  const api = async (route, { requestOrigin, ...options } = {}) => {
    const response = await fetch(`${origin}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
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

  const login = await api('/api/login', {
    method: 'POST',
    requestOrigin: 'https://photos.example.test',
    body: JSON.stringify({ password: 'a secure test password' }),
  });
  assert.equal(login.response.status, 200);
  const sessionCookie = login.response.headers.getSetCookie()
    .find((cookieValue) => cookieValue.startsWith('photo_sorter_session='));
  assert.match(sessionCookie, /;\s*Secure(?:;|$)/);
  assert.deepEqual((await api('/api/passkeys/status')).body, { enabled: true, count: 0 });
  assert.equal((await api('/api/passkeys/authentication/options', {
    method: 'POST',
    requestOrigin: 'https://photos.example.test',
    body: '{}',
  })).response.status, 404);
  assert.equal((await api('/api/passkeys/registration/options', {
    method: 'POST',
    requestOrigin: 'https://attacker.example.test',
    body: '{}',
  })).response.status, 403);

  const options = await api('/api/passkeys/registration/options', {
    method: 'POST',
    requestOrigin: 'https://photos.example.test',
    body: '{}',
  });
  assert.equal(options.response.status, 200);
  assert.equal(options.body.options.rp.id, 'example.test');
  const invalidVerification = await api('/api/passkeys/registration/verify', {
    method: 'POST',
    requestOrigin: 'https://photos.example.test',
    body: JSON.stringify({ challengeId: options.body.challengeId, response: {} }),
  });
  assert.equal(invalidVerification.response.status, 400);
  assert.equal((await api('/api/passkeys/status')).body.count, 0);
});
