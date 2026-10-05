// The print queue page, shared with the inventory wiki (src/utils/api.js there).
//
// Reading goes through do=export_raw: opening the editor makes dokuwiki lock the
// page for 15 minutes, and without a save afterwards nobody else can save it
// through the API until then. The editor is only opened to save right away,
// which also releases its lock again.
//
// Changing the queue happens under the wiki's own lock, the content of the lock
// page ("<token>/<date>"), so that no entry added by the wiki in the meantime is lost.
const WIKI = 'https://wiki.temporaerhaus.de';
const QUEUE_PAGE = 'inventar/print-queue';
const LOCK_PAGE = 'inventar/lock';

// a lock older than this counts as stale, the same as in the wiki
const LOCK_TIMEOUT = 10 * 1000;

async function readPage(page) {
  const res = await fetch(`${WIKI}/${page}?do=export_raw`, { cache: 'no-store' });

  // the lock date is the wiki's time, not ours
  const date = new Date(res.headers.get('Date'));
  const now = isNaN(date) ? new Date() : date;

  // dokuwiki deletes a page that is saved empty, which is what releasing the
  // lock does (and emptying a queue without anything else on its page)
  if (res.status === 404) {
    return { text: '', now };
  }
  if (res.status !== 200) {
    throw new Error(`${page}: ${res.status} ${res.statusText}`);
  }
  // without a login the wiki redirects to its login page
  if (res.redirected || !res.headers.get('Content-Type')?.startsWith('text/plain')) {
    throw new Error(`${page} kann nicht gelesen werden, ist das Terminal im Wiki angemeldet?`);
  }

  return {
    text: (await res.text()).replaceAll('\r\n', '\n'),
    now
  };
}

async function savePage(page, update, summary) {
  const res = await fetch(`${WIKI}/${page}?do=edit`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const form = doc.querySelector('form#dw__editform') || doc.querySelector('form[method="post"]');
  if (!form) {
    throw new Error(`${page} kann nicht bearbeitet werden`);
  }

  const data = new FormData(form);
  data.set('wikitext', update(String(data.get('wikitext') || '').replaceAll('\r\n', '\n')));
  data.set('summary', summary);
  data.set('do[save]', '1');
  await fetch(`${WIKI}/${page}?do=edit`, { method: 'post', body: data });
}

// null if somebody else holds the lock right now
async function acquireLock() {
  const { text, now } = await readPage(LOCK_PAGE);
  const lockDate = new Date(text.trim().split('/').pop());
  if (text.trim() && !isNaN(lockDate) && (now - lockDate) < LOCK_TIMEOUT) {
    return null;
  }

  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await savePage(LOCK_PAGE, () => `${token}/${now.toUTCString()}`, 'lock');

  // somebody else may have been faster
  return (await readPage(LOCK_PAGE)).text.trim().split('/')[0] === token ? token : null;
}

async function releaseLock(token) {
  if ((await readPage(LOCK_PAGE)).text.trim().split('/')[0] === token) {
    await savePage(LOCK_PAGE, () => '', 'release');
  }
}

async function withLock(fn, { wait = false } = {}) {
  let token = await acquireLock();
  while (!token && wait) {
    await new Promise(resolve => setTimeout(resolve, Math.round(Math.random() * LOCK_TIMEOUT)));
    token = await acquireLock();
  }
  if (!token) {
    return null;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(token);
  }
}

// An entry is a "  * <entry>" line, an inventory number or
// "inhaltsliste:<number>[:<levels>]", followed by " x <count>" for more than
// one label; the wiki reads and writes them the same way (src/utils/api.js).
export const MAX_COPIES = 5;
const COUNT_REGEX = /^(.*?)\s+x\s*([0-9]+)$/i;
const isEntry = (line) => line.startsWith('  *');
export const sameEntry = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const clampCount = (count) => Math.min(MAX_COPIES, Math.max(1, Math.round(Number(count)) || 1));
const entryLine = (entry, count) => `  * ${entry}${count > 1 ? ` x ${count}` : ''}`;

const parseLine = (line) => {
  const text = line.slice(3).trim();
  const match = COUNT_REGEX.exec(text);
  return match ? { entry: match[1].trim(), count: clampCount(match[2]) } : { entry: text, count: 1 };
};

// [{entry, count}] on the queue, in its order, an entry queued more than once
// with the most labels any of its lines asks for. They stay there until they
// are printed (or removed in the wiki), so that the queue can be seen and
// edited in the wiki meanwhile.
export async function readQueue() {
  const entries = [];
  for (const { entry, count } of (await readPage(QUEUE_PAGE)).text.split('\n').filter(isEntry).map(parseLine)) {
    const known = entries.find(e => sameEntry(e.entry, entry));
    if (known) {
      known.count = Math.max(known.count, count);
    } else if (entry) {
      entries.push({ entry, count });
    }
  }
  return entries;
}

// sets the counts of entries, [{entry, count}], a count of 0 takes the entry
// off the queue; whether that happened, it does not if the lock is taken right
// now and wait is not set
export async function changeQueue(changes, { wait = false } = {}) {
  if (changes.length === 0) {
    return true;
  }

  const done = await withLock(async () => {
    await savePage(QUEUE_PAGE, (text) => {
      const seen = new Set();
      return text.split('\n').flatMap((line) => {
        const change = isEntry(line) && changes.find(e => sameEntry(e.entry, parseLine(line).entry));
        if (!change) {
          return [line];
        }
        if (change.count === 0 || seen.has(change)) {
          return [];
        }
        seen.add(change);
        return [entryLine(parseLine(line).entry, clampCount(change.count))];
      }).join('\n');
    }, 'update queue');
    return true;
  }, { wait });
  return Boolean(done);
}

// [{entry, count}]
export async function putQueue(entries) {
  if (entries.length === 0) {
    return;
  }

  await withLock(
    () => savePage(QUEUE_PAGE, (text) => `${text.trimEnd()}\n${entries.map(e => entryLine(e.entry, e.count)).join('\n')}`, 'save queue'),
    { wait: true }
  );
}
