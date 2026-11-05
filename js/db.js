// Local storage (IndexedDB). Everything stays on this computer, in the extension's
// private storage. Same pattern as Noted's db.js.
//   sets       one per quiz (a page or a selection)
//   questions  every question generated for a set
//   attempts   every answer you gave

const NAME = "quizzer";
const VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const sets = db.createObjectStore("sets", { keyPath: "id" });
      sets.createIndex("url", "url");
      const qs = db.createObjectStore("questions", { keyPath: "id" });
      qs.createIndex("setId", "setId");
      const at = db.createObjectStore("attempts", { keyPath: "id" });
      at.createIndex("setId", "setId");
      at.createIndex("questionId", "questionId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Run fn(store) inside one transaction and resolve with the last request's result
async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const all = (store) => tx(store, "readonly", (s) => s.getAll());
const byIndex = (store, index, key) => tx(store, "readonly", (s) => s.index(index).getAll(key));
const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));

export const DB = {
  putSet: (set) => put("sets", { ...set, updatedAt: Date.now() }),
  getSet: (id) => tx("sets", "readonly", (s) => s.get(id)),
  allSets: () => all("sets"),
  putQuestion: (q) => put("questions", q),
  questionsFor: (setId) => byIndex("questions", "setId", setId),
  putAttempt: (a) => put("attempts", a),
  attemptsFor: (setId) => byIndex("attempts", "setId", setId),
  allAttempts: () => all("attempts"),
  allQuestions: () => all("questions"),

  async deleteSet(id) {
    const [qs, ats] = await Promise.all([DB.questionsFor(id), DB.attemptsFor(id)]);
    await tx("questions", "readwrite", (s) => { qs.forEach((q) => s.delete(q.id)); });
    await tx("attempts", "readwrite", (s) => { ats.forEach((a) => s.delete(a.id)); });
    await tx("sets", "readwrite", (s) => s.delete(id));
  },

  async clearAll() {
    for (const store of ["sets", "questions", "attempts"]) await tx(store, "readwrite", (s) => s.clear());
  },

  // Questions whose most recent attempt was wrong: the "Review missed" deck
  async missed() {
    const [attempts, questions] = await Promise.all([DB.allAttempts(), DB.allQuestions()]);
    const latest = new Map();
    for (const a of attempts) {
      const prev = latest.get(a.questionId);
      if (!prev || a.at > prev.at) latest.set(a.questionId, a);
    }
    const byId = new Map(questions.map((q) => [q.id, q]));
    return [...latest.values()]
      .filter((a) => !a.correct && byId.has(a.questionId))
      .sort((a, b) => b.at - a.at)
      .map((a) => byId.get(a.questionId));
  },

  // Per-set stats for the home list: { [setId]: { answered, right } }
  async stats() {
    const out = {};
    for (const a of await DB.allAttempts()) {
      const s = (out[a.setId] ||= { answered: 0, right: 0 });
      s.answered++;
      if (a.correct) s.right++;
    }
    return out;
  },
};

// Simple settings store in chrome.storage.local
export const Settings = {
  async get(key, fallback) {
    const r = await chrome.storage.local.get(key);
    return r[key] ?? fallback;
  },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
};
