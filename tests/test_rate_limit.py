"""
Regression test for the stuck-on-"Stopping…" bug.

Root cause: a global ``default_limits=["100/hour"]`` was applied to every route,
including ``/api/v1/status``. The SPA polls status every 3-15s, so a long-open
tab exhausted the 100/hour budget within ~25 min and every subsequent request
(including the status polls that detect the server stopping) returned 429. The
client swallowed the 429s, never saw "stopped", and after 120s fell back to
"Failed to stop".

The fix gives ``/api/v1/status`` its own much higher limit while leaving the
100/hour default on every other route. This test asserts both halves:
  * status can be polled far past 100 times without a 429, and
  * an ordinary route still hits the 100/hour default.

The DCS-bound modules (app.config, app.control) are stubbed so the suite runs
without a DCS install — importing the real ones triggers path validation that
calls ``exit(1)`` on a non-server box.
"""

import sys
import types
from base64 import b64encode
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

# --- stub DCS-bound modules BEFORE importing app.routes / app.auth ----------

_fake_values = {
    "app.allowed_filenames": ["retribution_nextturn.miz"],
    "app.allowed_max_size": 0,
    "users": [{"username": "u", "password": "p"}],
}


class _FakeConfig:
    @staticmethod
    def get(key: str) -> object:
        return _fake_values[key]


_fake_config = types.ModuleType("app.config")
_fake_config.Config = _FakeConfig  # type: ignore[attr-defined]
sys.modules["app.config"] = _fake_config


class _FakeDCSControl:
    state_json = Path("state.json")

    @staticmethod
    def get_status() -> None:
        # None -> /status reports "stopped"; the value is irrelevant to the
        # rate-limit behaviour under test.
        return None


_fake_control = types.ModuleType("app.control")
_fake_control.DCSControl = _FakeDCSControl  # type: ignore[attr-defined]
sys.modules["app.control"] = _fake_control

# Now safe to import the real limiter + routes.
from app.limiter import DEFAULT_RATE_LIMIT, STATUS_RATE_LIMIT, limiter  # noqa: E402
from app.routes import router_api_v1  # noqa: E402

_AUTH = {"Authorization": "Basic " + b64encode(b"u:p").decode()}


def _make_client() -> TestClient:
    limiter.reset()
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(
        RateLimitExceeded,
        lambda request, exc: JSONResponse(
            status_code=429, content={"detail": "Rate limit exceeded"}
        ),
    )
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(router_api_v1)
    return TestClient(app)


def test_default_limit_is_100_per_hour() -> None:
    """An ordinary route keeps the 100/hour default (sanity check)."""
    assert DEFAULT_RATE_LIMIT == "100/hour"
    client = _make_client()
    codes = [
        client.get("/api/v1/auth/validate", headers=_AUTH).status_code
        for _ in range(130)
    ]
    assert codes.count(200) == 100
    assert 429 in codes
    assert codes.index(429) == 100  # first 429 is the 101st request


def test_status_poll_is_not_throttled_by_default_limit() -> None:
    """
    The regression: /status must survive far more than 100 polls. 150 here is
    well past the old 100/hour ceiling but under STATUS_RATE_LIMIT.
    """
    client = _make_client()
    codes = [
        client.get("/api/v1/status", headers=_AUTH).status_code for _ in range(150)
    ]
    assert all(c == 200 for c in codes), f"unexpected non-200s: {set(codes)}"


def test_status_rate_limit_value() -> None:
    """STATUS_RATE_LIMIT comfortably exceeds the 3s transition poll (1200/hr)."""
    assert STATUS_RATE_LIMIT == "3800/hour"
