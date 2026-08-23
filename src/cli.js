#!/usr/bin/env node
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider, resolveConcurrency } from './llmClient.js';
import { scoreCard, DEFAULT_WEIGHTS } from './scorer.js';
import { Store } from './store.js';
import { runPool } from './concurrency.js';
import { classifyError } from './errorKinds.js';
import { resolveCacheFile, listCaches } from './cachePath.js';

const DEFAULT_CONFIG = {
  charactersDir: './characters',
  cacheFile: './data/cache.json',
  trashDir: './data/trash',
  provider: 'nanogpt',
  model: undefined,
  apiKey: undefined,
  baseURL: undefined,
  concurrency: 8,
  weights: DEFAULT_WEIGHTS,
  port: 4180,
  host: '0.0.0.0',
  authToken: '',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function loadConfig(args) {
  const configPath = path.resolve(process.cwd(), args.config || './config.json');
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (args.config) throw new Error(`Config file not found: ${configPath}`);
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    weights: { ...DEFAULT_WEIGHTS, ...(fileConfig.weights || {}) },
  };

  if (args.dir) config.charactersDir = args.dir;
  if (args.provider) config.provider = args.provider;
  if (args.model) config.model = args.model;
  if (args['api-key']) config.apiKey = args['api-key'];
  if (args['base-url']) config.baseURL = args['base-url'];
  if (args.concurrency) config.concurrency = Number(args.concurrency);
  if (args.port) config.port = Number(args.port);
  if (args.host) config.host = args.host;
  if (args['auth-token']) config.authToken = args['auth-token'];

  config.charactersDir = path.resolve(process.cwd(), config.charactersDir);
  config.cacheFile = path.resolve(process.cwd(), config.cacheFile);
  config.trashDir = path.resolve(process.cwd(), config.trashDir);
  // Kept so the dashboard can persist a folder picked at runtime back to the
  // same file it was loaded from (or create one, if it didn't exist yet).
  config.configPath = configPath;

  return config;
}

async function listCardFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read characters directory "${dir}": ${err.message}`);
  }
  return entries
    .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
}

function scoreBucket(score) {
  if (score == null) return 'unscored';
  if (score >= 8) return 'great (8-10)';
  if (score >= 6) return 'good (6-7.9)';
  if (score >= 4) return 'mediocre (4-5.9)';
  return 'weak (1-3.9)';
}

async function cmdScan(args) {
  const config = await loadConfig(args);
  const cacheFile = await resolveCacheFile(config.cacheFile, config.charactersDir);
  const store = await new Store(cacheFile, config.charactersDir).load();
  const files = await listCardFiles(config.charactersDir);

  const rescore = Boolean(args.rescore);
  const limit = args.limit ? Number(args.limit) : Infinity;

  const candidates = [];
  for (const file of files) {
    const filePath = path.join(config.charactersDir, file);
    let card;
    try {
      const buf = await readFile(filePath);
      card = parseCardFile(buf, file);
    } catch (err) {
      console.warn(`⚠ skip ${file}: ${err.message}`);
      continue;
    }
    const hash = hashCard(card);
    const cached = store.get(file);
    const needsScore = rescore || !cached || cached.hash !== hash || cached.error;
    if (needsScore) candidates.push({ file, card, hash });
  }

  const work = candidates.slice(0, limit);
  console.log(`${files.length} card files found, ${candidates.length} need scoring, running ${work.length}.`);

  const totalTokens = work.reduce((s, w) => s + totalCardTokens(w.card), 0);
  console.log(`Estimated input tokens for this run: ~${totalTokens.toLocaleString()} (rough char/4 estimate, excludes prompt overhead).`);

  if (args['dry-run']) {
    console.log('Dry run — no scoring performed.');
    return;
  }

  if (work.length === 0) {
    console.log('Nothing to do. Use --rescore to force re-scoring everything.');
    return;
  }

  const provider = createProvider(config);
  const { concurrency, clamped, reason } = resolveConcurrency(config);
  if (clamped) console.log(`Note: ${reason}`);
  const rl = provider.limiter?.stats?.();
  const paceNote = rl?.enabled ? `, paced to ${Math.round(rl.requestsPerMinute)} req/min` : '';
  console.log(`Using provider "${provider.name}" (model: ${provider.model}), concurrency ${concurrency}${paceNote}.`);

  let done = 0;
  let errors = 0;
  const runStartedAt = Date.now();
  // Live throughput/ETA, so a slow run is obvious within minutes instead of
  // after leaving it overnight and finding it barely moved.
  const progress = () => {
    const finished = done + errors;
    const elapsedMin = (Date.now() - runStartedAt) / 60_000;
    if (elapsedMin < 0.1 || finished === 0) return `[${finished}/${work.length}]`;
    const perHour = finished / (elapsedMin / 60);
    const remainingHours = (work.length - finished) / Math.max(perHour, 0.01);
    const eta = remainingHours < 1 ? `${Math.round(remainingHours * 60)}m` : `${remainingHours.toFixed(1)}h`;
    return `[${finished}/${work.length} · ${perHour.toFixed(0)}/hr · ETA ${eta}]`;
  };

  await runPool(work, concurrency, async ({ file, card, hash }) => {
    try {
      const result = await scoreCard(card, provider, { weights: config.weights });
      await store.set(file, {
        hash,
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        result,
        error: null,
      });
      done++;
      console.log(`${progress()} ✓ ${card.name} — overall ${result.overall_score}/10  (${file})`);
    } catch (err) {
      errors++;
      await store.set(file, {
        hash,
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        result: null,
        error: err.message,
      });
      console.error(`${progress()} ✗ ${card.name} — ${err.message}  (${file})`);
    }
  });

  const totalMin = (Date.now() - runStartedAt) / 60_000;
  console.log(`\nDone in ${totalMin < 60 ? `${totalMin.toFixed(1)} min` : `${(totalMin / 60).toFixed(1)} h`}. ${done} scored, ${errors} errors. Re-run scan to retry errors.`);
  if (errors > done && errors > 2) {
    console.log('\nMost cards failed. Run `node src/cli.js doctor` to find out why (it tests a few cards and explains the cause).');
  }
}

async function cmdStats(args) {
  const config = await loadConfig(args);
  const cacheFile = await resolveCacheFile(config.cacheFile, config.charactersDir);
  const store = await new Store(cacheFile, config.charactersDir).load();
  const entries = Object.values(store.all());
  const buckets = {};
  const errorGroups = new Map();
  let sum = 0;
  let scored = 0;
  let failed = 0;

  for (const e of entries) {
    const score = e.result?.overall_score ?? null;
    const bucket = e.error ? 'error' : scoreBucket(score);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    if (e.error) {
      failed++;
      const kind = classifyError(e.error);
      if (!errorGroups.has(kind)) errorGroups.set(kind, { count: 0, sample: e.error });
      errorGroups.get(kind).count++;
    }
    if (score != null) {
      sum += score;
      scored++;
    }
  }

  const attempted = scored + failed;
  console.log(`Characters folder: ${config.charactersDir}`);
  console.log(`Score data file:   ${cacheFile}`);
  console.log('');
  console.log(`Total cached entries: ${entries.length}`);
  console.log(`Scored successfully: ${scored}${scored ? `, average overall score: ${(sum / scored).toFixed(2)}` : ''}`);
  if (attempted > 0) {
    console.log(`Failed: ${failed} (${((failed / attempted) * 100).toFixed(0)}% of attempted)`);
  }

  console.log('\nScore distribution:');
  for (const [bucket, count] of Object.entries(buckets)) {
    console.log(`  ${bucket}: ${count}`);
  }

  if (errorGroups.size) {
    console.log('\nWhy cards failed:');
    const sorted = [...errorGroups.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [kind, { count, sample }] of sorted) {
      console.log(`  ${String(count).padStart(5)}  ${kind}`);
      console.log(`         e.g. "${sample.slice(0, 130)}${sample.length > 130 ? '…' : ''}"`);
    }
    const top = sorted[0][0];
    console.log('');
    if (/timed out/.test(top)) {
      console.log('Most failures are timeouts: the model is slower than the time limit.');
      console.log('A timed-out request is now retried once at double the deadline, so re-running');
      console.log('`scan` will recover many of these. If they still fail, the model is slower than');
      console.log('2x your timeout — raise "timeoutMs" in Settings, or pick a faster model.');
    } else if (/JSON/.test(top)) {
      console.log('Most failures are unusable output, not speed. This usually means the model');
      console.log('spends its output budget "thinking" instead of answering, or ignores the JSON');
      console.log('format. Try a different (non-reasoning) model, or raise "maxTokens".');
    } else if (/429|Rate limited/.test(top)) {
      console.log('Most failures are rate limits. Lower "Requests per minute" in Settings.');
    } else if (/Auth/.test(top)) {
      console.log('Your API key is being rejected — re-enter it in Settings.');
    }
    console.log('\nRun `node src/cli.js doctor` to test a few cards live against your API.');
  }
}

async function cmdServe(args) {
  const config = await loadConfig(args);
  await mkdir(config.trashDir, { recursive: true });
  const { startServer } = await import('./server.js');
  await startServer(config);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'scan':
      await cmdScan(args);
      break;
    case 'stats':
      await cmdStats(args);
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case 'caches': {
      // "Where did my scores go?" — list every cache file and which folder it
      // describes, so a mismatch is visible instead of looking like data loss.
      const config = await loadConfig(args);
      const active = await resolveCacheFile(config.cacheFile, config.charactersDir);
      const all = await listCaches(config.cacheFile);
      console.log(`Active characters folder: ${config.charactersDir}`);
      console.log(`Active score data file:   ${active}\n`);
      if (!all.length) {
        console.log('No cache files found yet — nothing has been scored.');
        break;
      }
      console.log('All score data files found:');
      for (const c of all) {
        const mark = c.file === active ? '->' : '  ';
        console.log(`${mark} ${c.name}  ${String(c.cardCount).padStart(6)} cards`);
        console.log(`     folder: ${c.charactersDir || '(not recorded — written by an older version)'}`);
      }
      break;
    }
    case 'doctor': {
      const config = await loadConfig(args);
      const { runDoctor } = await import('./doctor.js');
      const { ok } = await runDoctor(config);
      if (!ok) process.exitCode = 1;
      break;
    }
    default:
      console.log(`SillyScoreReview — score & clean up SillyTavern character cards

Usage:
  node src/cli.js scan [--config config.json] [--dir <characters folder>] [--limit N] [--rescore] [--dry-run]
                        [--provider anthropic|openai|local|mock] [--model NAME] [--api-key KEY] [--base-url URL]
                        [--concurrency N]
  node src/cli.js doctor [--config config.json]
        Tests a few real cards against your API and explains what is slow or failing.
        Run this FIRST if a scan is crawling.

  node src/cli.js caches [--config config.json]
        Lists every score-data file and which characters folder each belongs to.
        Use this if scores look like they vanished.

  node src/cli.js stats [--config config.json]
  node src/cli.js serve [--config config.json] [--port 4180]

Copy config.example.json to config.json and edit it first — see README.md.`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
