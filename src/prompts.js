import { createHash } from 'node:crypto';

/**
 * The prompts sent to the model, split in two:
 *
 * - **instructions** — what to judge and how. This is yours to change: a
 *   different rubric, stricter or kinder grading, a genre focus, another
 *   language for the feedback. Edits are saved to config.json (`prompts`).
 *
 * - **format** — the exact response shape the code parses. Never editable,
 *   always appended. If a free edit could change it, one stray word would make
 *   every card in a 3,000-card scan fail to parse, so it is locked and shown
 *   read-only instead.
 *
 * The defaults below are the prompts this tool has always sent; composing the
 * default instructions with the format reproduces them exactly.
 */

const FULL_INSTRUCTIONS = `You are a critical, experienced editor for SillyTavern-style AI roleplay character cards. \
You review card fields for writing quality, clarity, internal consistency, and how well they will actually \
drive an LLM to roleplay the character well — not for raw length. A short, sharp card can outscore a long, \
padded one; call out padding, redundancy, and vague generic writing as weaknesses wherever you see them.

Rate this character card on a scale of 1-10 for each field provided.

For each field:
1. Score (1-10)
2. Strengths - What works well
3. Weaknesses - What needs improvement
4. Suggestions - Concrete changes

Then provide:
- Overall Score (weighted average)
- Top 3 Priority Improvements
- Summary

Be critical but constructive. Specific, actionable feedback only. Keep each strengths/weaknesses/suggestions \
entry to one short sentence (max ~20 words) — this is a fast triage pass across a large card collection, not \
a full editorial letter, and a long response risks being cut off before it's valid JSON.`;

const FULL_FORMAT = `Respond with ONLY a single valid JSON object (no markdown fences, no commentary before or after) matching \
exactly this shape:
{
  "fields": {
    "<field_name>": { "score": <1-10 integer>, "strengths": "<string>", "weaknesses": "<string>", "suggestions": "<string>" }
  },
  "overall_score": <number 1-10, one decimal>,
  "top_priority_improvements": ["<string>", "<string>", "<string>"],
  "summary": "<2-4 sentence summary>"
}
Include an entry in "fields" for every field given to you below, using the exact field name shown.`;

const FAST_INSTRUCTIONS = `You are a critical, experienced editor for SillyTavern-style AI roleplay \
character cards. You judge writing quality, clarity, internal consistency, and how well a field will actually \
drive an LLM to roleplay the character well — never length. A short, sharp card outscores a long padded one; \
treat padding, redundancy and vague generic writing as faults.

Rate each field you are given from 1-10, applying the same standard you would if you were writing out the \
full critique. Do not be generous: the scores are used to decide which cards get deleted.`;

const FAST_FORMAT = `Respond with ONLY a single valid JSON object, no markdown fences and no commentary, in exactly this shape:
{"fields": {"<field_name>": <1-10 integer>}, "overall_score": <number 1-10, one decimal>}

Include every field name given to you below, spelled exactly as shown. Output nothing else — no strengths, no \
weaknesses, no suggestions, no summary.`;

const IMPROVE_INSTRUCTIONS = `You are a senior editor for SillyTavern character cards. You are given a \
card, a critique of it, and you return an edited version of the fields that need work.

You are EDITING, not inventing. Hard rules, in priority order:

1. SAME CHARACTER. Keep the name, identity, personality core, speech register, setting, relationships, body, \
age and canon exactly as they are. Never add a new backstory element, power, relative or plot twist that is \
not already implied by the card. If a weakness can only be fixed by inventing facts, make the writing sharper \
instead and leave the facts alone.
2. DO NOT PAD. Quality per token is the whole point. Every rewritten field must be the SAME LENGTH OR SHORTER \
than the original — cut filler, redundancy, restated traits and purple prose to make room for anything you add. \
The only exception is a field that is empty or nearly empty, which may be filled in compactly. A longer card \
is a worse card.
3. FIX WHAT THE CRITIQUE NAMED. Address the specific weaknesses and suggestions given for that field. Vague, \
generic writing becomes concrete and specific; contradictions get resolved; traits that are asserted get shown \
in behaviour instead.
4. KEEP THE FORMAT. Preserve {{char}} and {{user}} macros exactly. Keep mes_example in its <START> / \
"{{user}}:" / "{{char}}:" turn format. Keep first_mes in the card's own narrative person, tense and formatting \
style (asterisk actions, quotes, prose) — match what is already there.
5. CARD TEXT ONLY. No notes to the reader, no headings you invented, no "Improved:" labels, no commentary \
inside the field text.`;

const IMPROVE_FORMAT = `Only include a field in your response if you are actually improving it. Leave out anything already good.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "fields": {
    "<field_name>": { "text": "<the full rewritten field text>", "why": "<one short sentence on what you changed>" }
  },
  "headline": "<one sentence on the overall change>"
}`;

export const PROMPT_KINDS = {
  full: {
    label: 'Full critique',
    description: 'Used for full scoring: a score plus strengths, weaknesses and suggestions for each field, three priority improvements and a summary.',
    defaultInstructions: FULL_INSTRUCTIONS,
    format: FULL_FORMAT,
  },
  fast: {
    label: 'Fast scoring',
    description: 'Used when Scoring detail is set to Fast: a score per field and an overall score, no written feedback.',
    defaultInstructions: FAST_INSTRUCTIONS,
    format: FAST_FORMAT,
  },
  improve: {
    label: 'Improve card',
    description: 'Used by "Improve with AI": rewrites the weak fields of a card using its own critique.',
    defaultInstructions: IMPROVE_INSTRUCTIONS,
    format: IMPROVE_FORMAT,
  },
};

export const MAX_INSTRUCTIONS_CHARS = 20_000;

/** Joins instructions and the locked format into the system prompt that is actually sent. */
function compose(instructions, format) {
  return `${instructions.trim()}\n\n${format}`;
}

/** The instructions in effect for `kind`: your saved edit if there is one, otherwise the default. */
export function instructionsFor(kind, overrides = {}) {
  const def = PROMPT_KINDS[kind];
  if (!def) throw new Error(`Unknown prompt "${kind}"`);
  const custom = overrides?.[kind];
  return typeof custom === 'string' && custom.trim() ? custom : def.defaultInstructions;
}

/** The complete system prompt for `kind`, optionally with unsaved instructions (for previews and tests). */
export function systemPrompt(kind, overrides = {}, draftInstructions = null) {
  const instructions = typeof draftInstructions === 'string' && draftInstructions.trim()
    ? draftInstructions
    : instructionsFor(kind, overrides);
  return compose(instructions, PROMPT_KINDS[kind].format);
}

/** The prompt each kind sends when nothing has been customised. */
export const DEFAULT_PROMPTS = Object.fromEntries(
  Object.entries(PROMPT_KINDS).map(([kind, def]) => [kind, compose(def.defaultInstructions, def.format)]),
);

/**
 * Short fingerprint of a system prompt. Stored on every score, so after you
 * change a prompt the dashboard can tell which cards were judged by the old
 * one — and you can rescore just those, rather than all or nothing.
 */
export function promptHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

/**
 * Checks an edit before it is saved. Returns a list of problems (empty = fine).
 * Nothing here can break parsing — the format is appended regardless — these
 * catch edits that would quietly make the results worse or the run fail.
 */
export function validateInstructions(kind, text) {
  const problems = [];
  if (!PROMPT_KINDS[kind]) problems.push(`Unknown prompt "${kind}".`);
  if (typeof text !== 'string' || !text.trim()) problems.push('The instructions are empty. Use "Reset to default" instead of clearing them.');
  if (typeof text === 'string' && text.length > MAX_INSTRUCTIONS_CHARS) {
    problems.push(`The instructions are ${text.length.toLocaleString()} characters; the limit is ${MAX_INSTRUCTIONS_CHARS.toLocaleString()}. Every card pays for this length in every request.`);
  }
  return problems;
}

/**
 * Advice rather than errors: things that are allowed but probably not meant.
 * Shown under the editor while you type.
 */
export function adviseInstructions(kind, text) {
  const notes = [];
  if (typeof text !== 'string') return notes;
  if (/```|"fields"\s*:|overall_score/.test(text)) {
    notes.push('These instructions describe a JSON response. You do not need to — the response format below is always added automatically, and two conflicting formats can confuse the model.');
  }
  if (kind === 'fast' && /strength|weakness|suggestion|summary|explain/i.test(text)) {
    notes.push('Fast scoring never returns written feedback, so instructions about strengths, weaknesses or summaries will be ignored (and only slow it down).');
  }
  // "Do not be generous" is the opposite of lenient — only flag the word when
  // it is not negated, or the built-in strict prompt warns about itself.
  const leniency = /\b(?<!(?:not|never|n't)\s+(?:be\s+)?)(lenient|generous|be kind|go easy)\b/i;
  if (kind !== 'improve' && leniency.test(text)) {
    notes.push('Lenient grading compresses scores toward the top, which makes it harder to tell which cards to delete.');
  }
  if (text.length > 6000) {
    notes.push(`At ${text.length.toLocaleString()} characters, these instructions are sent with every card. Over a 3,000-card scan that adds up in time and cost.`);
  }
  return notes;
}
