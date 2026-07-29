# File Tree

```
├── .gitignore
├── background.js
├── manifest.json
├── popup.html
└── popup.js
```

# Source Files

## `.gitignore`

```
.env
.env.*
*.key
*.pem
*token*
*secret*
node_modules/
.DS_Store
*.log
```

## `background.js`

```js
// ============================================================================
// AI Chat Auto-Prompt — background service worker
//
// THE CORE PROBLEM THIS FILE SOLVES:
// Chrome only routes real, trusted input (including debugger-injected
// keystrokes via chrome.debugger's Input.dispatchKeyEvent) to the ACTIVE
// tab of a window. A background/inactive tab simply never receives it —
// this isn't a bug, it's how Chrome's input pipeline works, confirmed both
// by Chromium's own issue tracker and by real testing. So there is no way
// to deliver a genuinely trusted Ctrl+V/Enter to a tab that isn't the
// frontmost tab at that exact moment.
//
// THE FIX (default behavior): open every URL in parallel first — this part
// really is simultaneous, since loading a background tab is NOT blocked,
// only INPUT delivery is. Then, once every tab has had its chance to load,
// the extension itself rapidly cycles which tab is "active" — the exact
// same thing you were doing by hand with Ctrl+1/2/3 — briefly bringing each
// tab to the front just long enough to paste and send, then moving to the
// next one. No manual navigation needed; it's automated and near-instant
// per tab (a few hundred ms).
//
// INPUT DETECTION: Primary method polls document.activeElement for up to 8s.
// If the site doesn't auto-focus its input, a fallback kicks in: the extension
// simulates Tab keypresses (via debugger, trusted events, page-only — the
// omnibox is never reached) to walk through all focusable elements, collects
// text-input candidates, scores them (textarea > contenteditable > input,
// large > small, bottom-of-page > top-of-page), and focuses the best match.
// If both methods fail, the tab is aborted with a clear error (no blind firing).
//
// TEXT INSERTION: The prompt is injected directly into each tab's focused
// input via CDP's Input.insertText — no system clipboard is involved.
// This means the user can freely copy/paste on their PC while the
// extension runs without corrupting the prompt being sent.
//
// VERIFICATION: Two-stage post-send check. Stage 1 polls the tab URL for
// 1.5s — if it changes, the prompt was delivered. If Stage 1 fails, Stage 2
// polls the exact input element we wrote into (found via a temporary
// data-autoprompt-input attribute) for 1.5s — if its content is cleared,
// the site consumed the prompt. If both stages fail, the tab is flagged
// as a definitive failure (not "uncertain").
//
// TARGETED RE-CHECK: If initial verification fails on a tab that received
// the prompt, the extension does not immediately give up. After all tabs
// are processed, it re-activates only the failed tabs, waits for the page
// to settle, and re-runs the same two-stage verification. This fixes false
// failures caused by sites pausing or delaying DOM updates while backgrounded.
//
// RETRY ENTER: If the targeted re-check still fails and the marked input
// box still contains the prompt text, the extension re-focuses that exact
// input box, re-attaches the debugger, and sends one more trusted Enter
// keystroke. This is the final rescue step. If it fails, the tab remains
// flagged as failed.
//
// An "experimentalBackground" toggle keeps the old direct/no-cycling
// behavior available (all tabs stay in the background, no cycling) for
// anyone who wants to try it anyway — expect it to fail on most sites,
// which is exactly the behavior you already ran into.
//
// A "debugLog" toggle records a timestamped, per-tab timeline of every step
// (tab opened, debugger attach ok/fail, load-wait finished, focus detected
// or not, keys dispatched, errors) and downloads it as a .json file at the
// end of the run, so failures can be diagnosed without opening the service
// worker's console manually.
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_AUTOMATION') {
    runAutomation(msg.urls, msg.prompt, {
      skipWait: !!msg.skipWait,
      experimentalBackground: !!msg.experimentalBackground,
      debugLog: !!msg.debugLog
    }).catch((err) => console.error('[AI Chat Auto-Prompt] automation failed:', err));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RUN_STEALTH_TEST') {
    runStealthExperiment(msg.url, msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (msg.type === 'RUN_STEALTH_MULTI_TEST') {
    runStealthMultiTest(msg.urls, msg.prompt)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ results: [], error: err.message }));
    return true;
  }

  return false;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Debug logger -----------------------------------------------------------

function makeLogger(enabled) {
  const entries = [];
  function log(scope, message, data) {
    const entry = { t: new Date().toISOString(), scope: String(scope), message };
    if (data !== undefined) entry.data = data;
    entries.push(entry);
    // Always echo to the service worker console too — that's free, and
    // helps even when the "save log file" toggle is off.
    console.log(`[AI Chat Auto-Prompt] [${scope}] ${message}`, data !== undefined ? data : '');
  }
  async function flush(meta) {
    if (!enabled) return;
    try {
      const payload = { meta, entries };
      const json = JSON.stringify(payload, null, 2);
      const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
      await chrome.downloads.download({
        url: dataUrl,
        filename: `ai-chat-autoprompt-log-${Date.now()}.json`,
        saveAs: false
      });
    } catch (e) {
      console.error('[AI Chat Auto-Prompt] failed to save debug log:', e);
    }
  }
  return { log, flush };
}

// ---- Tab load / focus detection --------------------------------------------

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') finish();
    });
  });
}

async function isInputFocused(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        return tag === 'textarea' || tag === 'input' || !!el.isContentEditable;
      }
    });
    return !!(results && results[0] && results[0].result);
  } catch (e) {
    return false;
  }
}

async function waitForFocusedInput(tabId, maxWaitMs = 15000, stepMs = 350) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isInputFocused(tabId)) return true;
    await delay(stepMs);
  }
  return false;
}

// ---- Input element marking (for post-send verification) ---------------------

async function markInputElement(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.activeElement;
        if (el) el.setAttribute('data-autoprompt-input', 'true');
      }
    });
  } catch (e) {}
}

async function getMarkedInputContent(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('[data-autoprompt-input="true"]');
        if (!el) return null;
        if (el.value !== undefined) return el.value;
        return el.innerText || el.textContent || '';
      }
    });
    return results && results[0] ? results[0].result : null;
  } catch (e) {
    return null;
  }
}

async function cleanupInputElementMark(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('[data-autoprompt-input="true"]');
        if (el) el.removeAttribute('data-autoprompt-input');
      }
    });
  } catch (e) {}
}

async function focusMarkedInput(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('[data-autoprompt-input="true"]');
        if (!el) return false;

        el.focus();
        return true;
      }
    });
    return !!(results && results[0] && results[0].result);
  } catch (e) {
    return false;
  }
}

// ---- Tab-navigation fallback helpers ----------------------------------------

function fingerprintsMatch(a, b) {
  return (
    a.tag === b.tag &&
    a.id === b.id &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h
  );
}

function scoreCandidate(data) {
  let score = 0;
  if (data.tag === 'textarea') score += 100;
  if (data.editable) score += 80;
  if (data.tag === 'input') score += 40;
  if (data.w > 400) score += 30;
  if (data.h > 60) score += 20;
  if (data.h > 200) score += 10;
  const ph = (data.placeholder || '').toLowerCase();
  if (/message|prompt|ask|chat|type/.test(ph)) score += 15;
  if (data.y > data.viewportH * 0.5) score += 10;
  if (/search/.test(ph) && data.tag === 'input') score -= 20;
  return score;
}

async function findInputViaTabNavigation(tabId, logger) {
  const MAX_TABS = 50;
  let firstFingerprint = null;
  const candidates = [];

  for (let i = 0; i < MAX_TABS; i++) {
    await dispatchKey(tabId, {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      code: 'Tab', key: 'Tab'
    });
    await dispatchKey(tabId, {
      type: 'keyUp',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      code: 'Tab', key: 'Tab'
    });
    await delay(100);

    let info;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) {
            return { type: 'none' };
          }

          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const editable = !!el.isContentEditable;
          const inputType = (el.type || '').toLowerCase();

          const rect = el.getBoundingClientRect();
          const fingerprint = {
            tag,
            id: el.id || '',
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          };

          const isCandidate =
            tag === 'textarea' ||
            editable ||
            (tag === 'input' && ['text', 'search', ''].includes(inputType));

          if (!isCandidate) {
            return { type: 'not-candidate', fingerprint };
          }

          const placeholder =
            el.placeholder ||
            el.getAttribute('data-placeholder') ||
            el.getAttribute('aria-label') ||
            '';
          const scoreData = {
            tag, editable, inputType, placeholder,
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            y: Math.round(rect.y),
            viewportH: window.innerHeight
          };

          const candidateIndex = document.querySelectorAll('[data-autoprompt-candidate]').length;
          el.setAttribute('data-autoprompt-candidate', String(candidateIndex));

          return { type: 'candidate', fingerprint, scoreData, candidateIndex };
        }
      });
      info = results && results[0] && results[0].result;
    } catch (e) {
      logger.log(tabId, `Tab fallback: executeScript error on Tab ${i + 1}: ${e.message}`);
      break;
    }

    if (!info || info.type === 'none') continue;

    if (firstFingerprint === null) {
      firstFingerprint = info.fingerprint;
    } else if (fingerprintsMatch(info.fingerprint, firstFingerprint)) {
      logger.log(tabId, `Tab fallback: full cycle complete after ${i + 1} Tab presses`);
      break;
    }

    if (info.type === 'candidate') {
      candidates.push(info);
      logger.log(tabId, `Tab fallback: found candidate #${info.candidateIndex} (<${info.scoreData.tag}>, ${info.scoreData.w}x${info.scoreData.h})`);
    }
  }

  if (candidates.length === 0) {
    logger.log(tabId, 'Tab fallback: no text-input candidates found after full cycle');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.querySelectorAll('[data-autoprompt-candidate]').forEach((el) =>
            el.removeAttribute('data-autoprompt-candidate')
          );
        }
      });
    } catch (_e) {}
    return false;
  }

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
    logger.log(tabId, 'Tab fallback: only 1 candidate — using it directly (no scoring needed)');
  } else {
    chosen = candidates.reduce((best, c) =>
      scoreCandidate(c.scoreData) > scoreCandidate(best.scoreData) ? c : best
    );
    logger.log(tabId, `Tab fallback: ${candidates.length} candidates — picked #${chosen.candidateIndex} (score ${scoreCandidate(chosen.scoreData)})`);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (idx) => {
        const el = document.querySelector(`[data-autoprompt-candidate="${idx}"]`);
        if (el) el.focus();
        document.querySelectorAll('[data-autoprompt-candidate]').forEach((e) =>
          e.removeAttribute('data-autoprompt-candidate')
        );
        return !!el;
      },
      args: [chosen.candidateIndex]
    });
  } catch (e) {
    logger.log(tabId, `Tab fallback: failed to focus chosen element: ${e.message}`);
    return false;
  }

  await delay(150);

  const confirmed = await isInputFocused(tabId);
  logger.log(tabId, confirmed
    ? 'Tab fallback: chosen element is now focused — ready to send'
    : 'Tab fallback: focus confirmation failed');
  return confirmed;
}

// ---- Trusted keystroke simulation via the debugger -------------------------

async function dispatchKey(tabId, params) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', params);
}

async function sendTextThenEnter(tabId, prompt) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: prompt });

  await delay(600);

  await dispatchKey(tabId, {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13,
    code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r'
  });
  await dispatchKey(tabId, { type: 'char', text: '\r' });
  await delay(30);
  await dispatchKey(tabId, {
    type: 'keyUp',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    code: 'Enter', key: 'Enter'
  });
}

async function sendEnterOnly(tabId) {
  await dispatchKey(tabId, {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13,
    code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r'
  });
  await dispatchKey(tabId, { type: 'char', text: '\r' });
  await delay(30);
  await dispatchKey(tabId, {
    type: 'keyUp',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    code: 'Enter', key: 'Enter'
  });
}

// ---- Post-send verification (two-stage: URL change + input clearing) --------

async function verifySend(tabId, originalUrl, logger) {
  const urlDeadline = Date.now() + 1500;
  while (Date.now() < urlDeadline) {
    try {
      const { url: newUrl } = await chrome.tabs.get(tabId);
      if (newUrl !== originalUrl) {
        logger.log(tabId, 'Verification Stage 1: URL changed — Success');
        return { verified: true, reason: 'URL changed — prompt was sent' };
      }
    } catch (e) {
      logger.log(tabId, `Verification Stage 1 error: ${e.message}`);
    }
    await delay(500);
  }

  logger.log(tabId, 'Verification Stage 1 failed — starting Stage 2 (input clearing check)');
  const inputDeadline = Date.now() + 1500;
  while (Date.now() < inputDeadline) {
    const content = await getMarkedInputContent(tabId);

    if (content === null) {
      logger.log(tabId, 'Stage 2: marked input element no longer exists — cannot verify');
      break;
    }

    if (content.trim() === '') {
      logger.log(tabId, 'Verification Stage 2: input box cleared — Success');
      return { verified: true, reason: 'Input box cleared — prompt was sent' };
    }

    await delay(500);
  }

  logger.log(tabId, 'Verification failed: URL unchanged and input still contains text');
  return { verified: false, reason: 'URL unchanged and input still contains text — send failed' };
}

// ---- Targeted re-check + Stage 3 retry Enter -------------------------------

async function recheckFailedTab(result, logger) {
  try {
    const tab = await chrome.tabs.get(result.tabId);

    // Re-activate the tab so the site's JavaScript wakes up and updates the DOM/URL
    await chrome.tabs.update(result.tabId, { active: true });
    if (tab && tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    logger.log(result.tabId, `Re-check: activated tab (${result.url})`);

    // Give the site time to settle after being brought back to the front
    await delay(1500);

    // ---- Stage 2: targeted re-check (unchanged) ----
    const verification = await verifySend(result.tabId, result.url, logger);

    if (verification.verified) {
      result.status = 'success';
      result.reason = `Re-check success: ${verification.reason}`;
      logger.log(result.tabId, 'Re-check passed — status updated to success');
      return;
    }

    logger.log(result.tabId, 'Re-check failed — evaluating Stage 3 (Retry Enter)');

    // ---- Stage 3: Retry Enter only if the input box still contains text ----
    const remainingText = await getMarkedInputContent(result.tabId);

    if (remainingText === null || remainingText.trim() === '') {
      result.status = 'error';
      result.reason = `Re-check failed: ${verification.reason}`;
      logger.log(result.tabId, 'Stage 3 skipped — input box is empty or no longer exists');
      return;
    }

    logger.log(result.tabId, 'Stage 3: input box still contains text — focusing input and retrying Enter');

    const focused = await focusMarkedInput(result.tabId);
    if (!focused) {
      result.status = 'error';
      result.reason = `Re-check failed: ${verification.reason}; Retry Enter skipped (could not focus marked input)`;
      logger.log(result.tabId, 'Stage 3 failed — could not focus marked input');
      return;
    }

    await delay(200);

    // Re-attach the debugger because trusted Enter key events require it
    let debuggerAttached = false;
    try {
      await chrome.debugger.attach({ tabId: result.tabId }, '1.3');
      debuggerAttached = true;
      logger.log(result.tabId, 'Stage 3: debugger re-attached for Enter retry');
    } catch (e) {
      logger.log(result.tabId, `Stage 3: debugger attach failed: ${e.message}`);
    }

    if (!debuggerAttached) {
      result.status = 'error';
      result.reason = `Re-check failed: ${verification.reason}; Retry Enter skipped (debugger attach failed)`;
      return;
    }

    try {
      await sendEnterOnly(result.tabId);
      logger.log(result.tabId, 'Stage 3: Enter retry dispatched');

      // Small settle delay before final verification
      await delay(300);

      const retryVerification = await verifySend(result.tabId, result.url, logger);

      if (retryVerification.verified) {
        result.status = 'success';
        result.reason = `Retry Enter success: ${retryVerification.reason}`;
        logger.log(result.tabId, 'Stage 3 passed — status updated to success');
      } else {
        result.status = 'error';
        result.reason = `Retry Enter failed: ${retryVerification.reason}`;
        logger.log(result.tabId, 'Stage 3 failed — status remains error');
      }
    } finally {
      try {
        await chrome.debugger.detach({ tabId: result.tabId });
        logger.log(result.tabId, 'Stage 3: debugger detached');
      } catch (_e) {}
    }
  } catch (e) {
    logger.log(result.tabId || result.url, `Re-check error: ${e.message}`);
    result.status = 'error';
    result.reason = `Re-check error: ${e.message}`;
  } finally {
    delete result.needsRecheck;

    // Clean up the temporary input mark now that re-check and retry are finished
    if (result.tabId) {
      try {
        await cleanupInputElementMark(result.tabId);
      } catch (_e) {}
    }
  }
}

// ---- Mode 1 (default): open in parallel, then auto-cycle focus -------------

async function openAndAttach(url, skipWait, logger) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    logger.log(url, `Failed to open tab: ${e.message}`);
    return { url, tabId: null, ok: false };
  }
  const tabId = tab.id;
  logger.log(tabId, `Opened tab for ${url}`);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    logger.log(tabId, 'Debugger attached');
  } catch (e) {
    logger.log(tabId, `Debugger attach failed (DevTools already open on it?): ${e.message}`);
    return { url, tabId, ok: false };
  }

  try {
    if (skipWait) {
      await delay(1000);
      logger.log(tabId, 'Skip-wait mode: used ~1s settle delay instead of waiting for full page load');
    } else {
      await waitForTabComplete(tabId);
      await delay(1200);
      logger.log(tabId, 'Waited for full page load + grace period');
    }
  } catch (e) {
    logger.log(tabId, `Error while waiting for load: ${e.message}`);
  }

  return { url, tabId, ok: true };
}

async function sendToActivatedTab(tabId, url, prompt, logger) {
  const result = { url, tabId, status: 'unknown', reason: '' };
  try {
    const tab = await chrome.tabs.get(tabId);

    await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront');
    } catch (e) {}
    logger.log(tabId, `Activated tab (${url})`);

    await delay(200);

    let focused = await waitForFocusedInput(tabId, 8000, 300);

    if (!focused) {
      logger.log(tabId, 'Primary focus detection timed out — starting Tab navigation fallback');
      focused = await findInputViaTabNavigation(tabId, logger);
    }

    if (!focused) {
      logger.log(tabId, 'Both primary and Tab fallback failed — no input box found, aborting tab');
      result.status = 'error';
      result.reason = 'No input box found (primary detection + Tab fallback both failed)';
      return result;
    }

    logger.log(tabId, 'Input box focused — proceeding with text insertion');
    await delay(200);

    await markInputElement(tabId);

    await sendTextThenEnter(tabId, prompt);
    logger.log(tabId, 'Text inserted + Enter dispatched');

    const verification = await verifySend(tabId, url, logger);

    if (verification.verified) {
      // Success — clean up the temporary input mark immediately
      await cleanupInputElementMark(tabId);
      result.status = 'success';
      result.reason = verification.reason;
    } else {
      // Failed — keep the input mark so the targeted re-check can inspect the same input box later
      result.status = 'error';
      result.reason = verification.reason;
      result.needsRecheck = true;
      logger.log(tabId, 'Initial verification failed — tab marked for targeted re-check');
    }
  } catch (e) {
    logger.log(tabId, `Error during send: ${e.message}`);
    result.status = 'error';
    result.reason = e.message;

    // Clean up the temporary input mark if it was added before the error
    try {
      await cleanupInputElementMark(tabId);
    } catch (_e) {}
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
      logger.log(tabId, 'Debugger detached');
    } catch (e) {}
  }
  return result;
}

async function runAutomationAutoCycle(urls, prompt, skipWait, logger) {
  logger.log('main', `Starting run: ${urls.length} URL(s), skipWait=${skipWait}, mode=auto-cycle (Ready Queue)`);

  // 1. Launch all tabs in parallel. Each runs its own loading/wait logic.
  const tabPromises = urls.map((url) => openAndAttach(url, skipWait, logger));

  const readyQueue = [];
  const failedTabs = [];
  const startTime = Date.now();

  // 2. Build the Ready Queue dynamically
  while (readyQueue.length < urls.length) {
    for (let i = 0; i < tabPromises.length; i++) {
      if (!tabPromises[i]) continue;

      let isResolved = false;
      let result = null;

      await Promise.race([
        tabPromises[i].then(res => { result = res; isResolved = true; }),
        Promise.resolve()
      ]);

      if (isResolved) {
        if (result.ok && result.tabId) {
          readyQueue.push(result);
          logger.log(result.tabId, `Added to Ready Queue (Position ${readyQueue.length})`);
        } else {
          failedTabs.push(result);
        }
        tabPromises[i] = null;
      }
    }

    if (readyQueue.length === 0 && Date.now() - startTime > 1000) {
      logger.log('main', '1s elapsed with no ready tabs. Forcing first tab into queue.');
      const firstIdx = tabPromises.findIndex(p => p !== null);
      if (firstIdx === -1) break;
      const firstResult = await tabPromises[firstIdx];
      if (firstResult.ok && firstResult.tabId) {
        readyQueue.push(firstResult);
      } else {
        failedTabs.push(firstResult);
      }
      tabPromises[firstIdx] = null;
      break;
    }

    if (readyQueue.length > 0) {
      break;
    }

    await delay(100);
  }

  // 3. Process the first batch of ready tabs
  const results = [...failedTabs];

  for (const state of readyQueue) {
    const result = await sendToActivatedTab(state.tabId, state.url, prompt, logger);
    results.push(result);
  }

  // 4. Process remaining tabs as they finish loading
  for (let i = 0; i < tabPromises.length; i++) {
    if (tabPromises[i] === null) continue;

    const state = await tabPromises[i];
    if (!state.ok || !state.tabId) {
      results.push({ url: state.url, tabId: state.tabId || null, status: 'error', reason: 'Failed to open or attach debugger' });
      continue;
    }

    logger.log(state.tabId, 'Tab finished loading, added to processing queue.');
    const result = await sendToActivatedTab(state.tabId, state.url, prompt, logger);
    results.push(result);
  }

  // ---- Targeted re-check phase ----
  // Only re-check tabs where the prompt was sent but initial verification failed.
  const tabsToRecheck = results.filter((r) => r.needsRecheck && r.tabId);

  if (tabsToRecheck.length > 0) {
    logger.log('main', `Initial pass complete. ${tabsToRecheck.length} tab(s) flagged as failed — starting targeted re-check.`);

    for (const failedResult of tabsToRecheck) {
      await recheckFailedTab(failedResult, logger);
    }
  } else {
    logger.log('main', 'Initial pass complete. No tabs need targeted re-check.');
  }

  // Remove internal flag before saving/displaying results
  results.forEach((r) => delete r.needsRecheck);

  await chrome.storage.local.set({ lastRunResults: results, lastRunFinishedAt: Date.now() });
  logger.log('main', `Run complete. Results stored: ${results.length} tab(s)`);
  return results;
}

// ---- Stealth mode helpers ---------------------------------------------------

async function stealthSetupTab(url, logger) {
  const state = { url, tabId: null, ok: false, error: null };

  try {
    // Create tab as about:blank so spoofing is injected BEFORE the real page loads
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    state.tabId = tab.id;
    logger.log(tab.id, `Stealth: tab created as about:blank for ${url}`);

    // Attach debugger and enable required CDP domains
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable');
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable');
    logger.log(tab.id, 'Stealth: debugger attached, CDP domains enabled');

    // Inject hardened visibility/focus spoofing BEFORE any page JS runs
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function() {
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
          window.addEventListener('visibilitychange', (e) => { e.stopImmediatePropagation(); }, true);
          window.addEventListener('blur', (e) => { e.stopImmediatePropagation(); }, true);
        })();
      `
    });

    // Enable focus emulation (may not exist in all Chrome versions)
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {
      logger.log(tab.id, `Stealth: focus emulation not available: ${e.message}`);
    }

    // Navigate to the real URL — spoofing is already in place
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url });
    logger.log(tab.id, `Stealth: navigating to ${url}`);

    state.ok = true;
  } catch (e) {
    logger.log(state.tabId || url, `Stealth setup failed: ${e.message}`);
    state.error = e.message;
  }

  return state;
}

async function stealthSendToTab(tabState, prompt, skipWait, logger) {
  const { tabId, url } = tabState;
  const result = { url, tabId, status: 'unknown', reason: '' };

  try {
    // Wait for the page to load
    if (skipWait) {
      await delay(1500);
      logger.log(tabId, 'Stealth: skip-wait mode — used 1.5s settle delay');
    } else {
      await delay(500); // let navigation start
      await waitForTabComplete(tabId, 30000);
      await delay(1200);
      logger.log(tabId, 'Stealth: waited for full page load + grace period');
    }

    // DOM search for the best input candidate via Runtime.evaluate
    const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          const selectors = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';
          const elements = Array.from(document.querySelectorAll(selectors));
          let best = null;
          let maxScore = -1;
          elements.forEach(el => {
            const style = getComputedStyle(el);
            if (style.display === 'none') return;
            if (style.visibility === 'hidden') return;
            if (style.opacity === '0') return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const tag = el.tagName.toLowerCase();
            let score = 0;
            if (tag === 'textarea') score += 100;
            if (el.isContentEditable) score += 80;
            if (tag === 'input') score += 40;
            if (rect.width > 400) score += 30;
            if (rect.height > 60) score += 20;
            if (rect.height > 200) score += 10;
            const ph = (el.placeholder || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
            if (/message|prompt|ask|chat|type/.test(ph)) score += 15;
            if (rect.y > window.innerHeight * 0.5) score += 10;
            if (/search/.test(ph) && tag === 'input') score -= 20;
            if (score > maxScore) { maxScore = score; best = el; }
          });
          if (best) best.setAttribute('data-autoprompt-input', 'true');
          return best;
        })()
      `,
      returnByValue: false
    });

    if (!evalResult || !evalResult.result || !evalResult.result.objectId) {
      logger.log(tabId, 'Stealth: no input candidate found by DOM search');
      result.status = 'error';
      result.reason = 'No input box found (stealth DOM search)';
      return result;
    }

    logger.log(tabId, 'Stealth: input candidate found — focusing via CDP DOM.focus');

    // Protocol-level focus — bypasses OS focus requirement
    await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', { objectId: evalResult.result.objectId });
    await delay(300);

    // Insert text and press Enter
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: prompt });
    await delay(600);

    await dispatchKey(tabId, {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13,
      code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r'
    });
    await dispatchKey(tabId, { type: 'char', text: '\r' });
    await delay(30);
    await dispatchKey(tabId, {
      type: 'keyUp',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      code: 'Enter', key: 'Enter'
    });

    logger.log(tabId, 'Stealth: text inserted + Enter dispatched');

    // Two-stage verification (reuses existing verifySend)
    const verification = await verifySend(tabId, url, logger);

    if (verification.verified) {
      await cleanupInputElementMark(tabId);
      result.status = 'success';
      result.reason = verification.reason;
    } else {
      // Keep the input mark for re-check
      result.status = 'error';
      result.reason = verification.reason;
      result.needsRecheck = true;
      logger.log(tabId, 'Stealth: initial verification failed — marked for re-check');
    }

  } catch (e) {
    logger.log(tabId, `Stealth send error: ${e.message}`);
    result.status = 'error';
    result.reason = e.message;
    try { await cleanupInputElementMark(tabId); } catch (_e) {}
  }

  return result;
}

async function stealthRecheckFailedTab(result, logger) {
  try {
    logger.log(result.tabId, `Stealth re-check: waiting for page to settle (${result.url})`);

    // Wait for the site to finish processing (no tab activation)
    await delay(2000);

    // ---- Stage 2: re-run verification ----
    const verification = await verifySend(result.tabId, result.url, logger);

    if (verification.verified) {
      result.status = 'success';
      result.reason = `Re-check success: ${verification.reason}`;
      logger.log(result.tabId, 'Stealth re-check passed — status updated to success');
      return;
    }

    logger.log(result.tabId, 'Stealth re-check failed — evaluating Stage 3 (Retry Enter)');

    // ---- Stage 3: Retry Enter only if input still contains text ----
    const remainingText = await getMarkedInputContent(result.tabId);

    if (remainingText === null || remainingText.trim() === '') {
      result.status = 'error';
      result.reason = `Re-check failed: ${verification.reason}`;
      logger.log(result.tabId, 'Stage 3 skipped — input box is empty or no longer exists');
      return;
    }

    logger.log(result.tabId, 'Stage 3: input still has text — re-focusing via CDP and retrying Enter');

    // Re-focus the marked element via CDP (not JavaScript .focus())
    try {
      const focusResult = await chrome.debugger.sendCommand({ tabId: result.tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector('[data-autoprompt-input="true"]');
            return el || null;
          })()
        `,
        returnByValue: false
      });

      if (focusResult && focusResult.result && focusResult.result.objectId) {
        await chrome.debugger.sendCommand({ tabId: result.tabId }, 'DOM.focus', { objectId: focusResult.result.objectId });
        await delay(200);
      } else {
        logger.log(result.tabId, 'Stage 3: could not find marked element via CDP');
        result.status = 'error';
        result.reason = `Re-check failed: ${verification.reason}; Retry Enter skipped (element not found)`;
        return;
      }
    } catch (e) {
      logger.log(result.tabId, `Stage 3: CDP focus error: ${e.message}`);
      result.status = 'error';
      result.reason = `Re-check failed: ${verification.reason}; Retry Enter skipped (CDP focus error)`;
      return;
    }

    // Debugger is still attached from the initial send — no need to re-attach
    try {
      await sendEnterOnly(result.tabId);
      logger.log(result.tabId, 'Stage 3: Enter retry dispatched');
      await delay(300);

      const retryVerification = await verifySend(result.tabId, result.url, logger);

      if (retryVerification.verified) {
        result.status = 'success';
        result.reason = `Retry Enter success: ${retryVerification.reason}`;
        logger.log(result.tabId, 'Stage 3 passed — status updated to success');
      } else {
        result.status = 'error';
        result.reason = `Retry Enter failed: ${retryVerification.reason}`;
        logger.log(result.tabId, 'Stage 3 failed — status remains error');
      }
    } catch (e) {
      logger.log(result.tabId, `Stage 3 error: ${e.message}`);
      result.status = 'error';
      result.reason = `Retry Enter error: ${e.message}`;
    }

  } catch (e) {
    logger.log(result.tabId || result.url, `Stealth re-check error: ${e.message}`);
    result.status = 'error';
    result.reason = `Re-check error: ${e.message}`;
  } finally {
    delete result.needsRecheck;
    if (result.tabId) {
      try { await cleanupInputElementMark(result.tabId); } catch (_e) {}
    }
  }
}

async function runAutomationStealth(urls, prompt, skipWait, logger) {
  logger.log('main', `Starting run: ${urls.length} URL(s), skipWait=${skipWait}, mode=stealth (parallel background)`);

  // 1. Setup all tabs in parallel (about:blank → spoofing → navigate)
  const setupResults = await Promise.all(
    urls.map((url) => stealthSetupTab(url, logger))
  );

  const results = [];
  const readyTabs = [];

  for (const state of setupResults) {
    if (state.ok && state.tabId) {
      readyTabs.push(state);
    } else {
      results.push({ url: state.url, tabId: state.tabId || null, status: 'error', reason: `Stealth setup failed: ${state.error || 'unknown'}` });
    }
  }

  logger.log('main', `Stealth: ${readyTabs.length} tab(s) ready, ${results.length} failed setup`);

  // 2. Send to ALL ready tabs in parallel
  const sendResults = await Promise.all(
    readyTabs.map((state) => stealthSendToTab(state, prompt, skipWait, logger))
  );
  results.push(...sendResults);

  // 3. Targeted re-check for tabs that failed initial verification
  const tabsToRecheck = results.filter((r) => r.needsRecheck && r.tabId);

  if (tabsToRecheck.length > 0) {
    logger.log('main', `Stealth: ${tabsToRecheck.length} tab(s) flagged — starting targeted re-check`);
    for (const failedResult of tabsToRecheck) {
      await stealthRecheckFailedTab(failedResult, logger);
    }
  } else {
    logger.log('main', 'Stealth: no tabs need targeted re-check');
  }

  // 4. Cleanup: disable emulation and detach all debuggers
  for (const state of readyTabs) {
    try {
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (_e) {}
    try {
      await chrome.debugger.detach({ tabId: state.tabId });
      logger.log(state.tabId, 'Stealth: debugger detached');
    } catch (_e) {}
  }

  // Remove internal flags before saving
  results.forEach((r) => delete r.needsRecheck);

  await chrome.storage.local.set({ lastRunResults: results, lastRunFinishedAt: Date.now() });
  logger.log('main', `Stealth run complete. Results stored: ${results.length} tab(s)`);
  return results;
}

// ---- Main entry point --------------------------------------------------------

async function runAutomation(urls, prompt, opts) {
  const logger = makeLogger(opts.debugLog);

  try {
    if (!Array.isArray(urls) || urls.length === 0) {
      logger.log('main', 'No URLs provided, aborting.');
      await chrome.storage.local.set({ lastRunResults: [], lastRunFinishedAt: Date.now() });
      return;
    }

    let results;
    if (opts.experimentalBackground) {
      results = await runAutomationStealth(urls, prompt, opts.skipWait, logger);
    } else {
      results = await runAutomationAutoCycle(urls, prompt, opts.skipWait, logger);
    }
    return results;
  } catch (err) {
    logger.log('main', `Unhandled error: ${err && err.message}`);
    await chrome.storage.local.set({ lastRunResults: [], lastRunFinishedAt: Date.now() });
    throw err;
  } finally {
    await logger.flush({
      urls,
      skipWait: opts.skipWait,
      mode: opts.experimentalBackground ? 'stealth' : 'auto-cycle',
      finishedAt: new Date().toISOString()
    });
  }
}

// ============================================================================
// STEALTH MODE EXPERIMENT
// Tests whether CDP trusted input works on a minimized Chrome window.
// Uses: about:blank pre-load → visibility spoofing → Page.navigate →
//       DOM search → CDP DOM.focus → Input.insertText → Enter
// ============================================================================

async function runStealthExperiment(url, prompt) {
  const log = (msg) => console.log(`[Stealth Test] ${msg}`);
  log(`Starting experiment for ${url}`);

  // 1. Create tab as about:blank so we can inject spoofing BEFORE the real page loads
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const tabId = tab.id;
  log(`Tab created as about:blank (tabId: ${tabId})`);

  try {
    // 2. Attach debugger and enable required CDP domains
    await chrome.debugger.attach({ tabId }, '1.3');
    log('Debugger attached');

    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    log('CDP domains enabled (Page, DOM, Runtime)');

    // 3. HARDENED VISIBILITY SPOOFING — injected before any page JS runs
    //    Uses getters so the site cannot easily overwrite them.
    //    Intercepts visibilitychange events to prevent the site from
    //    detecting that it was ever hidden.
    await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function() {
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
          window.addEventListener('visibilitychange', (e) => {
            e.stopImmediatePropagation();
          }, true);
          window.addEventListener('blur', (e) => {
            e.stopImmediatePropagation();
          }, true);
        })();
      `
    });
    log('Visibility/focus spoofing registered (pre-load)');

    // 4. Enable CDP focus emulation
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      log('Focus emulation enabled');
    } catch (e) {
      log(`Focus emulation not available: ${e.message} — continuing without it`);
    }

    // 5. NOW navigate to the real URL — spoofing is already in place
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
    log(`Navigating to ${url} ...`);

    // 6. Wait for the page to load
    //    For this experiment we use a fixed delay. In production we would
    //    listen for Page.loadEventFired or Page.frameStoppedLoading.
    log('Waiting 5 seconds for page load...');
    await delay(5000);

    // 7. DOM SEARCH via Runtime.evaluate — returns a CDP RemoteObjectId
    //    Uses getComputedStyle + getBoundingClientRect instead of offsetParent
    //    to correctly handle position:fixed and position:sticky elements.
    const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          const selectors = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';
          const elements = Array.from(document.querySelectorAll(selectors));
          let best = null;
          let maxScore = -1;

          elements.forEach(el => {
            // Robust visibility check — does NOT use offsetParent
            const style = getComputedStyle(el);
            if (style.display === 'none') return;
            if (style.visibility === 'hidden') return;
            if (style.opacity === '0') return;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const tag = el.tagName.toLowerCase();
            let score = 0;

            // Tag type scoring
            if (tag === 'textarea') score += 100;
            if (el.isContentEditable) score += 80;
            if (tag === 'input') score += 40;

            // Size scoring — chat inputs are large
            if (rect.width > 400) score += 30;
            if (rect.height > 60) score += 20;
            if (rect.height > 200) score += 10;

            // Placeholder / label hints
            const ph = (el.placeholder || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
            if (/message|prompt|ask|chat|type/.test(ph)) score += 15;

            // Position — chat inputs are usually in the lower half
            if (rect.y > window.innerHeight * 0.5) score += 10;

            // Penalty for search-like inputs
            if (/search/.test(ph) && tag === 'input') score -= 20;

            if (score > maxScore) {
              maxScore = score;
              best = el;
            }
          });

          if (best) {
            best.setAttribute('data-autoprompt-input', 'true');
          }
          return best;
        })()
      `,
      returnByValue: false
    });

    if (!evalResult || !evalResult.result || !evalResult.result.objectId) {
      log('FAILED: No suitable input candidate found by DOM search');
      return { success: false, reason: 'No input candidate found' };
    }

    const objectId = evalResult.result.objectId;
    log(`Input candidate found (objectId: ${objectId})`);

    // 8. PROTOCOL-LEVEL FOCUS via DOM.focus — bypasses OS focus requirement
    await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', { objectId });
    log('CDP DOM.focus applied to candidate element');
    await delay(300);

    // 9. INSERT TEXT via CDP
    log('Inserting prompt via Input.insertText...');
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: prompt });
    await delay(600);

    // 10. PRESS ENTER via CDP
    log('Dispatching Enter key...');
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13,
      code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r'
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'char', text: '\r' });
    await delay(30);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      code: 'Enter', key: 'Enter'
    });
    log('Enter dispatched');

    // 11. WAIT AND VERIFY
    log('Waiting 3 seconds to check result...');
    await delay(3000);

    // Check if the URL changed
    const currentTab = await chrome.tabs.get(tabId);
    const urlChanged = currentTab.url !== url && currentTab.url !== 'about:blank';

    // Check if the input box was cleared
    let inputCleared = false;
    try {
      const checkResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector('[data-autoprompt-input="true"]');
            if (!el) return 'element_gone';
            const val = el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
            return val.trim() === '' ? 'empty' : 'has_text';
          })()
        `,
        returnByValue: true
      });
      const state = checkResult && checkResult.result ? checkResult.result.value : 'unknown';
      inputCleared = (state === 'empty' || state === 'element_gone');
      log(`Input state after send: ${state}`);
    } catch (e) {
      log(`Input check error: ${e.message}`);
    }

    const success = urlChanged || inputCleared;
    const reason = urlChanged
      ? 'URL changed — prompt was sent'
      : inputCleared
        ? 'Input box cleared — prompt was sent'
        : 'URL unchanged and input still has text — send likely failed';

    log(`RESULT: ${success ? 'SUCCESS' : 'FAILED'} — ${reason}`);
    return { success, reason, urlChanged, inputCleared };

  } catch (err) {
    log(`Error during experiment: ${err.message}`);
    return { success: false, reason: `Error: ${err.message}` };
  } finally {
    // Clean up: disable emulation, detach debugger
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (_e) {}
    try {
      await chrome.debugger.detach({ tabId });
      log('Debugger detached');
    } catch (_e) {}
  }
}

// ============================================================================
// MULTI-TAB STEALTH TEST
// Tests whether CDP trusted input works on MULTIPLE minimized tabs in parallel.
// ============================================================================

async function runStealthMultiTest(urls, prompt) {
  const log = (msg) => console.log(`[Stealth Multi] ${msg}`);
  log(`Starting multi-tab test: ${urls.length} URL(s)`);

  // 1. Create all tabs as about:blank
  const tabs = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabs.push({ url, tabId: tab.id });
    log(`Tab created for ${url} (tabId: ${tab.id})`);
  }

  // 2. Setup each tab: attach debugger, enable domains, inject spoofing, enable focus emulation
  for (const t of tabs) {
    try {
      await chrome.debugger.attach({ tabId: t.tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'DOM.enable');
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Runtime.enable');

      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (function() {
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
            window.addEventListener('visibilitychange', (e) => { e.stopImmediatePropagation(); }, true);
            window.addEventListener('blur', (e) => { e.stopImmediatePropagation(); }, true);
          })();
        `
      });

      try {
        await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch (e) {
        log(`Focus emulation not available for tab ${t.tabId}: ${e.message}`);
      }

      log(`Tab ${t.tabId} setup complete`);
    } catch (e) {
      log(`Tab ${t.tabId} setup FAILED: ${e.message}`);
      t.error = e.message;
    }
  }

  // 3. Navigate all tabs to their real URLs
  for (const t of tabs) {
    if (t.error) continue;
    try {
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Page.navigate', { url: t.url });
      log(`Navigating tab ${t.tabId} to ${t.url}`);
    } catch (e) {
      log(`Navigation failed for tab ${t.tabId}: ${e.message}`);
      t.error = e.message;
    }
  }

  // 4. Wait for all pages to load
  log('Waiting 6 seconds for all pages to load...');
  await delay(6000);

  // 5. Send to ALL tabs in parallel
  log('Sending to all tabs in parallel...');
  const sendResults = await Promise.all(tabs.map(async (t) => {
    if (t.error) {
      return { url: t.url, tabId: t.tabId, success: false, reason: `Setup failed: ${t.error}` };
    }

    try {
      // DOM search for input
      const evalResult = await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const selectors = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';
            const elements = Array.from(document.querySelectorAll(selectors));
            let best = null;
            let maxScore = -1;
            elements.forEach(el => {
              const style = getComputedStyle(el);
              if (style.display === 'none') return;
              if (style.visibility === 'hidden') return;
              if (style.opacity === '0') return;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return;
              const tag = el.tagName.toLowerCase();
              let score = 0;
              if (tag === 'textarea') score += 100;
              if (el.isContentEditable) score += 80;
              if (tag === 'input') score += 40;
              if (rect.width > 400) score += 30;
              if (rect.height > 60) score += 20;
              if (rect.height > 200) score += 10;
              const ph = (el.placeholder || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
              if (/message|prompt|ask|chat|type/.test(ph)) score += 15;
              if (rect.y > window.innerHeight * 0.5) score += 10;
              if (/search/.test(ph) && tag === 'input') score -= 20;
              if (score > maxScore) { maxScore = score; best = el; }
            });
            if (best) best.setAttribute('data-autoprompt-input', 'true');
            return best;
          })()
        `,
        returnByValue: false
      });

      if (!evalResult || !evalResult.result || !evalResult.result.objectId) {
        return { url: t.url, tabId: t.tabId, success: false, reason: 'No input candidate found' };
      }

      // CDP focus
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'DOM.focus', { objectId: evalResult.result.objectId });
      await delay(300);

      // Insert text
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Input.insertText', { text: prompt });
      await delay(600);

      // Press Enter
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, macCharCode: 13,
        code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r'
      });
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Input.dispatchKeyEvent', { type: 'char', text: '\r' });
      await delay(30);
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        code: 'Enter', key: 'Enter'
      });

      log(`Tab ${t.tabId}: text inserted + Enter dispatched`);
      return { url: t.url, tabId: t.tabId, success: true, reason: 'Sent (pending verification)' };

    } catch (e) {
      return { url: t.url, tabId: t.tabId, success: false, reason: `Send error: ${e.message}` };
    }
  }));

  // 6. Wait and verify all tabs
  log('Waiting 3 seconds before verification...');
  await delay(3000);

  const finalResults = [];
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const sr = sendResults[i];

    if (!sr.success) {
      finalResults.push(sr);
      continue;
    }

    try {
      const currentTab = await chrome.tabs.get(t.tabId);
      const urlChanged = currentTab.url !== t.url && currentTab.url !== 'about:blank';

      let inputCleared = false;
      try {
        const checkResult = await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Runtime.evaluate', {
          expression: `
            (function() {
              const el = document.querySelector('[data-autoprompt-input="true"]');
              if (!el) return 'element_gone';
              const val = el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
              return val.trim() === '' ? 'empty' : 'has_text';
            })()
          `,
          returnByValue: true
        });
        const state = checkResult && checkResult.result ? checkResult.result.value : 'unknown';
        inputCleared = (state === 'empty' || state === 'element_gone');
        log(`Tab ${t.tabId} input state: ${state}`);
      } catch (e) {
        log(`Tab ${t.tabId} input check error: ${e.message}`);
      }

      const success = urlChanged || inputCleared;
      const reason = urlChanged
        ? 'URL changed — prompt was sent'
        : inputCleared
          ? 'Input box cleared — prompt was sent'
          : 'URL unchanged and input still has text — send likely failed';

      log(`Tab ${t.tabId} RESULT: ${success ? 'SUCCESS' : 'FAILED'} — ${reason}`);
      finalResults.push({ url: t.url, tabId: t.tabId, success, reason, urlChanged, inputCleared });

    } catch (e) {
      finalResults.push({ url: t.url, tabId: t.tabId, success: false, reason: `Verify error: ${e.message}` });
    }
  }

  // 7. Cleanup: detach all debuggers
  for (const t of tabs) {
    try {
      await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (_e) {}
    try {
      await chrome.debugger.detach({ tabId: t.tabId });
    } catch (_e) {}
  }

  const successCount = finalResults.filter(r => r.success).length;
  log(`FINAL: ${successCount}/${finalResults.length} succeeded`);

  return finalResults;
}
```

## `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "BYPASS API_CLAUDE_BUREAU",
  "version": "1.0.0",
  "description": "Opens an AI chat URL and auto-sends your prompt by simulating a real Ctrl+V paste and Enter keystroke.",
  "permissions": ["tabs", "scripting", "debugger", "storage"],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_popup": "popup.html"
  },
  "background": {
    "service_worker": "background.js"
  }
}
```

## `popup.html`

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    width: 320px;
    padding: 14px;
    background: #1e1e1e;
    color: #eee;
  }
  h3 { margin: 0 0 4px 0; font-size: 15px; font-weight: 600; }
  .sub { font-size: 11px; color: #888; margin-bottom: 10px; }
  label {
    font-size: 12px;
    color: #aaa;
    display: block;
    margin-top: 10px;
    margin-bottom: 4px;
  }
  input[type="text"], textarea {
    width: 100%;
    box-sizing: border-box;
    background: #2b2b2b;
    border: 1px solid #444;
    color: #eee;
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 90px; }
  input:focus, textarea:focus { outline: none; border-color: #4f7cff; }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 10px;
    border: none;
    border-radius: 6px;
    background: #4f7cff;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { background: #555; cursor: default; }
  #status { margin-top: 8px; font-size: 12px; color: #9ad; min-height: 14px; white-space: pre-line; }

  #results-section {
    margin-top: 14px;
    border-top: 1px solid #333;
    padding-top: 10px;
    display: none;
  }
  #results-section h4 {
    margin: 0 0 6px 0;
    font-size: 12px;
    color: #aaa;
    font-weight: 600;
  }
  .result-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
    line-height: 1.4;
  }
  .result-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 3px;
  }
  .result-dot.success { background: #4caf50; }
  .result-dot.uncertain { background: #ff9800; }
  .result-dot.error { background: #f44336; }
  .result-url {
    color: #ccc;
    word-break: break-all;
  }
  .result-reason {
    color: #777;
    font-size: 10px;
    margin-top: 1px;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    gap: 8px;
  }
  .toggle-row .toggle-label { font-size: 12px; color: #ccc; line-height: 1.3; }
  .toggle-row .toggle-hint { font-size: 10px; color: #777; }
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background-color: #444; transition: .15s; border-radius: 20px;
  }
  .slider:before {
    position: absolute; content: ""; height: 14px; width: 14px;
    left: 3px; bottom: 3px; background-color: white; transition: .15s; border-radius: 50%;
  }
  input:checked + .slider { background-color: #4f7cff; }
  input:checked + .slider:before { transform: translateX(16px); }
</style>
</head>
<body>
  <h3>AI Chat Auto-Prompt</h3>
  <div class="sub">Opens tabs in parallel, pastes, and hits Enter automatically.</div>

  <label for="urls">AI chat URLs (one per line)</label>
  <textarea id="urls" placeholder="https://gemini.google.com/app&#10;https://claude.ai/new&#10;https://chat.deepseek.com" style="min-height:70px;"></textarea>

  <label for="prompt">Prompt</label>
  <textarea id="prompt" placeholder="Type the prompt to send..."></textarea>

  <div class="toggle-row">
    <div>
      <div class="toggle-label">Skip waiting for full page load</div>
      <div class="toggle-hint">Starts checking for the input box ~1s after opening instead of waiting for "loaded"</div>
    </div>
    <label class="switch">
      <input type="checkbox" id="skipWait">
      <span class="slider"></span>
    </label>
  </div>

  <div class="toggle-row">
    <div>
      <div class="toggle-label">Stealth mode (background)</div>
      <div class="toggle-hint">All tabs run in parallel. Works while Chrome is minimized. No focus stealing.</div>
    </div>
    <label class="switch">
      <input type="checkbox" id="experimentalBackground">
      <span class="slider"></span>
    </label>
  </div>

  <div class="toggle-row">
    <div>
      <div class="toggle-label">Save debug log</div>
      <div class="toggle-hint">Downloads a .json timeline of every step</div>
    </div>
    <label class="switch">
      <input type="checkbox" id="debugLog">
      <span class="slider"></span>
    </label>
  </div>

  <button id="submit">Open &amp; Send</button>
  <div id="status"></div>

  <div id="results-section">
    <h4>Run Results</h4>
    <div id="results-list"></div>
  </div>

  <div id="stealth-section" style="margin-top:14px; border-top:1px solid #333; padding-top:10px;">
    <h4 style="margin:0 0 6px 0; font-size:12px; color:#aaa; font-weight:600;">Stealth Mode Experiment</h4>
    <div style="font-size:10px; color:#777; margin-bottom:8px; line-height:1.4;">
      Tests if CDP input works while Chrome is minimized. Minimize Chrome immediately after clicking the button.
    </div>
    <label for="stealthUrl" style="font-size:12px; color:#aaa; display:block; margin-bottom:4px;">Test URL</label>
    <input type="text" id="stealthUrl" placeholder="https://claude.ai/new" style="width:100%; box-sizing:border-box; background:#2b2b2b; border:1px solid #444; color:#eee; border-radius:6px; padding:8px; font-size:13px;">
    <button id="stealthTestBtn" style="width:100%; margin-top:10px; padding:8px; border:none; border-radius:6px; background:#ff9800; color:#1e1e1e; font-size:13px; font-weight:600; cursor:pointer;">
      Run Stealth Test (then minimize Chrome)
    </button>
    <div id="stealthStatus" style="margin-top:6px; font-size:11px; color:#9ad; min-height:14px; white-space:pre-line;"></div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

## `popup.js`

```js
const urlsInput = document.getElementById('urls');
const promptInput = document.getElementById('prompt');
const skipWaitInput = document.getElementById('skipWait');
const experimentalBgInput = document.getElementById('experimentalBackground');
const debugLogInput = document.getElementById('debugLog');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');

chrome.storage.local.get(['lastUrls', 'skipWait', 'experimentalBackground', 'debugLog', 'lastRunResults'], (res) => {
  if (res.lastUrls) urlsInput.value = res.lastUrls;
  if (res.skipWait) skipWaitInput.checked = true;
  if (res.experimentalBackground) experimentalBgInput.checked = true;
  if (res.debugLog) debugLogInput.checked = true;
  if (res.lastRunResults && res.lastRunResults.length > 0) {
    displayResults(res.lastRunResults);
  }
});

skipWaitInput.addEventListener('change', () => {
  chrome.storage.local.set({ skipWait: skipWaitInput.checked });
});
experimentalBgInput.addEventListener('change', () => {
  chrome.storage.local.set({ experimentalBackground: experimentalBgInput.checked });
});
debugLogInput.addEventListener('change', () => {
  chrome.storage.local.set({ debugLog: debugLogInput.checked });
});

function parseUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u))
    .filter((u, i, arr) => arr.indexOf(u) === i);
}

function displayResults(results) {
  resultsList.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'result-item';

    const dot = document.createElement('div');
    dot.className = 'result-dot ' + r.status;
    item.appendChild(dot);

    const textWrap = document.createElement('div');
    const urlEl = document.createElement('div');
    urlEl.className = 'result-url';
    try {
      urlEl.textContent = new URL(r.url).hostname;
    } catch (_e) {
      urlEl.textContent = r.url;
    }
    textWrap.appendChild(urlEl);

    const reasonEl = document.createElement('div');
    reasonEl.className = 'result-reason';
    reasonEl.textContent = r.status === 'success' ? r.reason : 'FAILED: ' + r.reason;
    textWrap.appendChild(reasonEl);

    item.appendChild(textWrap);
    resultsList.appendChild(item);
  }
  resultsSection.style.display = 'block';
}

submitBtn.addEventListener('click', async () => {
  const urls = parseUrls(urlsInput.value);
  const prompt = promptInput.value;
  const skipWait = skipWaitInput.checked;

  if (urls.length === 0) {
    statusEl.textContent = 'Enter at least one URL first.';
    return;
  }
  if (!prompt) {
    statusEl.textContent = 'Enter a prompt first.';
    return;
  }

  resultsSection.style.display = 'none';
  resultsList.innerHTML = '';
  await chrome.storage.local.remove('lastRunResults');

  chrome.storage.local.set({ lastUrls: urlsInput.value, skipWait, experimentalBackground: experimentalBgInput.checked, debugLog: debugLogInput.checked });

  submitBtn.disabled = true;
  statusEl.textContent = 'Working... opening ' + urls.length + ' tab' + (urls.length > 1 ? 's' : '') + ' in parallel.';

  try {
    await chrome.runtime.sendMessage({
      type: 'RUN_AUTOMATION',
      urls,
      prompt,
      skipWait,
      experimentalBackground: experimentalBgInput.checked,
      debugLog: debugLogInput.checked
    });
    statusEl.textContent = 'Tabs opened. Sending prompt, then verifying...';
  } catch (e) {
    statusEl.textContent = 'Error: ' + (e && e.message ? e.message : e);
    submitBtn.disabled = false;
    return;
  }

  pollForResults();
});

// ---- Stealth Mode Experiment ----
const stealthUrlInput = document.getElementById('stealthUrl');
const stealthTestBtn = document.getElementById('stealthTestBtn');
const stealthStatusEl = document.getElementById('stealthStatus');

// Restore last stealth test URL
chrome.storage.local.get(['lastStealthUrl'], (res) => {
  if (res.lastStealthUrl) stealthUrlInput.value = res.lastStealthUrl;
});

stealthTestBtn.addEventListener('click', async () => {
  const testUrl = stealthUrlInput.value.trim();
  const mainUrls = parseUrls(urlsInput.value);
  const prompt = promptInput.value;

  if (!prompt) {
    stealthStatusEl.textContent = 'Enter a prompt in the main prompt box first.';
    return;
  }

  const urlsToTest = mainUrls.length > 0 ? mainUrls : (testUrl ? [testUrl] : []);

  if (urlsToTest.length === 0) {
    stealthStatusEl.textContent = 'Enter URLs in the main box or the stealth URL field.';
    return;
  }

  if (testUrl) {
    chrome.storage.local.set({ lastStealthUrl: testUrl });
  }

  stealthTestBtn.disabled = true;
  stealthStatusEl.style.color = '#9ad';
  stealthStatusEl.textContent = `Starting stealth test (${urlsToTest.length} tab(s))... MINIMIZE CHROME NOW!`;

  try {
    if (urlsToTest.length === 1) {
      // Single tab (existing behavior)
      const result = await chrome.runtime.sendMessage({
        type: 'RUN_STEALTH_TEST',
        url: urlsToTest[0],
        prompt
      });

      if (result && result.success) {
        stealthStatusEl.textContent = '✅ SUCCESS: ' + result.reason;
        stealthStatusEl.style.color = '#4caf50';
      } else {
        stealthStatusEl.textContent = '❌ FAILED: ' + (result ? result.reason : 'No response');
        stealthStatusEl.style.color = '#f44336';
      }
    } else {
      // Multi-tab
      const response = await chrome.runtime.sendMessage({
        type: 'RUN_STEALTH_MULTI_TEST',
        urls: urlsToTest,
        prompt
      });

      if (response && response.results && response.results.length > 0) {
        const successCount = response.results.filter(r => r.success).length;
        const totalCount = response.results.length;
        let summary = `${successCount}/${totalCount} succeeded\n`;
        for (const r of response.results) {
          const hostname = (() => { try { return new URL(r.url).hostname; } catch(_e) { return r.url; } })();
          summary += `${r.success ? '✅' : '❌'} ${hostname}: ${r.reason}\n`;
        }
        stealthStatusEl.textContent = summary;
        stealthStatusEl.style.color = successCount === totalCount ? '#4caf50' : '#ff9800';
      } else {
        stealthStatusEl.textContent = '❌ No results returned';
        stealthStatusEl.style.color = '#f44336';
      }
    }
  } catch (e) {
    stealthStatusEl.textContent = '❌ ERROR: ' + (e && e.message ? e.message : e);
    stealthStatusEl.style.color = '#f44336';
  }

  stealthTestBtn.disabled = false;
});

function pollForResults() {
  var maxWait = 180000;
  var interval = 1000;
  var elapsed = 0;

  function check() {
    chrome.storage.local.get(['lastRunResults', 'lastRunFinishedAt'], (res) => {
      if (res.lastRunFinishedAt && res.lastRunResults) {
        displayResults(res.lastRunResults);
        var successCount = res.lastRunResults.filter(function (r) { return r.status === 'success'; }).length;
        var totalCount = res.lastRunResults.length;
        statusEl.textContent = 'Done: ' + successCount + '/' + totalCount + ' succeeded.';
        submitBtn.disabled = false;
        return;
      }
      elapsed += interval;
      if (elapsed >= maxWait) {
        statusEl.textContent = 'Timed out waiting for results. Check service worker console.';
        submitBtn.disabled = false;
        return;
      }
      setTimeout(check, interval);
    });
  }
  check();
}
```
