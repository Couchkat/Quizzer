// One running quiz. Holds the engine state, keeps two questions generated ahead,
// and saves answers to IndexedDB. No DOM code in here.

import { AI } from "./ai/index.js";
import { DB } from "./db.js";
import { initState, nextRequest, record, isNearDuplicate, weakest } from "./engine.js";

const AHEAD = 2;
const DIFF = { easy: 1, medium: 2, hard: 3 };

export class GenerationError extends Error {}

export class QuizSession {
  // settings: { types: [...], level: "easy"|"medium"|"hard", length: 0 (infinite) | 10 | 20 }
  constructor(set, { review = null } = {}) {
    this.set = set;
    this.review = review; // array of saved questions, for "Review missed"
    this.engine = set.engineState;
    this.pending = [];
    this.recent = [];
    this.answered = 0;
    this.right = 0;
    this.streak = 0;
    this.lastResult = {}; // conceptId → true/false, for the rail
    this.saved = !!set.savedAt;
    this.failsInRow = 0;
    this.limit = set.settings.length || 0;
  }

  // New quiz from passages. Extracting concepts is the slow first step.
  static async create({ kind, url, title, passages }, settings) {
    const concepts = await AI.concepts(passages);
    const set = {
      id: crypto.randomUUID(),
      kind, url, title: title || "Untitled",
      passages, concepts,
      settings,
      engineState: initState(concepts.map((c) => c.id), DIFF[settings.level] || 1),
      createdAt: Date.now(),
      savedAt: null,
    };
    return new QuizSession(set);
  }

  // Keep going on a saved set
  static async resume(setId, settings) {
    const set = await DB.getSet(setId);
    if (!set) throw new Error("That quiz was deleted.");
    if (settings) set.settings = settings;
    const s = new QuizSession(set);
    const qs = await DB.questionsFor(setId);
    s.recent = qs.sort((a, b) => a.createdAt - b.createdAt).map((q) => q.prompt).slice(-30);
    return s;
  }

  static review(questions) {
    const set = { id: "review", title: "Review missed", concepts: [], passages: [], settings: { types: [], length: questions.length }, engineState: initState([]) };
    const s = new QuizSession(set, { review: [...questions] });
    s.limit = questions.length;
    return s;
  }

  get isReview() { return !!this.review; }
  conceptById(id) { return this.set.concepts.find((c) => c.id === id); }
  passageById(id, q) {
    const list = q?.passageText ? [{ id: q.passageId, text: q.passageText }] : this.set.passages;
    return list.find((p) => p.id === id);
  }

  // How many more questions may be produced (fixed-length quizzes)
  get budgetLeft() {
    return this.limit ? this.limit - this.answered - this.pending.length : Infinity;
  }
  get finished() { return !!this.limit && this.answered >= this.limit; }

  fill() {
    if (this.isReview) return;
    while (this.pending.length < AHEAD && this.budgetLeft > 0) {
      const p = this.produce();
      p.catch(() => {}); // handled when it's awaited in next()
      this.pending.push(p);
    }
  }

  async produce() {
    for (let tries = 0; tries < 3; tries++) {
      const { request, state } = nextRequest(this.engine, { types: this.set.settings.types });
      this.engine = state;
      const concept = this.conceptById(request.conceptId);
      const q = await AI.generate({
        passages: this.set.passages,
        concept,
        type: request.type,
        difficulty: request.difficulty,
        avoid: this.recent,
      });
      if (!q || isNearDuplicate(q.prompt, this.recent, this.set.passages.length < 3 ? 0.9 : 0.8)) continue;
      this.recent.push(q.prompt);
      const passage = this.set.passages.find((p) => p.id === q.passageId);
      return {
        ...q,
        id: crypto.randomUUID(),
        setId: this.set.id,
        conceptId: concept.id,
        conceptName: concept.name,
        difficulty: request.difficulty,
        passageText: passage?.text || "",
        url: this.set.url,
        createdAt: Date.now(),
      };
    }
    throw new GenerationError("Couldn't write a good question");
  }

  // Next question (waits for it if it isn't ready). Returns null when the quiz is over.
  async next() {
    if (this.isReview) return this.review.shift() || null;
    if (this.finished) return null;
    if (!this.pending.length) this.fill();
    if (!this.pending.length) return null;
    const p = this.pending.shift();
    this.fill();
    try {
      const q = await p;
      this.failsInRow = 0;
      return q;
    } catch (e) {
      if (e instanceof GenerationError) {
        this.failsInRow++;
        if (this.failsInRow >= 3) throw e;
        return this.next();
      }
      throw e; // AIError: key, rate limit, network
    }
  }

  // Throw away prefetched questions (after a "Bad question" or an error)
  reset() { this.pending = []; }

  async answer(q, { correct, response }) {
    this.answered++;
    if (correct) { this.right++; this.streak++; } else this.streak = 0;
    this.lastResult[q.conceptId] = correct;

    if (!this.isReview) {
      this.engine = record(this.engine, { conceptId: q.conceptId, correct });
      this.set.engineState = this.engine;
      if (!this.saved) { this.set.savedAt = Date.now(); this.saved = true; }
      await DB.putSet(this.set);
    }
    await DB.putQuestion(q);
    await DB.putAttempt({ id: crypto.randomUUID(), questionId: q.id, setId: q.setId, correct, response: String(response ?? ""), at: Date.now() });
  }

  // Bad question: drop it without counting it
  skip(q) {
    this.recent.push(q.prompt);
  }

  // Fixed-length quiz → let it run 10 more
  extend(n = 10) { this.limit = this.limit ? this.answered + n : 0; }

  summary() {
    return {
      answered: this.answered,
      right: this.right,
      weakest: this.isReview ? [] : weakest(this.engine).map((w) => ({ ...w, name: this.conceptById(w.id)?.name || "" })),
    };
  }
}
