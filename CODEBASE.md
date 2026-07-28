# File Tree

```
.
├── background.js
├── manifest.json
├── popup.html
└── popup.js
```

# Source Files

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
// TEXT INSERTION: The prompt is injected directly into each tab's focused
// input via CDP's Input.insertText — no system clipboard is involved.
// This means the user can freely copy/paste on their PC while the
// extension runs without corrupting the prompt being sent.
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

// ---- Post-send verification (URL change check) -----------------------------

async function verifySend(tabId, originalUrl, logger, pollMs = 500, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { url: newUrl } = await chrome.tabs.get(tabId);
      logger.log(tabId, `Verification: check "${originalUrl}" vs "${newUrl}"`);
      if (newUrl !== originalUrl) {
        return { verified: true, reason: 'URL changed — prompt was sent' };
      }
      await delay(pollMs);
    }
    return { verified: false, reason: 'URL unchanged after polling — send may have failed' };
  } catch (e) {
    logger.log(tabId, `Verification error: ${e.message}`);
    return { verified: false, reason: `Verification error: ${e.message}` };
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

    const focused = await waitForFocusedInput(tabId, 8000, 300);
    logger.log(tabId, focused
      ? 'Focused input detected'
      : 'No focused input detected after waiting; attempting keys anyway');
    await delay(200);

    await sendTextThenEnter(tabId, prompt);
    logger.log(tabId, 'Text inserted + Enter dispatched');

    const verification = await verifySend(tabId, url, logger);
    if (verification.verified) {
      result.status = 'success';
      result.reason = verification.reason;
    } else {
      result.status = 'uncertain';
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
  logger.log('main', `Starting run: ${urls.length} URL(s), skipWait=${skipWait}, mode=auto-cycle`);

  const tabStates = await Promise.all(urls.map((url) => openAndAttach(url, skipWait, logger)));

  const results = [];
  for (const state of tabStates) {
    if (!state.ok || !state.tabId) {
      results.push({ url: state.url, tabId: state.tabId || null, status: 'error', reason: 'Failed to open or attach debugger' });
      continue;
    }
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
    const focused = await waitForFocusedInput(tabId);
    logger.log(tabId, focused
      ? 'Focused input detected'
      : 'No focused input detected; attempting anyway (background tabs usually fail here)');
    await delay(250);
    await sendTextThenEnter(tabId, prompt);
    logger.log(tabId, 'Text inserted + Enter dispatched');

    const verification = await verifySend(tabId, url, logger);
    result.status = verification.verified ? 'success' : 'uncertain';
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
      <div class="toggle-label">Experimental: background mode</div>
      <div class="toggle-hint">All tabs stay in background (no cycling). Fails on most sites.</div>
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

chrome.storage.local.get(['lastUrls', 'skipWait', 'experimentalBackground', 'debugLog'], (res) => {
  if (res.lastUrls) urlsInput.value = res.lastUrls;
  if (res.skipWait) skipWaitInput.checked = true;
  if (res.experimentalBackground) experimentalBgInput.checked = true;
  if (res.debugLog) debugLogInput.checked = true;
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

function pollForResults() {
  var maxWait = 60000;
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
