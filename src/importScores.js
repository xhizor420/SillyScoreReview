import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseCardFile, hashCard, totalCardTokens } from './cardParser.js';
import { resolveCacheFile } from './cachePath.js';
import { Store } from './store.js';

/**
 * Imports score numbers recovered from a dashboard tab (see
 * recover-scores-snippet.js) back into the cache.
 *
 * These entries carry only the overall score — the written critique was never
 * in the page and cannot be recovered. They are marked `partial: true` so it is
 * obvious which cards have a number but no detail.
 *
 * The important part is the content hash: it is recomputed from the card file
 * on disk, so `scan` treats these exactly like normally-scored cards and will
 * NOT re-score them. Importing a number is the whole point — nobody wants to
 * pay to re-derive a score they already have.
 */
export async function importScores({ cacheFile, charactersDir, payload, dryRun = false, overwrite = false, onProgress }) {
  // Be liberal about shape: the snippet and the Export button both produce
  // { scores: [...] }, but a hand-made file could reasonably be a bare array,
  // a { cards: [...] }, or even a plain { "file.png": 7 } mapping.
  let rows = null;
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload?.scores)) rows = payload.scores;
  else if (Array.isArray(payload?.cards)) rows = payload.cards;
  else if (payload && typeof payload === 'object') {
    const pairs = Object.entries(payload).filter(([, v]) => typeof v === 'number' || typeof v?.overallScore === 'number');
    if (pairs.length) {
      rows = pairs.map(([k, v]) => ({ id: k, name: null, overallScore: typeof v === 'number' ? v : v.overallScore }));
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      'No scores found in that file. Expected a "scores" array (what the recovery ' +
      'snippet and the Export scores button produce). Top-level keys seen: ' +
      (payload && typeof payload === 'object' ? Object.keys(payload).join(', ') || '(none)' : typeof payload),
    );
  }

  // Normalize the score field name — tolerate a few spellings.
  rows = rows.map((r) => (r && typeof r === 'object'
    ? { ...r, overallScore: r.overallScore ?? r.overall_score ?? r.score ?? null }
    : r));

  const dest = await resolveCacheFile(cacheFile, charactersDir);
  const store = await new Store(dest, charactersDir).load();

  const onDisk = (await readdir(charactersDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
    .map((e) => e.name);
  const onDiskSet = new Set(onDisk);

  // The DOM fallback in the snippet cannot see filenames, so allow matching on
  // the character's name as a second pass.
  const byName = new Map();
  const cardCache = new Map();
  async function readCard(file) {
    if (cardCache.has(file)) return cardCache.get(file);
    let card = null;
    try {
      card = parseCardFile(await readFile(path.join(charactersDir, file)), file);
    } catch {
      card = null;
    }
    cardCache.set(file, card);
    return card;
  }
  const needNameMatch = rows.some((r) => !r.id);
  if (needNameMatch) {
    for (const file of onDisk) {
      const card = await readCard(file);
      if (card?.name && !byName.has(card.name)) byName.set(card.name, file);
    }
  }

  let imported = 0;
  let skippedExisting = 0;
  let notFound = 0;
  const missing = [];

  for (const row of rows) {
    const score = Number(row?.overallScore);
    if (!Number.isFinite(score)) continue;

    let file = row.id && onDiskSet.has(row.id) ? row.id : null;
    if (!file && row.name) file = byName.get(row.name) || null;
    if (!file) {
      notFound++;
      if (missing.length < 10) missing.push(row.name || row.id || '(unnamed)');
      continue;
    }

    const existing = store.get(file);
    // Never clobber a full result with a bare number.
    if (existing?.result && !existing.result.partial && !overwrite) {
      skippedExisting++;
      continue;
    }

    const card = await readCard(file);
    if (!card) {
      notFound++;
      continue;
    }

    if (!dryRun) {
      // Staged, not written — a single save follows the loop.
      store.stage(file, {
        hash: hashCard(card), // real hash => scan will not re-score this card
        name: card.name,
        tokenEstimate: totalCardTokens(card),
        scoredAt: new Date().toISOString(),
        provider: existing?.provider ?? 'recovered',
        model: existing?.model ?? null,
        result: {
          fields: {},
          overall_score: Math.round(score * 10) / 10,
          top_priority_improvements: [],
          summary: 'Score recovered from a dashboard session; the detailed critique was not saved. Rescore this card to regenerate the full breakdown.',
          partial: true,
        },
        error: null,
      });
    }
    imported++;
    if (onProgress && imported % 100 === 0) onProgress(imported, rows.length);
  }

  if (!dryRun && imported > 0) await store.save();

  return {
    dest,
    imported,
    skippedExisting,
    notFound,
    missing,
    total: rows.length,
    // Enough to see a mismatch at a glance without opening the files.
    sampleFromFile: rows.slice(0, 3).map((r) => r?.id || r?.name || '(no id/name)'),
    sampleOnDisk: onDisk.slice(0, 3),
    onDiskCount: onDisk.length,
  };
}
