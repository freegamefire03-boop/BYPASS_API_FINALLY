const urlsInput = document.getElementById('urls');
const promptInput = document.getElementById('prompt');
const skipWaitInput = document.getElementById('skipWait');
const experimentalBgInput = document.getElementById('experimentalBackground');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');
const downloadAnswersBtn = document.getElementById('downloadAnswersBtn');
const downloadJsonBtn = document.getElementById('downloadJsonBtn');

const SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_CODE_LENGTH = 10;
const STORAGE_KEY = "autoprompt_latest_submission";

function generateSessionCode() {
  const bytes = new Uint8Array(SESSION_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    code += SESSION_CODE_ALPHABET[bytes[i] % SESSION_CODE_ALPHABET.length];
  }
  return code;
}

function submissionId() {
  try { return crypto.randomUUID(); } catch (_e) { return Date.now() + '-' + Math.random().toString(36).slice(2, 10); }
}

chrome.storage.local.get(['lastUrls', 'skipWait', 'experimentalBackground', STORAGE_KEY], (res) => {
  if (res.lastUrls) urlsInput.value = res.lastUrls;
  if (res.skipWait) skipWaitInput.checked = true;
  if (res.experimentalBackground) experimentalBgInput.checked = true;
  if (res[STORAGE_KEY]) updateUI(res[STORAGE_KEY]);
});

skipWaitInput.addEventListener('change', () => {
  chrome.storage.local.set({ skipWait: skipWaitInput.checked });
});

experimentalBgInput.addEventListener('change', () => {
  chrome.storage.local.set({ experimentalBackground: experimentalBgInput.checked });
});

function parseUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u))
    .filter((u, i, arr) => arr.indexOf(u) === i);
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
  downloadAnswersBtn.style.display = 'none';
  downloadJsonBtn.style.display = 'none';

  chrome.storage.local.set({ lastUrls: urlsInput.value, skipWait, experimentalBackground: experimentalBgInput.checked });

  const sessionCode = generateSessionCode();
  const sid = submissionId();

  submitBtn.disabled = true;
  statusEl.textContent = 'Preparing prompt markers...';

  try {
    await chrome.runtime.sendMessage({
      type: 'RUN_AUTOMATION',
      submissionId: sid,
      urls,
      prompt,
      sessionCode,
      skipWait,
      experimentalBackground: experimentalBgInput.checked
    });
    statusEl.textContent = 'Tabs opened. Sending prompt...';
  } catch (e) {
    statusEl.textContent = 'Error: ' + (e && e.message ? e.message : e);
    submitBtn.disabled = false;
    return;
  }
});

function renderSubmission(submission) {
  if (!submission || !submission.tabs) return;
  resultsList.innerHTML = '';
  for (const tab of submission.tabs) {
    const item = document.createElement('div');
    item.className = 'result-item';

    const dot = document.createElement('div');
    let statusClass = 'error';
    if (tab.status === 'success') statusClass = 'success';
    dot.className = 'result-dot ' + statusClass;
    item.appendChild(dot);

    const textWrap = document.createElement('div');

    const urlEl = document.createElement('div');
    urlEl.className = 'result-url';
    try {
      urlEl.textContent = new URL(tab.url).hostname;
    } catch (_e) {
      urlEl.textContent = tab.url;
    }
    textWrap.appendChild(urlEl);

    const reasonEl = document.createElement('div');
    reasonEl.className = 'result-reason';
    if (tab.sendStatus === 'failed' || tab.status === 'failed') {
      reasonEl.textContent = 'FAILED: ' + (tab.sendReason || tab.responseReason || 'unknown');
    } else if (tab.responseStatus === 'success') {
      const preview = (tab.answer || '').slice(0, 160).replace(/\n/g, ' ');
      reasonEl.textContent = preview ? preview : '[empty answer]';
    } else if (tab.responseStatus === 'partial') {
      const preview = (tab.answer || '').slice(0, 160).replace(/\n/g, ' ');
      reasonEl.textContent = 'PARTIAL: ' + (preview || tab.responseReason);
    } else {
      reasonEl.textContent = (tab.responseReason || tab.sendReason || 'unknown');
    }
    textWrap.appendChild(reasonEl);

    if (tab.confidence) {
      const confEl = document.createElement('div');
      confEl.className = 'result-confidence';
      confEl.textContent = 'confidence: ' + tab.confidence + (tab.responseDurationMs ? ' (' + tab.responseDurationMs + 'ms)' : '');
      textWrap.appendChild(confEl);
    }

    item.appendChild(textWrap);
    resultsList.appendChild(item);
  }
  resultsSection.style.display = 'block';
}

function updateUI(submission) {
  if (!submission) {
    if (submitBtn.disabled) {
      statusEl.textContent = 'No active submission.';
      submitBtn.disabled = false;
    }
    return;
  }
  if (submission.status === 'running') {
    const done = submission.tabs ? submission.tabs.filter(t => t.status).length : 0;
    const total = submission.tabs ? submission.tabs.length : 0;
    statusEl.textContent = 'Running... ' + done + '/' + total + ' tabs complete.';
    submitBtn.disabled = true;
    renderSubmission(submission);
  } else if (submission.status === 'completed') {
    const successCount = submission.tabs ? submission.tabs.filter(t => t.status === 'success').length : 0;
    const totalCount = submission.tabs ? submission.tabs.length : 0;
    statusEl.textContent = 'Done: ' + successCount + '/' + totalCount + ' succeeded.';
    submitBtn.disabled = false;
    renderSubmission(submission);
    downloadAnswersBtn.style.display = 'block';
    downloadJsonBtn.style.display = 'block';
  }
}

chrome.storage.local.get([STORAGE_KEY], (res) => {
  if (res[STORAGE_KEY]) updateUI(res[STORAGE_KEY]);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    updateUI(changes[STORAGE_KEY].newValue);
  }
});

function timestamp() {
  const d = new Date();
  return d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') + '-' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
}

function buildTxtContent(submission) {
  const lines = [];
  lines.push('AUTO PROMPT ANSWERS');
  lines.push('Generated: ' + new Date().toLocaleString());
  lines.push('Session Code: ' + (submission.sessionCode || 'N/A'));
  lines.push('Status: ' + (submission.status || 'N/A'));
  lines.push('');
  lines.push('ORIGINAL PROMPT:');
  lines.push(submission.originalPrompt || '');
  lines.push('');
  lines.push('='.repeat(50));
  lines.push('');
  const tabs = submission.tabs || [];
  tabs.forEach((tab, i) => {
    lines.push('TAB ' + (i + 1));
    lines.push('URL: ' + (tab.url || 'N/A'));
    lines.push('Send Status: ' + (tab.sendStatus || 'N/A'));
    lines.push('Response Status: ' + (tab.responseStatus || 'N/A'));
    lines.push('Confidence: ' + (tab.confidence || 'N/A'));
    lines.push('Method: ' + (tab.method || 'N/A'));
    lines.push('Reason: ' + (tab.responseReason || tab.sendReason || 'N/A'));
    lines.push('Duration: ' + (tab.responseDurationMs || 'N/A') + ' ms');
    lines.push('');
    lines.push('ANSWER:');
    if (tab.answer && tab.answer.length > 0) {
      lines.push(tab.answer);
    } else if (tab.responseStatus === 'failed') {
      lines.push('[FAILED: ' + (tab.responseReason || 'no reason') + ']');
    } else if (tab.responseStatus === 'partial') {
      lines.push('[PARTIAL ANSWER]');
      if (tab.answer) lines.push(tab.answer);
    } else {
      lines.push('[EMPTY ANSWER]');
    }
    lines.push('');
    lines.push('='.repeat(50));
    lines.push('');
  });
  return lines.join('\n');
}

downloadAnswersBtn.addEventListener('click', () => {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const sub = res[STORAGE_KEY];
    if (!sub) return;
    const content = buildTxtContent(sub);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoprompt-answers-' + timestamp() + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

downloadJsonBtn.addEventListener('click', () => {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const sub = res[STORAGE_KEY];
    if (!sub) return;
    const json = JSON.stringify(sub, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoprompt-answers-' + timestamp() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});