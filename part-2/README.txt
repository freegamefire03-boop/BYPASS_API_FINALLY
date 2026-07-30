===============================================================================
 part-2/ — AI Response Watcher (Part 2 of the Extension)
===============================================================================

Part 2 is a CDP-injectable DOM watcher that monitors AI chat pages for
streaming responses, waits for stability, and extracts the final text.

===============================================================================
FOLDER STRUCTURE
===============================================================================

part-2/
  README.txt                          ← this file
  review-prompt-for-ai.txt            ← paste into AI chat for code review
  plan/
    synthesis.txt                     ← 17-section implementation plan
    (copied from answers/prompt-4/)
  discussion/
    deepseek-response.txt             ← DeepSeek Round 4 response
    gemini-response.txt               ← Gemini Round 4 response
    qwen-response.txt                 ← Qwen Round 4 response
    z-ai-response.txt                 ← Z.ai Round 4 response
    (copied from answers/prompt-4/)
  implementation/
    watcher-code.txt                  ← full Part 2 source code from background.js
    popup-update.txt                  ← popup.js changes for response display
    (extracted from background.js, popup.js)

===============================================================================
CORE ARCHITECTURE
===============================================================================

injectResponseWatcher(prompt) — serialized via .toString(), injected via
CDP Runtime.evaluate with awaitPromise:true. Runs in PAGE CONTEXT.

  4-phase state machine:
    WAITING    → polls body.innerText.length only
    STREAMING  → polls length; stability at 3s / 8s (thinking)
    LOCKED     → re-scans DOM; requires LOCK_STREAK=3 consecutive matches
    COMPLETE   → resolve Promise with {text, wordCount, confidence, ...}

  Fallback chain for text extraction:
    1. locked container (innerText with junk hidden)
    2. deltaDiff(bodyText, prompt) — strip prompt from full text
    3. full body.innerText

readResponse(tabId, logger) — called at 4 integration points:
  - sendToActivatedTab initial send success
  - recheckFailedTab Stage 3 retry success
  - stealthSendToTab initial send success
  - stealthRecheckFailedTab Stage 3 retry success

===============================================================================
CONSTANTS (tunable)
===============================================================================

  MAX_WAIT        120000 ms    safety timeout
  POLL_MS         500 ms       poll interval
  STABILITY_MS    3000 ms      stable text threshold (normal)
  THINKING_MS     8000 ms      stable text threshold (thinking mode)
  FORCE_BYPASS_MS 5000 ms      force-finish after streaming starts
  SCORE_THRESHOLD 600          minimum DOM candidate score
  LOCK_STREAK     3            consecutive matches before finalizing

===============================================================================
TARGET SITES
===============================================================================

  - DeepSeek  (chat.deepseek.com)
  - Z.ai      (z.ai / chatglm.cn)
  - Kimi      (kimi.moonshot.cn)
  - Perplexity (perplexity.ai)

  (Gemini and Qwen skipped per user preference)

===============================================================================
