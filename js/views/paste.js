// Fallback for pages Chrome won't let extensions read (chrome://, the Web Store, PDFs)
import { $, render, setTop, setActions } from "../ui.js";

export function showPaste(app, { url, title }) {
  app.screen = "paste";
  setTop({ title: "Paste text", crumb: title || "", back: () => app.goHome() });
  render($("view"), `
    <div class="panel-block">
      <h3>This page can't be read</h3>
      <p class="muted" style="margin:0 0 10px">Chrome blocks extensions on pages like this one. Copy the text you want to study and paste it here.</p>
      <label class="sr-only" for="paste">Text to quiz on</label>
      <textarea id="paste" class="answer-box paste" placeholder="Paste a few paragraphs…"></textarea>
    </div>
  `);
  const box = $("paste");
  const bar = setActions(`<span class="spacer"></span><button class="btn primary" data-go disabled>Make a quiz</button>`);
  const go = bar.querySelector("[data-go]");
  box.addEventListener("input", () => (go.disabled = box.value.trim().length < 40));
  go.onclick = () => app.quizPasted({ text: box.value, url, title });
  box.focus();
}
