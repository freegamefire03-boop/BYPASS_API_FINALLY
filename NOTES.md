# Notes

## 1 — Parallel tab processing idea (unresolved)

**Goal:** Instead of cycling tabs sequentially (activate tab 1 → detect input → send → verify → move to tab 2), find a way to "wake up" all tabs in rapid succession so the extension can do the actual work while tabs are backgrounded.

**The blocker (confirmed):** Chrome's `Input.dispatchKeyEvent` (CDP via `chrome.debugger`) only delivers trusted keystrokes to the **active** tab. Background tabs silently drop them. This isn't a bug — it's how Chrome's input pipeline is designed.

**What we already tried that doesn't work:**
- Sending Enter to background tabs via debugger → ignored by Chrome
- Using content scripts to dispatch synthetic events → untrusted, sites ignore them

**The idea:** Maybe we only need the tab to be active during the Enter keystroke (a few ms), not during the full focus-detect + insertText + verify cycle. If `Input.insertText` works on background tabs (it injects text directly into the DOM, not via the input pipeline), we could:
  1. Rapidly flash each tab to the front (just to deliver Enter)
  2. Do everything else (insertText, verification) while backgrounded

**Unknowns / needs investigation:**
- Does `Input.insertText` work on background tabs? (It injects text directly, not via keystrokes — so it might work.)
- Does `chrome.scripting.executeScript` (for focus detection, input marking, content reading) work on background tabs? (It should — it's not input-related.)
- Can we reduce the "active" window to a sub-100ms flash per tab just for the Enter key?

**If this works,** the auto-cycle mode could be: activate tab → wait 0ms → send Enter → deactivate → move on. All the slow parts (waitForFocusedInput, Tab navigation fallback, insertText delay, verifySend) run in the background. This would make auto-cycle nearly as fast as parallel experimental mode.

**Status:** Blurry / not yet investigated. Needs prototyping and testing.

## 2 — Extension must work with Chrome minimized (priority)

**Requirement:** The extension should work correctly when Chrome is minimized. No part of the flow should depend on the window being visible or having focus.

**Current state:** `sendToActivatedTab` calls `chrome.windows.update(tab.windowId, { focused: true })` to bring the window forward. If Chrome is minimized, this call might behave unexpectedly (e.g., the window becomes unminimized but stays behind other apps, or the activation fails silently).

**What needs checking:**
- Does `chrome.windows.update` work when Chrome is minimized? Does it restore the window?
- Does `Page.bringToFront` via debugger work on a minimized window?
- Does focus detection (`document.activeElement` polling via `executeScript`) work on backgrounded tabs? (It should — `executeScript` is not input-related.)
- Does `Input.insertText` work on background tabs? (Direct DOM injection — should work.)
- Does `Input.dispatchKeyEvent` (Enter) require the window to be in focus, or just the tab to be active?

**If `dispatchKeyEvent` requires the window to be focused** (not just the tab active), then we genuinely cannot send Enter while minimized. In that case the minimum requirement is: Chrome just needs to be a normal (not minimized) window — it doesn't need to be the OS foreground window.

**Priority:** High — a core usability requirement.

## 3 — Verification must work on background tabs (status false-positive fix)

**Observed bug:** Sometimes 1-2 tabs show as failed (red dot) even though the prompt was actually sent. The suspected cause is that the extension navigates away from the tab (activates the next tab) *before* `verifySend` finishes polling.

**Current flow in auto-cycle mode:**
1. Activate tab N
2. `sendTextThenEnter(tabId, prompt)` — sends to tab N
3. `verifySend(tabId, url, logger)` — polls URL + input content on tab N for ~3s total
4. Detach debugger, move to tab N+1 → activates tab N+1

**The problem:** When tab N+1 is activated, `chrome.tabs.get(tabId)` in `verifySend` for tab N still works (it's not tab-specific), but `getMarkedInputContent` uses `executeScript` to query `[data-autoprompt-input="true"]` on tab N. If Chrome decides that a background tab's `executeScript` is deprioritized or queued, the polling might get delayed results or fail.

**Potential fixes:**

**Option A — Verify in background** (preferred):
- `chrome.scripting.executeScript` should work on any tab regardless of active state — it's not input. If it does, then verification is already non-dependent on tab focus, and the false failures might be a race condition with the debugger detach or tab navigation.
- Needs testing: does `executeScript` on a background tab return promptly and accurately?

**Option B — Second pass (dedicated verification cycle):**
- After the main send cycle completes, make a second pass over all tabs: activate each one again briefly just to run `verifySend` while it's the active tab.
- This adds ~3s × N tabs to total runtime but eliminates the race condition.

**Option C — Move verification to background mode (only works if Option A is confirmed):**
- Keep the send cycle as-is (rapidly flash tabs for Enter only).
- After all sends are done, run all `verifySend` calls in parallel (they use `executeScript`, which should work on backgrounded tabs).
- This would be the fastest approach if `executeScript` on background tabs works reliably.

**Priority:** High — fixes false failure reports that undermine trust in the tool.

## 4 — Stage 1 early-fail gap: no recovery when prompt was never written

**Observed gap:** If the initial send stage fails *before or during* `sendTextThenEnter`, the tab is permanently skipped with no recovery path. Specifically:

- **Focus detection fails** (`sendToActivatedTab` line 649): returns early with `{ status: 'error' }`. No `markInputElement`, no `needsRecheck`. Tab never enters re-check queue.
- **`sendTextThenEnter` throws** after `markInputElement` (catch block line 675): cleans up the input mark, sets `{ status: 'error' }`, does **not** set `needsRecheck`. Tab is written off even though `insertText` may have partially succeeded (text in input, Enter never sent).
- **`sendTextThenEnter` succeeds, verification fails, input is empty by Stage 2:** Stage 2 `verifySend` re-runs but the input is already cleared (or the marked element no longer exists) → returns false. Stage 3 checks `getMarkedInputContent` → returns `null` or `''` → skips itself. Tab remains as error with no further rescue.

**Consequence:** Any failure that prevents the prompt from reaching the input box (focus miss, debugger disconnect, tab crash, SPA navigation that blows away the DOM after marking) is terminal — the 3-stage rescue ladder never engages.

**Possible fix directions:**

1. **Bypass Stage 3 text check** — If the marked input exists but is empty, the prompt was either consumed (success!) or was never written. Try re-sending the prompt text before retrying Enter.
2. **Last-resort re-send** — For tabs where `needsRecheck` was never set but the tabId is valid and the tab is still alive, attempt a full re-send (focus detect → insertText → Enter → verify) as a final pass.
3. **Set `needsRecheck` in the catch block** — If `sendTextThenEnter` throws, keep the mark (don't clean up) and set `needsRecheck = true` so the re-check phase at least tries.

**Status:** Gap identified but not yet addressed. Needs scoping before implementation.

