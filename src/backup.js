import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Rolling snapshots of the score cache.
 *
 * Scores are the expensive part of this tool — thousands of API calls and hours
 * of wall time — and the cache that holds them is a single JSON file that
 * imports, merges and folder switches all rewrite. One bad write should never
 * be able to cost a whole run, so every operation that rewrites the cache
 * wholesale takes a snapshot first, and those snapshots are kept around.
 */
export const KEEP_BACKUPS = 12;

export function backupDirFor(cacheFile) {
  return path.join(path.dirname(cacheFile), 'backups');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function sanitizeReason(reason) {
  return String(reason || 'manual').replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'manual';
}

/**
 * Copies `cacheFile` into the backups folder, then prunes old snapshots of that
 * same cache down to KEEP_BACKUPS. Returns null when there is nothing to back
 * up (no cache yet, or an empty one) — never throws, because failing to take a
 * backup must not be a reason to fail the operation it was protecting.
 */
export async function snapshotCache(cacheFile, { reason = 'manual', keep = KEEP_BACKUPS } = {}) {
  try {
    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    const cardCount = Object.keys(parsed.cards || {}).length;
    if (cardCount === 0) return null;

    const dir = backupDirFor(cacheFile);
    await mkdir(dir, { recursive: true });
    const base = path.basename(cacheFile, '.json');
    const file = path.join(dir, `${base}--${stamp()}--${sanitizeReason(reason)}.json`);
    await copyFile(cacheFile, file);

    const mine = (await readdir(dir))
      .filter((n) => n.startsWith(`${base}--`) && n.endsWith('.json'))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
      await unlink(path.join(dir, old)).catch(() => {});
    }

    return { file, cardCount, reason: sanitizeReason(reason) };
  } catch {
    return null;
  }
}

/** Lists every snapshot, newest first, with what it holds. */
export async function listBackups(cacheFile) {
  const dir = backupDirFor(cacheFile);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const [st, parsed] = await Promise.all([
        stat(file),
        readFile(file, 'utf8').then(JSON.parse),
      ]);
      const cards = Object.values(parsed.cards || {});
      out.push({
        file,
        name,
        takenAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        cardCount: cards.length,
        scoredCount: cards.filter((c) => c?.result).length,
        charactersDir: parsed.charactersDir ?? null,
        reason: name.replace(/\.json$/, '').split('--').slice(2).join('--') || null,
      });
    } catch {
      // unreadable snapshot — skip it rather than failing the listing
    }
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/**
 * Restores a snapshot over the live cache, snapshotting the current cache first
 * so a restore is itself undoable.
 */
export async function restoreBackup(backupFile, cacheFile) {
  const parsed = JSON.parse(await readFile(backupFile, 'utf8'));
  const cardCount = Object.keys(parsed.cards || {}).length;
  const replaced = await snapshotCache(cacheFile, { reason: 'before-restore' });
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await copyFile(backupFile, cacheFile);
  return { restored: backupFile, cardCount, charactersDir: parsed.charactersDir ?? null, previousSavedAs: replaced?.file ?? null };
}
