/**
 * Pulls the JSON answer out of a model response.
 *
 * Thinking models make this harder than it looks:
 *
 * - Reasoning can arrive inline, as "<think> … </think>" before the answer,
 *   and sometimes with the opening tag already stripped by the provider.
 * - That reasoning quotes the card it is judging, and card text is full of
 *   braces — every {{user}} and {{char}} macro. The old "first { to last }"
 *   approach would start inside the reasoning and fail to parse a perfectly
 *   good answer.
 *
 * So: drop reasoning blocks, then try the whole text, then fenced blocks, then
 * every balanced {…} span — newest first, because the answer comes after the
 * thinking — and take the first one that parses and has the key the caller
 * needs.
 */

const THINK_TAGS = ['think', 'thinking', 'reasoning'];

export function stripThinking(text) {
  let t = String(text ?? '');
  for (const tag of THINK_TAGS) {
    t = t.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  // A closing tag with no opening one: the provider removed "<think>" but left
  // the reasoning and "</think>". Everything up to the last close is reasoning.
  const lower = t.toLowerCase();
  let cut = -1;
  for (const tag of THINK_TAGS) {
    const i = lower.lastIndexOf(`</${tag}>`);
    if (i !== -1) cut = Math.max(cut, i + tag.length + 3);
  }
  if (cut !== -1) t = t.slice(cut);
  return t.trim();
}

/** End index (inclusive) of the {...} that opens at `start`, honouring JSON strings; -1 if unbalanced. */
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Returns the answer object, or null if there isn't a usable one.
 * @param {string} text the raw model response
 * @param {{ requireKey?: string }} [opts] only accept objects with this key (e.g. "fields")
 */
export function extractJsonObject(text, { requireKey } = {}) {
  const ok = (v) => v && typeof v === 'object' && !Array.isArray(v) && (!requireKey || requireKey in v);
  const t = stripThinking(text);

  const whole = tryParse(t);
  if (ok(whole)) return whole;

  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const v = tryParse(m[1].trim());
    if (ok(v)) return v;
  }

  // Newest first: the answer follows any reasoning or preamble.
  const starts = [];
  for (let i = t.indexOf('{'); i !== -1; i = t.indexOf('{', i + 1)) starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    const end = matchingBrace(t, starts[k]);
    if (end === -1) continue;
    const v = tryParse(t.slice(starts[k], end + 1));
    if (ok(v)) return v;
  }
  return null;
}
