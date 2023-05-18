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
  const input = document.getElementById('scan');
  const parser = new DOMParser();
  let queue = {};

  window.electronAPI.onError((event, error) => {
    alert(`Error: ${error}`);
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
  });
  window.electronAPI.onClear(() => {
    queue = {};
    document.getElementById('queue').innerHTML = '';
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
  });

  const printNow = async () => {
    const content = [];

    for (const [id, item] of Object.entries(queue)) {
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
        columns: [{
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
          width: mm2pt(95),
          height: mm2pt(24)
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
        window.electronAPI.print(res);
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
    const yaml = [...document.querySelectorAll('#dokuwiki__content .code.yaml')]
      .map(e => YAML.parse(e.innerText))
      .find(e => e.inventory);

    if (!queue[id]) {
      const item = document.createElement('li');
      queue[id] = {
        id: id,
        title: title,
        yaml: yaml
      };

      const bold = document.createElement('b');
      bold.style.marginRight = '1em';
      bold.innerText = id;

      const label = document.createElement('div');
      label.innerText = title;

      const button = document.createElement('button');
      button.innerText = '🗑';
      button.addEventListener('click', () => {
        item.remove()
        delete queue[id];
      });

      item.appendChild(button);
      item.appendChild(bold);
      item.appendChild(label);

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
          printNow();
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

  document.querySelector('#print').addEventListener('click', printNow);

  setInterval(async () => {
    const res = await fetch('https://wiki.temporaerhaus.de/inventar/print-queue?do=edit');
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const data = new FormData(doc.querySelector('form[method="post"]'));

    const lines = data.get('wikitext').split('\n');
    const items = lines.filter(e => e.startsWith('  *'));

    if (items.length === 0) {
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
});