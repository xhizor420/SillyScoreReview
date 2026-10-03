import { crc32 as zlibCrc32 } from 'node:zlib';

import { SCORABLE_FIELDS } from './cardParser.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// zlib.crc32 landed in Node 22.2. Keep a table fallback so a slightly older
// runtime writes valid PNGs too — a bad CRC produces a file that SillyTavern
// (and every image viewer) rejects, which is a terrible way to lose a card.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buffer);
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function textChunk(keyword, text) {
  // Card JSON is base64 (ASCII), which is what SillyTavern writes and reads.
  return buildChunk('tEXt', Buffer.concat([
    Buffer.from(`${keyword}\0`, 'latin1'),
    Buffer.from(text, 'latin1'),
  ]));
}

/** Splits a PNG into its chunk list without decoding pixels. */
function splitChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd), raw: buffer.subarray(offset, dataEnd + 4) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function chunkKeyword(chunk) {
  const nul = chunk.data.indexOf(0);
  return nul === -1 ? null : chunk.data.toString('latin1', 0, nul);
}

const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

/** The separator cardParser uses when flattening alternate_greetings for display. */
export const GREETING_SEPARATOR = '\n\n---\n\n';

function splitGreetings(text) {
  if (!text || !text.trim()) return [];
  return text.split(/\n*---\n*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Merges edited field text back into the card's own raw JSON.
 *
 * Only the fields actually given are touched, and everything else in the object
 * is passed through untouched — a card's lorebook (`character_book`),
 * `creator_notes`, `extensions`, `avatar`, custom keys from whatever tool made
 * it, all of it survives. Rewriting a card must never be a way to silently lose
 * data the tool doesn't happen to model.
 */
/**
 * Appends lorebook entries to a V2/V3 card's character_book, creating the book
 * if the card has none. Follows the Character Card V2 spec: every entry has
 * keys, content, extensions ({}), enabled and insertion_order, and the book
 * itself has entries and extensions. Existing entries — and any keys this tool
 * doesn't know about — are never touched; the spec forbids destroying them.
 */
function appendLorebookEntries(data, entries) {
  if (!entries?.length) return;
  const book = data.character_book && typeof data.character_book === 'object' ? data.character_book : {};
  if (!Array.isArray(book.entries)) book.entries = [];
  if (!book.extensions || typeof book.extensions !== 'object') book.extensions = {};
  let order = book.entries.reduce((m, e) => Math.max(m, Number(e?.insertion_order) || 0), 0);
  let id = book.entries.reduce((m, e) => Math.max(m, Number(e?.id) || 0), 0);
  for (const e of entries) {
    book.entries.push({
      id: ++id,
      keys: e.keys,
      secondary_keys: [],
      content: e.content,
      extensions: {},
      enabled: true,
      insertion_order: (order += 10),
      case_sensitive: false,
      selective: false,
      constant: false,
      name: e.keys[0],
      // Not used in prompts (per the spec) — marks where the entry came from.
      comment: 'Moved here from the card by SillyScoreReview',
    });
  }
  data.character_book = book;
}

export function applyFieldsToRaw(raw, { fields = {}, name, lorebookEntries = [] } = {}) {
  const next = structuredClone(raw);
  const isV2 = next.data && typeof next.data === 'object';
  const target = isV2 ? next.data : next;
  if (lorebookEntries.length) {
    if (!isV2) throw new Error('This card is in the older V1 format, which has no lorebook. Save it without the lorebook entries.');
    appendLorebookEntries(next.data, lorebookEntries);
  }

  for (const field of SCORABLE_FIELDS) {
    if (!(field in fields)) continue;
    const value = fields[field];
    if (value == null) continue;
    if (field === 'alternate_greetings') {
      target.alternate_greetings = splitGreetings(value);
    } else {
      target[field] = String(value);
    }
  }

  if (name != null && String(name).trim()) {
    target.name = String(name).trim();
    if (isV2 && 'name' in next) next.name = target.name;
  }

  return next;
}

/** Encodes a raw card object the way SillyTavern stores it in a PNG chunk. */
function encodeCardChunk(raw) {
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64');
}

/**
 * Returns a new PNG buffer carrying `raw` as its character data, with the
 * original image untouched.
 *
 * Every image chunk is copied through byte-for-byte (including its original
 * CRC) so the artwork cannot be re-encoded or degraded; only the card's text
 * chunks are replaced. A `ccv3` chunk is rewritten only if the original had
 * one, so a V2 card stays a V2 card.
 */
export function writeCardToPng(originalBuffer, raw) {
  const chunks = splitChunks(originalBuffer);

  // IHDR is always first in a real PNG, and the card's text chunks go straight
  // after it. A file without one is already not a viewable image, but refusing
  // to edit it would mean its card data is simply unreachable — so write the
  // text chunks at the front instead and leave the rest of the stream alone.
  const hasHeader = chunks.length > 0 && chunks[0].type === 'IHDR';

  const hadCcv3 = chunks.some(
    (c) => (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') && chunkKeyword(c) === 'ccv3',
  );

  const encoded = encodeCardChunk(raw);
  const newText = [textChunk('chara', encoded)];
  if (hadCcv3) newText.push(textChunk('ccv3', encoded));

  const out = hasHeader ? [PNG_SIGNATURE, chunks[0].raw, ...newText] : [PNG_SIGNATURE, ...newText];
  for (const chunk of hasHeader ? chunks.slice(1) : chunks) {
    const isCardText =
      (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') &&
      CARD_KEYWORDS.has(chunkKeyword(chunk));
    if (isCardText) continue; // replaced above
    out.push(chunk.raw);
  }
  if (!chunks.some((c) => c.type === 'IEND')) out.push(buildChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

/** Same contract as writeCardToPng, for plain .json card exports. */
export function writeCardToJson(raw) {
  return Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/**
 * Produces the bytes for an edited card, picking the right container from the
 * filename so a .json card stays JSON and a .png card stays a PNG.
 */
export function serializeCard({ filename, originalBuffer, raw, fields, name, lorebookEntries }) {
  const merged = applyFieldsToRaw(raw, { fields, name, lorebookEntries });
  const bytes = filename.toLowerCase().endsWith('.json')
    ? writeCardToJson(merged)
    : writeCardToPng(originalBuffer, merged);
  return { bytes, raw: merged };
}
