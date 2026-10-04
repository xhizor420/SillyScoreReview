import { SCORABLE_FIELDS, estimateTokens } from './cardParser.js';
import { DEFAULT_PROMPTS, systemPrompt } from './prompts.js';
import { extractJsonObject } from './jsonExtract.js';
import { ask, unusableAnswerError } from './scorer.js';
import { lorebookEntries, lorebookContext, auditLorebook } from './lorebook.js';

/**
 * Improving a card, in two model steps with you choosing in between:
 *
 * 1. Ideas — the model records the card's canon (what makes the character
 *    itself, each fact with a quote from the card) and proposes specific
 *    changes, each of a kind: fix, combine, extend, move, trim, lorebook.
 * 2. Edits — the chosen ideas are carried out as precise, anchored edits:
 *    "replace this exact passage with…", "insert after this exact passage…".
 *
 * Edits, not rewrites, because a model asked to rewrite a 3,000-token field
 * hands back a summary of it: details quietly vanish, and the character goes
 * with them. With edits, text outside a quoted passage cannot change at all,
 * every change can be looked at and allowed on its own, and what a change
 * removes can be measured (the dashboard does, live, as you choose).
 */
// Kept for anything that imports it; the editable source is prompts.js.
export const IMPROVE_SYSTEM_PROMPT = DEFAULT_PROMPTS.improve;

export const IDEA_KINDS = ['fix', 'combine', 'extend', 'move', 'trim', 'lorebook'];
const CANON_ASPECTS = ['look', 'personality', 'voice', 'goals', 'relationships', 'powers', 'setting', 'format'];
const IMPACTS = ['high', 'medium', 'low'];
const ACTIONS = ['replace', 'insert_after', 'insert_before', 'disable'];

function critiqueFor(result, field) {
  const f = result?.fields?.[field];
  if (!f) return null;
  const bits = [];
  if (Number.isFinite(f.score)) bits.push(`scored ${f.score}/10`);
  if (f.weaknesses) bits.push(`weaknesses: ${f.weaknesses}`);
  if (f.suggestions) bits.push(`suggestions: ${f.suggestions}`);
  return bits.length ? bits.join('; ') : null;
}

/** V2/V3 cards have a lorebook (character_book) and extensions; flat V1 cards do not. */
export function supportsLorebook(card) {
  return Boolean(card?.raw?.data && typeof card.raw.data === 'object');
}

const LORE_RE = /^lorebook:(\d+)$/;

/**
 * Everything an idea or edit can point at: the card's non-empty fields, and
 * (on cards that have one) each lorebook entry as "lorebook:N".
 */
export function editTargets(card) {
  const targets = new Map();
  for (const field of SCORABLE_FIELDS) {
    const text = card.fields[field] || '';
    if (!text.trim()) continue;
    // V1 cards have nowhere to store a Character's Note.
    if (field === 'character_note' && !supportsLorebook(card)) continue;
    targets.set(field, { target: field, label: field.replace(/_/g, ' '), text });
  }
  if (supportsLorebook(card)) {
    for (const e of lorebookEntries(card)) {
      targets.set(`lorebook:${e.index}`, {
        target: `lorebook:${e.index}`, label: `lorebook: ${e.title}`, text: e.content, entry: e,
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Matching quoted text against the card. Models copy faithfully but not
// perfectly: curly vs straight quotes, a collapsed double space, "..." for "…".
// Exact first; then a normalised comparison that maps back to the real text.
// ---------------------------------------------------------------------------

function normChar(ch) {
  if (ch === '‘' || ch === '’' || ch === 'ʼ') return "'";
  if (ch === '“' || ch === '”') return '"';
  if (ch === '…') return '...';
  if (ch === ' ') return ' ';
  return ch;
}

/** Normalised text plus, for each normalised character, its index in the original. */
function normalizeWithMap(text) {
  let norm = '';
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const n = normChar(text[i]);
    if (/\s/.test(n)) {
      if (prevSpace) continue;
      prevSpace = true;
      norm += ' ';
      map.push(i);
      continue;
    }
    prevSpace = false;
    for (const c of n) { norm += c; map.push(i); }
  }
  return { norm, map };
}

function normalize(text) {
  return normalizeWithMap(String(text)).norm.trim();
}

/**
 * Where `find` is in `text`: { start, end } in the original text, or
 * { error } — not there at all, or there more than once (and so ambiguous).
 */
export function locate(text, find) {
  const needle = String(find ?? '');
  if (!needle.trim()) return { error: 'no passage was quoted' };
  const first = text.indexOf(needle);
  if (first !== -1) {
    if (text.indexOf(needle, first + 1) !== -1) return { error: 'the quoted passage appears more than once' };
    return { start: first, end: first + needle.length };
  }
  const hay = normalizeWithMap(text);
  const n = normalize(needle);
  if (!n) return { error: 'no passage was quoted' };
  const at = hay.norm.indexOf(n);
  if (at === -1) return { error: 'the quoted passage is not in the card' };
  if (hay.norm.indexOf(n, at + 1) !== -1) return { error: 'the quoted passage appears more than once' };
  const start = hay.map[at];
  const lastNorm = at + n.length - 1;
  let end = hay.map[lastNorm] + 1;
  // A normalised "..." can stand for a single "…" — end after the whole char.
  return { start, end: Math.min(end, text.length) };
}

/** Is `quote` (normalised) somewhere in `text`? */
export function containsQuote(text, quote) {
  const q = normalize(quote);
  return q.length > 0 && normalize(text).includes(q);
}

/**
 * Inserted text that doesn't bring its own spacing gets a space, so
 * "…teal.She…" never happens. A paragraph-level insert keeps its own breaks.
 */
function joinSpacing(left, middle, right) {
  let out = middle;
  if (left && out && !/\s$/.test(left) && !/^\s/.test(out)) out = ` ${out}`;
  if (right && out && !/\s$/.test(out) && !/^[\s.,;:!?)\]}"'’”]/.test(right)) out = `${out} `;
  return out;
}

/**
 * Turns the model's edits into placed edits against the real text of each
 * target. An edit is placed only if its quote is found exactly once and it
 * doesn't overlap an edit placed before it; otherwise it is returned in
 * `unplaced` with the reason, and the card is unaffected by it.
 */
export function placeEdits(targets, edits, { allowed = null } = {}) {
  const placed = [];
  const unplaced = [];
  edits.forEach((raw, order) => {
    const e = {
      order,
      idea: Number.isInteger(raw.idea) ? raw.idea : Number.parseInt(raw.idea, 10) || null,
      target: String(raw.field ?? raw.target ?? '').trim(),
      action: ACTIONS.includes(raw.action) ? raw.action : 'replace',
      find: String(raw.find ?? ''),
      text: String(raw.text ?? '').replace(/\r\n/g, '\n'),
      why: String(raw.why ?? '').trim(),
    };
    const t = targets.get(e.target);
    const fail = (reason) => unplaced.push({ ...e, reason });
    if (!t) return fail('it points at a part of the card that does not exist');
    if (allowed && !allowed.has(e.target)) return fail('it changes a part of the card no chosen idea was about');
    if (e.action === 'disable') {
      if (!LORE_RE.test(e.target)) return fail('only lorebook entries can be switched off');
      if (placed.some((p) => p.target === e.target && p.action === 'disable')) return fail('this entry is already being switched off');
      placed.push({ ...e, start: 0, end: 0, old: '', new: '', anchor: '' });
      return;
    }
    const at = locate(t.text, e.find);
    if (at.error) return fail(at.error);
    let { start, end } = at;
    let newText = e.text;
    let old = t.text.slice(start, end);
    if (e.action === 'replace') {
      if (newText === old) return fail('it would change nothing');
      // Removing a sentence shouldn't leave a double space behind.
      if (!newText && t.text[start - 1] === ' ' && t.text[end] === ' ') { end += 1; old = t.text.slice(start, end); }

    } else {
      if (!newText.trim()) return fail('it adds nothing');
      const point = e.action === 'insert_after' ? end : start;
      newText = joinSpacing(t.text.slice(0, point), newText, t.text.slice(point));
      start = point;
      end = point;
      old = '';
    }
    // Overlaps: two replacements of intersecting text, or an insert inside a
    // replaced passage, can't both apply. The first one placed wins.
    const clash = placed.find((p) => p.target === e.target && p.action !== 'disable' && (
      (start < p.end && p.start < end) ||
      (start === end && p.start < start && start < p.end) ||
      (p.start === p.end && start < p.start && p.start < end)));
    if (clash) return fail('it overlaps another change to the same passage');
    placed.push({ ...e, start, end, old, new: newText, anchor: t.text.slice(at.start, at.end) });
  });
  return { placed, unplaced };
}

/** Applies placed edits to one target's text (all of them — the dashboard applies the ones you allow). */
export function applyEdits(text, edits) {
  const sorted = edits.filter((e) => e.action !== 'disable').sort((a, b) => a.start - b.start || a.order - b.order);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += text.slice(pos, e.start) + e.new;
    pos = e.end;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------
// Step 1: ideas
// ---------------------------------------------------------------------------

/** The prompt pair for the ideas step. */
export function buildIdeasPrompts(card, result, { prompts = {}, draftInstructions = null } = {}) {
  const parts = [`Character name: ${card.name}`, ''];
  if (result?.summary) parts.push(`Rating summary: ${result.summary}`, '');
  if (Number.isFinite(result?.overall_score)) parts.push(`Overall score: ${result.overall_score}/10`, '');
  if (result?.top_priority_improvements?.length) {
    parts.push('Top priority improvements from the rating:', ...result.top_priority_improvements.map((p) => `- ${p}`), '');
  }

  const editable = [];
  for (const field of SCORABLE_FIELDS) {
    const text = card.fields[field] || '';
    if (!text.trim()) continue;
    if (field === 'character_note' && !supportsLorebook(card)) continue;
    editable.push(field);
    const critique = critiqueFor(result, field);
    parts.push(`### ${field} (~${estimateTokens(text)} tokens)`);
    if (critique) parts.push(`Rating of this field: ${critique}`);
    parts.push(text.trim(), '');
  }
  if (!editable.length) throw new Error('Card has no non-empty fields to improve');

  if (supportsLorebook(card)) {
    const { lines, audit } = lorebookContext(card, { maxChars: 24000, perEntry: 1200, heading: '### Lorebook' });
    if (lines.length) parts.push(...lines);
    parts.push(audit.count
      ? 'This card has a lorebook: "move" ideas may create new entries, and "lorebook" ideas may change the entries above (field lorebook:N).'
      : 'This card supports a lorebook but has none yet: "move" ideas may create entries.', '');
  } else {
    parts.push('This card is in the older V1 format, which has no lorebook: do not suggest "move" or "lorebook" ideas.', '');
  }
  parts.push(`Fields you may suggest changes to: ${editable.join(', ')}${supportsLorebook(card) && lorebookEntries(card).length ? ', or lorebook:N' : ''}.`);
  return { system: systemPrompt('ideas', prompts, draftInstructions), user: parts.join('\n'), editable };
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Step 1 of improving a card: the canon and a menu of specific changes.
 * Nothing is changed. Everything is checked against the card: ideas for parts
 * that don't exist are dropped, lorebook ideas are dropped for cards without
 * a lorebook, and quotes the model got wrong are dropped — a quote that isn't
 * really in the card can neither be protected nor relied on.
 */
export async function generateIdeas(card, result, provider, { prompts = {}, draftInstructions = null } = {}) {
  const { system, user } = buildIdeasPrompts(card, result, { prompts, draftInstructions });
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
  const targets = editTargets(card);
  const allText = [...targets.values()].map((t) => t.text).join('\n');
  const realQuote = (q) => {
    const s = String(q ?? '').trim().replace(/^["“]|["”]$/g, '');
    return s.length >= 3 && containsQuote(allText, s) ? s : null;
  };

  const ideas = parsed.ideas
    .filter((i) => i && clean(i.change, 2000))
    .map((i) => {
      const field = String(i.field ?? '').trim();
      let kind = IDEA_KINDS.includes(String(i.kind).toLowerCase()) ? String(i.kind).toLowerCase() : null;
      if (!kind) kind = i.lorebook ? 'move' : 'extend'; // older custom prompts don't name a kind
      if (LORE_RE.test(field) && !['fix', 'combine', 'lorebook', 'extend', 'trim'].includes(kind)) kind = 'lorebook';
      return { i, field, kind };
    })
    .filter(({ field, kind }) => targets.has(field) && (lorebookOk || (kind !== 'move' && kind !== 'lorebook')))
    .map(({ i, field, kind }, n) => {
      const risk = clean(i.risk, 400);
      const quotes = (Array.isArray(i.quotes) ? i.quotes : []).map(realQuote).filter(Boolean).slice(0, 6);
      return {
        id: `idea-${n + 1}`,
        kind,
        field,
        fieldLabel: targets.get(field).label,
        title: clean(i.title, 120) || clean(i.change, 60),
        change: clean(i.change, 2000),
        why: clean(i.why, 600),
        quotes,
        impact: IMPACTS.includes(String(i.impact).toLowerCase()) ? String(i.impact).toLowerCase() : 'medium',
        risk: !risk || /^none\.?$/i.test(risk) ? '' : risk,
        lorebook: kind === 'move',
      };
    })
    .slice(0, 12);
  if (!ideas.length) throw new Error('The model suggested no usable improvements for this card');

  // The canon: each fact with the quote that establishes it. A quote the
  // model got wrong is dropped (the fact stays, just unprotected).
  let canon = (Array.isArray(parsed.canon) ? parsed.canon : [])
    .map((c) => ({
      aspect: CANON_ASPECTS.includes(String(c?.aspect).toLowerCase()) ? String(c.aspect).toLowerCase() : 'other',
      fact: clean(c?.fact, 300),
      quote: realQuote(c?.quote) || '',
    }))
    .filter((c) => c.fact)
    .slice(0, 24);
  // Older custom prompts return a flat keep list and keep_quotes instead.
  if (!canon.length && Array.isArray(parsed.keep)) {
    canon = parsed.keep.map((k) => ({ aspect: 'other', fact: clean(k, 300), quote: '' })).filter((c) => c.fact).slice(0, 12);
    for (const q of (Array.isArray(parsed.keep_quotes) ? parsed.keep_quotes : []).map(realQuote).filter(Boolean)) {
      canon.push({ aspect: 'other', fact: 'Exact line', quote: q });
    }
  }
  const keepQuotes = [...new Set(canon.map((c) => c.quote).filter(Boolean))].slice(0, 24);

  return {
    canon,
    keep: canon.map((c) => c.fact),
    keepQuotes,
    ideas,
    lorebookSupported: lorebookOk,
    targetLabels: Object.fromEntries([...targets.values()].map((t) => [t.target, t.label])),
    model: provider.model,
    provider: provider.name,
  };
}

// ---------------------------------------------------------------------------
// Step 2: edits
// ---------------------------------------------------------------------------

/**
 * Which parts of the card the chosen ideas may change. A lorebook idea about
 * a duplicate also reaches the other copies (they get merged or switched off),
 * and any entry an idea names explicitly.
 */
function planTargets(card, plan, targets) {
  const out = new Set();
  const audit = auditLorebook(card);
  for (const idea of plan.ideas) {
    if (targets.has(idea.field)) out.add(idea.field);
    const blob = `${idea.change || ''} ${idea.why || ''} ${(idea.quotes || []).join(' ')}`;
    for (const m of blob.matchAll(/lorebook:(\d+)/g)) if (targets.has(`lorebook:${m[1]}`)) out.add(`lorebook:${m[1]}`);
    const lm = LORE_RE.exec(idea.field);
    if (lm) {
      for (const f of audit.findings.filter((x) => x.kind === 'duplicate' && x.entries.includes(Number(lm[1])))) {
        for (const i of f.entries) out.add(`lorebook:${i}`);
      }
    }
    // A fix can name text in another field ("the greeting says 8 feet") by quoting it.
    for (const q of idea.quotes || []) {
      for (const t of targets.values()) if (containsQuote(t.text, q) && idea.kind === 'fix') out.add(t.target);
    }
  }
  // The description is canon: a fix changes the place that disagrees with it,
  // never the description itself, unless an idea is about the description.
  if (!plan.ideas.some((i) => i.field === 'description')) out.delete('description');
  return out;
}

/** The exact prompt pair an improve request sends, so tests and diagnostics can reuse it. */
export function buildImprovePrompts(card, result, { prompts = {}, draftInstructions = null, plan = null, fields = null } = {}) {
  const targets = editTargets(card);
  const parts = [`Character name: ${card.name}`, ''];
  let allowed;

  if (plan?.ideas?.length) {
    allowed = planTargets(card, plan, targets);
    parts.push('Chosen changes — carry out exactly these, and change nothing else:');
    plan.ideas.forEach((idea, i) => {
      parts.push(`${i + 1}. [${idea.kind || 'change'} · ${idea.field}] ${idea.title} — ${idea.change}${idea.why ? ` (Why: ${idea.why})` : ''}`);
      if (idea.quotes?.length) parts.push(`   Passages it is about: ${idea.quotes.map((q) => `“${q}”`).join(' / ')}`);
    });
    parts.push('');
    const canon = plan.canon?.length ? plan.canon : (plan.keep || []).map((k) => ({ aspect: 'other', fact: k, quote: '' }));
    if (canon.length) {
      parts.push('Canon — what makes this character itself. Every edit must leave all of it intact:',
        ...canon.map((c) => `- ${c.aspect !== 'other' ? `${c.aspect}: ` : ''}${c.fact}${c.quote ? ` (“${c.quote}”)` : ''}`), '');
    }
    if (plan.keepQuotes?.length) {
      parts.push('Must survive word for word, wherever they appear:', ...plan.keepQuotes.map((q) => `- "${q}"`), '');
    }
  } else {
    // No ideas chosen (a prompt test): carry out the critique's priorities.
    const wanted = (fields?.length ? fields : SCORABLE_FIELDS).filter((f) => targets.has(f));
    allowed = new Set(wanted);
    parts.push('No specific changes were chosen: carry out the most valuable improvements the critique names, as edits, keeping to the rules.', '');
  }
  if (result?.summary) parts.push(`Critique summary: ${result.summary}`, '');
  if (result?.top_priority_improvements?.length) {
    parts.push('Top priority improvements:', ...result.top_priority_improvements.map((p) => `- ${p}`), '');
  }

  if (!allowed.size) throw new Error('None of the chosen ideas point at a part of this card that exists');

  // The description goes in as the reference even when it isn't being edited:
  // fixing the greeting "to match the description" needs the description.
  const desc = targets.get('description');
  if (desc && !allowed.has('description')) {
    parts.push('### description (REFERENCE ONLY — the canon. Do not edit it.)', desc.text.trim(), '');
  }
  for (const target of allowed) {
    const t = targets.get(target);
    const critique = LORE_RE.test(target) ? null : critiqueFor(result, target);
    const head = t.entry
      ? `### ${target} — lorebook entry “${t.entry.title}” (keys: ${t.entry.keys.join(', ')})${t.entry.enabled ? '' : ' (switched off)'}`
      : `### ${target} (~${estimateTokens(t.text)} tokens)`;
    parts.push(head);
    if (critique) parts.push(`Critique of this field: ${critique}`);
    parts.push(t.text, '');
  }
  parts.push(`You may edit only: ${[...allowed].join(', ')}.${plan?.ideas?.some((i) => i.kind === 'move') && supportsLorebook(card) ? ' Moves may also add new lorebook entries.' : ''}`);

  return { system: systemPrompt('improve', prompts, draftInstructions), user: parts.join('\n'), allowed, targets };
}

function cleanText(text) {
  let out = String(text ?? '');
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```\s*$/i);
  if (fence) out = fence[1];
  return out.replace(/\r\n/g, '\n').trim();
}

/** Normalises proposed lorebook entries; drops anything without keys and content. */
function cleanLorebookEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      keys: (Array.isArray(e?.keys) ? e.keys : [e?.keys]).map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 8),
      content: cleanText(e?.content),
    }))
    .filter((e) => e.keys.length && e.content)
    .slice(0, 12);
}

/**
 * Asks for the chosen ideas as edits and places them against the card.
 * Returns proposals only — nothing is written here. Each placed edit carries
 * the exact passage it changes and the idea it belongs to, so the dashboard
 * can show it in context and let you allow, adjust or refuse it alone.
 */
export async function improveCard(card, result, provider, { fields, prompts = {}, draftInstructions = null, plan = null } = {}) {
  const { system, user, allowed, targets } = buildImprovePrompts(card, result, { fields, prompts, draftInstructions, plan });

  // No response cap: a thinking model reasons before answering, and the edits
  // for a long card can be long. The only limit is yours.
  let reply = await ask(provider, { system, user });
  let parsed = extractJsonObject(reply.content, { requireKey: 'edits' });
  if (!parsed || !Array.isArray(parsed.edits)) {
    reply = await ask(provider, {
      system,
      user: `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off). Respond again with ONLY the JSON object, with an "edits" list.`,
    });
    parsed = extractJsonObject(reply.content, { requireKey: 'edits' });
  }
  if (!parsed || !Array.isArray(parsed.edits)) throw unusableAnswerError('improvement', reply.finishReason);

  const { placed, unplaced } = placeEdits(targets, parsed.edits.filter((e) => e && typeof e === 'object'), { allowed });

  // Which idea each edit carries out (the prompt numbers them from 1).
  const ideaFor = (n) => (plan?.ideas && n >= 1 && n <= plan.ideas.length ? plan.ideas[n - 1] : null);
  const describe = (e) => {
    const idea = ideaFor(e.idea);
    return {
      id: `edit-${e.order + 1}`,
      target: e.target,
      label: targets.get(e.target)?.label || e.target,
      action: e.action,
      start: e.start,
      end: e.end,
      old: e.old,
      new: e.new,
      anchor: e.anchor,
      find: e.find,
      why: e.why,
      ideaId: idea?.id || null,
      ideaTitle: idea?.title || '',
      kind: idea?.kind || null,
      ...(e.reason ? { reason: e.reason, text: e.text } : {}),
    };
  };

  const wantsLorebook = Boolean(plan?.ideas?.some((i) => i.kind === 'move' || i.lorebook)) && supportsLorebook(card);
  const lorebookEntriesOut = wantsLorebook ? cleanLorebookEntries(parsed.new_lorebook_entries) : [];

  if (!placed.length && !lorebookEntriesOut.length) {
    const why = unplaced.length
      ? ` It suggested ${unplaced.length} change${unplaced.length === 1 ? '' : 's'}, but none could be placed (${[...new Set(unplaced.map((u) => u.reason))].join('; ')}).`
      : '';
    throw new Error(`The model returned no changes that could be applied.${why}`);
  }

  const touched = [...new Set(placed.map((e) => e.target))];
  return {
    edits: placed.map(describe),
    unplaced: unplaced.map(describe),
    before: Object.fromEntries(touched.map((t) => [t, targets.get(t).text])),
    labels: Object.fromEntries(touched.map((t) => [t, targets.get(t).label])),
    // The rest of the card (switched-off entries aside), so the dashboard can
    // tell a detail that moved elsewhere from one that is gone.
    rest: [...targets.values()]
      .filter((t) => !touched.includes(t.target) && (!t.entry || t.entry.enabled))
      .map((t) => t.text)
      .join('\n'),
    lorebookEntries: lorebookEntriesOut,
    headline: String(parsed.headline || '').trim(),
    model: provider.model,
    provider: provider.name,
  };
}
