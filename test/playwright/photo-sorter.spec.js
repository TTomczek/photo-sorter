const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PhotoSorter } = require('../../src/app');

const PASSWORD = 'browser test password';
const TEST_IMAGE_NAMES = ['01-red.png', '02-green.png', '03-blue.png'];
let browser;
let fixture;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const content = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  content.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(content), data.length + 8);
  return chunk;
}

function generatedPng(red, green, blue, width = 96, height = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function createFixture({ imageCount = 3, existingOutput = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-browser-'));
  const dataDirectory = path.join(temporary, 'data');
  const rootDirectory = path.join(temporary, 'library');
  await fs.mkdir(rootDirectory);
  const root = await fs.realpath(rootDirectory);
  for (let index = 0; index < imageCount; index += 1) {
    const filename = TEST_IMAGE_NAMES[index] || `image-${String(index + 1).padStart(3, '0')}.png`;
    const color = index % 3;
    const png = color === 0 ? generatedPng(230, 30, 30)
      : color === 1 ? generatedPng(30, 210, 50) : generatedPng(25, 60, 230);
    await fs.writeFile(path.join(root, filename), png);
  }
  await fs.writeFile(path.join(root, '99-unplayable.mp4'), Buffer.from('not a real video'));
  if (existingOutput) {
    await fs.mkdir(path.join(root, 'deleted'));
    await fs.writeFile(path.join(root, 'deleted', 'existing.txt'), 'keep this file');
  }

  const app = await new PhotoSorter({ dataDirectory }).initialize();
  const collectionId = app.createCollection('Browser library');
  const rootId = await app.addRoot(collectionId, root);
  await app.saveSettings({ defaultSort: 'filename', previewCacheLimitMb: 2048 });
  const port = await app.listen(0);
  return {
    temporary,
    dataDirectory,
    root,
    app,
    collectionId,
    rootId,
    origin: `http://localhost:${port}`,
    port,
  };
}

async function closeFixture(current) {
  if (!current) return;
  await current.app.close();
  await fs.rm(current.temporary, { recursive: true, force: true });
}

async function setupAccount(page) {
  await page.goto(fixture.origin);
  await expect(page.locator('#auth-title')).toHaveText('Waiting for host setup');
  await expect(page.locator('#auth-form')).toBeHidden();
  await expect(page.locator('#add-root')).toBeDisabled();
  await fixture.app.createPassword(PASSWORD);
  await page.reload();
  await expect(page.locator('#auth-title')).toHaveText('Log in');
  await expect(page.locator('#network-warning')).toContainText('not encrypted');
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#app-panel')).toBeVisible();
  await expect(page.locator('#collection-title')).toHaveText('Unseen items');
  await expect(page.locator('#current-media img')).toHaveJSProperty('naturalWidth', 96);
}

async function api(page, route, options = {}) {
  return page.evaluate(async ({ route, options }) => {
    const response = await fetch(route, {
      ...options,
      headers: {
        ...(options.body && !options.headers?.['Content-Type']
          ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : await response.text(),
    };
  }, { route, options });
}

test.beforeAll(async ({ playwright }) => {
  browser = await playwright.chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  fixture = await createFixture();
  process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = fixture.origin;
  process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = 'localhost';
});

test.afterEach(async () => {
  await closeFixture(fixture);
  fixture = null;
  delete process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN;
  delete process.env.PHOTO_SORTER_WEBAUTHN_RP_ID;
});

test('first-run setup, generated image previews, review decisions, keyboard, undo/redo and safe apply/restore', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(fixture.origin);
    await expect(page.locator('#auth-title')).toHaveText('Waiting for host setup');
    await expect(page.locator('#auth-form')).toBeHidden();
    await fixture.app.createPassword(PASSWORD);
    await page.reload();
    await expect(page.locator('#auth-title')).toHaveText('Log in');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();

    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#add-root')).toBeEnabled();
    await expect(page.locator('#filters [data-category="unseen"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#filters [data-category="unseen"]')).toHaveCSS('box-shadow', /inset/);
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '01-red.png');
    await expect(page.locator('#current-media img')).toHaveJSProperty('naturalWidth', 96);
    await expect.poll(() => fixture.app.db.prepare('SELECT COUNT(*) AS count FROM preview_cache').get().count)
      .toBeGreaterThan(0);

    const item = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'unseen', sort: 'filename',
    }).items[0];
    const previewResponse = await api(page, `/api/media/${item.id}/preview`);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.contentType).toContain('image/jpeg');
    expect(await page.evaluate(async (url) => {
      const response = await fetch(url);
      const bitmap = await createImageBitmap(await response.blob());
      const dimensions = [bitmap.width, bitmap.height];
      bitmap.close();
      return dimensions;
    }, `/api/media/${item.id}/preview`)).toEqual([96, 64]);
    expect((await fs.readFile(path.join(fixture.root, '01-red.png'))).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    await page.locator('#zoom-in').click();
    await expect(page.locator('#current-media img')).toHaveClass(/zoomable/);
    await expect(page.locator('#current-media img')).toHaveCSS('transform', /matrix\(1\.5/);
    const imageBox = await page.locator('#current-media img').boundingBox();
    await page.mouse.move(imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(imageBox.x + imageBox.width / 2 + 24, imageBox.y + imageBox.height / 2 + 16);
    await page.mouse.up();
    await expect(page.locator('#current-media img')).toHaveCSS('transform', /matrix\(1\.5, 0, 0, 1\.5, 24, 16\)/);
    await page.locator('#zoom-reset').click();
    await expect(page.locator('#current-media img')).not.toHaveClass(/zoomable/);

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
    await page.locator('#filters [data-category="keep"]').click();
    await expect(page.locator('#collection-title')).toHaveText('Keep items');
    await expect(page.locator('#filters [data-category="keep"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#filters [data-category="keep"]')).toHaveCSS('box-shadow', /inset/);
    await expect(page.locator('#filters [data-category="unseen"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#media-grid')).toContainText('01-red.png');

    await page.locator('#undo-decision').click();
    await expect.poll(() => fixture.app.db.prepare('SELECT category FROM media WHERE id = ?')
      .get(item.id)?.category).toBe(null);
    await page.locator('#filters [data-category="unseen"]').click();
    await expect(page.locator('#media-grid')).toContainText('01-red.png');
    await page.locator('#redo-decision').click();
    await expect.poll(() => fixture.app.db.prepare('SELECT category FROM media WHERE id = ?')
      .get(item.id)?.category).toBe('keep');
    await page.locator('#filters [data-category="keep"]').click();
    await expect(page.locator('#media-grid')).toContainText('01-red.png');

    await page.locator('#filters [data-category="unseen"]').click();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#status')).toContainText('Saved unsure decision');
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'unsure'").get().count)
      .toBe(1);
    await page.locator('#filters [data-category="unsure"]').click();
    await expect(page.locator('#collection-title')).toHaveText('Unsure items');
    const unsureItem = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'unsure', sort: 'filename',
    }).items[0];
    expect((await api(page, `/api/media/${unsureItem.id}/lock`, { method: 'POST' })).status).toBe(200);
    expect((await api(page, `/api/media/${unsureItem.id}/decision`, {
      method: 'PUT', body: JSON.stringify({ category: 'unseen' }),
    })).status).toBe(200);
    await expect.poll(() => fixture.app.db.prepare('SELECT category FROM media WHERE id = ?')
      .get(unsureItem.id)?.category).toBe(null);

    await page.locator('#filters [data-category="unseen"]').click();
    await page.locator('.decision-actions [data-decision="delete"]').click();
    await expect(page.locator('#status')).toContainText('Saved delete decision');
    await expect.poll(() => fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'delete', sort: 'filename',
    }).total).toBe(1);
    const deleteItem = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'delete', sort: 'filename',
    }).items[0];
    const deleteFilename = path.basename(deleteItem.relative_path);
    await expect(fs.stat(path.join(fixture.root, deleteFilename))).resolves.toBeTruthy();
    await page.locator('#apply').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await expect(page.locator('#dialog-content')).toContainText(deleteFilename);
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#status')).toContainText('Applied 1 move');
    await expect(fs.readFile(path.join(fixture.root, 'deleted', deleteFilename))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(fixture.root, deleteFilename))).rejects.toMatchObject({ code: 'ENOENT' });

    await page.locator('#restore').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#status')).toContainText('1 restored');
    await expect(fs.readFile(path.join(fixture.root, deleteFilename))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(fixture.root, 'deleted', deleteFilename))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('development reload keeps an authenticated session', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await fixture.app.createPassword(PASSWORD);
    await page.addInitScript(() => {
      window.photoSorter = { isDesktop: true, getAutostart: async () => false };
    });
    await page.goto(`${fixture.origin}/?dev=1`);
    await expect(page.locator('#auth-title')).toHaveText('Log in');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app-panel')).toBeVisible();

    await page.reload();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#auth-panel')).toBeHidden();
    await expect(page.locator('#collection-title')).toHaveText('Unseen items');
  } finally {
    await context.close();
  }
});

test('existing output folders need explicit approval and cancellation does not move originals', async () => {
  fixture = await closeFixtureAndRecreate({ existingOutput: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await page.locator('.decision-actions [data-decision="delete"]').click();
    await expect(page.locator('#status')).toContainText('Saved delete decision');
    await page.locator('#apply').click();
    await expect(page.locator('#dialog-content')).toContainText('explicitly approve reusing');
    await expect(page.locator('#dialog-confirm')).toBeDisabled();
    await page.locator('#confirm-dialog [value="cancel"]').click();
    await expect(fs.readFile(path.join(fixture.root, '01-red.png'))).resolves.toBeTruthy();

    await page.locator('#apply').click();
    await page.locator('#confirm-dialog input[type="checkbox"]').check();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#status')).toContainText('Applied 1 move');
    await expect(fs.readFile(path.join(fixture.root, 'deleted', '01-red.png'))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(fixture.root, 'deleted', 'existing.txt'), 'utf8')).resolves.toBe('keep this file');
  } finally {
    await context.close();
  }
});

test('mobile layout preserves explicit actions and maps a right swipe to keep', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await expect(page.locator('.decision-actions [data-decision="keep"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    await page.evaluate(() => {
      const target = document.getElementById('current-media');
      const touch = (clientX) => new Touch({
        identifier: 1, target, clientX, clientY: 200, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
      });
      target.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, changedTouches: [touch(100)], touches: [touch(100)],
      }));
      target.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, changedTouches: [touch(190)], touches: [],
      }));
    });
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'keep'").get().count)
      .toBe(1);
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
  } finally {
    await context.close();
  }
});

async function closeFixtureAndRecreate(options) {
  await closeFixture(fixture);
  const replacement = await createFixture(options);
  process.env.PHOTO_SORTER_WEBAUTHN_ORIGIN = replacement.origin;
  process.env.PHOTO_SORTER_WEBAUTHN_RP_ID = 'localhost';
  return replacement;
}

test('settings, German localization, theme/grid preferences, device state, collections and audit export', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);

    await page.locator('#settings-panel summary').click();
    await page.locator('#theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#grid-columns').selectOption('4');
    await expect(page.locator('html')).toHaveAttribute('data-grid-columns', '4');
    await page.locator('#language').selectOption('de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
    await expect(page.locator('#network-warning')).toContainText('HTTP im lokalen Netzwerk');
    await page.locator('#status').evaluate((element) => {
      element.textContent = 'Create a collection, then choose a folder from the host desktop app.';
    });
    await expect(page.locator('#status'))
      .toHaveText('Erstelle eine Sammlung und wähle anschließend einen Ordner in der Desktop-App des Hosts aus.');

    await page.locator('#default-sort').selectOption('capture-desc');
    await page.locator('#preview-cache-limit').fill('0');
    await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
    await expect(page.locator('#status')).toContainText('Einstellungen gespeichert');
    expect((await api(page, '/api/settings')).body).toEqual({
      defaultSort: 'capture-desc',
      previewCacheLimitMb: 0,
    });
    await page.reload();
    await expect(page.locator('#auth-title')).toHaveText('Anmelden');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-grid-columns', '4');
    await expect(page.locator('#language')).toHaveValue('de');

    await page.locator('#new-collection-form input').fill('Second collection');
    await page.locator('#new-collection-form button').click();
    await expect(page.locator('#collection option')).toHaveCount(2);
    await page.locator('#archive-collection').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#collection option')).toHaveCount(1);
    await page.locator('#archived-collections summary').click();
    await expect(page.locator('#archived-list')).toContainText('Second collection');
    await page.locator('#archived-list button').click();
    await expect(page.locator('#collection option')).toHaveCount(2);

    await page.locator('#collection').selectOption(fixture.collectionId);
    await expect(page.locator('.decision-actions [data-decision="keep"]')).toBeEnabled();
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'keep'").get().count)
      .toBe(1);
    await page.locator('#root-management summary').click();
    await page.locator('#root-list button').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#root-list')).toContainText('Ordner');
    await expect(page.locator('#current-media')).toContainText('Keine Elemente');
    await fixture.app.addRoot(fixture.collectionId, fixture.root);
    await page.reload();
    await expect(page.locator('#auth-title')).toHaveText('Anmelden');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#root-list')).toContainText(fixture.root);

    await page.locator('#audit').click();
    await expect(page.locator('#audit-panel')).toBeVisible();
    await expect(page.locator('#audit-list')).toContainText('Entscheidung geändert');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-audit').click(),
    ]);
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    expect(exported.events.some((event) => event.action === 'decision_changed')).toBe(true);
    await page.locator('#clear-audit').click();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#audit-list')).toContainText('Audit-Protokoll geleert');
    expect((await api(page, '/api/audit')).body.events.map((event) => event.action)).toEqual(['audit_cleared']);
  } finally {
    await context.close();
  }
});

test('PWA service worker caches the shell only and serves the shell offline', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    const cacheContents = await page.evaluate(async () => {
      const names = await caches.keys();
      const cached = [];
      for (const name of names) {
        for (const request of await (await caches.open(name)).keys()) cached.push(new URL(request.url).pathname);
      }
      return { names, cached };
    });
    expect(cacheContents.names.some((name) => name.startsWith('photo-sorter-shell-'))).toBe(true);
    expect(cacheContents.cached).toContain('/');
    expect(cacheContents.cached.some((url) => url.startsWith('/api/'))).toBe(false);
    expect(cacheContents.cached.some((url) => url.includes('/media/'))).toBe(false);

    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('h1')).toHaveText('Photo Sorter');
    await expect(page.locator('#auth-panel')).toBeVisible();
  } finally {
    await context.setOffline(false);
    await context.close();
  }
});

test('bounded grid pagination and real-time updates between browser devices', async () => {
  test.setTimeout(30_000);
  fixture = await closeFixtureAndRecreate({ imageCount: 65 });
  const firstContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const requestedMediaPages = [];
  firstPage.on('request', (request) => {
    const match = request.url().match(/\/api\/media\?.*offset=(\d+)/);
    if (match) requestedMediaPages.push(Number(match[1]));
  });
  try {
    await test.step('load the first bounded page', async () => {
      await setupAccount(firstPage);
    });
    await expect(firstPage.locator('#media-grid .media-card')).toHaveCount(60);
    await expect(firstPage.locator('#item-count')).toContainText('of 66');

    await test.step('connect a second device', async () => {
      await firstPage.locator('#next').click();
      await expect(firstPage.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
      await secondPage.goto(fixture.origin);
      await secondPage.locator('#password').fill(PASSWORD);
      await secondPage.locator('#auth-submit').click();
      await expect(secondPage.locator('#app-panel')).toBeVisible();
      await expect(secondPage.locator('#current-media img')).toHaveAttribute('alt', '01-red.png');
      await expect(secondPage.locator('.decision-actions [data-decision="keep"]')).toBeEnabled();
    });

    await test.step('receive a live queue update', async () => {
      await secondPage.locator('.decision-actions [data-decision="keep"]').click();
      await expect(firstPage.locator('#item-count')).toContainText('of 65');
      await expect(firstPage.locator('#media-grid')).not.toContainText('01-red.png');
      expect((await api(firstPage, '/api/media?collectionId=' + fixture.collectionId + '&category=keep')).body.total).toBe(1);
    });

    await test.step('scroll into the final API page', async () => {
      await firstPage.locator('#media-viewport').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => requestedMediaPages).toContain(60);
      await expect(firstPage.locator('#media-grid')).toContainText('image-065.png');
      expect(await firstPage.locator('#media-grid .media-card').count()).toBeLessThanOrEqual(60);
    });
  } finally {
    await firstContext.close().catch(() => {});
    await secondContext.close().catch(() => {});
  }
});

test('WebAuthn passkey registration, authentication and removal with a virtual authenticator', async () => {
  test.setTimeout(30_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  let cdp;
  try {
    await setupAccount(page);
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });

    await page.locator('#passkey-management summary').click();
    await page.locator('#register-passkey').click();
    await expect(page.locator('#passkey-list li')).toHaveCount(1);
    await expect(page.locator('#status')).toContainText('Passkey registered');

    await page.locator('#logout').click();
    await expect(page.locator('#auth-title')).toHaveText('Log in');
    await page.locator('#passkey-login').click();
    await expect(page.locator('#app-panel')).toBeVisible();

    if (!await page.locator('#passkey-management').evaluate((element) => element.open)) {
      await page.locator('#passkey-management summary').click();
    }
    await expect(page.locator('#passkey-list li')).toHaveCount(1);
    await page.locator('#passkey-list button').click();
    await expect(page.locator('#passkey-list li')).toHaveCount(0);
    const status = await api(page, '/api/passkeys/status');
    expect(status.body).toEqual({ enabled: true, count: 0 });
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await cdp.send('WebAuthn.disable');
  } finally {
    await context.close().catch(() => {});
    await cdp?.detach().catch(() => {});
  }
});
