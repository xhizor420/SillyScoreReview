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
  constructor(filePath, charactersDir) {
    this.filePath = filePath;
    this.charactersDir = charactersDir;
    this.data = { version: 1, charactersDir: charactersDir ?? null, cards: {} };
    this._writeQueue = Promise.resolve();
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

  set(key, value) {
    this.data.cards[key] = value;
    return this._queueSave();
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

  /** Writes whatever has been staged. */
  save() {
    return this._queueSave();
  }

  delete(key) {
    delete this.data.cards[key];
    return this._queueSave();
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
