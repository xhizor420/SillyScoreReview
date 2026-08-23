import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Decides which cache file holds the scores for a given characters folder.
 *
 * This has to be deterministic. An earlier version used the configured
 * `cacheFile` for whichever folder happened to be active at startup and a
 * hash-derived name for any folder switched to later — so switching folders
 * mid-session wrote scores to `cache-<hash>.json`, while the config's
 * charactersDir was updated to that folder, and the *next* startup treated it
 * as the initial folder and looked in the (empty) configured `cacheFile`.
 * Hours of scoring would appear to vanish.
 *
 * Now: every folder maps to `cache-<hash of its path>.json`, always. The
 * legacy configured file is still honored when it plainly belongs to the
 * folder being opened, so caches written by older versions keep working.
 */
export function hashedCacheFileFor(cacheFile, charactersDir) {
  const key = path.resolve(charactersDir);
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return path.join(path.dirname(cacheFile), `cache-${hash}.json`);
}

async function readCacheMeta(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return {
      exists: true,
      charactersDir: parsed.charactersDir ?? null,
      cardCount: Object.keys(parsed.cards || {}).length,
    };
  } catch {
    return { exists: false, charactersDir: null, cardCount: 0 };
  }
}

/**
 * Returns the cache file to use for `charactersDir`, preferring an existing
 * legacy file when it belongs to this folder so no previously-scored data is
 * orphaned.
 */
export async function resolveCacheFile(cacheFile, charactersDir) {
  const dir = path.resolve(charactersDir);
  const hashed = hashedCacheFileFor(cacheFile, dir);

  const hashedMeta = await readCacheMeta(hashed);
  if (hashedMeta.exists) return hashed;

  // No hashed file yet. Fall back to the legacy configured file when it either
  // records this folder, or predates the folder being recorded at all (in which
  // case it was written when this was the only folder in play).
  const legacyMeta = await readCacheMeta(cacheFile);
  if (legacyMeta.exists && legacyMeta.cardCount > 0) {
    if (legacyMeta.charactersDir == null || path.resolve(legacyMeta.charactersDir) === dir) {
      return cacheFile;
    }
  }

  return hashed;
}

/**
 * Lists every cache file next to `cacheFile`, with which folder it belongs to
 * and how much it holds — so a "my scores disappeared" situation is
 * inspectable rather than a mystery.
 */
export async function listCaches(cacheFile) {
  const { readdir } = await import('node:fs/promises');
  const dir = path.dirname(cacheFile);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => /^cache.*\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const meta = await readCacheMeta(full);
    if (meta.exists) out.push({ file: full, name, charactersDir: meta.charactersDir, cardCount: meta.cardCount });
  }
  return out.sort((a, b) => b.cardCount - a.cardCount);
}
