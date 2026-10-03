import { SCORABLE_FIELDS, estimateTokens } from './cardParser.js';
import { DEFAULT_PROMPTS, systemPrompt } from './prompts.js';
import { extractJsonObject } from './jsonExtract.js';
import { ask, unusableAnswerError } from './scorer.js';

/**
 * Rewriting a card is a different job from scoring one, and the failure modes
 * are worse: a rewrite can quietly turn someone else's character into a
 * different character, or pad a tight 700-token card into 4,000 tokens of
 * nothing. Both are explicitly forbidden below, and the length rule is also
 * checked in code afterwards (see measureFields) rather than merely requested.
 */
// Kept for anything that imports it; the editable source is prompts.js.
export const IMPROVE_SYSTEM_PROMPT = DEFAULT_PROMPTS.improve;

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
export function buildImprovePrompts(card, result, { fields, prompts = {}, draftInstructions = null, plan = null } = {}) {
  // With a plan, only the fields the chosen ideas touch are sent at all — the
  // strongest guarantee that the rest of the card comes back untouched.
  const planFields = plan?.ideas?.length ? [...new Set(plan.ideas.map((i) => i.field))] : null;
  const pool = planFields || (fields?.length ? fields : SCORABLE_FIELDS);
  const wanted = pool.filter((f) => SCORABLE_FIELDS.includes(f));
  const parts = [`Character name: ${card.name}`, ''];

  if (result?.summary) parts.push(`Overall critique: ${result.summary}`, '');
  if (result?.top_priority_improvements?.length) {
    parts.push('Top priority improvements:', ...result.top_priority_improvements.map((p) => `- ${p}`), '');
  }

  if (plan?.ideas?.length) {
    parts.push('The owner chose these changes. Apply ONLY these, and change nothing else:');
    plan.ideas.forEach((idea, i) => {
      parts.push(`${i + 1}. [${idea.field}] ${idea.title} — ${idea.change}${idea.why ? ` (Fixes: ${idea.why})` : ''}` +
        `${idea.lorebook ? ' (Move this detail into new lorebook entries, in the card\'s own words.)' : ''}`);
    });
    parts.push('');
    if (plan.keep?.length) {
      parts.push('Must keep — what makes this card itself. Do not alter any of it:', ...plan.keep.map((k) => `- ${k}`), '');
    }
    if (plan.keepQuotes?.length) {
      parts.push('Must survive word for word, wherever they appear:', ...plan.keepQuotes.map((q) => `- "${q}"`), '');
    }
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

  return { system: systemPrompt('improve', prompts, draftInstructions), user: parts.join('\n'), editable };
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
/** V2/V3 cards have a lorebook (character_book); flat V1 cards do not. */
export function supportsLorebook(card) {
  return Boolean(card?.raw?.data && typeof card.raw.data === 'object');
}

/** All the card's prompt text in one string, for checking quotes against. */
function allCardText(card) {
  return SCORABLE_FIELDS.map((f) => card.fields[f] || '').join('\n');
}

/**
 * Context the ideas step needs for the spec checks: creator_notes (which never
 * reach the model, so the model can't otherwise see what's in them), what the
 * lorebook already holds, and whether one can be added to at all.
 */
function cardContext(card) {
  const data = card.raw?.data || card.raw || {};
  const lines = [];
  if (typeof data.creator_notes === 'string' && data.creator_notes.trim()) {
    lines.push('creator_notes (shown to users, never sent to the model):', data.creator_notes.trim().slice(0, 1500), '');
  }
  const entries = data.character_book?.entries;
  if (Array.isArray(entries) && entries.length) {
    const keys = entries.slice(0, 20).map((e) => (Array.isArray(e.keys) ? e.keys.slice(0, 3).join('/') : '?')).join(', ');
    lines.push(`Existing lorebook: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (keys: ${keys}). Do not duplicate them.`, '');
  }
  lines.push(supportsLorebook(card)
    ? 'This card supports a lorebook: lorebook ideas are allowed.'
    : 'This card is in the older V1 format, which has no lorebook: do not suggest lorebook ideas.', '');
  return lines;
}

/** The prompt pair for the ideas step. */
export function buildIdeasPrompts(card, result, { prompts = {}, draftInstructions = null } = {}) {
  const parts = [`Character name: ${card.name}`, ''];
  if (result?.summary) parts.push(`Rating summary: ${result.summary}`, '');
  if (Number.isFinite(result?.overall_score)) parts.push(`Overall score: ${result.overall_score}/10`, '');
  if (result?.top_priority_improvements?.length) {
    parts.push('Top priority improvements from the rating:', ...result.top_priority_improvements.map((p) => `- ${p}`), '');
  }
  parts.push(...cardContext(card));

  const editable = [];
  for (const field of SCORABLE_FIELDS) {
    const text = card.fields[field] || '';
    if (!text.trim()) continue;
    editable.push(field);
    const critique = critiqueFor(result, field);
    parts.push(`### ${field} (~${estimateTokens(text)} tokens)`);
    if (critique) parts.push(`Rating of this field: ${critique}`);
    parts.push(text.trim(), '');
  }
  if (!editable.length) throw new Error('Card has no non-empty fields to improve');
  parts.push(`Fields you may suggest changes to: ${editable.join(', ')}.`);
  return { system: systemPrompt('ideas', prompts, draftInstructions), user: parts.join('\n'), editable };
}

const IMPACTS = ['high', 'medium', 'low'];

/**
 * Step 1 of improving a card: what to keep, and a menu of specific changes.
 * Nothing is rewritten. Ideas are checked against the card — unknown fields
 * are dropped, lorebook ideas are dropped for cards without a lorebook, and
 * "keep_quotes" the model misquoted are dropped, because a quote that isn't
 * really in the card can't be protected.
 */
export async function generateIdeas(card, result, provider, { prompts = {}, draftInstructions = null } = {}) {
  const { system, user, editable } = buildIdeasPrompts(card, result, { prompts, draftInstructions });
  let reply = await ask(provider, { system, user });
  let parsed = extractJsonObject(reply.content, { requireKey: 'ideas' });
  if (!parsed || !Array.isArray(parsed.ideas)) {
    reply = await ask(provider, {
      system,
      user: `${user}\n\nYour previous response was not valid JSON matching the required schema. Respond again with ONLY the JSON object.`,
    });
    parsed = extractJsonObject(reply.content, { requireKey: 'ideas' });
  }
  if (!parsed || !Array.isArray(parsed.ideas)) throw unusableAnswerError('ideas', reply.finishReason);

  const lorebookOk = supportsLorebook(card);
  const text = allCardText(card);
  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const ideas = parsed.ideas
    .filter((i) => i && editable.includes(i.field) && clean(i.change, 2000))
    .map((i, n) => {
      const risk = clean(i.risk, 400);
      return {
        id: `idea-${n + 1}`,
        field: i.field,
        title: clean(i.title, 120) || clean(i.change, 60),
        change: clean(i.change, 2000),
        why: clean(i.why, 600),
        impact: IMPACTS.includes(String(i.impact).toLowerCase()) ? String(i.impact).toLowerCase() : 'medium',
        risk: !risk || /^none\.?$/i.test(risk) ? '' : risk,
        lorebook: Boolean(i.lorebook) && lorebookOk,
      };
    })
    .slice(0, 12);
  if (!ideas.length) throw new Error('The model suggested no usable improvements for this card');

  const keep = (Array.isArray(parsed.keep) ? parsed.keep : []).map((k) => clean(k, 300)).filter(Boolean).slice(0, 12);
  const quotes = (Array.isArray(parsed.keep_quotes) ? parsed.keep_quotes : [])
    .map((q) => String(q ?? '').trim().replace(/^["“]|["”]$/g, ''))
    .filter((q) => q.length >= 3 && text.includes(q));
  const keepQuotes = [...new Set(quotes)].slice(0, 10);

  return { keep, keepQuotes, ideas, lorebookSupported: lorebookOk, model: provider.model, provider: provider.name };
}

/** Normalises proposed lorebook entries; drops anything without keys and content. */
function cleanLorebookEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      keys: (Array.isArray(e?.keys) ? e.keys : [e?.keys]).map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 8),
      content: cleanFieldText(e?.content),
    }))
    .filter((e) => e.keys.length && e.content)
    .slice(0, 12);
}

/** Exact phrases from the keep list that no longer appear anywhere in the improved card. */
export function lostQuotes(card, proposed, lorebookEntries, keepQuotes = []) {
  const after = SCORABLE_FIELDS.map((f) => (proposed[f] ? proposed[f].text : card.fields[f] || ''))
    .concat(lorebookEntries.map((e) => e.content))
    .join('\n');
  return keepQuotes.filter((q) => !after.includes(q));
}

export async function improveCard(card, result, provider, { fields, prompts = {}, draftInstructions = null, plan = null } = {}) {
  const { system, user, editable } = buildImprovePrompts(card, result, { fields, prompts, draftInstructions, plan });

  // No response cap here either: the answer *is* the rewritten card, and a
  // thinking model reasons before writing it. The only limit is yours.
  let reply = await ask(provider, { system, user });
  let parsed = extractJsonObject(reply.content, { requireKey: 'fields' });

  if (!parsed || typeof parsed.fields !== 'object') {
    reply = await ask(provider, {
      system,
      user: `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off). Respond again with ONLY the JSON object. If the card is long, improve fewer fields rather than \
returning a truncated response.`,
    });
    parsed = extractJsonObject(reply.content, { requireKey: 'fields' });
  }

  if (!parsed || typeof parsed.fields !== 'object') throw unusableAnswerError('improvement', reply.finishReason);

  const proposed = {};
  for (const [field, value] of Object.entries(parsed.fields)) {
    // With a plan, a field nobody chose a change for must come back untouched,
    // even if the model rewrote it anyway.
    if (!SCORABLE_FIELDS.includes(field) || !editable.includes(field)) continue;
    const text = cleanFieldText(value?.text ?? value);
    if (!text) continue;
    // A field returned unchanged is noise in the review UI.
    if (text === (card.fields[field] || '').trim()) continue;
    proposed[field] = { text, why: String(value?.why || '').trim() };
  }

  // Lorebook entries are only accepted when a chosen idea asked for a move and
  // the card can hold them.
  const wantsLorebook = Boolean(plan?.ideas?.some((i) => i.lorebook)) && supportsLorebook(card);
  const lorebookEntries = wantsLorebook ? cleanLorebookEntries(parsed.new_lorebook_entries) : [];

  if (!Object.keys(proposed).length && !lorebookEntries.length) {
    throw new Error('The model returned no actual changes — the card may already be in good shape');
  }

  return {
    fields: measureFields(card, proposed),
    lorebookEntries,
    lostQuotes: lostQuotes(card, proposed, lorebookEntries, plan?.keepQuotes),
    headline: String(parsed.headline || '').trim(),
    model: provider.model,
    provider: provider.name,
  };
}
