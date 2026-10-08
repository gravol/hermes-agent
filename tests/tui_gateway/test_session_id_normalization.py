"""Regression tests for session ID normalization.

Phase 4G: _sess_nowait must resolve DB session keys to live sids
so that downstream operations (prompt.submit, _start_agent_build, etc.)
always use the canonical short live sid.

Validates:
  1. _sess_nowait with DB session key → resolves to live sid
  2. _sess_nowait with live sid → direct lookup works
  3. _sess_nowait unknown session → 4001 error
  4. _sess() normalizes sid before calling _start_agent_build
  5. session.resume returns a short live sid, not the DB key
"""

import sys
import threading
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
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


class TestSessionIdNormalization:

    DB_KEY = "20260717_144557_ffb16939"
    LIVE_SID = "p4g_test_live_001"

    # ── _sess_nowait 3-tuple contract ──────────────────────────────

    def test_sess_nowait_db_key_resolves_to_live_sid(self, server):
        """_sess_nowait with DB session key resolves to the live sid."""
        server._sessions[self.LIVE_SID] = {
            "agent": None,
            "session_key": self.DB_KEY,
        }
        session, resolved_sid, err = server._sess_nowait(
            {"session_id": self.DB_KEY}, "r1"
        )
        assert err is None
        assert resolved_sid == self.LIVE_SID, (
            f"resolved_sid={resolved_sid}, expected {self.LIVE_SID}"
        )

    def test_sess_nowait_live_sid_direct_lookup(self, server):
        """_sess_nowait with live sid returns it unchanged."""
        server._sessions[self.LIVE_SID] = {
            "agent": None,
            "session_key": self.DB_KEY,
        }
        session, resolved_sid, err = server._sess_nowait(
            {"session_id": self.LIVE_SID}, "r1"
        )
        assert err is None
        assert resolved_sid == self.LIVE_SID

    def test_sess_nowait_unknown_session_returns_4001(self, server):
        """Unknown session returns error 4001."""
        _, _, err = server._sess_nowait(
            {"session_id": "nonexistent"}, "r1"
        )
        assert err is not None
        assert err["error"]["code"] == 4001

    # ── _sess() normalization ──────────────────────────────────────

    def test_sess_normalizes_id_before_start_agent_build(self, server, monkeypatch):
        """_sess() passes resolved live sid to _start_agent_build."""
        server._sessions[self.LIVE_SID] = {
            "agent": None,
            "running": False,
            "history": [],
            "history_lock": threading.Lock(),
            "session_key": self.DB_KEY,
        }
        built_sid = []

        def fake_start_build(sid, _session):
            built_sid.append(sid)

        monkeypatch.setattr(server, "_start_agent_build", fake_start_build)
        monkeypatch.setattr(server, "_wait_agent", lambda _s, _rid: None)

        _, err = server._sess({"session_id": self.DB_KEY}, "r1")
        assert err is None
        assert len(built_sid) == 1
        assert built_sid[0] == self.LIVE_SID, (
            f"_start_agent_build called with {built_sid[0]}, expected {self.LIVE_SID}"
        )

    # ── session.resume ─────────────────────────────────────────────

    def test_session_resume_returns_live_sid_not_db_key(self, server, monkeypatch):
        """session.resume returns a short live sid, not the DB key."""
        target = self.DB_KEY

        class _DB:
            def get_session(self, _sid):
                return {"id": target}
            def get_session_by_title(self, _title):
                return None
            def reopen_session(self, _sid):
                return None
            def get_messages_as_conversation(self, _sid, include_ancestors=False):
                return []
            def put_session(self, *_a, **_kw):
                pass

        fake_approval = types.SimpleNamespace(
            load_permanent_allowlist=lambda: None,
            register_gateway_notify=lambda *_a, **_kw: None,
        )

        monkeypatch.setattr(server, "_get_db", lambda: _DB())
        monkeypatch.setattr(
            server, "_make_agent",
            lambda *_a, **_kw: MagicMock(model="test/model", sid="sid", session_id=target),
        )
        monkeypatch.setattr(
            server, "_SlashWorker",
            lambda _key, _model: types.SimpleNamespace(close=lambda: None),
        )
        monkeypatch.setattr(
            server, "_start_notification_poller",
            lambda _sid, _session: threading.Event(),
        )
        monkeypatch.setattr(server, "_notify_session_boundary", lambda *_a, **_kw: None)
        monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
        monkeypatch.setattr(server, "_emit", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            server, "_session_info",
            lambda _agent, _session=None: {"model": "test/model"},
        )

        with patch.dict(sys.modules, {"tools.approval": fake_approval}):
            resp = server.handle_request({
                "id": "resume1",
                "method": "session.resume",
                "params": {"session_id": target},
            })

        assert "error" not in resp, f"Unexpected error: {resp.get('error')}"
        sid = resp["result"]["session_id"]
        assert len(sid) < 20, (
            f"session_id '{sid}' looks like a DB key (too long), not a live sid"
        )
        assert sid != target, (
            f"session_id should be a live sid, not the DB key '{target}'"
        )
