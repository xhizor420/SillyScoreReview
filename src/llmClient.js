const DEFAULT_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries(fn, { retries = 3, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable = err.retriable !== false; // default: retry
      if (!retriable || attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 300;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Anthropic Messages API. */
function createAnthropicProvider(config) {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic provider selected but no API key set (config.apiKey or ANTHROPIC_API_KEY)');
  const model = config.model || 'claude-sonnet-5';
  const baseURL = config.baseURL || 'https://api.anthropic.com';

  return {
    name: 'anthropic',
    model,
    async chat({ system, user }) {
      return withRetries(async () => {
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
              max_tokens: config.maxTokens || 2000,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          },
          config.timeoutMs || DEFAULT_TIMEOUT_MS,
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
          err.retriable = res.status === 429 || res.status >= 500;
          throw err;
        }
        const json = await res.json();
        return json.content?.map((c) => c.text || '').join('') || '';
      });
    },
  };
}

/** Works for OpenAI itself, and any OpenAI-compatible local server (Ollama, LM Studio, text-generation-webui, vLLM, etc). */
function createOpenAICompatProvider(config) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || 'not-needed';
  const model = config.model || 'gpt-4o-mini';
  const baseURL = config.baseURL || 'https://api.openai.com/v1';

  return {
    name: 'openai-compatible',
    model,
    async chat({ system, user }) {
      return withRetries(async () => {
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
              max_tokens: config.maxTokens || 2000,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
          },
          config.timeoutMs || DEFAULT_TIMEOUT_MS,
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`OpenAI-compatible API ${res.status}: ${body.slice(0, 500)}`);
          err.retriable = res.status === 429 || res.status >= 500;
          throw err;
        }
        const json = await res.json();
        return json.choices?.[0]?.message?.content || '';
      });
    },
  };
}

/** Deterministic offline provider for --dry-run / self-tests. No network calls, no cost. */
function createMockProvider() {
  return {
    name: 'mock',
    model: 'mock-heuristic',
    async chat({ user }) {
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

export function createProvider(config) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai':
    case 'local':
    case 'openai-compatible':
      return createOpenAICompatProvider(config);
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown provider "${config.provider}". Use anthropic, openai, local, or mock.`);
  }
}
