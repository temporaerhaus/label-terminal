// Updates from the GitHub releases (see .github/workflows/release.yml), through
// Electron's update service and Squirrel.Windows, as update-electron-app did:
// a look right after starting and every 10 minutes, a newer version is
// downloaded and installed next to the running one, and takes over with the
// next start. What it is doing is sent to the window, which shows it in the
// settings, and asks there for the restart.
const { app, autoUpdater } = require('electron');

const FEED = 'https://update.electronjs.org/temporaerhaus/label-terminal';
const INTERVAL = 10 * 60 * 1000;

// send: called with the state whenever it changes
module.exports = function updater(send) {
  // status: idle, checking, downloading, up-to-date, downloaded, error, or
  // unsupported for a version that is not installed (e.g. npm start)
  const state = {
    version: app.getVersion(),
    status: app.isPackaged && process.platform === 'win32' ? 'idle' : 'unsupported',
    checked: null,
    error: null
  };
  const update = (changes) => {
    Object.assign(state, changes);
    send({ ...state });
  };

  // not while a look is still going on, or an update only waits for the restart
  const check = () => {
    if (!['unsupported', 'checking', 'downloading', 'downloaded'].includes(state.status)) {
      autoUpdater.checkForUpdates();
    }
    return { ...state };
  };

  if (state.status !== 'unsupported') {
    autoUpdater.setFeedURL({
      url: `${FEED}/${process.platform}-${process.arch}/${app.getVersion()}`,
      headers: { 'User-Agent': `label-terminal/${app.getVersion()} (${process.platform}: ${process.arch})` }
    });

    autoUpdater.on('checking-for-update', () => update({ status: 'checking' }));
    autoUpdater.on('update-available', () => update({ status: 'downloading' }));
    autoUpdater.on('update-not-available', () => update({ status: 'up-to-date', checked: Date.now(), error: null }));
    autoUpdater.on('update-downloaded', () => update({ status: 'downloaded', checked: Date.now(), error: null }));
    autoUpdater.on('error', (e) => update({ status: 'error', checked: Date.now(), error: e?.message || String(e) }));

    check();
    setInterval(check, INTERVAL);
  }

  return {
    state: () => ({ ...state }),
    check,
    restart: () => {
      if (state.status === 'downloaded') {
        autoUpdater.quitAndInstall();
      }
    }
  };
};
