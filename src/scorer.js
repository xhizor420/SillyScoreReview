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

const SYSTEM_PROMPT = `You are a critical, experienced editor for SillyTavern-style AI roleplay character cards. \
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

function buildUserPrompt(card, weights) {
  const parts = [`Character name: ${card.name}`, ''];
  for (const field of SCORABLE_FIELDS) {
    const text = card.fields[field];
    if (!text || !text.trim()) continue;
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
export async function scoreCard(card, provider, { weights = DEFAULT_WEIGHTS } = {}) {
  const user = buildUserPrompt(card, weights);
  if (!user.includes('###')) {
    throw new Error('Card has no non-empty scorable fields');
  }

  let raw = await provider.chat({ system: SYSTEM_PROMPT, user });
  let parsed = extractJsonBlock(raw);

  if (!parsed || typeof parsed.fields !== 'object') {
    // A common cause of unparseable JSON is the response getting cut off before
    // it closes — so the retry gets real extra headroom (not just a scolding),
    // on top of asking for tighter wording to make it less likely to recur.
    raw = await provider.chat({
      system: SYSTEM_PROMPT,
      user: `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off before finishing). Respond again with ONLY the valid JSON object, nothing else, and keep every \
text field to one short sentence so the full response fits comfortably.`,
      maxTokens: 4000,
    });
    parsed = extractJsonBlock(raw);
  }

  if (!parsed || typeof parsed.fields !== 'object') {
    throw new Error('Model did not return parseable JSON after retry');
  }

  // Normalize/clamp scores defensively; models occasionally drift from the schema.
  const fields = {};
  for (const [name, f] of Object.entries(parsed.fields)) {
    if (!f) continue;
    const score = Math.max(1, Math.min(10, Math.round(Number(f.score))));
    fields[name] = {
      score: Number.isFinite(score) ? score : null,
      strengths: String(f.strengths || ''),
      weaknesses: String(f.weaknesses || ''),
      suggestions: String(f.suggestions || ''),
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
