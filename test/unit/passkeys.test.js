const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { PasskeyService } = require('../../src/passkeys');

test('passkey options are restricted to the configured secure origin and device', async (t) => {
  const priorOrigin = process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
  const priorRpId = process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
  process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = 'https://photos.example.test';
  process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = 'example.test';
  t.after(() => {
    if (priorOrigin === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
    else process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = priorOrigin;
    if (priorRpId === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
    else process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = priorRpId;
  });

  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const passkeys = new PasskeyService(db);
  assert.deepEqual(passkeys.status(), { enabled: true, count: 0 });
  await assert.rejects(
    passkeys.authenticationOptions({ headers: { origin: 'https://attacker.example.test' } }),
    { status: 403 },
  );

  const options = await passkeys.registrationOptions(
    { headers: { origin: 'https://photos.example.test' } },
    'device-one',
  );
  assert.equal(options.options.rp.id, 'example.test');
  assert.ok(options.options.challenge);
  assert.throws(() => passkeys.consumeChallenge(options.challengeId, 'registration', 'device-two'), {
    status: 400,
  });
  assert.throws(() => passkeys.consumeChallenge(options.challengeId, 'registration', 'device-one'), {
    status: 400,
  });
});

test('passkeys remain disabled for malformed origins, HTTP addresses and mismatched relying parties', (t) => {
  const priorOrigin = process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
  const priorRpId = process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
  const db = new DatabaseSync(':memory:');
  t.after(() => {
    db.close();
    if (priorOrigin === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
    else process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = priorOrigin;
    if (priorRpId === undefined) delete process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
    else process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = priorRpId;
  });

  const passkeys = new PasskeyService(db);
  for (const [origin, rpId] of [
    ['http://photos.example.test', 'example.test'],
    ['https://photos.example.test/', 'example.test'],
    ['https://photos.example.test', 'other.test'],
    ['https://photos.example.test', 'Example.test'],
    ['http://192.168.1.20', '192.168.1.20'],
  ]) {
    process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = origin;
    process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = rpId;
    assert.deepEqual(passkeys.status(), { enabled: false, count: 0 });
  }

  process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = 'http://localhost';
  process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = 'localhost';
  assert.deepEqual(passkeys.status(), { enabled: true, count: 0 });
});
