const { app, BrowserWindow, ipcMain } = require('electron');
const { print } = require('pdf-to-printer');
const tmp = require('tmp-promise');
const fs = require('fs/promises');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      webSecurity: false
    },
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  ipcMain.on('print', async (event, url) => {
    const file = await tmp.file({ postfix: '.pdf', keep: true });
    await fs.writeFile(file.path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

    try {
      await print(file.path, {
        printer: 'Brother PT-P710BT',
        // printer: 'Microsoft Print to PDF',
        orientation: 'landscape',
        printDialog: false,
        scale: 'fit',
        silent: false,
        copies: 1
      });
      mainWindow.webContents.send('clear');
    } catch (e) {
      mainWindow.webContents.send('error', e.message);
      console.log(e);
    }

    await file.cleanup();
  });

  ipcMain.on('print-old', async (event, url) => {
    const win = new BrowserWindow({
      show: true,
      webPreferences: {
        nodeIntegration: true
      }
    });
    win.loadURL(url);

    await Promise.all([
      new Promise(resolve => win.webContents.on('dom-ready', resolve)),
      new Promise(resolve => win.webContents.on('did-finish-load', resolve)),
      new Promise(resolve => win.webContents.on('page-title-updated', resolve)),
    ]);

    win.webContents.print({
      silent: false,
      printBackground: true,
      // deviceName: 'Brother PT-P710BT',
      deviceName: 'Microsoft Print to PDF',
      color: false,
      margin: {
        marginType: 'printableArea'
      },
      landscape: false,
      pagesPerSheet: 1,
      collate: false,
      copies: 1,
      header: '',
      footer: ''
    }, (success, failureReason) => {
      if (!success) {
        mainWindow.webContents.send('error', failureReason);
      } else {
        mainWindow.webContents.send('clear');
        win.close();
      }
    });
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
