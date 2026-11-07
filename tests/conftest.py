"""Shared test harness: runs the real unpacked extension against a fake Khan Academy.

Every request to https://www.khanacademy.org is intercepted with Playwright's `context.route`
and answered locally by FakeKA, and every other request is aborted, so tests never hit the real site.
The extension still sees the real URLs, so its manifest `matches` and login-page detection get tested as-is.
"""

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

GOOD_USER = "learner@example.test"
GOOD_PASS = "correct-horse-battery"
# The real message, observed on 2026-11-04 after a wrong password.
KA_ERROR = "Your login or password is incorrect."


@dataclass
class FakeKA:
    """Server-side state of the fake site. Tests flip these options per scenario."""

    on_success: str = "navigate"  # "navigate" (full page load) | "spa" (pushState) | "hang"
    # How the home page reports the session to the extension's check (its fetch of "/"):
    # "honest" | "always_signed_out" | "http_500" (always) | "http_500_after_login" | "no_flag"
    profile: str = "honest"
    signed_in: bool = False
    login_posts: int = 0
    error_text: str = KA_ERROR  # what the fake shows for wrong credentials

    def handle(self, route):
        req = route.request
        path = req.url.split("khanacademy.org", 1)[1].split("?", 1)[0]
        if path == "/fixture/login" and req.method == "POST":
            return self._login(route, json.loads(req.post_data or "{}"))
        if path == "/login" or path.startswith("/login/"):
            return route.fulfill(path=FIXTURES / "login.html", content_type="text/html")
        if req.resource_type == "fetch":
            return self._home_for_check(route)
        return route.fulfill(body=self._home_html(self.signed_in), content_type="text/html")

    def _login(self, route, creds):
        self.login_posts += 1
        if creds.get("username") != GOOD_USER or creds.get("password") != GOOD_PASS:
            return route.fulfill(json={"error": self.error_text})
        if self.on_success == "hang":
            return route.fulfill(json={})
        self.signed_in = True
        key = "spa_navigate" if self.on_success == "spa" else "navigate"
        return route.fulfill(json={key: "/"})

    def _home_html(self, has_profile: bool, flag: bool = True) -> str:
        """Like KA, the server renders the session flags into the page (format seen on the real site)."""
        data = f'{{"KA-has-profile":{str(has_profile).lower()},"KA-is-phantom":false}}' if flag else "{}"
        return (FIXTURES / "home.html").read_text().replace("__KA_DATA_JSON__", data)

    def _home_for_check(self, route):
        """The extension's fetch("/"). Page navigations are served honestly; only this check is faked."""
        if self.profile == "http_500" or (self.profile == "http_500_after_login" and self.signed_in):
            return route.fulfill(status=500, body="oops")
        has_profile = self.signed_in and self.profile != "always_signed_out"
        return route.fulfill(body=self._home_html(has_profile, flag=self.profile != "no_flag"),
                             content_type="text/html")


def make_extension(tmp_path: Path, config: dict | None) -> Path:
    """Copy the extension and write config.json (or leave it out, to test the example fallback)."""
    dest = tmp_path / "extension"
    shutil.copytree(EXTENSION_DIR, dest, ignore=shutil.ignore_patterns("config.json"))
    if config is not None:
        (dest / "config.json").write_text(json.dumps(config))
    return dest


@pytest.fixture
def fake_ka():
    return FakeKA()


@pytest.fixture
def launch(tmp_path, fake_ka):
    """launch(config) -> (context, page, console_lines). Config None = no config.json."""
    pw = sync_playwright().start()
    contexts = []

    def _launch(config={"username": GOOD_USER, "password": GOOD_PASS}):
        ext = make_extension(tmp_path, config)
        ctx = pw.chromium.launch_persistent_context(
            str(tmp_path / "profile"),
            channel="chromium",  # Playwright's Chromium, which supports extensions in headless mode
            headless=True,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"],
        )
        contexts.append(ctx)
        ctx.route("**/*", lambda route: route.abort())  # nothing leaves the machine...
        ctx.route("https://www.khanacademy.org/**", fake_ka.handle)  # ...except to the fake KA
        page = ctx.new_page()
        lines = []
        page.on("console", lambda m: lines.append(m.text))
        return ctx, page, lines

    yield _launch
    for ctx in contexts:
        ctx.close()
    pw.stop()
