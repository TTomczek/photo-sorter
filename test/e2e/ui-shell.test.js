const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PhotoSorter } = require('../../src/app');

test('serves PWA shell assets with installable manifest and safe worker scope', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-shell-'));
  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const port = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /\/manifest\.webmanifest/);
  assert.match(pageHtml, /\/i18n\.js/);
  assert.match(pageHtml, /id="media-viewport"/);
  assert.match(pageHtml, /id="zoom-controls"/);
  const primaryPanelOrder = [
    'class="toolbar panel"',
    'class="review panel"',
    'class="panel grid-section"',
    'id="settings-panel"',
  ].map((marker) => pageHtml.indexOf(marker));
  assert.ok(primaryPanelOrder.every((position, index) => (
    position >= 0 && (index === 0 || position > primaryPanelOrder[index - 1])
  )));

  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifestResponse.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.icons[0].src, '/icon.svg');

  const localeResponse = await fetch(`${origin}/i18n.js`);
  assert.match(localeResponse.headers.get('content-type'), /^text\/javascript/);
  assert.match(await localeResponse.text(), /Deine Bibliothek bleibt auf diesem Computer/);

  const workerResponse = await fetch(`${origin}/service-worker.js`);
  assert.match(workerResponse.headers.get('content-type'), /^text\/javascript/);
  const worker = await workerResponse.text();
  assert.ok(worker.includes("url.pathname.startsWith('/api/')"));
  assert.match(worker, /SHELL_ASSETS/);
  assert.ok(worker.includes("'/i18n.js'"));
  assert.ok(worker.includes("'/passkeys.js'"));

  const iconResponse = await fetch(`${origin}/icon.svg`);
  assert.equal(iconResponse.headers.get('content-type'), 'image/svg+xml');
});
