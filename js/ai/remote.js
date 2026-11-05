// API-key provider. Talks straight to the provider from the extension; the key is
// kept in chrome.storage.local on this computer and is never synced.

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", model: "claude-haiku-5-5", keyHint: "sk-ant-…" },
  openai: { label: "OpenAI", model: "gpt-5-mini", keyHint: "sk-…" },
  gemini: { label: "Google Gemini", model: "gemini-2.5-flash", keyHint: "AIza…" },
};

export const WORD_BUDGET = 9000;

export class AIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function request(cfg, { system, messages, json, stream }) {
  const model = cfg.model || PROVIDERS[cfg.provider].model;
  if (cfg.provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: { model, max_tokens: 1200, system, messages, stream },
    };
  }
  if (cfg.provider === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: `Bearer ${cfg.key}` },
      body: {
        model, stream,
        messages: [{ role: "system", content: system }, ...messages],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      },
    };
  }
  // Gemini
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}`,
    headers: { "x-goog-api-key": cfg.key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      ...(json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
    },
  };
}

async function send(cfg, opts) {
  if (!cfg.key) throw new AIError("key", "Add an API key in Settings.");
  const { url, headers, body } = request(cfg, opts);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch {
    throw new AIError("network", "Couldn't reach the AI provider. Check your internet connection.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    if (res.status === 401 || res.status === 403) throw new AIError("key", "The API key was rejected. Check it in Settings.");
    if (res.status === 429) throw new AIError("rate", "The provider's rate limit was hit. Wait a moment, then continue.");
    if (res.status === 404) throw new AIError("model", `Model not found. Check the model name in Settings.${detail ? ` (${detail})` : ""}`);
    throw new AIError("http", `The provider returned an error (${res.status}).${detail ? ` ${detail}` : ""}`);
  }
  return res;
}

function textOf(cfg, data) {
  if (cfg.provider === "anthropic") return (data.content || []).map((c) => c.text || "").join("");
  if (cfg.provider === "openai") return data.choices?.[0]?.message?.content || "";
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

function deltaOf(cfg, evt) {
  if (cfg.provider === "anthropic") return evt.type === "content_block_delta" ? evt.delta?.text || "" : "";
  if (cfg.provider === "openai") return evt.choices?.[0]?.delta?.content || "";
  return (evt.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

const withJsonInstruction = (user, schema) =>
  `${user}\n\nReply with a single JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(schema)}`;

export async function json(cfg, { system, user, schema }) {
  const res = await send(cfg, { system, messages: [{ role: "user", content: withJsonInstruction(user, schema) }], json: true, stream: false });
  return textOf(cfg, await res.json());
}

// Server-sent events → text deltas
export async function* chat(cfg, system, messages) {
  const res = await send(cfg, { system, messages, json: false, stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const d = deltaOf(cfg, JSON.parse(payload));
          if (d) yield d;
        } catch {}
      }
    }
  }
}

// Settings → "Test" button
export async function test(cfg) {
  const out = await json(cfg, { system: "Reply with JSON only.", user: 'Reply with {"ok": true}.', schema: { type: "object", properties: { ok: { type: "boolean" } } } });
  return /true/.test(out);
}
