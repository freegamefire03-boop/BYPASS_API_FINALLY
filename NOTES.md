# Stealth Mode — Planned Changes

## Goals
1. Remove all unnecessary delays between actions
2. Correct the verification logic
3. Add a retry fallback for failed tabs

---

### 1. Remove delays

Current delays to eliminate or minimize:
- `delay(500)` before `waitForTabComplete` → remove, let the listener handle it
- `delay(1200)` after tab complete → remove or reduce to ~300ms max
- `delay(300)` after DOM.focus → remove
- `delay(600)` after Input.insertText → reduce to ~100ms or remove
- `delay(30)` between keyDown and keyUp → remove
- `delay(300)` before retry verify in Stage 3 → remove
- `delay(2000)` in stealthRecheckFailedTab settle → remove or replace with event-driven wait

### 2. Correct verification logic

Problems with current `verifySend`:
- Two-stage (URL change → input cleared) is fragile
- URL check only polls 1.5s — might miss async navigation
- Input cleared check relies on `getMarkedInputContent` which queries DOM

New approach (to be designed):
- Single signal: detect when the AI has finished generating (our future Part A)
- Or: watch for the site's "stop generating" button to disappear
- Or: listen for the input becoming enabled again

### 3. Retry fallback for failed tabs

When `needsRecheck = true` and `stealthRecheckFailedTab` fails:
1. Close the failed tab
2. Open a fresh tab to the same URL
3. Wait for full page load (or up to 3-6s timeout, whichever comes first)
4. Re-run the full stealth workflow (DOM search → focus → insertText → Enter → verify)
5. If it fails again, mark as permanent error (no infinite loop)

This replaces the current Stage 3 (Enter retry) which only re-presses Enter without re-opening the tab.

---

# Known Limitations

## Qwen not responding (investigate later)

Qwen sometimes returns no response — probably due to late loading of the chat UI/input or slow init on the site. Not blocking; defer investigation to a later session.

## 120s Marker Watcher Timeout

The marker-based watcher (`MARKER_MAX_WAIT_MS = 120000`) hard-fails if the AI hasn't output both `APSTART-{code}` and `APEND-{code}` markers within 2 minutes.

**Why this matters:** Long-reasoning models (thinking mode, chain-of-thought, multi-step agents) can take >2 minutes to begin their visible response. The watcher will report `markers not found` even though the AI is still working.

**Possible fixes (future):**
- Increase the timeout (cost: longer wait before failing on genuinely stuck tabs)
- Add a dynamic "still thinking" detector (e.g., monitor for UI signals like a blinking cursor, "thinking..." label, or streaming activity) that extends the deadline
- Use a site-specific heuristic to detect generation-in-progress vs idle
