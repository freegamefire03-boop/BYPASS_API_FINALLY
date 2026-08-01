// Per-site configurator runner UI — merged from "site-configurator final" v1.3.0.
// Namespaced in an IIFE so it never collides with popup.js (autoprompt UI).
// Each site with an `options` schema renders per-site controls (selects/checkboxes)
// that persist to chrome.storage.local and drive describe()/buildSteps() on run.
(() => {
  const SITE_CONFIGS = window.SITE_CONFIGS || {};
  const listEl = document.getElementById("siteList");
  const statusEl = document.getElementById("cfgStatus");
  const clearBtn = document.getElementById("cfgClearBtn");
  if (!listEl || !statusEl || !clearBtn) return;

  let busyKey = null;
  const rows = {};

  function renderStatus(text) {
    statusEl.textContent = text;
  }

  function storageKey(siteKey, optKey) {
    return siteKey + "_" + optKey;
  }

  function describe(cfg, sel) {
    return cfg.describe ? cfg.describe(sel) : cfg.description;
  }

  function buildSteps(cfg, sel) {
    return cfg.buildSteps ? cfg.buildSteps(sel) : cfg.steps;
  }

  function makeRow(cfg) {
    const row = document.createElement("div");
    row.className = "site-row";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "site-name";
    name.textContent = cfg.name;
    const desc = document.createElement("div");
    desc.className = "site-desc";
    info.append(name, desc);

    const opts = document.createElement("div");
    opts.className = "site-options";
    const ctl = {};
    const save = () => {
      const sel = refresh();
      const changes = {};
      for (const o of cfg.options || []) {
        changes[storageKey(cfg.key, o.key)] = sel[o.key];
      }
      chrome.storage.local.set(changes).catch(() => {});
    };
    for (const o of cfg.options || []) {
      const w = document.createElement("div");
      w.className = "option-row";
      const l = document.createElement("label");
      l.textContent = o.label;
      let c;
      if (o.type === "toggle") {
        c = document.createElement("input");
        c.type = "checkbox";
        c.onchange = save;
      } else {
        c = document.createElement("select");
        for (const v of o.values) {
          const op = document.createElement("option");
          op.value = v;
          op.textContent = v;
          c.appendChild(op);
        }
        c.onchange = save;
      }
      ctl[o.key] = c;
      w.append(l, c);
      opts.appendChild(w);
    }
    info.append(opts);

    const btn = document.createElement("button");
    btn.className = "run-btn";
    btn.textContent = "Run";
    btn.dataset.site = cfg.key;
    btn.onclick = () => runConfig(cfg.key);
    row.append(info, btn);

    function refresh() {
      const sel = {};
      for (const o of cfg.options || []) {
        sel[o.key] = ctl[o.key].type === "checkbox" ? !!ctl[o.key].checked : ctl[o.key].value;
      }
      desc.textContent = describe(cfg, sel);
      return sel;
    }
    refresh();

    return { row, ctl, refresh, cfg };
  }

  for (const key of Object.keys(SITE_CONFIGS)) {
    const built = makeRow(SITE_CONFIGS[key]);
    rows[key] = built;
    listEl.appendChild(built.row);
  }

  const defaults = {};
  for (const key of Object.keys(SITE_CONFIGS)) {
    for (const o of SITE_CONFIGS[key].options || []) {
      defaults[storageKey(key, o.key)] = o.default;
    }
  }
  chrome.storage.local
    .get(defaults)
    .then((stored) => {
      for (const key of Object.keys(SITE_CONFIGS)) {
        const built = rows[key];
        for (const o of built.cfg.options || []) {
          const v = stored[storageKey(key, o.key)];
          if (o.type === "toggle") built.ctl[o.key].checked = !!v;
          else built.ctl[o.key].value = v;
        }
        built.refresh();
      }
    })
    .catch(() => {});

  async function runConfig(key) {
    const cfg = SITE_CONFIGS[key];
    if (!cfg) return;
    const sel = rows[key].refresh();
    const config = {
      key: cfg.key,
      name: cfg.name,
      url: cfg.url,
      inputText: cfg.inputText,
      description: describe(cfg, sel),
      steps: buildSteps(cfg, sel)
    };
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
          config
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
