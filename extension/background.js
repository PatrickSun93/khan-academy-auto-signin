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

// onMessage only receives messages from this extension's own scripts; web pages can't send here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getConfig') loadConfig().then(sendResponse);
  else if (msg?.type === 'reserveAttempt') oneAtATime(reserveAttempt).then(sendResponse);
  else return false;
  return true; // keeps the channel open for the async sendResponse
});
