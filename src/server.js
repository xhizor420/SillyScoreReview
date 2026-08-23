import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rename, unlink, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider, listModels, resolveConcurrency, PROVIDER_PRESETS } from './llmClient.js';
import { scoreCard } from './scorer.js';
import { Store } from './store.js';
import { runPool } from './concurrency.js';
import { classifyError } from './errorKinds.js';

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

  // A scan/browse against one folder shouldn't see cached scores that
  // belong to a same-named file in a folder you switched away from, so
  // each characters folder the picker has pointed at gets its own cache
  // file (auto-derived next to the configured one, keyed by folder path).
  const initialDir = path.resolve(config.charactersDir);
  const stores = new Map([[initialDir, await new Store(config.cacheFile).load()]]);
  async function getStore(charactersDir) {
    const key = path.resolve(charactersDir);
    let store = stores.get(key);
    if (!store) {
      const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
      const file = path.join(path.dirname(config.cacheFile), `cache-${hash}.json`);
      store = await new Store(file).load();
      stores.set(key, store);
    }
    return store;
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
      isImage: /\.png$/i.test(file),
    };
  }

  async function readCardOrThrow(file) {
    const filePath = safeJoin(config.charactersDir, file);
    const buf = await readFile(filePath);
    const card = parseCardFile(buf, file);
    return { filePath, card, hash: hashCard(card) };
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

  async function scoreOne(file, provider, store) {
    const { card, hash } = await readCardOrThrow(file);
    try {
      const result = await scoreCard(card, provider, { weights: config.weights });
      const entry = {
        hash,
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        result,
        error: null,
      };
      await store.set(file, entry);
      return entry;
    } catch (err) {
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
      await store.set(file, entry);
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
      const provider = createProvider(config);
      const entry = await scoreOne(req.params.id, provider, store);
      res.json({ id: req.params.id, entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/score/batch', async (req, res) => {
    const { ids, scope = 'selected', limit, rescore = false } = req.body || {};
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
      } else {
        files = all;
      }
      if (!rescore) {
        files = files.filter((f) => {
          const entry = store.get(f);
          return !entry || entry.error;
        });
      }
      if (limit) files = files.slice(0, Number(limit));
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
      inFlight: 0,
      active: [],       // cards currently awaiting a response, with elapsed time
      recent: [],       // rolling feed of the last few completions
      latencies: [],    // per-card wall time, for a live median
    };
    jobs.set(jobId, job);
    res.json({ jobId, total: files.length });

    (async () => {
      let provider;
      try {
        provider = createProvider(config);
      } catch (err) {
        job.status = 'error';
        job.fatalError = err.message;
        return;
      }
      await runPool(files, job.concurrency, async (file) => {
        const startedMs = Date.now();
        job.inFlight++;
        job.active.push({ file, startedMs });
        const settle = (outcome) => {
          job.inFlight--;
          job.active = job.active.filter((a) => a.file !== file);
          const tookMs = Date.now() - startedMs;
          job.latencies.push(tookMs);
          if (job.latencies.length > 200) job.latencies.shift();
          job.recent.unshift({ ...outcome, file, tookMs });
          if (job.recent.length > 12) job.recent.pop();
        };
        try {
          const entry = await scoreOne(file, provider, store);
          job.done++;
          const outcome = { name: entry.name, overallScore: entry.result.overall_score };
          job.results.push({ file, ...outcome });
          settle(outcome);
        } catch (err) {
          job.errors++;
          job.results.push({ file, error: err.message });
          settle({ error: err.message });
        }
      });
      job.status = 'done';
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
      inFlight: job.inFlight,
      concurrency: job.concurrency,
      model: job.model,
      elapsedMs,
      perHour,
      medianLatencyMs: medianMs,
      etaMs: perHour && perHour > 0 ? ((job.total - finished) / perHour) * 3_600_000 : null,
      active: job.active.map((a) => ({ file: a.file, elapsedMs: now - a.startedMs })),
      recent: job.recent,
    });
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
        await store.delete(file);
        moved.push({ file, trashedAs: destName });
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }
    res.json({ moved, errors });
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
      charactersDir: config.charactersDir,
      authRequired: Boolean(config.authToken),
      presets: PROVIDER_PRESETS,
    });
  });

  app.post('/api/settings', async (req, res) => {
    const { provider, model, baseURL, apiKey, concurrency, requestsPerMinute, timeoutMs } = req.body || {};
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
