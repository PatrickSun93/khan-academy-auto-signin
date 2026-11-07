"""End-to-end tests for the extension against the fake Khan Academy (see conftest.py)."""

import json

from conftest import GOOD_PASS, GOOD_USER, KA_ERROR

TOAST = "[data-ka-autosignin-toast]"
LOGIN = "https://www.khanacademy.org/login"


def toast(page, timeout=30_000):
    """Wait for the toast; return (kind, text)."""
    host = page.locator(TOAST)
    box = host.locator(".toast")  # Playwright locators pierce the open shadow root
    box.wait_for(timeout=timeout)
    return host.get_attribute("data-ka-autosignin-toast"), box.inner_text()


def test_wrong_credentials_show_ka_error_verbatim(launch, fake_ka):
    _, page, lines = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    kind, text = toast(page)
    assert kind == "failure"
    assert text == KA_ERROR
    assert any(KA_ERROR in line for line in lines)
    assert fake_ka.login_posts == 1


def test_error_text_is_not_normalised(launch, fake_ka):
    # Curly quotes, an em dash, a non-ASCII letter: the toast must not "tidy" any of it.
    fake_ka.error_text = "We don’t recognise “that” login — réessayez."
    _, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    assert toast(page) == ("failure", fake_ka.error_text)


def test_missing_config_falls_back_to_example_and_fails(launch, fake_ka):
    _, page, lines = launch(None)
    page.goto(LOGIN)
    kind, text = toast(page)
    assert (kind, text) == ("failure", KA_ERROR)
    assert any("config.example.json" in line for line in lines)


def test_success_after_full_navigation_is_confirmed(launch, fake_ka):
    _, page, lines = launch()
    page.goto(LOGIN)
    kind, _ = toast(page)
    assert kind == "success"
    assert page.url == "https://www.khanacademy.org/"
    assert any("success" in line for line in lines)


def test_login_on_accounts_subdomain_is_handled_and_confirmed_on_www(launch, fake_ka):
    # Seen on the real site 2026-11-06: www.khanacademy.org/login -> accounts.khanacademy.org/login.
    # The submit happens on accounts.*, the result is judged on www.*, so the pending marker
    # has to cross origins (it lives in the background, not in the page's sessionStorage).
    fake_ka.login_host = "accounts"
    _, page, _ = launch()
    page.goto(LOGIN)
    kind, _ = toast(page)
    assert kind == "success"
    assert page.url == "https://www.khanacademy.org/"
    assert fake_ka.login_posts == 1


def test_wrong_credentials_on_accounts_subdomain_show_ka_error(launch, fake_ka):
    fake_ka.login_host = "accounts"
    _, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    assert toast(page) == ("failure", KA_ERROR)
    assert page.url.startswith("https://accounts.khanacademy.org/login")


def test_success_after_spa_navigation_is_confirmed(launch, fake_ka):
    fake_ka.on_success = "spa"
    _, page, _ = launch()
    page.goto(LOGIN)
    assert toast(page)[0] == "success"


def test_redirect_without_session_is_not_success(launch, fake_ka):
    fake_ka.profile = "always_signed_out"
    _, page, _ = launch()
    page.goto(LOGIN)
    assert toast(page)[0] == "uncertain"


def test_unreadable_state_after_submit_is_not_success(launch, fake_ka):
    fake_ka.profile = "http_500_after_login"
    _, page, _ = launch()
    page.goto(LOGIN)
    kind, text = toast(page)
    assert kind == "uncertain"
    assert "HTTP 500" in text
    assert fake_ka.login_posts == 1


def test_unreadable_state_before_submit_means_no_submit(launch, fake_ka):
    # Without "nobody was signed in before", a session afterwards proves nothing, so don't even try.
    fake_ka.profile = "http_500"
    _, page, _ = launch()
    page.goto(LOGIN)
    kind, text = toast(page)
    assert kind == "uncertain"
    assert "Did not submit" in text
    assert fake_ka.login_posts == 0


def test_missing_session_flag_is_not_success(launch, fake_ka):
    # If KA stops rendering the flag, we must say we can't tell, not guess either way.
    fake_ka.profile = "no_flag"
    _, page, _ = launch()
    page.goto(LOGIN)
    kind, text = toast(page)
    assert kind == "uncertain"
    assert "KA-has-profile" in text
    assert fake_ka.login_posts == 0


def test_hung_sign_in_times_out_as_uncertain(launch, fake_ka):
    fake_ka.on_success = "hang"
    _, page, _ = launch()
    page.goto(LOGIN)
    assert toast(page, timeout=40_000)[0] == "uncertain"


def test_only_one_submit_per_visit(launch, fake_ka):
    _, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    toast(page)
    page.wait_for_timeout(2_000)  # give a buggy retry loop time to fire
    assert page.evaluate("window.__submits") == 1
    assert fake_ka.login_posts == 1
    assert page.locator(TOAST).count() == 1


def test_reload_counts_as_a_new_visit(launch, fake_ka):
    _, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    toast(page)
    page.reload()
    toast(page)
    assert fake_ka.login_posts == 2


def test_sliding_window_limit_is_shared_across_tabs(launch, fake_ka):
    ctx, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    toast(page)
    for _ in range(2):  # two manual reloads: new visits, so attempts 2 and 3
        page.reload()
        toast(page)
    assert fake_ka.login_posts == 3

    other = ctx.new_page()  # a 4th visit, in another tab, must be refused
    other.goto(LOGIN)
    kind, text = toast(other)
    assert kind == "info"
    assert text.startswith("Sign-in skipped: already tried 3 times in the last 5 minutes.")
    assert fake_ka.login_posts == 3
    assert other.evaluate("window.__submits") == 0


def test_config_edits_apply_without_reloading_extension(launch, fake_ka, tmp_path):
    # background.js re-reads config.json on every request, and Chrome serves an unpacked
    # extension's files straight from disk, so fixing the config only needs a page reload.
    _, page, _ = launch({"username": GOOD_USER, "password": "wrong"})
    page.goto(LOGIN)
    assert toast(page)[0] == "failure"
    (tmp_path / "extension" / "config.json").write_text(json.dumps({"username": GOOD_USER, "password": GOOD_PASS}))
    page.reload()
    assert toast(page)[0] == "success"


def test_does_nothing_on_other_pages(launch, fake_ka):
    _, page, lines = launch()
    page.goto("https://www.khanacademy.org/math")
    page.wait_for_timeout(2_000)
    assert page.locator(TOAST).count() == 0
    assert fake_ka.login_posts == 0
    assert not any("[KA auto sign-in]" in line for line in lines)


def test_already_signed_in_does_not_submit(launch, fake_ka):
    fake_ka.signed_in = True
    _, page, _ = launch()
    page.goto(LOGIN)
    assert toast(page)[0] == "info"
    assert fake_ka.login_posts == 0
