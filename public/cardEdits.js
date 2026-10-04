/*
 * The review step of "Improve with AI": applying the changes you allow, and
 * checking what each one would take out of the card.
 *
 * Every suggested change is an anchored edit — "replace this exact passage",
 * "insert after this exact passage", "switch this lorebook entry off" — so
 * text outside an edit can't change. What an edit *can* do is remove a
 * detail, and that is measured here, live, against the whole card as it would
 * be saved: a detail counts as lost only if it's gone from everywhere, so
 * merging two passages (the detail moves) or a lorebook move (the detail is
 * in the new entry) is not flagged, but trimming the outfit description is.
 *
 * Plain script (no build step): the dashboard loads it with <script>, and the
 * self-tests run it in a sandbox. Everything hangs off globalThis.CardEdits.
 */
(function (root) {
  /** The text of one part of the card with the given edits applied. */
  function compose(before, edits) {
    const used = edits
      .filter((e) => e.use && e.action !== 'disable')
      .sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0));
    let out = '';
    let pos = 0;
    for (const e of used) {
      out += before.slice(pos, e.start) + e.new;
      pos = e.end;
    }
    return out + before.slice(pos);
  }

  /**
   * Spans for showing the whole field before and after: plain text, and the
   * parts each allowed edit removes (old side) or adds (new side).
   */
  function spans(before, edits) {
    const used = edits
      .filter((e) => e.use && e.action !== 'disable')
      .sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0));
    const oldSide = [];
    const newSide = [];
    let pos = 0;
    for (const e of used) {
      const plain = before.slice(pos, e.start);
      if (plain) { oldSide.push({ text: plain }); newSide.push({ text: plain }); }
      if (e.old) oldSide.push({ text: e.old, mark: true });
      if (e.new) newSide.push({ text: e.new, mark: true });
      pos = e.end;
    }
    const rest = before.slice(pos);
    if (rest) { oldSide.push({ text: rest }); newSide.push({ text: rest }); }
    return { old: oldSide, new: newSide };
  }

  // Common words that say nothing specific about a character; everything else
  // of five letters or more, every name and every number counts as a detail.
  const COMMON = new Set(('about above across after again against almost alone along already although always among ' +
    'another anyone anything around because become becomes before behind being below beneath beside besides between ' +
    'beyond both cannot could didn\'t doesn\'t doing during either enough even every everyone everything except first ' +
    'given gives going having however itself just later least less likely makes making maybe might more most mostly ' +
    'much must myself never often other others otherwise perhaps quite rather really since something sometimes ' +
    'someone somewhat still such their theirs them themselves then there these they thing things those though ' +
    'through throughout together toward towards under unless until upon usually very wants whatever when where ' +
    'whether which while whole whose will with within without would your yours yourself char user words while ' +
    'start shall should would could takes taken taking comes coming another always').split(/\s+/));

  // Four-letter words that carry no detail ("with", "that", "very"…). Other
  // four-letter words often do: "wool", "teal", "fang", "scar", "silk".
  const COMMON4 = new Set(('also back been both came come does done down each even ever from gave goes gone good have here ' +
    'into just keep kept know last left like look made make many more most much must next once only onto over said same ' +
    'seem some such sure take than that them then they this thus time told took very want were what when whom will with ' +
    'your able away bit came does feel felt find gets give into knew less lets lot mine near need none ones part puts ' +
    'quite real seen self sees shes tell tend upon used uses usually ways well went whom wish yeah yours').split(/\s+/));
  // Short colour words: a changed colour is a changed look.
  const COLOURS = new Set(['red', 'tan', 'jet']);

  /** The specific details in a passage: numbers (with units), names, distinctive words. */
  function detailTerms(text) {
    const terms = new Set();
    const s = String(text || '');
    for (const m of s.matchAll(/\d+(?:[.,\-–]\d+)*(?:\s?(?:cm|mm|km|kg|lbs?|ft|feet|foot|inch(?:es)?|in\b|years?|yrs?|%|'|"|′|″))?/gi)) {
      terms.add(m[0].toLowerCase().replace(/\s+/g, ' '));
    }
    for (const w of s.match(/\p{L}[\p{L}']*/gu) || []) {
      const lw = w.toLowerCase().replace(/'s$/, '');
      if (COMMON.has(lw) || COMMON4.has(lw)) continue;
      if ((/^\p{Lu}/u.test(w) && lw.length >= 3) || lw.length >= 4 || COLOURS.has(lw)) terms.add(lw);
    }
    return terms;
  }

  /**
   * The details in `removedText` that appear nowhere in `cardText` (the whole
   * card as it would be saved). Short words and common words are ignored.
   */
  function lostDetails(removedText, cardText) {
    if (!removedText || !removedText.trim()) return [];
    const have = detailTerms(cardText);
    return [...detailTerms(removedText)].filter((t) => !have.has(t));
  }

  // Changes whose point is to replace a detail: a fix ("8 feet" becomes "7
  // feet") or an update to an outdated lorebook entry. What they remove is a
  // correction, not a loss — and the same outdated words disappearing from a
  // duplicate entry is the same correction.
  const CORRECTING = new Set(['fix', 'lorebook']);
  const corrects = (e) => e.action === 'replace' && CORRECTING.has(e.kind);

  function correctedTerms(parts) {
    const out = new Set();
    for (const p of parts) {
      if (p.handEdited) continue;
      for (const e of p.edits) if (e.use && corrects(e)) for (const t of detailTerms(e.old)) out.add(t);
    }
    return out;
  }

  /**
   * What one edit would take out of the card, judged as if it were on (so a
   * change you've left off still says what it would cost):
   *   lost      — details found nowhere else in the card afterwards
   *   corrected — for a fix, the details it replaces
   */
  function editImpact(parts, p, e, extraText = '') {
    const was = e.use;
    e.use = true;
    const card = wholeCard(parts, extraText);
    const corrected = correctedTerms(parts);
    e.use = was;
    const gone = lostDetails(e.action === 'disable' ? p.before : e.old, card);
    if (corrects(e)) return { lost: [], corrected: gone };
    return { lost: gone.filter((t) => !corrected.has(t)), corrected: [] };
  }

  /**
   * Which edits to allow before you've touched anything: everything that
   * loses no detail, and every fix (changing a detail is its point). An edit
   * that would remove something found nowhere else in the card starts off,
   * so nothing distinctive goes unless you decide it should. Judged with all
   * the other edits on, so a detail a merge moved elsewhere counts as kept.
   */
  function defaultUses(parts, extraText = '') {
    const live = parts.filter((p) => !p.handEdited);
    for (const p of live) for (const e of p.edits) e.use = true;
    const verdicts = [];
    for (const p of live) for (const e of p.edits) verdicts.push([e, corrects(e) || editImpact(parts, p, e, extraText).lost.length === 0]);
    for (const [e, on] of verdicts) e.use = on;
  }

  /**
   * All the card's text as it would be saved: each edited part with its
   * allowed edits (or your hand edit), minus lorebook entries being switched
   * off, plus `extraText` (the untouched rest of the card and any new
   * lorebook entries).
   */
  function wholeCard(parts, extraText = '') {
    return parts
      .filter((p) => !p.edits.some((e) => e.use && e.action === 'disable'))
      .map((p) => (p.handEdited ? p.after : compose(p.before, p.edits)))
      .concat(extraText)
      .join('\n');
  }

  root.CardEdits = { compose, spans, detailTerms, lostDetails, editImpact, defaultUses, wholeCard };
})(globalThis);
