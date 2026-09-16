"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Minimal, safe surface exposed to the pi-web frontend.
contextBridge.exposeInMainWorld("piWebDesktop", {
  isDesktop: true,
  platform: process.platform,
});

// pi-web's OWN desktop bridge (upstream v0.7.13+): native directory picker.
contextBridge.exposeInMainWorld("piDesktop", {
  selectDirectory: () => ipcRenderer.invoke("pi-web-desktop:select-directory"),
});

// ---------------------------------------------------------------------------
// In-page update-result CTA (top-right toast)
// ---------------------------------------------------------------------------
const UI =
  "var(--font-ui, 'Segoe UI', Selawik, system-ui, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif)";

const STATUS = {
  updated: "var(--tile-green, #60A917)",
  latest: "var(--accent, #0050EF)",
  available: "var(--tile-amber, #F0A30A)",
  error: "var(--tile-red, #E51400)",
};

let hostEl = null;

function whenBody(cb) {
  if (document.body) cb();
  else document.addEventListener("DOMContentLoaded", cb, { once: true });
}

function ensureHost() {
  if (hostEl && document.body && document.body.contains(hostEl)) return hostEl;
  hostEl = document.createElement("div");
  hostEl.id = "pi-web-desktop-cta-host";
  const s = hostEl.style;
  s.position = "fixed";
  s.top = "64px";
  s.right = "20px";
  s.zIndex = "2147483647";
  s.display = "flex";
  s.flexDirection = "column";
  s.gap = "10px";
  s.pointerEvents = "none";
  hostEl.attachShadow({ mode: "open" });
  document.body.appendChild(hostEl);
  return hostEl;
}

function renderNotice(notice) {
  whenBody(() => {
    const accent = STATUS[notice.status] || STATUS.latest;
    const root = ensureHost().shadowRoot;

    const card = document.createElement("div");
    const cs = card.style;
    cs.pointerEvents = "auto";
    cs.boxSizing = "border-box";
    cs.width = "340px";
    cs.padding = "13px 15px";
    cs.borderRadius = "0";
    cs.background = "var(--bg-panel, #ffffff)";
    cs.color = "var(--text, #1a1a1a)";
    cs.border = "1px solid var(--border, rgba(0,0,0,0.06))";
    cs.borderLeft = "3px solid " + accent;
    cs.boxShadow = "0 2px 14px rgba(0,0,0,0.22)";
    cs.fontFamily = UI;
    cs.fontSize = "13px";
    cs.lineHeight = "1.5";
    cs.opacity = "0";
    cs.transform = "translateY(-10px)";
    cs.transition = "opacity .22s ease, transform .26s cubic-bezier(0.1,0.9,0.2,1)";

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";

    const dot = document.createElement("span");
    const ds = dot.style;
    ds.flex = "0 0 auto";
    ds.width = "8px";
    ds.height = "8px";
    ds.borderRadius = "0";
    ds.background = accent;
    ds.boxShadow = "0 0 0 3px color-mix(in srgb, " + accent + " 15%, transparent)";

    const title = document.createElement("div");
    title.textContent = notice.title || "检查更新";
    title.style.flex = "1 1 auto";
    title.style.fontWeight = "600";
    title.style.fontSize = "13.5px";
    title.style.letterSpacing = "0.2px";

    const close = document.createElement("button");
    close.textContent = "✕";
    close.setAttribute("aria-label", "关闭");
    const xs = close.style;
    xs.flex = "0 0 auto";
    xs.cursor = "pointer";
    xs.border = "none";
    xs.background = "transparent";
    xs.color = "var(--text-dim, #9ca3af)";
    xs.fontFamily = UI;
    xs.fontSize = "12px";
    xs.lineHeight = "1";
    xs.padding = "2px 4px";
    xs.borderRadius = "0";
    close.addEventListener("mouseenter", () => (close.style.color = "var(--text, #1a1a1a)"));
    close.addEventListener("mouseleave", () => (close.style.color = "var(--text-dim, #9ca3af)"));

    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    card.appendChild(head);

    if (notice.message) {
      const msg = document.createElement("div");
      msg.textContent = notice.message;
      msg.style.marginTop = "9px";
      msg.style.fontSize = "13px";
      msg.style.color = "var(--text, #1a1a1a)";
      card.appendChild(msg);
    }
    if (notice.detail) {
      const det = document.createElement("div");
      det.textContent = notice.detail;
      det.style.marginTop = "3px";
      det.style.fontSize = "12px";
      det.style.color = "var(--text-muted, #6b7280)";
      card.appendChild(det);
    }

    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      card.style.opacity = "0";
      card.style.transform = "translateY(-8px)";
      setTimeout(() => card.remove(), 220);
    };
    close.addEventListener("click", dismiss);

    if (notice.action && notice.action.id) {
      const act = document.createElement("button");
      act.textContent = notice.action.label || "更新";
      const as = act.style;
      as.marginTop = "12px";
      as.width = "100%";
      as.cursor = "pointer";
      as.padding = "9px 12px";
      as.border = "none";
      as.borderRadius = "0";
      as.background = "var(--accent, #0050EF)";
      as.color = "#ffffff";
      as.fontFamily = UI;
      as.fontSize = "12.5px";
      as.fontWeight = "600";
      as.letterSpacing = "0.3px";
      act.addEventListener("mouseenter", () => (act.style.background = "var(--accent-hover, #2F6BFF)"));
      act.addEventListener("mouseleave", () => (act.style.background = "var(--accent, #0050EF)"));
      act.addEventListener("click", () => {
        act.disabled = true;
        act.textContent = "正在更新…";
        act.style.opacity = "0.75";
        act.style.cursor = "default";
        ipcRenderer.send("pi-web-desktop:" + notice.action.id);
      });
      card.appendChild(act);
    }

    root.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });

    const sticky = notice.status === "error" || !!(notice.action && notice.action.id);
    if (!sticky) timer = setTimeout(dismiss, 8000);
  });
}

ipcRenderer.on("pi-web-desktop:update-notice", (_e, notice) => {
  if (notice) renderNotice(notice);
});

// ---------------------------------------------------------------------------
// Readability fix for pi-web's own notice shelf
// ---------------------------------------------------------------------------
(function fixNoticeShelf() {
  if (location.protocol !== "http:") return;

  const FONT = 14;
  const LINE = 1.5;
  const PAD_Y = 12;
  const DOT = 7;
  const DOT_TOP = Math.round(PAD_Y + (FONT * LINE) / 2 - DOT / 2);

  const CSS = [
    ".notice-shelf-item{",
    "height:auto !important;min-height:0 !important;max-height:40vh !important;",
    "overflow-y:auto !important;align-items:flex-start !important;",
    `font-size:${FONT}px !important;line-height:${LINE} !important;`,
    "}",
    `.notice-shelf-item>span:first-child{margin-top:${DOT_TOP}px !important;}`,
    ".notice-shelf-item>span:first-child+span{",
    "white-space:pre-wrap !important;text-overflow:clip !important;",
    "overflow:visible !important;overflow-wrap:anywhere !important;",
    `padding:${PAD_Y}px 0 !important;`,
    "}",
  ].join("");

  function inject() {
    if (document.getElementById("pi-web-desktop-notice-shelf-style")) return;
    const parent = document.head || document.documentElement;
    if (!parent) {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
      return;
    }
    const st = document.createElement("style");
    st.id = "pi-web-desktop-notice-shelf-style";
    st.textContent = CSS;
    parent.appendChild(st);
  }
  inject();
})();

// ---------------------------------------------------------------------------
// Bottom strip: reload button (browser-style ⟳) + reserve space
// ---------------------------------------------------------------------------
(function mountBottomBar() {
  if (location.protocol !== "http:") return;

  const BAR_H = 30;
  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let host = null;
  let bar = null;

  function whenBodyReady(cb) {
    if (document.body) cb();
    else document.addEventListener("DOMContentLoaded", cb, { once: true });
  }

  function ensureHost() {
    if (host && document.body && document.body.contains(host)) return host;
    host = document.createElement("div");
    host.id = "pi-web-desktop-dashboard-host";
    const s = host.style;
    s.position = "fixed";
    s.left = "0";
    s.right = "0";
    s.bottom = "0";
    s.height = BAR_H + "px";
    s.zIndex = "2147483600";
    s.pointerEvents = "none";
    host.attachShadow({ mode: "open" });
    document.body.appendChild(host);
    buildBar();
    return host;
  }

  function viewportReserveValue() {
    return "calc(100dvh - " + BAR_H + "px)";
  }

  function applyViewportReserve() {
    const root = document.documentElement;
    if (!root) return;
    if (root.style.getPropertyValue("--app-viewport-height") !== viewportReserveValue()) {
      root.style.setProperty("--app-viewport-height", viewportReserveValue());
    }
  }

  function guardViewportReserve() {
    applyViewportReserve();
    try {
      new MutationObserver(() => applyViewportReserve()).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
    } catch {
      /* ignore */
    }
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", applyViewportReserve);
      vv.addEventListener("scroll", applyViewportReserve);
    }
  }

  function ensureReserveStyle() {
    if (document.getElementById("pi-web-desktop-reserve-style")) return;
    const st = document.createElement("style");
    st.id = "pi-web-desktop-reserve-style";
    st.textContent =
      "[data-piwd-reserve]{height:calc(100dvh - " +
      BAR_H +
      "px) !important;max-height:calc(100dvh - " +
      BAR_H +
      "px) !important;}";
    (document.head || document.documentElement).appendChild(st);
  }

  function tagAppRoot() {
    const kids = (document.body && document.body.children) || [];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (el === host || el.id === "pi-web-desktop-cta-host" || el.id === "pi-web-desktop-dashboard-host") {
        continue;
      }
      const h = el.tagName === "DIV" && el.style ? el.style.height.replace(/\s+/g, "") : "";
      if (h === "100dvh" || h === "var(--app-viewport-height,100dvh)") {
        if (!el.hasAttribute("data-piwd-reserve")) el.setAttribute("data-piwd-reserve", "1");
        return true;
      }
    }
    return false;
  }

  function setupReserve() {
    ensureReserveStyle();
    guardViewportReserve();
    tagAppRoot();
    try {
      new MutationObserver(() => tagAppRoot()).observe(document.body, { childList: true });
    } catch {
      /* ignore */
    }
  }

  function buildReloadChip() {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-label", "重新加载页面");
    chip.title = "重新加载 (Ctrl+R)";
    const cs = chip.style;
    cs.pointerEvents = "auto";
    cs.display = "flex";
    cs.alignItems = "center";
    cs.justifyContent = "center";
    cs.cursor = "pointer";
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "var(--text-muted, #6b7280)";
    cs.fontFamily = UI;
    cs.fontSize = "14px";
    cs.lineHeight = "1";
    cs.padding = "5px 8px";
    cs.borderRadius = "0";
    cs.transition = "background .15s ease, color .15s ease";
    chip.addEventListener("mouseenter", () => {
      chip.style.background = "color-mix(in srgb, var(--text, #1a1a1a) 8%, transparent)";
      chip.style.color = "var(--text, #1a1a1a)";
    });
    chip.addEventListener("mouseleave", () => {
      chip.style.background = "transparent";
      chip.style.color = "var(--text-muted, #6b7280)";
    });

    const glyph = document.createElement("span");
    glyph.textContent = "⟳";
    glyph.style.display = "inline-block";
    glyph.style.fontSize = "15px";

    let reloading = false;
    chip.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (reloading) return;
      reloading = true;
      if (!reduceMotion) {
        try {
          glyph.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
            duration: 600,
            iterations: Infinity,
            easing: "linear",
          });
        } catch {
          /* WAAPI unavailable */
        }
      }
      try {
        const r = await ipcRenderer.invoke("pi-web-desktop:reload-page");
        if (!r || r.ok !== true) throw new Error((r && r.error) || "reload refused");
      } catch {
        location.reload();
      }
    });

    chip.appendChild(glyph);
    return chip;
  }

  function buildBar() {
    const root = host.shadowRoot;

    bar = document.createElement("div");
    const bs = bar.style;
    bs.boxSizing = "border-box";
    bs.width = "100%";
    bs.height = "30px";
    bs.display = "flex";
    bs.alignItems = "center";
    bs.justifyContent = "flex-start";
    bs.padding = "0 14px";
    bs.fontFamily = UI;
    bs.fontSize = "12px";
    bs.color = "var(--text-muted, #6b7280)";
    bs.background = "var(--bg-panel, #ffffff)";
    bs.borderTop = "1px solid var(--border, rgba(0,0,0,0.06))";
    bs.pointerEvents = "none";

    bar.appendChild(buildReloadChip());
    root.appendChild(bar);
  }

  function init() {
    ensureHost();
    setupReserve();
  }

  whenBodyReady(init);
})();

// ---------------------------------------------------------------------------
// Theme sync — pi-web's light/dark toggle → the native window frame
// ---------------------------------------------------------------------------
(function syncNativeTheme() {
  if (location.protocol !== "http:") return;

  let last = null;

  function report() {
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    if (theme === last) return;
    last = theme;
    ipcRenderer.send("pi-web-desktop:theme-changed", theme);
  }

  function init() {
    report();
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  if (document.documentElement) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();

// ---------------------------------------------------------------------------
// Brand rename — "Pi Web" → "Pi" in the embedded page
// ---------------------------------------------------------------------------
(function renameBrand() {
  if (location.protocol !== "http:") return;

  const FROM = "Pi Web";
  const TO = "Pi";
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT"]);

  function fixText(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || node.nodeValue !== FROM) return;
    const el = node.parentElement;
    if (!el || SKIP.has(el.tagName) || el.isContentEditable) return;
    node.nodeValue = TO;
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return fixText(root);
    if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has(root.tagName)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) fixText(n);
  }

  function init() {
    scan(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") fixText(r.target);
        else r.addedNodes.forEach(scan);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
