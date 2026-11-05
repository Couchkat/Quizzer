// Settings: where the AI comes from, the on-page chip, and saved data.
import { AI } from "../ai/index.js";
import { DB, Settings } from "../db.js";
import { $, esc, render, setTop, setActions, toast } from "../ui.js";

export async function showSettings(app) {
  setTop({ title: "Settings", back: () => app.goHome() });
  setActions(null);
  $("rail").hidden = true;
  const [cfg, status, chip] = await Promise.all([AI.config(), AI.status(), Settings.get("chip", { enabled: true, hiddenSites: [] })]);
  const nano = cfg.mode === "key" ? null : status;
  const P = AI.providers;

  const nanoLine = () => {
    if (!nano) return "";
    const lines = {
      available: ["ok", "Ready. Runs on this computer, free and offline."],
      downloadable: ["", "Needs a one-time download of about 2 GB."],
      downloading: ["", "Downloading…"],
      unsupported: ["bad", "Not available in this version of Chrome. It needs Chrome 138 or newer on a supported computer."],
      unavailable: ["bad", "Not available on this computer. Use an API key instead."],
    };
    const [dot, text] = status.ready ? lines.available : lines[status.reason] || lines.unavailable;
    return `
      <div class="status-line"><span class="dot ${dot}"></span><span>${text}</span></div>
      ${!status.ready && (status.reason === "downloadable" || status.reason === "downloading") ? `
        <div class="row-actions"><button class="btn primary" data-download><span data-icon="download"></span>Download model</button></div>
        <div class="progress" hidden><i></i></div>` : ""}`;
  };

  render($("view"), `
    <section class="panel-block">
      <h3>AI</h3>
      <div class="seg two" role="radiogroup" aria-label="Where the AI runs">
        <button role="radio" data-mode="nano" class="${cfg.mode !== "key" ? "on" : ""}"><span data-icon="cpu"></span>On this computer</button>
        <button role="radio" data-mode="key" class="${cfg.mode === "key" ? "on" : ""}"><span data-icon="key"></span>API key</button>
      </div>
      <div style="margin-top:12px">
        ${cfg.mode === "key" ? `
          <div class="field">
            <label for="provider">Provider</label>
            <select id="provider" class="select">
              ${Object.entries(P).map(([id, p]) => `<option value="${id}" ${cfg.provider === id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="key">API key</label>
            <input id="key" class="input mono" type="password" autocomplete="off" spellcheck="false" value="${esc(cfg.key)}" placeholder="${esc(P[cfg.provider].keyHint)}" />
            <div class="help">Stored only in this browser. Sent only to ${esc(P[cfg.provider].label)}.</div>
          </div>
          <div class="field">
            <label for="model">Model</label>
            <input id="model" class="input mono" autocomplete="off" spellcheck="false" value="${esc(cfg.model)}" placeholder="${esc(P[cfg.provider].model)}" />
            <div class="help">Leave blank to use ${esc(P[cfg.provider].model)}.</div>
          </div>
          <div class="row-actions">
            <button class="btn primary" data-save>Save key</button>
            <button class="btn" data-test>Test</button>
          </div>
          <div class="status-line" id="key-status" style="margin-top:10px" hidden></div>
        ` : nanoLine()}
      </div>
    </section>

    <section class="panel-block">
      <h3>Quiz me chip</h3>
      <div class="switch-row">
        <span>Show a Quiz me button when you highlight 15 or more words on a page</span>
        <button class="switch" role="switch" aria-checked="${chip.enabled !== false}" data-chip aria-label="Show the Quiz me chip"></button>
      </div>
      ${(chip.hiddenSites || []).length ? `
        <p class="muted" style="margin:12px 0 0">Hidden on these sites:</p>
        <ul class="site-list">${chip.hiddenSites.map((s) => `<li>${esc(s)}<button class="icon-btn sm" data-unhide="${esc(s)}" data-icon="x" title="Show on ${esc(s)} again" aria-label="Show on ${esc(s)} again"></button></li>`).join("")}</ul>` : ""}
    </section>

    <section class="panel-block">
      <h3>Saved quizzes</h3>
      <p class="muted" style="margin:0 0 10px">Quizzes, answers and your missed-question deck are stored on this computer only.</p>
      <button class="btn" data-clear style="color:var(--danger)"><span data-icon="trash" style="display:inline-block;vertical-align:-4px;margin-right:4px"></span>Delete all quizzes</button>
    </section>
  `);

  const view = $("view");
  view.onclick = async (e) => {
    const mode = e.target.closest("[data-mode]");
    if (mode) {
      await AI.setConfig({ mode: mode.dataset.mode });
      return showSettings(app);
    }
    if (e.target.closest("[data-download]")) {
      const btn = e.target.closest("[data-download]");
      const bar = view.querySelector(".progress");
      btn.disabled = true;
      bar.hidden = false;
      try {
        await AI.downloadNano((p) => bar.style.setProperty("--p", `${Math.round(p * 100)}%`));
        toast("On-device model is ready.");
      } catch (err) {
        toast(`Download didn't finish: ${err.message}`, { error: true });
      }
      return showSettings(app);
    }
    if (e.target.closest("[data-save]") || e.target.closest("[data-test]")) {
      await AI.setConfig({ provider: $("provider").value, key: $("key").value.trim(), model: $("model").value.trim() });
      if (e.target.closest("[data-save]")) { toast("Key saved."); await app.refreshStatus(); return; }
      const line = $("key-status");
      line.hidden = false;
      render(line, `<span class="dot"></span><span>Testing…</span>`);
      try {
        const ok = await AI.testKey();
        render(line, ok ? `<span class="dot ok"></span><span>Working.</span>` : `<span class="dot bad"></span><span>The provider replied, but not as expected. Check the model name.</span>`);
      } catch (err) {
        render(line, `<span class="dot bad"></span><span>${esc(err.message)}</span>`);
      }
      return;
    }
    if (e.target.closest("[data-chip]")) {
      const sw = e.target.closest("[data-chip]");
      const enabled = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", enabled);
      await Settings.set("chip", { ...chip, enabled });
      chip.enabled = enabled;
      return;
    }
    const un = e.target.closest("[data-unhide]");
    if (un) {
      await Settings.set("chip", { ...chip, hiddenSites: chip.hiddenSites.filter((s) => s !== un.dataset.unhide) });
      return showSettings(app);
    }
    const clear = e.target.closest("[data-clear]");
    if (clear) {
      if (!clear.dataset.confirm) {
        clear.dataset.confirm = "1";
        clear.lastChild.textContent = "Click again to delete everything";
        return;
      }
      await DB.clearAll();
      toast("All quizzes deleted.");
      return app.goHome();
    }
  };
  view.querySelector("#provider")?.addEventListener("change", async (e) => {
    await AI.setConfig({ provider: e.target.value, key: $("key").value.trim(), model: "" });
    showSettings(app);
  });
}
