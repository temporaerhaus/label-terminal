// Contents lists of containers, printed on A4. Collecting the contents and the
// layout are copied from the inventory wiki (src/components/ContentsListComponent.vue),
// keep them in sync.
import YAML from 'yaml';
import QRCode from 'qrcode';

const WIKI = 'https://wiki.temporaerhaus.de';
const PREFIX = 'inventar';
const YAML_REGEX = /```yaml\n(.*?)\n```/s;

// print queue entries look like "inhaltsliste:39C3" or "inhaltsliste:39C3:2",
// the number being how many levels of sub containers to list the contents of
export const CONTENTS_REGEX = /^inhaltsliste:([^:\s]+)(?::(\d+))?$/i;

// "all levels" still stops here, to deal with potential circular links
const MAX_DEPTH = 10;

function mm2pt(mm) {
  return mm / 25.4 * 72;
}

async function rpc(method, params = {}) {
  const res = await fetch(`${WIKI}/lib/exe/jsonrpc.php/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${method}: HTTP ${res.status}`);
  }

  if (body.error?.code) {
    throw new Error(body.error.message);
  }

  return body.result;
}

async function searchItems(query) {
  return (await rpc('core.searchPages', { query: `${query} @${PREFIX}` }))
    .map(e => e.id.split(':').pop().toUpperCase());
}

export async function fetchInventoryItem(inventoryId) {
  // a missing page comes back as the namespace template, which has no yaml block
  const wikitext = await rpc('core.getPage', { page: `${PREFIX}:${String(inventoryId).toLowerCase()}` });

  for (const [, block] of wikitext.replaceAll('\r\n', '\n').matchAll(new RegExp(YAML_REGEX.source, 'gs'))) {
    try {
      const data = YAML.parse(block);
      if (data.inventory) {
        data.title = /^# (.*)$/m.exec(wikitext)?.[1]?.trim() || '';
        return data;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// all items located in a container, depth first, contents of sub containers right below them
export async function collectContents(containerId, levels, depth = 0, seen = new Set([containerId.toUpperCase()])) {
  const ids = (await searchItems(`location: ${containerId}`)).filter(id => !seen.has(id));
  ids.forEach(id => seen.add(id));

  const items = (await Promise.all(ids.map(async (id) => ({ id, item: await fetchInventoryItem(id) }))))
    .filter(e => e.item)
    .sort((a, b) => a.id.localeCompare(b.id));

  const rows = [];
  for (const { id, item } of items) {
    rows.push({ id, title: item.title || '', description: String(item.description || ''), depth });
    if (item.container && depth < Math.min(levels, MAX_DEPTH)) {
      rows.push(...await collectContents(id, levels, depth + 1, seen));
    }
  }

  return rows;
}

// name and description of an item, one line each, cut to what fits
function titleCell(row, fit, width) {
  return { stack: [
    { text: fit(row.title, width, 8.5) },
    { text: fit(row.description.replace(/\s+/g, ' '), width, 6.5), fontSize: 6.5, color: '#555555' }
  ] };
}

// a table cannot flow from one column into the next, so the rows are split
// into columns and pages up front. For that every row has the same height:
// one line of title and one of description, cut to what fits. Roboto Mono
// is monospaced, so what fits is a matter of counting characters.
const page = { width: mm2pt(297), height: mm2pt(210) };
const margin = { side: mm2pt(12), top: mm2pt(32), bottom: mm2pt(14) };

// the pages of one contents list, each one starting on a new page
function contentsPages({ inventoryId, rows }) {
  const gap = mm2pt(8);
  const column = (page.width - 2 * margin.side - gap) / 2;
  // box: column of the boxes to tick off, boxSize: the drawn box itself,
  // boxGap: space between the box of a sub item and its inventory number
  const widths = { box: mm2pt(5), boxSize: mm2pt(3), boxGap: mm2pt(2), id: mm2pt(30) };
  const padding = 4;
  const line = .5;
  const charWidth = (fontSize) => fontSize * .6;
  const fit = (text, width, fontSize) => {
    const max = Math.floor(width / charWidth(fontSize));
    return text.length > max ? `${text.slice(0, Math.max(max - 1, 0))}…` : text;
  };

  const titleWidth = column - widths.box - widths.id - 6 * padding - 4 * line;
  const heights = { header: 12, row: 21 };
  const rowHeight = heights.row + 4 + line;
  const available = page.height - margin.top - margin.bottom - (heights.header + 4 + 2 * line + 1);
  // a few points of slack, so rounding in the layout never pushes a row onto a new page
  const rowsPerColumn = Math.max(1, Math.floor((available - 5) / rowHeight));

  const table = (rows) => ({
    table: {
      headerRows: 1,
      widths: [widths.box, widths.id, '*'],
      heights: (i) => i === 0 ? heights.header : heights.row,
      body: [
        [{ text: '' }, { text: 'Inventarnummer', bold: true }, { text: 'Gegenstand', bold: true }],
        ...rows.map(row => {
          const room = widths.id - 2 * padding;
          // the font has no ballot box glyph, so the box to tick off is drawn
          const box = { canvas: [{ type: 'rect', x: 0, y: 1, w: widths.boxSize, h: widths.boxSize, lineWidth: .7, lineColor: '#333333' }], width: widths.boxSize };

          if (row.depth === 0) {
            return [box, { text: fit(row.id, room, 8.5), bold: true }, titleCell(row, fit, titleWidth)];
          }

          // sub items carry their box in front of the inventory number, so it moves in with them:
          // on the first level the box takes up the start of the column, every further level
          // moves box and number further in, but never so far that the number has to be cut
          const numberRoom = room - widths.boxSize - widths.boxGap;
          const indent = Math.max(0, Math.min(mm2pt(5) * (row.depth - 1), numberRoom - row.id.length * charWidth(8.5)));
          return [
            { text: '' },
            {
              columns: [box, { text: fit(row.id, numberRoom - indent, 8.5), width: '*' }],
              columnGap: widths.boxGap,
              margin: [indent, 0, 0, 0]
            },
            titleCell(row, fit, titleWidth)
          ];
        })
      ]
    },
    fontSize: 8.5,
    layout: {
      hLineColor: () => '#999999',
      vLineColor: () => '#999999',
      hLineWidth: (i) => i === 1 ? 1 : line,
      vLineWidth: () => line,
      fillColor: (i) => i === 0 ? '#eeeeee' : null
    }
  });

  const pages = [];
  for (let i = 0; i < rows.length; i += 2 * rowsPerColumn) {
    pages.push([
      rows.slice(i, i + rowsPerColumn),
      rows.slice(i + rowsPerColumn, i + 2 * rowsPerColumn)
    ]);
  }

  return pages.length ? pages.map(([left, right]) => ({
    columns: [
      { width: column, ...table(left) },
      right.length ? { width: column, ...table(right) } : { width: column, text: '' }
    ],
    columnGap: gap
  })) : [{
    // unlike in the wiki there is no italic font here
    text: `Keine Gegenstände an diesem Ort (${inventoryId}).`, color: '#666666'
  }];
}

// One document for any number of contents lists, so they go out as a single
// print job. Since the rows are split into pages up front, it is known which
// pages belong to which list, which the header and footer are looked up by.
export async function contentsDocument(lists) {
  const created = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

  const sections = [];
  const content = [];
  for (const list of lists) {
    const pages = contentsPages(list);
    sections.push({
      ...list,
      first: content.length + 1,
      count: pages.length,
      qrCode: await QRCode.toString(list.inventoryId, { margin: 0, type: 'svg', errorCorrectionLevel: 'Q' })
    });
    // every list gets at least one page, even without any contents
    for (const e of pages) {
      content.push(content.length > 0 ? { ...e, pageBreak: 'before' } : e);
    }
  }
  const section = (current) => sections.findLast(e => e.first <= current);

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [margin.side, margin.top, margin.side, margin.bottom],
    info: { title: `Inhaltsliste ${lists.map(e => e.inventoryId).join(', ')}` },
    defaultStyle: { font: 'freemono', fontSize: 9 },

    header: (current) => {
      const { inventoryId, title, rows, qrCode } = section(current);
      return {
        columns: [{
          svg: qrCode,
          width: mm2pt(18)
        }, {
          width: '*',
          margin: [mm2pt(4), 0, 0, 0],
          stack: [
            { text: 'Inhaltsliste', fontSize: 8, color: '#666666' },
            { text: inventoryId, fontSize: 14, bold: true },
            { text: title || '', fontSize: 10 },
            { text: `${rows.length} ${rows.length === 1 ? 'Gegenstand' : 'Gegenstände'} · Stand ${created}`, fontSize: 7, color: '#666666' }
          ]
        }],
        margin: [margin.side, mm2pt(8), margin.side, 0]
      };
    },

    footer: (current) => {
      const { inventoryId, first, count } = section(current);
      return {
        columns: [
          { text: `${inventoryId} · Stand ${created}`, color: '#666666' },
          { text: `Seite ${current - first + 1} von ${count}`, alignment: 'right', color: '#666666' }
        ],
        fontSize: 7,
        margin: [margin.side, mm2pt(5), margin.side, 0]
      };
    },

    content
  };
}
