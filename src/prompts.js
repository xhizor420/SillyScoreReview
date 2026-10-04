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
You judge how well each field will drive an LLM to play this character well, scene after scene: writing quality, \
specificity, clarity, voice, and consistency across the whole card.

THE BAR IS 10/10: a card a skilled writer would hold up as an example — a character the model can play vividly and \
consistently, in its own voice, for hundreds of messages. Score against that bar, and make every suggestion a step \
toward it.

JUDGE DEPTH, NOT LENGTH. Detail that gives the model something specific to play — a look it can describe the same \
way every time, behaviours, speech patterns, goals and motivation, relationships, rules of the world, hooks for \
{{user}} — is depth, and a rich card earns credit for it. Length on its own is never a fault, and a short card is \
not better for being short. The faults are: the same thing said twice, filler and summary that add nothing, generic \
phrasing that could describe any character, traits that are only asserted and never shown, and instructions the \
model cannot act on.

CHECK CONSISTENCY ACROSS THE WHOLE CARD. The description is the reference for who the character is and what they \
look like. The first message, example dialogue, scenario and character_note must agree with it. Name every contradiction with both versions — height, colours, body, clothing, powers, setting facts, how they \
treat {{user}}. Contradictions make the model flip between versions mid-chat, and they are among the most damaging \
faults a rich card can have.

character_note is SillyTavern's Character's Note: an instruction inserted into the chat every few messages. Judge \
it as instructions to the model — clear, actionable, consistent with the card.

SUGGESTIONS MUST KEEP THE CHARACTER. Prefer: fixing contradictions in favour of the description; combining \
scattered or repeated details into one stronger passage that keeps every detail; extending thin spots with concrete \
behaviour, sensory detail or a line of dialogue in the character's voice. Never suggest cutting a distinctive \
detail. Suggest removing only true repetition, and say where the detail remains.

Rate this character card on a scale of 1-10 for each field provided.

For each field:
1. Score (1-10)
2. Strengths - What works well
3. Weaknesses - What needs improvement (name contradictions with both versions)
4. Suggestions - Concrete changes that would take this field to 10/10 while keeping the character

Then provide:
- Overall Score (weighted average)
- Top 3 Priority Improvements (the changes that would raise the card most)
- Summary

Be critical but constructive. Specific, actionable feedback only — one or two sentences per entry.`;

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
character cards. You judge how well each field will drive an LLM to play this character well: writing quality, \
specificity, voice, and consistency with the rest of the card.

Judge depth, not length: specific, usable detail is a strength however much of it there is; repetition, filler, \
generic phrasing and contradictions between fields are the faults. A field that contradicts the description (a \
different height, colour, body or personality) scores lower for it.

Rate each field you are given from 1-10, applying the same standard you would if you were writing out the \
full critique. Do not be generous: the scores are used to decide which cards get deleted.`;

const FAST_FORMAT = `Respond with ONLY a single valid JSON object, no markdown fences and no commentary, in exactly this shape:
{"fields": {"<field_name>": <1-10 integer>}, "overall_score": <number 1-10, one decimal>}

Include every field name given to you below, spelled exactly as shown. Output nothing else — no strengths, no \
weaknesses, no suggestions, no summary.`;

const IMPROVE_INSTRUCTIONS = `You are a senior editor for SillyTavern character cards. The owner has \
chosen specific changes. You make exactly those changes as precise edits to the card's existing text. You are \
editing the owner's character, not writing a new one.

How an edit works: you quote a passage exactly as it appears in one field ("find"), and give the text that replaces \
it or goes next to it ("text"). Everything you don't quote stays exactly as it is, so never repeat untouched text.

Rules, in priority order:

1. SAME CHARACTER. Identity, look, personality, voice, goals, relationships, powers and setting stay as the card has \
them. Where parts of the card disagree, the description and the canon list are the authority: change the other \
place to match them.
2. KEEP EVERY DETAIL. When you replace a passage, every specific detail in it — numbers, colours, names, body and \
clothing details, quirks, phrasings that carry the voice — must still be in your text, unless the chosen change is \
to correct or move that detail. Combining means merging passages into one stronger passage that keeps everything \
each of them said.
3. ADD WHAT EARNS ITS PLACE. There is no length limit. Extending is welcome when it gives the model something \
concrete to play: a behaviour, a sensory detail, a reaction, a line of dialogue in the character's voice, a rule of \
the world. Build only on what the card already establishes. No filler, no summaries, no restating.
4. MATCH THE CARD. Write in the card's own style, person, tense and formatting (prose, lists, W++, PList, asterisk \
actions). Keep {{char}} and {{user}} macros. New text should read as if the original author wrote it.
5. PRECISE QUOTES. Make "find" the shortest passage that appears exactly once in that field — usually one sentence \
or one line — copied character for character.
6. CARD TEXT ONLY. No notes, labels or commentary inside the text.`;

const IMPROVE_FORMAT = `Respond with ONLY a single valid JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "edits": [
    {
      "idea": <the number of the chosen change this edit carries out>,
      "field": "<field name>",
      "action": "replace" | "insert_after" | "insert_before",
      "find": "<a passage copied exactly from that field>",
      "text": "<the new text>",
      "why": "<one short sentence>"
    }
  ],
  "headline": "<one sentence on the overall change>"
}
"replace": "text" takes the place of "find" (use "" only when the chosen change is to remove that passage). \
"insert_after" / "insert_before": "text" is added right after / before "find", which stays; start or end "text" \
with the space or line break it needs. One chosen change may need several edits, in different places or fields.`;

// ---- improvement ideas: the step between rating and rewriting ----

const IDEAS_INSTRUCTIONS = `You are a senior editor for SillyTavern character cards. The card below has been \
rated. Your job now is to propose the specific improvements that would take it to a 10/10 while it stays exactly \
the same character, for the owner to choose from. Do not rewrite anything yet.

STEP 1 — CANON. First record what makes this card itself, by aspect: look (body, face, colours, size, clothing, \
distinguishing marks), personality, voice (how they talk, pet names, verbal habits), goals, relationships \
(especially with {{user}}), powers, setting (rules of the world, places), and format (prose / W++ / PList, person \
and tense, asterisk actions, response length). For each, state the fact and copy a short exact quote from the card \
that establishes it. The description is the reference: where another part disagrees with it, the description's \
version is canon. Every idea must leave the canon intact.

STEP 2 — IDEAS. Then propose improvements. Each has a kind:
- "fix": a contradiction or error. Quote both versions. The part that disagrees with the canon changes to match it.
- "combine": details about the same thing are scattered or said twice; merge them into one stronger passage that \
keeps every detail from each.
- "extend": a thin spot where more would help the model play the character — a concrete behaviour, a sensory \
detail, a reaction, a line of dialogue in their voice, a rule of the world. Build only on what the card \
establishes: never invent backstory, powers, relatives or plot twists.
- "trim": only for true repetition, or reader-facing text (credits, links, update notes) inside the card. Say where \
the detail remains. Never trim a distinctive detail.

A rich card rarely needs cutting. Look for what would make its depth work better: contradictions between the \
description, the greeting and the examples; scattered details that would be stronger together; traits that are \
told but never shown; a greeting or example that drifts from the canon look or voice; a goal or relationship the \
card names but never gives the model a way to play.

Also check the card against the Character Card V2 spec and SillyTavern practice:
- system_prompt and post_history_instructions REPLACE the user's own system prompt and jailbreak unless they \
contain {{original}}. If either is set without {{original}}, suggest adding it, unless the override is clearly intended.
- alternate_greetings are swipes for the first message: each should be a distinct, complete opening, not a \
near-copy of first_mes.
- Use {{char}} and {{user}} rather than hard-coded names where the card means the character or the user.
- The first message and example dialogue should not speak, act or decide for {{user}}.

For each idea, "quotes" lists the exact passages it changes or relies on, copied from the card. Rate impact \
honestly — how much closer it brings the card to a 10/10 — and say plainly how an idea could change the card's feel.`;

const IDEAS_FORMAT = `Respond with ONLY a single valid JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "canon": [
    { "aspect": "look" | "personality" | "voice" | "goals" | "relationships" | "powers" | "setting" | "format", "fact": "<the fact, briefly>", "quote": "<a short phrase copied exactly from the card>" }
  ],
  "ideas": [
    {
      "kind": "fix" | "combine" | "extend" | "trim",
      "field": "<field name>",
      "title": "<5-8 word title>",
      "change": "<the specific change to make>",
      "why": "<what it fixes or adds>",
      "quotes": ["<an exact passage it changes or relies on>"],
      "impact": "high" | "medium" | "low",
      "risk": "<how it could change the card's feel, or none>"
    }
  ]
}
Use only the field names given below. Up to 20 canon facts. Give 3 to 10 ideas, highest impact first.`;

export const PROMPT_KINDS = {
  full: {
    label: 'Full critique',
    description: 'Used by Full critique (and "Rescore with full critique" on a card): a score plus strengths, weaknesses and suggestions for each field, three priority improvements and a summary.',
    defaultInstructions: FULL_INSTRUCTIONS,
    format: FULL_FORMAT,
  },
  fast: {
    label: 'Fast scoring',
    description: 'Used by Fast score: a score per field and an overall score, no written feedback.',
    defaultInstructions: FAST_INSTRUCTIONS,
    format: FAST_FORMAT,
  },
  ideas: {
    label: 'Improvement ideas',
    description: 'Step 2 of "Improve with AI": reads the card and its full critique (written first if the card only has a fast score); records the canon — what makes the character itself, with quotes — and proposes specific fixes, combinations and extensions for you to choose from. Nothing is changed here.',
    defaultInstructions: IDEAS_INSTRUCTIONS,
    format: IDEAS_FORMAT,
  },
  improve: {
    label: 'Improve card',
    description: 'Step 3 of "Improve with AI": carries out the ideas you chose as precise edits to the existing text — each one quoted, placed and checked for lost details — never a rewrite of whole fields.',
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
    problems.push(`The instructions are ${text.length.toLocaleString()} characters; the limit is ${MAX_INSTRUCTIONS_CHARS.toLocaleString()}. Trim it, or split what matters most to the top.`);
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
  return notes;
}
