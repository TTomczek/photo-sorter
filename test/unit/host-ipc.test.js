const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHostIpc } = require('../../src/electron/host-ipc');

function createHostHarness({ pickerResult = { canceled: false, filePaths: ['C:\\Photos'] } } = {}) {
  const handlers = new Map();
  const calls = [];
  let autostart = false;
  const app = {
    setLoginItemSettings: (settings) => { autostart = settings.openAtLogin; },
    getLoginItemSettings: () => ({ openAtLogin: autostart }),
  };
  const service = {
    addRoot: async (...args) => {
      calls.push(args);
      return 'registered-root';
    },
  };
  const dialog = {
    showOpenDialog: async (...args) => {
      calls.push(args);
      return pickerResult;
    },
  };
  registerHostIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog,
    app,
    getWindow: () => 'host-window',
    getService: () => service,
    getPort: () => 43127,
  });
  const mainFrame = { url: 'http://127.0.0.1:43127/' };
  const hostEvent = { senderFrame: mainFrame, sender: { mainFrame } };
  return { handlers, calls, hostEvent, app };
}

test('Electron folder-picker IPC invokes the native directory dialog only from the host frame', async () => {
  const { handlers, calls, hostEvent } = createHostHarness();
  const chooseRoot = handlers.get('photo-sorter:choose-root');
  assert.deepEqual(await chooseRoot(hostEvent, 'collection-id'), { rootId: 'registered-root' });
  assert.deepEqual(calls[0], [
    'host-window',
    { title: 'Choose a photo or video folder', properties: ['openDirectory'] },
  ]);
  assert.deepEqual(calls[1], ['collection-id', 'C:\\Photos', { waitForScan: false }]);

  const remoteFrame = { url: 'http://192.168.1.20:43127/' };
  await assert.rejects(
    chooseRoot({ senderFrame: remoteFrame, sender: { mainFrame: remoteFrame } }, 'collection-id'),
    /Folder selection is only available in the host app/,
  );
  await assert.rejects(
    chooseRoot({ ...hostEvent, senderFrame: { url: hostEvent.senderFrame.url } }, 'collection-id'),
    /Folder selection is only available in the host app/,
  );
  await assert.rejects(chooseRoot(hostEvent, 'x'.repeat(65)), /Invalid collection/);
  assert.equal(calls.length, 2);
});

test('Electron folder-picker cancellation and autostart IPC preserve explicit host behavior', async () => {
  const { handlers, calls, hostEvent, app } = createHostHarness({ pickerResult: { canceled: true, filePaths: [] } });
  assert.deepEqual(await handlers.get('photo-sorter:choose-root')(hostEvent, 'collection-id'), { canceled: true });
  assert.equal(calls.length, 1);
  assert.equal(handlers.get('photo-sorter:set-autostart')(hostEvent, true), true);
  assert.equal(handlers.get('photo-sorter:get-autostart')(hostEvent), true);
  assert.throws(() => handlers.get('photo-sorter:set-autostart')(hostEvent, 'true'), /Invalid autostart setting/);
  assert.equal(app.getLoginItemSettings().openAtLogin, true);
});
