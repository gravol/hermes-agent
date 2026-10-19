"""Frame-trace joinability (Phase 1): gateway-minted connection ids (cid), connect/close pairs,
per-frame write results (queued vs written, byte count, exception class), and the stream-ownership
assertion helper.

The failing Android trial routed 424 frames to a session transport while the prompt arrived on a
different socket of the same phone; these tests pin the log features needed to answer "which socket
owned this sid, and did the bytes actually reach the wire" — everything the gateway CAN observe,
with payload content still excluded.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from types import SimpleNamespace

from tui_gateway import server
from tui_gateway import ws as ws_mod


# ---------------------------------------------------------------- harness --

class _CidTransport:
    """Minimal stand-in carrying only what the trace helpers read (``cid``)."""

    def __init__(self, cid: str) -> None:
        self.cid = cid

    def write(self, obj: dict) -> bool:
        return True


def _trace_file(tmp_path, monkeypatch):
    path = tmp_path / "frames.log"
    monkeypatch.setattr(server, "_FRAME_TRACE_PATH", str(path))
    return path


def _lines(path):
    return [ln for ln in path.read_text().splitlines() if ln.strip()]


def _run_loop_in_thread():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    return loop, thread


def _wait_until(predicate, timeout=5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


# ------------------------------------------------------------------- (1) identity --

def test_bind_and_route_lines_stamp_cid(tmp_path, monkeypatch):
    """rebind/detach/route lines keep ``transport=`` and gain the connection's ``cid=``;
    transports without a cid (drop sentinel, stdio) print ``cid=-``."""
    path = _trace_file(tmp_path, monkeypatch)
    phone = _CidTransport("cafe1234ab")
    sid = "sess-abcdef01"

    server._trace_bind(sid, "rebind", phone, "attach")
    server._trace_frame(
        sid, {"jsonrpc": "2.0", "method": "event",
              "params": {"type": "session.turn.started", "seq": 7}},
        "session_transport", transport=phone)
    server._trace_bind(sid, "detach", server._detached_ws_transport, "ws_disconnect")

    rebind, route, detach = _lines(path)
    assert f"cid={phone.cid}" in rebind and "transport=" in rebind and "reason=attach" in rebind
    assert "route=session_transport" in route and "cid=cafe1234ab" in route and "seq=7" in route
    assert "cid=-" in detach and "reason=ws_disconnect" in detach


def test_connect_close_pair_echoes_cid_to_client(tmp_path, monkeypatch):
    """handle_ws mints a cid, echoes it in gateway.ready (so the client can echo it back), and
    brackets the connection with connect/close trace lines carrying peer + reason."""
    path = _trace_file(tmp_path, monkeypatch)
    sent: list[dict] = []

    class FakeWS:
        client = SimpleNamespace(host="127.0.0.1", port=5555)
        scope: dict = {}

        async def accept(self):
            pass

        async def send_text(self, line):
            sent.append(json.loads(line))

        async def receive_text(self):
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))

    ready = next(f for f in sent if f.get("params", {}).get("type") == "gateway.ready")
    cid = ready["params"]["payload"]["connection_id"]
    assert re.fullmatch(r"[0-9a-f]{10}", cid), cid  # short, stable, hex

    lines = _lines(path)
    connect = next(ln for ln in lines if " connect " in ln)
    close = next(ln for ln in lines if " close " in ln)
    assert f"cid={cid}" in connect and "peer=127.0.0.1:5555" in connect
    assert f"cid={cid}" in close and "reason=client_disconnect" in close


# ------------------------------------------------------------- (2) write results --

def test_write_json_route_line_then_written_result(tmp_path, monkeypatch):
    """write_json emits the enqueue-time route line (cid, seq, type) and — with
    HERMES_TUI_FRAME_WRITE_TRACE=1 — a write_done line carrying the real socket outcome."""
    path = _trace_file(tmp_path, monkeypatch)
    monkeypatch.setenv("HERMES_TUI_FRAME_WRITE_TRACE", "1")
    loop, thread = _run_loop_in_thread()
    sent: list[str] = []

    class FakeSocketWS:
        async def send_text(self, payload):
            sent.append(payload)

    try:
        t = ws_mod.WSTransport(FakeSocketWS(), loop, peer="test", cid="beef0000ff")
        server._sessions.clear()
        server._sessions["trace-sid"] = {"transport": t}
        try:
            ok = server.write_json({"jsonrpc": "2.0", "method": "event",
                                    "params": {"type": "session.turn.completed", "session_id": "trace-sid"}})
        finally:
            server._sessions.clear()
        assert ok is True
        # The frame really reached the fake socket (the loop thread performed the send).
        assert _wait_until(lambda: bool(sent)), "frame never reached the socket"
        assert t.last_write_result["outcome"] == "written"

        lines = _lines(path)
        route = next(ln for ln in lines if "route=session_transport" in ln)
        done = next(ln for ln in lines if "write_done" in ln)
        assert "cid=beef0000ff" in route and re.search(r"seq=\d+", route)
        assert "cid=beef0000ff" in done and "outcome=written" in done and "ok=1" in done
        nbytes = int(re.search(r"bytes=(\d+)", done).group(1))
        assert nbytes == len(sent[0].encode("utf-8")) > 0
    finally:
        server._sessions.clear()
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


def test_queued_token_rebind_and_batch_completion_are_joinable(tmp_path, monkeypatch):
    """A coalesced token is recorded as queued at enqueue time; its completion arrives later as a
    ws_batch line on the same cid. A rebind landing between the two stays visible BETWEEN them."""
    path = _trace_file(tmp_path, monkeypatch)
    monkeypatch.setenv("HERMES_TUI_FRAME_WRITE_TRACE", "1")
    loop, thread = _run_loop_in_thread()
    sent: list[str] = []

    class FakeSocketWS:
        async def send_text(self, payload):
            sent.append(payload)

    try:
        t = ws_mod.WSTransport(FakeSocketWS(), loop, peer="test", cid="cafe000001")
        tok = {"jsonrpc": "2.0", "method": "event",
               "params": {"type": "message.delta", "session_id": "s", "payload": "x"}}
        # Called off the loop thread: the token is buffered (queued), NOT yet on the wire.
        assert t.write(tok) is True
        info = t.last_write_result
        assert info["outcome"] == "queued" and info["qdepth"] == 1 and info["bytes"] > 0

        server._trace_frame("s", tok, "session_transport", transport=t)   # enqueue-time record
        server._trace_bind("s", "rebind", t, "attach")                    # rebind lands in between
        # The coalesce timer flushes on the loop → ws_batch completion line, same cid.
        assert _wait_until(lambda: any("ws_batch" in ln for ln in _lines(path))), "no completion line"

        lines = _lines(path)
        i_enq = next(i for i, ln in enumerate(lines) if "route=session_transport" in ln)
        i_reb = next(i for i, ln in enumerate(lines) if "rebind" in ln)
        i_done = next(i for i, ln in enumerate(lines) if "ws_batch" in ln)
        assert i_enq < i_reb < i_done, lines
        assert all("cid=cafe000001" in lines[i] for i in (i_enq, i_reb, i_done))
        batch = lines[i_done]
        assert "frames=1" in batch and "outcome=written" in batch
        assert int(re.search(r"bytes=(\d+)", batch).group(1)) == len(sent[0].encode("utf-8")) > 0
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


def test_write_trace_lines_are_off_by_default(tmp_path, monkeypatch):
    """Without HERMES_TUI_FRAME_WRITE_TRACE the route line still carries cid=, but no
    write_done/ws_batch volume is added."""
    monkeypatch.delenv("HERMES_TUI_FRAME_WRITE_TRACE", raising=False)
    path = _trace_file(tmp_path, monkeypatch)
    loop, thread = _run_loop_in_thread()

    class FakeSocketWS:
        async def send_text(self, payload):
            pass

    try:
        t = ws_mod.WSTransport(FakeSocketWS(), loop, peer="test", cid="off0000000")
        server._sessions.clear()
        server._sessions["off-sid"] = {"transport": t}
        try:
            assert server.write_json({"jsonrpc": "2.0", "method": "event",
                                      "params": {"type": "session.turn.completed", "session_id": "off-sid"}})
        finally:
            server._sessions.clear()
        assert _wait_until(lambda: bool(t.last_write_result))  # record kept regardless of tracing
        lines = _lines(path)
        assert any("route=session_transport" in ln and "cid=off0000000" in ln for ln in lines)
        assert not any("write_done" in ln or "ws_batch" in ln for ln in lines)
    finally:
        server._sessions.clear()
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


# ------------------------------------------------------------ (3) ownership --

def test_trace_stream_ownership_reports_owner_and_viewer_cids(tmp_path, monkeypatch):
    """The assertion helper names the owning cid and every registered viewer cid from
    ``session["viewers"]``, emits an ownership trace line, and never mutates routing state."""
    path = _trace_file(tmp_path, monkeypatch)
    owner, viewer = _CidTransport("own0000001"), _CidTransport("view000002")
    session = {"transport": owner, "viewers": {owner: 1.0, viewer: 2.0}}
    server._sessions.clear()
    try:
        server._sessions["own-sid"] = session
        info = server.trace_stream_ownership("own-sid")  # published by session_lifecycle.register()
        missing = server.trace_stream_ownership("gone-sid")
    finally:
        server._sessions.clear()

    assert info["live"] is True and info["owner_cid"] == "own0000001"
    assert info["viewers"] == 2 and sorted(info["viewer_cids"]) == ["own0000001", "view000002"]
    assert missing["live"] is False and missing["owner_cid"] == "-" and missing["viewer_cids"] == []
    # Nothing changed: still the same owner/viewer registrations.
    assert session["transport"] is owner and len(session["viewers"]) == 2

    line = next(ln for ln in _lines(path) if " ownership " in ln)
    assert "owner_cid=own0000001" in line and "viewers=2" in line
    assert "view000002" in line
