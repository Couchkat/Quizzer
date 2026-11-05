// Runs on every page. Two jobs:
// 1. Shows a small "Quiz me" chip under a text selection of 15+ words.
// 2. "Show in page": finds a passage, scrolls to it and highlights it for a few
//    seconds with the CSS Custom Highlight API (the page's HTML is never changed).
(() => {
  if (window.__quizzerChip) return;
  window.__quizzerChip = true;

  const MIN_WORDS = 15;
  const host = location.hostname;
  let prefs = { enabled: true, hiddenSites: [] };
  chrome.storage.local.get("chip", (r) => { prefs = { ...prefs, ...(r.chip || {}) }; });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.chip) prefs = { ...prefs, ...(c.chip.newValue || {}) };
  });

  // ───────── The chip (lives in a shadow root so page CSS can't touch it) ─────────
  let root = null, chip = null, menu = null;
  function build() {
    const el = document.createElement("quizzer-chip");
    el.style.cssText = "position:fixed;top:0;left:0;z-index:2147483646;";
    root = el.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        [hidden] { display: none !important; }
        .wrap { position: fixed; display: flex; align-items: center; gap: 2px; padding: 3px;
          border-radius: 999px; background: #ffffff; border: 1px solid #e0e8e9;
          box-shadow: 0 1px 2px rgba(18,27,29,.06), 0 10px 28px -10px rgba(18,27,29,.28);
          font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #121b1d;
          animation: in .22s cubic-bezier(.16,1,.3,1); }
        @keyframes in { from { opacity: 0; transform: translateY(-3px) scale(.97); } }
        button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
          height: 28px; padding: 0 11px 0 8px; border-radius: 999px; transition: background .12s; }
        button:hover { background: #e7eeee; }
        button:active { transform: scale(.97); }
        button:focus-visible { outline: 2px solid #0e7c86; outline-offset: 1px; }
        .go { background: #0e7c86; color: #fff; }
        .go:hover { background: #0b6971; }
        .more { width: 28px; padding: 0; justify-content: center; color: #63777a; }
        svg { width: 15px; height: 15px; }
        .menu { position: absolute; top: calc(100% + 6px); right: 0; min-width: 170px; padding: 4px;
          border-radius: 10px; background: #fff; border: 1px solid #e0e8e9;
          box-shadow: 0 12px 32px -12px rgba(18,27,29,.3); }
        .menu button { display: flex; width: 100%; box-sizing: border-box; height: 30px; padding: 0 10px; border-radius: 7px; font-size: 12.5px; }
        @media (prefers-color-scheme: dark) {
          .wrap, .menu { background: #1a2324; border-color: #2f3b3c; color: #e6eff0; }
          button:hover, .menu button:hover { background: #283435; }
          .go { background: #4fc3cc; color: #062226; }
          .go:hover { background: #63ccd4; }
          .more { color: #92a4a6; }
        }
        @media (prefers-reduced-motion: reduce) { .wrap { animation: none; } }
      </style>
      <div class="wrap" hidden>
        <button class="go" title="Make a quiz from this selection">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11.5" cy="11" r="6.5"/><path d="M13 13.5l5 5"/></svg>
          Quiz me
        </button>
        <button class="more" title="More" aria-label="More options">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
        </button>
        <div class="menu" hidden><button class="hide">Don't show on ${host.replace(/[<>&"]/g, "")}</button></div>
      </div>`;
    document.documentElement.appendChild(el);
    chip = root.querySelector(".wrap");
    menu = root.querySelector(".menu");
    // Keep the page selection alive when the chip is pressed
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    root.querySelector(".go").addEventListener("click", () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      // Clear the selection so the chip doesn't reappear and later highlights stay visible
      sel?.removeAllRanges();
      hide();
      if (text.trim()) chrome.runtime.sendMessage({ type: "quiz-selection", text, url: location.href, title: document.title });
    });
    root.querySelector(".more").addEventListener("click", () => { menu.hidden = !menu.hidden; });
    root.querySelector(".hide").addEventListener("click", () => {
      const hiddenSites = [...new Set([...(prefs.hiddenSites || []), host])];
      chrome.storage.local.set({ chip: { ...prefs, hiddenSites } });
      hide();
    });
  }

  function hide() {
    if (chip) { chip.hidden = true; menu.hidden = true; }
  }

  function maybeShow() {
    if (!prefs.enabled || (prefs.hiddenSites || []).includes(host)) return hide();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    const text = sel.toString();
    if ((text.match(/\S+/g) || []).length < MIN_WORDS) return hide();
    // Don't offer it inside text fields
    const a = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (a && a.closest("input, textarea, [contenteditable='true']")) return hide();

    const rects = sel.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return hide();
    if (!root) build();
    chip.hidden = false;
    menu.hidden = true;
    const w = chip.offsetWidth || 130, h = chip.offsetHeight || 36;
    let left = Math.min(Math.max(8, last.right - w), innerWidth - w - 8);
    let top = last.bottom + 8;
    if (top + h > innerHeight - 8) top = Math.max(8, rects[0].top - h - 8);
    chip.style.left = `${left}px`;
    chip.style.top = `${top}px`;
  }

  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(maybeShow, 180); };
  document.addEventListener("mouseup", later);
  document.addEventListener("keyup", (e) => { if (e.key === "Escape") hide(); else if (e.shiftKey || e.key.startsWith("Arrow")) later(); });
  document.addEventListener("selectionchange", () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed) hide();
  });
  addEventListener("scroll", hide, { passive: true, capture: true });

  // ───────── Show in page ─────────
  const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  // Builds one lowercase string of the page's visible text, with a map back to text nodes
  function indexText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest("script, style, noscript, quizzer-chip")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let text = "";
    const map = []; // map[i] = [node, offset] for each char of `text`
    let lastSpace = true;
    for (let n; (n = walker.nextNode()); ) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          text += " "; map.push([n, i]); lastSpace = true;
        } else {
          text += norm(ch); map.push([n, i]); lastSpace = false;
        }
      }
      if (!lastSpace) { text += " "; map.push([n, v.length]); lastSpace = true; }
    }
    return { text, map };
  }

  let clearTimer = 0;
  function showPassage(needles) {
    const { text, map } = indexText();
    for (const raw of needles) {
      const needle = norm(String(raw || "")).replace(/\s+/g, " ").trim();
      if (needle.length < 12) continue;
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const [sNode, sOff] = map[at];
      const [eNode, eOff] = map[Math.min(at + needle.length - 1, map.length - 1)];
      const range = document.createRange();
      range.setStart(sNode, sOff);
      range.setEnd(eNode, Math.min(eOff + 1, eNode.nodeValue.length));
      window.getSelection()?.removeAllRanges(); // a leftover selection would hide the highlight
      const el = sNode.parentElement;
      el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      if (window.CSS?.highlights) {
        CSS.highlights.set("quizzer", new Highlight(range));
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => CSS.highlights.delete("quizzer"), 4000);
      }
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "show-passage") reply({ found: showPassage(msg.needles || []) });
    if (msg?.type === "ping") reply({ ok: true });
  });
})();
