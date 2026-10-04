import { RateLimiter } from './rateLimiter.js';
import { fatalReason } from './errorKinds.js';

const DEFAULT_TIMEOUT_MS = 120_000;

// Known providers with sane defaults, used both to fill in config.baseURL/model
// when they're left blank and to drive the Settings panel in the dashboard.
// NanoGPT (https://nano-gpt.com) is an OpenAI-compatible aggregator giving
// access to many models through one API key, so it reuses the same client
// code as `openai`/`local` — only the default base URL differs.
export const PROVIDER_PRESETS = {
  nanogpt: {
    label: 'NanoGPT',
    baseURL: 'https://nano-gpt.com/api/v1',
    defaultModel: '',
    needsKey: true,
    docs: 'https://docs.nano-gpt.com',
    // Per-key limits per docs.nano-gpt.com/api-reference/miscellaneous/rate-limits:
    // 10 concurrent requests, a 10-requests/10s burst bucket, 60 requests/minute.
    // Concurrency alone does not honor the per-minute ceiling — 8 in flight
    // against a 2s model is ~240/min — so requests are also paced by a token
    // bucket sized to these numbers.
    maxConcurrency: 10,
    requestsPerMinute: 60,
    burst: 10,
    rateLimitNote: 'NanoGPT allows 10 concurrent requests and 60 requests/minute per key. Requests are automatically paced to stay under 60/min, so raising concurrency past ~8 will not go faster.',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseURL: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    needsKey: true,
    docs: 'https://console.anthropic.com',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    docs: 'https://platform.openai.com',
  },
  local: {
    label: 'Local / other OpenAI-compatible (Ollama, LM Studio, …)',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: '',
    needsKey: false,
    docs: '',
  },
  mock: {
    label: 'Mock (offline test, no cost, no real scoring)',
    baseURL: '',
    defaultModel: 'mock-heuristic',
    needsKey: false,
    docs: '',
  },
};

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      // Mark timeouts distinctly. Retrying an identical request that was too
      // slow rarely helps — it just burns another full timeout — so the retry
      // policy treats these very differently from a transient 500.
      const timeoutErr = new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s. The model is likely too slow for this workload — ` +
        `try a faster model, or raise "timeoutMs" in config.json if you want to wait longer.`,
      );
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a standard `Retry-After` header (seconds, or an HTTP-date) into a millisecond delay. */
function parseRetryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function withRetries(fn, { retries = 4, baseDelayMs = 1500 } = {}) {
  let lastErr;
  let timeoutsSeen = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // A retry after a timeout gets a longer deadline rather than the same one
      // that just proved too short — retrying an identical too-short deadline is
      // how a merely-slow model turns into a failed card. Measured against a
      // model whose latency straddles the timeout: same-deadline retries failed
      // 8-17% of cards, while one retry at double the deadline failed 0% and
      // made *fewer* HTTP calls overall, because nothing needed retrying twice.
      return await fn({ timeoutMultiplier: 2 ** timeoutsSeen });
    } catch (err) {
      lastErr = err;
      const retriable = err.retriable !== false; // default: retry
      if (!retriable || attempt === retries) break;
      // Still capped: two attempts total for timeouts. The old five-attempt
      // ladder burned ~10 minutes per card at the 120s default and failed anyway.
      if (err.isTimeout && ++timeoutsSeen > 1) break;
      // A long Retry-After (tens of minutes+) usually means a daily quota reset,
      // not a transient rate limit — waiting it out would just block this worker
      // slot for hours, so surface the error now instead of stalling the batch.
      if (err.retryAfterMs != null && err.retryAfterMs > 30_000) break;
      // Otherwise, a 429/503 that tells us exactly how long to wait (NanoGPT and
      // most OpenAI-compatible APIs do) gets honored as-is instead of guessed at —
      // that's the actual contract for staying within a provider's limits.
      const delay = err.retryAfterMs ?? baseDelayMs * 2 ** attempt + Math.random() * 300;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * The response-length limit to send, if any.
 *
 * `maxTokens` in config is the user's choice: a positive number is a hard cap
 * sent as-is; 0 (the default) means "no limit" and max_tokens is left out of
 * the request entirely. That matters for thinking models: their reasoning
 * usually counts against max_tokens, so any fixed cap risks the answer being
 * cut off after the model has spent the budget thinking.
 *
 * There are deliberately no per-request caps any more (fast mode used to ask
 * for 400, improve for at most 16k): with a thinking model, any of them could
 * truncate the answer.
 */
export function responseLimit(config) {
  const n = Number(config.maxTokens);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Anthropic Messages API. */
function createAnthropicProvider(config) {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic provider selected but no API key set (config.apiKey or ANTHROPIC_API_KEY)');
  const model = config.model || 'claude-sonnet-5';
  const baseURL = config.baseURL || 'https://api.anthropic.com';
  // No published per-minute number to pace against by default, but the limiter
  // still matters: it is what slows down when the API starts answering 429.
  const limiter = new RateLimiter({ requestsPerMinute: config.requestsPerMinute ?? 0 });

  async function probe() {
    try {
      const res = await fetchWithTimeout(`${baseURL}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      }, 10_000);
      return { reachable: res.status < 500, status: res.status };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  return {
    name: 'anthropic',
    model,
    limiter,
    probe,
    async chat(args) {
      return (await this.chatWithMeta(args)).content;
    },
    async chatWithMeta({ system, user }) {
      return withRetries(async ({ timeoutMultiplier = 1 } = {}) => {
        await limiter.acquire();
        const startedAt = Date.now();
        const res = await fetchWithTimeout(
          `${baseURL}/v1/messages`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              // The Messages API requires max_tokens, so "no limit" can't mean
              // leaving it out here; send a generous ceiling instead.
              max_tokens: responseLimit(config) ?? 8192,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          },
          (config.timeoutMs || DEFAULT_TIMEOUT_MS) * timeoutMultiplier,
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
          err.status = res.status;
          err.body = body.slice(0, 2000);
          err.retriable = (res.status === 429 || res.status >= 500) && !fatalReason(err);
          err.retryAfterMs = parseRetryAfterMs(res);
          if (res.status === 429) limiter.penalize(err.retryAfterMs);
          throw err;
        }
        limiter.reward();
        const json = await res.json();
        return {
          content: json.content?.filter((c) => c.type === 'text').map((c) => c.text || '').join('') || '',
          // Normalised to the OpenAI wording so callers check one value.
          finishReason: json.stop_reason === 'max_tokens' ? 'length' : json.stop_reason ?? null,
          usage: json.usage ?? null,
          latencyMs: Date.now() - startedAt,
        };
      }, { baseDelayMs: config.retryBaseDelayMs ?? 1500 });
    },
  };
}

/** Works for OpenAI, NanoGPT, and any other OpenAI-compatible server (Ollama, LM Studio, text-generation-webui, vLLM, etc). */
function createOpenAICompatProvider(config, name = 'openai-compatible') {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || 'not-needed';
  const preset = PROVIDER_PRESETS[name];
  const model = config.model || preset?.defaultModel || 'gpt-4o-mini';
  const baseURL = config.baseURL || preset?.baseURL || 'https://api.openai.com/v1';
  if (!model) throw new Error(`No model set for provider "${name}" — pick one in Settings (Refresh model list, or type one in manually).`);

  // An explicit config value wins (raise it if the provider granted you more,
  // set 0 to disable pacing entirely — e.g. for a local model on your own box).
  const limiter = new RateLimiter({
    requestsPerMinute: config.requestsPerMinute ?? preset?.requestsPerMinute ?? 0,
    burst: config.burst ?? preset?.burst,
  });

  async function call({ system, user }) {
    const limit = responseLimit(config);
    return withRetries(async ({ timeoutMultiplier = 1 } = {}) => {
      // Pace against the provider's published requests/minute ceiling before
      // opening the connection — staying inside the limit rather than finding
      // it by collecting 429s.
      await limiter.acquire();
      const startedAt = Date.now();
      const res = await fetchWithTimeout(
        `${baseURL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: config.temperature ?? 0.2,
            // No limit unless you set one (see responseLimit).
            ...(limit ? { max_tokens: limit } : {}),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        },
        (config.timeoutMs || DEFAULT_TIMEOUT_MS) * timeoutMultiplier,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`${name} API ${res.status}: ${body.slice(0, 500)}`);
        err.status = res.status;
        err.body = body.slice(0, 2000);
        // A rejected key or an empty balance will be rejected identically on
        // every retry — retrying only adds rejected requests to the account.
        err.retriable = (res.status === 429 || res.status >= 500) && !fatalReason(err);
        err.retryAfterMs = parseRetryAfterMs(res);
        // The provider is telling us we are too fast, even if we are inside
        // its published numbers. Believe it, for everyone sharing this limiter.
        if (res.status === 429) limiter.penalize(err.retryAfterMs);
        throw err;
      }
      limiter.reward();
      const json = await res.json();
      const message = json.choices?.[0]?.message || {};
      return {
        // Thinking models: some providers return the reasoning in its own
        // field (reasoning_content / reasoning) and only the answer here;
        // others put "<think>…</think>" in front of the answer in this field.
        // Either way the reasoning is not the answer — the JSON reader strips
        // inline think blocks, and the separate field is only measured (and
        // shown when you test a prompt, so you can see how the model got there).
        content: message.content || '',
        reasoning: message.reasoning_content || message.reasoning || '',
        reasoningChars: (message.reasoning_content || message.reasoning || '').length,
        finishReason: json.choices?.[0]?.finish_reason ?? null,
        usage: json.usage ?? null,
        latencyMs: Date.now() - startedAt,
      };
    }, { baseDelayMs: config.retryBaseDelayMs ?? 1500 });
  }

  /**
   * Is the provider reachable at all? Lists models — no tokens, no cost — so
   * an outage can be watched for recovery without spending anything. Any HTTP
   * answer below 500 means the network path works (an auth problem will then
   * surface as a proper fatal error on the next real request).
   */
  async function probe() {
    try {
      const res = await fetchWithTimeout(`${baseURL}/models`, { headers: { authorization: `Bearer ${apiKey}` } }, 10_000);
      return { reachable: res.status < 500, status: res.status };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  return {
    name,
    model,
    baseURL,
    limiter,
    probe,
    async chat(args) {
      return (await call(args)).content;
    },
    // Same request, but returns timing/finish_reason/usage alongside the text —
    // used by `doctor` to explain *why* a scan is slow or failing.
    chatWithMeta: call,
  };
}

/**
 * Splits an ideas/improve prompt back into the text of each part it shows
 * ("### description", "### lorebook:3 — …"), so the mock provider can return
 * plausible ideas and edits for the real card instead of lorem ipsum.
 */
function parsePromptParts(user) {
  const out = {};
  const parts = user.split(/^### (\w+)([^\n]*)$/m);
  for (let i = 1; i < parts.length; i += 3) {
    const name = parts[i];
    if (/REFERENCE ONLY/.test(parts[i + 1] || '')) continue;
    const body = (parts[i + 2] || '')
      .split('\n')
      .filter((line) => !/^(Critique|Rating) of this field:/.test(line))
      .join('\n');
    const cut = body.search(/\n(You may edit only:|Fields you may suggest)/);
    out[name] = (cut === -1 ? body : body.slice(0, cut)).trim();
  }
  return out;
}

/** The first whole sentence of `text` (or its first line), for quoting. */
function firstSentence(text) {
  const m = text.match(/^[^\n]*?[.!?](?=\s|$)/);
  return (m ? m[0] : text.split('\n')[0]).trim();
}

/** Deterministic offline provider for --dry-run / self-tests. No network calls, no cost. */
function createMockProvider() {
  return {
    name: 'mock',
    model: 'mock-heuristic',
    async chat({ system, user }) {
      // Fast triage asks for bare numbers; answer in that shape so the offline
      // path exercises the same parser a real fast scan does.
      if (/Output nothing else — no strengths/.test(system || '')) {
        const fields = {};
        for (const m of user.matchAll(/### (\w+)/g)) fields[m[1]] = 6;
        const scores = Object.values(fields);
        return JSON.stringify({
          fields,
          overall_score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 5,
        });
      }

      // Recognised by its locked response format, not its wording — the
      // instructions part is user-editable and may say anything.
      // Ideas step: a deterministic menu built from the real card, so the
      // offline path exercises the same choose-then-edit flow.
      if (/"canon": \[/.test(system || '') && /"ideas": \[/.test(system || '')) {
        const originals = parsePromptParts(user);
        const ideas = [];
        const canon = [];
        for (const [field, text] of Object.entries(originals)) {
          if (!text) continue;
          const quote = firstSentence(text);
          if (canon.length < 4 && quote) canon.push({ aspect: field === 'first_mes' ? 'voice' : 'personality', fact: `Mock provider: how ${field.replace(/_/g, ' ')} opens`, quote });
          ideas.push({
            kind: 'extend', field, title: `Show the ${field.replace(/_/g, ' ')} in action`,
            change: `Add one concrete behaviour after the first sentence of ${field}.`, why: 'Mock provider: no real analysis.',
            quotes: quote ? [quote] : [], impact: ideas.length ? 'medium' : 'high', risk: 'none',
          });
        }
        return JSON.stringify({ canon, ideas });
      }

      if (/"edits": \[/.test(system || '') && /"headline"/.test(system || '')) {
        const originals = parsePromptParts(user);
        const chosen = [...user.matchAll(/^(\d+)\. \[(\w+) · ([\w:]+)\]/gm)].map((m) => ({ n: Number(m[1]), kind: m[2], field: m[3] }));
        const edits = [];
        for (const c of chosen.length ? chosen : Object.keys(originals).map((field, i) => ({ n: i + 1, kind: 'extend', field }))) {
          const text = originals[c.field];
          if (!text) continue;
          const anchor = firstSentence(text);
          if (!anchor) continue;
          edits.push({
            idea: c.n, field: c.field, action: 'insert_after', find: anchor,
            text: ' {{char}} pauses, choosing the next words with care.', why: 'Mock provider: a placeholder behaviour.',
          });
        }
        return JSON.stringify({ edits, headline: 'Mock provider edits — use a real provider for actual improvements.' });
      }

      // crude heuristic: score inversely correlated with filler/repetition, just for pipeline testing
      const lengthPenalty = Math.min(3, Math.max(0, (user.length - 3000) / 4000));
      const base = 7 - lengthPenalty;
      const fieldsMatch = [...user.matchAll(/### (\w+)/g)].map((m) => m[1]);
      const fields = {};
      for (const f of fieldsMatch) {
        const score = Math.max(1, Math.min(10, Math.round(base + (Math.random() * 2 - 1))));
        fields[f] = {
          score,
          strengths: 'Mock provider: no real analysis performed.',
          weaknesses: 'Mock provider: no real analysis performed.',
          suggestions: 'Run with a real provider for actual feedback.',
        };
      }
      const overall = fields && Object.keys(fields).length
        ? Math.round((Object.values(fields).reduce((s, f) => s + f.score, 0) / Object.keys(fields).length) * 10) / 10
        : 5;
      return JSON.stringify({
        fields,
        overall_score: overall,
        top_priority_improvements: ['Mock run 1', 'Mock run 2', 'Mock run 3'],
        summary: 'Mock provider output — use --provider anthropic|openai for real scoring.',
      });
    },
  };
}

/**
 * Clamps a requested concurrency to what the provider documents it allows, so a
 * hand-edited config or an over-eager Settings value can't push past the
 * provider's stated ceiling. Returns the value to use plus why it changed.
 */
export function resolveConcurrency(config) {
  const requested = Math.max(1, Number(config.concurrency) || 1);
  const max = PROVIDER_PRESETS[config.provider]?.maxConcurrency;
  if (!max || requested <= max) return { concurrency: requested, clamped: false };
  return {
    concurrency: max,
    clamped: true,
    reason: `${config.provider} documents a limit of ${max} concurrent requests; using ${max} instead of ${requested}.`,
  };
}

export function createProvider(config) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai':
    case 'local':
    case 'openai-compatible':
    case 'nanogpt':
      return createOpenAICompatProvider(config, config.provider === 'openai-compatible' ? 'openai' : config.provider);
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown provider "${config.provider}". Use nanogpt, anthropic, openai, local, or mock.`);
  }
}

/** Lists model IDs available for the currently configured provider/key, for the Settings panel's model picker. */
export async function listModels(config) {
  if (config.provider === 'mock') return ['mock-heuristic'];

  const preset = PROVIDER_PRESETS[config.provider];
  const baseURL = config.baseURL || preset?.baseURL;
  if (!baseURL) throw new Error(`No base URL configured for provider "${config.provider}"`);

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('No API key saved yet — save one in Settings first.');
    const res = await fetchWithTimeout(
      `${baseURL}/v1/models?limit=1000`,
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      15_000,
    );
    if (!res.ok) throw new Error(`Model list request failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const json = await res.json();
    return (json.data || []).map((m) => m.id).sort();
  }

  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey && preset?.needsKey) throw new Error('No API key saved yet — save one in Settings first.');
  const res = await fetchWithTimeout(
    `${baseURL}/models`,
    { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} },
    15_000,
  );
  if (!res.ok) throw new Error(`Model list request failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id).sort();
}
