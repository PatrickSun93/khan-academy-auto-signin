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
3. After editing `config.json`, click the reload icon on the extension's card.
4. Open https://www.khanacademy.org/login. The toast appears bottom-right, and the log line (prefixed `[KA auto sign-in]`) is in that tab's DevTools console.

## Design decisions

TODO (expand): the outcome states (failure / success / uncertain / needs-human / info); why the content script matches all of www.khanacademy.org but acts only on the login page or right after its own submit; the sessionStorage "pending" marker; why credentials go through the service worker rather than web_accessible_resources.

**One attempt per visit.** A visit is one load of the login page, or one SPA route change into it. Reloading the login page counts as a new visit, so it tries again. A reload caused by our own submit doesn't count as a new visit: the pending marker identifies it, and that page only judges the earlier attempt.

## How we know it worked

- **Account created:** TODO
- **Signed in:** TODO. Rule: success needs positive proof (KA's current-user API returns the configured account). A redirect, or no error showing up, isn't enough. Anything short of proof is reported as *uncertain*.

## Permissions

| Requested | Why |
|---|---|
| `content_scripts.matches: https://www.khanacademy.org/*` | TODO: the only host access. Needed on the login page, and on the page the submit lands on, to verify the sign-in. |
| (no `permissions`, no `host_permissions`) | The config is read from the extension package, and state is kept in the page's sessionStorage, so `storage` isn't needed. The service worker never contacts KA. |

## Tests

```sh
uv run pytest
```

The extension tests load the real unpacked extension in Playwright's Chromium. All `khanacademy.org` traffic is served by a local fake (`tests/conftest.py`) and everything else is blocked, so the tests never touch the real site or the real account.

## Known limitations / next steps

TODO

## AI tools used

TODO: Claude Code (what for).
