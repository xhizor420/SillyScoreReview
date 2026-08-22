import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { createProvider } from './llmClient.js';
import { scoreCard } from './scorer.js';
import { Store } from './store.js';
import { runPool } from './concurrency.js';

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
  const store = await new Store(config.cacheFile).load();
  const jobs = new Map();

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

  async function scoreOne(file, provider) {
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
    const cards = files.map((file) => cardSummary(file, store.get(file)));
    res.json({ charactersDir: config.charactersDir, cards });
  });

  app.get('/api/cards/:id', async (req, res) => {
    const file = req.params.id;
    const entry = store.get(file);
    try {
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
      res.type('png').send(await readFile(filePath));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/cards/:id/score', async (req, res) => {
    try {
      const provider = createProvider(config);
      const entry = await scoreOne(req.params.id, provider);
      res.json({ id: req.params.id, entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/score/batch', async (req, res) => {
    const { ids, scope = 'selected', limit, rescore = false } = req.body || {};
    let files;
    try {
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
    const job = { id: jobId, total: files.length, done: 0, errors: 0, status: 'running', results: [], startedAt: new Date().toISOString() };
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
      await runPool(files, config.concurrency, async (file) => {
        try {
          const entry = await scoreOne(file, provider);
          job.done++;
          job.results.push({ file, name: entry.name, overallScore: entry.result.overall_score });
        } catch (err) {
          job.errors++;
          job.results.push({ file, error: err.message });
        }
      });
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    })();
  });

  app.get('/api/score/batch/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job id' });
    res.json(job);
  });

  app.post('/api/cards/delete', async (req, res) => {
    const { ids = [] } = req.body || {};
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

  app.get('/api/config', (req, res) => {
    res.json({
      charactersDir: config.charactersDir,
      provider: config.provider,
      model: config.model,
      concurrency: config.concurrency,
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`SillyScoreReview dashboard running at http://localhost:${config.port}`);
      console.log(`Characters directory: ${config.charactersDir}`);
      resolve(server);
    });
  });
}
