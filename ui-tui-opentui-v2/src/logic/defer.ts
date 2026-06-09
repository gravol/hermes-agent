/**
 * deferClose — defer an overlay/prompt close by one tick.
 *
 * Overlays REPLACE the composer (a `<Switch>`), so when one closes the composer
 * remounts + refocuses. Running the close on the NEXT tick lets the current
 * key/close event (Esc/q/Enter/y/select) finish dispatching first, so the
 * keystroke that triggered the close can't leak into the freshly-focused
 * composer (e.g. `/clear`→y once left a stray "y" in the input).
 */
export function deferClose(fn: () => void): void {
  setTimeout(fn, 0)
}
