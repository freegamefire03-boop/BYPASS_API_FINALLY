importScripts("sites.js"); // loads SITE_CONFIGS (5-site model/thinking steps)

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
// THE CORE PROBLEM THIS FILE SOLVES:
// Chrome only routes real, trusted input (including debugger-injected
// keystrokes via chrome.debugger's Input.dispatchKeyEvent) to the ACTIVE
// tab of a window. A background/inactive tab simply never receives it —
// this isn't a bug, it's how Chrome's input pipeline works, confirmed both
// by Chromium's own issue tracker and by real testing.
//
// THE APPROACH (the only mode): fully background "stealth". Each tab is
// opened as about:blank and visibility/focus are spoofed at the protocol
// level BEFORE any page JS runs, then the tab navigates to the real URL.
// The input is located with a direct DOM search (no OS focus needed),
// focused via CDP DOM.focus, and the prompt is injected via Input.insertText
// + Enter. All tabs run in parallel and the whole flow works while Chrome is
// minimized, with no focus stealing.
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
// are processed, it re-checks only the failed tabs, waits for the page
// to settle, and re-runs the same two-stage verification. This fixes false
// failures caused by sites pausing or delaying DOM updates while backgrounded.
//
// RETRY ENTER: If the targeted re-check still fails and the marked input
// box still contains the prompt text, the extension re-focuses that exact
// input box, re-attaches the debugger, and sends one more trusted Enter
// keystroke. This is the final rescue step. If it fails, the tab remains
// flagged as failed.
// ============================================================================
// PART 3: Per-site model/mode configurator (DeepSeek · Qwen · Gemini · Kimi · Z.ai)
// Merged from "site-configurator final". Runs DOM-based model/thinking toggles
// via inject.js (content-script runner). Two entry points: the popup triggers it
// with {type:"run-config", siteKey, config}, and the send pipeline applies it
// automatically (applySiteSettings) before typing the prompt for a matched site.
// ============================================================================

const SITE_URLS = {
  deepseek: "https://chat.deepseek.com/",
  qwen: "https://chat.qwen.ai/",
  gemini: "https://gemini.google.com/app",
  kimi: "https://www.kimi.com/?chat_enter_method=change_model",
  zai: "https://chat.z.ai/"
};

try {
  chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
  });
} catch (e) {}

async function getOrCreateTab(url) {
  const base = url.replace(/\/+$/, "");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(base));
  if (existing) {
    if (existing.discarded) {
      try {
        await chrome.tabs.reload(existing.id);
      } catch (e) {}
    }
    return existing;
  }
  return chrome.tabs.create({ url, active: false });
}

function waitForLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve(true);
      } catch (e) {
        return resolve(false);
      }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(check, 300);
    };
    check();
  });
}

async function injectAndRun(tabId, config) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, {
          type: "run-config",
          config
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 90000))
      ]);
      if (res) return res;
    } catch (e) {
      // content script not present yet
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["inject.js"]
      });
    } catch (e2) {
      // page not ready
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, error: "could not start runner in tab" };
}

function matchSiteKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const key of Object.keys(SITE_URLS)) {
      const base = new URL(SITE_URLS[key]).hostname.toLowerCase().replace(/^www\./, "");
      if (host === base || host.endsWith("." + base)) return key;
    }
  } catch (e) {}
  return null;
}

async function applySiteSettings(tabId, url, logger) {
  const key = matchSiteKey(url);
  if (!key) return { skipped: true };
  const config = SITE_CONFIGS[key];
  if (!config) return { skipped: true };
  logger.log(tabId, "Config: applying " + key + " model/thinking steps before send");
  const res = await injectAndRun(tabId, config);
  return { skipped: false, siteKey: key, result: res };
}

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
  if (msg && msg.type === 'config-step') {
    chrome.runtime.sendMessage({ type: 'config-step', state: msg.state }).catch(() => {});
    return;
  }
  if (msg && msg.type === 'run-config') {
    (async () => {
      try {
        const url = SITE_URLS[msg.siteKey];
        if (!url) return sendResponse({ ok: false, error: 'unknown site' });
        const tab = await getOrCreateTab(url);
        await waitForLoaded(tab.id, 30000);
        const result = await injectAndRun(tab.id, msg.config);
        sendResponse(result);
      } catch (e) {
        try {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        } catch (e2) {}
      }
    })();
    return true;
  }
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
        skipWait: !!msg.skipWait
      },
      tabs: []
    };
    saveSubmissionToStorage();
    updateKeepalive(true);

    // Pass delay(100) before running
    delay(PREPARE_DELAY_MS).then(() => {
      runAutomation(msg.urls, markerPlan.wrappedPrompt, markerPlan, {
        skipWait: !!msg.skipWait
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
const MARKER_POLL_MS = 500;
const MARKER_MAX_WAIT_MS = 120000;
const SETTLE_NORMAL_MS = 2500;
const SETTLE_ACTIVE_MS = 10000;
const MIN_GROWTH_DELTA = 5;
const TRANSIENT_SIGNAL_CACHE_MS = 1000;
const MAX_TRANSIENT_ELEMENTS_CHECKED = 200;
const DEBUG_SNIPPET_LENGTH = 1000;
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
  result.answerLength = (watcherResult.answer || '').length;
  result.confidence = watcherResult.confidence;
  result.responseReason = watcherResult.reason;
  result.method = watcherResult.method;
  result.startCount = watcherResult.startCount || 0;
  result.endCount = watcherResult.endCount || 0;
  result.multipleMarkers = !!watcherResult.multipleMarkers;
  result.responseDurationMs = watcherResult.durationMs || 0;
  result.settleMsUsed = watcherResult.settleMsUsed || 0;
  result.transientGeneratingAtFire = !!watcherResult.transientGeneratingAtFire;
  result.growthSource = watcherResult.growthSource || 'none';
  result.debugSnippet = watcherResult.debugSnippet || null;
  result.status = (watcherResult.status === 'success' || watcherResult.status === 'partial') ? 'success' : 'failed';
  result.sessionCode = markerPlan.sessionCode;
  result.startMarker = markerPlan.startMarker;
  result.endMarker = markerPlan.endMarker;
}

async function waitForMarkerResponse(tabId, plan, logger, remainingMaxWaitMs) {
  const log = (msg) => logger.log(tabId, '[MarkerPart2] ' + msg);
  const startTime = Date.now();
  const effectiveMaxWait = remainingMaxWaitMs || MARKER_MAX_WAIT_MS;

  try {
    const config = {
      startMarker: plan.startMarker,
      endMarker: plan.endMarker,
      pollMs: MARKER_POLL_MS,
      maxWaitMs: effectiveMaxWait,
      settleNormalMs: SETTLE_NORMAL_MS,
      settleActiveMs: SETTLE_ACTIVE_MS,
      minGrowthDelta: MIN_GROWTH_DELTA,
      transientSignalCacheMs: TRANSIENT_SIGNAL_CACHE_MS,
      maxTransientElementsChecked: MAX_TRANSIENT_ELEMENTS_CHECKED,
      debugSnippetLength: DEBUG_SNIPPET_LENGTH
    };
    const expression = buildInjectedWatcher(config);
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: BACKGROUND_SAFETY_TIMEOUT_MS
    });

    if (result && result.result && result.result.value) {
      const w = result.result.value;
      log('watcher result: ' + w.status + ' (' + w.method + ') duration=' + w.durationMs + 'ms' +
        ' startCount=' + w.startCount + ' endCount=' + w.endCount +
        ' settleMs=' + w.settleMsUsed + ' transient=' + w.transientGeneratingAtFire +
        ' source=' + w.growthSource);
      return {
        status: w.status,
        answer: w.answer || '',
        confidence: w.confidence || 'low',
        method: w.method || 'unknown',
        reason: w.reason || '',
        startCount: w.startCount || 0,
        endCount: w.endCount || 0,
        multipleMarkers: !!w.multipleMarkers,
        durationMs: w.durationMs || (Date.now() - startTime),
        settleMsUsed: w.settleMsUsed || 0,
        transientGeneratingAtFire: !!w.transientGeneratingAtFire,
        growthSource: w.growthSource || 'none',
        debugSnippet: w.debugSnippet || null
      };
    }

    log('watcher returned no value');
    return {
      status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
      reason: 'no return value', startCount: 0, endCount: 0, multipleMarkers: false,
      durationMs: Date.now() - startTime, settleMsUsed: 0,
      transientGeneratingAtFire: false, growthSource: 'none', debugSnippet: null
    };
  } catch (e) {
    const msg = e.message || String(e);
    const elapsed = Date.now() - startTime;
    const timeRemaining = effectiveMaxWait - elapsed;

    // Navigation / context destruction — retry once if time remains
    if (timeRemaining > 5000 && (msg.includes('target') || msg.includes('context') || msg.includes('navigation'))) {
      if (msg.includes('detached')) {
        log('watcher context lost (debugger detached) — no retry');
        return failedResult('debugger detached', Date.now() - startTime);
      }
      log('watcher context lost (' + msg + ') — waiting for reload and retrying once (' + timeRemaining + 'ms remaining)');
      try {
        await waitForTabComplete(tabId, 15000);
        log('watcher retry with ' + timeRemaining + 'ms max wait');
        const retryResult = await waitForMarkerResponse(tabId, plan, logger, timeRemaining);
        return retryResult;
      } catch (retryErr) {
        log('watcher retry also failed: ' + (retryErr.message || String(retryErr)));
        return failedResult('navigation failure', Date.now() - startTime);
      }
    }

    log('watcher error: ' + msg);
    return failedResult(msg, Date.now() - startTime);
  }
}

function failedResult(reason, durationMs) {
  return {
    status: 'failed', answer: '', confidence: 'low', method: 'watcher-error',
    reason: reason, startCount: 0, endCount: 0, multipleMarkers: false,
    durationMs: durationMs || 0, settleMsUsed: 0,
    transientGeneratingAtFire: false, growthSource: 'none', debugSnippet: null
  };
}

function buildInjectedWatcher(config) {
  const configJson = JSON.stringify(config);
  return `
    (function() {
      var cfg = ${configJson};
      return new Promise(function(resolve) {
        var startedAt = Date.now();
        var resolved = false;
        var pollTimer = null;
        var lastGrowthAt = Date.now();
        var growthBaselineLength = 0;
        var lastTransientCheckAt = 0;
        var lastTransientGenerating = false;
        var growthSource = 'innerText';

        function getVisibleText() {
          try {
            if (document.body && document.body.innerText) {
              growthSource = 'innerText';
              return document.body.innerText;
            }
            if (document.body && document.body.textContent) {
              growthSource = 'textContent';
              return document.body.textContent;
            }
          } catch(e) {}
          growthSource = 'none';
          return '';
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

        function updateGrowth(currentLength) {
          if (currentLength > growthBaselineLength + cfg.minGrowthDelta) {
            lastGrowthAt = Date.now();
            growthBaselineLength = currentLength;
          } else if (currentLength < growthBaselineLength) {
            growthBaselineLength = currentLength;
          }
        }

        function cleanup() {
          if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        }

        function finalize(value) {
          if (resolved) return;
          resolved = true;
          cleanup();
          window.removeEventListener('pagehide', onPageHide);
          resolve(value);
        }

        function onPageHide() {
          finalize({
            ok: false, status: 'failed', answer: '', confidence: 'low',
            method: 'none', reason: 'page unloaded',
            durationMs: Date.now() - startedAt,
            startCount: 0, endCount: 0, multipleMarkers: false,
            settleMsUsed: 0, transientGeneratingAtFire: false,
            growthSource: growthSource, textLength: 0,
            lastStartIndex: -1, lastEndIndex: -1,
            debugSnippet: null
          });
        }

        window.addEventListener('pagehide', onPageHide, { once: true });

        function isTransientGeneratingVisible() {
          var now = Date.now();
          if (now - lastTransientCheckAt < cfg.transientSignalCacheMs) {
            return lastTransientGenerating;
          }
          lastTransientCheckAt = now;
          lastTransientGenerating = computeTransientGenerating();
          return lastTransientGenerating;
        }

        function computeTransientGenerating() {
          try {
            var maxCheck = cfg.maxTransientElementsChecked;

            // Signal A: stop button
            var buttons = document.querySelectorAll('button, [role="button"]');
            var stopWords = ['stop', 'halt', 'interrupt'];
            var skipWords = ['cancel', 'copy', 'regenerate', 'share', 'like', 'dislike'];
            for (var i = 0; i < buttons.length && i < maxCheck; i++) {
              var btn = buttons[i];
              var rect = btn.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              var style = window.getComputedStyle(btn);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              var label = (btn.getAttribute('aria-label') || btn.title || btn.innerText || btn.textContent || '').toLowerCase().trim();
              if (!label) continue;
              var isStop = false;
              for (var si = 0; si < stopWords.length; si++) {
                if (label.indexOf(stopWords[si]) !== -1) { isStop = true; break; }
              }
              if (!isStop) continue;
              var isSkip = false;
              for (var si = 0; si < skipWords.length; si++) {
                if (label.indexOf(skipWords[si]) !== -1) { isSkip = true; break; }
              }
              if (isSkip) continue;
              return true;
            }

            // Signal B: aria-busy
            var busyEls = document.querySelectorAll('[aria-busy="true"]');
            for (var i = 0; i < busyEls.length && i < maxCheck; i++) {
              var rect = busyEls[i].getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
            }

            // Signal C: thinking indicator — very conservative
            var thinkingSelectors = [
              '[class*="thinking" i]', '[class*="reasoning" i]',
              '[class*="generating" i]', '[class*="loading" i]',
              '[data-testid*="thinking" i]',
              '[aria-label*="thinking" i]', '[aria-label*="generating" i]'
            ];
            for (var si = 0; si < thinkingSelectors.length; si++) {
              try {
                var els = document.querySelectorAll(thinkingSelectors[si]);
                for (var ei = 0; ei < els.length && ei < maxCheck; ei++) {
                  var el = els[ei];
                  var rect = el.getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
                  if (el.getAttribute('aria-busy') === 'true') return true;
                  var animStyle = window.getComputedStyle(el);
                  if (animStyle.animationName && animStyle.animationName !== 'none') return true;
                  var spinners = el.querySelectorAll('[class*="spinner" i], [class*="loading" i]');
                  for (var ci = 0; ci < spinners.length && ci < 5; ci++) {
                    var sr = spinners[ci].getBoundingClientRect();
                    if (sr.width > 0 && sr.height > 0) return true;
                  }
                }
              } catch(e) {}
            }
          } catch(e) {}
          return false;
        }

        function getDebugSnippet(visibleText, lastStartIdx) {
          try {
            if (lastStartIdx !== -1) {
              return visibleText.substring(lastStartIdx, lastStartIdx + cfg.debugSnippetLength);
            }
            return visibleText.substring(Math.max(0, visibleText.length - cfg.debugSnippetLength));
          } catch(e) { return null; }
        }

        function finishSuccess(visibleText, startCount, endCount, lastStartIdx, lastEndIdx, transientGenerating, settleMs) {
          var answer = visibleText.substring(lastStartIdx + cfg.startMarker.length, lastEndIdx).trim();
          var multipleMarkers = (startCount > 1 || endCount > 1);
          var confidence = (growthSource === 'innerText') ? 'high' : 'medium';

          if (!answer) {
            try {
              var tcText = document.body.textContent || '';
              if (tcText) {
                var tcLastStart = tcText.lastIndexOf(cfg.startMarker);
                var tcLastEnd = tcText.lastIndexOf(cfg.endMarker);
                if (tcLastStart !== -1 && tcLastEnd !== -1 && tcLastEnd > tcLastStart) {
                  answer = tcText.substring(tcLastStart + cfg.startMarker.length, tcLastEnd).trim();
                  growthSource = 'textContent';
                  confidence = 'medium';
                }
              }
            } catch(e) {}
            if (!answer) {
              finalize({
                ok: false, status: 'failed', answer: '', confidence: 'low',
                method: 'markers-settled', reason: 'empty between markers',
                durationMs: Date.now() - startedAt,
                startCount: startCount, endCount: endCount, multipleMarkers: multipleMarkers,
                settleMsUsed: settleMs, transientGeneratingAtFire: transientGenerating,
                growthSource: growthSource, textLength: visibleText.length,
                lastStartIndex: lastStartIdx, lastEndIndex: lastEndIdx,
                debugSnippet: null
              });
              return;
            }
          }

          finalize({
            ok: true, status: 'success', answer: answer, confidence: confidence,
            method: 'markers-settled', reason: 'markers found with settle',
            durationMs: Date.now() - startedAt,
            startCount: startCount, endCount: endCount, multipleMarkers: multipleMarkers,
            settleMsUsed: settleMs, transientGeneratingAtFire: transientGenerating,
            growthSource: growthSource, textLength: visibleText.length,
            lastStartIndex: lastStartIdx, lastEndIndex: lastEndIdx,
            debugSnippet: null
          });
        }

        function finishTimeout() {
          var visibleText = getVisibleText();
          var startCount = countMarkers(visibleText, cfg.startMarker);
          var endCount = countMarkers(visibleText, cfg.endMarker);
          var lastStartIdx = visibleText.lastIndexOf(cfg.startMarker);
          var lastEndIdx = visibleText.lastIndexOf(cfg.endMarker);
          var debugSnippet = getDebugSnippet(visibleText, lastStartIdx);

          if (startCount > 0 && endCount === 0) {
            var partialAnswer = lastStartIdx !== -1 ? visibleText.substring(lastStartIdx + cfg.startMarker.length).trim() : '';
            finalize({
              ok: true, status: 'partial', answer: partialAnswer, confidence: 'low',
              method: 'partial-after-start', reason: 'end marker missing',
              durationMs: Date.now() - startedAt,
              startCount: startCount, endCount: endCount, multipleMarkers: (startCount > 1 || endCount > 1),
              settleMsUsed: 0, transientGeneratingAtFire: false,
              growthSource: growthSource, textLength: visibleText.length,
              lastStartIndex: lastStartIdx, lastEndIndex: lastEndIdx,
              debugSnippet: debugSnippet
            });
          } else if (startCount === 0 && endCount > 0) {
            finalize({
              ok: false, status: 'failed', answer: '', confidence: 'low',
              method: 'none', reason: 'start marker missing',
              durationMs: Date.now() - startedAt,
              startCount: startCount, endCount: endCount, multipleMarkers: false,
              settleMsUsed: 0, transientGeneratingAtFire: false,
              growthSource: growthSource, textLength: visibleText.length,
              lastStartIndex: -1, lastEndIndex: lastEndIdx,
              debugSnippet: debugSnippet
            });
          } else {
            finalize({
              ok: false, status: 'failed', answer: '', confidence: 'low',
              method: 'none', reason: 'markers not found',
              durationMs: Date.now() - startedAt,
              startCount: startCount, endCount: endCount, multipleMarkers: false,
              settleMsUsed: 0, transientGeneratingAtFire: false,
              growthSource: growthSource, textLength: visibleText.length,
              lastStartIndex: lastStartIdx, lastEndIndex: lastEndIdx,
              debugSnippet: debugSnippet
            });
          }
        }

        function poll() {
          try {
            if (resolved) return;

            var elapsed = Date.now() - startedAt;
            if (elapsed >= cfg.maxWaitMs) {
              finishTimeout();
              return;
            }

            var visibleText = getVisibleText();
            if (!visibleText) {
              updateGrowth(0);
              pollTimer = setTimeout(poll, cfg.pollMs);
              return;
            }

            var startCount = countMarkers(visibleText, cfg.startMarker);
            var endCount = countMarkers(visibleText, cfg.endMarker);
            var lastStartIdx = visibleText.lastIndexOf(cfg.startMarker);
            var lastEndIdx = visibleText.lastIndexOf(cfg.endMarker);

            updateGrowth(visibleText.length);
            var transientGenerating = isTransientGeneratingVisible();

            var markersReady = (startCount >= 1 && endCount >= 1 && lastEndIdx > lastStartIdx);

            if (markersReady) {
              var settleMs = transientGenerating ? cfg.settleActiveMs : cfg.settleNormalMs;
              if (Date.now() - lastGrowthAt >= settleMs) {
                finishSuccess(visibleText, startCount, endCount, lastStartIdx, lastEndIdx, transientGenerating, settleMs);
                return;
              }
            }
          } catch (err) {
            finalize({
              ok: false, status: 'failed', answer: '', confidence: 'low',
              method: 'watcher-error', reason: err.message || String(err),
              durationMs: Date.now() - startedAt,
              startCount: 0, endCount: 0, multipleMarkers: false,
              settleMsUsed: 0, transientGeneratingAtFire: false,
              growthSource: growthSource, textLength: 0,
              lastStartIndex: -1, lastEndIndex: -1,
              debugSnippet: null
            });
            return;
          }

          pollTimer = setTimeout(poll, cfg.pollMs);
        }

        // Initialize baseline
        try {
          if (document.body) {
            var initText = (document.body.innerText || document.body.textContent || '');
            growthBaselineLength = initText.length;
          }
        } catch(e) {}

        poll();
      });
    })()
  `;
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

// ---- Input element marking (for post-send verification) ---------------------
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

// ---- Trusted keystroke simulation via the debugger -------------------------
async function dispatchKey(tabId, params) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', params);
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

    // PART 3: apply per-site model/thinking steps before sending the prompt
    const configState = await applySiteSettings(tabId, url, logger);
    if (!configState.skipped) {
      result.siteKey = configState.siteKey;
      result.configSteps = (configState.result && configState.result.steps) || [];
      const cfgErr = configState.result && configState.result.error;
      logger.log(tabId, 'Config: ' + configState.siteKey + ' steps done' + (cfgErr ? ' \u2014 ' + cfgErr : ''));
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

// ---- Pre-run tab cleanup ----------------------------------------------------
async function cleanupLeftoverTabs(logger) {
  logger.log('main', 'Cleanup: opening anchor tab, then closing all other tabs');
  let anchor = null;
  try {
    anchor = await chrome.tabs.create({ url: 'about:blank', active: false });
  } catch (e) {
    logger.log('main', 'Cleanup: could not open anchor tab: ' + e.message);
  }
  const keepIds = new Set();
  if (anchor && typeof anchor.id === 'number') keepIds.add(anchor.id);
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let closed = 0;
  for (const t of tabs) {
    if (t && keepIds.has(t.id)) continue;
    try {
      await chrome.tabs.remove(t.id);
      closed++;
    } catch (_e) {}
  }
  logger.log('main', 'Cleanup: closed ' + closed + ' leftover tab(s); anchor kept open');
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

    await cleanupLeftoverTabs(logger);

    const results = await runAutomationStealth(urls, prompt, markerPlan, opts.skipWait, logger);

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