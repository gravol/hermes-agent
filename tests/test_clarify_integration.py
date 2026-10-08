#!/usr/bin/env python3
"""Integration smoke test: _clarify_callback end-to-end (no human input).

Verifies the full path works:
  - HERMES_CLARIFY_INLINE=1 emits the inline block via _cprint.
  - The blocking poll loop resolves when we feed an answer into
    _clarify_state["response_queue"] (simulating a key press from another thread).
  - Timeout path returns the "agent will decide" notice.

Drives response_queue directly after polling for _clarify_state — no race,
no real prompt_toolkit app (which would deadlock on a non-event-loop thread).

Run:  HERMES_CLARIFY_INLINE=1 python3 tests/test_clarify_integration.py
"""
import os
import sys
import time
import types
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cli as climod


def build_stub():
    class Stub:
        pass
    stub = Stub()
    for meth in ["_clarify_callback", "_paint_now", "_persist_prompt_summary",
                 "_emit_clarify_inline"]:
        fn = getattr(climod.HermesCLI, meth, None)
        if fn is not None:
            setattr(stub, meth, types.MethodType(fn, stub))
    stub._app = None  # _paint_now no-ops cleanly; avoids prompt_toolkit thread deadlock
    return stub


def drive_answer_after(stub, answer, delay=1.0):
    """Poll for _clarify_state['response_queue'] and put the answer into it."""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        st = getattr(stub, "_clarify_state", None)
        if st is not None and "response_queue" in st:
            st["response_queue"].put(answer)
            return True
        time.sleep(0.02)
    return False


def test_resolves_via_queue():
    os.environ["HERMES_CLARIFY_INLINE"] = "1"
    stub = build_stub()

    captured = []
    orig = climod._cprint
    climod._cprint = lambda t: captured.append(str(t))

    box = {}

    def call():
        box["r"] = stub._clarify_callback(
            "Which model?", ["Ornith", "Genesis", "DeepSeek"],
            multi_select=False, questions=None,
        )

    t = threading.Thread(target=call, daemon=True)
    t.start()
    # Feed the answer shortly after the callback starts polling.
    threading.Thread(
        target=drive_answer_after, args=(stub, "Genesis", 0.5), daemon=True
    ).start()
    t.join(timeout=10)

    climod._cprint = orig

    if t.is_alive():
        print("[FAIL] resolve-via-queue: callback thread hung (timeout)")
        return False

    emitted = "\n".join(captured)
    ok = (box.get("r") == "Genesis"
          and "Hermes needs your input" in emitted
          and "1. Ornith" in emitted
          and "2. Genesis" in emitted
          and "3. DeepSeek" in emitted
          and "? Clarify: Which model? → Genesis" in emitted)
    print(f"[{'PASS' if ok else 'FAIL'}] resolves via queue with inline block")
    if not ok:
        print(f"    result={box.get('r')!r}")
        for ln in emitted.splitlines():
            print(f"    | {ln[:90]}")
    return ok


def test_timeout():
    os.environ["HERMES_CLARIFY_INLINE"] = "1"
    import tools.clarify_gateway as cg
    cg.resolve_clarify_timeout = lambda cfg: 1  # force a 1s timeout

    stub = build_stub()
    captured = []
    orig = climod._cprint
    climod._cprint = lambda t: captured.append(str(t))

    box = {}

    def call():
        box["r"] = stub._clarify_callback(
            "Should I proceed?", ["Yes", "No"], multi_select=False, questions=None,
        )

    t = threading.Thread(target=call, daemon=True)
    t.start()
    t.join(timeout=10)  # no answer fed → should time out at 1s
    climod._cprint = orig

    ok = "time limit" in str(box.get("r", "")).lower()
    print(f"[{'PASS' if ok else 'FAIL'}] timeout returns decide-on-own notice")
    if not ok:
        print(f"    result={box.get('r')!r}")
    return ok


def main():
    r1 = test_resolves_via_queue()
    r2 = test_timeout()
    print()
    passed = sum([r1, r2])
    print(f"{passed}/{len([r1, r2])} integration cases passed")
    sys.exit(0 if passed == len([r1, r2]) else 1)


if __name__ == "__main__":
    main()
