const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PhotoSorter } = require('../../src/app');

const PASSWORD = 'Browser test password! 42';
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

async function setupAccount(page, { expectedCategory = 'Review' } = {}) {
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
  await expect(page.locator('#collection-title')).toHaveText(expectedCategory);
  await expect.poll(() => fixture.app.db.prepare(
    "SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued', 'running')",
  ).get().count).toBe(0);
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

test('first-run review focus, photo details, category browsing and safe apply/restore', async () => {
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
    await expect(page.locator('#review-view')).toBeVisible();
    await expect(page.locator('#previous')).toHaveAttribute('aria-label', 'Previous');
    await expect(page.locator('#next')).toHaveAttribute('aria-label', 'Next');
    const reviewNavigation = await page.evaluate(() => {
      const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
      const previous = bounds('#previous');
      const next = bounds('#next');
      const media = bounds('#current-media');
      return {
        previousCenterX: previous.left + previous.width / 2,
        nextCenterX: next.left + next.width / 2,
        mediaLeft: media.left,
        mediaRight: media.right,
        navigationCenterY: previous.top + previous.height / 2,
        mediaCenterY: media.top + media.height / 2,
      };
    });
    expect(reviewNavigation.previousCenterX).toBeLessThan(
      reviewNavigation.mediaLeft + (reviewNavigation.mediaRight - reviewNavigation.mediaLeft) / 4,
    );
    expect(reviewNavigation.nextCenterX).toBeGreaterThan(
      reviewNavigation.mediaLeft + (reviewNavigation.mediaRight - reviewNavigation.mediaLeft) * 3 / 4,
    );
    expect(Math.abs(reviewNavigation.navigationCenterY - reviewNavigation.mediaCenterY)).toBeLessThan(1);
    await expect.poll(() => fixture.app.db.prepare(
      "SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued', 'running')",
    ).get().count).toBe(0);
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '01-red.png');
    await expect(page.locator('#current-media img')).toHaveJSProperty('naturalWidth', 96);
    await page.locator('#photo-info-toggle').click();
    await expect(page.locator('#photo-details')).toBeVisible();
    await expect(page.locator('#photo-details')).toContainText('01-red.png');
    await page.locator('#photo-info-toggle').click();
    await expect(page.locator('#photo-details')).toBeHidden();
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
    await page.locator('.decision-actions [data-decision="delete"]').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '03-blue.png');
    await page.locator('.decision-actions [data-decision="unsure"]').click();
    await expect(page.locator('#current-media video')).toBeVisible();
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '03-blue.png');
    await expect(page.locator('.decision-actions [data-decision="keep"]')).toBeEnabled();
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#browse-view')).toBeVisible();
    await expect(page.locator('#filters [data-category="all"]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#app-navigation [data-view="collections"]').click();
    await expect(page.locator('#collections-view')).toBeVisible();
    await expect(page.locator('#add-root')).toBeEnabled();
    await page.locator('#app-navigation [data-view="browse"]').click();
    await expect(page.locator('#browse-view')).toBeVisible();
    await expect(page.locator('#media-grid')).toContainText('01-red.png');
    await expect(page.locator('#media-grid')).toHaveCSS('grid-auto-rows', '250px');
    const browseLayout = await page.evaluate(() => {
      const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
      const sortLabel = bounds('label[for="sort-order"]');
      const sortSelect = bounds('#sort-order');
      const heading = bounds('.grid-section .section-heading');
      const toolbar = bounds('.grid-section .section-heading > div');
      const photos = bounds('#media-viewport');
      return {
        labelCenter: sortLabel.top + sortLabel.height / 2,
        selectCenter: sortSelect.top + sortSelect.height / 2,
        headingBottom: heading.bottom,
        photoGap: photos.top - toolbar.bottom,
      };
    });
    expect(Math.abs(browseLayout.labelCenter - browseLayout.selectCenter)).toBeLessThan(1);
    expect(browseLayout.photoGap).toBeGreaterThanOrEqual(12);
    await page.locator('#filters [data-category="keep"]').click();
    await expect(page.locator('#collection-title')).toHaveText('Keep items');
    await expect(page.locator('#filters [data-category="keep"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#media-grid')).toContainText('01-red.png');
    await page.locator('#filters [data-category="all"]').click();
    const alphaCard = page.locator('#media-grid .media-card').filter({ hasText: '01-red.png' });
    await alphaCard.locator('button.media-name').click();
    await page.locator('#mark-unseen').click();
    await expect.poll(() => fixture.app.db.prepare('SELECT category FROM media WHERE id = ?')
      .get(item.id)?.category).toBe(null);
    await expect(page.locator('#status')).toContainText('Saved unseen decision');
    await page.locator('#filters [data-category="unseen"]').click();
    await expect(page.locator('#media-grid')).toContainText('01-red.png');
    const unseenItem = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'unseen', sort: 'filename',
    }).items[0];
    await page.locator('#filters [data-category="all"]').click();
    await expect(page.locator('#collection-title')).toHaveText('All items');
    await expect(page.locator('#item-count')).toHaveText('1 of 4');
    await expect(page.locator('#media-grid .media-card')).toHaveCount(4);
    await expect(page.locator('#filters [data-category="all"]')).toHaveAttribute('aria-pressed', 'true');
    expect((await api(page, `/api/media/${unseenItem.id}/lock`, { method: 'POST' })).status).toBe(200);
    expect((await api(page, `/api/media/${unseenItem.id}/decision`, {
      method: 'PUT', body: JSON.stringify({ category: 'unseen' }),
    })).status).toBe(200);
    await expect.poll(() => fixture.app.db.prepare('SELECT category FROM media WHERE id = ?')
      .get(unseenItem.id)?.category).toBe(null);

    await expect.poll(() => fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'delete', sort: 'filename',
    }).total).toBe(1);
    const deleteItem = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'delete', sort: 'filename',
    }).items[0];
    const deleteFilename = path.basename(deleteItem.relative_path);
    await expect(fs.stat(path.join(fixture.root, deleteFilename))).resolves.toBeTruthy();
    await page.locator('#app-navigation [data-view="apply"]').click();
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

test('opens directly into photo-first review with the side sheet beside it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await expect(page.locator('#review-view')).toBeVisible();
    await expect(page.locator('#side-sheet')).toBeVisible();
    await expect(page.locator('#menu-toggle')).toBeHidden();
    const reviewBox = await page.locator('#current-media').boundingBox();
    const workspaceBox = await page.locator('.workspace-main').boundingBox();
    const sideSheetBox = await page.locator('#side-sheet').boundingBox();
    const viewport = page.viewportSize();
    expect(sideSheetBox.x + sideSheetBox.width).toBeLessThanOrEqual(workspaceBox.x + 1);
    expect(reviewBox.width).toBe(workspaceBox.width);
    expect(reviewBox.height).toBeGreaterThan(viewport.height * 0.7);
    await expect(page.locator('#current-media img')).toHaveCSS('width', `${reviewBox.width}px`);

    await page.locator('#collapse-menu').click();
    await expect(page.locator('#app-panel')).toHaveClass(/sidebar-collapsed/);
    await expect(page.locator('#collapse-menu')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#collapse-menu').click();
    await expect(page.locator('#app-panel')).not.toHaveClass(/sidebar-collapsed/);
    await page.locator('#next').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
    await page.locator('#pause-review').click();
    await expect(page.locator('#browse-view')).toBeVisible();
    await page.locator('#app-navigation [data-view="review"]').click();
    await expect(page.locator('#review-view')).toBeVisible();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
    await page.keyboard.press('Escape');
    await expect(page.locator('#browse-view')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('review queue opens on unsure items when no unseen items remain', async () => {
  await expect.poll(() => fixture.app.db.prepare(
    "SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued', 'running')",
  ).get().count).toBe(0);
  const items = fixture.app.listMedia({
    collectionId: fixture.collectionId, category: 'unseen', sort: 'filename',
  }).items;
  for (const [index, item] of items.entries()) {
    fixture.app.setDecision(item.id, index === 0 ? 'unsure' : 'keep');
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '01-red.png');
  } finally {
    await context.close();
  }
});

test('unsure items return at the end of the review queue and resolved queue opens Browse', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await expect.poll(() => fixture.app.db.prepare(
      "SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued', 'running')",
    ).get().count).toBe(0);
    await expect(page.locator('#item-count')).toHaveText('1 of 4');

    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '02-green.png');
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '03-blue.png');
    await page.locator('.decision-actions [data-decision="unsure"]').click();
    await expect(page.locator('#current-media video')).toBeVisible();
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '03-blue.png');
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect(page.locator('#browse-view')).toBeVisible();
    await expect(page.locator('#status')).toContainText('All unseen and unsure photos are resolved');
    await expect(fs.readFile(path.join(fixture.root, '99-unplayable.mp4'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(fixture.root, 'unsure', '99-unplayable.mp4')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await context.close();
  }
});

test('page reload keeps an authenticated session', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await fixture.app.createPassword(PASSWORD);
    await page.goto(fixture.origin);
    await expect(page.locator('#auth-title')).toHaveText('Log in');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app-panel')).toBeVisible();

    await page.reload();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#auth-panel')).toBeHidden();
    await expect(page.locator('#collection-title')).toHaveText('Review');
  } finally {
    await context.close();
  }
});

test('logged-in users can change their password without losing the current session', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const newPassword = 'A completely new secure password! 42';
  try {
    await setupAccount(page);
    await page.locator('#app-navigation [data-view="settings"]').click();
    await page.locator('#password-management summary').click();
    await page.locator('#current-password').fill(PASSWORD);
    await page.locator('#new-password').fill('a completely new secure password 42');
    await page.locator('#confirm-new-password').fill('a completely new secure password 42');
    await page.locator('#password-change-form button[type="submit"]').click();
    await expect(page.locator('#password-change-error'))
      .toContainText('Password must include an uppercase letter, a lowercase letter, a number, and a special character.');
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#confirm-new-password').fill(newPassword);
    await page.locator('#password-change-form button[type="submit"]').click();
    await expect(page.locator('#status')).toContainText('Password changed. Other devices have been signed out.');
    await expect(page.locator('#current-password')).toHaveValue('');
    await page.reload();
    await expect(page.locator('#app-panel')).toBeVisible();

    await page.locator('#logout').click();
    await expect(page.locator('#auth-panel')).toBeVisible();
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-error')).toHaveText('Incorrect password.');
    await page.locator('#password').fill(newPassword);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app-panel')).toBeVisible();
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
    await page.locator('#app-navigation [data-view="apply"]').click();
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
    await expect(page.locator('#menu-toggle')).toBeVisible();
    await expect(page.locator('#side-sheet')).not.toHaveClass(/is-open/);
    await page.locator('#menu-toggle').click();
    await expect(page.locator('#side-sheet')).toHaveClass(/is-open/);
    await expect(page.locator('#drawer-backdrop')).toHaveClass(/is-visible/);
    await page.locator('#drawer-backdrop').click({ position: { x: 380, y: 100 } });
    await expect(page.locator('#side-sheet')).not.toHaveClass(/is-open/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    await page.locator('.decision-actions [data-decision="delete"]').click();
    await expect(page.locator('#current-media .decision-flash')).toHaveAttribute('data-category', 'delete');
    await expect(page.locator('#current-media .decision-flash')).toHaveText('Delete');
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'delete'").get().count)
      .toBe(1);
    await expect(page.locator('.decision-actions [data-decision="keep"]')).toBeEnabled();
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
    await expect(page.locator('#current-media .decision-flash')).toHaveAttribute('data-category', 'keep');
    await expect(page.locator('#current-media .decision-flash')).toHaveText('Keep');
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'keep'").get().count)
      .toBe(1);
    await expect(page.locator('#current-media img')).toHaveAttribute('alt', '03-blue.png');
    await page.locator('#menu-toggle').click();
    await page.locator('#app-navigation [data-view="browse"]').click();
    await expect(page.locator('#browse-view')).toBeVisible();
    const gridColumnCount = await page.locator('#media-grid').evaluate((element) => {
      const columns = getComputedStyle(element).gridTemplateColumns;
      const repeatCount = columns.match(/^repeat\((\d+),/);
      return repeatCount ? Number(repeatCount[1]) : columns.split(/\s+/).length;
    });
    expect(gridColumnCount).toBe(2);
    const browseLayout = await page.evaluate(() => {
      const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
      const sortLabel = bounds('label[for="sort-order"]');
      const sortSelect = bounds('#sort-order');
      const toolbar = bounds('.grid-section .section-heading > div');
      return {
        labelCenter: sortLabel.top + sortLabel.height / 2,
        selectCenter: sortSelect.top + sortSelect.height / 2,
        photoGap: bounds('#media-viewport').top - toolbar.bottom,
      };
    });
    expect(Math.abs(browseLayout.labelCenter - browseLayout.selectCenter)).toBeLessThan(1);
    expect(browseLayout.photoGap).toBeGreaterThanOrEqual(12);
  } finally {
    await context.close();
  }
});

test('Browse search filters by path, date, media type, and registered folder', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    const green = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'all', sort: 'filename',
    }).items.find((item) => item.relative_path === '02-green.png');
    fixture.app.db.prepare('UPDATE media SET capture_at = ? WHERE id = ?')
      .run('2024-02-01T12:00:00.000Z', green.id);

    await page.locator('#app-navigation [data-view="browse"]').click();
    await page.locator('#media-search-query').fill('02-');
    await page.locator('#media-search-form button[type="submit"]').click();
    await expect(page.locator('#media-grid button.media-name')).toHaveCount(1);
    await expect(page.locator('#media-grid')).toContainText('02-green.png');

    await page.locator('#clear-media-search').click();
    await page.locator('#media-kind').selectOption('video');
    await page.locator('#media-search-form button[type="submit"]').click();
    await expect(page.locator('#media-grid button.media-name')).toHaveCount(1);
    await expect(page.locator('#media-grid')).toContainText('99-unplayable.mp4');

    await page.locator('#clear-media-search').click();
    await page.locator('#media-root').selectOption(fixture.rootId);
    await page.locator('#media-from-date').fill('2024-02-01');
    await page.locator('#media-to-date').fill('2024-02-01');
    await page.locator('#media-search-form button[type="submit"]').click();
    await expect(page.locator('#media-grid button.media-name')).toHaveCount(1);
    await expect(page.locator('#media-grid')).toContainText('02-green.png');
  } finally {
    await context.close();
  }
});

test('Browse reports a missing root scan and retries it after the folder returns', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const unavailableRoot = `${fixture.root}-offline`;
  try {
    await setupAccount(page);
    await page.locator('#app-navigation [data-view="browse"]').click();
    await fs.rename(fixture.root, unavailableRoot);
    fixture.app.startRootScan(fixture.collectionId, fixture.rootId);
    await expect.poll(() => fixture.app.listScanStatus(fixture.collectionId)[0].status).toBe('failed');
    await expect(page.locator('#scan-status-list')).toContainText('ENOENT');
    await expect(page.locator('#scan-status-list [data-rescan-root]')).toBeEnabled();
    const retryButton = page.locator('#scan-status-list [data-rescan-root]');
    await expect(retryButton.locator('xpath=..')).toHaveClass(/scan-status-heading/);
    expect(await retryButton.evaluate((button) =>
      button.getBoundingClientRect().width < button.closest('.scan-status-root').getBoundingClientRect().width / 2,
    )).toBe(true);

    await fs.rename(unavailableRoot, fixture.root);
    await retryButton.click();
    await expect.poll(() => fixture.app.listScanStatus(fixture.collectionId)[0].status).toBe('completed');
    await expect.poll(() => fixture.app.listScanStatus(fixture.collectionId)[0].errorCount).toBe(0);
    await expect(page.locator('#scan-status-list')).toContainText('Scan complete');
    await expect(page.locator('#media-grid')).toContainText('01-red.png');
  } finally {
    if (await fs.stat(unavailableRoot).catch(() => null)) await fs.rename(unavailableRoot, fixture.root);
    await context.close();
  }
});

test('200,000-item browser browsing keeps pages and rendered cards bounded', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const originalCount = fixture.app.listMedia({
      collectionId: fixture.collectionId, category: 'all',
    }).total;
    const insert = fixture.app.db.prepare(`
      INSERT INTO media(id, root_id, relative_path, size, modified_at, present, kind)
      VALUES (?, ?, ?, 1, ?, 1, 'image')
    `);
    fixture.app.db.exec('BEGIN');
    try {
      for (let index = 0; index < 200_000 - originalCount; index += 1) {
        const filename = String(index).padStart(6, '0');
        insert.run(
          `virtual-${filename}`,
          fixture.rootId,
          `virtual-${filename}.jpg`,
          1_700_000_000_000 + index,
        );
      }
      fixture.app.db.exec('COMMIT');
    } catch (error) {
      fixture.app.db.exec('ROLLBACK');
      throw error;
    }

    await setupAccount(page);
    await page.locator('#app-navigation [data-view="browse"]').click();
    await page.locator('#filters [data-category="all"]').click();
    await expect(page.locator('#media-grid .media-card')).toHaveCount(60);
    const pageResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/media' && Number(url.searchParams.get('offset')) > 0;
    });
    const startedAt = performance.now();
    await page.locator('#media-viewport').evaluate((viewport) => {
      viewport.scrollTop = document.querySelector('#media-virtual-space').getBoundingClientRect().height * 0.75;
      viewport.dispatchEvent(new Event('scroll'));
    });
    const response = await pageResponse;
    const responseDurationMs = performance.now() - startedAt;
    const result = await response.json();
    expect(result.total).toBe(200_000);
    expect(result.items.length).toBeLessThanOrEqual(60);
    await expect(page.locator('#media-grid .media-card')).toHaveCount(60);
    const metrics = await page.evaluate(() => ({
      renderedCards: document.querySelectorAll('#media-grid .media-card').length,
      domNodes: document.getElementsByTagName('*').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
      virtualHeightPx: document.querySelector('#media-virtual-space').getBoundingClientRect().height,
    }));
    expect(metrics.renderedCards).toBe(60);
    expect(metrics.domNodes).toBeLessThan(1_000);
    expect(metrics.virtualHeightPx).toBeGreaterThan(200_000);
    const measured = { responseDurationMs, ...metrics, pageItems: result.items.length };
    console.log(`Large-library browser metrics: ${JSON.stringify(measured)}`);
    await test.info().attach('large-library-browser-metrics.json', {
      body: Buffer.from(JSON.stringify(measured)),
      contentType: 'application/json',
    });
  } finally {
    await context.close();
  }
});

test('undecodable media stays sortable without a generic red preview error', async () => {
  await expect.poll(() => fixture.app.db.prepare(
    "SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued', 'running')",
  ).get().count).toBe(0);
  await fs.writeFile(path.join(fixture.root, '99-broken.png'), 'not an image');
  await fixture.app.scanRoot(fixture.rootId);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await page.locator('#app-navigation [data-view="browse"]').click();
    const brokenCard = page.locator('#media-grid .media-card').filter({ hasText: '99-broken.png' });
    await expect(brokenCard.locator('.placeholder')).toContainText('Preview unavailable');
    await expect(page.locator('#status')).not.toHaveClass(/error/);
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

    await page.locator('#app-navigation [data-view="settings"]').click();
    await page.locator('#theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#side-sheet')).toHaveCSS('background-color', 'rgb(32, 38, 44)');
    await expect(page.locator('#app-navigation [data-view="settings"]'))
      .toHaveCSS('color', 'rgb(216, 232, 255)');
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
    await expect.poll(async () => (await api(page, '/api/settings')).body.defaultSort)
      .toBe('capture-desc');
    await expect(page.locator('#status')).toContainText('Einstellungen gespeichert');
    await page.locator('#preview-cache-limit').fill('0');
    await expect.poll(async () => (await api(page, '/api/settings')).body.previewCacheLimitMb)
      .toBe(0);
    await expect(page.locator('#status')).toContainText('Einstellungen gespeichert');
    await expect(page.locator('#settings-form button[type="submit"]')).toHaveCount(0);
    expect((await api(page, '/api/settings')).body).toEqual({
      defaultSort: 'capture-desc',
      previewCacheLimitMb: 0,
    });
    await page.reload();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#auth-panel')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-grid-columns', '4');
    await expect(page.locator('#language')).toHaveValue('de');

    await page.locator('#app-navigation [data-view="collections"]').click();
    await page.locator('#new-collection-form input').fill('Second collection');
    await page.locator('#new-collection-form button').click();
    await expect(page.locator('#collection option')).toHaveCount(2);
    await page.locator('#app-navigation [data-view="collections"]').click();
    await page.locator('#archive-collection').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#collection option')).toHaveCount(1);
    await page.locator('#app-navigation [data-view="collections"]').click();
    await page.locator('#archived-collections summary').click();
    await expect(page.locator('#archived-list')).toContainText('Second collection');
    await page.locator('#archived-list button').click();
    await expect(page.locator('#collection option')).toHaveCount(2);

    await page.locator('#app-navigation [data-view="collections"]').click();
    await page.locator('#collection').selectOption(fixture.collectionId);
    await expect(page.locator('#review-view')).toBeVisible();
    await expect(page.locator('.decision-actions [data-decision="keep"]')).toBeEnabled();
    await page.locator('.decision-actions [data-decision="keep"]').click();
    await expect.poll(() => fixture.app.db.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'keep'").get().count)
      .toBe(1);
    await page.locator('#app-navigation [data-view="collections"]').click();
    await page.locator('#root-management summary').click();
    await page.locator('#root-list button').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await page.locator('#app-navigation [data-view="collections"]').click();
    await expect(page.locator('#root-list')).toContainText('Ordner');
    await expect(page.locator('#current-media')).toContainText('Keine ungesehenen oder unsicheren Fotos');
    await fixture.app.addRoot(fixture.collectionId, fixture.root);
    await page.reload();
    await expect(page.locator('#app-panel')).toBeVisible();
    await expect(page.locator('#auth-panel')).toBeHidden();
    await page.locator('#app-navigation [data-view="collections"]').click();
    await expect(page.locator('#root-list')).toContainText(fixture.root);
    await expect(page.locator('#root-list button')).toHaveAttribute('aria-label', 'Entfernen');

    await page.locator('#app-navigation [data-view="history"]').click();
    await expect(page.locator('#audit-panel')).toBeVisible();
    await expect(page.locator('#audit-list')).toContainText('Entscheidung geändert');
    const decisionAuditEntry = page.locator('#audit-list .audit-entry')
      .filter({ hasText: 'Entscheidung geändert' }).first();
    await expect(decisionAuditEntry.locator('.audit-fields')).toContainText('Medien-ID');
    await expect(page.locator('#audit-list')).toHaveCSS('overflow-y', 'auto');
    const rawAuditDetails = decisionAuditEntry.locator('.audit-raw-details');
    await expect(rawAuditDetails.locator('summary')).toHaveText('Rohdaten (JSON)');
    await expect(rawAuditDetails).not.toHaveAttribute('open', '');
    await rawAuditDetails.locator('summary').click();
    await expect(rawAuditDetails.locator('pre')).toContainText('"mediaId"');
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
      await firstPage.locator('#app-navigation [data-view="browse"]').click();
    });
    await expect(firstPage.locator('#media-grid .media-card')).toHaveCount(60);
    await expect(firstPage.locator('#item-count')).toContainText('of 66');

    await test.step('connect a second device', async () => {
      await firstPage.locator('#app-navigation [data-view="review"]').click();
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
      await firstPage.locator('#app-navigation [data-view="browse"]').click();
      await expect(firstPage.locator('#media-grid .media-card').filter({ hasText: '01-red.png' }))
        .toContainText('keep');
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

test('Photo Health progress, duplicate comparison, and safe group review work in the browser', async () => {
  const copyPath = path.join(fixture.root, '04-copy.png');
  await fs.copyFile(path.join(fixture.root, '01-red.png'), copyPath);
  await fixture.app.rescanCollection(fixture.collectionId);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setupAccount(page);
    await page.locator('#app-navigation [data-view="photo-health"]').click();
    await page.locator('#photo-health-enable').click();
    await expect(page.locator('#photo-health-status')).toContainText('Analysis complete');
    await expect(page.locator('.photo-health-finding h3').first()).toHaveText('Duplicate group · 2 photos');
    await page.getByRole('button', { name: 'Compare and review' }).click();
    await expect(page.locator('.health-compare img')).toHaveCount(2);
    await expect(page.locator('.health-compare img').first()).toHaveJSProperty('naturalWidth', 96);
    await expect(page.locator('.health-member-list input[type="checkbox"]')).toHaveCount(2);
    await page.locator('.health-member-list input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: 'Keep selected; stage the rest as Deleted' }).click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#dialog-confirm').click();
    await expect(page.locator('#photo-health-list')).toContainText('No findings match');
    expect((await fs.readFile(path.join(fixture.root, '01-red.png'))).equals(
      await fs.readFile(copyPath),
    )).toBe(true);
  } finally {
    await context.close();
  }
});

test('WebAuthn passkey registration, authentication and removal with a virtual authenticator', async () => {
  test.setTimeout(30_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  let cdp;
  try {
    await setupAccount(page);
    await page.locator('#app-navigation [data-view="settings"]').click();
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

    await page.locator('#app-navigation [data-view="settings"]').click();
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
