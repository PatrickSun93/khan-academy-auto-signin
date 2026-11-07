# Khan Academy onboarding script + auto sign-in extension

> Status: work in progress. Sections marked TODO get filled in after the real Khan Academy pages have been checked.

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
4. Open https://www.khanacademy.org/login. The toast appears bottom-right, and the log line (prefixed `[KA auto sign-in]`) is in that tab's DevTools console.

## Design decisions

TODO (expand): the outcome states (failure / success / uncertain / needs-human / info); why the content script matches all of www.khanacademy.org but acts only on the login page or right after its own submit; the sessionStorage "pending" marker; why credentials go through the service worker rather than web_accessible_resources.

**One attempt per visit.** A visit is one load of the login page, or one SPA route change into it. Reloading the login page counts as a new visit, so it tries again. A reload caused by our own submit doesn't count as a new visit: the pending marker identifies it, and that page only judges the earlier attempt.

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
| `content_scripts.matches: https://www.khanacademy.org/*` | TODO: the only host access. Needed on the login page, and on the page the submit lands on, to verify the sign-in. |
| `storage` | Holds the sliding-window attempt counter (at most 3 sign-in submits per 5 minutes, across all tabs), so a wrong config plus repeated reloads can't get the account locked. Only timestamps are stored, never credentials. `chrome.storage` is used rather than the site's localStorage so KA's page scripts can't read or reset it. |
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

TODO (Patrick): anything else.

## AI tools used

TODO: Claude Code (what for).
