#!/usr/bin/env python3
"""Unit harness for _emit_clarify_inline (TUI clarify inline rendering).

Exercises the pure-rendering method directly — no prompt_toolkit app needed —
by capturing what it passes to _cprint. Covers every branch: single-choice,
multi-select, freetext/open-ended, long-question truncation, long-choice
truncation, and the env-gate (off = no output).

Run:  python3 tests/test_clarify_inline.py
"""
import io
import os
import sys
import contextlib

# Ensure the cli module is importable.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cli as climod  # noqa: E402


class CaptureCLI:
    """Minimal stand-in: bind the real method to a fake self and capture output."""

    def __init__(self):
        self.captured = io.StringIO()

    # The method under test only uses these from its "self":
    _emit_clarify_inline = climod.HermesCLI._emit_clarify_inline.__get__(None, object) if False else None


def build_stub():
    """Create a bare object with the real method bound to it."""

    class Stub:
        pass

    stub = Stub()
    # Bind the unbound function from HermesCLI onto the stub instance.
    type(stub)._emit_clarify_inline = climod.HermesCLI._emit_clarify_inline
    return stub


def run_case(name, question, choices, multi_select, freetext, expect_substrings, env_on=True):
    os.environ["HERMES_CLARIFY_INLINE"] = "1" if env_on else "0"
    stub = build_stub()

    # Patch module-level _cprint to capture instead of printing.
    original_cprint = climod._cprint
    captured = io.StringIO()

    def fake_cprint(text):
        captured.write(text)

    climod._cprint = fake_cprint
    try:
        stub._emit_clarify_inline(question, choices, multi_select, freetext)
    finally:
        climod._cprint = original_cprint

    out = captured.getvalue()
    failures = []
    for sub in expect_substrings:
        if sub not in out:
            failures.append(f"MISSING substring: {sub!r}")

    status = "PASS" if not failures else "FAIL"
    print(f"[{status}] {name}" + ("" if not failures else "  -> " + "; ".join(failures)))
    if failures:
        print("    --- captured output ---")
        for line in out.splitlines():
            print(f"    | {line}")
        print("    -----------------------")
    return not failures


def main():
    results = []

    # 1. Single-choice: question + both choices + Other + hint present.
    results.append(run_case(
        "single-choice",
        "Which model should I use for this task?",
        ["Ornith", "Genesis", "DeepSeek"], False, False,
        expect_substrings=["Hermes needs your input", "Which model should I use",
                           "1. Ornith", "2. Genesis", "3. DeepSeek", "Other (type your answer)",
                           "Press a number to pick"],
    ))

    # 2. Multi-select: hint changes, checkboxes implied.
    results.append(run_case(
        "multi-select",
        "Pick the features to enable?",
        ["Logs", "Alerts", "Backups"], True, False,
        expect_substrings=["Pick the features to enable", "1. Logs",
                           "Press a number to toggle, Enter when done."],
    ))

    # 3. Freetext / open-ended: no choices, type instruction.
    results.append(run_case(
        "freetext",
        "What's the best approach here?",
        [], False, True,
        expect_substrings=["What's the best approach here?",
                           "Type your answer below, then press Enter."],
    ))

    # 4. Long question truncates (no overflow past ~76 chars on the q line).
    long_q = "Q" * 200
    results.append(run_case(
        "long-question-truncate",
        long_q, ["A"], False, False,
        expect_substrings=["…"],  # ellipsis marker present
    ))

    # 5. Long choice truncates.
    long_c = "C" * 200
    results.append(run_case(
        "long-choice-truncate",
        "Short?", [long_c], False, False,
        expect_substrings=["1. ", "…"],
    ))

    # 6. Env gate OFF: nothing emitted (captured output should be empty).
    out_off = run_case(
        "env-gate-off",
        "Should I proceed?", ["Yes", "No"], False, False,
        expect_substrings=[],  # expect NO required substrings
        env_on=False,
    )
    # Explicitly assert the off case produced zero output.
    os.environ["HERMES_CLARIFY_INLINE"] = "0"
    stub = build_stub()
    original_cprint = climod._cprint
    captured = io.StringIO()
    climod._cprint = lambda t: captured.write(t)
    try:
        stub._emit_clarify_inline("Should I proceed?", ["Yes", "No"], False, False)
    finally:
        climod._cprint = original_cprint
    env_gate_pass = captured.getvalue() == ""
    print(f"[{'PASS' if env_gate_pass else 'FAIL'}] env-gate-off emitted nothing"
          + ("" if env_gate_pass else f"  -> got {captured.getvalue()!r}"))
    results.append(env_gate_pass)

    print()
    passed = sum(results)
    total = len(results)
    print(f"{passed}/{total} cases passed")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
