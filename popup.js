const urlsInput = document.getElementById('urls');
const promptInput = document.getElementById('prompt');
const skipWaitInput = document.getElementById('skipWait');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');
const downloadAnswersBtn = document.getElementById('downloadAnswersBtn');
const downloadAnswersZipBtn = document.getElementById('downloadAnswersZipBtn');
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

chrome.storage.local.get(['lastUrls', 'skipWait', STORAGE_KEY], (res) => {
  if (res.lastUrls) urlsInput.value = res.lastUrls;
  if (res.skipWait) skipWaitInput.checked = true;
  if (res[STORAGE_KEY]) updateUI(res[STORAGE_KEY]);
});

skipWaitInput.addEventListener('change', () => {
  chrome.storage.local.set({ skipWait: skipWaitInput.checked });
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
  downloadAnswersZipBtn.style.display = 'none';
  downloadJsonBtn.style.display = 'none';

  chrome.storage.local.set({ lastUrls: urlsInput.value, skipWait });

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
      skipWait
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
    downloadAnswersZipBtn.style.display = 'block';
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
    lines.push('Start Count: ' + (tab.startCount !== undefined ? tab.startCount : 'N/A'));
    lines.push('End Count: ' + (tab.endCount !== undefined ? tab.endCount : 'N/A'));
    lines.push('Multiple Markers: ' + (tab.multipleMarkers !== undefined ? tab.multipleMarkers : 'N/A'));
    lines.push('Settle Used: ' + (tab.settleMsUsed || 'N/A') + ' ms');
    lines.push('Growth Source: ' + (tab.growthSource || 'N/A'));
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

// ---- Download answers as separate files (zip) --------------------------------
function stripMarkers(text, submission) {
  let out = (text || '').trim();
  if (submission && submission.startMarker) {
    out = out.split(submission.startMarker).join('');
  }
  if (submission && submission.endMarker) {
    const idx = out.indexOf(submission.endMarker);
    if (idx !== -1) out = out.substring(0, idx);
  }
  return out.trim();
}

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'site';
}

function crc32(data) {
  if (!crc32.table) {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ data[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint16(6, 0x0800, true);
    lfh.setUint16(8, 0, true);
    lfh.setUint16(10, dosTime, true);
    lfh.setUint16(12, dosDate, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, size, true);
    lfh.setUint32(22, size, true);
    lfh.setUint16(26, nameBytes.length, true);
    lfh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lfh.buffer), nameBytes, f.data);
    central.push({ nameBytes, crc, size, offset, dosTime, dosDate });
    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  for (const c of central) {
    const cdr = new DataView(new ArrayBuffer(46));
    cdr.setUint32(0, 0x02014b50, true);
    cdr.setUint16(4, 20, true);
    cdr.setUint16(6, 20, true);
    cdr.setUint16(8, 0x0800, true);
    cdr.setUint16(10, 0, true);
    cdr.setUint16(12, c.dosTime, true);
    cdr.setUint16(14, c.dosDate, true);
    cdr.setUint32(16, c.crc, true);
    cdr.setUint32(20, c.size, true);
    cdr.setUint32(24, c.size, true);
    cdr.setUint16(28, c.nameBytes.length, true);
    cdr.setUint16(30, 0, true);
    cdr.setUint16(32, 0, true);
    cdr.setUint16(34, 0, true);
    cdr.setUint16(36, 0, true);
    cdr.setUint32(38, 0, true);
    cdr.setUint32(42, c.offset, true);
    chunks.push(new Uint8Array(cdr.buffer), c.nameBytes);
    offset += 46 + c.nameBytes.length;
  }

  const centralSize = offset - centralStart;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  const total = chunks.reduce((s, c) => s + c.length, 0) + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  out.set(new Uint8Array(eocd.buffer), p);
  return out;
}

downloadAnswersZipBtn.addEventListener('click', () => {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const sub = res[STORAGE_KEY];
    if (!sub) return;
    const files = [];
    const used = new Map();
    const tabs = sub.tabs || [];
    tabs.forEach((tab) => {
      if (!tab || !tab.url) return;
      let base = 'site';
      try { base = sanitizeFilename(new URL(tab.url).hostname); }
      catch (_e) { base = sanitizeFilename(tab.url); }
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      const name = count === 0 ? base : base + '-' + (count + 1);

      const answer = stripMarkers(tab.answer, sub);
      let content;
      if (answer.length > 0) {
        content = answer;
      } else if (tab.responseStatus === 'failed') {
        content = '[No answer: ' + (tab.responseReason || tab.sendReason || 'unknown') + ']';
      } else if (tab.responseStatus === 'partial') {
        content = '[PARTIAL ANSWER]';
      } else {
        content = '[No answer]';
      }
      files.push({ name: 'answers/' + name + '.txt', data: new TextEncoder().encode(content) });
    });
    files.push({ name: 'answers/prompt.txt', data: new TextEncoder().encode(sub.originalPrompt || '') });

    const zip = buildZip(files);
    const blob = new Blob([zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoprompt-answers-' + timestamp() + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    statusEl.textContent = 'Downloaded ' + tabs.length + ' answer file(s) + prompt (zip).';
  });
});