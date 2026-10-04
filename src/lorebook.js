import { estimateTokens } from './cardParser.js';

/**
 * A card's embedded lorebook (character_book), read for review: what each
 * entry says, when it fires, and the problems that quietly undo a good card.
 *
 * The checks here are plain code, not the model's opinion, so they cost
 * nothing and say the same thing every time:
 *
 * - near-duplicates: lorebooks grown from chat memories collect three copies
 *   of "Physical Appearance", each slightly different — and an old copy keeps
 *   telling the model a look the card has since moved on from;
 * - keys that fire on almost every message: an entry keyed on the character's
 *   own name is effectively always on, so its tokens are spent every turn;
 * - generic keys ("magic", "plan", "location") that fire far more often than
 *   the entry is relevant;
 * - a title that matches nothing in the entry (a "Rainbow Dash" entry whose
 *   keys and text are all about Rarity).
 */

/** The card's lorebook entries, in their stored order, with their index. */
export function lorebookEntries(card) {
  const data = card?.raw?.data && typeof card.raw.data === 'object' ? card.raw.data : null;
  const entries = data?.character_book?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.map((e, index) => {
    const keys = (Array.isArray(e?.keys) ? e.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean);
    const content = String(e?.content ?? '');
    return {
      index,
      title: String(e?.comment || e?.name || keys[0] || `Entry ${index + 1}`).trim(),
      keys,
      content,
      enabled: e?.enabled !== false && e?.disable !== true,
      constant: e?.constant === true,
      tokens: estimateTokens(content),
    };
  });
}

// Words that turn up in almost any roleplay, so an entry keyed on one fires
// far more often than it is relevant.
const GENERIC_KEYS = new Set([
  'magic', 'plan', 'plans', 'location', 'locations', 'character', 'characters', 'body', 'night', 'day', 'event',
  'events', 'setting', 'settings', 'power', 'powers', 'ability', 'abilities', 'history', 'progress', 'role', 'target',
  'targets', 'ally', 'appearance', 'details', 'profile', 'info', 'information', 'person', 'people', 'home', 'house',
  'room', 'love', 'time', 'world', 'place', 'friend', 'friends', 'story', 'girl', 'boy', 'man', 'woman', 'she', 'he',
  'her', 'him', 'they', 'you', 'me', 'look', 'looks', 'eyes', 'hair', 'face', 'hand', 'hands', 'food', 'work',
]);

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'her', 'his', 'their', 'that', 'this', 'into', 'are', 'was', 'has', 'have']);

function wordSet(text) {
  return new Set((String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The words of the character's name worth matching on ("Chrysalis", "Queen"), lowercased. */
function nameWords(card) {
  const names = [card?.name, card?.raw?.data?.name, card?.raw?.name].filter(Boolean).join(' ');
  return new Set((names.toLowerCase().match(/[\p{L}']+/gu) || []).filter((w) => w.length >= 4 && w !== 'the'));
}

/**
 * Health findings for a card's lorebook. Each finding names the entries it is
 * about (by index) so the dashboard can point at them and the ideas step can
 * propose a fix.
 */
export function auditLorebook(card) {
  const entries = lorebookEntries(card);
  const live = entries.filter((e) => e.enabled && e.content.trim());
  const findings = [];
  if (!entries.length) return { count: 0, enabled: 0, alwaysOnTokens: 0, findings, entries };

  // --- near-duplicates (only among live entries; a disabled copy costs nothing)
  const sets = new Map(live.map((e) => [e.index, wordSet(`${e.title} ${e.content}`)]));
  const seen = new Set();
  for (const a of live) {
    if (seen.has(a.index)) continue;
    const group = [a];
    for (const b of live) {
      if (b.index <= a.index || seen.has(b.index)) continue;
      const sameTitle = a.title.toLowerCase() === b.title.toLowerCase();
      const sim = jaccard(sets.get(a.index), sets.get(b.index));
      if (sim >= 0.5 || (sameTitle && sim >= 0.3)) group.push(b);
    }
    if (group.length > 1) {
      group.forEach((e) => seen.add(e.index));
      findings.push({
        kind: 'duplicate',
        severity: 'warn',
        entries: group.map((e) => e.index),
        message: `${group.length} entries say much the same thing (${[...new Set(group.map((e) => `“${e.title}”`))].join(', ')}). ` +
          'When their wording differs, the model gets competing versions — and an older copy can keep describing something the card has since changed.',
      });
    }
  }

  // --- keys that make an entry fire on nearly every message
  const names = nameWords(card);
  const alwaysOn = [];
  for (const e of live) {
    if (e.constant) { alwaysOn.push(e); continue; }
    const nameKeys = e.keys.filter((k) => (k.toLowerCase().match(/[\p{L}']+/gu) || []).some((w) => names.has(w)));
    if (nameKeys.length) alwaysOn.push(e);
  }
  if (alwaysOn.filter((e) => !e.constant).length) {
    const keyed = alwaysOn.filter((e) => !e.constant);
    findings.push({
      kind: 'name-key',
      severity: keyed.length > 3 ? 'warn' : 'info',
      entries: keyed.map((e) => e.index),
      message: `${keyed.length} entr${keyed.length === 1 ? 'y is' : 'ies are'} keyed on the character's own name, which comes up in almost every message — so ${keyed.length === 1 ? 'it is' : 'they are'} effectively always on.`,
    });
  }
  const generic = live
    .map((e) => ({ e, keys: e.keys.filter((k) => GENERIC_KEYS.has(k.toLowerCase())) }))
    .filter((x) => x.keys.length);
  if (generic.length) {
    findings.push({
      kind: 'generic-key',
      severity: 'info',
      entries: generic.map((x) => x.e.index),
      message: `${generic.length} entr${generic.length === 1 ? 'y has' : 'ies have'} very common words as keys (${[...new Set(generic.flatMap((x) => x.keys.map((k) => `“${k}”`)))].slice(0, 8).join(', ')}), so ${generic.length === 1 ? 'it fires' : 'they fire'} far more often than ${generic.length === 1 ? 'it is' : 'they are'} relevant.`,
    });
  }

  // --- a title naming one subject over an entry about another. Only judged
  // when the entry's first key is a name (capitalised) that its own text is
  // about, so a descriptive title like "Conquest Tactics" isn't second-guessed.
  for (const e of live) {
    const subject = e.keys[0];
    if (!subject || !/^\p{Lu}/u.test(subject)) continue;
    const content = e.content.toLowerCase();
    const title = e.title.toLowerCase();
    if (!content.includes(subject.toLowerCase()) || title.includes(subject.toLowerCase())) continue;
    const titleWords = (e.title.match(/[\p{L}']+/gu) || []).map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !STOP.has(w));
    if (titleWords.length && titleWords.every((w) => !content.includes(w))) {
      findings.push({
        kind: 'title-mismatch',
        severity: 'warn',
        entries: [e.index],
        message: `“${e.title}” is about ${subject}: its keys and text never mention ${e.title}. Probably mislabelled, or the wrong text was pasted in.`,
      });
    }
  }

  const disabled = entries.filter((e) => !e.enabled);
  if (disabled.length) {
    findings.push({
      kind: 'disabled',
      severity: 'info',
      entries: disabled.map((e) => e.index),
      message: `${disabled.length} entr${disabled.length === 1 ? 'y is' : 'ies are'} switched off.`,
    });
  }

  return {
    count: entries.length,
    enabled: live.length,
    alwaysOnTokens: alwaysOn.reduce((n, e) => n + e.tokens, 0),
    alwaysOnCount: alwaysOn.length,
    findings,
    entries,
  };
}

/**
 * The lorebook as context for a prompt: every live entry, with the ones that
 * are effectively always on in full (the model sees those every turn, so they
 * are part of the character as played), and the rest in full until the budget
 * runs out, then by title only.
 */
export function lorebookContext(card, { maxChars = 12000, perEntry = 900, heading = '### Lorebook' } = {}) {
  const audit = auditLorebook(card);
  if (!audit.count) return { lines: [], audit };
  const alwaysOn = new Set(audit.findings.filter((f) => f.kind === 'name-key').flatMap((f) => f.entries));
  const order = [...audit.entries].sort((a, b) =>
    (b.constant || alwaysOn.has(b.index)) - (a.constant || alwaysOn.has(a.index)) || a.index - b.index);
  const lines = [heading];
  let used = 0;
  const brief = [];
  for (const e of order) {
    const head = `[lorebook:${e.index}] “${e.title}” — keys: ${e.keys.slice(0, 8).join(', ') || '(none)'}` +
      `${e.constant ? ' — always on' : alwaysOn.has(e.index) ? ' — keyed on the character\'s name, so effectively always on' : ''}` +
      `${e.enabled ? '' : ' — switched off'}`;
    const text = e.content.trim().replace(/\s+\n/g, '\n');
    if (used < maxChars) {
      const body = text.length > perEntry ? `${text.slice(0, perEntry)}…` : text;
      lines.push(head, body, '');
      used += head.length + body.length;
    } else {
      brief.push(head);
    }
  }
  if (brief.length) lines.push(`Further entries (titles only):`, ...brief, '');
  if (audit.findings.length) {
    lines.push('Lorebook checks (measured, not guessed):', ...audit.findings.map((f) => `- ${f.message} [${f.entries.map((i) => `lorebook:${i}`).join(', ')}]`), '');
  }
  return { lines, audit };
}
