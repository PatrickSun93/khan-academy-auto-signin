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

// onMessage only receives messages from this extension's own scripts; web pages can't send here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'getConfig') return false;
  loadConfig().then(sendResponse);
  return true; // keeps the channel open for the async sendResponse
});
