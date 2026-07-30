// ============================================================================
// AI Chat Auto-Prompt — background service worker
//
// PART 1: Sending prompts to AI chat sites via CDP keystroke injection.
// PART 2: Reading AI responses via a CDP-injected DOM watcher.
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
// INPUT DETECTION (auto-cycle): Primary method polls document.activeElement
// for up to 8s. If the site doesn't auto-focus its input, a fallback kicks
// in: the extension simulates Tab keypresses (via debugger, trusted events,
// page-only — the omnibox is never reached) to walk through all focusable
// elements, collects text-input candidates, scores them (textarea >
// contenteditable > input, large > small, bottom-of-page > top-of-page),
// and focuses the best match. If both methods fail, the tab is aborted with
// a clear error (no blind firing).
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
// STEALTH MODE: The "experimentalBackground" toggle switches to a fully
// background "stealth" mode. Each tab is opened as about:blank, visibility
// and focus are spoofed at the protocol level BEFORE any page JS runs, then
// the tab navigates to the real URL. The input is located with a direct DOM
// search (no OS focus needed), focused via CDP DOM.focus, and the prompt is
// injected via Input.insertText + Enter. All tabs run in parallel and the
// whole flow works while Chrome is minimized, with no focus stealing.
// ============================================================================

// ---- In-progress submission state (kept in memory, synced to storage) ------
let currentSubmission = null;

function saveSubmissionToStorage() {
  if (!currentSubmission) return;
  chrome.storage.local.set({ [STORAGE_KEY]: currentSubmission }).catch(() => {});
}

function updateKeepalive(active) {
  if (active) {
    chrome.alarms.get(KEEPALIVE_ALARM_NAME, (alarm) => {
      if (!alarm) chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
    });
  } else {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_AUTOMATION') {
    // Supplementary note 4: reject new submit while running
    if (currentSubmission && currentSubmission.status === 'running') {
      sendResponse({ ok: false, error: 'Submission already in progress' });
      return true;
    }

    const sessionCode = msg.sessionCode || generateSessionCode();
    const sid = msg.submissionId || (Date.now() + '-' + Math.random().toString(36).slice(2, 10));
    const originalPrompt = (msg.prompt || '').trim();

    // Build & validate marker plan (up to 5 retries)
    let markerPlan, attempts = 0;
    while (attempts < 5) {
      const code = attempts === 0 ? sessionCode : generateSessionCode();
      markerPlan = buildMarkerPlan(code, originalPrompt);
      if (validateMarkerPlan(markerPlan)) break;
      attempts++;
    }
    if (!markerPlan || !validateMarkerPlan(markerPlan)) {
      console.error('[MarkerPart2] marker collision after 5 attempts');
      sendResponse({ ok: false, error: 'marker collision' });
      return true;
    }

    console.log('[MarkerPart2] submission started', sid, markerPlan.sessionCode);

    currentSubmission = {
      submissionId: sid,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      originalPrompt,
      sessionCode: markerPlan.sessionCode,
      startMarker: markerPlan.startMarker,
      endMarker: markerPlan.endMarker,
      wrappedPrompt: markerPlan.wrappedPrompt,
      options: {
        stealthMode: !!msg.experimentalBackground,
        skipWait: !!msg.skipWait,
        experimentalBackground: !!msg.experimentalBackground
      },
      tabs: []
    };
    saveSubmissionToStorage();
    updateKeepalive(true);

    // Pass delay(100) before running
    delay(PREPARE_DELAY_MS).then(() => {
      runAutomation(msg.urls, markerPlan.wrappedPrompt, markerPlan, {
        skipWait: !!msg.skipWait,
        experimentalBackground: !!msg.experimentalBackground
      }).catch((err) => console.error('[AI Chat Auto-Prompt] automation failed:', err));
    });

    sendResponse({ ok: true });
    return true;
  }
  return false;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Logger (console only) -------------------------------------------------
function makeLogger() {
  function log(scope, message, data) {
    console.log(`[AI Chat Auto-Prompt] [${scope}] ${message}`, data !== undefined ? data : '');
  }
  return { log };
}

// ---- Marker-based Part 2 constants & helpers --------------------------------
const MARKER_START_PREFIX = "APSTART-";
const MARKER_END_PREFIX = "APEND-";
const SESSION_CODE_LENGTH = 10;
const SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREPARE_DELAY_MS = 100;
const MARKER_POLL_MS = 400;
const MARKER_MAX_WAIT_MS = 120000;
const MARKER_CONFIRM_POLLS = 2;
const MARKER_ANOMALY_GRACE_MS = 5000;
const BACKGROUND_SAFETY_TIMEOUT_MS = 130000;
const STORAGE_KEY = "autoprompt_latest_submission";
const KEEPALIVE_ALARM_NAME = "autoprompt-marker-keepalive";

function generateSessionCode() {
  const bytes = new Uint8Array(SESSION_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    code += SESSION_CODE_ALPHABET[bytes[i] % SESSION_CODE_ALPHABET.length];
  }
  return code;
}

function buildMarkerPlan(sessionCode, originalPrompt) {
  const startMarker = MARKER_START_PREFIX + sessionCode;
  const endMarker = MARKER_END_PREFIX + sessionCode;
  const trimmed = (originalPrompt || "").trim();
  const wrappedPrompt =
    "MANDATORY OUTPUT FORMAT:\n" +
    "You must strictly follow this output format. Do not include any conversational filler before or after the required markers.\n" +
    "Do not wrap the markers in markdown formatting (no backticks, no bold, no bullet points, no headers).\n" +
    "Output the markers as plain text exactly as shown.\n" +
    "\n" +
    "Session Code: " + sessionCode + "\n" +
    "\n" +
    "Instructions:\n" +
    "- Your very first line must be: " + MARKER_START_PREFIX + " followed immediately by the session code\n" +
    "- Your very last line must be: " + MARKER_END_PREFIX + " followed immediately by the session code\n" +
    "- Do not print these markers anywhere else in your response\n" +
    "- Do not explain the format or mention the session code in your actual answer\n" +
    "\n" +
    "USER REQUEST:\n" +
    trimmed;
  return { sessionCode, startMarker, endMarker, wrappedPrompt, originalPrompt: trimmed };
}

function validateMarkerPlan(plan) {
  if (!plan.sessionCode || plan.sessionCode.length !== SESSION_CODE_LENGTH) return false;
  if (!plan.originalPrompt) return false;
  if (plan.wrappedPrompt.indexOf(plan.startMarker) !== -1) return false;
  if (plan.wrappedPrompt.indexOf(plan.endMarker) !== -1) return false;
  return true;
}

function applyWatcherResult(result, watcherResult, markerPlan) {
  result.responseStatus = watcherResult.status;
  result.answer = watcherResult.answer;
  result.answerLength = watcherResult.answer.length;
  result.confidence = watcherResult.confidence;
  result.responseReason = watcherResult.reason;
  result.method = watcherResult.method;
  result.startCount = watcherResult.startCount;
  result.endCount = watcherResult.endCount;
  result.responseDurationMs = watcherResult.durationMs;
  result.status = (watcherResult.status === 'success' || watcherResult.status === 'partial') ? 'success' : 'failed';
  result.sessionCode = markerPlan.sessionCode;
  result.startMarker = markerPlan.startMarker;
  result.endMarker = markerPlan.endMarker;
}

// ---- Marker watcher (injected via CDP Runtime.evaluate) --------------------
function buildMarkerWatcherExpression(plan) {
  const config = {
    startMarker: plan.startMarker,
    endMarker: plan.endMarker,
    pollMs: MARKER_POLL_MS,
    maxWaitMs: MARKER_MAX_WAIT_MS,
    confirmPolls: MARKER_CONFIRM_POLLS,
    anomalyGraceMs: MARKER_ANOMALY_GRACE_MS
  };
  const configJson = JSON.stringify(config);
  return `
    (function() {
      var cfg = ${configJson};
      return new Promise(function(resolve) {
        var startedAt = Date.now();
        var exactConfirmCount = 0;
        var anomalyConfirmCount = 0;
        var firstMarkerSeenAt = null;
        var resolved = false;

        function finalize(value) {
          if (resolved) return;
          resolved = true;
          resolve(value);
        }

        function countMarkers(text, marker) {
          if (!text) return 0;
          var count = 0, idx = 0;
          while (idx !== -1) {
            idx = text.indexOf(marker, idx);
            if (idx !== -1) { count++; idx += marker.length; }
          }
          return count;
        }

        function tryExtract(text, firstStartIdx, lastStartIdx, lastEndIdx, mode) {
          if (mode === 'exact' && lastEndIdx > lastStartIdx) {
            return text.substring(lastStartIdx + cfg.startMarker.length, lastEndIdx).trim();
          } else if (mode === 'anomaly' && lastEndIdx > firstStartIdx) {
            return text.substring(firstStartIdx + cfg.startMarker.length, lastEndIdx).trim();
          } else if (mode === 'partial' && lastStartIdx !== -1) {
            return text.substring(lastStartIdx + cfg.startMarker.length).trim();
          }
          return '';
        }

        function findMarkers(text) {
          if (!text) return { startCount: 0, endCount: 0, firstStartIdx: -1, lastStartIdx: -1, lastEndIdx: -1 };
          return {
            startCount: countMarkers(text, cfg.startMarker),
            endCount: countMarkers(text, cfg.endMarker),
            firstStartIdx: text.indexOf(cfg.startMarker),
            lastStartIdx: text.lastIndexOf(cfg.startMarker),
            lastEndIdx: text.lastIndexOf(cfg.endMarker)
          };
        }

        function checkShadowRoots(root) {
          if (!root || !root.querySelectorAll) return '';
          var result = '';
          if (root.textContent) result += root.textContent + ' ';
          try {
            var all = root.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              if (all[i].shadowRoot && all[i].shadowRoot.textContent) {
                result += all[i].shadowRoot.textContent + ' ';
              }
            }
          } catch(e) {}
          return result;
        }

        function makeResult(ok, status, answer, confidence, method, reason, sc, ec, elapsed) {
          return {
            ok: ok, status: status, answer: answer, confidence: confidence,
            method: method, reason: reason, startCount: sc, endCount: ec,
            durationMs: elapsed || (Date.now() - startedAt),
            url: location.href, title: document.title
          };
        }

        function poll() {
          try {
            if (!document.body) { setTimeout(poll, cfg.pollMs); return; }

            var text = (document.body.textContent || '');
            var m = findMarkers(text);

            if (m.startCount === 0 && m.endCount === 0) {
              var altText = (document.body.innerText || '');
              if (altText !== text) {
                var altM = findMarkers(altText);
                if (altM.startCount > 0 || altM.endCount > 0) { text = altText; m = altM; }
              }
              if (m.startCount === 0 && m.endCount === 0) {
                var shText = checkShadowRoots(document.body);
                if (shText) {
                  var shM = findMarkers(shText);
                  if (shM.startCount > 0 || shM.endCount > 0) { m = shM; }
                }
              }
            }

            var elapsed = Date.now() - startedAt;

            if (m.startCount === 1 && m.endCount === 1 && m.lastEndIdx > m.lastStartIdx) {
              exactConfirmCount++;
              anomalyConfirmCount = 0;
              if (exactConfirmCount >= cfg.confirmPolls) {
                var answer = tryExtract(text, m.firstStartIdx, m.lastStartIdx, m.lastEndIdx, 'exact');
                finalize(makeResult(true, 'success', answer, 'high', 'markers-exact', 'markers found', m.startCount, m.endCount, elapsed));
                return;
              }
            } else if (m.startCount >= 1 && m.endCount >= 1 && m.lastEndIdx > m.lastStartIdx) {
              if (firstMarkerSeenAt === null) firstMarkerSeenAt = Date.now();
              if (Date.now() - firstMarkerSeenAt >= cfg.anomalyGraceMs) {
                anomalyConfirmCount++;
                if (anomalyConfirmCount >= cfg.confirmPolls) {
                  var answer = tryExtract(text, m.firstStartIdx, m.lastStartIdx, m.lastEndIdx, 'anomaly');
                  finalize(makeResult(true, 'success', answer, 'low', 'markers-anomaly', 'marker count anomaly', m.startCount, m.endCount, elapsed));
                  return;
                }
              }
            } else {
              exactConfirmCount = 0;
              anomalyConfirmCount = 0;
            }

            if (m.startCount > 0 || m.endCount > 0) {
              if (firstMarkerSeenAt === null) firstMarkerSeenAt = Date.now();
            }

            if (elapsed >= cfg.maxWaitMs) {
              if (m.startCount > 0 && m.endCount === 0) {
                var partialAnswer = tryExtract(text, m.firstStartIdx, m.lastStartIdx, m.lastEndIdx, 'partial');
                finalize(makeResult(true, 'partial', partialAnswer, 'low', 'partial-start-only', 'end marker missing', m.startCount, m.endCount, elapsed));
              } else {
                finalize(makeResult(false, 'failed', '', 'low', 'none', 'markers not found', m.startCount, m.endCount, elapsed));
              }
              return;
            }
          } catch (err) {
            finalize(makeResult(false, 'failed', '', 'low', 'watcher-error', err.message || String(err), 0, 0, Date.now() - startedAt));
            return;
          }
          setTimeout(poll, cfg.pollMs);
        }

        poll();
      });
    })()
  `;
}

async function waitForMarkerResponse(tabId, plan, logger) {
  const log = (msg) => logger.log(tabId, '[MarkerPart2] ' + msg);
  const startTime = Date.now();

  try {
    const expression = buildMarkerWatcherExpression(plan);
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: BACKGROUND_SAFETY_TIMEOUT_MS
    });

    if (result && result.result && result.result.value) {
      const w = result.result.value;
      log('watcher result: ' + w.status + ' (' + w.method + ') duration=' + w.durationMs + 'ms');
      return {
        status: w.status,
        answer: w.answer || '',
        confidence: w.confidence || 'low',
        method: w.method || 'unknown',
        reason: w.reason || '',
        startCount: w.startCount || 0,
        endCount: w.endCount || 0,
        durationMs: w.durationMs || (Date.now() - startTime)
      };
    }

    // No return value — treat as failure
    log('watcher returned no value');
    return {
      status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
      reason: 'no return value', startCount: 0, endCount: 0, durationMs: Date.now() - startTime
    };
  } catch (e) {
    const msg = e.message || String(e);

    // Navigation / context destruction — retry once
    if (msg.includes('target') || msg.includes('context') || msg.includes('navigation') || msg.includes('detached')) {
      log('watcher context lost (' + msg + ') — waiting for reload and retrying once');
      try {
        // Supplementary note 5: check if debugger was detached
        if (msg.includes('detached')) {
          return {
            status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
            reason: 'debugger detached', startCount: 0, endCount: 0, durationMs: Date.now() - startTime
          };
        }
        // Wait for tab to finish loading (max 15s)
        await waitForTabComplete(tabId, 15000);
        // Retry watcher once
        const retryResult = await waitForMarkerResponse(tabId, plan, logger);
        log('watcher retry result: ' + retryResult.status);
        return retryResult;
      } catch (retryErr) {
        log('watcher retry also failed: ' + (retryErr.message || String(retryErr)));
        return {
          status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
          reason: 'navigation failure', startCount: 0, endCount: 0, durationMs: Date.now() - startTime
        };
      }
    }

    log('watcher error: ' + msg);
    return {
      status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
      reason: msg, startCount: 0, endCount: 0, durationMs: Date.now() - startTime
    };
  }
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
  await delay(1300);
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
async function recheckFailedTab(result, markerPlan, logger) {
  try {
    const tab = await chrome.tabs.get(result.tabId);

    await chrome.tabs.update(result.tabId, { active: true });
    if (tab && tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    logger.log(result.tabId, 'Re-check: activated tab (' + result.url + ')');

    await delay(1500);

    const verification = await verifySend(result.tabId, result.url, logger);
    if (verification.verified) {
      result.sendStatus = 'success';
      result.sendReason = 'Re-check: ' + verification.reason;
      logger.log(result.tabId, 'Re-check passed — running marker watcher');
      // Attach debugger for marker watcher
      try {
        await chrome.debugger.attach({ tabId: result.tabId }, '1.3');
      } catch (e) {
        if (!e.message || !e.message.includes('attached')) {
          result.sendStatus = 'failed';
          result.sendReason = 'Re-check: debugger attach failed';
          result.status = 'error';
          result.reason = 'Re-check: debugger attach failed: ' + e.message;
          return;
        }
      }
      const watcherResult = await waitForMarkerResponse(result.tabId, markerPlan, logger);
      applyWatcherResult(result, watcherResult, markerPlan);
      try { await chrome.debugger.detach({ tabId: result.tabId }); } catch (_e) {}
      return;
    }

    logger.log(result.tabId, 'Re-check failed — evaluating Stage 3 (Retry Enter)');

    const remainingText = await getMarkedInputContent(result.tabId);
    if (remainingText === null || remainingText.trim() === '') {
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Re-check failed: ' + verification.reason;
      result.reason = 'Re-check failed: ' + verification.reason;
      logger.log(result.tabId, 'Stage 3 skipped — input box is empty or no longer exists');
      return;
    }

    logger.log(result.tabId, 'Stage 3: input box still contains text — focusing input and retrying Enter');

    const focused = await focusMarkedInput(result.tabId);
    if (!focused) {
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Retry Enter skipped (could not focus marked input)';
      result.reason = 'Re-check failed: ' + verification.reason + '; Retry Enter skipped (could not focus marked input)';
      logger.log(result.tabId, 'Stage 3 failed — could not focus marked input');
      return;
    }

    await delay(200);

    let debuggerAttached = false;
    try {
      await chrome.debugger.attach({ tabId: result.tabId }, '1.3');
      // Supplementary note 5: handle "already attached" error
      debuggerAttached = true;
      logger.log(result.tabId, 'Stage 3: debugger re-attached for Enter retry');
    } catch (e) {
      if (e.message && e.message.includes('attached')) {
        logger.log(result.tabId, 'Stage 3: debugger already attached — using existing');
        debuggerAttached = true;
      } else {
        logger.log(result.tabId, 'Stage 3: debugger attach failed: ' + e.message);
      }
    }

    if (!debuggerAttached) {
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Retry Enter skipped (debugger attach failed)';
      result.reason = 'Re-check failed: ' + verification.reason + '; Retry Enter skipped (debugger attach failed)';
      return;
    }

    try {
      await sendEnterOnly(result.tabId);
      logger.log(result.tabId, 'Stage 3: Enter retry dispatched');
      await delay(300);

      const retryVerification = await verifySend(result.tabId, result.url, logger);
      if (retryVerification.verified) {
        result.sendStatus = 'success';
        result.sendReason = 'Retry Enter success: ' + retryVerification.reason;
        logger.log(result.tabId, 'Stage 3 success — running marker watcher');
        const watcherResult = await waitForMarkerResponse(result.tabId, markerPlan, logger);
        applyWatcherResult(result, watcherResult, markerPlan);
      } else {
        result.status = 'error';
        result.sendStatus = 'failed';
        result.sendReason = 'Retry Enter failed: ' + retryVerification.reason;
        result.reason = 'Retry Enter failed: ' + retryVerification.reason;
        logger.log(result.tabId, 'Stage 3 failed — status remains error');
      }
    } finally {
      try {
        await chrome.debugger.detach({ tabId: result.tabId });
        logger.log(result.tabId, 'Stage 3: debugger detached');
      } catch (_e) {}
    }
  } catch (e) {
    logger.log(result.tabId || result.url, 'Re-check error: ' + e.message);
    result.status = 'error';
    result.sendStatus = 'failed';
    result.sendReason = 'Re-check error: ' + e.message;
    result.reason = 'Re-check error: ' + e.message;
  } finally {
    delete result.needsRecheck;
    if (result.tabId) {
      try { await cleanupInputElementMark(result.tabId); } catch (_e) {}
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

async function sendToActivatedTab(tabId, url, prompt, markerPlan, logger) {
  const result = { url, tabId, status: 'unknown', reason: '', sendStatus: 'failed', sendReason: '', originalPrompt: markerPlan ? markerPlan.originalPrompt : '' };
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
      result.sendStatus = 'failed';
      result.sendReason = 'No input box found';
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
      result.sendStatus = 'success';
      result.sendReason = verification.reason;
      logger.log(tabId, 'Send verified — running marker watcher');
      const watcherResult = await waitForMarkerResponse(tabId, markerPlan, logger);
      applyWatcherResult(result, watcherResult, markerPlan);
      await cleanupInputElementMark(tabId);
    } else {
      result.sendStatus = 'failed';
      result.sendReason = verification.reason;
      result.status = 'error';
      result.reason = verification.reason;
      result.needsRecheck = true;
      logger.log(tabId, 'Initial verification failed — tab marked for targeted re-check');
    }
  } catch (e) {
    logger.log(tabId, `Error during send: ${e.message}`);
    result.sendStatus = 'failed';
    result.sendReason = e.message;
    result.status = 'error';
    result.reason = e.message;
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

async function runAutomationAutoCycle(urls, prompt, markerPlan, skipWait, logger) {
  logger.log('main', 'Starting run: ' + urls.length + ' URL(s), skipWait=' + skipWait + ', mode=auto-cycle');

  const tabPromises = urls.map((url) => openAndAttach(url, skipWait, logger));

  const readyQueue = [];
  const failedTabs = [];
  const startTime = Date.now();

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
          logger.log(result.tabId, 'Added to Ready Queue (Position ' + readyQueue.length + ')');
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
      if (firstResult.ok && firstResult.tabId) readyQueue.push(firstResult);
      else failedTabs.push(firstResult);
      tabPromises[firstIdx] = null;
      break;
    }
    if (readyQueue.length > 0) break;
    await delay(100);
  }

  const results = [...failedTabs];
  for (const state of readyQueue) {
    const result = await sendToActivatedTab(state.tabId, state.url, prompt, markerPlan, logger);
    results.push(result);
    if (currentSubmission) {
      currentSubmission.tabs = results.map(r => ({ ...r }));
      saveSubmissionToStorage();
    }
  }

  for (let i = 0; i < tabPromises.length; i++) {
    if (tabPromises[i] === null) continue;
    const state = await tabPromises[i];
    if (!state.ok || !state.tabId) {
      const errResult = { url: state.url, tabId: state.tabId || null, status: 'error', reason: 'Failed to open or attach debugger', sendStatus: 'failed', sendReason: 'Failed to open or attach debugger' };
      results.push(errResult);
      if (currentSubmission) {
        currentSubmission.tabs = results.map(r => ({ ...r }));
        saveSubmissionToStorage();
      }
      continue;
    }
    logger.log(state.tabId, 'Tab finished loading, added to processing queue.');
    const result = await sendToActivatedTab(state.tabId, state.url, prompt, markerPlan, logger);
    results.push(result);
    if (currentSubmission) {
      currentSubmission.tabs = results.map(r => ({ ...r }));
      saveSubmissionToStorage();
    }
  }

  const tabsToRecheck = results.filter((r) => r.needsRecheck && r.tabId);
  if (tabsToRecheck.length > 0) {
    logger.log('main', tabsToRecheck.length + ' tab(s) flagged — starting targeted re-check.');
    for (const failedResult of tabsToRecheck) {
      await recheckFailedTab(failedResult, markerPlan, logger);
      if (currentSubmission) {
        const idx = results.indexOf(failedResult);
        if (idx !== -1) results[idx] = failedResult;
        currentSubmission.tabs = results.map(r => ({ ...r }));
        saveSubmissionToStorage();
      }
    }
  }

  results.forEach((r) => delete r.needsRecheck);
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

async function stealthSendToTab(tabState, prompt, markerPlan, skipWait, logger) {
  const { tabId, url } = tabState;
  const result = { url, tabId, status: 'unknown', reason: '', sendStatus: 'failed', sendReason: '', originalPrompt: markerPlan ? markerPlan.originalPrompt : '' };

  try {
    // Wait for the page to load
    if (skipWait) {
      await delay(1500);
      logger.log(tabId, 'Stealth: skip-wait mode — used 1.5s settle delay');
    } else {
      await delay(500);
      await waitForTabComplete(tabId, 30000);
      await delay(1200);
      logger.log(tabId, 'Stealth: waited for full page load + grace period');
    }

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
      result.sendStatus = 'failed';
      result.sendReason = 'No input box found';
      result.reason = 'No input box found (stealth DOM search)';
      return result;
    }

    logger.log(tabId, 'Stealth: input candidate found — focusing via CDP DOM.focus');
    await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', { objectId: evalResult.result.objectId });
    await delay(300);

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

    const verification = await verifySend(tabId, url, logger);

    if (verification.verified) {
      result.sendStatus = 'success';
      result.sendReason = verification.reason;
      logger.log(tabId, 'Send verified — running marker watcher');
      const watcherResult = await waitForMarkerResponse(tabId, markerPlan, logger);
      applyWatcherResult(result, watcherResult, markerPlan);
      await cleanupInputElementMark(tabId);
    } else {
      result.sendStatus = 'failed';
      result.sendReason = verification.reason;
      result.status = 'error';
      result.reason = verification.reason;
      result.needsRecheck = true;
      logger.log(tabId, 'Stealth: initial verification failed — marked for re-check');
    }
  } catch (e) {
    logger.log(tabId, `Stealth send error: ${e.message}`);
    result.sendStatus = 'failed';
    result.sendReason = e.message;
    result.status = 'error';
    result.reason = e.message;
    try { await cleanupInputElementMark(tabId); } catch (_e) {}
  }

  return result;
}

async function stealthRecheckFailedTab(result, markerPlan, logger) {
  try {
    logger.log(result.tabId, `Stealth re-check: waiting for page to settle (${result.url})`);

    await delay(2000);

    const verification = await verifySend(result.tabId, result.url, logger);
    if (verification.verified) {
      result.sendStatus = 'success';
      result.sendReason = 'Re-check: ' + verification.reason;
      logger.log(result.tabId, 'Stealth re-check passed — running marker watcher');
      const watcherResult = await waitForMarkerResponse(result.tabId, markerPlan, logger);
      applyWatcherResult(result, watcherResult, markerPlan);
      return;
    }

    logger.log(result.tabId, 'Stealth re-check failed — evaluating Stage 3 (Retry Enter)');

    const remainingText = await getMarkedInputContent(result.tabId);
    if (remainingText === null || remainingText.trim() === '') {
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Re-check failed: ' + verification.reason;
      result.reason = 'Re-check failed: ' + verification.reason;
      logger.log(result.tabId, 'Stage 3 skipped — input box is empty or no longer exists');
      return;
    }

    logger.log(result.tabId, 'Stage 3: input still has text — re-focusing via CDP and retrying Enter');

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
        result.sendStatus = 'failed';
        result.sendReason = 'Retry Enter skipped (element not found)';
        result.reason = 'Re-check failed: ' + verification.reason + '; Retry Enter skipped (element not found)';
        return;
      }
    } catch (e) {
      logger.log(result.tabId, 'Stage 3: CDP focus error: ' + e.message);
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Retry Enter skipped (CDP focus error)';
      result.reason = 'Re-check failed: ' + verification.reason + '; Retry Enter skipped (CDP focus error)';
      return;
    }

    try {
      await sendEnterOnly(result.tabId);
      logger.log(result.tabId, 'Stage 3: Enter retry dispatched');
      await delay(300);

      const retryVerification = await verifySend(result.tabId, result.url, logger);
      if (retryVerification.verified) {
        result.sendStatus = 'success';
        result.sendReason = 'Retry Enter success: ' + retryVerification.reason;
        logger.log(result.tabId, 'Stage 3 success — running marker watcher');
        const watcherResult = await waitForMarkerResponse(result.tabId, markerPlan, logger);
        applyWatcherResult(result, watcherResult, markerPlan);
      } else {
        result.status = 'error';
        result.sendStatus = 'failed';
        result.sendReason = 'Retry Enter failed: ' + retryVerification.reason;
        result.reason = 'Retry Enter failed: ' + retryVerification.reason;
        logger.log(result.tabId, 'Stage 3 failed — status remains error');
      }
    } catch (e) {
      logger.log(result.tabId, 'Stage 3 error: ' + e.message);
      result.status = 'error';
      result.sendStatus = 'failed';
      result.sendReason = 'Retry Enter error: ' + e.message;
      result.reason = 'Retry Enter error: ' + e.message;
    }
  } catch (e) {
    logger.log(result.tabId || result.url, 'Stealth re-check error: ' + e.message);
    result.status = 'error';
    result.sendStatus = 'failed';
    result.sendReason = 'Re-check error: ' + e.message;
    result.reason = 'Re-check error: ' + e.message;
  } finally {
    delete result.needsRecheck;
    if (result.tabId) {
      try { await cleanupInputElementMark(result.tabId); } catch (_e) {}
    }
  }
}

async function runAutomationStealth(urls, prompt, markerPlan, skipWait, logger) {
  logger.log('main', 'Starting run: ' + urls.length + ' URL(s), skipWait=' + skipWait + ', mode=stealth');

  const setupResults = await Promise.all(
    urls.map((url) => stealthSetupTab(url, logger))
  );

  const results = [];
  const readyTabs = [];
  for (const state of setupResults) {
    if (state.ok && state.tabId) {
      readyTabs.push(state);
    } else {
      results.push({ url: state.url, tabId: state.tabId || null, status: 'error', reason: 'Stealth setup failed: ' + (state.error || 'unknown'), sendStatus: 'failed', sendReason: 'Stealth setup failed' });
    }
  }
  logger.log('main', 'Stealth: ' + readyTabs.length + ' tab(s) ready, ' + results.length + ' failed setup');

  const sendResults = await Promise.all(
    readyTabs.map((state) => stealthSendToTab(state, prompt, markerPlan, skipWait, logger))
  );
  results.push(...sendResults);
  if (currentSubmission) {
    currentSubmission.tabs = results.map(r => ({ ...r }));
    saveSubmissionToStorage();
  }

  const tabsToRecheck = results.filter((r) => r.needsRecheck && r.tabId);
  if (tabsToRecheck.length > 0) {
    logger.log('main', 'Stealth: ' + tabsToRecheck.length + ' tab(s) flagged — starting re-check');
    for (const failedResult of tabsToRecheck) {
      await stealthRecheckFailedTab(failedResult, markerPlan, logger);
      if (currentSubmission) {
        const idx = results.indexOf(failedResult);
        if (idx !== -1) results[idx] = failedResult;
        currentSubmission.tabs = results.map(r => ({ ...r }));
        saveSubmissionToStorage();
      }
    }
  }

  for (const state of readyTabs) {
    try { await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false }); } catch (_e) {}
    try { await chrome.debugger.detach({ tabId: state.tabId }); logger.log(state.tabId, 'Stealth: debugger detached'); } catch (_e) {}
  }

  results.forEach((r) => delete r.needsRecheck);
  return results;
}

// ---- Main entry point --------------------------------------------------------
async function runAutomation(urls, prompt, markerPlan, opts) {
  const logger = makeLogger();
  try {
    if (!Array.isArray(urls) || urls.length === 0) {
      logger.log('main', 'No URLs provided, aborting.');
      if (currentSubmission) {
        currentSubmission.status = 'completed';
        currentSubmission.finishedAt = Date.now();
        currentSubmission.tabs = currentSubmission.tabs || [];
        saveSubmissionToStorage();
      }
      return;
    }

    let results;
    if (opts.experimentalBackground) {
      results = await runAutomationStealth(urls, prompt, markerPlan, opts.skipWait, logger);
    } else {
      results = await runAutomationAutoCycle(urls, prompt, markerPlan, opts.skipWait, logger);
    }

    // Mark submission completed
    if (currentSubmission) {
      currentSubmission.status = 'completed';
      currentSubmission.finishedAt = Date.now();
      currentSubmission.tabs = results.map(r => ({ ...r }));
      saveSubmissionToStorage();
      updateKeepalive(false);
    }

    logger.log('main', 'Submission completed. ' + results.length + ' tab(s) processed.');
    return results;
  } catch (err) {
    logger.log('main', 'Unhandled error: ' + (err && err.message));
    if (currentSubmission) {
      currentSubmission.status = 'completed';
      currentSubmission.finishedAt = Date.now();
      currentSubmission.tabs = currentSubmission.tabs || [];
      saveSubmissionToStorage();
      updateKeepalive(false);
    }
    throw err;
  }
}

// Keepalive alarm — keeps the service worker alive while submission runs
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    // No-op: just prevents the worker from being killed
    if (currentSubmission && currentSubmission.status === 'running') {
      chrome.storage.local.get(STORAGE_KEY, () => {});
    }
  }
});