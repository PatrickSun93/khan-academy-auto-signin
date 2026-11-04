"""Create ONE free Khan Academy adult learner account (email + password).

Usage:
    uv run python signup/signup.py --email you@example.com
    (the password is prompted for twice, with no echo)

Exit codes:
    0  created: KA's current-user API confirms a signed-in account with that email
    1  failed: KA showed an error (printed verbatim)
    2  uncertain: timed out, or we couldn't prove anything. NOT reported as created.

Credentials are never printed, logged or written to disk. Playwright tracing and screenshots stay off.
If a CAPTCHA / bot check appears, the script says so and waits for a human to finish it in the
open browser window. It never tries to get around it.
"""

import argparse
import getpass
import sys
import time

from playwright.sync_api import Page, sync_playwright

SIGNUP_URL = "https://www.khanacademy.org/signup"
EXIT_CREATED, EXIT_FAILED, EXIT_UNCERTAIN = 0, 1, 2
OUTCOME_TIMEOUT_S = 30
HUMAN_TIMEOUT_S = 300

# TODO-RECON: confirm every selector below against the real sign-up flow.
SEL = {
    "error": '[role="alert"]',
    "captcha": 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
}

# The same current-user check the extension uses (extension/content.js, fetchCurrentUser).
CURRENT_USER_JS = """
async () => {
  const res = await fetch('/api/internal/graphql/getFullUserProfile', {
    method: 'POST', credentials: 'same-origin',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({operationName: 'getFullUserProfile',
      query: 'query getFullUserProfile { user { id kaid email username isPhantom } }', variables: {}}),
  });
  if (!res.ok) return {known: false, reason: `current-user API returned HTTP ${res.status}`};
  const user = (await res.json())?.data?.user;
  if (!user || user.isPhantom) return {known: true, signedIn: false};
  return {known: true, signedIn: true, email: user.email || ''};
}
"""


def classify(ka_error: str | None, profile: dict | None, expected_email: str) -> tuple[int, str]:
    """Turn what we saw into (exit code, message). Pure function so it can be unit-tested.

    Success requires positive proof: a signed-in user whose email matches the one we registered.
    """
    if ka_error:
        return EXIT_FAILED, f"FAILED: Khan Academy said: {ka_error}"
    if not profile or not profile.get("known"):
        reason = (profile or {}).get("reason", "no answer from the current-user API")
        return EXIT_UNCERTAIN, f"UNCERTAIN: could not confirm the account ({reason})."
    if not profile.get("signedIn"):
        return EXIT_UNCERTAIN, "UNCERTAIN: no error shown, but Khan Academy reports nobody signed in."
    if profile.get("email", "").lower() != expected_email.lower():
        return EXIT_UNCERTAIN, "UNCERTAIN: signed in, but not as the email we registered."
    return EXIT_CREATED, "CREATED: Khan Academy confirms a signed-in account with the registered email."


def read_credentials(email_arg: str | None) -> tuple[str, str]:
    email = email_arg or input("Email for the new account: ").strip()
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords don't match; nothing was submitted.")
    return email, password


def fill_signup_form(page: Page, email: str, password: str, birth_year: int) -> None:
    """Walk the sign-up flow up to (and including) the final submit.

    TODO-RECON: the steps below are placeholders until the real flow has been observed
    (role choice -> birthday -> email/password -> submit).
    """
    raise NotImplementedError("sign-up steps pending recon of the real flow (see BRIEF.md progress)")


def wait_for_outcome(page: Page) -> str | None:
    """After submit: return KA's error text, or None once the page shows no error and has moved on."""
    deadline = time.monotonic() + OUTCOME_TIMEOUT_S
    told_human = False
    while time.monotonic() < deadline:
        errors = [t.strip() for t in page.locator(SEL["error"]).all_inner_texts() if t.strip()]
        if errors:
            return "\n".join(errors)
        if page.locator(SEL["captcha"]).count():
            if not told_human:
                print("NEEDS HUMAN: a CAPTCHA / bot check is shown. Complete it in the browser window; "
                      f"waiting up to {HUMAN_TIMEOUT_S}s. (The script does not solve it.)")
                told_human = True
                deadline = time.monotonic() + HUMAN_TIMEOUT_S
        elif "/signup" not in page.url:
            return None
        page.wait_for_timeout(500)
    return None  # timed out; the profile check that follows decides, and will say "uncertain"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email", help="email for the new account (prompted for if omitted)")
    parser.add_argument("--birth-year", type=int, default=1990, help="adult birth year (default 1990)")
    args = parser.parse_args()

    email, password = read_credentials(args.email)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)  # headed: a human can see it, and step in for a CAPTCHA
        page = browser.new_page()
        page.goto(SIGNUP_URL)
        fill_signup_form(page, email, password, args.birth_year)
        ka_error = wait_for_outcome(page)
        profile = None if ka_error else page.evaluate(CURRENT_USER_JS)
        code, message = classify(ka_error, profile, email)
        print(message)
        browser.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
