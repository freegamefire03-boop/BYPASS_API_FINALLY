(() => {
  const RUNNER_VER = "v10";
  if (
    document.documentElement.getAttribute("data-ai-site-cfg") === RUNNER_VER &&
    window.__aiSiteCfgVer === RUNNER_VER
  ) {
    return;
  }
  window.__aiSiteCfgVer = RUNNER_VER;
  document.documentElement.setAttribute("data-ai-site-cfg", RUNNER_VER);
  console.log("[AI-Site-Cfg] booted " + RUNNER_VER);

  let running = false;
  let overlayRoot = null;
  let statusEl = null;
  let listEl = null;
  let currentSite = "";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function persist(state) {
    try {
      chrome.storage.session.set({ configStatus: state }).catch(() => {});
    } catch (e) {}
    try {
      chrome.runtime.sendMessage({ type: "config-step", state }).catch(() => {});
    } catch (e) {}
  }

  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function score(el, text) {
    let s = 0;
    const al = norm(el.getAttribute && el.getAttribute("aria-label"));
    if (al === text) s = Math.max(s, 100);
    else if (al && al.includes(text)) s = Math.max(s, 70);
    const ph = norm(el.getAttribute && el.getAttribute("placeholder"));
    if (ph === text) s = Math.max(s, 100);
    else if (ph && ph.includes(text)) s = Math.max(s, 70);
    const ti = norm(el.title);
    if (ti && (ti === text || ti.includes(text))) s = Math.max(s, 70);
    const t = norm(el.textContent);
    if (t === text) s = Math.max(s, 100);
    else if (t.includes(text) && t.length < text.length + 80) s = Math.max(s, 60);
    return s;
  }

  function interactiveHint(el) {
    if (!el) return 0;
    let h = 0;
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "TEXTAREA") h += 3;
    const role = ((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
    if (/button|menuitem|radio|option|checkbox|tab|link/.test(role)) h += 3;
    if (/(toggle-button|button|btn|menu-item|option-item)/i.test((el.className || "").toString())) h += 2;
    return h;
  }

  function findBest(text) {
    let best = null;
    let bestScore = 0;
    const all = document.querySelectorAll(
      'button,a,li,span,div,textarea,input,[role="menuitem"],[role="radio"],[role="option"],[role="checkbox"],[role="button"],[role="tab"],label'
    );
    for (const el of all) {
      if (el.closest && el.closest("[data-ai-site-cfg-overlay]")) continue;
      const s = score(el, text);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      } else if (s === bestScore && best && interactiveHint(el) > interactiveHint(best)) {
        best = el;
      }
    }
    return best;
  }

  function clickable(el) {
    if (!el) return false;
    return (
      el.tagName === "BUTTON" ||
      el.tagName === "A" ||
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      /(button|menuitem|radio|option|checkbox|tab|link)/i.test(
        el.getAttribute("role") || ""
      )
    );
  }

  function doClick(el) {
    const target = clickable(el)
      ? el
      : el.closest(
          'button,a,[role="button"],[role="menuitem"],[role="radio"],[role="option"],[role="checkbox"],label'
        ) || el;
    const rect = target.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0
    };
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse" })
    );
    target.dispatchEvent(new MouseEvent("mousedown", base));
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse" })
    );
    target.dispatchEvent(new MouseEvent("mouseup", base));
    target.dispatchEvent(new MouseEvent("click", base));
  }

  function doHover(el) {
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    };
    el.dispatchEvent(new MouseEvent("mouseenter", base));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mousemove", base));
    el.dispatchEvent(
      new PointerEvent("pointerover", { ...base, pointerId: 1, pointerType: "mouse" })
    );
    el.dispatchEvent(
      new PointerEvent("pointermove", { ...base, pointerId: 1, pointerType: "mouse" })
    );
  }

  function doKeyboard(el, key) {
    el.focus();
    const k = key || "Enter";
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      key: k,
      code: k,
      keyCode: k === "Enter" ? 13 : 0,
      which: k === "Enter" ? 13 : 0
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function inOverlay(node) {
    return !!(node && node.closest && node.closest("[data-ai-site-cfg-overlay]"));
  }

  function waitForFound(text, timeout) {
    const deadline = Date.now() + timeout;
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let observer = null;
      const finish = (val) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(val);
      };
      const check = () => {
        if (done) return;
        const el = findBest(text);
        if (el) finish(el);
      };
      check();
      if (done) return;
      try {
        observer = new MutationObserver((records) => {
          for (const r of records) {
            if (inOverlay(r.target)) continue;
            if (r.type === "childList" && [...r.addedNodes].some(inOverlay)) continue;
            check();
            return;
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true
        });
      } catch (e) {}
      const tick = () => {
        if (done) return;
        if (Date.now() >= deadline) return finish(null);
        check();
        timer = setTimeout(tick, 400);
      };
      timer = setTimeout(tick, 400);
    });
  }

  async function openMenuIfNeeded(step) {
    if (!step.openMenu) return;
    for (let i = 0; i < 4; i++) {
      if (findBest(step.find)) return true;
      await clickText(step.openMenu, 2500);
      await sleep(step.openWait ?? 700);
    }
    return !!findBest(step.find);
  }

  async function clickText(text, timeout) {
    const el = await waitForFound(text, timeout);
    if (!el) return false;
    doClick(el);
    return true;
  }

  function probeActive(step) {
    const p = step.activeProbe;
    if (!p || !p.text) return false;
    const candidates = [...document.querySelectorAll("div,span,button,[role]")].filter(
      (el) => {
        if (el.closest && el.closest("[data-ai-site-cfg-overlay]")) return false;
        const t = norm(el.textContent);
        const al = norm(el.getAttribute && el.getAttribute("aria-label"));
        return (
          t === p.text ||
          al === p.text ||
          (al && al.includes(p.text)) ||
          (t.includes(p.text) && t.length < p.text.length + 80)
        );
      }
    );
    if (!candidates.length) return false;
    if (p.cls) {
      return candidates.some((el) => (el.className || "").toString().includes(p.cls));
    }
    return true;
  }

  async function ensureToggle(step) {
    const wantOn = step.target !== "off";
    const active = probeActive(step);
    if (wantOn && active) return { ok: true, detail: "already on" };
    if (!wantOn && !active) return { ok: true, detail: "already off" };
    const deadline = Date.now() + (step.timeout || 12000);
    while (Date.now() < deadline) {
      await openMenuIfNeeded(step);
      const clicked = await clickText(
        step.find,
        Math.min(4000, Math.max(1500, deadline - Date.now()))
      );
      if (!clicked) {
        await sleep(300);
        continue;
      }
      await sleep(step.pauseAfter ?? 900);
      const a = probeActive(step);
      if (wantOn && a) return { ok: true, detail: "switched on" };
      if (!wantOn && !a) return { ok: true, detail: "switched off" };
      await sleep(300);
    }
    return { ok: false, detail: wantOn ? "could not enable" : "could not disable" };
  }

  function readCssText(css) {
    try {
      const el = document.querySelector(css);
      return el
        ? norm(el.innerText || el.textContent || el.getAttribute("aria-label") || "")
        : "";
    } catch (e) {
      return "";
    }
  }

  function findOptionEl(step) {
    const css = step.optionCss || ".ant-select-item-option";
    const els = document.querySelectorAll(css);
    for (const el of els) {
      if (inOverlay(el)) continue;
      const t = norm(el.textContent);
      if (t === step.find || t.includes(step.find)) return el;
    }
    return null;
  }

  async function dropdownStep(step) {
    if (step.currentCss && readCssText(step.currentCss) === step.find) {
      return { ok: true, detail: "already set" };
    }
    const openEl = step.openCss ? document.querySelector(step.openCss) : null;
    if (openEl) doClick(openEl);
    const deadline = Date.now() + (step.timeout || 8000);
    let el = null;
    while (Date.now() < deadline) {
      el = findOptionEl(step);
      if (el) break;
      await sleep(300);
    }
    if (!el) return { ok: false, detail: "option not found" };
    doClick(el);
    await sleep(600);
    if (step.currentCss && readCssText(step.currentCss) === step.find) {
      return { ok: true, detail: "set to " + step.find };
    }
    return { ok: true, detail: "clicked " + step.find };
  }

  function buildOverlay() {
    if (overlayRoot) return;
    document.querySelectorAll("[data-ai-site-cfg-overlay]").forEach((r) => r.remove());
    const root = document.createElement("div");
    root.setAttribute("data-ai-site-cfg-overlay", "1");
    root.style.cssText =
      "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;background:#0b1226;color:#e2e8f0;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;border:1px solid #3b82f6;border-radius:12px;padding:14px 16px;width:280px;box-shadow:0 10px 40px rgba(0,0,0,.5);text-align:left";
    const title = document.createElement("div");
    title.textContent = "AI Site Configurator";
    title.style.cssText = "font-weight:700;font-size:13px;color:#60a5fa;margin-bottom:2px";
    const sub = document.createElement("div");
    sub.textContent = currentSite;
    sub.style.cssText = "color:#94a3b8;margin-bottom:8px;font-size:11px";
    statusEl = document.createElement("div");
    statusEl.style.cssText = "margin:6px 0 8px;color:#fbbf24;font-weight:600";
    statusEl.textContent = "Starting\u2026";
    listEl = document.createElement("div");
    const close = document.createElement("button");
    close.textContent = "\u2715";
    close.style.cssText =
      "all:initial;position:absolute;top:8px;right:10px;color:#94a3b8;font-size:13px;cursor:pointer;padding:2px 4px";
    close.onclick = () => {
      root.remove();
      overlayRoot = null;
    };
    root.append(title, sub, statusEl, listEl, close);
    (document.body || document.documentElement).appendChild(root);
    overlayRoot = root;
  }

  function render(steps) {
    if (!overlayRoot) return;
    listEl.textContent = "";
    for (const s of steps) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;margin:3px 0";
      const color =
        s.status === "ok"
          ? "#4ade80"
          : s.status === "fail"
            ? "#f87171"
            : s.status === "skip"
              ? "#94a3b8"
              : s.status === "run"
                ? "#60a5fa"
                : "#e2e8f0";
      row.style.color = color;
      const mark = document.createElement("span");
      mark.style.flex = "0 0 auto";
      mark.textContent =
        s.status === "ok"
          ? "\u2713"
          : s.status === "fail"
            ? "\u2717"
            : s.status === "skip"
              ? "\u2013"
              : s.status === "run"
                ? "\u2026"
                : " ";
      const label = document.createElement("span");
      label.textContent = s.label + (s.detail ? " \u2014 " + s.detail : "");
      row.append(mark, label);
      listEl.appendChild(row);
    }
  }

  function stripOverlay() {
    if (overlayRoot) {
      overlayRoot.remove();
      overlayRoot = null;
    }
    try {
      chrome.storage.session.remove("configStatus").catch(() => {});
    } catch (e) {}
  }

  async function run(config) {
    if (running) return { ok: false, error: "already running" };
    running = true;
    currentSite = config.name;
    buildOverlay();
    const steps = config.steps.map((s) => ({ label: s.label, status: "wait" }));
    render(steps);
    statusEl.textContent = "Waiting for page\u2026";
    const input = await waitForFound(config.inputText, 20000);
    if (!input) {
      statusEl.textContent = "Page element not found \u2014 maybe not logged in?";
      render(steps.map((s) => ({ ...s, status: "skip" })));
      const state = { key: config.key, site: currentSite, done: true, steps, error: "page-not-ready" };
      persist(state);
      running = false;
      return state;
    }
    statusEl.textContent = "Running\u2026";
    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      steps[i].status = "run";
      render(steps);
      let ok = false;
      let detail = "";
      if (step.type === "toggle") {
        const res = await ensureToggle(step);
        ok = res.ok;
        detail = res.detail;
      } else if (step.type === "dropdown") {
        const res = await dropdownStep(step);
        ok = res.ok;
        detail = res.detail;
      } else if (step.type === "hover") {
        const el = await waitForFound(step.find, step.timeout || 8000);
        if (el) {
          doHover(el);
          ok = true;
          detail = "hovered";
        } else {
          ok = false;
          detail = step.optional ? "skipped (not found)" : "not found";
        }
      } else {
        await openMenuIfNeeded(step);
        const el = await waitForFound(step.find, step.timeout || 8000);
        if (el) {
          if (step.keyboard) {
            doKeyboard(el, step.key);
            ok = true;
            detail = "keyboard activated";
          } else {
            doClick(el);
            ok = true;
            detail = "clicked";
          }
        } else {
          ok = false;
          detail = step.optional ? "skipped (not found)" : "not found";
        }
      }
      steps[i].status = ok ? "ok" : step.optional ? "skip" : "fail";
      steps[i].detail = detail;
      render(steps);
      persist({ key: config.key, site: currentSite, done: false, steps });
      await sleep(step.pauseAfter ?? 900);
    }
    statusEl.textContent = "Done \u2713 (click \u2715 to close)";
    const state = { key: config.key, site: currentSite, done: true, steps };
    persist(state);
    running = false;
    return state;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "run-config") {
      if (window.__aiSiteCfgVer !== RUNNER_VER) return;
      run(msg.config)
        .then(sendResponse)
        .catch((err) => {
          try {
            sendResponse({
              ok: false,
              error: String((err && err.message) || err)
            });
          } catch (e2) {}
        });
      return true;
    }
    if (msg && msg.type === "clear-overlay") {
      stripOverlay();
      try {
        sendResponse({ ok: true });
      } catch (e) {}
    }
  });
})();
