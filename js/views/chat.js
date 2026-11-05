// "Ask a follow-up": a short chat about one question, under its card.
import { AI } from "../ai/index.js";
import { render } from "../ui.js";

const LIMIT = 6; // your messages per question

export function openChat(host, { question, passage, onError }) {
  const messages = [];
  render(host, `
    <div class="chat">
      <div class="msgs" aria-live="polite"></div>
      <form class="chat-form">
        <label class="sr-only" for="chat-in">Ask a follow-up question</label>
        <input id="chat-in" autocomplete="off" placeholder="What's still unclear?" />
        <button class="icon-btn accent" type="submit" data-icon="send" title="Send" aria-label="Send"></button>
      </form>
      <div class="chat-limit" hidden></div>
    </div>`);
  const list = host.querySelector(".msgs");
  const form = host.querySelector("form");
  const input = host.querySelector("input");
  const limitNote = host.querySelector(".chat-limit");
  let busy = false;

  const add = (role, text) => {
    const el = document.createElement("div");
    el.className = `msg ${role === "user" ? "me" : "ai"}`;
    el.textContent = text;
    list.append(el);
    el.scrollIntoView({ block: "nearest" });
    return el;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    busy = true;
    messages.push({ role: "user", content: text });
    add("user", text);
    const out = add("assistant", "");
    out.classList.add("pending");
    let reply = "";
    try {
      for await (const chunk of AI.chat({ question, passage, messages })) {
        reply += chunk;
        out.textContent = reply;
        out.scrollIntoView({ block: "nearest" }); // keep the reply in view as it streams
      }
      if (!reply.trim()) out.textContent = reply = "I couldn't come up with an answer. Try asking another way.";
    } catch (err) {
      out.textContent = err.message || "The AI didn't respond.";
      out.style.color = "var(--danger)";
      onError?.(err);
    }
    out.classList.remove("pending");
    messages.push({ role: "assistant", content: reply });
    busy = false;
    const used = messages.filter((m) => m.role === "user").length;
    if (used >= LIMIT) {
      input.disabled = true;
      input.placeholder = "Follow-up limit reached for this question";
      limitNote.hidden = false;
      limitNote.textContent = `That's ${LIMIT} follow-ups. Go to the next question to keep the quiz moving.`;
    } else input.focus();
  };
  input.focus();
}
