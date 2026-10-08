"""Regression: _sess_nowait must resolve a stored DB session_key to the live runtime session.

Phone/dashboard clients legitimately address sessions by their stored DB key. A runtime-dict-only
lookup returned 4001 "session not found" even while the session was live — file.attach then failed
in a loop (2026-10-08): session.resume succeeded (liveSid=63bdffd1), the attach retry sent the DB
key, and the server answered 4001 again.

Contract (2-tuple preserved, params canonicalized in place):
  1. live runtime sid → (session, None), params.session_id unchanged
  2. stored session_key → (session, None), params.session_id REWRITTEN to the live runtime sid
     (so _sess_building/_start_agent_build target the live record)
  3. unknown id → (None, 4001)
"""

import sys
import types
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def server():
    with patch.dict("sys.modules", {
        "hermes_constants": MagicMock(get_hermes_home=MagicMock(return_value="/tmp/hermes_test")),
        "hermes_cli.env_loader": MagicMock(),
        "hermes_cli.banner": MagicMock(),
        "hermes_state": MagicMock(),
    }):
        import importlib
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        for attr in ("_sessions", "_pending", "_answers"):
            d = getattr(mod, attr, None)
            if isinstance(d, dict):
                d.clear()


DB_KEY = "20261007_042108_521587"
LIVE_SID = "63bdffd1"


def _live_session(mod):
    mod._sessions[LIVE_SID] = {"agent": None, "session_key": DB_KEY}


class TestSessNowaitKeyResolution:
    def test_db_key_resolves_and_canonicalizes(self, server):
        _live_session(server)
        params = {"session_id": DB_KEY}
        s, err = server._sess_nowait(params, "r1")
        assert err is None
        assert s is server._sessions[LIVE_SID]
        assert params["session_id"] == LIVE_SID

    def test_live_sid_direct_lookup_unchanged(self, server):
        _live_session(server)
        params = {"session_id": LIVE_SID}
        s, err = server._sess_nowait(params, "r2")
        assert err is None
        assert s is server._sessions[LIVE_SID]
        assert params["session_id"] == LIVE_SID

    def test_unknown_returns_4001(self, server):
        params = {"session_id": "nonexistent"}
        s, err = server._sess_nowait(params, "r3")
        assert s is None
        assert err["error"]["code"] == 4001
        assert params["session_id"] == "nonexistent"

    def test_sess_building_warms_live_record_not_db_key(self, server, monkeypatch):
        """_sess_building's _start_agent_build receives the canonical live sid when the caller
        addressed the DB key — the warm-build path must target the live record."""
        server._sessions[LIVE_SID] = {
            "agent": None,
            "running": False,
            "history": [],
            "history_lock": __import__("threading").Lock(),
            "session_key": DB_KEY,
        }
        built = []
        monkeypatch.setattr(server, "_start_agent_build",
                            lambda sid, s: built.append(sid))
        params = {"session_id": DB_KEY}
        s, err = server._sess_building(params, "r4")
        assert err is None
        assert built == [LIVE_SID]
