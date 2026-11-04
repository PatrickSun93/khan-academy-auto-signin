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
import re
import sys
import time

from playwright.sync_api import Page, sync_playwright

SIGNUP_URL = "https://www.khanacademy.org/signup"
EXIT_CREATED, EXIT_FAILED, EXIT_UNCERTAIN = 0, 1, 2
OUTCOME_TIMEOUT_S = 30
HUMAN_TIMEOUT_S = 300

# Checked against the real sign-up flow on 2026-11-04 (stopped short of the final submit).
SEL = {
    # [role="alert"] regions plus the per-field error slots (ids like ":rn:-labeled-field-error").
    "error": '[role="alert"], [id$="-labeled-field-error"]',
    "captcha": 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
}

# KA's GraphQL only accepts its own safelisted queries, so we don't send one. Instead we read
# the answers to the current-user queries KA's own pages make, using Playwright's view of network
# responses. getFullUserProfile includes the email; loggedInUserQuery doesn't.
HOME_URL = "https://www.khanacademy.org/"
USER_QUERIES = ("getFullUserProfile", "loggedInUserQuery")
USER_TIMEOUT_S = 15


def watch_user_responses(page: Page) -> list:
    """Start collecting `data.user` from KA's own current-user responses (None = nobody signed in)."""
    seen: list = []

    def on_response(resp):
        path = resp.url.split("?", 1)[0]
        if "/api/internal/graphql/" not in path or not path.endswith(USER_QUERIES):
            return
        try:
            seen.append((resp.json().get("data") or {}).get("user"))
        except Exception:
            pass  # not JSON (e.g. an error page): tells us nothing

    page.on("response", on_response)
    return seen


def current_user_profile(page: Page, seen: list) -> dict:
    """Open the home page (it asks KA who is signed in) and turn the answers into a profile dict."""
    seen.clear()
    page.goto(HOME_URL)
    deadline = time.monotonic() + USER_TIMEOUT_S
    while time.monotonic() < deadline and not any(u and "email" in u for u in seen):
        page.wait_for_timeout(500)
    # Second source: KA's own client-side copy of the signed-in user.
    # TODO-RECON: the shape of window.__USER_PROFILE__ when signed in hasn't been confirmed.
    client_user = page.evaluate("() => window.__USER_PROFILE__ || null")
    if isinstance(client_user, dict) and client_user.get("email"):
        seen.append(client_user)
    if not seen:
        return {"known": False, "reason": "Khan Academy's pages never reported a current user"}
    users = [u for u in seen if u and not u.get("isPhantom")]
    if not users:
        return {"known": True, "signedIn": False}
    with_email = [u for u in users if u.get("email")]
    if not with_email:
        return {"known": False, "reason": "signed in, but no response included the account's email"}
    return {"known": True, "signedIn": True, "email": with_email[-1]["email"]}


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


def pick(page: Page, testid: str, option: str) -> None:
    """KA's birthday fields are custom comboboxes: click to open, then click the option."""
    page.get_by_test_id(testid).click()
    page.get_by_role("option", name=option, exact=True).click()


def fill_signup_form(page: Page, email: str, password: str, birth_year: int) -> None:
    """Walk the sign-up flow: role -> birthday -> email/password -> submit.

    /signup  ->  /signup/learner/birthday  ->  /signup/learner/over-age-gate
    """
    # "Student: learning on my own" is the learner role. An adult birthday makes this an adult account.
    page.get_by_role("link", name=re.compile(r"^Student")).click()
    page.wait_for_url("**/signup/learner/birthday")
    pick(page, "birthday-picker-month", "Jan")
    pick(page, "birthday-picker-year", str(birth_year))
    page.get_by_role("button", name="Next", exact=True).click()
    page.wait_for_url("**/signup/learner/over-age-gate")

    # Checking this box accepts KA's Terms of Service. The person running the script is the
    # one agreeing, which is why the README asks you to read them first.
    page.get_by_test_id("tos-checkbox").check()
    page.locator('input[type="email"]').fill(email)
    page.locator('input[type="password"]').fill(password)
    page.get_by_role("button", name="Sign up", exact=True).click()


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
        page = browser.new_page()  # fresh context: no session exists before our sign-up
        seen_users = watch_user_responses(page)
        page.goto(SIGNUP_URL)
        fill_signup_form(page, email, password, args.birth_year)
        ka_error = wait_for_outcome(page)
        profile = None if ka_error else current_user_profile(page, seen_users)
        code, message = classify(ka_error, profile, email)
        print(message)
        browser.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
