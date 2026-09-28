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
  if (res.status !== 200) {
    throw new Error(`${page}: ${res.status} ${res.statusText}`);
  }
  // without a login the wiki redirects to its login page
  if (res.redirected || !res.headers.get('Content-Type')?.startsWith('text/plain')) {
    throw new Error(`${page} kann nicht gelesen werden, ist das Terminal im Wiki angemeldet?`);
  }

  // the lock's date is the wiki's time, not ours
  const date = new Date(res.headers.get('Date'));
  return {
    text: (await res.text()).replaceAll('\r\n', '\n'),
    now: isNaN(date) ? new Date() : date
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

const isEntry = (line) => line.startsWith('  *');

// takes all entries off the queue, an empty list if there are none or the lock is taken
export async function takeQueue() {
  if (!(await readPage(QUEUE_PAGE)).text.split('\n').some(isEntry)) {
    return [];
  }

  return await withLock(async () => {
    let entries = [];
    await savePage(QUEUE_PAGE, (text) => {
      const lines = text.split('\n');
      entries = lines.filter(isEntry).map(e => e.slice(3).trim());
      return lines.filter(e => !isEntry(e)).join('\n');
    }, 'empty queue');
    return entries;
  }) || [];
}

export async function putQueue(entries) {
  if (entries.length === 0) {
    return;
  }

  await withLock(
    () => savePage(QUEUE_PAGE, (text) => `${text}\n${entries.map(e => `  * ${e}`).join('\n')}`, 'save queue'),
    { wait: true }
  );
}
