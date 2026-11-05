// Side panel entry point: appearance, which tab we're looking at, and moving
// between screens. Each screen lives in js/views/.

import { hydrateIcons } from "./icons.js";
import { $, toggleMenu, toast } from "./ui.js";
import { Settings } from "./db.js";
import { AI } from "./ai/index.js";
import { fromTab, textToPassages, selectionInTab } from "./source.js";
import { showHome } from "./views/home.js";
import { openSetup } from "./views/setup.js";
import { runQuiz } from "./views/quiz.js";
import { showSettings } from "./views/settings.js";
import { showPaste } from "./views/paste.js";

// ───────── Appearance: mode (auto/light/dark) + color theme (shared with Noted) ─────────
const PALETTES = [
  { id: "lagoon", name: "Lagoon", desc: "Teal, Quizzer's own", bg: "#f2f6f6", text: "#121b1d", accent: "#0e7c86" },
  { id: "evergreen", name: "Evergreen", desc: "Noted's green", bg: "#f4f4f5", text: "#18181b", accent: "#1f7a5a" },
  { id: "cobalt", name: "Cobalt", desc: "Cool blue", bg: "#f3f5f8", text: "#141a24", accent: "#2f5fd0" },
  { id: "terracotta", name: "Terracotta", desc: "Warm clay", bg: "#f6f3ee", text: "#241c16", accent: "#b4532a" },
  { id: "rose", name: "Rose", desc: "Soft berry", bg: "#f7f3f4", text: "#22171a", accent: "#b03a5b" },
  { id: "graphite", name: "Graphite", desc: "Black and white", bg: "#f2f2f2", text: "#161616", accent: "#262626" },
];
const Appearance = { mode: "system", palette: "lagoon" };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function applyAppearance() {
  const root = document.documentElement;
  const dark = Appearance.mode === "dark" || (Appearance.mode === "system" && darkQuery.matches);
  root.dataset.palette = Appearance.palette;
  root.dataset.mode = dark ? "dark" : "light";
  try { localStorage.setItem("quizzer:appearance", JSON.stringify(Appearance)); } catch {}
  document.querySelectorAll("[data-mode-opt]").forEach((b) => {
    const on = b.dataset.modeOpt === Appearance.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  document.querySelectorAll("[data-palette-opt]").forEach((b) => {
    const on = b.dataset.paletteOpt === Appearance.palette;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
}

async function initAppearance() {
  Object.assign(Appearance, await Settings.get("appearance", {}));
  if (!PALETTES.some((p) => p.id === Appearance.palette)) Appearance.palette = "lagoon";
  $("palette-list").innerHTML = PALETTES.map((p) => `
    <button class="menu-item palette-opt" data-palette-opt="${p.id}" role="radio"
      style="--pv-bg:${p.bg};--pv-text:${p.text};--pv-accent:${p.accent}">
      <span class="pv"></span>
      <span class="po-text"><span class="po-name">${p.name}</span><span class="po-desc">${p.desc}</span></span>
      <span class="po-check" data-icon="check"></span>
    </button>`).join("");
  hydrateIcons(document);
  $("btn-appearance").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu($("appearance-menu")); });
  $("appearance-menu").addEventListener("click", async (e) => {
    const m = e.target.closest("[data-mode-opt]");
    const p = e.target.closest("[data-palette-opt]");
    if (m) Appearance.mode = m.dataset.modeOpt;
    if (p) Appearance.palette = p.dataset.paletteOpt;
    if (m || p) { applyAppearance(); await Settings.set("appearance", { ...Appearance }); }
  });
  darkQuery.addEventListener("change", () => Appearance.mode === "system" && applyAppearance());
  applyAppearance();
}

// ───────── App controller ─────────
const app = {
  tab: null,      // { id, url, title }
  status: null,   // AI.status()
  session: null,  // running QuizSession
  screen: "home",

  async currentTab() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    app.tab = t ? { id: t.id, url: t.url || "", title: t.title || "" } : null;
    return app.tab;
  },

  async refreshStatus() {
    app.status = await AI.status();
    return app.status;
  },

  leaveQuiz() {
    app.session?.reset();
    app.session = null;
    $("rail").hidden = true;
  },

  async goHome() {
    app.leaveQuiz();
    app.screen = "home";
    await app.currentTab();
    await app.refreshStatus();
    await showHome(app);
  },

  async openSettings() {
    app.screen = "settings";
    await showSettings(app);
  },

  // Whole page → setup sheet
  async quizPage() {
    const tab = await app.currentTab();
    if (!tab) return;
    const read = await fromTab(tab.id);
    if (read.error) return showPaste(app, { url: tab.url, title: tab.title });
    openSetup(app, { kind: "page", url: tab.url, title: tab.title, ...read });
  },

  // Current selection → setup sheet
  async quizSelection(text) {
    const tab = await app.currentTab();
    if (text == null && tab) text = await selectionInTab(tab.id);
    if (!text || !text.trim()) {
      toast("Highlight some text on the page first.");
      return;
    }
    const read = textToPassages(text);
    openSetup(app, { kind: "selection", url: tab?.url || "", title: tab?.title || "Selection", excerpt: text.trim(), ...read });
  },

  quizPasted({ text, url, title }) {
    const read = textToPassages(text);
    if (read.words < 20) return toast("Paste at least a paragraph to quiz on.");
    openSetup(app, { kind: "paste", url: "", title: title || "Pasted text", excerpt: text.trim(), sourceUrl: url, ...read });
  },

  async start(source, settings, existingSession = null) {
    app.screen = "quiz";
    await runQuiz(app, { source, settings, session: existingSession });
  },
};

// Requests from the right-click menu or the on-page chip
async function takePending() {
  const { pendingQuiz } = await chrome.storage.session.get("pendingQuiz");
  if (!pendingQuiz) return;
  await chrome.storage.session.remove("pendingQuiz");
  if (Date.now() - pendingQuiz.at > 60_000) return;
  if (app.screen !== "home") { app.leaveQuiz(); await app.goHome(); }
  app.quizSelection(pendingQuiz.text);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingQuiz?.newValue) takePending();
});

// Keep the home screen in step with the tab you're looking at
let tabTimer = 0;
function onTabChange() {
  if (app.screen !== "home") return;
  clearTimeout(tabTimer);
  tabTimer = setTimeout(() => app.goHome(), 150);
}
chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "complete" && id === app.tab?.id) onTabChange(); });

$("btn-settings").addEventListener("click", () => (app.screen === "settings" ? app.goHome() : app.openSettings()));

(async function init() {
  await initAppearance();
  await app.goHome();
  await takePending();
})();
