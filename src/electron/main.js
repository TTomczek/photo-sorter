const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require('electron');
const { watch } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PhotoSorter, defaultDataDirectory } = require('../app');
const { registerHostIpc } = require('./host-ipc');

app.setName('photo-sorter');
app.setPath('userData', defaultDataDirectory());

const development = !app.isPackaged && process.argv.includes('--hot-reload');
let appIcon;
let service;
let window;
let tray;
let uiWatcher;
let reloadTimer;
let serverPort;
let quitting = false;
let shutdownComplete = false;

async function loadAppIcon() {
  const svgPath = path.join(__dirname, '..', 'ui', 'icon.svg');
  if (process.platform !== 'win32') {
    const svgIcon = nativeImage.createFromPath(svgPath);
    if (!svgIcon.isEmpty()) return svgIcon;
  }

  const svg = await fs.readFile(svgPath);
  const svgDataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  const renderer = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    webPreferences: { sandbox: true },
  });

  try {
    await renderer.loadURL('data:text/html,<html><body></body></html>');
    const pngDataUrl = await renderer.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(svgDataUrl)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      canvas.getContext('2d').drawImage(image, 0, 0, 512, 512);
      return canvas.toDataURL('image/png');
    })()`);
    const icon = nativeImage.createFromDataURL(pngDataUrl);
    if (icon.isEmpty()) throw new Error('The application SVG icon could not be rendered.');
    return icon;
  } finally {
    renderer.destroy();
  }
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 340,
    minHeight: 560,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const localOrigin = `http://127.0.0.1:${serverPort}`;
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== localOrigin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  if (development) {
    await window.webContents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  }
  await window.loadURL(`http://127.0.0.1:${serverPort}${development ? '/?dev=1' : ''}`);
  if (development) {
    uiWatcher = watch(path.join(__dirname, '..', 'ui'), { recursive: true }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (window && !window.isDestroyed()) window.webContents.reloadIgnoringCache();
      }, 100);
    });
    uiWatcher.on('error', (error) => console.error('Development UI watcher failed:', error));
  }
}

function showWindow() {
  if (!window || window.isDestroyed()) return createWindow();
  window.show();
  window.focus();
}

app.whenReady().then(async () => {
  appIcon = await loadAppIcon();
  if (process.platform === 'darwin') app.dock.setIcon(appIcon);
  service = await new PhotoSorter().initialize();
  serverPort = await service.listen();
  registerHostIpc({
    ipcMain,
    dialog,
    app,
    getWindow: () => window,
    getService: () => service,
    getPort: () => serverPort,
  });
  await createWindow();
  tray = new Tray(appIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Photo Sorter is serving your local network');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Photo Sorter', click: showWindow },
    { type: 'separator' },
    {
      label: 'Start Photo Sorter when I sign in',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: 'Quit and stop service', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}).catch((error) => {
  dialog.showErrorBox('Photo Sorter failed to start', error.message);
  app.quit();
});

app.on('activate', showWindow);
app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  uiWatcher?.close();
  clearTimeout(reloadTimer);
  tray?.destroy();
  Promise.resolve(service?.close()).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {});
