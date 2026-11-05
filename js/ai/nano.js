// On-device provider: Chrome's built-in Gemini Nano via the Prompt API (Chrome 138+).
// Free, private, works offline once the model is downloaded.

const OPTS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};
const LM = () => globalThis.LanguageModel;

// "unsupported" | "unavailable" | "downloadable" | "downloading" | "available"
export async function availability() {
  if (!LM()) return "unsupported";
  try {
    return await LM().availability(OPTS);
  } catch {
    return "unavailable";
  }
}

// Starts (or continues) the one-time model download. onProgress gets 0..1.
export async function download(onProgress) {
  const s = await LM().create({
    ...OPTS,
    monitor(m) { m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded)); },
  });
  s.destroy();
}

async function session(system, history = []) {
  return LM().create({ ...OPTS, initialPrompts: [{ role: "system", content: system }, ...history] });
}

// Roughly how many words fit in one prompt (Nano's window is small)
export const WORD_BUDGET = 1400;

export async function json({ system, user, schema }) {
  const s = await session(system);
  try {
    return await s.prompt(user, { responseConstraint: schema });
  } finally {
    s.destroy();
  }
}

// Streams a chat reply. Yields the text added since the last chunk.
export async function* chat(system, messages) {
  const s = await session(system, messages.slice(0, -1));
  try {
    let sofar = "";
    for await (const chunk of s.promptStreaming(messages[messages.length - 1].content)) {
      // Older Chrome builds send the whole reply so far; newer ones send only the new part
      const delta = chunk.startsWith(sofar) && sofar ? chunk.slice(sofar.length) : chunk;
      sofar += delta;
      yield delta;
    }
  } finally {
    s.destroy();
  }
}
