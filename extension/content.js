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
//   success      Nobody was signed in before our submit, KA showed no error, and afterwards KA's
//                server-rendered home page says a profile is signed in. Ours was the only sign-in
//                in between, so the session is the configured account's (see signInState below).
//   uncertain    Timed out, or KA's page couldn't confirm. Explicitly NOT a success.
//   needs-human  A CAPTCHA / bot check appeared. We stop and don't try to get around it.
//   info         Nothing was attempted (already signed in, no config, ...).
(() => {
  const LOG_PREFIX = '[KA auto sign-in]';
  const MARKER_KEY = 'kaAutoSignin.pending'; // lives in the page's sessionStorage (this tab only)
  const MARKER_TTL_MS = 30_000; // an older marker is treated as stale and ignored
  const FORM_TIMEOUT_MS = 10_000; // time allowed for the SPA to render the login form
  const OUTCOME_TIMEOUT_MS = 15_000; // time after submit to wait for an error or a sign-in
  const VERIFY_TIMEOUT_MS = 10_000; // time allowed for the session to show up on KA's home page
  const POLL_MS = 250;

  // Checked against the real login page on 2026-11-04. KA's own data-testids are stabler than
  // its generated class names.
  const SEL = {
    username: '[data-testid="identifier-field"]',
    password: '[data-testid="password-field"]',
    submit: '[data-testid="log-in-submit-button"]',
    // Wrong credentials: KA adds <div id="log-in-server-error" role="alert"> above the button
    // (seen 2026-11-04: "Your login or password is incorrect."). The per-field slots are aria-live
    // regions, empty until a field is invalid. [role="alert"] catches any other form-level error.
    error: '#log-in-server-error, [data-testid="identifier-error"], [data-testid="password-error"], [role="alert"]',
    captcha: 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
  };

  // KA's server renders its session flags into every page's HTML (window.__KA_DATA__). Checked
  // 2026-11-04 signed out ("KA-has-profile":false) and 2026-11-06 right after sign-up (true).
  // We read them from a fresh copy of the home page, not from this page's JS (a content script
  // can't see page variables) and not from KA's GraphQL API (it only accepts KA's own queries).
  // The HTML doesn't include the email, which is why success is judged before/after (see above).
  const STATE_URL = '/';
  const HAS_PROFILE = { true: '"KA-has-profile":true', false: '"KA-has-profile":false' };
  const IS_PHANTOM = '"KA-is-phantom":true'; // a guest "phantom" profile is not a sign-in

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isLoginPage() {
    return location.pathname === '/login' || location.pathname.startsWith('/login/');
  }

  // ---------- reporting ----------

  // Progress lines, so the console shows how far a visit got. Never includes credentials.
  function step(text) {
    console.info(`${LOG_PREFIX} ${text}`);
  }

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

  // Ask KA's server whether anyone is signed in. Returns { known: false, reason } when we can't tell.
  async function signInState() {
    try {
      const res = await fetch(STATE_URL, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return { known: false, reason: `Khan Academy's home page returned HTTP ${res.status}` };
      const html = await res.text();
      if (html.includes(HAS_PROFILE.true)) return { known: true, signedIn: !html.includes(IS_PHANTOM) };
      if (html.includes(HAS_PROFILE.false)) return { known: true, signedIn: false };
      return { known: false, reason: "Khan Academy's home page no longer includes the KA-has-profile flag" };
    } catch (e) {
      return { known: false, reason: `request to Khan Academy's home page failed (${e.message})` };
    }
  }

  async function getConfig() {
    try {
      return await chrome.runtime.sendMessage({ type: 'getConfig' });
    } catch (e) {
      return null;
    }
  }

  async function reserveAttempt() {
    try {
      return await chrome.runtime.sendMessage({ type: 'reserveAttempt' });
    } catch (e) {
      // If we can't check the limit, don't submit: an extra attempt costs more than a skipped one.
      return { allowed: false, max: 0, windowMs: 0, retryInMs: 0 };
    }
  }

  // ---------- the flow ----------

  // Runs on a fresh visit to the login page. Submits at most once.
  async function attemptSignIn() {
    const cfg = await getConfig();
    if (!cfg) return report('info', 'No usable credentials in config.json or config.example.json; not signing in.');
    step(`login page visit: credentials from ${cfg.source}`);
    if (cfg.source !== 'config.json') {
      console.warn(`${LOG_PREFIX} config.json not found, using ${cfg.source} (deliberately wrong values).`);
    }

    // The "before" half of the proof. If we can't see that nobody is signed in now, a signed-in
    // session afterwards wouldn't prove anything, so we don't submit at all.
    const before = await signInState();
    if (!before.known) return report('uncertain', `Could not check whether anyone is already signed in: ${before.reason}. Did not submit. Reload the page to try again.`);
    if (before.signedIn) return report('info', 'Already signed in; not attempting sign-in.');
    step('before submit: nobody is signed in');

    const form = await waitFor(() => {
      const u = document.querySelector(SEL.username);
      const p = document.querySelector(SEL.password);
      const b = document.querySelector(SEL.submit);
      return u && p && b ? { u, p, b } : null;
    }, FORM_TIMEOUT_MS);
    if (!form) return report('uncertain', 'Login form not found on the page; did not attempt sign-in. Reload the page to try again.');
    if (document.querySelector(SEL.captcha)) return report('needs-human', 'A CAPTCHA is shown; please sign in manually.');

    step('login form found');
    // Errors already on screen weren't caused by our submit, so they don't count later.
    const preexisting = new Set(errorTexts());

    setInputValue(form.u, cfg.username);
    setInputValue(form.p, cfg.password);
    // KA keeps "Log in" aria-disabled until React has seen both values. If it never enables,
    // our input didn't register, and clicking would do nothing, so we say so instead.
    const enabled = await waitFor(() => form.b.getAttribute('aria-disabled') !== 'true', 3_000);
    if (!enabled) return report('uncertain', 'The Log in button stayed disabled after filling the form; did not submit. Reload the page to try again.');

    // Ask the background for a slot in the sliding-window limit right before the one real submit.
    const slot = await reserveAttempt();
    if (!slot.allowed) {
      const wait = Math.ceil(slot.retryInMs / 60_000);
      return report('info', `Sign-in skipped: already tried ${slot.max} times in the last ${slot.windowMs / 60_000} minutes. ` +
        `Waiting avoids locking the account. Try again in about ${wait} min.`);
    }
    step('submitting (attempt reserved)');
    const marker = writeMarker(); // write it before submitting: the submit might reload the page
    form.b.click(); // the same thing a user does
    await judgeOutcome(marker, preexisting);
  }

  // Decide how the attempt turned out. Runs either right after submit, or on the page that the
  // submit navigated to (then `preexisting` is empty, since any error there is a result of our submit).
  async function judgeOutcome(marker, preexisting) {
    const deadline = marker.at + OUTCOME_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const fresh = errorTexts().filter((t) => !preexisting.has(t));
      if (fresh.length) return finish('failure', fresh.join('\n'));
      if (document.querySelector(SEL.captcha)) return finish('needs-human', 'A CAPTCHA appeared after submitting; complete it manually. Not reported as signed in.');
      if (!isLoginPage()) break; // we left the login page: now look for positive proof
      await sleep(POLL_MS);
    }

    // No error shown. That alone proves nothing, so ask KA's server whether a profile is signed in now.
    let last = { known: false, reason: 'no answer' };
    const verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < verifyDeadline) {
      last = await signInState();
      if (last.known && last.signedIn) break;
      await sleep(POLL_MS * 4);
    }

    // The "after" half. A marker is only written after the "before" check saw nobody signed in,
    // so signed out -> our submit -> signed in. Known gap: a different account signed in by hand
    // in another tab within these few seconds would look the same (README: limitations).
    if (last.known && last.signedIn) {
      return finish('success', 'Signed in to Khan Academy (signed out before our submit, signed in after it).');
    }
    // Reloading is safe: the next visit checks first, and if we did get signed in it won't submit again.
    const next = 'Reload the login page to check again, or sign in manually.';
    if (last.known) return finish('uncertain', `No error was shown, but Khan Academy reports no signed-in user. Not reported as success. ${next}`);
    return finish('uncertain', `Could not confirm the sign-in: ${last.reason}. Not reported as success. ${next}`);
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
    try {
      await task();
    } catch (e) {
      // Never fail silently: an unexpected error is reported, and it is not a success.
      finish('uncertain', `Unexpected error in the extension: ${e && e.message}. Not reported as success. Reload the login page to try again.`);
    } finally {
      busy = false;
    }
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
    run(() => judgeOutcome(marker, new Set()));
  }
  tick();
  setInterval(tick, 500); // simple way to notice SPA route changes into /login
})();
