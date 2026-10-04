import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rename, unlink, stat, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider, listModels, resolveConcurrency, PROVIDER_PRESETS } from './llmClient.js';
import { scoreCard, buildScoringPrompts, ask } from './scorer.js';
import { improveCard, buildImprovePrompts, generateIdeas, buildIdeasPrompts } from './improver.js';
import {
  PROMPT_KINDS, DEFAULT_PROMPTS, instructionsFor, systemPrompt, promptHash,
  validateInstructions, adviseInstructions,
} from './prompts.js';
import { serializeCard } from './cardWriter.js';
import { Store, flushOnExit } from './store.js';
import { runQueue } from './concurrency.js';
import { resolveCacheFile } from './cachePath.js';
import { classifyError, isRunLevelError, fatalReason, isConnectivityError } from './errorKinds.js';
import { snapshotCache, listBackups } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Resolves `name` inside `dir`, rejecting any path traversal attempt. */
function safeJoin(dir, name) {
  const resolved = path.resolve(dir, name);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error('Invalid path');
  }
  return resolved;
}

export async function startServer(config) {
  await mkdir(config.trashDir, { recursive: true });
  const jobs = new Map();
  const controls = new Map(); // jobId -> { openGate, resume } for a live scan

  // A scan/browse against one folder shouldn't see cached scores that
  // belong to a same-named file in a folder you switched away from, so
  // each characters folder the picker has pointed at gets its own cache
  // file (auto-derived next to the configured one, keyed by folder path).
  const stores = new Map();
  async function getStore(charactersDir) {
    const key = path.resolve(charactersDir);
    let store = stores.get(key);
    if (!store) {
      const file = await resolveCacheFile(config.cacheFile, key);
      // Snapshot before this process starts writing to it. Scores are hours of
      // API time; one bad session should never be able to be the end of them.
      await snapshotCache(file, { reason: 'startup' });
      store = await new Store(file, key).load();
      stores.set(key, store);
      // Closing the dashboard window is how most people stop it — make sure
      // that never drops results still waiting in the write batch.
      flushOnExit(store);
    }
    return store;
  }

  // One provider — and so one rate limiter — for the whole server. Each
  // createProvider() gets its own limiter, so a scan, a rescore from the card
  // popup and an "Improve" running at once used to each pace independently and
  // could together exceed the provider's published limit. Rebuilt only when a
  // setting that affects requests changes.
  let sharedProvider = null;
  let sharedSignature = null;
  function getProvider() {
    const signature = JSON.stringify([
      config.provider, config.baseURL, config.apiKey, config.model, config.requestsPerMinute,
      config.burst, config.timeoutMs, config.maxTokens, config.temperature,
    ]);
    if (!sharedProvider || signature !== sharedSignature) {
      sharedProvider = createProvider(config);
      sharedSignature = signature;
    }
    return sharedProvider;
  }

  /**
   * Was this score produced by a different prompt than the one now in effect?
   * Scores from before prompts were editable carry no fingerprint; they were
   * necessarily made with the default, so they are compared as such.
   */
  function isPromptStale(entry) {
    const result = entry?.result;
    if (!result || result.partial) return false;
    const kind = result.brief ? 'fast' : 'full';
    const used = result.promptHash ?? promptHash(DEFAULT_PROMPTS[kind]);
    return used !== promptHash(systemPrompt(kind, config.prompts));
  }

  function cardSummary(file, entry) {
    return {
      id: file,
      name: entry?.name || file,
      tokenEstimate: entry?.tokenEstimate ?? null,
      overallScore: entry?.result?.overall_score ?? null,
      scoredAt: entry?.scoredAt ?? null,
      provider: entry?.provider ?? null,
      error: entry?.error ?? null,
      previousScore: entry?.previousScore ?? null,
      improvedFrom: entry?.improvedFrom ?? null,
      brief: Boolean(entry?.result?.brief),
      promptStale: isPromptStale(entry),
      isImage: /\.png$/i.test(file),
    };
  }

  async function readCardOrThrow(file) {
    const filePath = safeJoin(config.charactersDir, file);
    const buf = await readFile(filePath);
    const card = parseCardFile(buf, file);
    return { filePath, buf, card, hash: hashCard(card) };
  }

  /** Read-modify-write a patch of fields into config.json on disk, tolerating a missing file. */
  async function persistConfigPatch(patch) {
    let onDisk = {};
    try {
      onDisk = JSON.parse(await readFile(config.configPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    Object.assign(onDisk, patch);
    await mkdir(path.dirname(config.configPath), { recursive: true });
    await writeFile(config.configPath, JSON.stringify(onDisk, null, 2));
  }

  async function scoreOne(file, provider, store, detail = config.scoreDetail || 'full') {
    let card;
    let hash;
    try {
      ({ card, hash } = await readCardOrThrow(file));
    } catch (err) {
      // Deleting a card while a scan is running is a normal thing to do — you
      // spot garbage in the results and cull it. The in-flight worker then hits
      // a missing file; recording that as a scoring error would leave a phantom
      // entry for a card that no longer exists, inflating the failure count
      // forever. Drop the entry instead.
      if (err.code === 'ENOENT') {
        store.stageDelete(file);
        const gone = new Error('Card was deleted during the scan');
        gone.cardDeleted = true;
        throw gone;
      }
      throw err;
    }

    try {
      const result = await scoreCard(card, provider, { weights: config.weights, detail, prompts: config.prompts });
      const entry = {
        hash,
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        detail,
        result,
        error: null,
      };
      // Not awaited: the entry is in memory immediately and the write is
      // coalesced with the other cards finishing around it. Every path that
      // ends a run flushes, so nothing is left unwritten.
      store.set(file, entry);
      return entry;
    } catch (err) {
      // A run-level problem (API key rejected, out of credits, network down) is
      // not this card's fault and says nothing about it — record nothing, so
      // the card is exactly as it was and simply gets picked up again.
      if (isRunLevelError(err)) throw err;

      // A failed *re*score must never destroy the score it was replacing. It
      // used to: the error entry overwrote the result, so a "Rescore all" with
      // an expired key, or a rescore that timed out, wiped good scores.
      // Keep the existing result and note the failed attempt beside it.
      const previous = store.get(file);
      if (previous?.result && previous.hash === hash) {
        store.set(file, { ...previous, lastError: err.message, lastErrorAt: new Date().toISOString() });
        throw err;
      }

      const entry = {
        hash,
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        result: null,
        error: err.message,
      };
      store.set(file, entry);
      throw err;
    }
  }

  const app = express();
  app.use(express.json());
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // Optional shared-secret gate for the data API. Leave config.authToken empty
  // for pure-localhost use; set it once this dashboard is reachable from other
  // machines (e.g. over Tailscale) so a random device on your tailnet can't
  // browse/delete your cards.
  app.use('/api', (req, res, next) => {
    if (!config.authToken) return next();
    const provided = req.header('x-auth-token') || req.query.token;
    if (provided === config.authToken) return next();
    res.status(401).json({ error: 'Missing or invalid auth token' });
  });

  app.use(express.static(PUBLIC_DIR));

  app.get('/api/cards', async (req, res) => {
    let files;
    try {
      files = (await readdir(config.charactersDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      return res.status(500).json({ error: `Cannot read characters directory: ${err.message}` });
    }
    const store = await getStore(config.charactersDir);
    const cards = files.map((file) => cardSummary(file, store.get(file)));
    res.json({ charactersDir: config.charactersDir, cards });
  });

  app.get('/api/cards/:id', async (req, res) => {
    const file = req.params.id;
    try {
      const store = await getStore(config.charactersDir);
      const entry = store.get(file);
      const { card } = await readCardOrThrow(file);
      res.json({ id: file, name: card.name, fields: card.fields, tags: card.tags, entry: entry || null });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.get('/api/cards/:id/image', async (req, res) => {
    try {
      const filePath = safeJoin(config.charactersDir, req.params.id);
      if (!/\.png$/i.test(filePath)) return res.status(204).end();

      // Card art never changes unless the file does, so let the browser cache it.
      // Without this every grid re-render refetched every thumbnail — with a few
      // thousand cards that's hundreds of full-file reads per second competing
      // with the scoring pool on the same single-threaded server.
      const st = await stat(filePath);
      const etag = `W/"${st.size}-${st.mtimeMs}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=300');
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      res.type('png').send(await readFile(filePath));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/cards/:id/score', async (req, res) => {
    try {
      const store = await getStore(config.charactersDir);
      const provider = getProvider();
      const detail = req.body?.detail === 'full' || req.body?.detail === 'fast' ? req.body.detail : undefined;
      const entry = await scoreOne(req.params.id, provider, store, detail ?? (config.scoreDetail || 'full'));
      await store.flush(); // a single card is an interactive action — make it durable before replying
      res.json({ id: req.params.id, entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Step 1 of improving a card: what makes it itself (kept in any rewrite) and
  // a menu of specific changes to choose from. Nothing is written.
  app.post('/api/cards/:id/ideas', async (req, res) => {
    const file = req.params.id;
    try {
      const store = await getStore(config.charactersDir);
      const { card } = await readCardOrThrow(file);
      const entry = store.get(file);
      const ideas = await generateIdeas(card, entry?.result, getProvider(), { prompts: config.prompts });
      res.json({
        id: file,
        name: card.name,
        previousScore: entry?.result?.overall_score ?? null,
        hadCritique: Boolean(entry?.result && !entry.result.partial && !entry.result.brief),
        ...ideas,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, kind: classifyError(err.message) });
    }
  });

  // Ask the model to rewrite the weak parts of a card, informed by its own
  // critique. Nothing is written here: the proposal comes back for review (and
  // hand-editing) first, because an unreviewed automatic rewrite of someone's
  // favourite character is exactly the wrong default.
  app.post('/api/cards/:id/improve', async (req, res) => {
    const file = req.params.id;
    try {
      const store = await getStore(config.charactersDir);
      const { card } = await readCardOrThrow(file);
      const entry = store.get(file);
      const provider = getProvider();
      const fields = Array.isArray(req.body?.fields) && req.body.fields.length ? req.body.fields : null;
      // The ideas the owner ticked, plus the keep list (possibly edited by them).
      const plan = Array.isArray(req.body?.ideas) && req.body.ideas.length
        ? {
            ideas: req.body.ideas,
            keep: Array.isArray(req.body.keep) ? req.body.keep.map(String).filter(Boolean) : [],
            keepQuotes: Array.isArray(req.body.keepQuotes) ? req.body.keepQuotes.map(String).filter(Boolean) : [],
          }
        : null;
      const proposal = await improveCard(card, entry?.result, provider, { fields, prompts: config.prompts, plan });
      const before = {};
      for (const field of Object.keys(proposal.fields)) before[field] = card.fields[field] || '';
      res.json({
        id: file,
        name: card.name,
        hadCritique: Boolean(entry?.result && !entry.result.partial),
        previousScore: entry?.result?.overall_score ?? null,
        before,
        ...proposal,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, kind: classifyError(err.message) });
    }
  });

  /** Picks a free filename next to `file`, e.g. "Raven.png" -> "Raven (improved).png". */
  async function freeFilename(base, ext, suffix) {
    for (let n = 0; n < 200; n++) {
      const name = n === 0 ? `${base}${suffix}${ext}` : `${base}${suffix} ${n + 1}${ext}`;
      try {
        await stat(safeJoin(config.charactersDir, name));
      } catch {
        return name;
      }
    }
    return `${base}${suffix} ${Date.now()}${ext}`;
  }

  // Writes edited field text back into a card. Used by the improve review step
  // and by hand-editing a card in the dashboard — same path, same safeguards.
  app.post('/api/cards/:id/save', async (req, res) => {
    const file = req.params.id;
    const { fields = {}, name, mode = 'new', rescore = false } = req.body || {};
    const lorebookEntries = Array.isArray(req.body?.lorebookEntries)
      ? req.body.lorebookEntries
          .map((e) => ({
            keys: (Array.isArray(e?.keys) ? e.keys : String(e?.keys ?? '').split(','))
              .map((k) => String(k).trim()).filter(Boolean),
            content: String(e?.content ?? '').trim(),
          }))
          .filter((e) => e.keys.length && e.content)
      : [];
    if (!fields || typeof fields !== 'object' || (!Object.keys(fields).length && !lorebookEntries.length)) {
      return res.status(400).json({ error: 'No edited fields were sent' });
    }
    if (mode !== 'new' && mode !== 'replace') {
      return res.status(400).json({ error: `Unknown save mode "${mode}"` });
    }

    try {
      const store = await getStore(config.charactersDir);
      const { buf, card } = await readCardOrThrow(file);
      const previousScore = store.get(file)?.result?.overall_score ?? null;

      const { bytes } = serializeCard({ filename: file, originalBuffer: buf, raw: card.raw, fields, name, lorebookEntries });

      let targetFile = file;
      let backedUpAs = null;
      if (mode === 'new') {
        const ext = path.extname(file);
        targetFile = await freeFilename(file.slice(0, file.length - ext.length), ext, ' (improved)');
      } else {
        // Replacing in place keeps a restorable copy of the original in trash,
        // so an edit that turns out worse is never a one-way door.
        backedUpAs = `${Date.now()}-before-edit-${file}`;
        await copyFile(safeJoin(config.charactersDir, file), safeJoin(config.trashDir, backedUpAs));
      }

      const targetPath = safeJoin(config.charactersDir, targetFile);
      await writeFile(`${targetPath}.tmp`, bytes);
      await rename(`${targetPath}.tmp`, targetPath);

      // The file changed, so any score attached to it is no longer about this
      // text. Drop the stale result but remember what it used to score, so the
      // before/after is visible instead of lost.
      const { card: savedCard, hash } = await readCardOrThrow(targetFile);
      store.stage(targetFile, {
        hash,
        name: savedCard.name,
        tokenEstimate: totalCardTokens(savedCard),
        scoredAt: null,
        provider: null,
        model: null,
        result: null,
        error: null,
        previousScore,
        improvedFrom: mode === 'new' ? file : null,
        editedAt: new Date().toISOString(),
      });
      await store.save();

      let entry = store.get(targetFile);
      if (rescore) {
        try {
          const scored = await scoreOne(targetFile, getProvider(), store);
          entry = { ...scored, previousScore, improvedFrom: mode === 'new' ? file : null };
          await store.set(targetFile, entry);
        } catch (err) {
          // The save itself succeeded; a failed score is a separate, retryable problem.
          entry = { ...store.get(targetFile), scoreError: err.message };
        }
      }

      res.json({ file: targetFile, mode, backedUpAs, previousScore, entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Records a failure against a card when the scorer itself could not (a card
   * that kept failing to connect while others got through). Like scoreOne, it
   * never throws away a score the card already had.
   */
  function markFailed(store, file, err) {
    const previous = store.get(file);
    if (previous?.result) {
      store.set(file, { ...previous, lastError: err.message, lastErrorAt: new Date().toISOString() });
    } else {
      store.set(file, { ...(previous || {}), name: previous?.name || file, result: null, error: err.message, scoredAt: new Date().toISOString() });
    }
  }

  /** The scan currently in progress (running, paused or waiting), if any. */
  function activeJob() {
    return [...jobs.values()].find((j) => j.status === 'running') || null;
  }

  app.get('/api/score/active', (req, res) => {
    const job = activeJob();
    res.json({ jobId: job?.id ?? null });
  });

  app.post('/api/score/batch', async (req, res) => {
    // One scan at a time. Two at once — the dashboard open on a phone and a PC,
    // or a reload and "Scan unscored" again — would each pace themselves to the
    // provider's limit and together send double it. Hand back the running scan
    // so the caller can attach to it instead.
    const running = activeJob();
    if (running) {
      return res.status(409).json({
        error: 'A scan is already running. Showing that one instead of starting a second.',
        jobId: running.id,
        total: running.total,
      });
    }
    const { ids, scope = 'selected', limit, rescore = false } = req.body || {};
    const detail = req.body?.detail === 'full' || req.body?.detail === 'fast'
      ? req.body.detail
      : config.scoreDetail || 'full';
    let files;
    let store;
    try {
      store = await getStore(config.charactersDir);
      const all = (await readdir(config.charactersDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
        .map((e) => e.name)
        .sort();
      if (scope === 'selected') {
        files = (ids || []).filter((f) => all.includes(f));
      } else if (scope === 'unscored') {
        files = all.filter((f) => {
          const entry = store.get(f);
          return !entry || entry.error;
        });
      } else if (scope === 'uncritiqued') {
        // Everything still waiting for a written critique: never scored, failed,
        // or only fast-scored. The second pass after fast-scoring and culling.
        files = all.filter((f) => {
          const entry = store.get(f);
          return !entry || entry.error || !entry.result || entry.result.brief;
        });
      } else {
        files = all;
      }
      if (!rescore && scope !== 'uncritiqued') {
        files = files.filter((f) => {
          const entry = store.get(f);
          return !entry || entry.error;
        });
      }
      if (limit) files = files.slice(0, Number(limit));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // "Rescore all" overwrites every existing result. Snapshot first so the
    // previous run's scores survive a rescore you didn't mean to start.
    if (rescore && files.length > 1) {
      await snapshotCache(store.filePath, { reason: 'before-rescore' });
    }

    const jobId = randomUUID();
    const job = {
      id: jobId,
      total: files.length,
      done: 0,
      errors: 0,
      status: 'running',
      results: [],
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      concurrency: resolveConcurrency(config).concurrency,
      model: config.model || null,
      detail,
      inFlight: 0,
      skipped: 0,       // cards never started because the scan was stopped
      cancelRequested: false,
      // Run-level supervision (see the runner below):
      state: 'running', // running | paused (fatal: key/credits/model) | waiting (outage)
      pauseKind: null,
      pauseReason: null,
      waitingSince: null,
      nextProbeAt: null,
      outages: 0,
      connStreak: 0,
      phase: 'main',    // main | retrying (the automatic second pass)
      retryTotal: 0,
      recovered: 0,
      active: [],       // cards currently awaiting a response, with elapsed time
      recent: [],       // rolling feed of the last few completions
      latencies: [],    // per-card wall time, for a live median
    };
    jobs.set(jobId, job);
    res.json({ jobId, total: files.length });

    (async () => {
      let provider;
      try {
        provider = getProvider();
      } catch (err) {
        job.status = 'error';
        job.fatalError = err.message;
        return;
      }

      // --- the gate: closed while paused or waiting, so nothing is sent ---
      let gatePromise = null;
      let release = null;
      const closeGate = () => {
        if (!gatePromise) gatePromise = new Promise((r) => { release = r; });
      };
      const openGate = () => {
        if (release) release();
        gatePromise = null;
        release = null;
      };
      const gate = () => gatePromise;

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const probeBaseMs = config.outageProbeMs ?? 5000;

      // Every remaining card would fail the same way (rejected key, empty
      // balance, unknown model). Stop sending, say why, wait for Resume.
      const pause = (fatal) => {
        if (job.state === 'paused') return;
        job.state = 'paused';
        job.pauseKind = fatal.kind;
        job.pauseReason = fatal.message;
        closeGate();
      };

      // The provider can't be reached. Stop sending, watch for it to come
      // back with a free request, and carry on by itself when it does.
      const startWaiting = () => {
        if (job.state !== 'running') return;
        job.state = 'waiting';
        job.waitingSince = Date.now();
        job.outages++;
        closeGate();
        (async () => {
          let delay = probeBaseMs;
          while (job.state === 'waiting' && !job.cancelRequested) {
            job.nextProbeAt = Date.now() + delay;
            await sleep(delay);
            if (job.state !== 'waiting' || job.cancelRequested) return;
            const result = provider.probe ? await provider.probe() : { reachable: true };
            if (result.reachable) {
              job.state = 'running';
              job.waitingSince = null;
              job.nextProbeAt = null;
              job.connStreak = 0;
              openGate();
              return;
            }
            delay = Math.min(30_000, Math.round(delay * 1.5));
          }
        })();
      };

      controls.set(job.id, {
        openGate,
        resume: () => {
          // Settings may have changed (new key, new model) — pick them up.
          provider = getProvider();
          job.state = 'running';
          job.pauseKind = null;
          job.pauseReason = null;
          openGate();
        },
      });

      const outageRequeues = new Map();   // file -> times handed back because of an outage
      const retryCandidates = [];         // cards that failed in a way worth one more try
      const retrying = new Set();         // cards on that second pass

      // Failed for reasons that may well not recur: slow model, cut-off JSON,
      // a provider hiccup. A card with no text, or a 400, would just fail again.
      const worthRetrying = (err) =>
        err.isTimeout || err.status === 429 || err.status >= 500 ||
        /parseable JSON|did not return/i.test(err.message || '');

      const worker = async (file, { requeue }) => {
        // A 3,000-card scan is a multi-hour commitment. Being able to stop it
        // without killing the server (and losing the scores already written)
        // is not a nicety.
        if (job.cancelRequested) {
          job.skipped++;
          return;
        }
        const startedMs = Date.now();
        job.inFlight++;
        job.active.push({ file, startedMs });
        const leave = () => {
          job.inFlight--;
          job.active = job.active.filter((a) => a.file !== file);
        };
        const settle = (outcome) => {
          leave();
          const tookMs = Date.now() - startedMs;
          job.latencies.push(tookMs);
          if (job.latencies.length > 200) job.latencies.shift();
          job.recent.unshift({ ...outcome, file, tookMs });
          if (job.recent.length > 12) job.recent.pop();
        };
        try {
          const entry = await scoreOne(file, provider, store, detail);
          job.connStreak = 0;
          job.done++;
          if (retrying.has(file)) {
            job.errors--;
            job.recovered++;
          }
          // Checkpoint a long run periodically, so a scan interrupted after
          // hours leaves a snapshot behind and not just a live file.
          // Flush first, or the snapshot would copy a file that is up to one
          // coalescing window behind what has actually been scored.
          if (job.done % 250 === 0) {
            store.flush().then(() => snapshotCache(store.filePath, { reason: 'scan-checkpoint' }));
          }
          const outcome = { name: entry.name, overallScore: entry.result.overall_score };
          job.results.push({ file, ...outcome });
          settle(outcome);
        } catch (err) {
          if (err.cardDeleted) {
            // You deleted it mid-scan; that is not a failure, just less work.
            job.total = Math.max(0, job.total - 1);
            leave();
            return;
          }

          const fatal = fatalReason(err);
          if (fatal) {
            leave();
            requeue(file); // not this card's fault — it goes back in line untouched
            pause(fatal);
            return;
          }

          if (isConnectivityError(err)) {
            const n = (outageRequeues.get(file) || 0) + 1;
            outageRequeues.set(file, n);
            if (n <= 3) {
              leave();
              requeue(file);
              // The request already retried for ~20s before getting here, so
              // two cards in a row coming back like this is an outage.
              if (++job.connStreak >= 2) startWaiting();
              return;
            }
            // The same card failing to connect again and again while others
            // get through is about that card, not the network.
            markFailed(store, file, err);
          } else {
            job.connStreak = 0;
          }

          if (!retrying.has(file)) {
            job.errors++;
            if (worthRetrying(err)) retryCandidates.push(file);
          }
          job.results.push({ file, error: err.message });
          settle({ error: err.message });
        }
      };

      await runQueue(files, job.concurrency, worker, { gate });

      // One automatic second pass over cards that failed for transient
      // reasons, so a run ends with as many scores as it can get instead of
      // asking you to press "Scan unscored" afterwards. Cards that fail twice
      // stay failed and keep any score they already had.
      if (!job.cancelRequested && retryCandidates.length) {
        job.phase = 'retrying';
        job.retryTotal = retryCandidates.length;
        for (const f of retryCandidates) retrying.add(f);
        await runQueue(retryCandidates, job.concurrency, worker, { gate });
      }

      controls.delete(job.id);
      await store.flush();
      job.status = job.cancelRequested ? 'stopped' : 'done';
      job.state = 'running';
      job.finishedAt = new Date().toISOString();
    })();
  });

  app.get('/api/score/batch/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job id' });

    const finished = job.done + job.errors;
    const elapsedMs = Date.now() - job.startedAtMs;
    const perHour = elapsedMs > 3000 && finished > 0 ? finished / (elapsedMs / 3_600_000) : null;
    const sorted = [...job.latencies].sort((a, b) => a - b);
    const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const now = Date.now();

    // Deliberately omits `results` (one entry per card — megabytes on a big run)
    // since this is polled every couple of seconds.
    res.json({
      id: job.id,
      status: job.status,
      fatalError: job.fatalError ?? null,
      total: job.total,
      done: job.done,
      errors: job.errors,
      skipped: job.skipped,
      stopping: job.cancelRequested && job.status === 'running',
      inFlight: job.inFlight,
      concurrency: job.concurrency,
      model: job.model,
      detail: job.detail,
      elapsedMs,
      perHour,
      medianLatencyMs: medianMs,
      etaMs: perHour && perHour > 0 ? ((job.total - finished) / perHour) * 3_600_000 : null,
      active: job.active.map((a) => ({ file: a.file, elapsedMs: now - a.startedMs })),
      recent: job.recent,
      state: job.state,
      pauseKind: job.pauseKind,
      pauseReason: job.pauseReason,
      waitingForMs: job.waitingSince ? now - job.waitingSince : null,
      nextProbeInMs: job.nextProbeAt ? Math.max(0, job.nextProbeAt - now) : null,
      outages: job.outages,
      phase: job.phase,
      retryTotal: job.retryTotal,
      recovered: job.recovered,
      pacing: sharedProvider?.limiter?.stats?.() ?? null,
    });
  });

  // Carry on after a pause — typically once the API key or balance is fixed
  // in Settings, which resume() picks up.
  app.post('/api/score/batch/:jobId/resume', (req, res) => {
    const job = jobs.get(req.params.jobId);
    const control = controls.get(req.params.jobId);
    if (!job || !control) return res.status(404).json({ error: 'No live scan with that id' });
    try {
      control.resume();
    } catch (err) {
      return res.status(400).json({ error: `Could not resume: ${err.message}` });
    }
    res.json({ id: job.id, state: job.state });
  });

  // Stops a scan without stopping the server. Cards already scored stay scored
  // — every result is written to the cache as it lands — and the cards that
  // never started are simply still unscored, so "Scan unscored" picks up
  // exactly where this left off.
  app.post('/api/score/batch/:jobId/stop', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job id' });
    job.cancelRequested = true;
    // A paused or waiting scan has its workers parked at the gate; let them
    // through so they see the stop and wind down.
    job.state = 'running';
    controls.get(job.id)?.openGate();
    res.json({ id: job.id, status: job.status, inFlight: job.inFlight });
  });

  app.post('/api/cards/delete', async (req, res) => {
    const { ids = [] } = req.body || {};
    const store = await getStore(config.charactersDir);
    const moved = [];
    const errors = [];
    for (const file of ids) {
      try {
        const src = safeJoin(config.charactersDir, file);
        let destName = file;
        let dest = safeJoin(config.trashDir, destName);
        try {
          await stat(dest);
          destName = `${Date.now()}-${file}`;
          dest = safeJoin(config.trashDir, destName);
        } catch {
          // no collision, use original name
        }
        await rename(src, dest);
        store.stageDelete(file);
        moved.push({ file, trashedAs: destName });
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }
    // One write for the whole batch, not one per card.
    await store.flush();
    res.json({ moved, errors });
  });

  // Copy (never move) selected cards into another folder, so a curated "keepers"
  // set can be built up without touching the library being reviewed. Scores
  // travel with the cards: the destination folder's own cache gets an entry for
  // each copied file, so pointing the tool at that folder later still shows what
  // every card scored instead of demanding a full rescan.
  app.post('/api/cards/copy', async (req, res) => {
    const { ids = [], destination = '' } = req.body || {};
    const target = path.resolve(String(destination));
    if (!destination) return res.status(400).json({ error: 'No destination folder given' });
    if (target === path.resolve(config.charactersDir)) {
      return res.status(400).json({ error: 'Destination is the folder you are reviewing — pick a different one.' });
    }

    try {
      await mkdir(target, { recursive: true });
      const st = await stat(target);
      if (!st.isDirectory()) throw new Error('Not a directory');
    } catch (err) {
      return res.status(400).json({ error: `Cannot use "${target}": ${err.message}` });
    }

    const store = await getStore(config.charactersDir);
    let destStore;
    try {
      destStore = await getStore(target);
    } catch {
      destStore = null; // copying still works even if the destination cache can't be opened
    }

    const copied = [];
    const skipped = [];
    const errors = [];

    for (const file of ids) {
      try {
        const src = safeJoin(config.charactersDir, file);
        let destName = file;
        let dest = safeJoin(target, destName);

        // Never overwrite. An identical file is already there → nothing to do.
        // A *different* file under the same name gets a suffix, so two unrelated
        // cards that happen to share a filename both survive.
        let alreadyThere = false;
        try {
          await stat(dest);
          const [a, b] = await Promise.all([readFile(src), readFile(dest)]);
          if (a.equals(b)) {
            alreadyThere = true;
          } else {
            const ext = path.extname(file);
            const base = file.slice(0, file.length - ext.length);
            let n = 2;
            for (;;) {
              destName = `${base} (${n})${ext}`;
              dest = safeJoin(target, destName);
              try {
                await stat(dest);
                n += 1;
              } catch {
                break;
              }
            }
          }
        } catch {
          // nothing at the destination name — copy straight across
        }

        if (alreadyThere) {
          skipped.push({ file, reason: 'already in destination' });
        } else {
          await copyFile(src, dest);
          copied.push({ file, copiedAs: destName });
        }

        const entry = store.get(file);
        if (destStore && entry && !destStore.get(destName)) {
          destStore.stage(destName, entry);
        }
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }

    if (destStore) {
      try {
        await destStore.save();
      } catch (err) {
        errors.push({ file: '(scores)', error: `Cards copied, but their scores could not be saved to the destination cache: ${err.message}` });
      }
    }

    res.json({ destination: target, copied, skipped, errors });
  });

  app.get('/api/backups', async (req, res) => {
    try {
      const store = await getStore(config.charactersDir);
      const all = await listBackups(config.cacheFile);
      const base = path.basename(store.filePath, '.json');
      res.json({
        liveFile: store.filePath,
        backups: all.filter((b) => b.name.startsWith(`${base}--`)),
        otherBackups: all.filter((b) => !b.name.startsWith(`${base}--`)).length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trash', async (req, res) => {
    try {
      const files = await readdir(config.trashDir);
      const items = await Promise.all(
        files.map(async (f) => {
          const s = await stat(safeJoin(config.trashDir, f));
          return { file: f, deletedAt: s.mtime };
        }),
      );
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trash/restore', async (req, res) => {
    const { files = [] } = req.body || {};
    const restored = [];
    const errors = [];
    for (const file of files) {
      try {
        const src = safeJoin(config.trashDir, file);
        const dest = safeJoin(config.charactersDir, file.replace(/^\d+-/, ''));
        await rename(src, dest);
        restored.push(file);
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }
    res.json({ restored, errors });
  });

  app.post('/api/trash/empty', async (req, res) => {
    try {
      const files = await readdir(config.trashDir);
      await Promise.all(files.map((f) => unlink(safeJoin(config.trashDir, f))));
      res.json({ deleted: files.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Grouped failure reasons for the whole cache, so the dashboard can explain
  // *why* cards failed rather than only how many.
  app.get('/api/failures', async (req, res) => {
    try {
      const store = await getStore(config.charactersDir);
      const groups = new Map();
      let failed = 0;
      let scored = 0;
      for (const entry of Object.values(store.all())) {
        if (entry?.error) {
          failed++;
          const kind = classifyError(entry.error);
          if (!groups.has(kind)) groups.set(kind, { kind, count: 0, sample: entry.error });
          groups.get(kind).count++;
        } else if (entry?.result) {
          scored++;
        }
      }
      res.json({
        scored,
        failed,
        groups: [...groups.values()].sort((a, b) => b.count - a.count),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- prompts: view, edit, preview, and try on a card before committing ----

  function promptPayload(kind) {
    const def = PROMPT_KINDS[kind];
    const instructions = instructionsFor(kind, config.prompts);
    return {
      kind,
      label: def.label,
      description: def.description,
      instructions,
      defaultInstructions: def.defaultInstructions,
      format: def.format,
      isCustom: instructions !== def.defaultInstructions,
      hash: promptHash(systemPrompt(kind, config.prompts)),
    };
  }

  app.get('/api/prompts', async (req, res) => {
    const kinds = Object.keys(PROMPT_KINDS).map(promptPayload);
    // How many existing scores were made with something other than today's
    // prompt — the number "Rescore stale" would cost.
    let stale = 0;
    try {
      const store = await getStore(config.charactersDir);
      stale = Object.values(store.all()).filter(isPromptStale).length;
    } catch {
      // no folder yet
    }
    res.json({ kinds, staleScores: stale });
  });

  app.post('/api/prompts/advise', (req, res) => {
    const { kind, instructions } = req.body || {};
    if (!PROMPT_KINDS[kind]) return res.status(400).json({ error: `Unknown prompt "${kind}"` });
    res.json({ problems: validateInstructions(kind, instructions), advice: adviseInstructions(kind, instructions) });
  });

  app.post('/api/prompts', async (req, res) => {
    const { kind, instructions, reset = false } = req.body || {};
    if (!PROMPT_KINDS[kind]) return res.status(400).json({ error: `Unknown prompt "${kind}"` });
    const next = { ...(config.prompts || {}) };
    if (reset || instructions === PROMPT_KINDS[kind].defaultInstructions) {
      delete next[kind];
    } else {
      const problems = validateInstructions(kind, instructions);
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
      next[kind] = instructions;
    }
    config.prompts = next;
    let persisted = true;
    let persistError = null;
    try {
      await persistConfigPatch({ prompts: next });
    } catch (err) {
      persisted = false;
      persistError = err.message;
    }
    res.json({ ...promptPayload(kind), persisted, persistError });
  });

  /** Picks the card a preview/test runs on: the one asked for, else the first scored one, else the first file. */
  async function sampleCardFile(requested) {
    if (requested) return requested;
    const store = await getStore(config.charactersDir);
    const files = (await readdir(config.charactersDir)).filter((f) => /\.(png|json)$/i.test(f)).sort();
    return files.find((f) => store.get(f)?.result && !store.get(f).result.partial) || files[0];
  }

  /**
   * The provider, with each reply copied into `replies` as it arrives: the raw
   * text (thinking included, if the model put it inline), any separate
   * reasoning, why it stopped, and the token counts the provider reported.
   */
  function recordingProvider(provider, replies) {
    const wrapped = Object.create(provider);
    wrapped.chatWithMeta = async (args) => {
      const reply = await ask(provider, args);
      replies.push({
        content: reply.content ?? '',
        reasoning: reply.reasoning || '',
        finishReason: reply.finishReason ?? null,
        usage: reply.usage ?? null,
        latencyMs: reply.latencyMs ?? null,
      });
      return reply;
    };
    wrapped.chat = async (args) => (await wrapped.chatWithMeta(args)).content;
    return wrapped;
  }

  // Exactly what would be sent for this card — system and user message — with
  // no request made. Works with unsaved edits.
  app.post('/api/prompts/preview', async (req, res) => {
    const { kind, instructions = null, cardId } = req.body || {};
    if (!PROMPT_KINDS[kind]) return res.status(400).json({ error: `Unknown prompt "${kind}"` });
    try {
      const file = await sampleCardFile(cardId);
      if (!file) return res.status(400).json({ error: 'There are no cards in this folder to preview with.' });
      const { card } = await readCardOrThrow(file);
      const store = await getStore(config.charactersDir);
      const result = store.get(file)?.result;
      const built = kind === 'improve'
        ? buildImprovePrompts(card, result, { prompts: config.prompts, draftInstructions: instructions })
        : kind === 'ideas'
          ? buildIdeasPrompts(card, result, { prompts: config.prompts, draftInstructions: instructions })
          : buildScoringPrompts(card, config.weights, { detail: kind, prompts: config.prompts, draftInstructions: instructions });
      res.json({
        cardId: file,
        cardName: card.name,
        system: built.system,
        user: built.user,
        approxTokens: Math.ceil((built.system.length + built.user.length) / 4),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Runs the (possibly unsaved) prompt once against one card and returns what
  // came back. One real request; nothing is saved to the card. The point is to
  // see an edit work on one card before spending it on three thousand.
  app.post('/api/prompts/test', async (req, res) => {
    const { kind, instructions = null, cardId } = req.body || {};
    if (!PROMPT_KINDS[kind]) return res.status(400).json({ error: `Unknown prompt "${kind}"` });
    if (instructions != null) {
      const problems = validateInstructions(kind, instructions);
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
    }
    const replies = [];
    try {
      const file = await sampleCardFile(cardId);
      if (!file) return res.status(400).json({ error: 'There are no cards in this folder to test with.' });
      const { card } = await readCardOrThrow(file);
      const store = await getStore(config.charactersDir);
      // Record every reply exactly as it arrived, so the panel can show what
      // the model actually sent back — most useful when it couldn't be read.
      const provider = recordingProvider(getProvider(), replies);
      const started = Date.now();
      let output;
      if (kind === 'improve') {
        output = await improveCard(card, store.get(file)?.result, provider, { prompts: config.prompts, draftInstructions: instructions });
      } else if (kind === 'ideas') {
        output = await generateIdeas(card, store.get(file)?.result, provider, { prompts: config.prompts, draftInstructions: instructions });
      } else {
        output = await scoreCard(card, provider, { weights: config.weights, detail: kind, prompts: config.prompts, draftInstructions: instructions });
      }
      res.json({
        cardId: file,
        cardName: card.name,
        tookMs: Date.now() - started,
        currentScore: store.get(file)?.result?.overall_score ?? null,
        output,
        replies,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, kind: classifyError(err.message), replies });
    }
  });

  app.get('/api/settings', (req, res) => {
    const preset = PROVIDER_PRESETS[config.provider];
    res.json({
      provider: config.provider,
      model: config.model || '',
      baseURL: config.baseURL || preset?.baseURL || '',
      apiKeySet: Boolean(config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
      concurrency: config.concurrency,
      effectiveConcurrency: resolveConcurrency(config).concurrency,
      requestsPerMinute: config.requestsPerMinute ?? preset?.requestsPerMinute ?? 0,
      timeoutMs: config.timeoutMs ?? 120000,
      scoreDetail: config.scoreDetail || 'full',
      maxTokens: config.maxTokens > 0 ? config.maxTokens : 0,
      charactersDir: config.charactersDir,
      authRequired: Boolean(config.authToken),
      presets: PROVIDER_PRESETS,
    });
  });

  app.post('/api/settings', async (req, res) => {
    const { provider, model, baseURL, apiKey, concurrency, requestsPerMinute, timeoutMs, scoreDetail, maxTokens } = req.body || {};
    if (scoreDetail !== undefined && scoreDetail !== 'full' && scoreDetail !== 'fast') {
      return res.status(400).json({ error: `Unknown scoring detail "${scoreDetail}"` });
    }
    if (provider !== undefined) {
      if (!PROVIDER_PRESETS[provider]) return res.status(400).json({ error: `Unknown provider "${provider}"` });
      config.provider = provider;
    }
    if (model !== undefined) config.model = model;
    if (baseURL !== undefined) config.baseURL = baseURL;
    if (apiKey) config.apiKey = apiKey; // blank/omitted = keep whatever's already saved
    if (concurrency) config.concurrency = Math.max(1, Number(concurrency));
    if (requestsPerMinute !== undefined && requestsPerMinute !== '') {
      config.requestsPerMinute = Math.max(0, Number(requestsPerMinute));
    }
    if (timeoutMs) config.timeoutMs = Math.max(5000, Number(timeoutMs));
    if (scoreDetail !== undefined) config.scoreDetail = scoreDetail;
    if (maxTokens !== undefined && maxTokens !== '') config.maxTokens = Math.max(0, Math.floor(Number(maxTokens) || 0));

    let persisted = true;
    let persistError = null;
    try {
      const patch = {};
      if (provider !== undefined) patch.provider = provider;
      if (model !== undefined) patch.model = model;
      if (baseURL !== undefined) patch.baseURL = baseURL;
      if (apiKey) patch.apiKey = apiKey;
      if (concurrency) patch.concurrency = config.concurrency;
      if (requestsPerMinute !== undefined && requestsPerMinute !== '') patch.requestsPerMinute = config.requestsPerMinute;
      if (timeoutMs) patch.timeoutMs = config.timeoutMs;
      if (scoreDetail !== undefined) patch.scoreDetail = scoreDetail;
      if (maxTokens !== undefined && maxTokens !== '') patch.maxTokens = config.maxTokens;
      await persistConfigPatch(patch);
    } catch (err) {
      persisted = false;
      persistError = err.message;
    }

    res.json({ ok: true, persisted, persistError });
  });

  app.get('/api/models', async (req, res) => {
    try {
      const models = await listModels(config);
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Server-side directory browser so the dashboard can offer a folder picker
  // even when the browser and the filesystem are on different machines (e.g.
  // you're at your desktop, the app and the cards are on a Tailscale-reachable
  // Linux box hosting SillyTavern). Deliberately allows browsing anywhere the
  // server process can read — see the authToken note above before exposing
  // this beyond localhost/your own tailnet.
  app.get('/api/browse', async (req, res) => {
    let target = path.resolve(req.query.path ? String(req.query.path) : config.charactersDir || os.homedir());
    try {
      const st = await stat(target);
      if (!st.isDirectory()) throw new Error('Not a directory');
    } catch (err) {
      // First run: the configured/default charactersDir may not exist yet — fall
      // back to the user's home folder instead of just erroring out.
      if (req.query.path) return res.status(400).json({ error: `Cannot open "${target}": ${err.message}` });
      target = os.homedir();
      try {
        const st2 = await stat(target);
        if (!st2.isDirectory()) throw new Error('Not a directory');
      } catch (err2) {
        return res.status(400).json({ error: `Cannot open "${target}": ${err2.message}` });
      }
    }
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (err) {
      return res.status(400).json({ error: `Cannot read "${target}": ${err.message}` });
    }
    const dirs = entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const cardCount = entries.filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name)).length;
    const parent = path.dirname(target) !== target ? path.dirname(target) : null;
    res.json({ path: target, parent, home: os.homedir(), cardCount, dirs });
  });

  app.post('/api/settings/characters-dir', async (req, res) => {
    const target = path.resolve(String(req.body?.path || ''));
    try {
      const st = await stat(target);
      if (!st.isDirectory()) throw new Error('Not a directory');
    } catch (err) {
      return res.status(400).json({ error: `Cannot use "${target}": ${err.message}` });
    }

    config.charactersDir = target;

    let persisted = true;
    let persistError = null;
    try {
      await persistConfigPatch({ charactersDir: target });
    } catch (err) {
      persisted = false;
      persistError = err.message;
    }

    res.json({ charactersDir: target, persisted, persistError });
  });

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host || '0.0.0.0', () => {
      const addr = server.address();
      const displayHost = addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address;
      console.log(`SillyScoreReview dashboard running at http://${displayHost}:${config.port}`);
      if (!config.host || config.host === '0.0.0.0') {
        console.log(`Also reachable from any other machine that can route to this one (e.g. over Tailscale) at http://<this machine's address>:${config.port}`);
        if (!config.authToken) {
          console.log(`No authToken set in config — anyone who can reach this address can browse and delete cards. Set "authToken" in config.json before exposing this beyond localhost.`);
        }
      }
      console.log(`Characters directory: ${config.charactersDir}`);
      resolve(server);
    });
  });
}
