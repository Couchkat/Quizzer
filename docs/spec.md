# Quizzer — Design Spec

*2026-11-04 · Katrina Chen*

Quizzer is a Chrome side-panel extension that turns the page you're reading (or a passage you highlight) into an endless, adaptive quiz, with AI explanations for every answer. It's a sibling to **Noted**: same build approach, same design system, its own accent.

---

## 1. Decisions

| Area | Decision |
|---|---|
| Stack | Vanilla JS, Manifest V3, plain ES modules, no build step (same as Noted) |
| AI | Hybrid. Chrome's on-device Gemini Nano (Prompt API) by default; optional API key in Settings for higher-quality output |
| Question types | Multiple choice, True/False, Short answer (AI-graded), Flashcards |
| Infinite mode | Adaptive stream: always 2 questions pre-generated; targets missed concepts; difficulty ramps per concept |
| Entry points | Floating "Quiz me" chip on selection · right-click "Quiz me on this" · panel buttons (Whole page / Selection). No keyboard shortcut. |
| Persistence | Saved quiz sets per page/topic + a "Review missed" deck. Local only (IndexedDB). No streaks or stats dashboard. |
| Explanations | Why right / why wrong · Show in page (jump-to-source highlight) · Follow-up chat. No pre-answer hints. |
| Look | Noted's design system (Inter Tight, IBM Plex Mono, zinc neutrals, Auto/Light/Dark, radii, easing). New default palette **Lagoon** (`#0e7c86` light / `#4fc3cc` dark). Noted's 5 palettes stay selectable. |
| Platform | Chrome ≥ 138 (Nano). With an API key, works on Chrome ≥ 116. |

---

## 2. File layout

```
quizzer/
  manifest.json
  background.js          service worker: context menu, open panel, relay requests
  panel.html
  panel.css              Noted tokens + Lagoon palette + quiz components
  content/
    chip.js              floating "Quiz me" chip + jump-to-source highlight
    chip.css             injected into the chip's shadow root
  js/
    theme-boot.js        copied from Noted (key "quizzer:appearance")
    icons.js             copied from Noted, plus quiz icons
    panel.js             appearance, current tab, moving between screens
    ui.js                shared helpers (escaping, top bar, toasts)
    session.js           one running quiz: prefetch, answers, saving (no DOM)
    views/
      home.js            home screen
      setup.js           setup sheet
      quiz.js            rail, question card (all 4 types), feedback, summary
      chat.js            follow-up chat under a question
      paste.js           paste-text fallback for unreadable pages
      settings.js        AI source, API key, chip, data
    source.js            page/selection → numbered passages
    engine.js            adaptive queue (pure functions)
    db.js                IndexedDB: sets, questions, attempts
    ai/
      index.js           picks a provider; exposes the shared interface
      nano.js            Chrome Prompt API provider
      remote.js          API-key provider (Anthropic / OpenAI / Gemini)
      prompts.js         prompt text + JSON schemas
      parse.js           validate model output
  fonts/  icons/         copied from Noted
  tests/
    engine.test.js       engine, parse and passage tests (node or browser)
    engine.test.html     runs the same tests in Chrome
  docs/spec.md
```

Each module has one job and talks to the others only through the interfaces below.

---

## 3. Manifest & permissions

- `permissions`: `sidePanel`, `storage`, `unlimitedStorage`, `contextMenus`, `scripting`
- `host_permissions`: `<all_urls>`. Needed to read the page and to show the chip.
- No separate permission for API providers: `<all_urls>` already lets the panel call them.
- `content_scripts`: `content/chip.js` on `<all_urls>`, `run_at: document_idle`, all frames off.
- No `identity` or `oauth2`; Quizzer doesn't need Google sign-in.

---

## 4. Modules

### 4.1 `source.js`: turning content into passages
- `fromPage(tabId)` runs `chrome.scripting.executeScript` and pulls readable text from `<main>`/`<article>`/`body`. It skips `nav`, `header`, `footer`, `aside`, `script`, `style`, and hidden elements.
- `fromSelection(text, url, title)` is used for chip and context-menu requests.
- The text is split into **passages** of roughly 80–200 words, on paragraph boundaries. Each passage is `{ id: "p3", text }`.
- The total is capped at about 12k words. Longer pages keep the first 12k and show a notice in the setup sheet ("Long page: quizzing the first ~40 min of reading").
- Unreadable pages (chrome://, Web Store, PDFs, empty text) return `{ error: "unreadable" }`, and the UI offers a "Paste text instead" box.

### 4.2 `ai/`: one interface, two providers

```js
AI.status()                       → { provider: "nano"|"remote", ready, reason }
AI.concepts(passages)             → [{ id, name, passageIds[] }]          // once per set
AI.generate({ passages, concept, type, difficulty, avoid[] })
                                   → Question
AI.grade({ question, response })  → { correct: bool, score: 0..1, missing: string }
AI.explain({ question, response }) → { whyRight, whyWrong }
AI.chat({ question, history[], message }) → string (streamed)
```

- **Choosing a provider:** if a key is saved, use `remote`. Otherwise use `nano` if `LanguageModel.availability()` returns `"available"`. Otherwise `status()` returns `ready:false` and the UI shows setup.
- **nano.js** creates a short-lived `LanguageModel` session per call, sending only the passages that fit Nano's small context window (about 1,400 words). Long pages are read in batches for concept extraction. It calls `prompt()` with `responseConstraint` (a JSON schema) for structured calls, and `promptStreaming()` for chat. If the model is `"downloadable"`, the setup screen shows a "Download on-device model" button with progress (`monitor` → `downloadprogress`).
- **remote.js** makes a plain `fetch` to the chosen provider. It asks for JSON output in that provider's native way and streams chat replies. The key is stored in `chrome.storage.local` and never synced.
- **prompts.js** holds every prompt and schema in one place. Generation prompts require the answer to be supported by the passage, the `passageId` to be cited, and, for multiple choice, 3 wrong options that are plausible but clearly wrong.
- **parse.js** validates each `Question`. MC needs exactly 4 options, `answerIndex` between 0 and 3, and no duplicate options. T/F needs a boolean answer. Every type needs a non-empty prompt and a `passageId` that exists. If validation fails, it retries once with "Your last reply was invalid because …". A second failure means the question is skipped silently.

**Question shape**
```js
{
  id, setId, type: "mc"|"tf"|"short"|"card",
  conceptId, difficulty: 1|2|3, passageId,
  prompt,                 // card: front
  options?: string[4],    // mc
  answerIndex?: number,   // mc
  answer?: boolean|string,// tf: boolean; short: model answer; card: back
  rationale,              // short "why" used before full explain() call
  createdAt
}
```

### 4.3 `engine.js`: the adaptive stream (pure functions)

State per set: `concepts: { [id]: { mastery: 0..1, difficulty: 1..3, streak, seen, lastSeenAt } }` plus a `queue` of question requests.

- `nextRequest(state, settings)` returns `{ conceptId, type, difficulty }`.
  - **Due re-asks come first.** A concept missed within the last 3 questions gets a new, reworded question on that concept.
  - Otherwise the engine picks a weighted-random concept, weighted by `(1 - mastery) + 0.15` so mastered concepts still show up occasionally. It won't pick the same concept twice in a row.
  - The question type rotates through the enabled types, weighted toward multiple choice (MC 40%, T/F 20%, short answer 20%, flashcard 20%, renormalized to whatever is enabled).
- `record(state, { conceptId, correct })` returns the new state.
  - Correct: streak +1, mastery moves toward 1 by 0.25. At a streak of 3, difficulty goes up by 1 (max 3) and the streak resets.
  - Wrong: streak resets, mastery moves toward 0 by 0.35, difficulty goes down by 1 (min 1), and the concept is marked for a re-ask.
  - Flashcards count "Knew it" as correct and "Didn't" as wrong. Short-answer is correct when `score ≥ 0.7`.
- **Prefetch:** the panel keeps 2 generated questions ready. When you answer, it calls `nextRequest` and starts generating the next one in the background.
- **Dedup:** the last 30 prompts for the set are sent to the AI as `avoid[]`. A generated question is also dropped if its normalized prompt shares 80% or more of its words with a recent one.
- **Fixed count:** the same engine runs, but the stream stops after N questions.

### 4.4 `db.js`: IndexedDB `quizzer`, version 1

| Store | Key | Fields | Indexes |
|---|---|---|---|
| `sets` | `id` | `url, title, source: "page"\|"selection", passages[], concepts{}, engineState, settings, createdAt, updatedAt` | `url` |
| `questions` | `id` | Question shape above | `setId`, `conceptId` |
| `attempts` | `id` | `questionId, setId, correct, response, at` | `setId`, `questionId` |

- **Saved sets:** a set is auto-saved on its first answer. Home lists the sets for the current site's origin first, then everything else.
- **Review missed:** questions whose most recent attempt was wrong. Getting one right in review clears it. The review deck replays the saved questions rather than generating new ones, so it works offline and with no AI available.
- Delete set and Clear all live in Settings.

### 4.5 `content/chip.js`
- On `mouseup`/`keyup` with a selection of 15 or more words, a "Quiz me" chip appears 8px below the end of the selection. It lives in a shadow DOM, so page styles can't affect it.
- It hides on scroll, on Escape, when the selection collapses, or on click-away. There's a per-site "Don't show on this site" option in the chip's ⋯ menu.
- Clicking it sends `{ type: "quiz-selection", text, url, title }` to the background, which opens the panel.
- **Jump-to-source:** handles `{ type: "show-passage", text }`. It finds the passage text in the page (first 12 words, whitespace-normalized), scrolls it into view, and highlights it with the CSS Custom Highlight API (`::highlight(quizzer)`, teal at 30%) for 4 seconds. The page's HTML is never changed. If the text isn't found, the panel shows a toast saying it couldn't be located on the page.

### 4.6 `background.js`
- Context menu `"Quiz me on this"` (selection context).
- Toolbar click opens the side panel (`openPanelOnActionClick`).
- Chip and context-menu requests open the panel, then queue `pendingQuiz` in `chrome.storage.session`. The panel picks it up on load and on `storage.onChanged`, the same handoff Noted uses for clips.

---

## 5. Screens (panel)

All screens use Noted's components (`.btn`, `.chip`, `.icon-btn`, `.menu`, `.seg`) and tokens.

1. **Home**
   - Top bar: Quizzer wordmark, Settings, Appearance.
   - Two primary buttons: **Quiz this page** and **Quiz selection** (disabled with a tooltip when nothing is selected).
   - A **Review missed (n)** card, shown only when n > 0.
   - **Saved sets**, listed for this site first. Each row shows title, question count, and accuracy %.
2. **Setup sheet** (bottom sheet over Home)
   - Type chips (all on by default; at least one must stay on).
   - Starting difficulty: Easy / Medium / Hard.
   - Length: **Infinite** / 10 / 20.
   - A **Start** button. The last choices are remembered.
   - While concepts are being extracted, a short skeleton shows "Reading the page…".
3. **Question**
   - **Top strip:** question number, current streak, and a row of concept dots (fill shows mastery).
   - **Card:**
     - MC: 4 full-width option rows, keys 1–4
     - T/F: two large buttons, keys T/F
     - Short answer: textarea, Submit with ⌘↵
     - Flashcard: the card flips with Space or a click, then **Knew it** / **Didn't**
   - **⋯ menu:** "Bad question" skips it and records nothing; "End quiz".
   - **Loading:** if the prefetch queue is empty, a skeleton card shows. Generating usually takes 1–4 seconds on Nano.
4. **Feedback** (expands under the answered card)
   - The card edge turns teal for correct or `--danger` for wrong. The correct option is marked.
   - **Why it's right**, plus **Why yours isn't** on a miss. For short answers, this also covers what was missing.
   - Actions: **Show in page**, **Ask a follow-up**, and **Next →** (Enter).
   - **Follow-up chat:** a small thread under the card with streamed replies and a 6-message limit per question. It closes when you go to the next question.
5. **Summary** (after End quiz or the fixed count): accuracy, the 3 weakest concepts, and buttons for **Keep going**, **Review missed**, and **Done**.
6. **Settings**
   - AI source: On-device (shows status) / API key (provider + key + Test button).
   - Appearance (same control as Noted).
   - Chip on/off, plus a list of sites where it's hidden.
   - Data: delete sets, clear all.

**Motion:** follows Noted's easings. Cards slide in at 180ms, the answer feedback color shows for 120ms, the flashcard flip is 300ms, and everything respects `prefers-reduced-motion`.
**Accessibility:** everything works by keyboard. Feedback is announced through an `aria-live="polite"` region. Right/wrong is shown with an icon and a text label as well as color.

---

## 6. Error handling

| Situation | Behavior |
|---|---|
| Nano unavailable, no key | Setup card: "Download on-device model" (if downloadable) or "Add an API key" with a link to Settings |
| Page unreadable | "This page can't be read. Paste text instead" textarea |
| Invalid model output | One corrective retry, then skip silently; 3 skips in a row shows "Having trouble generating — try a smaller selection" |
| Remote API error (401 / 429 / network) | Inline banner with the specific cause; 401 links to Settings; no automatic fallback to Nano mid-quiz |
| Passage not found in page | Toast: "Couldn't find that passage on the page" |
| Very short content (< 60 words) | Allowed, but setup warns that questions may repeat; dedup threshold relaxes |

---

## 7. Testing

- **`tests/engine.test.html`** loads `engine.js` and `ai/parse.js` and runs plain assertions in the browser console. It covers mastery and difficulty changes, re-ask ordering, weighting never returning a disabled type, dedup, and the parse accept/reject cases.
- **Manual checklist** (in `README.md`):
  - Wikipedia article, a news page, a Canvas reading, and an unreadable page
  - Each of the 4 question types
  - Nano and API-key paths
  - Light and dark mode in each palette
  - Keyboard-only pass

---

## 8. Out of scope (v1)

Keyboard shortcut, pre-answer hints, streaks/stats dashboard, spaced-repetition scheduling, sync across devices, PDF support, exporting quizzes, Noted integration.
