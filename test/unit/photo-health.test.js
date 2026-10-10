const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PhotoSorter } = require('../../src/app');
const { analyzeImage, hashDistance } = require('../../src/photo-health');

function scene({ background = '#e8e0c8', shift = 0 } = {}) {
  return Buffer.from(`<svg width="256" height="256">
    <rect width="256" height="256" fill="${background}"/>
    <rect x="${18 + shift}" y="24" width="92" height="155" fill="#103b63"/>
    <circle cx="${174 - shift}" cy="80" r="43" fill="#c3472a"/>
    <path d="M24 218 L128 95 L232 218 Z" fill="#207449"/>
    <path d="M145 145 L220 130 L238 220 L162 226 Z" fill="#e8c040"/>
  </svg>`);
}

async function waitForHealth(app, collectionId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = app.getPhotoHealthStatus(collectionId);
    if (status.pending === 0) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Photo Health analysis did not finish in time.');
}

test('Photo Health finds exact and resized copies, flags blur, and exposes failures', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-health-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  const dataDirectory = path.join(temporary, 'data');
  const exact = await sharp(scene()).png().toBuffer();
  const similarOriginal = await sharp(scene({ background: '#c9e8df', shift: 70 })).png().toBuffer();
  const similar = await sharp(similarOriginal).resize(128, 128).jpeg({ quality: 70 }).toBuffer();
  const cropped = await sharp(similarOriginal).extract({ left: 16, top: 16, width: 224, height: 224 }).png().toBuffer();
  const clearScene = await sharp(scene({ background: '#d3d8e8', shift: 30 })).png().toBuffer();
  const blurryScene = await sharp(clearScene).blur(8).png().toBuffer();
  await fs.writeFile(path.join(root, '01-exact-a.png'), exact);
  await fs.writeFile(path.join(root, '02-exact-b.png'), exact);
  await fs.writeFile(path.join(root, '03-similar-original.png'), similarOriginal);
  await fs.writeFile(path.join(root, '04-crop.png'), cropped);
  await fs.writeFile(path.join(root, '05-similar-copy.jpg'), similar);
  await fs.writeFile(path.join(root, '06-clear.png'), clearScene);
  await fs.writeFile(path.join(root, '07-blurry.png'), blurryScene);
  await fs.writeFile(path.join(root, '08-blurry-copy.png'), blurryScene);
  await fs.writeFile(path.join(root, '09-video-a.mp4'), 'same video bytes');
  await fs.writeFile(path.join(root, '10-video-b.mp4'), 'same video bytes');
  await fs.writeFile(path.join(root, '11-broken.jpg'), 'not an image');

  const app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection('Health');
  const rootId = await app.addRoot(collectionId, root);
  app.setPhotoHealthState(collectionId, 'enable');

  const status = await waitForHealth(app, collectionId);
  assert.equal(status.total, 11);
  assert.equal(status.processed, 11);
  assert.equal(status.unsupported, 1);
  assert.equal(status.blurry, 2);
  assert.equal(status.status, 'completed');

  const findings = app.listPhotoHealthFindings(collectionId, { type: 'duplicate', limit: 100 });
  const exactGroup = findings.items.find((finding) => finding.reason === 'Exact file match'
    && app.listPhotoHealthGroup(collectionId, finding.groupId).items
      .some((member) => member.relativePath === '01-exact-a.png'));
  const similarGroup = findings.items.find((finding) => finding.reason === 'Very similar image framing and content');
  assert.ok(exactGroup);
  assert.ok(similarGroup);
  assert.equal(app.listPhotoHealthGroup(collectionId, exactGroup.groupId).total, 2);
  assert.ok(similarGroup.strength >= 0.95);
  const videoGroup = findings.items.find((finding) => (
    app.listPhotoHealthGroup(collectionId, finding.groupId).items
      .some((member) => member.relativePath === '09-video-a.mp4')
  ));
  assert.ok(videoGroup);
  assert.equal(app.listPhotoHealthGroup(collectionId, videoGroup.groupId).total, 2);
  assert.equal(findings.items.some((finding) => (
    app.listPhotoHealthGroup(collectionId, finding.groupId).items
      .some((member) => member.relativePath === '07-blurry.png')
  )), true);
  assert.equal(findings.items.some((finding) => app.listPhotoHealthGroup(collectionId, finding.groupId).items
    .some((member) => member.relativePath === '04-crop.png')), false);

  const blurs = app.listPhotoHealthFindings(collectionId, { type: 'blur' }).items;
  assert.equal(blurs.length, 2);
  const blur = blurs.find((finding) => finding.label === '07-blurry.png');
  assert.equal(blur.label, '07-blurry.png');
  const blurredMedia = app.db.prepare(`
    SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id
    WHERE r.collection_id = ? AND m.relative_path = ?
  `).get(collectionId, blur.label).id;
  app.claimMediaLock(blurredMedia, 'phone');
  app.setDeviceDecision(blurredMedia, 'unsure', 'phone');
  const blurryCopy = app.db.prepare(`
    SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id
    WHERE r.collection_id = ? AND m.relative_path = '08-blurry-copy.png'
  `).get(collectionId).id;
  app.claimMediaLock(blurryCopy, 'phone');
  app.setDeviceDecision(blurryCopy, 'unsure', 'phone');
  assert.equal(app.listPhotoHealthFindings(collectionId, { type: 'blur' }).total, 0);
  assert.equal(app.listPhotoHealthFindings(collectionId, { type: 'blur', handled: 'handled' }).total, 2);

  const members = app.listPhotoHealthGroup(collectionId, exactGroup.groupId).items;
  app.claimMediaLock(members[1].id, 'other-device');
  assert.throws(() => app.decidePhotoHealthGroup(collectionId, exactGroup.groupId, [members[0].id], 'phone'),
    (error) => error.status === 409);
  app.releaseMediaLock(members[1].id, 'other-device');
  const result = app.decidePhotoHealthGroup(collectionId, exactGroup.groupId, [members[0].id], 'phone');
  assert.deepEqual(result, { changed: true, keptCount: 1, deletedCount: 1 });
  assert.deepEqual(app.db.prepare(`
    SELECT category FROM media WHERE id IN (?, ?) ORDER BY category
  `).all(...members.map((member) => member.id)).map((row) => row.category), ['delete', 'keep']);
  assert.equal(app.listPhotoHealthFindings(collectionId, { type: 'duplicate', handled: 'open' })
    .items.some((finding) => finding.groupId === exactGroup.groupId), false);
  assert.equal(app.listPhotoHealthFindings(collectionId, { type: 'duplicate', handled: 'handled' })
    .items.some((finding) => finding.groupId === exactGroup.groupId), true);
  assert.equal((await fs.readFile(path.join(root, '01-exact-a.png'))).equals(exact), true);
  assert.throws(() => app.listPhotoHealthGroup('another-collection', exactGroup.groupId), /not found/);

  await fs.writeFile(path.join(root, '12-video-c.mp4'), 'same video bytes');
  await app.scanRoot(rootId);
  const updatedStatus = await waitForHealth(app, collectionId);
  assert.equal(updatedStatus.total, 12);
  assert.equal(updatedStatus.processed, 12);
  assert.equal(app.listPhotoHealthGroup(collectionId, videoGroup.groupId).total, 3);
});

test('image analysis distinguishes a resized recompressed copy from a blurred image', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-health-analysis-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source.png');
  const resized = path.join(temporary, 'resized.jpg');
  const blurred = path.join(temporary, 'blurred.png');
  await sharp(scene()).png().toFile(source);
  await sharp(scene()).resize(128, 128).jpeg({ quality: 70 }).toFile(resized);
  await sharp(scene()).blur(8).png().toFile(blurred);

  const originalResult = await analyzeImage(source);
  const resizedResult = await analyzeImage(resized);
  const blurredResult = await analyzeImage(blurred);
  assert.notEqual(originalResult.sha256, resizedResult.sha256);
  assert.ok(hashDistance(originalResult.phash, resizedResult.phash) <= 2);
  assert.equal(originalResult.isBlurry, false);
  assert.equal(blurredResult.isBlurry, true);
});

test('image analysis flags motion-softened high-contrast scenes', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-health-motion-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source.png');
  const blurred = path.join(temporary, 'motion-blurred.png');
  const shapes = [];
  for (let y = 12; y < 250; y += 16) {
    shapes.push(`<path d="M 8 ${y} H ${60 + (y % 50)}" stroke="#fff" stroke-width="2"/>`);
    shapes.push(`<path d="M ${90 + (y % 35)} ${y + 2} H 240" stroke="#03e9ff" stroke-width="1"/>`);
  }
  for (let x = 24; x < 250; x += 22) {
    shapes.push(`<rect x="${x}" y="${(x * 3) % 200}" width="9" height="40" fill="#ffb020"/>`);
  }
  const sceneWithBrightDetails = Buffer.from(`<svg width="256" height="256">
    <rect width="256" height="256" fill="#20202a"/>${shapes.join('')}
  </svg>`);
  await sharp(sceneWithBrightDetails).png().toFile(source);
  await sharp(sceneWithBrightDetails).blur(2).png().toFile(blurred);

  assert.equal((await analyzeImage(source)).isBlurry, false);
  assert.equal((await analyzeImage(blurred)).isBlurry, true);
});

test('Photo Health reanalyzes stored images when the blur detector is upgraded', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-sorter-health-upgrade-'));
  const root = path.join(temporary, 'library');
  await fs.mkdir(root);
  const dataDirectory = path.join(temporary, 'data');
  await sharp(scene()).blur(8).png().toFile(path.join(root, 'blurred.png'));

  let app = await new PhotoSorter({ dataDirectory }).initialize();
  t.after(async () => {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const collectionId = app.createCollection('Health upgrade');
  await app.addRoot(collectionId, root);
  app.setPhotoHealthState(collectionId, 'enable');
  assert.equal((await waitForHealth(app, collectionId)).blurry, 1);

  const mediaId = app.db.prepare(`
    SELECT m.id FROM media m JOIN roots r ON r.id = m.root_id
    WHERE r.collection_id = ? AND m.relative_path = 'blurred.png'
  `).get(collectionId).id;
  app.db.prepare("UPDATE photo_health_items SET is_blurry = 0 WHERE media_id = ?").run(mediaId);
  app.db.exec('PRAGMA user_version = 4');
  await app.close();

  app = await new PhotoSorter({ dataDirectory }).initialize();
  await waitForHealth(app, collectionId);
  assert.equal(app.listPhotoHealthFindings(collectionId, { type: 'blur' }).total, 1);
});
