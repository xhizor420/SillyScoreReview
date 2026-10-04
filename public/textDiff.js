/*
 * Compares a card field before and after a suggested rewrite, as a list of
 * individual changes you can accept or reject one at a time.
 *
 * The unit of change is the sentence (and the line, for W++/PList-style
 * cards): that's the size of decision people actually make — "keep the outfit
 * description, take the rest of the trim". Within a changed sentence the
 * differing words are marked, so a one-word edit is visible at a glance.
 *
 * Plain script (no build step): the dashboard loads it with <script>, and the
 * self-tests run it in a sandbox. Everything hangs off globalThis.TextDiff.
 */
(function (root) {
  const TERMINATORS = '.!?…';
  const CLOSERS = '"”’\'*)]';

  /**
   * Splits text into sentence/line units whose concatenation is exactly the
   * original text — every space and newline belongs to some unit, so any mix of
   * accepted and rejected units reassembles cleanly.
   */
  function splitUnits(text) {
    const s = String(text ?? '');
    const units = [];
    let cur = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      cur += ch;
      i++;
      if (ch === '\n') {
        while (i < s.length && s[i] === '\n') cur += s[i++];
        units.push(cur);
        cur = '';
        continue;
      }
      if (TERMINATORS.includes(ch)) {
        while (i < s.length && TERMINATORS.includes(s[i])) cur += s[i++];
        while (i < s.length && CLOSERS.includes(s[i])) cur += s[i++];
        // only a real sentence end if whitespace (or the end of the text) follows
        if (i >= s.length || /\s/.test(s[i])) {
          while (i < s.length && (s[i] === ' ' || s[i] === '\t')) cur += s[i++];
          while (i < s.length && s[i] === '\n') cur += s[i++];
          units.push(cur);
          cur = '';
        }
      }
    }
    if (cur) units.push(cur);
    return units;
  }

  /** Longest-common-subsequence alignment: a list of {op: 'same'|'del'|'add', unit}. */
  function align(a, b, same) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (same(a[i], b[j])) { ops.push({ op: 'same', a: a[i], b: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: 'del', a: a[i++] });
      else ops.push({ op: 'add', b: b[j++] });
    }
    while (i < n) ops.push({ op: 'del', a: a[i++] });
    while (j < m) ops.push({ op: 'add', b: b[j++] });
    return ops;
  }

  function words(t) {
    return String(t).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  }

  /** How alike two sentences are: shared words over the longer one's word count (0..1). */
  function similarity(x, y) {
    const a = words(x);
    const b = words(y);
    if (!a.length || !b.length) return 0;
    const pool = new Map();
    for (const w of b) pool.set(w, (pool.get(w) || 0) + 1);
    let shared = 0;
    for (const w of a) {
      const n = pool.get(w);
      if (n) { shared++; pool.set(w, n - 1); }
    }
    return shared / Math.max(a.length, b.length);
  }

  /**
   * Breaks a run of changed sentences into one change per sentence. Each
   * original sentence is paired, in order, with the suggested sentence most like
   * it ("She wears a long grey oilskin coat…" ↔ "She wears a grey coat."), so a
   * trim of the body, a trim of the outfit and a deleted filler line are three
   * separate choices instead of one take-it-or-leave-it block. Sentences with
   * no counterpart become a removal or an addition of their own.
   */
  function splitChange(oldUnits, newUnits) {
    const n = oldUnits.length;
    const m = newUnits.length;
    const MIN = 0.2; // below this, two sentences are about different things
    const sim = oldUnits.map((o) => newUnits.map((nw) => similarity(o, nw)));
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const pair = sim[i][j] >= MIN ? sim[i][j] + best[i + 1][j + 1] : -1;
        best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (sim[i][j] >= MIN && best[i][j] === sim[i][j] + best[i + 1][j + 1]) {
        out.push({ type: 'change', old: oldUnits[i++], new: newUnits[j++] });
      } else if (best[i + 1][j] >= best[i][j + 1]) {
        out.push({ type: 'change', old: oldUnits[i++], new: '' });
      } else {
        out.push({ type: 'change', old: '', new: newUnits[j++] });
      }
    }
    while (i < n) out.push({ type: 'change', old: oldUnits[i++], new: '' });
    while (j < m) out.push({ type: 'change', old: '', new: newUnits[j++] });
    return out;
  }

  /**
   * The field as a sequence of unchanged text and changes:
   *   { type: 'same', text }  |  { type: 'change', old, new }
   * A change with old === '' is an addition; with new === '' a removal.
   */
  function diffText(before, after) {
    const ops = align(splitUnits(before), splitUnits(after), (x, y) => x.trim() === y.trim());
    const parts = [];
    let pending = null;
    const flush = () => {
      if (pending) { parts.push(...splitChange(pending.old, pending.new)); pending = null; }
    };
    for (const o of ops) {
      if (o.op === 'same') {
        flush();
        // Unchanged text keeps the original's own spacing.
        const last = parts[parts.length - 1];
        if (last && last.type === 'same') last.text += o.a;
        else parts.push({ type: 'same', text: o.a });
      } else {
        if (!pending) pending = { old: [], new: [] };
        if (o.op === 'del') pending.old.push(o.a); else pending.new.push(o.b);
      }
    }
    flush();
    return parts;
  }

  /** Number of changes in a diff. */
  function changeCount(parts) {
    return parts.filter((p) => p.type === 'change').length;
  }

  /**
   * The text you get from a set of choices — one 'old' or 'new' per change, in
   * order. All 'new' reproduces the suggestion exactly; all 'old' the original.
   */
  function compose(parts, choices, { before, after } = {}) {
    const picks = Array.from({ length: changeCount(parts) }, (_, k) => (choices[k] === 'old' ? 'old' : 'new'));
    if (after != null && picks.every((c) => c === 'new')) return after;
    if (before != null && picks.every((c) => c === 'old')) return before;
    let k = 0;
    return parts.map((p) => (p.type === 'same' ? p.text : picks[k++] === 'old' ? p.old : p.new)).join('');
  }

  /** Word-level marks for one change: which words differ on each side. */
  function wordDiff(oldText, newText) {
    const tok = (t) => String(t).match(/\s+|[^\s]+/g) || [];
    const ops = align(tok(oldText), tok(newText), (x, y) => x === y);
    const left = [];
    const right = [];
    for (const o of ops) {
      if (o.op === 'same') { left.push({ text: o.a, changed: false }); right.push({ text: o.b, changed: false }); }
      else if (o.op === 'del') left.push({ text: o.a, changed: /\S/.test(o.a) });
      else right.push({ text: o.b, changed: /\S/.test(o.b) });
    }
    return { old: left, new: right };
  }

  root.TextDiff = { splitUnits, diffText, changeCount, compose, wordDiff };
})(globalThis);
