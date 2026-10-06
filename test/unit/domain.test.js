const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CATEGORIES,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isLocalNetworkAddress,
  isWithin,
  numberedDestination,
  pathsOverlap,
} = require('../../src/app');

test('registered-root boundary rejects traversal and accepts descendants', () => {
  const root = path.resolve('/photos');
  assert.equal(isWithin(root, path.join(root, 'holiday', 'image.jpg')), true);
  assert.equal(isWithin(root, path.resolve(root, '..', 'outside.jpg')), false);
});

test('root overlap detects parent, child, and exact paths', () => {
  assert.equal(pathsOverlap('/photos', '/photos/2024'), true);
  assert.equal(pathsOverlap('/photos/2024', '/photos'), true);
  assert.equal(pathsOverlap('/photos', '/other'), false);
});

test('collision names are numbered before their extension', () => {
  const existing = new Set(['/photos/deleted/image.jpg', '/photos/deleted/image (1).jpg']);
  const result = numberedDestination('/photos/deleted/image.jpg', (candidate) => existing.has(candidate));
  assert.equal(result, '/photos/deleted/image (2).jpg');
});

test('media allowlists include common image/video formats and categories are bounded', () => {
  assert.equal(IMAGE_EXTENSIONS.has('.heic'), true);
  assert.equal(IMAGE_EXTENSIONS.has('.exe'), false);
  assert.equal(VIDEO_EXTENSIONS.has('.mp4'), true);
  assert.equal(VIDEO_EXTENSIONS.has('.pdf'), false);
  assert.deepEqual([...CATEGORIES].sort(), ['delete', 'keep', 'unseen', 'unsure']);
});

test('LAN listener addresses accept private and link-local networks only', () => {
  assert.equal(isLocalNetworkAddress('192.168.1.12'), true);
  assert.equal(isLocalNetworkAddress('172.20.0.1'), true);
  assert.equal(isLocalNetworkAddress('8.8.8.8'), false);
  assert.equal(isLocalNetworkAddress('fd12::1'), true);
});
