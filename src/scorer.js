import { SCORABLE_FIELDS, estimateTokens } from './cardParser.js';
import { DEFAULT_PROMPTS, systemPrompt, promptHash } from './prompts.js';
import { extractJsonObject } from './jsonExtract.js';

/**
 * One request, returning the answer and why it ended. Providers that can
 * report a finish reason do; the offline mock only returns text.
 */
export async function ask(provider, args) {
  if (provider.chatWithMeta) return provider.chatWithMeta(args);
  return { content: await provider.chat(args), finishReason: null };
}

/**
 * The error for an answer that never became usable JSON. When the provider
 * says the answer was cut off, say that — it needs a different fix (a bigger
 * or no response limit) from a model that ignored the format.
 */
export function unusableAnswerError(what, finishReason) {
  if (finishReason === 'length') {
    return new Error(
      `The model's answer was cut off before the ${what} was complete (finish_reason: length). ` +
      'Thinking models spend part of the response budget reasoning. Remove the response limit in ' +
      'Settings (0 = no limit), or raise it; if it is already 0, the provider applies its own cap — set a large explicit limit.',
    );
  }
  return new Error(`Model did not return parseable JSON ${what === 'score' ? 'after retry' : `for the ${what} after retry`}`);
}

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

// The prompts live in prompts.js, split into editable instructions and a
// locked response format. These names are kept for anything that imports them.
export const FULL_SYSTEM_PROMPT = DEFAULT_PROMPTS.full;
export const FAST_SYSTEM_PROMPT = DEFAULT_PROMPTS.fast;

/** Picks the system prompt for a scoring detail level, honouring any edits in `prompts`. */
export function systemPromptFor(detail, prompts = {}, draftInstructions = null) {
  return systemPrompt(detail === 'fast' ? 'fast' : 'full', prompts, draftInstructions);
}

/** The exact system+user prompt pair a real scan sends, so diagnostics can reuse it verbatim. */
export function buildScoringPrompts(card, weights = DEFAULT_WEIGHTS, { detail = 'full', prompts = {}, draftInstructions = null } = {}) {
  return {
    system: systemPromptFor(detail, prompts, draftInstructions),
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
export async function scoreCard(card, provider, { weights = DEFAULT_WEIGHTS, detail = 'full', prompts = {}, draftInstructions = null } = {}) {
  const fast = detail === 'fast';
  let user = buildUserPrompt(card, weights, { skipZeroWeight: fast });
  // A card whose only text is in zero-weight fields still deserves a score;
  // fall back to scoring everything rather than refusing it.
  if (fast && !user.includes('###')) user = buildUserPrompt(card, weights);
  if (!user.includes('###')) {
    throw new Error('Card has no non-empty scorable fields');
  }
  const system = systemPromptFor(detail, prompts, draftInstructions);

  // No per-request response cap: a thinking model spends part of any budget
  // reasoning, so a cap sized for the answer alone (fast mode used to ask for
  // 400 tokens) can cut the answer off. The only limit is the one you set.
  let reply = await ask(provider, { system, user });
  let raw = reply.content;
  let parsed = extractJsonObject(raw, { requireKey: 'fields' });

  if (!parsed || typeof parsed.fields !== 'object') {
    // The model wrote something other than the JSON (or ran out of room).
    // Ask once more, plainly, for just the object.
    reply = await ask(provider, {
      system,
      user: fast
        ? `${user}\n\nYour previous response was not valid JSON. Respond again with ONLY the JSON object of \
scores, nothing else.`
        : `${user}\n\nYour previous response was not valid JSON matching the required schema (it may have \
been cut off before finishing). Respond again with ONLY the valid JSON object, nothing else, and keep every \
text field to one short sentence so the full response fits comfortably.`,
    });
    raw = reply.content;
  }

  const result = parseScoreResponse(raw, weights);
  if (!result) throw unusableAnswerError('score', reply.finishReason);
  // Fingerprint the prompt that produced this, so a later prompt edit can tell
  // which scores came from the old wording.
  result.promptHash = promptHash(system);
  return detail === 'fast' ? { ...result, brief: true } : result;
}

/**
 * Turns a raw model response into a normalized score result, or null if it
 * isn't usable. Exported so diagnostics can check a single response without
 * running the full retry cycle.
 */
export function parseScoreResponse(raw, weights = DEFAULT_WEIGHTS) {
  const parsed = extractJsonObject(raw, { requireKey: 'fields' });
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
