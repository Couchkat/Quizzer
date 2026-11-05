// The adaptive stream. Pure functions only: every call takes a state and returns a
// new one, so the whole thing can be tested without Chrome or an AI.
//
// Per concept we track:
//   mastery    0..1   how well you seem to know it
//   difficulty 1..3   level of the next question on it
//   streak            right answers in a row at this difficulty
//   reaskBy           turn number by which a missed concept must come back (or null)

export const TYPES = ["mc", "tf", "short", "card"];
const TYPE_WEIGHT = { mc: 0.4, tf: 0.2, short: 0.2, card: 0.2 };
const MASTERED_FLOOR = 0.15; // mastered concepts still show up now and then
const REASK_WITHIN = 3;      // a miss returns within this many questions

export function initState(conceptIds, startDifficulty = 1) {
  const concepts = {};
  for (const id of conceptIds) {
    concepts[id] = { mastery: 0, difficulty: startDifficulty, streak: 0, seen: 0, reaskBy: null };
  }
  return { concepts, turn: 0, lastRequested: null, lastType: null };
}

// Weighted random pick. `rand` is injectable so tests are deterministic.
function pickWeighted(items, weightOf, rand) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let r = rand() * total;
  for (const x of items) {
    r -= weightOf(x);
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

export function pickType(types, lastType, rand = Math.random) {
  const enabled = TYPES.filter((t) => types.includes(t));
  if (!enabled.length) throw new Error("No question types enabled");
  // Avoid the same type three times running by halving the last type's weight
  return pickWeighted(enabled, (t) => TYPE_WEIGHT[t] * (t === lastType && enabled.length > 1 ? 0.5 : 1), rand);
}

// What should the next question be about? Returns { request, state }.
export function nextRequest(state, { types }, rand = Math.random) {
  const ids = Object.keys(state.concepts);
  if (!ids.length) throw new Error("No concepts");
  const others = ids.length > 1 ? ids.filter((id) => id !== state.lastRequested) : ids;

  // 1. A missed concept that is due comes first (earliest deadline wins)
  const due = others
    .filter((id) => state.concepts[id].reaskBy != null)
    .sort((a, b) => state.concepts[a].reaskBy - state.concepts[b].reaskBy);

  let conceptId;
  if (due.length) conceptId = due[0];
  else conceptId = pickWeighted(others, (id) => 1 - state.concepts[id].mastery + MASTERED_FLOOR, rand);

  const c = state.concepts[conceptId];
  const type = pickType(types, state.lastType, rand);
  const request = { conceptId, type, difficulty: c.difficulty, reask: c.reaskBy != null };

  return {
    request,
    state: {
      ...state,
      lastRequested: conceptId,
      lastType: type,
      concepts: { ...state.concepts, [conceptId]: { ...c, reaskBy: null } },
    },
  };
}

// Record an answer. Returns the new state.
export function record(state, { conceptId, correct }) {
  const c = state.concepts[conceptId];
  if (!c) return { ...state, turn: state.turn + 1 };
  let next;
  if (correct) {
    const streak = c.streak + 1;
    const levelUp = streak >= 3 && c.difficulty < 3;
    next = {
      ...c,
      seen: c.seen + 1,
      mastery: c.mastery + (1 - c.mastery) * 0.25,
      streak: levelUp || streak >= 3 ? 0 : streak,
      difficulty: levelUp ? c.difficulty + 1 : c.difficulty,
    };
  } else {
    next = {
      ...c,
      seen: c.seen + 1,
      mastery: c.mastery * 0.65,
      streak: 0,
      difficulty: Math.max(1, c.difficulty - 1),
      reaskBy: state.turn + REASK_WITHIN,
    };
  }
  return { ...state, turn: state.turn + 1, concepts: { ...state.concepts, [conceptId]: next } };
}

// ── Duplicate detection ──
const STOP = new Set("a an the of to in on for and or is are was were be by with as at from that this which what why how does do did it its".split(" "));
export function words(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));
}
export function overlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
export function isNearDuplicate(prompt, recent, threshold = 0.8) {
  return recent.some((r) => overlap(prompt, r) >= threshold);
}

// Lowest-mastery concepts first (for the summary screen)
export function weakest(state, n = 3) {
  return Object.entries(state.concepts)
    .filter(([, c]) => c.seen > 0)
    .sort((a, b) => a[1].mastery - b[1].mastery)
    .slice(0, n)
    .map(([id, c]) => ({ id, mastery: c.mastery }));
}
