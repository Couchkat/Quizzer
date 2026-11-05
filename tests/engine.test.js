// Tests for the adaptive engine and the model-output checks.
// Run either way:
//   node tests/engine.test.js
//   open tests/engine.test.html in Chrome and look at the console

import { initState, nextRequest, record, pickType, isNearDuplicate, weakest } from "../js/engine.js";
import { validateQuestion, shuffleOptions, extractJson, validateGrade } from "../js/ai/parse.js";
import { toPassages, textToPassages } from "../js/source.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
function eq(a, b, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg = "expected truthy") { if (!v) throw new Error(msg); }
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

console.log("engine");
test("starts every concept at the chosen difficulty", () => {
  const s = initState(["c1", "c2"], 2);
  eq(s.concepts.c1.difficulty, 2);
  eq(s.concepts.c2.mastery, 0);
});

test("three right in a row raises difficulty and resets the streak", () => {
  let s = initState(["c1"], 1);
  for (let i = 0; i < 3; i++) s = record(s, { conceptId: "c1", correct: true });
  eq(s.concepts.c1.difficulty, 2);
  eq(s.concepts.c1.streak, 0);
  ok(s.concepts.c1.mastery > 0.5, "mastery should rise");
});

test("difficulty never goes above 3 or below 1", () => {
  let s = initState(["c1"], 3);
  for (let i = 0; i < 6; i++) s = record(s, { conceptId: "c1", correct: true });
  eq(s.concepts.c1.difficulty, 3);
  s = initState(["c1"], 1);
  s = record(s, { conceptId: "c1", correct: false });
  eq(s.concepts.c1.difficulty, 1);
});

test("a miss lowers difficulty and lowers mastery", () => {
  let s = initState(["c1"], 2);
  s = record(s, { conceptId: "c1", correct: true });
  const before = s.concepts.c1.mastery;
  s = record(s, { conceptId: "c1", correct: false });
  eq(s.concepts.c1.difficulty, 1);
  ok(s.concepts.c1.mastery < before, "mastery should drop");
});

test("a missed concept comes back within 3 questions", () => {
  let s = initState(["c1", "c2", "c3", "c4"], 1);
  let r = nextRequest(s, { types: ["mc"] }, seq(0.01));
  s = record(r.state, { conceptId: r.request.conceptId, correct: false });
  const missed = r.request.conceptId;
  const next = [];
  for (let i = 0; i < 3; i++) {
    r = nextRequest(s, { types: ["mc"] }, seq(0.99));
    next.push(r.request.conceptId);
    s = r.state;
  }
  ok(next.includes(missed), `missed ${missed} not in ${next}`);
});

test("the re-ask is flagged and not the same concept twice in a row", () => {
  let s = initState(["c1", "c2"], 1);
  let r = nextRequest(s, { types: ["mc"] }, seq(0.01)); // c1
  s = record(r.state, { conceptId: r.request.conceptId, correct: false });
  r = nextRequest(s, { types: ["mc"] }, seq(0.01));
  ok(r.request.conceptId !== "c1", "should not repeat immediately");
  r = nextRequest(r.state, { types: ["mc"] }, seq(0.01));
  eq(r.request.conceptId, "c1");
  eq(r.request.reask, true);
});

test("low-mastery concepts are picked more often", () => {
  let s = initState(["c1", "c2"], 1);
  for (let i = 0; i < 8; i++) s = record(s, { conceptId: "c1", correct: true });
  s = { ...s, lastRequested: null };
  let c2 = 0;
  for (let i = 0; i < 400; i++) {
    const { request } = nextRequest({ ...s, lastRequested: null }, { types: ["mc"] });
    if (request.conceptId === "c2") c2++;
  }
  ok(c2 > 240, `c2 picked ${c2}/400`);
});

test("only enabled question types are ever picked", () => {
  for (let i = 0; i < 200; i++) {
    const t = pickType(["tf", "card"], "tf");
    ok(t === "tf" || t === "card", t);
  }
});

test("near-duplicate prompts are caught", () => {
  ok(isNearDuplicate("What is the main role of chlorophyll in plants?", ["What is chlorophyll's main role in plants"]));
  ok(!isNearDuplicate("Where does the Calvin cycle take place?", ["What is the main role of chlorophyll in plants?"]));
});

test("weakest lists seen concepts by lowest mastery", () => {
  let s = initState(["c1", "c2", "c3"], 1);
  s = record(s, { conceptId: "c1", correct: true });
  s = record(s, { conceptId: "c2", correct: false });
  eq(weakest(s).map((w) => w.id), ["c2", "c1"]);
});

console.log("parse");
const ids = ["p1", "p2"];
test("accepts a valid multiple-choice question", () => {
  const r = validateQuestion({ prompt: "Q?", options: ["a", "b", "c", "d"], answerIndex: 2, rationale: "r", passageId: "p1", quote: "x" }, "mc", ids);
  ok(r.ok, r.error);
});
test("rejects mc with 3 options, duplicates, or bad index", () => {
  ok(!validateQuestion({ prompt: "Q", options: ["a", "b", "c"], answerIndex: 0, passageId: "p1" }, "mc", ids).ok);
  ok(!validateQuestion({ prompt: "Q", options: ["a", "a", "c", "d"], answerIndex: 0, passageId: "p1" }, "mc", ids).ok);
  ok(!validateQuestion({ prompt: "Q", options: ["a", "b", "c", "d"], answerIndex: 4, passageId: "p1" }, "mc", ids).ok);
});
test("rejects an unknown passageId and an empty prompt", () => {
  ok(!validateQuestion({ prompt: "Q", answer: true, passageId: "p9" }, "tf", ids).ok);
  ok(!validateQuestion({ prompt: " ", answer: true, passageId: "p1" }, "tf", ids).ok);
});
test("accepts true/false given as a string", () => {
  const r = validateQuestion({ prompt: "S.", answer: "false", passageId: "p2" }, "tf", ids);
  ok(r.ok); eq(r.value.answer, false);
});
test("shuffling keeps the right answer attached", () => {
  const q = { type: "mc", options: ["right", "w1", "w2", "w3"], answerIndex: 0 };
  for (let i = 0; i < 20; i++) {
    const s = shuffleOptions(q);
    eq(s.options[s.answerIndex], "right");
  }
});
test("extracts JSON from fenced replies", () => {
  eq(extractJson('Sure!\n```json\n{"a": 1}\n```'), { a: 1 });
});
test("clamps grade scores", () => {
  eq(validateGrade({ score: 1.4, missing: "", feedback: "" }).value.score, 1);
});

console.log("source");
test("passages stay within size and keep ids in order", () => {
  const para = (n) => ({ text: Array(n).fill("word").join(" "), heading: false });
  const { passages } = toPassages([para(60), para(60), para(60), { text: "Heading", heading: true }, para(250), para(30)]);
  eq(passages.map((p) => p.id), passages.map((_, i) => `p${i + 1}`));
  ok(passages.every((p) => p.text.split(/\s+/).length <= 260), "a passage is too long");
});
test("pasted text becomes passages", () => {
  ok(textToPassages("One line.\n\nAnother line here.").passages.length >= 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (typeof process !== "undefined" && failed) process.exit(1);
