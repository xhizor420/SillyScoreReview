import { readFile, writeFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveCacheFile, listCaches } from './cachePath.js';

/**
 * Picks the better of two entries for the same card.
 *
 * A real score always beats an error — an error is just "we did not manage it
 * that time", and there is no reason to prefer it over a result we already
 * paid for. Between two scores (or two errors), the newer one wins.
 */
function pickBetter(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aOk = Boolean(a.result);
  const bOk = Boolean(b.result);
  if (aOk !== bOk) return aOk ? a : b;
  const aAt = Date.parse(a.scoredAt || 0) || 0;
  const bAt = Date.parse(b.scoredAt || 0) || 0;
  return bAt > aAt ? b : a;
}

async function readCards(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed.cards || {};
  } catch {
    return {};
  }
}

/**
 * Combines every cache file next to `cacheFile` into the one that belongs to
 * `charactersDir`, and optionally drops entries for cards no longer on disk.
 *
 * Merging is safe by construction: entries are only ever added or upgraded
 * (error -> score, older -> newer), never downgraded, and the destination is
 * backed up first.
 */
export async function mergeCaches({ cacheFile, charactersDir, prune = true, dryRun = false }) {
  const dest = await resolveCacheFile(cacheFile, charactersDir);
  const all = await listCaches(cacheFile);
  const sources = all.filter((c) => c.file !== dest);

  const destCards = await readCards(dest);
  const merged = { ...destCards };

  let added = 0;
  let upgraded = 0;
  const contributions = [];

  for (const src of sources) {
    const cards = await readCards(src.file);
    let srcAdded = 0;
    let srcUpgraded = 0;
    for (const [key, entry] of Object.entries(cards)) {
      const existing = merged[key];
      if (!existing) {
        merged[key] = entry;
        added++;
        srcAdded++;
        continue;
      }
      const better = pickBetter(existing, entry);
      if (better !== existing) {
        merged[key] = better;
        upgraded++;
        srcUpgraded++;
      }
    }
    contributions.push({ name: src.name, total: Object.keys(cards).length, added: srcAdded, upgraded: srcUpgraded });
  }

  // Drop entries whose card file is gone — deleting cards mid-scan used to
  // leave these behind, and they inflate the failure count for cards that no
  // longer exist.
  let pruned = 0;
  if (prune) {
    let onDisk = new Set();
    try {
      onDisk = new Set(
        (await readdir(charactersDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && /\.(png|json)$/i.test(e.name))
          .map((e) => e.name),
      );
      for (const key of Object.keys(merged)) {
        if (!onDisk.has(key)) {
          delete merged[key];
          pruned++;
        }
      }
    } catch {
      // Can't read the folder — safer to keep everything than to prune blind.
      pruned = -1;
    }
  }

  const summary = {
    dest,
    sources: contributions,
    added,
    upgraded,
    pruned,
    before: Object.keys(destCards).length,
    after: Object.keys(merged).length,
    scored: Object.values(merged).filter((e) => e?.result).length,
    failed: Object.values(merged).filter((e) => e?.error).length,
    backup: null,
  };

  if (dryRun) return summary;

  // Back up the destination before rewriting it.
  try {
    const backup = `${dest}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(dest, backup);
    summary.backup = backup;
  } catch {
    // no existing destination to back up
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(
    dest,
    JSON.stringify({ version: 1, charactersDir: path.resolve(charactersDir), cards: merged }, null, 2),
  );

  return summary;
}
