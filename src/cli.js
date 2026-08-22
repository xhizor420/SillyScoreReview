#!/usr/bin/env node
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider } from './llmClient.js';
import { scoreCard, DEFAULT_WEIGHTS } from './scorer.js';
import { Store } from './store.js';
import { runPool } from './concurrency.js';

const DEFAULT_CONFIG = {
  charactersDir: './characters',
  cacheFile: './data/cache.json',
  trashDir: './data/trash',
  provider: 'anthropic',
  model: undefined,
  apiKey: undefined,
  baseURL: undefined,
  concurrency: 3,
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
  const store = await new Store(config.cacheFile).load();
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
  console.log(`Using provider "${provider.name}" (model: ${provider.model}), concurrency ${config.concurrency}.`);

  let done = 0;
  let errors = 0;
  await runPool(work, config.concurrency, async ({ file, card, hash }) => {
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
      console.log(`[${done + errors}/${work.length}] ✓ ${card.name} — overall ${result.overall_score}/10  (${file})`);
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
      console.error(`[${done + errors}/${work.length}] ✗ ${card.name} — ${err.message}  (${file})`);
    }
  });

  console.log(`\nDone. ${done} scored, ${errors} errors. Re-run scan to retry errors.`);
}

async function cmdStats(args) {
  const config = await loadConfig(args);
  const store = await new Store(config.cacheFile).load();
  const entries = Object.values(store.all());
  const buckets = {};
  let sum = 0;
  let scored = 0;
  for (const e of entries) {
    const score = e.result?.overall_score ?? null;
    const bucket = e.error ? 'error' : scoreBucket(score);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    if (score != null) {
      sum += score;
      scored++;
    }
  }
  console.log(`Total cached entries: ${entries.length}`);
  console.log(`Scored successfully: ${scored}${scored ? `, average overall score: ${(sum / scored).toFixed(2)}` : ''}`);
  for (const [bucket, count] of Object.entries(buckets)) {
    console.log(`  ${bucket}: ${count}`);
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
    default:
      console.log(`SillyScoreReview — score & clean up SillyTavern character cards

Usage:
  node src/cli.js scan [--config config.json] [--dir <characters folder>] [--limit N] [--rescore] [--dry-run]
                        [--provider anthropic|openai|local|mock] [--model NAME] [--api-key KEY] [--base-url URL]
                        [--concurrency N]
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
