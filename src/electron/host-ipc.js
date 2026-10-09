function registerHostIpc({ ipcMain, dialog, app, getWindow, getService, getPort }) {
  function assertTrustedMainFrame(event, message = 'This setting is only available in the host app.') {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame
      || new URL(frame.url).origin !== `http://127.0.0.1:${getPort()}`) {
      throw new Error(message);
    }
  }

  ipcMain.handle('photo-sorter:choose-root', async (event, collectionId) => {
    assertTrustedMainFrame(event, 'Folder selection is only available in the host app.');
    if (typeof collectionId !== 'string' || collectionId.length > 64) {
      throw new Error('Invalid collection.');
    }
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a photo or video folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const rootId = await getService().addRoot(collectionId, result.filePaths[0], { waitForScan: false });
    return { rootId };
  });

  ipcMain.handle('photo-sorter:set-autostart', (event, enabled) => {
    assertTrustedMainFrame(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid autostart setting.');
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('photo-sorter:get-autostart', (event) => {
    assertTrustedMainFrame(event);
    return app.getLoginItemSettings().openAtLogin;
  });
}

module.exports = { registerHostIpc };
