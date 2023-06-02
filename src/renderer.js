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

function textMaxWidth(content) {
  return new Promise((resolve) => pdfMake.createPdf({
    defaultStyle: { font: 'freemono' },
    content: [{text: content, noWrap: true }],
    pageMargins: [0, 0, 0, 0],
  }).getStream({}, d => resolve(d.x)));
}

async function truncateText(text, options) {
  const { maxWidth, fontSize } = options;
  const { length } = text;
  let b = length;
  const trunc = (len) => {
    len = Math.max(Math.round(len, 0), 1);
    return len < length ? `${text.slice(0, len - 1)}…` : text;
  };
  const f = async (len) => (await textMaxWidth({ text: trunc(len), fontSize, })) - maxWidth;
  let bx = await f(b);
  if (bx > 0) {
    let a = 0, ax = await f(0);
    if (ax >= 0) {
      return '…';
    }
    if (Math.abs(ax) < Math.abs(bx)) {
      [a, ax, b, bx] = [b, bx, a, ax];
    }
    const xTol = 1;
    let c = a, cx = ax, mflag = true, d, maxIter = 20;
    while (maxIter-- && Math.abs(b - a) > xTol) {
      const acx = ax - cx;
      const bcx = bx - cx;
      const abx = ax - bx;
      let s = Math.abs(acx) > Number.EPSILON && Math.abs(bcx) > Number.EPSILON ?
        a * bx * cx / (abx * acx) + b * ax * cx / (-abx * bcx) + c * ax * bx / (acx * bcx) :
        b - bx * (b - a) / (bx - ax);
      if (s < (3 * a + b) / 4 || s > b || (
        mflag ?
          (Math.abs(s - b) >= Math.abs(b - c) / 2 || Math.abs(b - c) < Math.abs(2 * Number.EPSILON * Math.abs(b))) :
          (Math.abs(s - b) >= Math.abs(c - d) / 2 || Math.abs(c - d) < Math.abs(2 * Number.EPSILON * Math.abs(b)))
      )) {
        s = (a + b) / 2;
        mflag = true;
      } else {
        mflag = false;
      }

      const sx = await f(s);
      [d, c, cx] = [c, b, bx];
      if (ax * sx < 0) {
        [b, bx] = [s, sx];
      } else {
        [a, ax] = [s, sx];
      }

      if (Math.abs(ax) < Math.abs(bx)) {
        [a, ax, b, bx] = [b, bx, a, ax];
      }
    }
    return trunc(ax < bx ? a : b);
  }
  return text;
};

async function shortenDescription(text, options) {
  const output = [];
  const stack = text.split('\n');

  while (stack.length > 0 && output.length < options.maxLines) {
    let line = stack.shift();
    const tmp = await truncateText(line, options);
    const pos = tmp.indexOf('…');
    if (pos >= 0) {
      output.push(tmp.slice(0, pos));
      stack.unshift(line.slice(pos));
    } else if (tmp.length > 0) {
      output.push(tmp);
    }
  }

  return output.filter(e => e).slice(0, options.maxLines + 1).join('\n');
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('logo').src = `data:image/svg+xml;base64,${btoa(logo)}`;
  const printerSelect = document.getElementById('setting-printer');
  const input = document.getElementById('scan');
  const parser = new DOMParser();
  const queue = {};

  const cAlert = (msg) => new Promise((resolve) => {
    document.getElementById('dialog').addEventListener('close', (e) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => input.focus()));
      resolve(e.target.returnValue);
    }, { once: true });
    document.getElementById('dialog-message').innerText = msg;
    document.getElementById('dialog').showModal();
  });

  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('settings').style.display = document.getElementById('settings').style.display === 'block' ? 'none' : 'block';
  });

  const settings = {
    printer: null,
    printDialog: false
  };

  document.getElementById('setting-print-dialog').addEventListener('change', () => {
    settings.printDialog = !settings.printDialog;
    localStorage.setItem('settings', JSON.stringify(settings));
  });

  printerSelect.addEventListener('change', (e) => {
    settings.printer = printerSelect.value;
    localStorage.setItem('settings', JSON.stringify(settings));
  });

  window.electronAPI.getPrinters().then(({ printers, defaultPrinter }) => {
    printers.forEach(p => printerSelect.add(new Option(p.name, p.deviceId), undefined));
    printerSelect.value = defaultPrinter.deviceId;
    settings.printer = defaultPrinter.deviceId;

    try {
      const restored = JSON.parse(localStorage.getItem('settings'));
      Object.assign(settings, restored);

      printerSelect.value = settings.printer;
      document.getElementById('setting-print-dialog').checked = settings.printDialog;
    } catch {
      // ignore
    }

    document.querySelector('#settings-toggle').disabled = false;
    document.querySelector('#print-small').disabled = false;
    document.querySelector('#print').disabled = false;
  });

  window.electronAPI.onError(async (event, error) => {
    await cAlert(error);
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => input.focus()));
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
    localStorage.setItem('queue', JSON.stringify(queue));
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
            fontSize: 7,
            text: id.toUpperCase(),
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.1)]
          }, {
            text: await truncateText(item.title, { fontSize: 6, maxWidth: mm2pt(50 - 10 - 7.5 - 3) }),
            fontSize: 6,
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.1)],
          }, {
            text: await shortenDescription(item.yaml?.description || '', { fontSize: 6, maxWidth: mm2pt(50 - 10 - 7.5 - 3), maxLines: 2 }),
            lineHeight: .8,
            fontSize: 6
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
            fontSize: 9,
            text: await truncateText(item.title, { fontSize: 9, maxWidth: mm2pt(90 - 18 - 13.45 - 2) }),
            margin: [mm2pt(0), mm2pt(0), mm2pt(0), mm2pt(.5)],
          }, {
            text: await shortenDescription(item.yaml?.description || '', { fontSize: 8, maxWidth: mm2pt(90 - 18 - 13.45 - 2), maxLines: 3 }),
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

    if (yaml.serial) {
      yaml.description = `S/N: ${yaml.serial}\n${yaml.description}`;
    }

    const item = document.createElement('li');
    item.id = id;

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

    const refresh = document.createElement('button');
    refresh.innerText = '🔄️';
    refresh.className = 'refresh';
    refresh.addEventListener('click', () => queueItem(id));

    item.appendChild(refresh);
    item.appendChild(button);
    item.appendChild(bold);
    item.appendChild(label);
    item.appendChild(description);

    const tmp = document.getElementById(id);
    if (!tmp || !queue[id]) {
      document.getElementById('queue').insertAdjacentElement('afterbegin', item);
    } else {
      tmp.id = 'deleting';
      tmp.insertAdjacentElement('beforebegin', item);
      tmp.remove();
    }

    queue[id] = {
      id: id,
      title: title,
      yaml: yaml
    };
    localStorage.setItem('queue', JSON.stringify(queue));
  };

  try {
    const restored = JSON.parse(localStorage.getItem('queue'));
    for (const id of Object.keys(restored)) {
      await queueItem(id);
    }
  } catch {
    // ignore
  }

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
        await cAlert(e.message);
      } finally {
        input.disabled = false;
        input.value = '';

        window.requestAnimationFrame(() => window.requestAnimationFrame(() => input.focus()));
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