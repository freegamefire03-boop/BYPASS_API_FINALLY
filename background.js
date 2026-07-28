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

    await cleanupInputElementMark(tabId);

    if (verification.verified) {
      result.status = 'success';
      result.reason = verification.reason;
    } else {
      result.status = 'error';
      result.reason = verification.reason;
    }
  } catch (e) {
    logger.log(tabId, `Error during send: ${e.message}`);
    result.status = 'error';
    result.reason = e.message;
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
      const firstResult = await tabPromises[0];
      if (firstResult.ok && firstResult.tabId) {
        readyQueue.push(firstResult);
      } else {
        failedTabs.push(firstResult);
      }
      tabPromises[0] = null;
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

  await chrome.storage.local.set({ lastRunResults: results, lastRunFinishedAt: Date.now() });
  logger.log('main', `Run complete. Results stored: ${results.length} tab(s)`);
  return results;
}

// ---- Mode 2 (experimental/legacy): stay in the background, no cycling -----

async function runSingleTabFlowDirect(url, skipWait, prompt, logger) {
  const result = { url, tabId: null, status: 'unknown', reason: '' };
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  result.tabId = tabId;
  logger.log(tabId, `Opened tab for ${url} (experimental: direct background mode)`);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    logger.log(tabId, 'Debugger attached');
  } catch (err) {
    logger.log(tabId, `Debugger attach failed: ${err.message}`);
    result.status = 'error';
    result.reason = `Debugger attach failed: ${err.message}`;
    return result;
  }

  try {
    if (skipWait) {
      await delay(1000);
    } else {
      await waitForTabComplete(tabId);
      await delay(1200);
    }
    let focused = await waitForFocusedInput(tabId);

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
    await delay(250);

    await markInputElement(tabId);

    await sendTextThenEnter(tabId, prompt);
    logger.log(tabId, 'Text inserted + Enter dispatched');

    const verification = await verifySend(tabId, url, logger);

    await cleanupInputElementMark(tabId);

    result.status = verification.verified ? 'success' : 'error';
    result.reason = verification.reason;
  } catch (e) {
    logger.log(tabId, `Error: ${e.message}`);
    result.status = 'error';
    result.reason = e.message;
  } finally {
    await delay(400);
    try {
      await chrome.debugger.detach({ tabId });
      logger.log(tabId, 'Debugger detached');
    } catch (e) {}
  }
  return result;
}

async function runAutomationDirect(urls, prompt, skipWait, logger) {
  logger.log('main', `Starting run: ${urls.length} URL(s), skipWait=${skipWait}, mode=direct-background (experimental)`);

  const results = await Promise.all(
    urls.map((url) =>
      runSingleTabFlowDirect(url, skipWait, prompt, logger).catch((err) => {
        logger.log(url, `Flow failed: ${err.message}`);
        return { url, tabId: null, status: 'error', reason: err.message };
      })
    )
  );

  await chrome.storage.local.set({ lastRunResults: results, lastRunFinishedAt: Date.now() });
  logger.log('main', `Run complete. Results stored: ${results.length} tab(s)`);
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
      results = await runAutomationDirect(urls, prompt, opts.skipWait, logger);
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
      mode: opts.experimentalBackground ? 'direct-background' : 'auto-cycle',
      finishedAt: new Date().toISOString()
    });
  }
}
