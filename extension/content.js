// Khan Academy auto sign-in: content script.
//
// It's injected on every www.khanacademy.org page, but it only acts in two situations:
//   1. The page is the login page: it signs in once per visit.
//   2. A "pending" marker from its own submit is present: it judges how that attempt turned out
//      (the submit may have navigated to another page).
// On any other page it does nothing.
//
// It reports one of these outcomes, and never claims success it can't prove:
//   failure      Khan Academy showed an error. The toast shows that text verbatim.
//   success      KA's current-user API says we're signed in as the configured account.
//   uncertain    Timed out, or the API couldn't confirm. Explicitly NOT a success.
//   needs-human  A CAPTCHA / bot check appeared. We stop and don't try to get around it.
//   info         Nothing was attempted (already signed in, no config, ...).
(() => {
  const LOG_PREFIX = '[KA auto sign-in]';
  const MARKER_KEY = 'kaAutoSignin.pending'; // lives in the page's sessionStorage (this tab only)
  const MARKER_TTL_MS = 30_000; // an older marker is treated as stale and ignored
  const FORM_TIMEOUT_MS = 10_000; // time allowed for the SPA to render the login form
  const OUTCOME_TIMEOUT_MS = 15_000; // time after submit to wait for an error or a sign-in
  const VERIFY_TIMEOUT_MS = 10_000; // time allowed for the session to show up in the API
  const POLL_MS = 250;

  // Checked against the real login page on 2026-11-04. KA's own data-testids are stabler than
  // its generated class names.
  const SEL = {
    username: '[data-testid="identifier-field"]',
    password: '[data-testid="password-field"]',
    submit: '[data-testid="log-in-submit-button"]',
    // Per-field errors are aria-live regions, and they're empty until KA has something to say.
    // [role="alert"] is there for a form-level error. TODO-RECON: confirm where the
    // "wrong password" message is rendered.
    error: '[data-testid="identifier-error"], [data-testid="password-error"], [role="alert"]',
    captcha: 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
  };

  // TODO-RECON: KA's GraphQL rejects queries that aren't on its safelist
  // (403 "Operation not found in safelist"), so this ad-hoc query won't work on the real site.
  // To be replaced once the signed-in page has been inspected (see BRIEF.md progress).
  const CURRENT_USER_URL = '/api/internal/graphql/getFullUserProfile';
  const CURRENT_USER_QUERY = 'query getFullUserProfile { user { id kaid email username isPhantom } }';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isLoginPage() {
    return location.pathname === '/login' || location.pathname.startsWith('/login/');
  }

  // ---------- reporting ----------

  function report(kind, message) {
    const line = `${LOG_PREFIX} ${kind}: ${message}`;
    if (kind === 'failure' || kind === 'needs-human') console.error(line);
    else if (kind === 'uncertain') console.warn(line);
    else console.info(line);
    showToast(kind, message);
  }

  const TOAST_COLORS = { success: '#1b7f3b', failure: '#b3261e', uncertain: '#8a5a00', 'needs-human': '#8a5a00', info: '#33415c' };

  function showToast(kind, message) {
    const host = document.createElement('div');
    host.setAttribute('data-ka-autosignin-toast', kind);
    // Shadow DOM keeps the page's CSS away from the toast, and the toast's CSS away from the page.
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.className = 'toast';
    // textContent rather than innerHTML: KA's text is displayed exactly as given and is never parsed as HTML.
    box.textContent = message;
    box.title = 'Click to dismiss';
    box.addEventListener('click', () => host.remove());
    const style = document.createElement('style');
    style.textContent = `.toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      max-width: 420px; padding: 12px 16px; border-radius: 8px; color: #fff; cursor: pointer;
      font: 14px/1.4 system-ui, sans-serif; white-space: pre-wrap; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      background: ${TOAST_COLORS[kind] || '#33415c'}; }`;
    root.append(style, box);
    document.documentElement.appendChild(host);
  }

  // ---------- "pending" marker: carries one attempt across a navigation ----------

  function readMarker() {
    try {
      const m = JSON.parse(sessionStorage.getItem(MARKER_KEY));
      if (m && typeof m.at === 'number' && Date.now() - m.at < MARKER_TTL_MS) return m;
    } catch (e) { /* storage blocked or bad JSON: treat it as no marker */ }
    clearMarker();
    return null;
  }

  function writeMarker() {
    const m = { at: Date.now() };
    try { sessionStorage.setItem(MARKER_KEY, JSON.stringify(m)); } catch (e) { /* see README limitations */ }
    return m;
  }

  function clearMarker() {
    try { sessionStorage.removeItem(MARKER_KEY); } catch (e) { /* nothing to clear */ }
  }

  // ---------- page helpers ----------

  async function waitFor(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  function errorTexts() {
    return [...document.querySelectorAll(SEL.error)]
      .map((el) => el.textContent.trim())
      .filter((t) => t.length > 0);
  }

  function setInputValue(input, value) {
    // KA's form is React. React fires onChange when the DOM value differs from the value it last
    // recorded, and it checks on the 'input' event. So: set the value with the native setter,
    // then dispatch 'input' the way a keystroke would.
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Ask KA who is signed in. Returns { known: false } when we can't tell.
  async function fetchCurrentUser() {
    try {
      const res = await fetch(CURRENT_USER_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: 'getFullUserProfile', query: CURRENT_USER_QUERY, variables: {} }),
      });
      if (!res.ok) return { known: false, reason: `current-user API returned HTTP ${res.status}` };
      const user = (await res.json())?.data?.user;
      if (!user || user.isPhantom) return { known: true, signedIn: false };
      return { known: true, signedIn: true, email: user.email || '', username: user.username || '' };
    } catch (e) {
      return { known: false, reason: `current-user API request failed (${e.message})` };
    }
  }

  // KA accepts an email or a username at login, so compare against whichever one was configured.
  function isConfiguredUser(user, cfg) {
    const want = cfg.username.trim().toLowerCase();
    return want.includes('@') ? user.email.toLowerCase() === want : user.username.toLowerCase() === want;
  }

  async function getConfig() {
    try {
      return await chrome.runtime.sendMessage({ type: 'getConfig' });
    } catch (e) {
      return null;
    }
  }

  // ---------- the flow ----------

  // Runs on a fresh visit to the login page. Submits at most once.
  async function attemptSignIn() {
    const cfg = await getConfig();
    if (!cfg) return report('info', 'No usable credentials in config.json or config.example.json; not signing in.');
    if (cfg.source !== 'config.json') {
      console.warn(`${LOG_PREFIX} config.json not found, using ${cfg.source} (deliberately wrong values).`);
    }

    const before = await fetchCurrentUser();
    if (before.known && before.signedIn) return report('info', 'Already signed in; not attempting sign-in.');

    const form = await waitFor(() => {
      const u = document.querySelector(SEL.username);
      const p = document.querySelector(SEL.password);
      const b = document.querySelector(SEL.submit);
      return u && p && b ? { u, p, b } : null;
    }, FORM_TIMEOUT_MS);
    if (!form) return report('uncertain', 'Login form not found on the page; did not attempt sign-in.');
    if (document.querySelector(SEL.captcha)) return report('needs-human', 'A CAPTCHA is shown; please sign in manually.');

    // Errors already on screen weren't caused by our submit, so they don't count later.
    const preexisting = new Set(errorTexts());

    setInputValue(form.u, cfg.username);
    setInputValue(form.p, cfg.password);
    // KA keeps "Log in" aria-disabled until React has seen both values. If it never enables,
    // our input didn't register, and clicking would do nothing, so we say so instead.
    const enabled = await waitFor(() => form.b.getAttribute('aria-disabled') !== 'true', 3_000);
    if (!enabled) return report('uncertain', 'The Log in button stayed disabled after filling the form; did not submit.');
    const marker = writeMarker(); // write it before submitting: the submit might reload the page
    form.b.click(); // the same thing a user does
    await judgeOutcome(cfg, marker, preexisting);
  }

  // Decide how the attempt turned out. Runs either right after submit, or on the page that the
  // submit navigated to (then `preexisting` is empty, since any error there is a result of our submit).
  async function judgeOutcome(cfg, marker, preexisting) {
    const deadline = marker.at + OUTCOME_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const fresh = errorTexts().filter((t) => !preexisting.has(t));
      if (fresh.length) return finish('failure', fresh.join('\n'));
      if (document.querySelector(SEL.captcha)) return finish('needs-human', 'A CAPTCHA appeared after submitting; complete it manually. Not reported as signed in.');
      if (!isLoginPage()) break; // we left the login page: now look for positive proof
      await sleep(POLL_MS);
    }

    // No error shown. That alone proves nothing, so ask KA who is signed in.
    let last = { known: false, reason: 'no answer' };
    const verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < verifyDeadline) {
      last = await fetchCurrentUser();
      if (last.known && last.signedIn) break;
      await sleep(POLL_MS * 4);
    }

    if (last.known && last.signedIn) {
      if (isConfiguredUser(last, cfg)) return finish('success', 'Signed in to Khan Academy (confirmed by the current-user API).');
      return finish('uncertain', 'A session exists, but for a different account than the configured one. Not reported as success.');
    }
    if (last.known) return finish('uncertain', 'No error was shown, but Khan Academy reports no signed-in user. Not reported as success.');
    return finish('uncertain', `Could not confirm the sign-in: ${last.reason}. Not reported as success.`);
  }

  function finish(kind, message) {
    clearMarker();
    report(kind, message);
  }

  // ---------- entry point ----------

  // `busy` keeps a second flow from starting while one is running (e.g. React re-renders, SPA route changes).
  let busy = false;
  let wasOnLogin = false;

  async function run(task) {
    busy = true;
    try { await task(); } finally { busy = false; }
  }

  // A "visit" begins when we arrive on the login page: a page load or an SPA route change into /login.
  // While we stay on it, nothing else gets triggered.
  function tick() {
    if (busy) return;
    const onLogin = isLoginPage();
    if (onLogin && !wasOnLogin) run(attemptSignIn);
    wasOnLogin = onLogin;
  }

  const marker = readMarker();
  if (marker) {
    // This page load came out of our own submit: judge that attempt, don't start a new one.
    wasOnLogin = isLoginPage();
    run(async () => {
      const cfg = await getConfig();
      if (!cfg) return finish('uncertain', 'Lost access to the config while checking the sign-in outcome.');
      await judgeOutcome(cfg, marker, new Set());
    });
  }
  tick();
  setInterval(tick, 500); // simple way to notice SPA route changes into /login
})();
