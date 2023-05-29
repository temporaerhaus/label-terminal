const { app, BrowserWindow, ipcMain } = require('electron');
const { print, getPrinters, getDefaultPrinter } = require('pdf-to-printer');
const tmp = require('tmp-promise');
const fs = require('fs/promises');
require('update-electron-app')();

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

  ipcMain.on('getPrinters', async () => {
    const printers = await getPrinters();
    const defaultPrinter = await getDefaultPrinter();
    mainWindow.webContents.send('getPrintersResult', {
      defaultPrinter: defaultPrinter,
      printers: printers
    });
  });

  ipcMain.on('print', async (event, url, settings, small) => {
    const file = await tmp.file({ postfix: '.pdf', keep: true });
    await fs.writeFile(file.path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    console.log(file.path);

    if (!settings || typeof settings !== 'object') {
      settings = {};
    }
    if (!settings?.printer) {
      settings.printer = 'Brother PT-P710BT';
    }
    if (!settings?.printDialog) {
      settings.printDialog = false;
    }

    try {
      await print(file.path, {
        printer: settings.printer,
        printDialog: settings.printDialog,
        orientation: 'landscape',
        scale: 'fit',
        silent: false,
        copies: 1
      });
      mainWindow.webContents.send('clear', small);
    } catch (e) {
      mainWindow.webContents.send('error', e.message);
      console.log(e);
    }

    await file.cleanup();
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
