import './index.css';
import YAML from 'yaml';

import QRCode from 'qrcode';
import logo from './logo.svg';
import pdfMake from 'pdfmake/build/pdfmake';

pdfMake.fonts = {
  freemono: {
    bold: 'https://cdn.jsdelivr.net/gh/googlefonts/RobotoMono@main/fonts/ttf/RobotoMono-Bold.ttf',
    normal: 'https://cdn.jsdelivr.net/gh/googlefonts/RobotoMono@main/fonts/ttf/RobotoMono-Regular.ttf',
  }
};

function mm2pt(mm) {
  return mm / 25.4 * 72;
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logo').src = `data:image/svg+xml;base64,${btoa(logo)}`;
  const printerSelect = document.getElementById('setting-printer');
  const input = document.getElementById('scan');
  const parser = new DOMParser();
  const queue = {};

  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('settings').style.display = document.getElementById('settings').style.display === 'block' ? 'none' : 'block';
  });

  const settings = {
    printer: null,
    printDialog: false
  };

  document.getElementById('setting-print-dialog').addEventListener('change', () => {
    settings.printDialog = !settings.printDialog;
  });

  printerSelect.addEventListener('change', (e) => {
    settings.printer = printerSelect.value;
  });

  window.electronAPI.getPrinters().then(({ printers, defaultPrinter }) => {
    printers.forEach(p => printerSelect.add(new Option(p.name, p.deviceId), undefined));
    printerSelect.value = defaultPrinter.deviceId;
    settings.printer = defaultPrinter.deviceId;
    document.querySelector('#print-small').disabled = false;
    document.querySelector('#print').disabled = false;
  });

  window.electronAPI.onError((event, error) => {
    alert(`Error: ${error}`);
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
  });
  window.electronAPI.onClear((event, small) => {
    for (const [id, item] of Object.entries(queue)) {
      if (item.yaml.small && !small) {
        continue;
      } else if (!item.yaml.small && small) {
        continue;
      }

      delete queue[id];
      document.getElementById(id).remove();
    }
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
  });

  const printNow = async (small=false) => {
    if (!settings.printer) {
      return;
    }

    const content = [];

    for (const [id, item] of Object.entries(queue)) {
      if (!item.yaml) {
        continue;
      } else if (item.yaml.small && !small) {
        continue;
      } else if (!item.yaml.small && small) {
        continue;
      }

      const svg = await new Promise((resolve, reject) => QRCode.toString(id, {
        version: 1,
        margin: 0,
        type: 'svg',
        mode: 'alphanumeric',
        errorCorrectionLevel: 'Q'
      }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      }));

      content.push({
        columnGap: mm2pt(.5),
        margins: 0,
        columns: small ? [{
          svg: svg,
          width: mm2pt(10),
          margin: [mm2pt(0), mm2pt(1), mm2pt(3), mm2pt(1)],
        }, {
          width: '*',
          margin: [mm2pt(1), mm2pt(.3), mm2pt(1), mm2pt(3)],
          stack: [{
            bold: true,
            fontSize: 6,
            text: id.toUpperCase(),
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.4)]
          }, {
            text: item.title,
            fontSize: 5,
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.4)],
          }, {
            text: item.description,
            lineHeight: .8,
            fontSize: 4
          }]
        }, {
          svg: logo,
          margin: [mm2pt(0), mm2pt(1)],
          width: mm2pt(7.5)
        }] : [{
          svg: svg,
          width: mm2pt(18),
          margin: [mm2pt(0), mm2pt(3), mm2pt(3), mm2pt(3)],
        }, {
          width: '*',
          margin: [mm2pt(3), mm2pt(1.7), mm2pt(2), mm2pt(3)],
          stack: [{
            bold: true,
            fontSize: 11,
            text: id.toUpperCase(),
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.5)]
          }, {
            text: item.title,
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.5)],
          }, {
            text: item.description,
            lineHeight: .8,
            fontSize: 8
          }]
        }, {
          svg: logo,
          margin: [mm2pt(0), mm2pt(3)],
          width: mm2pt(13.45)
        }],
        pageBreak: 'before'
      });
    }

    if (content.length > 0) {
      delete content[0].pageBreak;
      const pdf = pdfMake.createPdf({
        pageSize: {
          width: small ? mm2pt(50) : mm2pt(95),
          height: small ? mm2pt(12) : mm2pt(24)
        },
        pageOrientation: 'landscape',
        pageMargins: 0,

        defaultStyle: {
          font: 'freemono',
          fontSize: 9,
        },

        content: content
      });

      pdf.getDataUrl((res) => {
        document.querySelector('iframe').style.display = 'block';
        document.querySelector('iframe').src = res;
        window.electronAPI.print(res, settings, small);
      });
    }
  };

  const queueItem = async (inventoryId) => {
    const res = await fetch(`https://wiki.temporaerhaus.de/inventar/${inventoryId}`);

    if (res.status !== 200) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const body = await res.text();
    const doc = parser.parseFromString(body, 'text/html');

    const id = inventoryId.toUpperCase();
    const title = doc.querySelector('#dokuwiki__content h1')?.innerText || '';
    const yaml = [...doc.querySelectorAll('#dokuwiki__content .code.yaml')]
      .map(e => YAML.parse(e.innerText))
      .find(e => e.inventory);

    if (id.startsWith('L-') && yaml.owner) {
      yaml.description = `Besitzer*in: ${yaml.owner}\n${yaml.description}`;
    }

    if (!queue[id]) {
      const item = document.createElement('li');
      item.id = id;

      queue[id] = {
        id: id,
        title: title,
        yaml: yaml
      };

      const bold = document.createElement('b');
      bold.style.marginRight = '1em';
      bold.innerText = id;
      if (yaml.small) {
        bold.innerText += ' 🤏';
      }

      const label = document.createElement('div');
      label.innerText = title;

      const description = document.createElement('small');
      description.innerText = yaml.description;

      const button = document.createElement('button');
      button.innerText = '🗑';
      button.addEventListener('click', () => {
        item.remove()
        delete queue[id];
      });

      item.appendChild(button);
      item.appendChild(bold);
      item.appendChild(label);
      item.appendChild(description);

      document.getElementById('queue').insertAdjacentElement('afterbegin', item);
    }
  };

  input.addEventListener('blur', () => input.focus());

  input.addEventListener('keydown', async (evt) => {
    if (evt.keyCode === 13 || evt.key === 'Enter') {
      input.disabled = true;
      evt.preventDefault();

      try {
        if (input.value === 'PRINT') {
          printNow(false);
          return;
        } else if (input.value === 'PRINT_SMALL') {
          printNow(true);
          return;
        }

        await queueItem(input.value);
      } catch (e) {
        alert(`Error: ${e.message}`);
      } finally {
        input.disabled = false;
        input.value = '';
        input.focus();
      }
    }
  });

  document.querySelector('#print').addEventListener('click', () => printNow(false));
  document.querySelector('#print-small').addEventListener('click', () => printNow(true));

  setInterval(async () => {
    const res = await fetch('https://wiki.temporaerhaus.de/inventar/print-queue?do=edit');
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const data = new FormData(doc.querySelector('form[method="post"]'));

    const lines = data.get('wikitext').split('\n');
    const items = lines.filter(e => e.startsWith('  *'));

    if (items.length === 0 || !(await window.electronAPI.isProduction())) {
      // nothing to do
      return;
    }

    data.set('wikitext', lines.filter(e => !e.startsWith('  *')).join('\n'));
    data.set('summary', 'empty queue');
    data.set('do[save]', '1');

    await fetch('https://wiki.temporaerhaus.de/inventar/print-queue?do=edit', {
      method: 'post',
      body: data
    });

    items.forEach(e => queueItem(e.slice(3).trim()));
  }, 10000);

  document.getElementById('save-exit').addEventListener('click', async () => {
    const res = await fetch('https://wiki.temporaerhaus.de/inventar/print-queue?do=edit');
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const data = new FormData(doc.querySelector('form[method="post"]'));

    data.set('wikitext', `${data.get('wikitext')}\n${Object.keys(queue).map(e => `  * ${e}`).join('\n')}`);
    data.set('summary', 'save queue');
    data.set('do[save]', '1');

    await fetch('https://wiki.temporaerhaus.de/inventar/print-queue?do=edit', {
      method: 'post',
      body: data
    });

    window.electronAPI.quit();
  });
});