const fs = require('fs');

const sumatra = fs.readdirSync('node_modules/pdf-to-printer/dist/').find(e => e.endsWith('.exe'));

module.exports = {
  packagerConfig: {
    // the app as plain files, as before @electron/packager 19 made an asar
    // archive the default: pdf-to-printer and regedit run files from disk
    asar: false,
    extraResource: [
      `node_modules/pdf-to-printer/dist/${sumatra}`,
      `node_modules/regedit/vbs`
    ]
  },
  rebuildConfig: {},
  makers: [{
    name: '@electron-forge/maker-squirrel',
    config: {
      name: 'label-terminal-win32-ia32'
    }
  }],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        devContentSecurityPolicy: `default-src * data: blob: filesystem: about: ws: wss: 'unsafe-inline' 'unsafe-eval'`,
        // I gave up `default-src 'self' https://wiki.temporaerhaus.de https://cdn.jsdelivr.net/ 'unsafe-eval' 'unsafe-inline'`,
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/index.html',
              js: './src/renderer.js',
              name: 'main_window',
              preload: {
                js: './src/preload.js',
              },
            },
          ],
        },
      },
    },
  ],
};
