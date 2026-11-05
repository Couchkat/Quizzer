// Checks what the model sent back before it reaches the screen.
// validateQuestion returns { ok: true, value } or { ok: false, error } so the caller
// can retry once with the error message.

// Pull a JSON object out of a reply that may be wrapped in ```json fences or prose
export function extractJson(text) {
  if (text && typeof text === "object") return text;
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(s.slice(start, end + 1));
}

const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);

export function validateQuestion(raw, type, passageIds) {
  const fail = (error) => ({ ok: false, error });
  if (!raw || typeof raw !== "object") return fail("reply was not an object");
  const prompt = clean(raw.prompt);
  if (!prompt) return fail('"prompt" is empty');
  if (!passageIds.includes(raw.passageId)) return fail(`"passageId" must be one of ${passageIds.join(", ")}`);

  const q = { type, prompt, rationale: clean(raw.rationale) || "", passageId: raw.passageId, quote: clean(raw.quote) || "" };

  if (type === "mc") {
    const options = Array.isArray(raw.options) ? raw.options.map(clean) : [];
    if (options.length !== 4) return fail('"options" must have exactly 4 choices');
    if (options.some((o) => !o)) return fail("an option is empty");
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return fail("two options are the same");
    const i = Number(raw.answerIndex);
    if (!Number.isInteger(i) || i < 0 || i > 3) return fail('"answerIndex" must be 0, 1, 2 or 3');
    q.options = options;
    q.answerIndex = i;
  } else if (type === "tf") {
    let a = raw.answer;
    if (typeof a === "string") a = a.toLowerCase() === "true" ? true : a.toLowerCase() === "false" ? false : a;
    if (typeof a !== "boolean") return fail('"answer" must be true or false');
    q.answer = a;
  } else {
    const a = clean(raw.answer);
    if (!a) return fail('"answer" is empty');
    q.answer = a;
  }
  return { ok: true, value: q };
}

// Models like to put the right answer first; shuffle so it lands anywhere.
export function shuffleOptions(q, rand = Math.random) {
  if (q.type !== "mc") return q;
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((k) => q.options[k]), answerIndex: order.indexOf(q.answerIndex) };
}

export function validateGrade(raw) {
  const score = Math.max(0, Math.min(1, Number(raw?.score)));
  if (Number.isNaN(score)) return { ok: false, error: '"score" must be a number from 0 to 1' };
  return { ok: true, value: { score, missing: clean(raw.missing) || "", feedback: clean(raw.feedback) || "" } };
}
