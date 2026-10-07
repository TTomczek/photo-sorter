const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { defaultDataDirectory } = require('../src/app');

function readPassword(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run the password reset command in an interactive terminal.'));
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (character) => {
      if (character === '\u0003') return finish(new Error('Password reset cancelled.'));
      if (character === '\r' || character === '\n') return finish();
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
        return;
      }
      if (character >= ' ') value += character;
    };
    input.on('data', onData);
  });
}

async function main() {
  const argumentsList = process.argv.slice(2);
  let dataDirectory = defaultDataDirectory();
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== '--data-dir' || !argumentsList[index + 1]) {
      throw new Error('Usage: npm run reset-password [-- --data-dir <app-data-directory>]');
    }
    dataDirectory = path.resolve(argumentsList[++index]);
  }
  const databasePath = path.join(dataDirectory, 'photo-sorter.sqlite');
  if (!fs.existsSync(databasePath)) throw new Error(`No Photo Sorter database found at ${databasePath}`);
  const password = await readPassword('New password (at least 12 characters): ');
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('Password must be between 12 and 1024 bytes.');
  }
  const confirmation = await readPassword('Confirm new password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString('hex')));
  });
  const database = new DatabaseSync(databasePath);
  try {
    const account = database.prepare('SELECT id FROM account WHERE id = 1').get();
    if (!account) throw new Error('Initial host setup has not been completed.');
    database.prepare('UPDATE account SET salt = ?, password_hash = ? WHERE id = 1').run(salt, passwordHash);
    database.prepare('INSERT INTO audit(action, details, created_at) VALUES (?, ?, ?)')
      .run('password_reset', JSON.stringify({}), new Date().toISOString());
  } finally {
    database.close();
  }
  process.stdout.write('Password updated. Restart the host service to invalidate current sessions.\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
