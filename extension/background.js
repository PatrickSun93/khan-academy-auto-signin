// Service worker: the only place that reads the credentials file.
//
// The content script asks for the config over runtime messaging instead of fetching
// config.json itself. A content script could only fetch it if config.json were listed in
// web_accessible_resources, and then any website could read the password too.

// config.json holds the real credentials and is gitignored. If it's missing we fall back to
// the committed example, which is deliberately wrong, so a fresh clone fails on its first run.
const CONFIG_FILES = ['config.json', 'config.example.json'];

async function loadConfig() {
  for (const file of CONFIG_FILES) {
    let cfg;
    try {
      const res = await fetch(chrome.runtime.getURL(file));
      cfg = await res.json();
    } catch (e) {
      continue; // file not in the package (or not valid JSON): try the next one
    }
    if (typeof cfg.username === 'string' && cfg.username && typeof cfg.password === 'string' && cfg.password) {
      return { username: cfg.username, password: cfg.password, source: file };
    }
  }
  return null;
}

// Sliding-window limit on sign-in attempts, shared by all tabs. KA locks an account for about
// an hour after "several" failed sign-ins, so a wrong config plus repeated reloads mustn't keep
// submitting. The count lives in chrome.storage, which only the extension can read or write.
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 5 * 60 * 1000;

// Two tabs could ask at the same moment. Each request waits for the previous one to finish,
// so the read-check-write below can't interleave and hand out a 4th attempt.
let queue = Promise.resolve();
function oneAtATime(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function reserveAttempt() {
  const now = Date.now();
  const { attempts = [] } = await chrome.storage.local.get('attempts');
  const recent = attempts.filter((t) => now - t < WINDOW_MS); // forget anything outside the window
  if (recent.length >= MAX_ATTEMPTS) {
    return { allowed: false, max: MAX_ATTEMPTS, windowMs: WINDOW_MS, retryInMs: WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  await chrome.storage.local.set({ attempts: recent });
  return { allowed: true };
}

// The "pending" marker: one sign-in attempt in flight, per tab. The submit can navigate from
// accounts.khanacademy.org (where KA serves the login form for many users) to www.khanacademy.org,
// and a page's sessionStorage is per origin, so the page that judges the result couldn't read a
// marker the login page wrote. The background keeps it instead, keyed by tab, in
// chrome.storage.session (memory only, cleared when the browser closes; same `storage` permission).
const PENDING_TTL_MS = 30_000; // an older marker is stale and ignored
const pendingKey = (tabId) => `pending:${tabId}`;

async function setPending(tabId) {
  const marker = { at: Date.now() };
  await chrome.storage.session.set({ [pendingKey(tabId)]: marker });
  return marker;
}

async function getPending(tabId) {
  const { [pendingKey(tabId)]: marker } = await chrome.storage.session.get(pendingKey(tabId));
  if (marker && Date.now() - marker.at < PENDING_TTL_MS) return marker;
  await chrome.storage.session.remove(pendingKey(tabId));
  return null;
}

async function clearPending(tabId) {
  await chrome.storage.session.remove(pendingKey(tabId));
  return true;
}

// onMessage only receives messages from this extension's own scripts; web pages can't send here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg?.type === 'getConfig') loadConfig().then(sendResponse);
  else if (msg?.type === 'reserveAttempt') oneAtATime(reserveAttempt).then(sendResponse);
  else if (msg?.type === 'setPending' && tabId !== undefined) setPending(tabId).then(sendResponse);
  else if (msg?.type === 'getPending' && tabId !== undefined) getPending(tabId).then(sendResponse);
  else if (msg?.type === 'clearPending' && tabId !== undefined) clearPending(tabId).then(sendResponse);
  else return false;
  return true; // keeps the channel open for the async sendResponse
});
