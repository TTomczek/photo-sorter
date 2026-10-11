const crypto = require('node:crypto');
const fs = require('node:fs');
const sharp = require('sharp');

const ANALYSIS_PIXEL_LIMIT = 200_000_000;
const HASH_SIZE = 32;
const HASH_FREQUENCIES = 8;
const PHASH_MAX_DISTANCE = 2;
const SIMILARITY_PIXEL_DIFFERENCE_LIMIT = 3;
const HASH_COSINES = Array.from({ length: HASH_FREQUENCIES }, (_, frequency) => (
  Array.from({ length: HASH_SIZE }, (_, sample) => Math.cos(((2 * sample + 1) * frequency * Math.PI) / (2 * HASH_SIZE)))
));

function imageDimensions(metadata) {
  const swapped = [5, 6, 7, 8].includes(metadata.orientation);
  return swapped
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function perceptualHash(pixels) {
  const samples = new Float64Array(HASH_SIZE * HASH_SIZE);
  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let x = 0; x < HASH_SIZE; x += 1) {
      samples[y * HASH_SIZE + x] = pixels[y * HASH_SIZE + x];
    }
  }

  const horizontal = new Float64Array(HASH_SIZE * HASH_FREQUENCIES);
  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let u = 0; u < HASH_FREQUENCIES; u += 1) {
      let sum = 0;
      for (let x = 0; x < HASH_SIZE; x += 1) {
        sum += samples[y * HASH_SIZE + x] * HASH_COSINES[u][x];
      }
      horizontal[y * HASH_FREQUENCIES + u] = sum;
    }
  }

  const coefficients = [];
  for (let v = 0; v < HASH_FREQUENCIES; v += 1) {
    for (let u = 0; u < HASH_FREQUENCIES; u += 1) {
      if (u === 0 && v === 0) continue;
      let sum = 0;
      for (let y = 0; y < HASH_SIZE; y += 1) {
        sum += horizontal[y * HASH_FREQUENCIES + u] * HASH_COSINES[v][y];
      }
      coefficients.push(sum);
    }
  }

  const sorted = coefficients.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  let hash = 0n;
  for (const coefficient of coefficients) hash = (hash << 1n) | (coefficient > median ? 1n : 0n);
  return hash.toString(16).padStart(16, '0');
}

function normalizedImageSignature(pixels) {
  const signature = Buffer.alloc(HASH_SIZE * HASH_SIZE);
  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let x = 0; x < HASH_SIZE; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < 8; dy += 1) {
        for (let dx = 0; dx < 8; dx += 1) {
          sum += pixels[(y * 8 + dy) * 256 + x * 8 + dx];
        }
      }
      signature[y * HASH_SIZE + x] = Math.round(sum / 64);
    }
  }
  return signature;
}

function signatureDifference(left, right) {
  if (!left || !right || left.length !== HASH_SIZE * HASH_SIZE || right.length !== left.length) return Infinity;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length;
}

function hashDistance(left, right) {
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (difference) {
    distance += 1;
    difference &= difference - 1n;
  }
  return distance;
}

function hashBuckets(hash) {
  return Array.from({ length: 4 }, (_, index) => hash.slice(index * 4, index * 4 + 4));
}

async function fileSha256(filename) {
  const digest = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return digest.digest('hex');
}

async function analyzeImage(filename) {
  const metadata = await sharp(filename, { limitInputPixels: ANALYSIS_PIXEL_LIMIT, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('The image dimensions could not be read.');
  const dimensions = imageDimensions(metadata);
  const [sha256, decoded] = await Promise.all([
    fileSha256(filename),
    sharp(filename, { limitInputPixels: ANALYSIS_PIXEL_LIMIT, failOn: 'error' })
      .rotate()
      .resize(256, 256, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const signature = normalizedImageSignature(decoded.data);
  return {
    sha256,
    phash: perceptualHash(signature),
    imageSignature: signature,
    width: dimensions.width,
    height: dimensions.height,
  };
}

module.exports = {
  PHASH_MAX_DISTANCE,
  analyzeImage,
  fileSha256,
  hashBuckets,
  hashDistance,
  signatureDifference,
  SIMILARITY_PIXEL_DIFFERENCE_LIMIT,
};
