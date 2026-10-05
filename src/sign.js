// An A4 page of large labels for a container, e.g. one for each side of a
// pallet: four of them, two by two on a landscape page, with dashed lines to
// cut along. Each has the QR code, the inventory number as large as it fits
// and the logo in a row, and below them the title and the description over the
// full width, wrapped between words. Queued as "schild:V-XX123456". The wiki
// (inventory-wiki repository, src/utils/sign.js) lays them out the same way;
// keep the two in step.
import QRCode from 'qrcode';

export const SIGN_REGEX = /^schild:([^:\s]+)$/i;

const mm2pt = (mm) => mm / 25.4 * 72;

// The font, Roboto Mono, has every glyph 1229/2048 em wide; so this is what
// measuring the text in the pdf comes to.
const ADVANCE = 1229 / 2048;
const monoWidth = (text, fontSize) => [...text].length * fontSize * ADVANCE;

// A4 landscape, in mm, in 2 × 2 cells, with space around each label
const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const COLUMNS = 2;
const ROWS = 2;
const CELL_WIDTH = PAGE_WIDTH / COLUMNS;
const CELL_HEIGHT = PAGE_HEIGHT / ROWS;
const PADDING = 8;
const WIDTH = CELL_WIDTH - 2 * PADDING;
const HEIGHT = CELL_HEIGHT - 2 * PADDING;

// the first row: QR code and logo (240 × 320) as high as the row, the number
// between them
const ROW_HEIGHT = 34;
const LOGO_WIDTH = ROW_HEIGHT * 240 / 320;
const GAP = 4;
const NUMBER_WIDTH = WIDTH - ROW_HEIGHT - LOGO_WIDTH - 2 * GAP;
const NUMBER_MAX_SIZE = 48;
// of Roboto Mono (regular and bold), ascender to descender, in em
const LINE_HEIGHT = (2146 + 555) / 2048;

// below it, over the full width: the title in up to two lines, the description
// in what is left of the height
const TITLE = { fontSize: 22, maxWidth: mm2pt(WIDTH), maxLines: 2, lineHeight: .95 };
const TITLE_SPACE = 1.5;
const DESCRIPTION = { fontSize: 13, maxWidth: mm2pt(WIDTH), lineHeight: .9 };
const lineMm = ({ fontSize, lineHeight }) => fontSize * LINE_HEIGHT * lineHeight / 72 * 25.4;

// The lines of text, at most maxLines of them, broken between words (within a
// word only if it is longer than a line), the last one ending in an ellipsis
// if text is cut; empty lines are left out, as on the label. Every glyph of
// the font is as wide as any other, so this is what fits.
export function wrapText(text, { fontSize, maxWidth, maxLines }) {
  const perLine = Math.floor(maxWidth / monoWidth('x', fontSize));
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = [];
    for (const word of paragraph.split(/\s+/).filter(Boolean).map(e => [...e])) {
      let rest = word;
      while (rest.length > 0) {
        const candidate = line.length > 0 ? [...line, ' ', ...rest] : rest;
        if (candidate.length <= perLine) {
          line = candidate;
          rest = [];
        } else if (line.length > 0) {
          lines.push(line);
          line = [];
        } else {
          lines.push(rest.slice(0, perLine));
          rest = rest.slice(perLine);
        }
      }
    }
    if (line.length > 0) {
      lines.push(line);
    }
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = [...(last.length < perLine ? last : last.slice(0, perLine - 1)), '…'];
  }
  return lines.map(e => e.join('')).join('\n');
}

// the largest font size the inventory number fits the row in with
export const numberFontSize = (id) => Math.min(NUMBER_MAX_SIZE, mm2pt(NUMBER_WIDTH) / monoWidth(id, 1));

// the nodes of one page: the labels and the lines between them, all placed
// absolutely
export function signPage({ id, title, description, qrCode, logo }) {
  const number = id.toUpperCase();
  const numberSize = numberFontSize(number);
  const titleText = wrapText(title || '', TITLE);
  const titleLines = titleText ? titleText.split('\n').length : 0;
  const descriptionLines = Math.max(1, Math.floor(
    (HEIGHT - ROW_HEIGHT - GAP - titleLines * lineMm(TITLE) - TITLE_SPACE) / lineMm(DESCRIPTION)
  ));

  const label = (column, row) => ({
    absolutePosition: {
      x: mm2pt(CELL_WIDTH * column + PADDING),
      y: mm2pt(CELL_HEIGHT * row + PADDING)
    },
    columns: [{
      width: mm2pt(WIDTH),
      stack: [{
        columnGap: mm2pt(GAP),
        columns: [{
          svg: qrCode,
          width: mm2pt(ROW_HEIGHT)
        }, {
          width: mm2pt(NUMBER_WIDTH),
          text: number,
          bold: true,
          fontSize: numberSize,
          noWrap: true,
          // in the middle of the row
          margin: [0, (mm2pt(ROW_HEIGHT) - numberSize * LINE_HEIGHT) / 2, 0, 0]
        }, {
          svg: logo,
          width: mm2pt(LOGO_WIDTH)
        }]
      }, {
        text: titleText,
        fontSize: TITLE.fontSize,
        lineHeight: TITLE.lineHeight,
        margin: [0, mm2pt(GAP), 0, mm2pt(TITLE_SPACE)]
      }, {
        text: wrapText(description || '', { ...DESCRIPTION, maxLines: descriptionLines }),
        fontSize: DESCRIPTION.fontSize,
        lineHeight: DESCRIPTION.lineHeight
      }]
    }]
  });

  const cut = (x1, y1, x2, y2) => ({
    absolutePosition: { x: 0, y: 0 },
    canvas: [{
      type: 'line',
      x1: mm2pt(x1),
      y1: mm2pt(y1),
      x2: mm2pt(x2),
      y2: mm2pt(y2),
      lineWidth: .5,
      lineColor: '#bbbbbb',
      dash: { length: 4, space: 4 }
    }]
  });

  return [
    cut(CELL_WIDTH, 0, CELL_WIDTH, PAGE_HEIGHT),
    cut(0, CELL_HEIGHT, PAGE_WIDTH, CELL_HEIGHT),
    ...Array.from({ length: COLUMNS * ROWS }, (_, i) => label(i % COLUMNS, Math.floor(i / COLUMNS)))
  ];
}

// the nodes of one page for a queued sign: {inventoryId, title, description},
// the description as printed, with serial number and owner
export async function signPageFor({ inventoryId, title, description }, logo) {
  const qrCode = await QRCode.toString(inventoryId.toUpperCase(), {
    version: 1,
    margin: 0,
    type: 'svg',
    mode: 'alphanumeric',
    errorCorrectionLevel: 'Q'
  });
  return signPage({ id: inventoryId, title, description, qrCode, logo });
}

// a document of large labels, a page per sign
export async function signDocument(signs, logo) {
  const content = [];
  for (const sign of signs) {
    if (content.length > 0) {
      content.push({ text: '', pageBreak: 'before' });
    }
    content.push(...await signPageFor(sign, logo));
  }

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: 0,
    info: { title: `Große Aufkleber ${signs.map(e => e.inventoryId).join(', ')}` },
    defaultStyle: { font: 'freemono', fontSize: 9 },
    content
  };
}
