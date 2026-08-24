/* ===========================================================================
   SCORE RECOVERY SNIPPET

   Use this when a dashboard tab is showing scores that never made it into the
   data file (e.g. the split-cache bug, or the server was restarted under it).
   The scores are still in that page's memory — this pulls them out.

   HOW TO USE
   1. Go to the browser tab that is showing the scores. Do NOT reload it.
   2. Press F12 (or Ctrl+Shift+I) and click the "Console" tab.
   3. Paste this entire file in, press Enter.
   4. A file called recovered-scores.json downloads.
   5. Move it into your SillyScoreReview folder and run:
          node src/cli.js import-scores recovered-scores.json

   Only the score numbers are recoverable this way — the written critique
   (strengths / weaknesses / suggestions) was never in the page. Imported cards
   count as scored and will NOT be re-scanned.
   =========================================================================== */
(() => {
  let rows = [];

  // Preferred: the page's own card list, which carries the filename each score
  // belongs to. app.js is a classic script, so `state` is reachable here.
  try {
    if (typeof state !== 'undefined' && Array.isArray(state.cards)) {
      rows = state.cards
        .filter((c) => c && c.overallScore != null)
        .map((c) => ({ id: c.id, name: c.name, overallScore: c.overallScore, tokenEstimate: c.tokenEstimate ?? null }));
    }
  } catch {
    // fall through to scraping
  }

  // Fallback: scrape the visible grid. Loses the filename, so the import has to
  // match on the character name instead — less reliable, but better than losing
  // the run entirely.
  if (rows.length === 0) {
    for (const tile of document.querySelectorAll('.card-tile')) {
      const name = tile.querySelector('.card-name')?.textContent?.trim();
      const badge = tile.querySelector('.score-badge')?.textContent?.trim();
      const score = Number(badge);
      if (name && Number.isFinite(score)) rows.push({ id: null, name, overallScore: score, tokenEstimate: null });
    }
    if (rows.length) {
      console.warn(
        'Read the scores off the visible grid only. If the grid is filtered, or cards are ' +
        'scrolled out of view, some may be missing — clear any filter and try again.',
      );
    }
  }

  if (rows.length === 0) {
    console.error(
      'No scores found on this page. Make sure this is the dashboard tab that is ' +
      'showing score badges, and that it has not been reloaded.',
    );
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    charactersDir: document.getElementById('dirLabel')?.textContent?.trim() || null,
    scores: rows,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recovered-scores.json';
  document.body.appendChild(a);
  a.click();
  a.remove();

  console.log(
    `Recovered ${rows.length} scores -> recovered-scores.json\n` +
    'Move it into your SillyScoreReview folder, then run:\n' +
    '    node src/cli.js import-scores recovered-scores.json',
  );
  return payload;
})();
