#!/usr/bin/env node
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import net from 'node:net';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider, resolveConcurrency } from './llmClient.js';
import { scoreCard, DEFAULT_WEIGHTS } from './scorer.js';
import { Store } from './store.js';
import { runPool } from './concurrency.js';
import { classifyError } from './errorKinds.js';
import { resolveCacheFile, listCaches } from './cachePath.js';
import { mergeCaches } from './mergeCaches.js';
import { importScores } from './importScores.js';

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
    case 'import-scores': {
      const config = await loadConfig(args);
      const file = args._[0];
      if (!file) {
        console.error('Usage: node src/cli.js import-scores <recovered-scores.json> [--dry-run] [--overwrite]');
        process.exitCode = 1;
        break;
      }
      // Look everywhere someone might reasonably have put it: the project
      // folder, the data folder (next to the cache it restores), and Downloads
      // where the browser actually saved it.
      const base = path.basename(file);
      const candidates = [
        path.resolve(process.cwd(), file),
        path.resolve(process.cwd(), 'data', base),
        path.resolve(path.dirname(config.cacheFile), base),
        path.join(os.homedir(), 'Downloads', base),
        path.join(os.homedir(), 'Desktop', base),
      ];
      let found = null;
      for (const c of candidates) {
        try {
          await readFile(c);
          found = c;
          break;
        } catch {
          // keep looking
        }
      }
      if (!found) {
        console.error(`Could not find "${file}". Looked in:`);
        for (const c of [...new Set(candidates)]) console.error(`  ${c}`);
        console.error('\nPass the full path instead, e.g.:');
        console.error('  node src/cli.js import-scores "C:\\Users\\You\\Downloads\\recovered-scores.json"');
        process.exitCode = 1;
        break;
      }
      if (found !== candidates[0]) console.log(`Found: ${found}\n`);

      // The dashboard server keeps the score file in memory and rewrites the
      // whole thing on its next save — so importing underneath a running server
      // gets silently undone the moment it scores or deletes anything.
      const serverUp = await new Promise((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: config.port, timeout: 700 });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
      });
      if (serverUp && !args.force) {
        console.error(`The dashboard server is still running on port ${config.port}.`);
        console.error('It holds the score file in memory and would overwrite this import');
        console.error('the next time it saves. Close that window (the one running the');
        console.error('server), then run this command again.');
        console.error('\n(Use --force to import anyway, if you know the server is idle.)');
        process.exitCode = 1;
        break;
      }

      const raw = await readFile(found, 'utf8');
      console.log(`File   : ${found} (${(raw.length / 1024).toFixed(1)} KB)`);
      console.log(`Folder : ${config.charactersDir}`);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        console.error(`\nThat file is not valid JSON: ${err.message}`);
        console.error('It should start with { and end with }. If you saved it by hand,');
        console.error('re-run the recovery snippet or the Export scores button.');
        process.exitCode = 1;
        break;
      }
      const r = await importScores({
        cacheFile: config.cacheFile,
        charactersDir: config.charactersDir,
        payload,
        dryRun: Boolean(args['dry-run']),
        overwrite: Boolean(args.overwrite),
      });
      console.log(`Target : ${r.dest}`);
      console.log(`${args['dry-run'] ? '\nDRY RUN — nothing written.' : ''}\n`);
      console.log(`  scores in file        : ${r.total}`);
      console.log(`  card files in folder  : ${r.onDiskCount}`);
      console.log(`  imported              : ${r.imported}`);
      if (r.skippedExisting) console.log(`  skipped (already have a full result) : ${r.skippedExisting}`);
      if (r.notFound) {
        console.log(`  no matching card file : ${r.notFound}`);
        if (r.missing.length) console.log(`     e.g. ${r.missing.join(', ')}`);
      }
      if (r.imported === 0) {
        // A bare "0" here is the least useful possible answer — say which of the
        // three reasons it was.
        console.log('\nNothing was imported. Why:');
        if (r.skippedExisting === r.total) {
          console.log(`  All ${r.total} cards already have a full score with critique in`);
          console.log('  this data file, so there was nothing to restore. Your scores are');
          console.log('  already there — check with: node src/cli.js stats');
        } else if (r.notFound === r.total) {
          console.log(`  None of the ${r.total} cards in the file match a card in:`);
          console.log(`    ${config.charactersDir}`);
          console.log('  That is usually the wrong characters folder. Check the folder shown');
          console.log('  by: node src/cli.js caches   — and switch to the right one if needed.');
        } else {
          console.log(`  ${r.skippedExisting} already had full results, ${r.notFound} matched no card file.`);
        }
        // Show both sides so a naming mismatch is obvious rather than inferred.
        console.log(`\n  first entries in your file : ${r.sampleFromFile.join(', ')}`);
        console.log(`  first card files on disk   : ${r.sampleOnDisk.join(', ') || '(folder is empty)'}`);
      } else {
        console.log('\nImported cards count as scored and will NOT be re-scanned.');
        console.log('They show their score but no written critique — rescore individually if you want the detail.');
        console.log('\nRefresh the dashboard in your browser to see them.');
      }
      if (args['dry-run']) console.log('\nRe-run without --dry-run to apply.');
      break;
    }
    case 'merge-caches': {
      const config = await loadConfig(args);
      const dryRun = Boolean(args['dry-run']);
      const prune = !args['no-prune'];
      const r = await mergeCaches({ cacheFile: config.cacheFile, charactersDir: config.charactersDir, prune, dryRun });

      console.log(`${dryRun ? 'DRY RUN — nothing written.\n' : ''}Merging into: ${r.dest}\n`);
      if (!r.sources.length) {
        console.log('No other cache files to merge — there is only one.');
      } else {
        for (const s2 of r.sources) {
          console.log(`  from ${s2.name}: ${s2.total} entries -> ${s2.added} new, ${s2.upgraded} replaced an error/older score`);
        }
      }
      console.log('');
      console.log(`  entries before : ${r.before}`);
      console.log(`  added          : ${r.added}`);
      console.log(`  upgraded       : ${r.upgraded}`);
      if (r.pruned > 0) console.log(`  pruned         : ${r.pruned} (cards no longer in the folder)`);
      else if (r.pruned === -1) console.log('  pruned         : skipped (could not read the characters folder)');
      console.log(`  entries after  : ${r.after}   (${r.scored} scored, ${r.failed} failed)`);
      if (r.backup) console.log(`\n  backup of the previous file: ${r.backup}`);
      if (dryRun) console.log('\nRe-run without --dry-run to apply.');
      break;
    }
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

  node src/cli.js import-scores <file.json> [--dry-run] [--overwrite]
        Restores score numbers recovered from an open dashboard tab.
        See recover-scores-snippet.js for how to get that file.

  node src/cli.js merge-caches [--config config.json] [--dry-run] [--no-prune]
        Combines all score-data files into the one for your current folder,
        keeping the best entry per card, and drops entries for deleted cards.
        Backs up the existing file first.

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
