const crypto = require('node:crypto');
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require('@simplewebauthn/server');

class PasskeyService {
  constructor(db) {
    this.db = db;
    this.challenges = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passkeys (
        credential_id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  configuredOrigin() {
    const origin = process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
    const rpId = process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
    if (!origin || !rpId) return null;
    let parsed;
    try { parsed = new URL(origin); } catch { return null; }
    const localHttp = parsed.protocol === 'http:' && parsed.hostname === 'localhost';
    const validRpId = typeof rpId === 'string' && rpId.length <= 253
      && rpId === rpId.toLowerCase()
      && rpId.split('.').every((label) => label.length > 0 && label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    if (!validRpId || parsed.origin !== origin || parsed.username || parsed.password
      || (parsed.protocol !== 'https:' && !localHttp)
      || (parsed.hostname !== rpId && !parsed.hostname.endsWith(`.${rpId}`))) return null;
    return { origin, rpId };
  }

  assertOrigin(request) {
    const configured = this.configuredOrigin();
    if (!configured) {
      throw Object.assign(new Error('Passkeys require PHOTO_SORTER_WEBAUTHN_ORIGIN and PHOTO_SORTER_WEBAUTHN_RP_ID.'), { status: 503 });
    }
    if (request.headers.origin !== configured.origin) {
      throw Object.assign(new Error('Passkey request origin is not allowed.'), { status: 403 });
    }
    return configured;
  }

  status() {
    return {
      enabled: Boolean(this.configuredOrigin()),
      count: this.db.prepare('SELECT COUNT(*) AS count FROM passkeys').get().count,
    };
  }

  newChallenge(type, challenge, config, deviceId = null) {
    const now = Date.now();
    for (const [id, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(id);
    }
    if (this.challenges.size >= 256) {
      throw Object.assign(new Error('Too many passkey requests are pending.'), { status: 429 });
    }
    const id = crypto.randomUUID();
    this.challenges.set(id, {
      type,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      deviceId,
      expiresAt: now + 120_000,
    });
    return id;
  }

  consumeChallenge(id, type, deviceId = null) {
    const entry = this.challenges.get(id);
    this.challenges.delete(id);
    if (!entry || entry.type !== type || entry.expiresAt <= Date.now()
      || entry.deviceId !== deviceId) {
      throw Object.assign(new Error('Passkey challenge expired or invalid; try again.'), { status: 400 });
    }
    return entry;
  }

  async registrationOptions(request, deviceId) {
    const config = this.assertOrigin(request);
    const credentials = this.db.prepare('SELECT credential_id, transports FROM passkeys').all();
    const options = await generateRegistrationOptions({
      rpName: 'Photo Sorter',
      rpID: config.rpId,
      userID: Buffer.from('photo-sorter-single-account'),
      userName: 'photo-sorter',
      userDisplayName: 'Photo Sorter',
      attestationType: 'none',
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: JSON.parse(credential.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });
    const challengeId = this.newChallenge('registration', options.challenge, config, deviceId);
    return { challengeId, options };
  }

  async verifyRegistration(request, deviceId, { challengeId, response }) {
    const config = this.assertOrigin(request);
    const challenge = this.consumeChallenge(challengeId, 'registration', deviceId);
    if (challenge.origin !== config.origin || challenge.rpId !== config.rpId) {
      throw Object.assign(new Error('Passkey challenge origin changed; try again.'), { status: 400 });
    }
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw Object.assign(new Error('Passkey registration could not be verified.'), { status: 400 });
    }
    const credential = verification.registrationInfo.credential;
    const transports = response.response.transports || credential.transports || [];
    this.db.prepare(`
      INSERT INTO passkeys(credential_id, public_key, counter, transports, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(transports),
      new Date().toISOString(),
    );
    this.log('passkey_added', { credentialId: credential.id });
    return { registered: true };
  }

  async authenticationOptions(request) {
    const config = this.assertOrigin(request);
    const credentials = this.db.prepare('SELECT credential_id, transports FROM passkeys').all();
    if (!credentials.length) {
      throw Object.assign(new Error('No passkeys are registered.'), { status: 404 });
    }
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: JSON.parse(credential.transports),
      })),
      userVerification: 'preferred',
    });
    const challengeId = this.newChallenge('authentication', options.challenge, config);
    return { challengeId, options };
  }

  async verifyAuthentication(request, { challengeId, response }) {
    const config = this.assertOrigin(request);
    const challenge = this.consumeChallenge(challengeId, 'authentication');
    if (challenge.origin !== config.origin || challenge.rpId !== config.rpId) {
      throw Object.assign(new Error('Passkey challenge origin changed; try again.'), { status: 400 });
    }
    const credential = this.db.prepare(`
      SELECT credential_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?
    `).get(response.id);
    if (!credential) {
      throw Object.assign(new Error('Passkey is not registered.'), { status: 401 });
    }
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports),
      },
      requireUserVerification: false,
    });
    if (!verification.verified) {
      throw Object.assign(new Error('Passkey authentication could not be verified.'), { status: 401 });
    }
    this.db.prepare('UPDATE passkeys SET counter = ? WHERE credential_id = ?')
      .run(verification.authenticationInfo.newCounter, credential.credential_id);
    this.log('passkey_login', { credentialId: credential.credential_id });
    return { authenticated: true };
  }

  list() {
    return this.db.prepare(`
      SELECT credential_id AS id, created_at AS createdAt, transports
      FROM passkeys ORDER BY created_at
    `).all().map((credential) => ({
      ...credential,
      transports: JSON.parse(credential.transports),
    }));
  }

  remove(credentialId) {
    const result = this.db.prepare('DELETE FROM passkeys WHERE credential_id = ?').run(credentialId);
    if (!result.changes) throw Object.assign(new Error('Passkey not found.'), { status: 404 });
    this.log('passkey_removed', { credentialId });
    return { removed: true };
  }

  log(action, details) {
    this.db.prepare('INSERT INTO audit(action, details, created_at) VALUES (?, ?, ?)')
      .run(action, JSON.stringify(details), new Date().toISOString());
  }
}

module.exports = { PasskeyService };
