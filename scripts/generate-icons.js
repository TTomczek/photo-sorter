const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const iconDirectory = path.join(__dirname, '..', 'src', 'ui');
const icnsTypes = new Map([
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
]);

async function renderPng(browser, svgDataUrl, size) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(`<html><body style="margin:0"><img id="icon" src="${svgDataUrl}"></body></html>`);
    await page.locator('#icon').evaluate(async (image, dimension) => {
      image.style.display = 'block';
      image.style.width = `${dimension}px`;
      image.style.height = `${dimension}px`;
      await image.decode();
    }, size);
    return await page.locator('#icon').screenshot({ omitBackground: true });
  } finally {
    await page.close();
  }
}

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let imageOffset = headerSize;

  images.forEach(({ size, png }, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

function createIcns(images) {
  const chunks = images.map(({ size, png }) => {
    const type = icnsTypes.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + header.length, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(chunks.reduce((length, chunk) => length + chunk.length, header.length), 4);
  return Buffer.concat([header, ...chunks]);
}

async function main() {
  const svg = await fs.readFile(path.join(iconDirectory, 'icon.svg'));
  const svgDataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const pngImages = await Promise.all(
      [...icnsTypes.keys()].map(async (size) => ({
        size,
        png: await renderPng(browser, svgDataUrl, size),
      })),
    );
    await Promise.all([
      fs.writeFile(path.join(iconDirectory, 'icon.png'), pngImages.find(({ size }) => size === 512).png),
      fs.writeFile(path.join(iconDirectory, 'icon.ico'), createIco(
        pngImages.filter(({ size }) => size <= 256),
      )),
      fs.writeFile(path.join(iconDirectory, 'icon.icns'), createIcns(pngImages)),
    ]);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Failed to generate platform icons from src/ui/icon.svg:', error);
  process.exitCode = 1;
});
