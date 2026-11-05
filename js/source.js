// Turns a page or a selection into numbered passages (~80–200 words each).
// Every question remembers which passage it came from, which is what powers
// "Show in page".

export const MAX_WORDS = 12000;
const MIN_PASSAGE = 80;
const MAX_PASSAGE = 200;

// Runs INSIDE the web page (via chrome.scripting), so it can't use anything from
// this module. Returns readable text blocks in reading order.
export function readPageInTab() {
  const SKIP = "nav, header, footer, aside, script, style, noscript, form, button, select, [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo']";
  const BLOCKS = "h1, h2, h3, h4, p, li, blockquote, pre, dd, dt, td, figcaption";
  const root = document.querySelector("article, main, [role='main']") || document.body;
  const out = [];
  root.querySelectorAll(BLOCKS).forEach((el) => {
    if (el.closest(SKIP)) return;
    // Skip a block that contains another block (a <li> wrapping <p>s); the inner ones are read instead
    if (el.querySelector("p, li, blockquote, pre")) return;
    if (el.checkVisibility && !el.checkVisibility()) return;
    const text = el.innerText.replace(/\s+/g, " ").trim();
    if (text.length < 2) return;
    out.push({ text, heading: /^H[1-4]$/.test(el.tagName) });
  });
  // Pages built from <div>s only: fall back to the whole visible text
  if (out.length < 3) {
    return String(root.innerText || "").split(/\n{1,}/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, heading: false }));
  }
  return out;
}

// Runs INSIDE the page: the current selection as plain text (keeps line breaks).
export function readSelectionInTab() {
  const s = window.getSelection();
  return s && !s.isCollapsed ? s.toString() : "";
}

const wordCount = (t) => (t.match(/\S+/g) || []).length;

// Blocks → passages. Headings start a new passage; short paragraphs are merged.
// Returns { passages: [{id, text}], words, truncated }.
export function toPassages(blocks) {
  const passages = [];
  let buf = [], bufWords = 0, total = 0, truncated = false;
  const flush = () => {
    if (!buf.length) return;
    passages.push({ id: `p${passages.length + 1}`, text: buf.join("\n") });
    buf = []; bufWords = 0;
  };
  for (const b of blocks) {
    let n = wordCount(b.text);
    if (total + n > MAX_WORDS) { truncated = true; break; }
    total += n;
    if (b.heading && bufWords >= MIN_PASSAGE / 2) flush();
    // A very long paragraph gets split on sentence boundaries
    if (n > MAX_PASSAGE) {
      flush();
      let chunk = [];
      for (const sentence of b.text.split(/(?<=[.!?])\s+/)) {
        chunk.push(sentence);
        if (wordCount(chunk.join(" ")) >= MAX_PASSAGE * 0.75) { buf = [chunk.join(" ")]; flush(); chunk = []; }
      }
      if (chunk.length) { buf = [chunk.join(" ")]; bufWords = wordCount(buf[0]); }
      continue;
    }
    buf.push(b.text);
    bufWords += n;
    if (bufWords >= MIN_PASSAGE && bufWords + 40 > MAX_PASSAGE) flush();
    else if (bufWords >= MAX_PASSAGE) flush();
  }
  flush();
  return { passages, words: total, truncated };
}

// Plain text (a selection or pasted text) → passages
export function textToPassages(text) {
  const blocks = String(text).split(/\n\s*\n|\n/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).map((t) => ({ text: t, heading: false }));
  return toPassages(blocks);
}

// Reads the active tab. Returns { passages, words, truncated } or { error: "unreadable" }.
export async function fromTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageInTab });
    const blocks = res?.result || [];
    const out = toPassages(blocks);
    if (out.words < 20) return { error: "unreadable" };
    return out;
  } catch {
    return { error: "unreadable" }; // chrome:// pages, the Web Store and PDFs can't be scripted
  }
}

export async function selectionInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: readSelectionInTab });
    return results.map((r) => r.result).find((t) => t && t.trim()) || "";
  } catch {
    return "";
  }
}

export { wordCount };
