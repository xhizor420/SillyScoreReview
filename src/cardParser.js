import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Fields we care about for quality scoring, in a sensible default order.
export const SCORABLE_FIELDS = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  // SillyTavern's Character's Note (extensions.depth_prompt): an instruction
  // injected into the chat every few messages. Often where a card sets its
  // style, length and point of view — a review that can't see it misjudges
  // the card.
  'character_note',
  'alternate_greetings',
];

// The fields a card's content hash covers. Fixed at the original set, so that
// adding a field to what is reviewed never makes every scored card in a
// library look edited (and due for a rescan).
const HASHED_FIELDS = [
  'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'system_prompt', 'post_history_instructions', 'alternate_greetings',
];

/**
 * Walks the PNG chunk stream and returns raw text chunks keyed by keyword.
 * Handles tEXt (plain) and zTXt (zlib-compressed) chunks; iTXt is rare for
 * character cards and intentionally skipped.
 */
function readPngTextChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  const chunks = {};
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString('latin1', 0, nul);
        const text = data.toString('latin1', nul + 1);
        chunks[keyword] = text;
      }
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString('latin1', 0, nul);
        // byte after NUL is compression method (0 = zlib/deflate), rest is compressed text
        const compressed = data.subarray(nul + 2);
        try {
          const text = inflateSync(compressed).toString('utf8');
          chunks[keyword] = text;
        } catch {
          // corrupt/unsupported compression, ignore this chunk
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }
  return chunks;
}

function decodeChunkJson(text) {
  // SillyTavern embeds base64-encoded JSON. Some older tools stored raw JSON directly.
  const candidates = [];
  try {
    candidates.push(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    // ignore
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalizeCardData(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // V2/V3 spec wraps the actual fields under `data`; V1 cards are flat.
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const spec = raw.spec || (raw.data ? 'chara_card_v2' : 'chara_card_v1');

  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter(Boolean).join('\n\n---\n\n')
    : '';

  return {
    spec,
    // The untouched source object. Editing a card merges changes into this and
    // re-serializes it, so fields this tool doesn't model (lorebooks,
    // creator_notes, extensions) are never dropped on a rewrite.
    raw,
    name: data.name || raw.name || '(unnamed)',
    creator: data.creator || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    fields: {
      description: data.description || '',
      personality: data.personality || '',
      scenario: data.scenario || '',
      first_mes: data.first_mes || '',
      mes_example: data.mes_example || '',
      system_prompt: data.system_prompt || '',
      post_history_instructions: data.post_history_instructions || '',
      character_note: typeof data.extensions?.depth_prompt?.prompt === 'string' ? data.extensions.depth_prompt.prompt : '',
      alternate_greetings: alternateGreetings,
    },
  };
}

/**
 * Extracts and normalizes character card data embedded in a PNG buffer.
 * Prefers the richer `ccv3` chunk over `chara` when both are present.
 */
export function extractCardFromPng(buffer) {
  const chunks = readPngTextChunks(buffer);
  const raw = decodeChunkJson(chunks.ccv3 || '') || decodeChunkJson(chunks.chara || '');
  if (!raw) {
    throw new Error('No character data chunk (chara/ccv3) found in PNG');
  }
  const card = normalizeCardData(raw);
  if (!card) {
    throw new Error('Character data chunk did not contain a usable card object');
  }
  return card;
}

/** Parses a plain SillyTavern JSON card export (not a PNG). */
export function extractCardFromJson(buffer) {
  const raw = JSON.parse(buffer.toString('utf8'));
  const card = normalizeCardData(raw);
  if (!card) throw new Error('JSON file did not contain a usable card object');
  return card;
}

export function parseCardFile(buffer, filename) {
  if (filename.toLowerCase().endsWith('.json')) {
    return extractCardFromJson(buffer);
  }
  return extractCardFromPng(buffer);
}

/** Cheap token estimate (chars/4) — good enough for relative comparisons, not exact. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function totalCardTokens(card) {
  return SCORABLE_FIELDS.reduce((sum, f) => sum + estimateTokens(card.fields[f]), 0);
}

/** Stable content hash so the store can detect edited/replaced cards and auto-invalidate. */
export function hashCard(card) {
  const h = createHash('sha256');
  h.update(card.name);
  for (const f of HASHED_FIELDS) h.update('\0' + (card.fields[f] || ''));
  return h.digest('hex');
}
