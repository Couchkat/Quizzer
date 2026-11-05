// Small UI helpers shared by every screen.
import { hydrateIcons } from "./icons.js";

export const $ = (id) => document.getElementById(id);

// Escape anything that came from a web page or an AI before it goes into innerHTML
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function render(el, html) {
  el.innerHTML = html;
  hydrateIcons(el);
  return el;
}

// Top bar: title, small crumb above it, and whether the back button shows
export function setTop({ title = "Quizzer", crumb = "", back = null } = {}) {
  $("title").textContent = title;
  $("crumb").textContent = crumb;
  $("btn-back").hidden = !back;
  $("brand").hidden = !!back;
  $("btn-back").onclick = back;
}

export function setActions(html) {
  const bar = $("actionbar");
  if (!html) { bar.hidden = true; bar.innerHTML = ""; return bar; }
  bar.hidden = false;
  return render(bar, html);
}

let toastTimer = 0;
export function toast(message, { error = false, action = null, ms = 3600 } = {}) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast${error ? " error" : ""}`;
  t.setAttribute("role", "status");
  t.textContent = message;
  if (action) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = ` ${action.label}`;
    a.onclick = (e) => { e.preventDefault(); t.remove(); action.run(); };
    t.append(a);
  }
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// Screen-reader announcement (right/wrong, new question)
export function announce(text) {
  const live = $("live");
  live.textContent = "";
  requestAnimationFrame(() => (live.textContent = text));
}

export function closeMenus() {
  document.querySelectorAll(".menu:not([hidden])").forEach((m) => (m.hidden = true));
}
export function toggleMenu(menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-anchor")) closeMenus();
});

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
export const sameDoc = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search; } catch { return false; } };

export const TYPE_LABEL = { mc: "Multiple choice", tf: "True or false", short: "Short answer", card: "Flashcard" };

// Is the user typing somewhere (so single-key shortcuts should stay out of the way)?
export const typing = (e) => !!e.target.closest?.("input, textarea, select, [contenteditable='true']");
