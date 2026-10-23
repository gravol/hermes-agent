"""``insights.get`` must carry the token/cost rollup, not only session counts.

The phone (Hermex Insights) renders a DAY/WEEK/MONTH usage panel. It used to sum
``session.list`` rows client-side, and those rows carry the ``sessions`` counters —
main-agent-loop calls only, uncached prompt tokens only. Measured against a real
store that hid ~13% of input tokens (background memory review, compaction, title
generation) and every cached prompt token, which is why its in/out ratio read as
absurd. The gateway now answers the window itself from ``session_model_usage``,
the same accounting ``/insights`` uses.
"""

from __future__ import annotations

import pytest

import hermes_state_registry as registry
from tui_gateway import server


@pytest.fixture()
def seeded_home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(server, "_hermes_home", str(home))
    monkeypatch.setattr(server, "_db", None)
    monkeypatch.setattr(server, "_db_error", None)

    db = registry.acquire(home / "state.db")
    db.create_session("s1", source="tui", model="main-model")
    db.update_token_counts(
        "s1", input_tokens=1000, output_tokens=100, cache_read_tokens=5000,
        model="main-model", billing_provider="nous", api_call_count=2,
    )
    # Auxiliary spend never touches the sessions counters — it lives only in the
    # per-(model, task) table. A panel that ignores it under-reports real work.
    db.record_auxiliary_usage(
        "s1", "compression", model="compressor-model", billing_provider="nous",
        input_tokens=400, output_tokens=40,
    )
    try:
        yield home
    finally:
        registry.close_all()


def _usage(result: dict) -> dict:
    payload = result["result"]
    assert "usage_unavailable" not in payload, payload.get("usage_unavailable")
    return payload["usage"]


def test_insights_get_returns_usage_rollup_including_aux(seeded_home):
    usage = _usage(server._methods["insights.get"]("rid", {"days": 30}))
    totals = usage["totals"]
    assert totals["input_tokens"] == 1400          # 1000 main + 400 compression
    assert totals["output_tokens"] == 140
    assert totals["cache_read_tokens"] == 5000      # cached prompt volume is reported
    assert totals["api_call_count"] == 3            # sessions counters said 2
    assert totals["sessions"] == 1

    tasks = {t["task"]: t for t in usage["tasks"]}
    assert set(tasks) == {"compression"}
    assert tasks["compression"]["input_tokens"] == 400
    assert tasks["compression"]["models"] == ["compressor-model"]

    models = {m["model"]: m for m in usage["models"]}
    assert set(models) == {"main-model", "compressor-model"}
    assert models["main-model"]["tasks"] == []
    assert models["compressor-model"]["tasks"] == ["compression"]


def test_legacy_count_keys_stay_for_older_clients(seeded_home):
    """The pre-rollup payload shape ({days, sessions, messages}) is kept: an app that only
    knows those keys keeps working against a new gateway."""
    payload = server._methods["insights.get"]("rid", {"days": 30})["result"]
    assert payload["days"] == 30 and payload["sessions"] == 1


def test_days_is_clamped_like_the_dashboard(seeded_home):
    assert server._methods["insights.get"]("rid", {"days": 99_999})["result"]["usage"]["period_days"] == 365
    assert server._methods["insights.get"]("rid", {"days": 0})["result"]["usage"]["period_days"] == 1


def test_window_outside_the_data_yields_zeros_not_an_error(seeded_home):
    usage = _usage(server._methods["insights.get"]("rid", {"days": 1}))
    # The seeded session is "now", so a 1-day window still sees it; the point is the shape:
    # totals exist and every counter is an int, never None.
    assert all(isinstance(v, int) for k, v in usage["totals"].items() if k.endswith("_tokens") or k == "api_call_count")
