// Setup sheet: question types, starting level, length. Remembers your last choices.
import { Settings } from "../db.js";
import { $, esc, render } from "../ui.js";
import { MAX_WORDS } from "../source.js";

const DEFAULTS = { types: ["mc", "tf", "short", "card"], level: "easy", length: 0 };
const TYPES = [
  ["mc", "Multiple choice"],
  ["tf", "True or false"],
  ["short", "Short answer"],
  ["card", "Flashcards"],
];

export async function openSetup(app, source) {
  const prefs = { ...DEFAULTS, ...(await Settings.get("quizPrefs", {})) };
  const overlay = $("overlay");
  const minutes = Math.max(1, Math.round(source.words / 230));
  const what = source.kind === "page"
    ? `${esc(source.title)}. About ${minutes} min of reading.`
    : `“${esc((source.excerpt || "").slice(0, 160))}${(source.excerpt || "").length > 160 ? "…" : ""}”`;

  render(overlay, `
    <div class="scrim" data-close></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div class="sheet-grip"></div>
      <h3 id="setup-title">${source.kind === "page" ? "Quiz this page" : source.kind === "paste" ? "Quiz pasted text" : "Quiz this selection"}</h3>
      <p class="sheet-src">${what}</p>
      ${source.truncated ? `<div class="notice"><span data-icon="info"></span><div>Long page. Quizzer will use the first ${MAX_WORDS.toLocaleString()} words, about ${Math.round(MAX_WORDS / 230)} min of reading.</div></div>` : ""}
      ${source.words < 60 ? `<div class="notice"><span data-icon="info"></span><div>This is short, so questions may start to repeat after a while. Select a longer passage for more variety.</div></div>` : ""}

      <div class="field">
        <span class="field-label" id="types-label">Question types</span>
        <div class="toggles" role="group" aria-labelledby="types-label">
          ${TYPES.map(([id, label]) => `<button class="toggle" data-type="${id}" aria-pressed="${prefs.types.includes(id)}"><span data-icon="check"></span>${label}</button>`).join("")}
        </div>
      </div>

      <div class="field">
        <span class="field-label">Start at</span>
        <div class="seg" data-seg="level" role="radiogroup" aria-label="Starting level">
          ${[["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]].map(([v, l]) => `<button role="radio" data-v="${v}">${l}</button>`).join("")}
        </div>
        <div class="help">Questions get harder as you get them right, and easier after a miss.</div>
      </div>

      <div class="field">
        <span class="field-label">Length</span>
        <div class="seg" data-seg="length" role="radiogroup" aria-label="Length">
          ${[[0, "Endless"], [10, "10 questions"], [20, "20 questions"]].map(([v, l]) => `<button role="radio" data-v="${v}">${l}</button>`).join("")}
        </div>
      </div>

      <button class="btn primary lg block" data-start>Start quiz</button>
    </section>
  `);

  const sheet = overlay.querySelector(".sheet");
  const state = { ...prefs, types: [...prefs.types] };
  const sync = () => {
    sheet.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", state.types.includes(b.dataset.type)));
    sheet.querySelectorAll("[data-seg]").forEach((seg) => {
      seg.querySelectorAll("button").forEach((b) => {
        const on = String(state[seg.dataset.seg]) === b.dataset.v;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on);
      });
    });
  };
  sync();
  const close = () => { overlay.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  overlay.onclick = async (e) => {
    if (e.target.closest("[data-close]")) return close();
    const t = e.target.closest("[data-type]");
    if (t) {
      const id = t.dataset.type;
      if (state.types.includes(id)) { if (state.types.length > 1) state.types = state.types.filter((x) => x !== id); }
      else state.types.push(id);
      return sync();
    }
    const segBtn = e.target.closest("[data-seg] button");
    if (segBtn) {
      const key = segBtn.closest("[data-seg]").dataset.seg;
      state[key] = key === "length" ? Number(segBtn.dataset.v) : segBtn.dataset.v;
      return sync();
    }
    if (e.target.closest("[data-start]")) {
      await Settings.set("quizPrefs", state);
      close();
      app.start(source, state);
    }
  };
  sheet.querySelector("[data-start]").focus();
}
