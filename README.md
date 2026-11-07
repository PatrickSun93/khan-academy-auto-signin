# Khan Academy onboarding script + auto sign-in extension

Two pieces:

- `signup/signup.py` creates one free adult learner account (email + password) and reports whether it was actually created.
- `extension/` is a Chrome Manifest V3 extension. It signs that account in on the Khan Academy login page and reports the outcome honestly: KA's own error text, word for word, on failure, and a success toast only once the sign-in is confirmed.

Recording: TODO (link)

## Setup

```sh
uv sync                              # Python 3.11+, installs playwright + pytest
uv run playwright install chromium   # browser for the script and the tests
```

## Running the onboarding script

```sh
uv run python signup/signup.py --email you@example.com
```

The password is prompted for twice, without echo. It is never printed, logged or saved.
Exit code 0 means created (proven), 1 means Khan Academy showed an error (printed verbatim), and 2 means uncertain.
If a CAPTCHA appears, the script prints `NEEDS HUMAN` and waits for you to finish it in the browser window. It never tries to get around it.

## Loading the extension and setting the credentials

1. `cp extension/config.example.json extension/config.json`, then put the real email and password in `config.json`. That file is gitignored.
   Without `config.json`, the extension uses `config.example.json`, whose values are deliberately wrong, so the first run fails on purpose.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
3. After editing `config.json`, just reload the login page. You don't need to reload the extension: `background.js` re-reads the file on every request, and Chrome serves an unpacked extension's files straight from disk (covered by a test).
4. Open https://www.khanacademy.org/login (KA may redirect you to `accounts.khanacademy.org/login`; both work). The toast appears bottom-right, and every step is logged in that tab's DevTools console with the prefix `[KA auto sign-in]`.
5. Make sure you're signed out of Khan Academy first. If you're already signed in, the extension says so and doesn't submit.

If nothing happens at all, open the extension's details page in `chrome://extensions` and check that site access is allowed for both Khan Academy sites.

## Design decisions

Each decision: what was chosen, why, and what was ruled out.

**1. What counts as "signed in".** The extension reads Khan Academy's server-rendered home page (`fetch('/')`) before and after its one submit. Success requires `"KA-has-profile":false` before, no error after submitting, and `"KA-has-profile":true` (not a guest profile) after. Our submit was the only sign-in in between, so the session is the configured account's. Ruled out:
- a redirect after submit (2FA and rate limits redirect too);
- cookies (guests get session-looking cookies, and the real login cookie is HttpOnly);
- the login API's response (a content script can't see the page's network traffic, and an OK response doesn't mean the browser holds a session);
- comparing the email (the HTML doesn't contain it, and KA's GraphQL only accepts its own safelisted queries);
- reading KA's JS variables from a `world: "MAIN"` script (other scripts on the page could fake the result, and the configured email would be exposed to them).

The known gap is someone signing in to a different account by hand in another tab within those few seconds.

**2. What "one attempt per visit" means.** Opening or reloading the login page, or an in-site navigation into it, is a new visit, because the user asked for the login page. A page load caused by our own submit is not: a pending marker identifies it, and that page only judges the earlier attempt. Otherwise a failure → reload → resubmit loop could lock the account by itself. On top of that, a sliding window allows at most 3 submits per 5 minutes across all tabs. It lives in `chrome.storage.local`, and a background queue keeps two tabs from both taking the last slot. When the window is full, the extension says how long to wait instead of submitting.

**3. Where the extension runs.** The content script matches all of `www.khanacademy.org` and `accounts.khanacademy.org`, not just `/login`, for three reasons:
- clicking "Log in" elsewhere on the site can reach the login page by an in-site navigation, with no new page load to inject on;
- the page the submit lands on has to judge the result;
- KA serves the form on the `accounts` subdomain for some browsers.

"Does nothing on other pages" holds in two layers. Chrome never injects into any other site, and inside KA the script acts only on `/login` or on the one page that carries its own pending marker. The marker is kept per tab by the service worker in `chrome.storage.session`, because a page's sessionStorage is per origin and wouldn't survive the jump from `accounts.` to `www.`. The cost is a broader install warning.

**4. Where the credentials live.** They sit in `extension/config.json`, which is gitignored, and only the service worker reads it. The content script asks for them by message. The file isn't listed in `web_accessible_resources`, because then any website could fetch it. Plaintext on disk is acceptable for a prototype. A real product would use the browser's or OS's password manager, `chrome.storage.managed` pushed by policy (a good fit for institution-managed devices), or token/SSO sign-in with no stored password. Hashing doesn't help, since the form needs the original password. Config edits take effect on the next page load without reloading the extension.

**5. What to report when nothing can be proven.** If no error appears and the sign-in can't be confirmed within the time limit, the extension reports *uncertain*, never success and never failure. The toast says why (no session, the page couldn't be read, the form never appeared) and what to do next: usually reload the login page, which is safe, because the next visit checks first and won't submit if we did get signed in. Uncertain attempts still count toward the limit. Anything unexpected inside the extension is reported the same way instead of failing silently.

**6. How the sign-up script proves the account exists.** It runs in a fresh browser with no session, so any session afterwards came from this sign-up. After submitting, it opens the home page and reads the answer to the current-user request KA's own page makes (`getFullUserProfile`). It reports `CREATED` only if that answer shows a signed-in, non-guest user with exactly the registered email, and it also checks the server-rendered `KA-has-profile` flag. A visible KA error is `FAILED`, printed verbatim. Anything else is `UNCERTAIN`, and the script tells you not to rerun, because the account may exist. A CAPTCHA is handed to the human; the script never tries to solve or bypass it.

**Outcome states** (both pieces): `failure` (KA's error, verbatim), `success` (proven only), `uncertain` (no proof either way), `needs-human` (CAPTCHA), `info` (nothing attempted, e.g. already signed in or over the limit).

## How we know it worked

- **Account created:** the script starts in a fresh browser with no session. After submitting the sign-up form, it opens the home page and reads the answer of Khan Academy's own current-user request (`getFullUserProfile`, which the page makes by itself). It reports `CREATED` only if that answer contains a signed-in, non-guest user whose email matches the one just registered. A KA error means `FAILED`, and anything else means `UNCERTAIN`. As a second check, the server-rendered home page must say `"KA-has-profile":true`. The script prints only yes/no for that check.
- **Signed in (extension):** success needs proof on both sides of our one submit:
  1. **Before:** the server-rendered home page (`fetch('/')`) says `"KA-has-profile":false`. If that can't be read, the extension doesn't submit.
  2. We submit the configured credentials, and no error appears.
  3. **After:** the same page now says `"KA-has-profile":true`, and it isn't a guest ("phantom") profile.

  Ours was the only sign-in in between, so the session belongs to the configured account. A redirect, a cookie, or simply no error isn't enough. Anything short of this is reported as *uncertain*.

  The page HTML doesn't contain the email, which is why identity is shown this way rather than by comparing emails. KA's GraphQL API only accepts its own safelisted queries, so the extension can't ask it directly.

## Permissions

| Requested | Why |
|---|---|
| `content_scripts.matches: https://www.khanacademy.org/*`, `https://accounts.khanacademy.org/*` | The only host access. KA serves the login form at `www.khanacademy.org/login` for some browsers and redirects others to `accounts.khanacademy.org/login` (seen on 2026-11-06), so both are needed. The script also has to run on the page the submit lands on, to verify the sign-in. On any other page it does nothing. |
| `storage` | `chrome.storage.session` (memory only) holds the per-tab pending marker for an attempt in flight. `chrome.storage.local` holds the sliding-window attempt counter (at most 3 sign-in submits per 5 minutes, across all tabs), so a wrong config plus repeated reloads can't get the account locked. Only timestamps are stored, never credentials. `chrome.storage` is used rather than the site's localStorage so KA's page scripts can't read or reset it. |
| (no `host_permissions`) | The config is read from the extension package, and the service worker never contacts KA. |

## Tests

```sh
uv run pytest
```

The extension tests load the real unpacked extension in Playwright's Chromium. All `khanacademy.org` traffic is served by a local fake (`tests/conftest.py`) and everything else is blocked, so the tests never touch the real site or the real account.

## Known limitations / next steps

- **Identity is shown by before/after, not by email.** If someone signed in to a *different* account by hand in another tab during the few seconds after our submit, the extension would report success for that session. Next step: read the email from a page that renders it (for example, account settings) and compare.
- The session check depends on KA continuing to render `KA-has-profile` into its HTML. If KA drops it, the extension says it can't tell and doesn't submit. It never guesses.
- Only one KA error text has been seen on the real site ("Your login or password is incorrect."). Others, such as lockout or rate-limit messages, are shown verbatim by the same code, but haven't been observed.
- 2FA or any extra step after the password ends as *uncertain*.
- Window expiry of the 3-per-5-minutes limit isn't tested (it needs a fake clock).
- The first real sign-up run crashed: KA does a full page navigation after "Sign up", and the script was reading the page at that moment. No account was created. Fixed by treating "page is navigating" as "no error yet", and by reporting `UNCERTAIN` with the window left open for any unexpected exception.

- On a brand-new browser profile, KA loads the login page twice while it sets its cookies. On the first load, the home page doesn't include the session flag yet, so a brief *uncertain* toast can appear, then disappear when the page reloads. Nothing is submitted.
- KA's markup (`data-testid`s, the flag in the HTML) can change. Each dependency is a named constant at the top of `content.js` or `signup.py`, and when one breaks, the code reports *uncertain* instead of guessing.

## AI tools used

Claude Code (Claude Opus 5.5) was used throughout:

- **Written by Claude Code:** the code, the tests and the fake Khan Academy fixture, and the README text. The design section above was drafted from decisions Patrick made and recorded during the work.
- **Patrick's decisions:**
  - the before/after sign-in proof, chosen over a hidden settings-page check;
  - rejecting a `world: "MAIN"` script for security reasons;
  - the definition of a visit;
  - the 3-per-5-minutes sliding window (his idea, not in the exercise);
  - running on the whole site so in-site navigation to the login page is covered;
  - hot-reloading the config;
  - checking the sign-in state before submitting;
  - reporting *uncertain* with a next step.

  Claude proposed options and pushed back where an idea didn't hold up. For example, hashing the password can't work, because the form needs the original.
- **Real-site inspection:** Claude inspected Khan Academy's pages read-only in a browser (DOM, page HTML, the logged-out state), without submitting forms or entering credentials. That's how it found the GraphQL safelist and the `accounts.` subdomain redirect.
- **Done by Patrick:** account creation, every real password and real sign-in, and the recording.
