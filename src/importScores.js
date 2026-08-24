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
export async function importScores({ cacheFile, charactersDir, payload, dryRun = false, overwrite = false }) {
  const rows = Array.isArray(payload) ? payload : payload?.scores;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No scores found in that file — expected a "scores" array (or a bare array).');
  }

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
      await store.set(file, {
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
  }

  return { dest, imported, skippedExisting, notFound, missing, total: rows.length };
}
