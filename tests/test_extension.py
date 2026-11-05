"""End-to-end tests for the extension against the fake Khan Academy (see conftest.py)."""

from conftest import GOOD_USER, KA_ERROR

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


def test_unavailable_current_user_api_is_not_success(launch, fake_ka):
    fake_ka.profile = "http_500"
    _, page, _ = launch()
    page.goto(LOGIN)
    kind, text = toast(page)
    assert kind == "uncertain"
    assert "HTTP 500" in text


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
