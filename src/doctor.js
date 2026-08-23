import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseCardFile, totalCardTokens } from './cardParser.js';
import { createProvider, PROVIDER_PRESETS } from './llmClient.js';
import { buildScoringPrompts, parseScoreResponse } from './scorer.js';

const CARDS_TO_TEST = 3;

function fmtSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function estimateFullRun(medianMs, cardCount, concurrency) {
  const totalMs = (medianMs * cardCount) / Math.max(1, concurrency);
  if (totalMs < 60_000) return 'under a minute';
  const hours = totalMs / 3_600_000;
  if (hours < 1) return `${Math.round(totalMs / 60_000)} minutes`;
  return `${hours.toFixed(1)} hours`;
}

/**
 * Scores a few real cards with full instrumentation and explains, in plain
 * language, what will make a full run slow or fail — so you find out in a
 * minute instead of after a 14-hour scan.
 */
export async function runDoctor(config) {
  const lines = [];
  const say = (s = '') => {
    lines.push(s);
    console.log(s);
  };

  say('SillyScoreReview — diagnostics');
  say('='.repeat(60));
  say(`Provider:    ${config.provider}`);
  say(`Model:       ${config.model || '(not set)'}`);
  say(`Base URL:    ${config.baseURL || PROVIDER_PRESETS[config.provider]?.baseURL || '(default)'}`);
  say(`API key:     ${config.apiKey ? 'set' : 'NOT SET'}`);
  say(`Concurrency: ${config.concurrency}`);
  say(`Timeout:     ${Math.round((config.timeoutMs || 120_000) / 1000)}s per request`);
  say(`Cards dir:   ${config.charactersDir}`);
  say('');

  let files;
  try {
    files = (await readdir(config.charactersDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    say(`FAIL: cannot read the characters folder — ${err.message}`);
    return { ok: false, lines };
  }
  say(`Found ${files.length} card files.`);
  if (files.length === 0) {
    say('Nothing to test. Point the app at your characters folder first.');
    return { ok: false, lines };
  }

  let provider;
  try {
    provider = createProvider(config);
  } catch (err) {
    say(`FAIL: ${err.message}`);
    return { ok: false, lines };
  }

  // Pick a spread: smallest, median, largest — so a slow big card shows up.
  const parsed = [];
  for (const file of files) {
    try {
      const card = parseCardFile(await readFile(path.join(config.charactersDir, file)), file);
      parsed.push({ file, card, tokens: totalCardTokens(card) });
    } catch {
      // unreadable cards are a separate concern; scan reports those
    }
    if (parsed.length >= 400) break; // enough to pick a representative spread
  }
  if (parsed.length === 0) {
    say('FAIL: none of the card files could be parsed.');
    return { ok: false, lines };
  }
  parsed.sort((a, b) => a.tokens - b.tokens);
  const picks = [parsed[0], parsed[Math.floor(parsed.length / 2)], parsed[parsed.length - 1]]
    .filter(Boolean)
    .slice(0, CARDS_TO_TEST);

  say(`Testing ${picks.length} real cards (smallest / median / largest) against the live API...`);
  say('');

  const results = [];
  for (const { file, card, tokens } of picks) {
    say(`→ ${card.name}  (~${tokens} tokens, ${file})`);
    const { system, user } = buildScoringPrompts(card, config.weights);
    const started = Date.now();
    try {
      const meta = await provider.chatWithMeta({ system, user });
      const elapsed = Date.now() - started;
      const scored = parseScoreResponse(meta.content, config.weights);
      const ok = Boolean(scored);

      say(`   latency:       ${fmtSeconds(meta.latencyMs)}${elapsed > meta.latencyMs + 500 ? ` (incl. retries: ${fmtSeconds(elapsed)})` : ''}`);
      if (meta.finishReason) say(`   finish_reason: ${meta.finishReason}`);
      if (meta.usage) {
        say(`   tokens:        ${meta.usage.prompt_tokens ?? '?'} in / ${meta.usage.completion_tokens ?? '?'} out`);
      }
      say(`   valid JSON:    ${ok ? 'yes' : 'NO — would trigger a repair retry (2x the time)'}`);
      if (ok) say(`   score:         ${scored.overall_score}/10`);
      results.push({ file, ok, latencyMs: meta.latencyMs, finishReason: meta.finishReason, usage: meta.usage });
    } catch (err) {
      const elapsed = Date.now() - started;
      say(`   FAILED after ${fmtSeconds(elapsed)}: ${err.message}`);
      results.push({ file, ok: false, latencyMs: elapsed, error: err.message, isTimeout: err.isTimeout });
    }
    say('');
  }

  // ---- verdict ----
  say('='.repeat(60));
  say('DIAGNOSIS');
  say('');

  const succeeded = results.filter((r) => r.ok);
  const timedOut = results.filter((r) => r.isTimeout);
  const truncated = results.filter((r) => r.finishReason === 'length');
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)] || 0;

  if (timedOut.length) {
    const currentTimeoutS = Math.round((config.timeoutMs || 120_000) / 1000);
    say(`✗ ${timedOut.length}/${results.length} requests TIMED OUT (current limit: ${currentTimeoutS}s).`);
    say('  A timed-out request is retried once with double the deadline, so a');
    say('  merely-slow model usually still succeeds — but if these are failing');
    say('  outright, the model is slower than twice your timeout.');
    say('');
    say('  FIX (either):');
    say(`   1. Switch to a faster model in Settings — the real fix. On NanoGPT,`);
    say('      avoid large "reasoning"/"thinking" models here: they are many times');
    say('      slower and spend their output budget thinking instead of answering.');
    say(`   2. Or raise "timeoutMs" in config.json above ${currentTimeoutS * 2}s if you`);
    say('      genuinely want to wait that long per card.');
  } else if (truncated.length) {
    say(`⚠ ${truncated.length}/${results.length} responses were CUT OFF (finish_reason: length).`);
    say('  The model ran out of output budget before finishing its JSON. Each of');
    say('  those costs a repair retry — double time — and may still fail.');
    say('  FIX: pick a model that does not "think" out loud, or raise "maxTokens"');
    say('  in config.json (currently ' + (config.maxTokens || 3000) + ').');
  } else if (succeeded.length === results.length) {
    say(`✓ All ${results.length} test cards scored successfully on the first try.`);
  } else {
    say(`⚠ ${succeeded.length}/${results.length} test cards scored successfully.`);
    for (const r of results.filter((x) => !x.ok && x.error)) {
      say(`  - ${r.file}: ${r.error}`);
    }
  }

  say('');
  if (succeeded.length === 0) {
    // An ETA built from failed requests is meaningless — don't imply the run
    // would finish when in fact nothing is getting scored at all.
    say('No successful requests, so there is no meaningful speed estimate:');
    say('at this rate the scan would never finish, however long you leave it.');
    say('Fix the problem above first, then re-run `doctor` to get a real ETA.');
  } else {
    const okLatencies = succeeded.map((r) => r.latencyMs).sort((a, b) => a - b);
    const okMedian = okLatencies[Math.floor(okLatencies.length / 2)];
    say(`Median latency of successful requests: ${fmtSeconds(okMedian)}`);
    say(`At this speed, ${files.length} cards at concurrency ${config.concurrency} would take about ${estimateFullRun(okMedian, files.length, config.concurrency)}.`);
    // Recommend a deadline with real headroom over what we actually observed,
    // so normal variance doesn't get killed as a "timeout".
    const slowest = Math.max(...succeeded.map((r) => r.latencyMs));
    const suggestedMs = Math.ceil((slowest * 3) / 10_000) * 10_000;
    const currentMs = config.timeoutMs || 120_000;
    if (suggestedMs > currentMs) {
      say('');
      say(`Slowest successful request: ${fmtSeconds(slowest)}, but your timeout is only ${fmtSeconds(currentMs)}.`);
      say(`That leaves little headroom for variance — consider "timeoutMs": ${suggestedMs} in config.json.`);
    }
    if (okMedian > 30_000) {
      say('');
      say('That is very slow per request. A fast model should answer in 2-10s.');
      say('Switching models is by far the biggest speed lever available to you —');
      say('far more than raising concurrency.');
    }
  }
  say('');

  return { ok: succeeded.length === results.length, lines, results, medianLatencyMs: median };
}
