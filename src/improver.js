import { SCORABLE_FIELDS, estimateTokens } from './cardParser.js';

/**
 * Rewriting a card is a different job from scoring one, and the failure modes
 * are worse: a rewrite can quietly turn someone else's character into a
 * different character, or pad a tight 700-token card into 4,000 tokens of
 * nothing. Both are explicitly forbidden below, and the length rule is also
 * checked in code afterwards (see measureFields) rather than merely requested.
 */
export const IMPROVE_SYSTEM_PROMPT = `You are a senior editor for SillyTavern character cards. You are given a \
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
inside the field text.

Only include a field in your response if you are actually improving it. Leave out anything already good.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "fields": {
    "<field_name>": { "text": "<the full rewritten field text>", "why": "<one short sentence on what you changed>" }
  },
  "headline": "<one sentence on the overall change>"
}`;

function critiqueFor(result, field) {
  const f = result?.fields?.[field];
  if (!f) return null;
  const bits = [];
  if (Number.isFinite(f.score)) bits.push(`scored ${f.score}/10`);
  if (f.weaknesses) bits.push(`weaknesses: ${f.weaknesses}`);
  if (f.suggestions) bits.push(`suggestions: ${f.suggestions}`);
  return bits.length ? bits.join('; ') : null;
}

/** The exact prompt pair an improve request sends, so tests and diagnostics can reuse it. */
export function buildImprovePrompts(card, result, { fields } = {}) {
  const wanted = fields?.length ? fields.filter((f) => SCORABLE_FIELDS.includes(f)) : SCORABLE_FIELDS;
  const parts = [`Character name: ${card.name}`, ''];

  if (result?.summary) parts.push(`Overall critique: ${result.summary}`, '');
  if (result?.top_priority_improvements?.length) {
    parts.push('Top priority improvements:', ...result.top_priority_improvements.map((p) => `- ${p}`), '');
  }

  const editable = [];
  for (const field of wanted) {
    const text = card.fields[field] || '';
    if (!text.trim()) continue;
    editable.push(field);
    const critique = critiqueFor(result, field);
    parts.push(`### ${field} (~${estimateTokens(text)} tokens — your rewrite must not exceed this)`);
    if (critique) parts.push(`Critique of this field: ${critique}`);
    parts.push(text.trim(), '');
  }

  if (!editable.length) throw new Error('Card has no non-empty fields to improve');

  parts.push(
    `Rewrite only the fields that need it, out of: ${editable.join(', ')}. ` +
      'Keep each rewrite within the token budget shown for that field.',
  );

  return { system: IMPROVE_SYSTEM_PROMPT, user: parts.join('\n'), editable };
}

function extractJsonBlock(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  return null;
}

function cleanFieldText(text) {
  let out = String(text ?? '');
  // Models sometimes wrap a long field in a fence despite being told not to.
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```\s*$/i);
  if (fence) out = fence[1];
  return out.replace(/\r\n/g, '\n').trim();
}

/**
 * Which {{...}} macros the original used and the rewrite has none of. Losing a
 * duplicate is fine editing; losing a macro entirely breaks how the card plugs
 * into SillyTavern, so that is the thing worth flagging.
 */
export function droppedMacros(before, after) {
  const dropped = [];
  for (const macro of ['user', 'char']) {
    const re = new RegExp(`\\{\\{${macro}\\}\\}`, 'g');
    if ((before.match(re) || []).length > 0 && (after.match(re) || []).length === 0) {
      dropped.push(`{{${macro}}}`);
    }
  }
  return dropped;
}

/**
 * Measures each proposed rewrite against the original and flags the two things
 * a rewrite most often gets wrong: silently ballooning the card, and dropping
 * the {{user}}/{{char}} macros that make it work in SillyTavern at all.
 */
export function measureFields(card, proposed) {
  const out = {};
  for (const [field, value] of Object.entries(proposed)) {
    const before = card.fields[field] || '';
    const after = value.text;
    const tokensBefore = estimateTokens(before);
    const tokensAfter = estimateTokens(after);
    out[field] = {
      text: after,
      why: value.why,
      tokensBefore,
      tokensAfter,
      // Only call it padding when the original had enough substance for the
      // rule to be meaningful; filling in a one-line field is allowed to grow.
      inflated: tokensBefore >= 40 && tokensAfter > Math.ceil(tokensBefore * 1.15),
      // Dropping a *repeated* macro is legitimate editing; dropping the last
      // one is not — the card stops addressing the user (or itself) at all.
      lostMacros: droppedMacros(before, after),
    };
  }
  return out;
}

/**
 * Asks the provider for an improved version of `card`, informed by its own
 * critique. Returns proposals only — nothing is written to disk here, so the
 * result can be reviewed and edited before it becomes a file.
 */
export async function improveCard(card, result, provider, { fields } = {}) {
  const { system, user } = buildImprovePrompts(card, result, { fields });

  // The output *is* the card, so the budget has to scale with the card: a 4k
  // token card cannot be rewritten inside a 3k token default.
  const cardTokens = SCORABLE_FIELDS.reduce((s, f) => s + estimateTokens(card.fields[f]), 0);
  const maxTokens = Math.min(16000, Math.max(3000, cardTokens * 2 + 1200));

  let raw = await provider.chat({ system, user, maxTokens });
  let parsed = extractJsonBlock(raw);

  if (!parsed || typeof parsed.fields !== 'object') {
    raw = await provider.chat({
      system,
      user: `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off). Respond again with ONLY the JSON object. If the card is long, improve fewer fields rather than \
returning a truncated response.`,
      maxTokens: Math.min(16000, maxTokens + 2000),
    });
    parsed = extractJsonBlock(raw);
  }

  if (!parsed || typeof parsed.fields !== 'object') {
    throw new Error('Model did not return a parseable improvement after retry');
  }

  const proposed = {};
  for (const [field, value] of Object.entries(parsed.fields)) {
    if (!SCORABLE_FIELDS.includes(field)) continue;
    const text = cleanFieldText(value?.text ?? value);
    if (!text) continue;
    // A field returned unchanged is noise in the review UI.
    if (text === (card.fields[field] || '').trim()) continue;
    proposed[field] = { text, why: String(value?.why || '').trim() };
  }

  if (!Object.keys(proposed).length) {
    throw new Error('The model returned no actual changes — the card may already be in good shape');
  }

  return {
    fields: measureFields(card, proposed),
    headline: String(parsed.headline || '').trim(),
    model: provider.model,
    provider: provider.name,
  };
}
