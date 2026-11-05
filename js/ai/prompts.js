// Every prompt and JSON schema in one place. Each builder returns
// { system, user, schema } so both providers (on-device and API key) send the same thing.

const SYSTEM = `You write study questions for a student reading a web page.
Rules:
- Use only facts stated in, or clearly implied by, the passages you are given.
- Be precise. Use plain, student-friendly language.
- Never mention "the passage" or "the text" in a question; ask about the subject itself.
- Reply with JSON only.`;

const DIFFICULTY = {
  1: "Easy: recall one fact the passage states directly.",
  2: "Medium: explain a relationship, cause, contrast, or process the passage describes.",
  3: "Hard: apply the idea to a new example, or draw an inference the passage supports.",
};

const TYPE_RULES = {
  mc: `Multiple choice. "options" has exactly 4 answer choices of similar length; "answerIndex" is the index (0-3) of the one correct choice. The 3 wrong choices must sound plausible to someone who skimmed, but be clearly wrong given the passage. No "all/none of the above".`,
  tf: `True/false. "prompt" is one declarative statement (not a question). Make it false about half the time by changing one key detail. "answer" is true or false.`,
  short: `Short answer. "prompt" is a question answerable in 1-2 sentences. "answer" is a model answer in 1-2 sentences.`,
  card: `Flashcard. "prompt" is the front: a key term or a very short question. "answer" is the back: a 1-2 sentence definition or answer.`,
};

const str = { type: "string" };

function questionSchema(type, passageIds) {
  const props = {
    prompt: str,
    rationale: str,
    passageId: { type: "string", enum: passageIds },
    quote: str,
  };
  if (type === "mc") {
    props.options = { type: "array", items: str, minItems: 4, maxItems: 4 };
    props.answerIndex = { type: "integer", minimum: 0, maximum: 3 };
  } else if (type === "tf") {
    props.answer = { type: "boolean" };
  } else {
    props.answer = str;
  }
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
}

const passageBlock = (passages) => passages.map((p) => `[${p.id}]\n${p.text}`).join("\n\n");

export function conceptsPrompt(passages, max = 10) {
  return {
    system: SYSTEM,
    user: `Passages:\n\n${passageBlock(passages)}\n\nList the ${Math.min(4, max)}-${max} most important concepts a student should learn from these passages. For each, give a short name (2-6 words) and the ids of the passages that cover it.`,
    schema: {
      type: "object",
      properties: {
        concepts: {
          type: "array",
          maxItems: max,
          items: {
            type: "object",
            properties: { name: str, passageIds: { type: "array", items: { type: "string", enum: passages.map((p) => p.id) }, minItems: 1 } },
            required: ["name", "passageIds"],
            additionalProperties: false,
          },
        },
      },
      required: ["concepts"],
      additionalProperties: false,
    },
  };
}

export function questionPrompt({ passages, concept, type, difficulty, avoid = [] }) {
  const avoidText = avoid.length ? `\n\nDo not repeat or closely reword any of these earlier questions:\n${avoid.map((a) => `- ${a}`).join("\n")}` : "";
  return {
    system: SYSTEM,
    user: `Passages:\n\n${passageBlock(passages)}\n\nWrite ONE question about the concept "${concept}".
Level: ${DIFFICULTY[difficulty] || DIFFICULTY[1]}
Format: ${TYPE_RULES[type]}
"rationale": 1-2 sentences explaining why the correct answer is correct.
"passageId": the id of the passage that supports the answer.
"quote": 5-15 words copied exactly from that passage that support the answer.${avoidText}`,
    schema: questionSchema(type, passages.map((p) => p.id)),
  };
}

export function gradePrompt({ question, response, passage }) {
  return {
    system: SYSTEM,
    user: `Passage:\n${passage?.text || ""}\n\nQuestion: ${question.prompt}\nModel answer: ${question.answer}\nStudent answer: ${response}\n\nGrade the student's answer on meaning, not wording. "score" is 0 to 1 (1 = fully correct, 0.7 = correct but missing a minor detail, 0.4 = partly correct, 0 = wrong or blank). "missing": what is missing or wrong, in one sentence, or "" if nothing. "feedback": 1-2 sentences to the student, starting with what they got right if anything.`,
    schema: {
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 1 }, missing: str, feedback: str },
      required: ["score", "missing", "feedback"],
      additionalProperties: false,
    },
  };
}

export function explainWrongPrompt({ question, picked, passage }) {
  const right = question.type === "mc" ? question.options[question.answerIndex] : String(question.answer);
  return {
    system: SYSTEM,
    user: `Passage:\n${passage?.text || ""}\n\nQuestion: ${question.prompt}\nCorrect answer: ${right}\nStudent chose: ${picked}\n\nIn 1-2 sentences, explain to the student why their choice is wrong. Name the specific detail they likely mixed up. Don't repeat the full correct explanation.`,
    schema: { type: "object", properties: { whyWrong: str }, required: ["whyWrong"], additionalProperties: false },
  };
}

export function chatSystem({ question, passage }) {
  const right = question.type === "mc" ? question.options[question.answerIndex] : String(question.answer);
  return `You are a patient tutor helping a student understand one quiz question.
Passage the question came from:
${passage?.text || ""}

Question: ${question.prompt}
Correct answer: ${right}
Why: ${question.rationale || ""}

Answer the student's follow-up questions in under 120 words, in plain language. Ground answers in the passage; if you add general knowledge beyond it, say so briefly. Do not use markdown headings.`;
}
