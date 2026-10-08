const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PhotoSorter, defaultDataDirectory } = require('../app');

app.setName('photo-sorter');
app.setPath('userData', defaultDataDirectory());

let appIcon;
let service;
let window;
let tray;
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
  await window.loadURL(`http://127.0.0.1:${serverPort}`);
  if (process.env.NODE_ENV === 'development') window.webContents.openDevTools();
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
  ipcMain.handle('photo-sorter:choose-root', async (_event, collectionId) => {
    if (_event.senderFrame !== _event.sender.mainFrame
      || new URL(_event.senderFrame.url).origin !== `http://127.0.0.1:${serverPort}`) {
      throw new Error('Folder selection is only available in the host app.');
    }
    if (typeof collectionId !== 'string' || collectionId.length > 64) throw new Error('Invalid collection.');
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a photo or video folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const rootId = await service.addRoot(collectionId, result.filePaths[0], { waitForScan: false });
    return { rootId };
  });
  ipcMain.handle('photo-sorter:set-autostart', (_event, enabled) => {
    if (_event.senderFrame !== _event.sender.mainFrame
      || new URL(_event.senderFrame.url).origin !== `http://127.0.0.1:${serverPort}`) {
      throw new Error('This setting is only available in the host app.');
    }
    if (typeof enabled !== 'boolean') throw new Error('Invalid autostart setting.');
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('photo-sorter:get-autostart', (_event) => {
    if (_event.senderFrame !== _event.sender.mainFrame
      || new URL(_event.senderFrame.url).origin !== `http://127.0.0.1:${serverPort}`) {
      throw new Error('This setting is only available in the host app.');
    }
    return app.getLoginItemSettings().openAtLogin;
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
  tray?.destroy();
  Promise.resolve(service?.close()).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {});
