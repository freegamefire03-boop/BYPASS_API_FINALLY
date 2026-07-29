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
