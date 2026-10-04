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
  "new_lorebook_entries": [
    { "keys": ["<word that should bring this up>", "<another>"], "content": "<the moved text, in the card's own words>" }
  ],
  "headline": "<one sentence on the overall change>"
}
Only fill "new_lorebook_entries" when a change you were asked to make moves detail out of a field into the lorebook; \
otherwise leave it as an empty list. Moved text keeps the card's own wording — it is relocated, not rewritten.`;

// ---- improvement ideas: the step between rating and rewriting ----

const IDEAS_INSTRUCTIONS = `You are a senior editor for SillyTavern character cards. The card below has been rated. Your \
job now is to propose specific improvements the owner can choose from. Do not rewrite anything yet.

First, identify what makes this card itself: its voice and speech patterns, quirks, formatting style (prose, \
W++, PList, asterisk actions, tense and point of view), signature lines, relationships and canon facts. These \
go in "keep", and every idea must leave them intact. In "keep_quotes", copy a few short phrases exactly as \
written in the card that carry its voice and must survive word for word.

Then propose improvements. A good idea is specific ("cut the second paragraph of description, which restates \
the personality list") rather than general ("make it more concise"), fixes a weakness the rating named, and \
never invents new backstory, powers, relatives or plot.

Also check the card against the Character Card V2 spec and SillyTavern practice:
- system_prompt and post_history_instructions REPLACE the user's own system prompt and jailbreak unless they \
contain {{original}}. If either is set without {{original}}, suggest adding it, unless the override is clearly intended.
- Credits, links, update notes or usage instructions aimed at the reader are not part of the character. Placed \
in description or another prompt field, they waste tokens and confuse the model; suggest removing them.
- alternate_greetings are swipes for the first message: each should be a distinct, complete opening, not a \
near-copy of first_mes.
- Use {{char}} and {{user}} rather than hard-coded names where the card means the character or the user.
- The first message and example dialogue should not speak, act or decide for {{user}}.
- Background that only matters in some scenes (side characters, places, history, item details) can move from \
an always-sent field into lorebook entries, which are only inserted when their keywords come up. Nothing is \
lost, and every turn costs fewer tokens. Mark these ideas "lorebook": true, with "field" set to the field the \
text moves out of. Only suggest this when the card supports a lorebook (stated below).

Rate each idea's impact on quality honestly, and say plainly how an idea could change the card's feel.`;

const IDEAS_FORMAT = `Respond with ONLY a single valid JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "keep": ["<one thing that makes this card itself and must survive any rewrite>"],
  "keep_quotes": ["<a short phrase copied exactly from the card>"],
  "ideas": [
    {
      "field": "<field_name>",
      "title": "<5-8 word title>",
      "change": "<the specific change to make>",
      "why": "<the weakness it fixes>",
      "impact": "high" | "medium" | "low",
      "risk": "<how it could change the card's feel, or none>",
      "lorebook": false
    }
  ]
}
Use only the field names given below. Give 3 to 8 ideas, highest impact first.`;

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
  ideas: {
    label: 'Improvement ideas',
    description: 'Step 1 of "Improve with AI": reads the card and its rating, lists what makes it itself (kept in any rewrite) and proposes specific changes for you to choose from. Nothing is rewritten here.',
    defaultInstructions: IDEAS_INSTRUCTIONS,
    format: IDEAS_FORMAT,
  },
  improve: {
    label: 'Improve card',
    description: 'Step 2 of "Improve with AI": rewrites only the fields your chosen ideas touch, keeping everything on the keep list.',
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
