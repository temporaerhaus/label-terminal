import './index.css';
import YAML from 'yaml';

import QRCode from 'qrcode';
import logo from './logo.svg';
import pdfMake from 'pdfmake/build/pdfmake';
import { CONTENTS_REGEX, collectContents, contentsDocument, fetchInventoryItem } from './contents-list';
import { MAX_COPIES, changeQueue, clampCount, putQueue, readQueue, sameEntry } from './print-queue';
import { SIGN_REGEX, signDocument } from './sign';

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
  // id => item; an item from the wiki's queue lists the entries there it came
  // from in wiki, they stay on that queue until the item is printed
  const queue = {};
  const saveQueue = () => localStorage.setItem('queue', JSON.stringify(queue));
  // format => ids of the items in the print job of that format, which are the
  // ones to clear once it is printed, not whatever was queued meanwhile
  const printedIds = {};
  const removeItem = (id) => {
    delete queue[id];
    document.getElementById(id)?.remove();
  };
  // the number of labels of an item, as shown in its entry
  const showCount = (id) => {
    const copies = document.getElementById(id)?.querySelector('.copies');
    if (!copies) {
      return;
    }

    const count = queue[id]?.count || 1;
    copies.querySelector('input').value = count;
    copies.querySelector('.less').disabled = count <= 1;
    copies.querySelector('.more').disabled = count >= MAX_COPIES;
  };

  // changes to the wiki's queue, [{entry, count}], a count of 0 takes the entry
  // off it: printed or removed here, or a count changed here; kept until they
  // are saved, the lock may be taken, the wiki unreachable
  let wikiChanges = [];
  try {
    wikiChanges = JSON.parse(localStorage.getItem('wikiChanges')) || [];
    // left by the version before counts
    wikiChanges.push(...(JSON.parse(localStorage.getItem('removals')) || []).map(entry => ({ entry, count: 0 })));
    localStorage.removeItem('removals');
  } catch {
    // ignore
  }
  const changeWiki = async (changes, { wait = false } = {}) => {
    // a later change of an entry replaces an earlier one
    wikiChanges = [...wikiChanges.filter(e => !changes.some(c => sameEntry(c.entry, e.entry))), ...changes];
    localStorage.setItem('wikiChanges', JSON.stringify(wikiChanges));

    const pending = [...wikiChanges];
    if (await changeQueue(pending, { wait })) {
      wikiChanges = wikiChanges.filter(e => !pending.includes(e));
      localStorage.setItem('wikiChanges', JSON.stringify(wikiChanges));
    }
  };

  // shown from a click on a print button until the print is done
  const loader = document.getElementById('printing');
  // if the print never comes back, e.g. because the pdf could not be created
  const PRINT_TIMEOUT = 2 * 60 * 1000;
  let printing = null;
  // the print job to send once this one is done, see printA4
  let printNext = null;
  const printDone = () => {
    clearTimeout(printing);
    printing = null;
    loader.hidden = true;

    const next = printNext;
    printNext = null;
    if (next) {
      setTimeout(() => printNow(next));
    }
  };

  // resolves with the value of the button it was closed with, '' for escape
  const cAlert = (msg, { title = '⚠️ Fehler', cancel = false } = {}) => new Promise((resolve) => {
    document.getElementById('dialog').addEventListener('close', (e) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => input.focus()));
      resolve(e.target.returnValue);
    }, { once: true });
    document.getElementById('dialog-title').innerText = title;
    document.getElementById('dialog-cancel').hidden = !cancel;
    document.getElementById('dialog').returnValue = '';
    document.getElementById('dialog-message').innerText = msg;
    document.getElementById('dialog').showModal();
  });
  const cConfirm = async (msg) => (await cAlert(msg, { title: '⚠️ Hinweis', cancel: true })) === 'ok';

  // The running version and what the updater is doing, in the settings, where
  // an update can be looked for; a downloaded one asks for the restart, once by
  // itself, and after every look that was asked for
  const updateStatus = document.getElementById('update-status');
  const updateRestart = document.getElementById('update-restart');
  let updateRequested = false;
  let updatePrompted = false;
  const timeOf = (time) => new Date(time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const confirmRestart = async () => {
    if ((await cAlert('Ein Update wurde heruntergeladen.\n\nJetzt neu starten, um es zu installieren?', { title: '🔄 Update', cancel: true })) === 'ok') {
      window.electronAPI.restartToUpdate();
    }
  };
  const showUpdate = async (state) => {
    const text = {
      checking: 'sucht nach Updates …',
      downloading: 'Update wird geladen …',
      'up-to-date': state.checked ? `aktuell, zuletzt geprüft ${timeOf(state.checked)}` : 'aktuell',
      downloaded: 'Update geladen, Neustart nötig',
      error: `Update-Fehler: ${state.error}`,
      unsupported: 'Entwicklungsversion, ohne Updates'
    }[state.status];
    updateStatus.innerText = `Version ${state.version}${text ? ` · ${text}` : ''}`;
    updateRestart.hidden = state.status !== 'downloaded';

    // not over a dialog that is open already, the restart button is there
    if (document.getElementById('dialog').open) {
      return;
    }
    if (state.status === 'downloaded' && (updateRequested || !updatePrompted)) {
      updateRequested = false;
      updatePrompted = true;
      await confirmRestart();
    } else if (updateRequested && ['up-to-date', 'error', 'unsupported'].includes(state.status)) {
      updateRequested = false;
      await cAlert({
        'up-to-date': 'Keine neuen Updates verfügbar.',
        error: `Nach Updates suchen hat nicht geklappt: ${state.error}`,
        unsupported: 'Updates gibt es nur für das installierte Terminal.'
      }[state.status], { title: state.status === 'error' ? '⚠️ Fehler' : '🔄 Update' });
    }
  };
  window.electronAPI.onUpdateStatus((event, state) => showUpdate(state));
  window.electronAPI.getUpdateStatus().then(state => showUpdate(state));
  document.getElementById('update-check').addEventListener('click', async () => {
    updateRequested = true;
    // the answer comes as a status; one that is there already is shown right away
    const state = await window.electronAPI.checkForUpdates();
    if (['downloaded', 'unsupported'].includes(state.status)) {
      await showUpdate(state);
    }
  });
  updateRestart.addEventListener('click', () => confirmRestart());

  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('settings').style.display = document.getElementById('settings').style.display === 'block' ? 'none' : 'block';
  });

  const settings = {
    printer: null,
    // contents lists go to a regular printer, not the label printer
    printerA4: null,
    printDialog: false
  };

  // labels come in two sizes, contents lists ('a4') and large labels ('sign')
  // are A4 pages
  const formatOf = (item) => item.contents ? 'a4' : item.sign ? 'sign' : item.yaml?.small ? 'small' : 'large';

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
  window.electronAPI.onPrintDone(() => printDone());
  window.electronAPI.onClear((event, format) => {
    const undo = [];
    const printed = [];
    for (const id of printedIds[format] || []) {
      const item = queue[id];
      if (!item) {
        continue;
      }

      removeItem(id);
      undo.push({ id, count: item.count || 1 });
      printed.push(...(item.wiki || []));
    }
    document.querySelector('iframe').src = '';
    document.querySelector('iframe').style.display = 'none';
    saveQueue();
    localStorage.setItem('undo', JSON.stringify(undo));

    // only now are they off the wiki's queue
    changeWiki(printed.map(entry => ({ entry, count: 0 }))).catch(e => console.log(e));
  });

  // the main process reports back with printDone once the print is through
  const showAndPrint = (pdf, printSettings, format) => {
    pdf.getDataUrl((res) => {
      document.querySelector('iframe').style.display = 'block';
      document.querySelector('iframe').src = res;
      window.electronAPI.print(res, printSettings, format);
    });
    return true;
  };

  // all queued contents lists in one print job, on the A4 printer
  const printContents = async () => {
    if (!settings.printerA4) {
      return false;
    }

    const items = Object.values(queue).filter(e => formatOf(e) === 'a4');
    if (items.length === 0) {
      return false;
    }

    const lists = items.map(e => e.contents);
    printedIds.a4 = items.map(e => e.id);
    return showAndPrint(pdfMake.createPdf(await contentsDocument(lists)), { ...settings, printer: settings.printerA4 }, 'a4');
  };

  // all queued large labels in one print job, on the A4 printer as well; a job
  // of their own, as they fill the whole page, the lists' margins and all
  const printSigns = async () => {
    if (!settings.printerA4) {
      return false;
    }

    const items = Object.values(queue).filter(e => formatOf(e) === 'sign');
    if (items.length === 0) {
      return false;
    }

    printedIds.sign = items.map(e => e.id);
    return showAndPrint(pdfMake.createPdf(await signDocument(items.map(e => e.sign), logo)), { ...settings, printer: settings.printerA4 }, 'sign');
  };

  // what goes to the A4 printer: the contents lists, then the large labels
  const printA4 = () => {
    if (printing) {
      return;
    }

    const has = (format) => Object.values(queue).some(e => formatOf(e) === format);
    if (has('a4')) {
      printNext = has('sign') ? 'sign' : null;
      printNow('a4');
    } else {
      printNow('sign');
    }
  };

  // The label printer cuts the tape off about a centimetre after the last label
  // of a print job, which is wasted. With a single label that is as much tape
  // again as the label itself, so it may be worth waiting for more.
  const confirmSingleLabel = async (format) => {
    const labels = Object.values(queue)
      .filter(e => e.yaml && formatOf(e) === format)
      .reduce((sum, e) => sum + (e.count || 1), 0);
    return labels !== 1 || await cConfirm(
      'Es wird nur ein einzelner Aufkleber gedruckt.\n\n' +
      'Der Drucker schneidet nach jedem Druckauftrag etwa 1 cm leeres Band ab, das verloren geht. ' +
      'Es spart Band, mehrere Aufkleber auf einmal zu drucken.\n\n' +
      'Trotzdem jetzt drucken?'
    );
  };

  const printNow = async (format='large') => {
    if (printing) {
      return;
    }
    if ((format === 'large' || format === 'small') && !(await confirmSingleLabel(format))) {
      return;
    }

    printing = setTimeout(printDone, PRINT_TIMEOUT);
    loader.hidden = false;
    try {
      if (!(await (format === 'a4' ? printContents() : format === 'sign' ? printSigns() : printLabels(format)))) {
        // nothing to print
        printDone();
      }
    } catch (e) {
      printDone();
      await cAlert(e.message);
    }
  };

  // returns whether a print job went out
  const printLabels = async (format) => {
    if (!settings.printer) {
      return false;
    }

    const small = format === 'small';
    const content = [];
    const ids = [];

    for (const [id, item] of Object.entries(queue)) {
      if (!item.yaml || formatOf(item) !== format) {
        continue;
      }
      ids.push(id);

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

      // the same label again, as often as asked for
      for (let copy = 1; copy < (item.count || 1); copy++) {
        content.push(structuredClone(content[content.length - 1]));
      }
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

      printedIds[format] = ids;
      return showAndPrint(pdf, settings, format);
    }

    return false;
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

  // "schild:39C3", an A4 page of large labels of an item (see sign.js)
  const fetchSign = async (entry) => {
    const inventoryId = SIGN_REGEX.exec(entry)[1].toUpperCase();
    const { title, description } = await fetchLabel(inventoryId);
    return {
      // the queue entry itself, as for contents lists
      id: `schild:${inventoryId}`,
      title,
      description: 'Große Aufkleber, 4 auf einer A4-Seite',
      sign: { inventoryId, title, description }
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
      yaml.description = `Eigentümer*in: ${yaml.owner}\n${yaml.description}`;
    }

    if (yaml.serial) {
      yaml.description = `S/N: ${yaml.serial}\n${yaml.description}`;
    }

    return { id, title, description: yaml.description, yaml };
  };

  // wiki: the entries of the wiki's queue the item comes from, see queue;
  // count: how many labels to print, unless the item is queued already
  const queueItem = async (entry, { wiki = [], count = 1 } = {}) => {
    const { id, title, description: text, yaml, contents, sign } = CONTENTS_REGEX.test(entry) ?
      await fetchContents(entry) :
      SIGN_REGEX.test(entry) ? await fetchSign(entry) : await fetchLabel(entry);
    count = clampCount(queue[id]?.count ?? count);

    const item = document.createElement('li');
    item.id = id;

    const bold = document.createElement('b');
    bold.style.marginRight = '1em';
    bold.innerText = contents ? contents.inventoryId : sign ? sign.inventoryId : id;
    if (contents) {
      bold.innerText += ' 📄';
    } else if (sign) {
      bold.innerText += ' 🪧';
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
      // otherwise the next look at the wiki's queue brings it back
      const entries = queue[id]?.wiki || [];
      item.remove()
      delete queue[id];
      saveQueue();
      changeWiki(entries.map(entry => ({ entry, count: 0 }))).catch(e => cAlert(e.message));
      input.focus();
    });

    // how many labels to print, also changed in the wiki for an item from there
    const copies = document.createElement('span');
    copies.className = 'copies';
    copies.title = 'Anzahl Aufkleber';
    const less = document.createElement('button');
    less.className = 'less';
    less.innerText = '−';
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = 1;
    amount.max = MAX_COPIES;
    const more = document.createElement('button');
    more.className = 'more';
    more.innerText = '+';
    copies.append(less, amount, more);

    const setCount = (value) => {
      const queued = queue[id];
      if (!queued) {
        return;
      }

      queued.count = clampCount(value);
      saveQueue();
      showCount(id);
      if (queued.wiki?.length > 0) {
        changeWiki(queued.wiki.map(entry => ({ entry, count: queued.count }))).catch(e => cAlert(e.message));
      }
    };
    less.addEventListener('click', () => setCount((queue[id]?.count || 1) - 1));
    more.addEventListener('click', () => setCount((queue[id]?.count || 1) + 1));
    amount.addEventListener('change', () => setCount(amount.value));

    const refresh = document.createElement('button');
    refresh.innerText = '🔄️';
    refresh.className = 'refresh';
    refresh.addEventListener('click', () => queueItem(id));

    item.appendChild(refresh);
    item.appendChild(button);
    if (!contents && !sign) {
      item.appendChild(copies);
    }
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

    // a refresh, or a scan of something that is queued in the wiki as well
    wiki = [...(queue[id]?.wiki || []), ...wiki];
    queue[id] = contents ? {
      id: id,
      title: title,
      contents: contents,
      wiki
    } : sign ? {
      id: id,
      title: title,
      sign: sign,
      wiki
    } : {
      id: id,
      title: title,
      yaml: yaml,
      count,
      wiki
    };
    saveQueue();
    showCount(id);
    input.focus();
  };

  try {
    const restored = JSON.parse(localStorage.getItem('queue'));
    for (const [id, item] of Object.entries(restored)) {
      await queueItem(id, { wiki: item.wiki || [], count: item.count || 1 });
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
          printA4();
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
  document.querySelector('#print-a4').addEventListener('click', () => printA4());

  // one look at the queue at a time, a slow wiki must not lead to overlapping ones
  let polling = false;
  // contents lists from the wiki's queue are printed right away, without a click on
  // print, once a running print is done and the A4 printer is known
  let contentsPending = false;
  // entries of the wiki's queue that could not be loaded, until the next start
  const failedEntries = [];
  setInterval(async () => {
    if (polling || !(await window.electronAPI.isProduction())) {
      return;
    }

    polling = true;
    try {
      // what could not be saved to the queue before
      if (wikiChanges.length > 0) {
        await changeWiki([]);
      }

      const entries = await readQueue();
      const names = entries.map(e => e.entry);
      const has = (list, entry) => list.some(e => sameEntry(e, entry));

      // entries removed from the queue in the wiki go here too, and so do the
      // counts changed there, unless one changed here is still to be saved
      for (const [id, item] of Object.entries(queue)) {
        if (item.wiki?.length > 0) {
          item.wiki = item.wiki.filter(e => has(names, e));
          if (item.wiki.length === 0) {
            removeItem(id);
          } else if (!item.wiki.some(e => has(wikiChanges.map(c => c.entry), e))) {
            item.count = Math.max(...entries.filter(e => has(item.wiki, e.entry)).map(e => e.count));
            showCount(id);
          }
        }
      }
      saveQueue();

      const removed = wikiChanges.filter(e => e.count === 0).map(e => e.entry);
      const known = [...Object.values(queue).flatMap(e => e.wiki || []), ...removed, ...failedEntries];
      const added = entries.filter((e, i) => !has(known, e.entry) && !has(names.slice(0, i), e.entry));
      const results = await Promise.allSettled(added.map(e => queueItem(e.entry, { wiki: [e.entry], count: e.count })));
      if (results.some((e, i) => e.status === 'fulfilled' && (CONTENTS_REGEX.test(added[i].entry) || SIGN_REGEX.test(added[i].entry)))) {
        contentsPending = true;
      }
      if (contentsPending && !printing && settings.printerA4) {
        contentsPending = false;
        printA4();
      }

      // they stay on the wiki's queue, and are only reported once
      const failed = results.map((e, i) => e.status === 'rejected' ? added[i].entry : null).filter(e => e);
      failedEntries.push(...failed);
      if (failed.length > 0) {
        await cAlert([
          ...results.map((e, i) => e.status === 'rejected' ? `${added[i].entry}: ${e.reason?.message}` : null).filter(e => e),
          '',
          'Diese Einträge bleiben in der Druckwarteschlange im Wiki, bis sie dort entfernt werden.'
        ].join('\n'));
      }
    } catch (e) {
      console.log(e);
    } finally {
      polling = false;
    }
  }, 10000);

  document.getElementById('save-exit').addEventListener('click', async () => {
    try {
      await changeWiki([], { wait: true });
      // what is queued in the wiki is still there, unlike what was scanned here
      await putQueue(Object.values(queue).filter(e => !e.wiki?.length).map(e => ({ entry: e.id, count: e.count || 1 })));
    } catch (e) {
      await cAlert(e.message);
      return;
    }

    window.electronAPI.quit();
  });

  document.getElementById('undo').addEventListener('click', async () => {
    try {
      // just ids from the version before counts
      const items = JSON.parse(localStorage.getItem('undo'));
      for (const item of items) {
        await queueItem(item.id ?? item, { count: item.count || 1 });
      }
    } catch (e) {
      await cAlert(e.message);
    }
  });
});