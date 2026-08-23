---
name: verify
description: How to drive SillyScoreReview's real CLI/server against a fake LLM provider to observe timing/behavior, instead of unit-testing internals.
---

# Verifying SillyScoreReview at runtime

The app's surface is the CLI (`node src/cli.js scan|serve|stats`) and, behind
`serve`, the Express API the dashboard calls. `test/selftest.js` already covers
the offline pipeline with `--provider mock`. For anything involving real LLM
call behavior (timing, retries, rate limits), drive the actual `scan` command
against a **fake local HTTP server standing in for the provider** — don't
import `scorer.js`/`llmClient.js` and call functions directly, and don't hit
the real network (no egress to nano-gpt.com or api.anthropic.com from this
environment).

## Recipe

1. Write synthetic card fixtures (a PNG with a base64 `tEXt` chunk keyed
   `chara`) — see `buildFakePng` in `test/selftest.js` for the exact chunk
   format.
2. Spin up a plain `node:http` server that mimics an OpenAI-compatible
   `/chat/completions` endpoint: read the request body, inspect
   `messages[].content` for `Character name: X` to identify which card a call
   belongs to, delay to simulate model latency, respond with whatever JSON
   shape you're testing (clean / truncated / 429 with `Retry-After`).
3. Write a `config.json` with `provider: "openai"`, `baseURL:
   "http://localhost:<fake port>"`, `apiKey: "test"`, `model: "test-model"`.
4. Run `node src/cli.js scan --config <path>` for real and read its stdout —
   that's the actual user-facing surface, same code path the dashboard's
   "Scan unscored" batch job uses (`server.js` calls the same
   `scoreCard`/`Store`/`runPool`).
5. Track request counts/timestamps/max-concurrency in the fake server (log to
   stdout or a SIGTERM handler) to get hard numbers, not impressions.

## Known gotchas found this way

- Scorer's JSON-repair retry (`scorer.js`) does **not** raise `max_tokens` on
  the second attempt. If a card's malformed JSON is caused by truncation
  (verbose model + `max_tokens: 2000` default), the retry gets truncated
  identically, doubles wall-clock time for that card, and still fails —
  confirmed via the fake-provider recipe above with a deliberately-truncated
  response in both `truncate-once` and `truncate-always` modes.
- `Store.set()` rewrites the *entire* cache file on every card (not just an
  append). At ~2000 cached entries (~7.5MB file) this costs ~30-40ms per
  save — real but small next to multi-hundred-ms+ LLM latency; don't mistake
  it for the main slowness source without checking JSON-truncation first.
- Concurrency is real (verified via `maxConcurrentSeen` in the fake server) —
  if scans still feel slow at high concurrency, look at retry counts per card
  before suspecting the pool.
