// The one interface the rest of Quizzer uses. It picks a provider (on-device Nano
// or an API key) and hides the difference:
//   AI.status()  AI.concepts()  AI.generate()  AI.grade()  AI.explainWrong()  AI.chat()

import * as Nano from "./nano.js";
import * as Remote from "./remote.js";
import { conceptsPrompt, questionPrompt, gradePrompt, explainWrongPrompt, chatSystem } from "./prompts.js";
import { extractJson, validateQuestion, shuffleOptions, validateGrade } from "./parse.js";
import { Settings } from "../db.js";
import { wordCount } from "../source.js";

export const DEFAULT_AI = { mode: "nano", provider: "anthropic", key: "", model: "" };

async function config() {
  return { ...DEFAULT_AI, ...(await Settings.get("ai", {})) };
}

// Nano handles one prompt at a time best, so structured calls go through a queue
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function provider() {
  const cfg = await config();
  if (cfg.mode === "key") {
    return {
      name: "remote",
      budget: Remote.WORD_BUDGET,
      json: (p) => Remote.json(cfg, p),
      chat: (system, msgs) => Remote.chat(cfg, system, msgs),
    };
  }
  return {
    name: "nano",
    budget: Nano.WORD_BUDGET,
    json: (p) => queued(() => Nano.json(p)),
    chat: (system, msgs) => Nano.chat(system, msgs),
  };
}

// Ask for JSON, check it, and retry once with the reason if it was invalid
async function askJson(p, prompt, check) {
  let user = prompt.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = extractJson(await p.json({ ...prompt, user }));
    } catch (e) {
      if (e instanceof Remote.AIError) throw e;
      raw = null;
    }
    const res = raw ? check(raw) : { ok: false, error: "reply was not valid JSON" };
    if (res.ok) return res.value;
    user = `${prompt.user}\n\nYour last reply was invalid because ${res.error}. Try again.`;
  }
  return null;
}

// Pick passages that fit the provider's word budget, starting at a random spot so
// repeated questions on one concept draw on different parts of it
function fitPassages(passages, budget, rand = Math.random) {
  if (passages.length <= 1) return passages;
  const start = Math.floor(rand() * passages.length);
  const out = [];
  let words = 0;
  for (let k = 0; k < passages.length; k++) {
    const p = passages[(start + k) % passages.length];
    const n = wordCount(p.text);
    if (out.length && words + n > budget) break;
    out.push(p);
    words += n;
  }
  return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export const AI = {
  config,
  setConfig: async (change) => Settings.set("ai", { ...(await config()), ...change }),
  providers: Remote.PROVIDERS,

  // { provider, ready, reason } where reason is one of
  // "downloadable" | "downloading" | "unsupported" | "unavailable" | "nokey"
  async status() {
    const cfg = await config();
    if (cfg.mode === "key") {
      return cfg.key ? { provider: "remote", ready: true, label: Remote.PROVIDERS[cfg.provider]?.label } : { provider: "remote", ready: false, reason: "nokey" };
    }
    const a = await Nano.availability();
    if (a === "available") return { provider: "nano", ready: true, label: "On-device (Gemini Nano)" };
    return { provider: "nano", ready: false, reason: a };
  },

  downloadNano: (onProgress) => Nano.download(onProgress),
  testKey: async () => Remote.test(await config()),

  // Passages → concepts [{ id, name, passageIds }]. Long pages are read in batches.
  async concepts(passages) {
    const p = await provider();
    const batches = [];
    let cur = [], words = 0;
    for (const ps of passages) {
      const n = wordCount(ps.text);
      if (cur.length && words + n > p.budget) { batches.push(cur); cur = []; words = 0; }
      cur.push(ps); words += n;
    }
    if (cur.length) batches.push(cur);

    const perBatch = Math.max(3, Math.ceil(12 / batches.length));
    const found = [];
    for (const batch of batches) {
      const prompt = conceptsPrompt(batch, Math.min(10, perBatch));
      const ids = batch.map((b) => b.id);
      const list = await askJson(p, prompt, (raw) => {
        const items = (raw.concepts || [])
          .map((c) => ({ name: String(c.name || "").trim(), passageIds: (c.passageIds || []).filter((id) => ids.includes(id)) }))
          .filter((c) => c.name && c.passageIds.length);
        return items.length ? { ok: true, value: items } : { ok: false, error: '"concepts" was empty' };
      });
      if (list) found.push(...list);
    }

    // Merge concepts with the same name across batches
    const merged = new Map();
    for (const c of found) {
      const key = c.name.toLowerCase();
      if (merged.has(key)) merged.get(key).passageIds.push(...c.passageIds);
      else merged.set(key, { ...c, passageIds: [...c.passageIds] });
    }
    let concepts = [...merged.values()].slice(0, 12);

    // If the model gave us nothing usable, fall back to page sections
    if (!concepts.length) {
      const size = Math.max(1, Math.ceil(passages.length / 6));
      for (let i = 0; i < passages.length; i += size) {
        const group = passages.slice(i, i + size);
        concepts.push({ name: group[0].text.split(/\s+/).slice(0, 5).join(" ") + "…", passageIds: group.map((g) => g.id) });
      }
    }
    return concepts.map((c, i) => ({ id: `c${i + 1}`, name: c.name, passageIds: [...new Set(c.passageIds)] }));
  },

  // One question, validated and with its options shuffled. null if the model failed twice.
  async generate({ passages, concept, type, difficulty, avoid = [] }) {
    const p = await provider();
    const own = passages.filter((x) => concept.passageIds.includes(x.id));
    const chosen = fitPassages(own.length ? own : passages, Math.floor(p.budget * 0.7));
    const prompt = questionPrompt({
      passages: chosen,
      concept: concept.name,
      type,
      difficulty,
      avoid: avoid.slice(-(p.name === "nano" ? 8 : 30)),
    });
    const ids = chosen.map((c) => c.id);
    const q = await askJson(p, prompt, (raw) => validateQuestion(raw, type, ids));
    return q ? shuffleOptions(q) : null;
  },

  async grade({ question, response, passage }) {
    const p = await provider();
    return askJson(p, gradePrompt({ question, response, passage }), validateGrade);
  },

  async explainWrong({ question, picked, passage }) {
    const p = await provider();
    const out = await askJson(p, explainWrongPrompt({ question, picked, passage }), (raw) =>
      raw.whyWrong ? { ok: true, value: String(raw.whyWrong).trim() } : { ok: false, error: '"whyWrong" was empty' });
    return out || "";
  },

  // Async generator of text chunks
  async *chat({ question, passage, messages }) {
    const p = await provider();
    yield* p.chat(chatSystem({ question, passage }), messages);
  },
};

export { AIError } from "./remote.js";
