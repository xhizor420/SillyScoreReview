import { SCORABLE_FIELDS, estimateTokens } from './cardParser.js';

// Relative importance of each field when computing the weighted overall score.
// Only fields that are actually non-empty on a given card are used; the
// remaining weights are renormalized so they still sum to 1.
export const DEFAULT_WEIGHTS = {
  description: 0.3,
  personality: 0.1,
  scenario: 0.1,
  first_mes: 0.25,
  mes_example: 0.15,
  system_prompt: 0.05,
  post_history_instructions: 0.05,
  alternate_greetings: 0.0, // scored for feedback, excluded from overall by default
};

export const FULL_SYSTEM_PROMPT = `You are a critical, experienced editor for SillyTavern-style AI roleplay character cards. \
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
a full editorial letter, and a long response risks being cut off before it's valid JSON.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary before or after) matching \
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

/**
 * Triage mode. Scoring is ~100% model latency, and latency is dominated by how
 * much the model has to *write* — the full rubric asks for three sentences per
 * field plus a summary, which is 10-20x more output than the numbers alone.
 *
 * For a first pass over thousands of cards the numbers are the whole job: you
 * cull by score and you only need the written critique for the handful you keep
 * and want to improve. So this asks for exactly the scores, and any card can be
 * rescored in full later without re-reading the collection.
 */
export const FAST_SYSTEM_PROMPT = `You are a critical, experienced editor for SillyTavern-style AI roleplay \
character cards. You judge writing quality, clarity, internal consistency, and how well a field will actually \
drive an LLM to roleplay the character well — never length. A short, sharp card outscores a long padded one; \
treat padding, redundancy and vague generic writing as faults.

Rate each field you are given from 1-10, applying the same standard you would if you were writing out the \
full critique. Do not be generous: the scores are used to decide which cards get deleted.

Respond with ONLY a single valid JSON object, no markdown fences and no commentary, in exactly this shape:
{"fields": {"<field_name>": <1-10 integer>}, "overall_score": <number 1-10, one decimal>}

Include every field name given to you below, spelled exactly as shown. Output nothing else — no strengths, no \
weaknesses, no suggestions, no summary.`;

/** Picks the system prompt for a scoring detail level. */
export function systemPromptFor(detail) {
  return detail === 'fast' ? FAST_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT;
}

/** The exact system+user prompt pair a real scan sends, so diagnostics can reuse it verbatim. */
export function buildScoringPrompts(card, weights = DEFAULT_WEIGHTS, { detail = 'full' } = {}) {
  return {
    system: systemPromptFor(detail),
    user: buildUserPrompt(card, weights, { skipZeroWeight: detail === 'fast' }),
  };
}

function buildUserPrompt(card, weights, { skipZeroWeight = false } = {}) {
  const parts = [`Character name: ${card.name}`, ''];
  for (const field of SCORABLE_FIELDS) {
    const text = card.fields[field];
    if (!text || !text.trim()) continue;
    // A zero-weight field (alternate_greetings by default) contributes nothing
    // to the overall score. In full mode its critique is still worth reading,
    // but in a scores-only pass it is pure cost — and on cards with several
    // greetings it is often the largest field in the prompt.
    if (skipZeroWeight && (weights[field] ?? 0) === 0) continue;
    const tokens = estimateTokens(text);
    const weight = weights[field] ?? 0;
    parts.push(`### ${field} (~${tokens} tokens, weight ${weight})`);
    parts.push(text.trim());
    parts.push('');
  }
  return parts.join('\n');
}

function extractJsonBlock(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace extraction below
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  return null;
}

function recomputeOverall(fields, weights) {
  const present = Object.keys(fields).filter((f) => Number.isFinite(fields[f]?.score));
  const totalWeight = present.reduce((s, f) => s + (weights[f] ?? 0), 0);
  if (totalWeight <= 0) {
    // no configured weights for these fields — fall back to a plain average
    const avg = present.reduce((s, f) => s + fields[f].score, 0) / (present.length || 1);
    return Math.round(avg * 10) / 10;
  }
  const weighted = present.reduce((s, f) => s + fields[f].score * (weights[f] ?? 0), 0);
  return Math.round((weighted / totalWeight) * 10) / 10;
}

/**
 * Scores a single normalized card via the given provider. Retries once with
 * a stricter instruction if the model's response isn't valid JSON.
 */
export async function scoreCard(card, provider, { weights = DEFAULT_WEIGHTS, detail = 'full' } = {}) {
  const fast = detail === 'fast';
  let user = buildUserPrompt(card, weights, { skipZeroWeight: fast });
  // A card whose only text is in zero-weight fields still deserves a score;
  // fall back to scoring everything rather than refusing it.
  if (fast && !user.includes('###')) user = buildUserPrompt(card, weights);
  if (!user.includes('###')) {
    throw new Error('Card has no non-empty scorable fields');
  }
  const system = systemPromptFor(detail);

  // Fast mode writes a couple of dozen tokens, so it needs nowhere near the
  // default budget — and a tight cap is itself a guard against a model that
  // ignores the schema and starts writing an essay.
  let raw = await provider.chat({ system, user, maxTokens: fast ? 400 : undefined });
  let parsed = extractJsonBlock(raw);

  if (!parsed || typeof parsed.fields !== 'object') {
    // A common cause of unparseable JSON is the response getting cut off before
    // it closes — so the retry gets real extra headroom (not just a scolding),
    // on top of asking for tighter wording to make it less likely to recur.
    raw = await provider.chat({
      system,
      user: fast
        ? `${user}\n\nYour previous response was not valid JSON. Respond again with ONLY the JSON object of \
scores, nothing else.`
        : `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off before finishing). Respond again with ONLY the valid JSON object, nothing else, and keep every \
text field to one short sentence so the full response fits comfortably.`,
      maxTokens: fast ? 800 : 4000,
    });
    parsed = extractJsonBlock(raw);
  }

  const result = parseScoreResponse(raw, weights);
  if (!result) {
    throw new Error('Model did not return parseable JSON after retry');
  }
  return detail === 'fast' ? { ...result, brief: true } : result;
}

/**
 * Turns a raw model response into a normalized score result, or null if it
 * isn't usable. Exported so diagnostics can check a single response without
 * running the full retry cycle.
 */
export function parseScoreResponse(raw, weights = DEFAULT_WEIGHTS) {
  const parsed = extractJsonBlock(raw);
  if (!parsed || typeof parsed.fields !== 'object') return null;

  // Normalize/clamp scores defensively; models occasionally drift from the schema.
  const fields = {};
  for (const [name, f] of Object.entries(parsed.fields)) {
    if (f == null) continue;
    // Fast mode answers `"description": 7`; full mode answers an object. Accept
    // either, so one parser covers both and a model that abbreviates in full
    // mode still produces a usable score instead of a failure.
    const rawScore = typeof f === 'object' ? f.score : f;
    const score = Math.max(1, Math.min(10, Math.round(Number(rawScore))));
    fields[name] = {
      score: Number.isFinite(score) ? score : null,
      strengths: typeof f === 'object' ? String(f.strengths || '') : '',
      weaknesses: typeof f === 'object' ? String(f.weaknesses || '') : '',
      suggestions: typeof f === 'object' ? String(f.suggestions || '') : '',
    };
  }

  const overall = Number.isFinite(parsed.overall_score)
    ? Math.round(parsed.overall_score * 10) / 10
    : recomputeOverall(fields, weights);

  return {
    fields,
    overall_score: overall,
    top_priority_improvements: Array.isArray(parsed.top_priority_improvements)
      ? parsed.top_priority_improvements.slice(0, 3).map(String)
      : [],
    summary: String(parsed.summary || ''),
  };
}
