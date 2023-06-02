const { app, BrowserWindow, ipcMain } = require('electron');
const { print, getPrinters, getDefaultPrinter } = require('pdf-to-printer');
const regedit = require('regedit');
const tmp = require('tmp-promise');
const fs = require('fs/promises');
require('update-electron-app')();

console.log(require('update-electron-app'));

regedit.setExternalVBSLocation('./.webpack/main/vbs');
regedit.setExternalVBSLocation('./vbs');

const REGISTRY_SMALL = [...Buffer.from('420072006f0074006800650072002000500054002d0050003700310030004200540000000000000000000000000000000000000000000000000000000000000001040005dc0040010f65010002000301f4017700640001000000b40001000100b400030000003100320020006d006d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e000000ef00030100000e00010000001e0062010000010000004252505400000000000000006b81040007e50b0050524956a03000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000180000000000102710271027000010270000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030003000000000003000062010000f4010000f4010000102700002c000000010000000000000000000000010000010e000000000001000000000000000000000000000000000000000000000000006b81040007e50b00000000000000000000', 'hex')];
const REGISTRY_LARGE = [...Buffer.from('420072006f0074006800650072002000500054002d0050003700310030004200540000000000000000000000000000000000000000000000000000000000000001040005dc0040010f65010002000501b6037700640001000000b40001000100b400030000003200340020006d006d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e000000ef00050100000e00010000001e00a1020000010000004252505400000000000000006b81040007e50b0050524956a030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001800000000001027102710270000102700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500030000000000030000a1020000b6030000b6030000102700002c000000010000000000000000000000010000010e000000000001000000000000000000000000000000000000000000000000006b81040007e50b00000000000000000000', 'hex')];

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

  ipcMain.handle('quit', () => app.quit());
  ipcMain.handle('isProduction', () => app.isPackaged);

  ipcMain.on('getPrinters', async () => {
    const printers = await getPrinters();
    const defaultPrinter = await getDefaultPrinter();
    mainWindow.webContents.send('getPrintersResult', {
      defaultPrinter: defaultPrinter,
      printers: printers
    });
  });

  ipcMain.on('print', async (event, url, settings, small) => {
    try {
      const file = await tmp.file({ postfix: '.pdf', keep: true });
      await fs.writeFile(file.path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

      // update registry
      try {
        await new Promise((resolve, reject) => regedit.putValue({
          'HKCU\\Printers\\DevModePerUser': {
            'Brother PT-P710BT': {
              type: 'REG_BINARY',
              value: small ? REGISTRY_SMALL : REGISTRY_LARGE
            }
          },
          'HKCU\\Printers\\DevModes2': {
            'Brother PT-P710BT': {
              type: 'REG_BINARY',
              value: small ? REGISTRY_SMALL : REGISTRY_LARGE
            }
          }
        }, (e) => e ? reject(e) : resolve()));
      } catch (e) {
        e.message = `Registry hack didn't work (${e.message})`;
        throw e;
      }

      if (!settings || typeof settings !== 'object') {
        settings = {};
      }
      if (!settings?.printer) {
        settings.printer = 'Brother PT-P710BT';
      }
      if (!settings?.printDialog) {
        settings.printDialog = false;
      }

      await print(file.path, {
        printer: settings.printer,
        printDialog: settings.printDialog,
        orientation: 'landscape',
        scale: 'fit',
        silent: false,
        copies: 1
      });

      mainWindow.webContents.send('clear', small);
      await file.cleanup();
    } catch (e) {
      mainWindow.webContents.send('error', e.message);
      console.log(e);
    }
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
