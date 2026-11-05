// The quiz screen: concept rail, question card (all four types), feedback, summary.
import { AI, AIError } from "../ai/index.js";
import { QuizSession, GenerationError } from "../session.js";
import { $, esc, render, setTop, setActions, announce, toast, toggleMenu, sameDoc, TYPE_LABEL, typing } from "../ui.js";
import { openChat } from "./chat.js";
import { hydrateIcons } from "../icons.js";

let keyHandler = null;
function onKeys(fn) {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = fn;
  if (fn) document.addEventListener("keydown", fn);
}

const PASS = 0.7; // short-answer score that counts as right

export async function runQuiz(app, { source, settings, session }) {
  const view = $("view");
  onKeys(null);

  // A brand-new quiz: find the key concepts first
  if (!session) {
    setTop({ title: source.title || "Quiz", crumb: "New quiz", back: () => app.goHome() });
    setActions(null);
    loading(view, "Reading the page and picking out the key ideas…", true);
    try {
      session = await QuizSession.create(source, settings);
    } catch (err) {
      return showError(app, err, () => runQuiz(app, { source, settings }));
    }
    if (app.screen !== "quiz") return; // left while it was loading
  }
  app.session = session;
  setTop({
    title: session.set.title,
    crumb: session.isReview ? "Review" : session.limit ? `${session.limit} questions` : "Endless quiz",
    back: () => endQuiz(app, session),
  });
  session.fill();
  nextQuestion(app, session);
}

function loading(view, label, concepts = false) {
  render(view, `
    <div class="card skeleton" aria-busy="true">
      <div class="sk" style="width:34%"></div>
      <div class="sk" style="width:92%;height:16px;margin-top:14px"></div>
      <div class="sk" style="width:70%;height:16px"></div>
      ${concepts ? "" : '<div class="sk opt-sk"></div><div class="sk opt-sk"></div><div class="sk opt-sk"></div>'}
      <div class="skeleton-label">${esc(label)}</div>
    </div>`);
}

function showError(app, err, retry) {
  const view = $("view");
  let msg = err?.message || "Something went wrong.";
  if (err instanceof GenerationError) msg = "Quizzer is having trouble writing good questions from this text. Try a smaller, more focused selection.";
  const keyIssue = err instanceof AIError && err.code === "key";
  render(view, `
    <div class="notice warn" role="alert">
      <span data-icon="alert"></span>
      <div>${esc(msg)}<br />
        <button class="btn sm" data-retry>Try again</button>
        ${keyIssue ? '<button class="btn sm ghost" data-settings>Open settings</button>' : ""}
      </div>
    </div>`);
  setActions(`<button class="btn ghost" data-home>Back to home</button>`).querySelector("[data-home]").onclick = () => app.goHome();
  view.querySelector("[data-retry]").onclick = retry;
  view.querySelector("[data-settings]")?.addEventListener("click", () => app.openSettings());
}

// ───────── Concept rail ─────────
function rail(session, q, done = false) {
  const n = session.answered + (done ? 0 : 1);
  const el = $("rail");
  if (session.isReview) {
    el.hidden = false;
    render(el, `
      <div class="rail-bars" aria-hidden="true"><div class="rail-bar" style="max-width:none"><i style="--m:${session.answered / session.limit}"></i></div></div>
      <div class="rail-meta"><span class="rail-count">${Math.min(n, session.limit)} / ${session.limit}</span><span class="rail-streak">Missed questions</span></div>`);
    el.querySelector(".rail-bar").style.height = "6px";
    return;
  }
  const concepts = session.set.concepts;
  const bars = concepts.map((c) => {
    const st = session.engine.concepts[c.id];
    const miss = session.lastResult[c.id] === false;
    return `<div class="rail-bar${q && q.conceptId === c.id ? " now" : ""}${miss ? " miss" : ""}" title="${esc(c.name)}: ${Math.round(st.mastery * 100)}% known"><i style="--m:${st.mastery}"></i></div>`;
  }).join("");
  const count = session.limit ? `${Math.min(n, session.limit)} / ${session.limit}` : `Q${n}`;
  const streak = session.streak >= 2 ? `${session.streak} in a row` : `${session.right} right`;
  el.hidden = false;
  render(el, `
    <div class="rail-bars" role="img" aria-label="How well you know each of ${concepts.length} key ideas">${bars}</div>
    <div class="rail-meta"><span class="rail-count">${count}</span><span class="rail-streak${session.streak >= 3 ? " hot" : ""}">${streak}</span></div>`);
}

// ───────── One question ─────────
async function nextQuestion(app, session) {
  const view = $("view");
  rail(session, null);
  if (session.finished) return showSummary(app, session);
  setActions(`<button class="btn ghost" data-end>End quiz</button><span class="spacer"></span><span class="hint">Writing a question…</span>`)
    .querySelector("[data-end]").onclick = () => endQuiz(app, session);
  loading(view, session.pending.length ? "Writing your next question…" : "Getting the next question…");

  let q;
  try {
    q = await session.next();
  } catch (err) {
    session.reset();
    return showError(app, err, () => { session.failsInRow = 0; session.fill(); nextQuestion(app, session); });
  }
  if (app.session !== session) return; // quiz was closed meanwhile
  if (!q) return showSummary(app, session);
  showQuestion(app, session, q);
}

function metaRow(session, q) {
  const pips = [1, 2, 3].map((n) => `<i class="${n <= (q.difficulty || 1) ? "on" : ""}"></i>`).join("");
  const level = ["", "Easy", "Medium", "Hard"][q.difficulty || 1];
  return `
    <div class="card-meta">
      <span class="concept">${esc(q.conceptName || "")}</span>
      <span class="sep"></span>
      <span>${TYPE_LABEL[q.type]}</span>
      <span class="pips" title="${level}" aria-label="${level}">${pips}</span>
      <div class="menu-anchor" style="margin-left:auto">
        <button class="icon-btn sm" data-qmenu data-icon="more" title="Question options" aria-label="Question options"></button>
        <div class="menu" hidden>
          ${session.isReview ? "" : '<button class="menu-item" data-bad><span data-icon="flag"></span>Bad question, skip it</button>'}
          <button class="menu-item" data-endq><span data-icon="stop"></span>End quiz</button>
        </div>
      </div>
    </div>`;
}

function showQuestion(app, session, q) {
  const view = $("view");
  rail(session, q);
  const isCard = q.type === "card";
  let body = "";
  if (q.type === "mc") {
    body = `<div class="options" role="group" aria-label="Answer choices">${q.options.map((o, i) => `
      <button class="opt" data-pick="${i}"><span class="key">${i + 1}</span><span class="opt-text">${esc(o)}</span><span class="mark"></span></button>`).join("")}</div>`;
  } else if (q.type === "tf") {
    body = `<div class="options tf" role="group" aria-label="True or false">
      <button class="opt" data-pick="true"><span class="key">T</span><span class="opt-text">True</span><span class="mark"></span></button>
      <button class="opt" data-pick="false"><span class="key">F</span><span class="opt-text">False</span><span class="mark"></span></button></div>`;
  } else if (q.type === "short") {
    body = `<label class="sr-only" for="answer">Your answer</label>
      <textarea id="answer" class="answer-box" placeholder="Type your answer in a sentence or two"></textarea>
      <div class="kbd-hint"><span class="kbd">⌘</span> <span class="kbd">Enter</span> to submit</div>`;
  } else {
    body = `<div class="flip">
      <div class="flip-inner">
        <button class="face front" data-flip aria-label="Flip card"><span class="face-label">Front</span><span class="face-text">${esc(q.prompt)}</span></button>
        <div class="face back" aria-hidden="true"><span class="face-label">Back</span><span class="face-text">${esc(q.answer)}</span></div>
      </div></div>`;
  }

  render(view, `
    <article class="card" aria-labelledby="qtext">
      ${metaRow(session, q)}
      ${isCard ? `<p class="sr-only" id="qtext">${esc(q.prompt)}</p>` : `<p class="prompt-text" id="qtext">${esc(q.prompt)}</p>`}
      ${body}
    </article>
    <div id="fb"></div>`);
  announce(`${TYPE_LABEL[q.type]}. ${q.prompt}`);
  view.scrollTop = 0;

  const state = { done: false, flipped: false };
  const card = view.querySelector(".card");

  // Menu: bad question / end quiz
  const menuBtn = view.querySelector("[data-qmenu]");
  menuBtn.onclick = (e) => { e.stopPropagation(); toggleMenu(menuBtn.nextElementSibling); };
  view.querySelector("[data-bad]")?.addEventListener("click", () => { session.skip(q); toast("Skipped. That one won't count."); nextQuestion(app, session); });
  view.querySelector("[data-endq]").onclick = () => endQuiz(app, session);

  const finish = async (result) => {
    if (state.done) return;
    state.done = true;
    card.classList.add(result.correct ? "right" : "wrong");
    announce(result.correct ? "Correct." : "Not quite.");
    session.answer(q, result).catch(() => toast("Couldn't save that answer.", { error: true }));
    rail(session, q, true);
    showFeedback(app, session, q, result);
  };

  // Choice questions
  const pick = (value) => {
    if (state.done) return;
    const opts = view.querySelector(".options");
    opts.classList.add("done");
    let correct, picked;
    if (q.type === "mc") {
      const i = Number(value);
      correct = i === q.answerIndex;
      picked = q.options[i];
      opts.children[q.answerIndex].classList.add("is-right");
      opts.children[i].classList.add("is-picked");
    } else {
      const v = value === "true";
      correct = v === q.answer;
      picked = v ? "True" : "False";
      opts.children[q.answer ? 0 : 1].classList.add("is-right");
      opts.children[v ? 0 : 1].classList.add("is-picked");
    }
    opts.querySelectorAll(".opt").forEach((o) => {
      const mark = o.querySelector(".mark");
      if (o.classList.contains("is-right")) mark.innerHTML = '<span data-icon="checkCircle"></span>';
      else if (o.classList.contains("is-picked")) mark.innerHTML = '<span data-icon="xCircle"></span>';
    });
    hydrateIcons(opts);
    finish({ correct, response: picked, picked });
  };
  view.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => pick(b.dataset.pick)));

  // Short answer
  const submitShort = async () => {
    const box = $("answer");
    const response = box.value.trim();
    if (!response || state.done || state.grading) return;
    state.grading = true;
    box.readOnly = true;
    setActions(`<span class="spacer"></span><span class="hint">Checking your answer…</span>`);
    render($("fb"), `<div class="feedback"><div class="why"><div class="sk" style="width:80%"></div><div class="sk" style="width:55%;margin-top:8px"></div></div></div>`);
    let grade = null;
    try {
      grade = await AI.grade({ question: q, response, passage: session.passageById(q.passageId, q) });
    } catch {}
    if (!grade) return selfGrade(response);
    finish({ correct: grade.score >= PASS, response, grade });
  };
  // If the AI can't grade, show the model answer and let you mark yourself
  const selfGrade = (response) => {
    render($("fb"), `
      <div class="feedback">
        <div class="why right-why"><h4>Model answer</h4><p>${esc(q.answer)}</p></div>
        <p class="muted" style="margin:8px 4px 0">The AI couldn't check this one. Compare and mark it yourself.</p>
      </div>`);
    const bar = setActions(`<button class="btn" data-self="0">I missed it</button><span class="spacer"></span><button class="btn primary" data-self="1">I got it</button>`);
    bar.querySelectorAll("[data-self]").forEach((b) => (b.onclick = () => {
      $("fb").innerHTML = "";
      finish({ correct: b.dataset.self === "1", response, selfGraded: true });
    }));
  };

  // Flashcards
  const flip = () => {
    if (!isCard || state.flipped) return;
    state.flipped = true;
    view.querySelector(".flip").classList.add("flipped");
    view.querySelector(".face.back").removeAttribute("aria-hidden");
    announce(`Back: ${q.answer}`);
    const bar = setActions(`<button class="btn" data-knew="0"><span data-icon="x"></span>Didn't know</button><span class="spacer"></span><button class="btn primary" data-knew="1"><span data-icon="check"></span>Knew it</button>`);
    bar.querySelector("[data-knew='1']").focus();
    bar.querySelectorAll("[data-knew]").forEach((b) => (b.onclick = () => finish({ correct: b.dataset.knew === "1", response: b.dataset.knew === "1" ? "knew it" : "didn't know" })));
  };
  view.querySelector("[data-flip]")?.addEventListener("click", flip);

  // Action bar before answering
  const end = `<button class="btn ghost" data-end>End quiz</button><span class="spacer"></span>`;
  let bar;
  if (q.type === "short") bar = setActions(`${end}<button class="btn primary" data-submit>Check answer</button>`);
  else if (isCard) bar = setActions(`${end}<button class="btn primary" data-flipbtn>Flip card</button>`);
  else bar = setActions(`${end}<span class="hint">${q.type === "mc" ? "Press 1 to 4" : "Press T or F"}</span>`);
  bar.querySelector("[data-end]").onclick = () => endQuiz(app, session);
  bar.querySelector("[data-submit]")?.addEventListener("click", submitShort);
  bar.querySelector("[data-flipbtn]")?.addEventListener("click", flip);
  if (q.type === "short") $("answer").focus();

  onKeys((e) => {
    if (app.screen !== "quiz" || document.querySelector(".sheet")) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.type === "short") { e.preventDefault(); return submitShort(); }
    if (typing(e)) return;
    if (state.done) {
      if (e.key === "Enter") { e.preventDefault(); $("actionbar").querySelector("[data-next]")?.click(); }
      return;
    }
    if (q.type === "mc" && /^[1-4]$/.test(e.key)) pick(Number(e.key) - 1);
    else if (q.type === "tf" && /^[tf]$/i.test(e.key)) pick(e.key.toLowerCase() === "t" ? "true" : "false");
    else if (isCard && e.key === " " && !state.flipped) { e.preventDefault(); flip(); }
    else if (isCard && state.flipped && (e.key === "1" || e.key === "2")) $("actionbar").querySelector(`[data-knew="${e.key === "2" ? 1 : 0}"]`)?.click();
  });
}

// ───────── After answering ─────────
function showFeedback(app, session, q, result) {
  const fb = $("fb");
  const passage = session.passageById(q.passageId, q);
  const { correct, grade } = result;
  const verdict = q.type === "card"
    ? (correct ? "Nice, you knew it" : "Marked to review")
    : q.type === "short"
      ? (correct ? "Correct" : grade && grade.score >= 0.4 ? "Partly right" : "Not quite")
      : (correct ? "Correct" : "Not quite");
  const sub = q.type === "short" && grade ? `${Math.round(grade.score * 100)}% match` : "";

  let why = "";
  if (q.type === "short" && grade) {
    why = `
      ${grade.feedback ? `<div class="why ${correct ? "right-why" : "wrong-why"}"><p>${esc(grade.feedback)}</p></div>` : ""}
      ${!correct && grade.missing ? `<div class="why wrong-why"><h4>What was missing</h4><p>${esc(grade.missing)}</p></div>` : ""}
      <div class="why right-why"><h4>Model answer</h4><p>${esc(q.answer)}</p></div>`;
  } else if (q.type === "short") {
    why = `<div class="why right-why"><h4>Model answer</h4><p>${esc(q.answer)}</p></div>`;
  } else if (q.type !== "card") {
    why = `<div class="why right-why"><h4>Why it's ${q.type === "tf" ? (q.answer ? "true" : "false") : "right"}</h4><p>${esc(q.rationale || "")}</p></div>
      ${correct ? "" : `<div class="why wrong-why" id="why-wrong"><h4>Why your answer isn't right</h4><div class="sk" style="width:85%"></div><div class="sk" style="width:60%;margin-top:6px"></div></div>`}`;
  } else if (q.rationale) {
    why = `<div class="why right-why"><p>${esc(q.rationale)}</p></div>`;
  }

  const canLocate = !!(q.url && passage);
  render(fb, `
    <div class="feedback">
      <p class="verdict ${correct ? "right" : "wrong"}"><span data-icon="${correct ? "checkCircle" : "xCircle"}"></span>${verdict}${sub ? `<span class="sub">${sub}</span>` : ""}</p>
      ${why}
      <div class="fb-actions">
        ${canLocate ? '<button class="chip lg" data-locate><span data-icon="locate"></span>Show in page</button>' : ""}
        <button class="chip lg" data-chat><span data-icon="chat"></span>Ask a follow-up</button>
      </div>
      <div id="chat-host"></div>
    </div>`);

  // Why the pick was wrong (loads after; the right-answer explanation shows instantly)
  if (!correct && (q.type === "mc" || q.type === "tf")) {
    AI.explainWrong({ question: q, picked: result.picked, passage })
      .then((text) => {
        const el = document.getElementById("why-wrong");
        if (!el) return;
        if (text) render(el, `<h4>Why your answer isn't right</h4><p>${esc(text)}</p>`);
        else el.remove();
      })
      .catch(() => document.getElementById("why-wrong")?.remove());
  }

  fb.querySelector("[data-locate]")?.addEventListener("click", () => showInPage(q, passage));
  const chatBtn = fb.querySelector("[data-chat]");
  chatBtn.onclick = () => {
    if (chatBtn.classList.contains("on")) return document.getElementById("chat-in")?.focus();
    chatBtn.classList.add("on");
    openChat(document.getElementById("chat-host"), { question: q, passage });
  };

  const last = session.limit && session.answered >= session.limit;
  const bar = setActions(`<button class="btn ghost" data-end>End quiz</button><span class="spacer"></span>
    <button class="btn primary" data-next>${last ? "See results" : "Next question"}<span data-icon="chevRight"></span></button>`);
  bar.querySelector("[data-end]").onclick = () => endQuiz(app, session);
  bar.querySelector("[data-next]").onclick = () => nextQuestion(app, session);
  bar.querySelector("[data-next]").focus({ preventScroll: true });
}

// Scroll the page to the passage and highlight it
async function showInPage(q, passage) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !sameDoc(tab.url, q.url)) {
    toast("This question came from another page.", { action: { label: "Open it", run: () => chrome.tabs.create({ url: q.url }) } });
    return;
  }
  const firstLine = (passage.text.split("\n")[0] || "").split(/\s+/);
  const needles = [q.quote, firstLine.slice(0, 12).join(" "), firstLine.slice(0, 7).join(" "), passage.text.split(/\s+/).slice(0, 8).join(" ")];
  const send = () => chrome.tabs.sendMessage(tab.id, { type: "show-passage", needles });
  let res;
  try {
    res = await send();
  } catch {
    // The page was open before Quizzer was installed: add the helper and try again
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/chip.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/page.css"] });
      res = await send();
    } catch {}
  }
  if (!res?.found) toast("Couldn't find that passage on the page. It may have changed.");
}

// ───────── End and summary ─────────
function endQuiz(app, session) {
  if (!session.answered) return app.goHome();
  showSummary(app, session);
}

function showSummary(app, session) {
  onKeys(null);
  session.reset();
  rail(session, null, true);
  const { answered, right, weakest } = session.summary();
  const pct = answered ? Math.round((right / answered) * 100) : 0;
  setTop({ title: session.set.title, crumb: "Results", back: () => app.goHome() });
  render($("view"), `
    <section class="summary">
      <div class="score"><b>${pct}%</b><span>${right} of ${answered} right</span></div>
      ${weakest.length ? `
        <ul class="weak" aria-label="Ideas to work on">
          ${weakest.map((w) => `<li><span class="name">${esc(w.name)}</span><span class="meter" title="${Math.round(w.mastery * 100)}% known"><i style="--m:${Math.round(w.mastery * 100)}%"></i></span></li>`).join("")}
        </ul>
        <p class="muted" style="margin:8px 0 0">Ideas you know least so far. Keep going and Quizzer will lean on these.</p>` : ""}
      <div class="summary-actions">
        ${session.isReview ? "" : '<button class="btn primary lg" data-more><span data-icon="refresh"></span>Keep going</button>'}
        <button class="btn lg" data-home>Done</button>
      </div>
    </section>`);
  setActions(null);
  $("view").querySelector("[data-home]").onclick = () => app.goHome();
  $("view").querySelector("[data-more]")?.addEventListener("click", () => {
    session.extend(session.set.settings.length || 10);
    if (!session.set.settings.length) session.limit = 0;
    setTop({ title: session.set.title, crumb: session.limit ? `${session.limit} questions` : "Endless quiz", back: () => endQuiz(app, session) });
    session.fill();
    nextQuestion(app, session);
  });
}
