// Per-site configurator runner UI — merged from "site-configurator final".
// Namespaced in an IIFE so it never collides with popup.js (autoprompt UI).
(() => {
  const SITE_CONFIGS = window.SITE_CONFIGS || {};
  const listEl = document.getElementById("siteList");
  const statusEl = document.getElementById("cfgStatus");
  const clearBtn = document.getElementById("cfgClearBtn");
  if (!listEl || !statusEl || !clearBtn) return;

  let busyKey = null;

  function renderStatus(text) {
    statusEl.textContent = text;
  }

  for (const key of Object.keys(SITE_CONFIGS)) {
    const cfg = SITE_CONFIGS[key];
    const row = document.createElement("div");
    row.className = "site-row";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "site-name";
    name.textContent = cfg.name;
    const desc = document.createElement("div");
    desc.className = "site-desc";
    desc.textContent = cfg.description;
    info.append(name, desc);
    const btn = document.createElement("button");
    btn.className = "run-btn";
    btn.textContent = "Run";
    btn.dataset.site = key;
    btn.onclick = () => runConfig(key);
    row.append(info, btn);
    listEl.appendChild(row);
  }

  async function runConfig(key) {
    const cfg = SITE_CONFIGS[key];
    if (!cfg) return;
    const btn = document.querySelector(`.run-btn[data-site="${key}"]`);
    if (busyKey) {
      renderStatus(SITE_CONFIGS[busyKey].name + " is already running \u2014 check that tab.");
      return;
    }
    busyKey = key;
    btn.disabled = true;
    renderStatus("Opening " + cfg.name + "\u2026");
    let res;
    try {
      res = await Promise.race([
        chrome.runtime.sendMessage({
          type: "run-config",
          siteKey: key,
          config: cfg
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("no response from background in 100s")), 100000)
        )
      ]);
    } catch (e) {
      renderStatus("Error: " + ((e && e.message) || e));
      busyKey = null;
      btn.disabled = false;
      return;
    }
    if (res && (res.ok || res.done)) {
      renderStatus(cfg.name + ": running \u2014 check the tab.");
    } else {
      renderStatus("Error: " + ((res && res.error) || "no response"));
      busyKey = null;
      btn.disabled = false;
    }
  }

  function updateFromState(s) {
    if (!s || !s.done) return;
    const okCount = s.steps.filter((x) => x.status === "ok").length;
    if (s.error) {
      renderStatus(s.site + ": page not ready \u2014 check login.");
    } else {
      renderStatus(s.site + ": done \u2014 " + okCount + "/" + s.steps.length + " steps ok.");
    }
    if (busyKey) {
      busyKey = null;
      const btn = document.querySelector(`.run-btn[data-site="${s.key}"]`);
      if (btn) btn.disabled = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.configStatus) {
      updateFromState(changes.configStatus.newValue);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "config-step") {
      updateFromState(msg.state);
    }
  });

  clearBtn.onclick = () => {
    chrome.storage.session.remove("configStatus");
    renderStatus("");
  };
})();
