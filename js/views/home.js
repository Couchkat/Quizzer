// Home: start a quiz from this page or a selection, review misses, reopen saved sets.
import { DB } from "../db.js";
import { $, esc, render, setTop, setActions, timeAgo, hostOf, toast } from "../ui.js";
import { QuizSession } from "../session.js";

const SCRIPTABLE = /^(https?|file):/;

// What to say when the AI isn't ready yet
export function aiNotice(status) {
  if (!status || status.ready) return "";
  const msg = {
    downloadable: ["The on-device AI model isn't downloaded yet.", "Download model"],
    downloading: ["The on-device AI model is downloading.", "See progress"],
    unsupported: ["This version of Chrome doesn't have on-device AI. Add an API key to use Quizzer.", "Add API key"],
    unavailable: ["On-device AI isn't available on this computer. Add an API key to use Quizzer.", "Add API key"],
    nokey: ["Add your API key to start making quizzes.", "Add API key"],
  }[status.reason] || ["The AI isn't set up yet.", "Open settings"];
  return `
    <div class="notice warn">
      <span data-icon="info"></span>
      <div>${esc(msg[0])}<br /><button class="btn sm" data-act="settings">${esc(msg[1])}</button></div>
    </div>`;
}

export async function showHome(app) {
  setTop({ title: "Quizzer" });
  setActions(null);
  const view = $("view");
  const tab = app.tab;
  const canRead = tab && SCRIPTABLE.test(tab.url);
  const site = tab ? hostOf(tab.url) : "";

  const [sets, stats, missed] = await Promise.all([DB.allSets(), DB.stats(), DB.missed()]);
  sets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const here = sets.filter((s) => hostOf(s.url) && hostOf(s.url) === site);
  const others = sets.filter((s) => !here.includes(s));

  const row = (s, i) => {
    const st = stats[s.id] || { answered: 0, right: 0 };
    const pct = st.answered ? Math.round((st.right / st.answered) * 100) : null;
    const kind = s.kind === "selection" ? "Selection" : s.kind === "paste" ? "Pasted text" : "Page";
    return `
      <div class="set-row" role="button" tabindex="0" data-set="${s.id}" style="--i:${i}">
        <div class="set-main">
          <div class="set-title">${esc(s.title)}</div>
          <div class="set-meta">${kind}, ${st.answered} answered, ${timeAgo(s.updatedAt || s.createdAt)}</div>
        </div>
        ${pct == null ? "" : `<span class="acc${pct >= 80 ? " good" : ""}" title="Accuracy">${pct}%</span>`}
        <button class="icon-btn sm" data-del="${s.id}" data-icon="trash" title="Delete quiz" aria-label="Delete quiz"></button>
      </div>`;
  };

  render(view, `
    ${aiNotice(app.status)}
    <section class="source">
      <div class="source-site">${esc(site || "No page")}</div>
      <div class="source-title">${esc(tab?.title || "Open a page to quiz yourself on it")}</div>
      <div class="source-actions">
        <button class="btn primary lg" data-act="page" ${canRead || tab ? "" : "disabled"}><span data-icon="page"></span>Quiz this page</button>
        <button class="btn lg" data-act="selection" ${canRead ? "" : "disabled"}><span data-icon="selection"></span>Quiz selection</button>
      </div>
      <p class="source-hint">${canRead
        ? "Or highlight a passage and click the Quiz me chip that appears."
        : "Chrome doesn't let extensions read this page. Quiz this page lets you paste the text instead."}</p>
    </section>

    ${missed.length ? `
      <button class="review" data-act="review">
        <span class="review-num">${missed.length}</span>
        <span class="review-text">
          <span class="review-title">Review missed questions</span><br />
          <span class="review-sub">Questions you got wrong, from every quiz</span>
        </span>
        <span data-icon="chevRight"></span>
      </button>` : ""}

    ${here.length ? `
      <div class="section-head"><h2>On ${esc(site)}</h2><span>${here.length}</span></div>
      <div class="sets">${here.map(row).join("")}</div>` : ""}
    ${others.length ? `
      <div class="section-head"><h2>${here.length ? "Other quizzes" : "Your quizzes"}</h2><span>${others.length}</span></div>
      <div class="sets">${others.map((s, i) => row(s, i + here.length)).join("")}</div>` : ""}
    ${!sets.length ? `
      <div class="empty">
        <strong>No quizzes yet</strong>
        Start one from this page, or highlight the part you want to be tested on. Quizzes save automatically after your first answer.
      </div>` : ""}
  `);

  const needAI = () => {
    if (app.status?.ready) return false;
    app.openSettings();
    return true;
  };

  view.onclick = async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      if (del.dataset.confirm) {
        await DB.deleteSet(del.dataset.del);
        toast("Quiz deleted.");
        showHome(app);
      } else {
        del.dataset.confirm = "1";
        del.title = "Click again to delete";
        del.style.color = "var(--danger)";
        toast("Click the bin again to delete this quiz.");
      }
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "settings") return app.openSettings();
    if (act === "page") return needAI() || app.quizPage();
    if (act === "selection") return needAI() || app.quizSelection();
    if (act === "review") {
      const qs = await DB.missed();
      return app.start(null, null, QuizSession.review(qs));
    }
    const setRow = e.target.closest("[data-set]");
    if (setRow && !needAI()) {
      try {
        const s = await QuizSession.resume(setRow.dataset.set);
        app.start(null, null, s);
      } catch (err) {
        toast(err.message, { error: true });
      }
    }
  };
  view.onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".set-row")) { e.preventDefault(); e.target.click(); }
  };
}
