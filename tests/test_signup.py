"""Unit tests for the sign-up script's outcome logic (no browser, no network)."""

import pytest

from signup.signup import EXIT_CREATED, EXIT_FAILED, EXIT_UNCERTAIN, classify

EMAIL = "learner@example.test"
SIGNED_IN = {"known": True, "signedIn": True, "email": EMAIL}


def test_created_only_with_matching_signed_in_user():
    assert classify(None, SIGNED_IN, EMAIL)[0] == EXIT_CREATED
    assert classify(None, {**SIGNED_IN, "email": "LEARNER@example.test"}, EMAIL)[0] == EXIT_CREATED


def test_ka_error_is_failure_and_quoted_verbatim():
    code, msg = classify("This email is already in use.", None, EMAIL)
    assert code == EXIT_FAILED
    assert msg.endswith("This email is already in use.")


def test_ka_error_wins_even_if_someone_is_signed_in():
    assert classify("Something went wrong.", SIGNED_IN, EMAIL)[0] == EXIT_FAILED


@pytest.mark.parametrize(
    "profile",
    [
        None,  # never got an answer
        {"known": False, "reason": "current-user API returned HTTP 500"},
        {"known": True, "signedIn": False},  # no error, but nobody signed in
        {**SIGNED_IN, "email": "someone-else@example.test"},  # wrong account
    ],
)
def test_anything_short_of_proof_is_uncertain(profile):
    assert classify(None, profile, EMAIL)[0] == EXIT_UNCERTAIN


@pytest.mark.parametrize("ka_error,profile", [(None, SIGNED_IN), ("err", None), (None, None)])
def test_messages_never_contain_the_email(ka_error, profile):
    assert EMAIL not in classify(ka_error, profile, EMAIL)[1]
