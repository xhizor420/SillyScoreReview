import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Minimal JSON-file-backed store for card scores. Fine for a few thousand
 * cards; writes are atomic (write to .tmp then rename) so a crash mid-scan
 * never corrupts previously saved results.
 */
export class Store {
  /**
   * @param {string} filePath
   * @param {string} [charactersDir] recorded in the file so a cache can always
   *   be traced back to the folder it describes (see cachePath.js)
   */
  constructor(filePath, charactersDir, { coalesceMs = 1200, coalesceAbove = 300 } = {}) {
    this.filePath = filePath;
    this.charactersDir = charactersDir;
    this.data = { version: 1, charactersDir: charactersDir ?? null, cards: {} };
    this._writeQueue = Promise.resolve();
    this._timer = null;
    // Above this many cards a full rewrite stops being free (a 3,765-card cache
    // is ~9MB, so JSON.stringify alone blocks the event loop for ~70ms), so
    // writes get coalesced instead of fired per card. Below it, write at once:
    // a small cache costs nothing to save and durability is worth more.
    this.coalesceMs = coalesceMs;
    this.coalesceAbove = coalesceAbove;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
      if (!this.data.cards) this.data.cards = {};
      // Stamp the folder onto caches written before this was recorded.
      if (!this.data.charactersDir && this.charactersDir) this.data.charactersDir = this.charactersDir;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // no cache yet, start fresh
    }
    return this;
  }

  get(key) {
    return this.data.cards[key];
  }

  /**
   * Records an entry and gets it to disk. The returned promise resolves once it
   * is actually written, which may be up to `coalesceMs` later on a big cache —
   * a scan should not await it per card (call `flush()` when the run ends), but
   * an interactive single-card action can.
   */
  set(key, value) {
    this.data.cards[key] = value;
    return this._scheduleSave();
  }

  /**
   * Stages an entry without writing. Every `set` rewrites the whole file, which
   * is right for a scan (each card should be durable the moment it finishes)
   * but pathological for a bulk import — a few thousand entries becomes a few
   * thousand full-file writes and looks like a hang. Stage, then `save()` once.
   */
  stage(key, value) {
    this.data.cards[key] = value;
  }

  /** Writes whatever has been staged, now. */
  save() {
    return this.flush();
  }

  /** Cancels any pending coalesced write and writes immediately. */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this._queueSave();
  }

  delete(key) {
    delete this.data.cards[key];
    return this._scheduleSave();
  }

  /**
   * Removes an entry without waiting for the write. Bulk deletes must use this
   * plus one `flush()`: awaiting `delete()` per card costs a full coalescing
   * window each, which turns "delete 500 bad cards" into a ten-minute wait.
   */
  stageDelete(key) {
    delete this.data.cards[key];
  }

  /**
   * Schedules a write. Rewriting the whole file after every single card is O(n)
   * per card and O(n^2) over a run — ~2.5 minutes of blocked event loop across
   * a 3,765-card scan, which also makes the dashboard stutter while scanning.
   * Coalescing collapses a burst of finished cards into one write; at most
   * `coalesceMs` of results are ever in flight, and a run always ends on a
   * flush.
   */
  _scheduleSave() {
    const big = Object.keys(this.data.cards).length > this.coalesceAbove;
    if (!big || this.coalesceMs <= 0) return this._queueSave();
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._queueSave();
      }, this.coalesceMs);
      this._timer.unref?.();
    }
    return this._pendingWrite();
  }

  /** Resolves when the write that is currently scheduled or running completes. */
  async _pendingWrite() {
    const deadline = Date.now() + this.coalesceMs + 50;
    while (this._timer && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(50, this.coalesceMs)));
    }
    return this._writeQueue;
  }

  all() {
    return this.data.cards;
  }

  _queueSave() {
    // serialize writes so concurrent scan workers don't race on the file
    this._writeQueue = this._writeQueue.then(() => this._save()).catch((err) => {
      console.error('Failed to save cache:', err);
    });
    return this._writeQueue;
  }

  async _save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.filePath);
  }
}
