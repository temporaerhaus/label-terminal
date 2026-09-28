import './index.css';
import YAML from 'yaml';

import QRCode from 'qrcode';
import logo from './logo.svg';
import pdfMake from 'pdfmake/build/pdfmake';
import { CONTENTS_REGEX, collectContents, contentsDocument, fetchInventoryItem } from './contents-list';
import { putQueue, takeQueue } from './print-queue';

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
  const printerA4Select = document.getElementById('setting-printer-a4');
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
    // contents lists go to a regular printer, not the label printer
    printerA4: null,
    printDialog: false
  };

  // labels come in two sizes, contents lists are A4 pages
  const formatOf = (item) => item.contents ? 'a4' : item.yaml?.small ? 'small' : 'large';

  document.getElementById('setting-print-dialog').addEventListener('change', () => {
    settings.printDialog = !settings.printDialog;
    localStorage.setItem('settings', JSON.stringify(settings));
  });

  printerSelect.addEventListener('change', (e) => {
    settings.printer = printerSelect.value;
    localStorage.setItem('settings', JSON.stringify(settings));
  });

  printerA4Select.addEventListener('change', (e) => {
    settings.printerA4 = printerA4Select.value;
    localStorage.setItem('settings', JSON.stringify(settings));
  });

  window.electronAPI.getPrinters().then(({ printers, defaultPrinter }) => {
    printers.forEach(p => printerSelect.add(new Option(p.name, p.deviceId), undefined));
    printers.forEach(p => printerA4Select.add(new Option(p.name, p.deviceId), undefined));
    printerSelect.value = defaultPrinter.deviceId;
    printerA4Select.value = defaultPrinter.deviceId;
    settings.printer = defaultPrinter.deviceId;
    settings.printerA4 = defaultPrinter.deviceId;

    try {
      const restored = JSON.parse(localStorage.getItem('settings'));
      Object.assign(settings, restored);

      printerSelect.value = settings.printer;
      printerA4Select.value = settings.printerA4;
      document.getElementById('setting-print-dialog').checked = settings.printDialog;
    } catch {
      // ignore
    }

    document.querySelector('#settings-toggle').disabled = false;
    document.querySelector('#print-small').disabled = false;
    document.querySelector('#print').disabled = false;
    document.querySelector('#print-a4').disabled = false;
  });

  window.electronAPI.onError(async (event, error) => {
    await cAlert(error);
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => input.focus()));
  });
  window.electronAPI.onClear((event, format) => {
    const undo = [];
    for (const [id, item] of Object.entries(queue)) {
      if (formatOf(item) !== format) {
        continue;
      }

      delete queue[id];
      document.getElementById(id).remove();
      undo.push(id);
    }
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
    localStorage.setItem('queue', JSON.stringify(queue));
    localStorage.setItem('undo', JSON.stringify(undo));
  });

  const showAndPrint = (pdf, printSettings, format) => {
    pdf.getDataUrl((res) => {
      document.querySelector('iframe').style.display = 'block';
      document.querySelector('iframe').src = res;
      window.electronAPI.print(res, printSettings, format);
    });
  };

  // all queued contents lists in one print job, on the A4 printer
  const printContents = async () => {
    if (!settings.printerA4) {
      return;
    }

    const lists = Object.values(queue).filter(e => formatOf(e) === 'a4').map(e => e.contents);
    if (lists.length > 0) {
      showAndPrint(pdfMake.createPdf(await contentsDocument(lists)), { ...settings, printer: settings.printerA4 }, 'a4');
    }
  };

  const printNow = async (format='large') => {
    if (format === 'a4') {
      return printContents();
    }

    if (!settings.printer) {
      return;
    }

    const small = format === 'small';
    const content = [];

    for (const [id, item] of Object.entries(queue)) {
      if (!item.yaml || formatOf(item) !== format) {
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

      showAndPrint(pdf, settings, format);
    }
  };

  // "inhaltsliste:39C3:2", the contents of a container, two levels of sub containers deep
  const fetchContents = async (entry) => {
    const [, containerId, depth] = CONTENTS_REGEX.exec(entry);
    const inventoryId = containerId.toUpperCase();
    const levels = Number(depth || 0);
    const container = await fetchInventoryItem(inventoryId);

    if (!container) {
      throw new Error(`${inventoryId} nicht gefunden`);
    }

    const rows = await collectContents(inventoryId, levels);
    return {
      // the queue entry itself, so that it can be restored and saved back to the print queue
      id: `inhaltsliste:${inventoryId}${levels > 0 ? `:${levels}` : ''}`,
      title: container.title,
      description: `Inhaltsliste, ${rows.length} ${rows.length === 1 ? 'Gegenstand' : 'Gegenstände'}${levels > 0 ? `, Unter-Behälter ${levels} ${levels === 1 ? 'Ebene' : 'Ebenen'} tief` : ''}`,
      contents: { inventoryId, title: container.title, rows }
    };
  };

  const fetchLabel = async (inventoryId) => {
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

    return { id, title, description: yaml.description, yaml };
  };

  const queueItem = async (entry) => {
    const { id, title, description: text, yaml, contents } = CONTENTS_REGEX.test(entry) ?
      await fetchContents(entry) :
      await fetchLabel(entry);

    const item = document.createElement('li');
    item.id = id;

    const bold = document.createElement('b');
    bold.style.marginRight = '1em';
    bold.innerText = contents ? contents.inventoryId : id;
    if (contents) {
      bold.innerText += ' 📄';
    } else if (yaml.small) {
      bold.innerText += ' 🤏';
    }

    const label = document.createElement('div');
    label.innerText = title;

    const description = document.createElement('small');
    description.innerText = text;

    const button = document.createElement('button');
    button.innerText = '🗑';
    button.addEventListener('click', () => {
      item.remove()
      delete queue[id];
      localStorage.setItem('queue', JSON.stringify(queue));
      input.focus();
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

    queue[id] = contents ? {
      id: id,
      title: title,
      contents: contents
    } : {
      id: id,
      title: title,
      yaml: yaml
    };
    localStorage.setItem('queue', JSON.stringify(queue));
    input.focus();
  };

  try {
    const restored = JSON.parse(localStorage.getItem('queue'));
    for (const id of Object.keys(restored)) {
      await queueItem(id);
    }
  } catch {
    // ignore
  }

  input.addEventListener('blur', (e) => {
    if (e.relatedTarget?.tagName === 'BUTTON') {
      return;
    }
    input.focus();
  });

  input.addEventListener('keydown', async (evt) => {
    if (evt.keyCode === 13 || evt.key === 'Enter') {
      input.disabled = true;
      evt.preventDefault();

      try {
        if (input.value === 'PRINT') {
          printNow('large');
          return;
        } else if (input.value === 'PRINT_SMALL') {
          printNow('small');
          return;
        } else if (input.value === 'PRINT_A4') {
          printNow('a4');
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

  document.querySelector('#print').addEventListener('click', () => printNow('large'));
  document.querySelector('#print-small').addEventListener('click', () => printNow('small'));
  document.querySelector('#print-a4').addEventListener('click', () => printNow('a4'));

  // one look at the queue at a time, a slow wiki must not lead to overlapping ones
  let polling = false;
  setInterval(async () => {
    if (polling || !(await window.electronAPI.isProduction())) {
      return;
    }

    polling = true;
    try {
      // the entries are off the wiki's queue now, so failures have to be shown here
      const entries = await takeQueue();
      const results = await Promise.allSettled(entries.map(e => queueItem(e)));
      const failed = results.map((e, i) => e.status === 'rejected' ? `${entries[i]}: ${e.reason?.message}` : null).filter(e => e);
      if (failed.length > 0) {
        await cAlert(failed.join('\n'));
      }
    } catch (e) {
      console.log(e);
    } finally {
      polling = false;
    }
  }, 10000);

  document.getElementById('save-exit').addEventListener('click', async () => {
    try {
      await putQueue(Object.keys(queue));
    } catch (e) {
      await cAlert(e.message);
      return;
    }

    window.electronAPI.quit();
  });

  document.getElementById('undo').addEventListener('click', async () => {
    try {
      const items = JSON.parse(localStorage.getItem('undo'));
      for (const id of items) {
        await queueItem(id);
      }
    } catch (e) {
      await cAlert(e.message);
    }
  });
});