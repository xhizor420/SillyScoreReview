const state = {
  cards: [],
  shown: [],
  selected: new Set(),
  dupeIds: new Set(),
  bestIds: new Set(),
  groups: new Map(),      // representative key -> cards in that group
  groupOf: new Map(),     // card id -> its group's representative key
  groupSizes: new Map(),  // representative key -> how many cards share it
  focusKey: null,         // when set, show only that name group
  lastToggledIndex: null, // anchor for shift-click range selection
  selectMode: false,      // touch: tap a tile to select rather than open it
};

const els = {
  grid: document.getElementById('grid'),
  emptyState: document.getElementById('emptyState'),
  stats: document.getElementById('stats'),
  dirLabel: document.getElementById('dirLabel'),
  search: document.getElementById('search'),
  sortBy: document.getElementById('sortBy'),
  filterBy: document.getElementById('filterBy'),
  scanUnscoredBtn: document.getElementById('scanUnscoredBtn'),
  rescanAllBtn: document.getElementById('rescanAllBtn'),
  trashToggleBtn: document.getElementById('trashToggleBtn'),
  exportScoresBtn: document.getElementById('exportScoresBtn'),
  scanPanel: document.getElementById('scanPanel'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  scanStats: document.getElementById('scanStats'),
  hideScanPanelBtn: document.getElementById('hideScanPanelBtn'),
  scanActive: document.getElementById('scanActive'),
  scanRecent: document.getElementById('scanRecent'),
  selectionBar: document.getElementById('selectionBar'),
  selectionCount: document.getElementById('selectionCount'),
  shownCount: document.getElementById('shownCount'),
  selectModeBtn: document.getElementById('selectModeBtn'),
  selectAllShownBtn: document.getElementById('selectAllShownBtn'),
  selectDupeLosersBtn: document.getElementById('selectDupeLosersBtn'),
  focusBar: document.getElementById('focusBar'),
  focusLabel: document.getElementById('focusLabel'),
  clearFocusBtn: document.getElementById('clearFocusBtn'),
  selectFocusLosersBtn: document.getElementById('selectFocusLosersBtn'),
  scoreSelectedBtn: document.getElementById('scoreSelectedBtn'),
  deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
  copySelectedBtn: document.getElementById('copySelectedBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  trashPanel: document.getElementById('trashPanel'),
  trashList: document.getElementById('trashList'),
  emptyTrashBtn: document.getElementById('emptyTrashBtn'),
  closeTrashBtn: document.getElementById('closeTrashBtn'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  modalBody: document.getElementById('modalBody'),
  modalClose: document.getElementById('modalClose'),
  folderBtn: document.getElementById('folderBtn'),
  folderPanel: document.getElementById('folderPanel'),
  closeFolderBtn: document.getElementById('closeFolderBtn'),
  folderPathInput: document.getElementById('folderPathInput'),
  folderGoBtn: document.getElementById('folderGoBtn'),
  folderHomeBtn: document.getElementById('folderHomeBtn'),
  folderUpBtn: document.getElementById('folderUpBtn'),
  folderInfo: document.getElementById('folderInfo'),
  folderList: document.getElementById('folderList'),
  useFolderBtn: document.getElementById('useFolderBtn'),
  copyHereBtn: document.getElementById('copyHereBtn'),
  folderPanelTitle: document.getElementById('folderPanelTitle'),
  folderPanelHint: document.getElementById('folderPanelHint'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settingsProvider: document.getElementById('settingsProvider'),
  apiKeyStatus: document.getElementById('apiKeyStatus'),
  settingsApiKey: document.getElementById('settingsApiKey'),
  settingsBaseUrl: document.getElementById('settingsBaseUrl'),
  settingsModelSelect: document.getElementById('settingsModelSelect'),
  refreshModelsBtn: document.getElementById('refreshModelsBtn'),
  settingsModelCustom: document.getElementById('settingsModelCustom'),
  settingsConcurrency: document.getElementById('settingsConcurrency'),
  settingsRpm: document.getElementById('settingsRpm'),
  settingsTimeout: document.getElementById('settingsTimeout'),
  concurrencyHint: document.getElementById('concurrencyHint'),
  throughputHint: document.getElementById('throughputHint'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  settingsMsg: document.getElementById('settingsMsg'),
};

let currentBrowse = null; // last successful /api/browse response, for "Use this folder" / "Up"

/**
 * Reduces a card name to a comparison key: case, punctuation, spacing, and the
 * usual version/copy suffixes people accumulate when collecting cards.
 */
function dedupeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(png|json)$/i, '')
    .replace(/[\[(<{].*?[\])>}]/g, ' ')      // (1), [v2], {final}
    .replace(/\b(v|ver|version)\s*\d+(\.\d+)?\b/g, ' ')
    .replace(/\b(copy|final|new|old|edit|edited|fixed|updated|rev|remake|alt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+\d+\s*$/, ' ')             // trailing bare numbers
    .replace(/\s+/g, '');                    // "Cream Heart" === "CreamHeart"
}

// Collection labels that get glued onto a character's name. "SCPMalo" is the
// same character as "Malo"; the prefix is a source tag, not part of who they are.
const NAME_AFFIXES = ['scp', 'oc', 'nsfw', 'sfw', 'ai', 'bot', 'char', 'card', 'the', 'my'];
function stripAffixes(key) {
  let out = key;
  for (let changed = true; changed;) {
    changed = false;
    for (const a of NAME_AFFIXES) {
      if (out.length > a.length + 3 && out.startsWith(a)) { out = out.slice(a.length); changed = true; }
      if (out.length > a.length + 3 && out.endsWith(a)) { out = out.slice(0, -a.length); changed = true; }
    }
  }
  return out;
}

/** True when the edit distance between a and b is at most max. Bails early. */
function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Whether two normalized names are the same character. Deliberately textual —
 * no AI, no image comparison — but it catches the three ways collections
 * actually differ: a source tag glued on (Malo / SCPMalo), one name contained
 * in a longer one (Mira / Mira Solace), and small spelling drift
 * (Kaelen / Kaelan). Short names are held to stricter rules so genuinely
 * different characters (Nyx / Onyx) do not merge.
 */
function namesSimilar(a, b) {
  if (a === b) return true;
  const sa = stripAffixes(a);
  const sb = stripAffixes(b);
  if (sa === sb && sa.length >= 3) return true;

  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.4) return true;

  const maxEdits = short.length >= 8 ? 2 : short.length >= 5 ? 1 : 0;
  return maxEdits > 0 && editDistanceAtMost(sa, sb, maxEdits);
}

/**
 * Groups cards by similar name using union-find. Computed once per card list
 * (cached in state) rather than per render — it is O(n^2)-ish over unique keys
 * and would otherwise re-run on every keystroke in the search box.
 */
function computeGroups() {
  const keyOf = new Map();
  for (const c of state.cards) keyOf.set(c.id, dedupeKey(c.name));

  const uniq = [...new Set(keyOf.values())].filter(Boolean);
  const stripped = uniq.map(stripAffixes);
  const order = uniq.map((_, i) => i).sort((a, b) => stripped[a].length - stripped[b].length);

  const parent = uniq.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const si = stripped[i];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      // Sorted by length, so once a candidate is too long to satisfy either the
      // containment ratio or the edit budget, nothing after it can match either.
      if (stripped[j].length > si.length / 0.4 && stripped[j].length - si.length > 2) break;
      if (namesSimilar(uniq[i], uniq[j])) union(i, j);
    }
  }

  // Map every card to its group's representative key.
  const keyToRoot = new Map();
  uniq.forEach((k, i) => keyToRoot.set(k, uniq[find(i)]));

  const groups = new Map();
  for (const card of state.cards) {
    const root = keyToRoot.get(keyOf.get(card.id));
    if (!root) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(card);
  }
  for (const [k, list] of groups) if (list.length < 2) groups.delete(k);

  state.groupOf = new Map();
  state.dupeIds = new Set();
  state.bestIds = new Set();
  state.groupSizes = new Map();
  for (const [root, list] of groups) {
    const scored = list.filter((c) => c.overallScore != null);
    const pool = scored.length ? scored : list;
    const winner = pool.reduce((a, b) => ((b.overallScore ?? -1) > (a.overallScore ?? -1) ? b : a));
    state.bestIds.add(winner.id);
    state.groupSizes.set(root, list.length);
    for (const c of list) {
      state.dupeIds.add(c.id);
      state.groupOf.set(c.id, root);
    }
  }
  state.groups = groups;
}

function scoreClass(score, error) {
  if (error) return 'score-error';
  if (score == null) return 'score-unscored';
  if (score >= 8) return 'score-great';
  if (score >= 6) return 'score-good';
  if (score >= 4) return 'score-mediocre';
  return 'score-weak';
}

function getAuthToken() {
  try {
    return localStorage.getItem('ssr_token') || '';
  } catch {
    return '';
  }
}

function setAuthToken(token) {
  try {
    localStorage.setItem('ssr_token', token);
  } catch {
    // localStorage unavailable (e.g. private browsing) — token just won't persist across reloads
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getAuthToken();
  if (token) headers['x-auth-token'] = token;

  let res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const entered = prompt('This dashboard is protected with an access token (set as "authToken" in config.json). Enter it:');
    if (entered) {
      setAuthToken(entered);
      headers['x-auth-token'] = entered;
      res = await fetch(url, { ...options, headers });
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

async function loadCards() {
  const data = await api('/api/cards');
  state.cards = data.cards;
  els.dirLabel.textContent = data.charactersDir;
  computeGroups();   // once per load, not per render
  renderStats();
  renderGrid();
}

function renderStats() {
  const total = state.cards.length;
  const scored = state.cards.filter((c) => c.overallScore != null).length;
  const errored = state.cards.filter((c) => c.error).length;
  const avg = scored
    ? (state.cards.reduce((s, c) => s + (c.overallScore || 0), 0) / scored).toFixed(2)
    : '—';
  els.stats.textContent = `${total} cards · ${scored} scored (avg ${avg}) · ${errored} errors`;
}

function passesFilter(card) {
  // Focusing one name group overrides the dropdown — you asked to see these
  // specific cards, so show all of them regardless of score/scored state.
  if (state.focusKey) return state.groupOf.get(card.id) === state.focusKey;
  const f = els.filterBy.value;
  if (f === 'duplicates') return state.dupeIds.has(card.id);
  if (f === 'unscored') return card.overallScore == null || card.error;
  if (f === 'below4') return card.overallScore != null && card.overallScore < 4;
  if (f === 'below6') return card.overallScore != null && card.overallScore < 6;
  if (f === 'scored') return card.overallScore != null;
  return true;
}

function sortCards(cards) {
  const mode = els.sortBy.value;
  const withDefault = (v, fallback) => (v == null ? fallback : v);
  const sorted = [...cards];
  switch (mode) {
    case 'score-asc':
      sorted.sort((a, b) => withDefault(a.overallScore, -1) - withDefault(b.overallScore, -1));
      break;
    case 'score-desc':
      sorted.sort((a, b) => withDefault(b.overallScore, -1) - withDefault(a.overallScore, -1));
      break;
    case 'tokens-desc':
      sorted.sort((a, b) => withDefault(b.tokenEstimate, 0) - withDefault(a.tokenEstimate, 0));
      break;
    case 'tokens-asc':
      sorted.sort((a, b) => withDefault(a.tokenEstimate, 0) - withDefault(b.tokenEstimate, 0));
      break;
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
  return sorted;
}

function renderGrid() {
  const query = els.search.value.trim().toLowerCase();

  let cards = state.cards.filter((c) => c.name.toLowerCase().includes(query) && passesFilter(c));
  cards = sortCards(cards);

  // In the duplicates view, keep each group together and put the best first,
  // so the keep/cull decision is a glance rather than a search.
  if (els.filterBy.value === 'duplicates' || state.focusKey) {
    cards.sort((a, b) => {
      const ka = state.groupOf.get(a.id) || '';
      const kb = state.groupOf.get(b.id) || '';
      if (ka !== kb) return ka.localeCompare(kb);
      return (b.overallScore ?? -1) - (a.overallScore ?? -1);
    });
  }
  state.shown = cards; // what "Select all shown" acts on

  els.grid.innerHTML = '';
  els.emptyState.classList.toggle('hidden', cards.length > 0);
  renderSelectionBar();

  cards.forEach((card, index) => {
    const tile = document.createElement('div');
    tile.className = 'card-tile';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'card-checkbox';
    checkbox.checked = state.selected.has(card.id);
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      // Shift-click selects everything between the last box you touched and
      // this one — ticking a few hundred boxes individually is not a workflow.
      if (e.shiftKey && state.lastToggledIndex != null) {
        const from = Math.min(state.lastToggledIndex, index);
        const to = Math.max(state.lastToggledIndex, index);
        const turningOn = !state.selected.has(card.id);
        for (let i = from; i <= to; i++) {
          const id = state.shown[i].id;
          if (turningOn) state.selected.add(id);
          else state.selected.delete(id);
        }
        state.lastToggledIndex = index;
        e.preventDefault();
        renderGrid();
        return;
      }
      state.lastToggledIndex = index;
    });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(card.id);
      else state.selected.delete(card.id);
      renderSelectionBar();
    });
    tile.appendChild(checkbox);

    const badge = document.createElement('div');
    badge.className = `score-badge ${scoreClass(card.overallScore, card.error)}`;
    badge.textContent = card.error ? '!' : card.overallScore != null ? card.overallScore : '–';
    tile.appendChild(badge);

    if (card.isImage) {
      const img = document.createElement('img');
      img.className = 'card-thumb';
      img.loading = 'lazy';
      img.src = `/api/cards/${encodeURIComponent(card.id)}/image`;
      tile.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'card-thumb-placeholder';
      ph.textContent = card.name.slice(0, 2).toUpperCase();
      tile.appendChild(ph);
    }

    const info = document.createElement('div');
    info.className = 'card-info';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.title = card.name;
    name.textContent = card.name;
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = card.tokenEstimate != null ? `~${card.tokenEstimate} tok` : '';
    if (state.dupeIds.has(card.id)) {
      const key = state.groupOf.get(card.id);
      const isBest = state.bestIds.has(card.id);
      meta.appendChild(document.createElement('br'));

      // Click to pull up every card sharing this name — the "I have 5 Ravens,
      // show me just those" action, done from the card itself.
      const chip = document.createElement('button');
      chip.className = `dupe-tag dupe-link ${isBest ? 'dupe-best' : 'dupe-worse'}`;
      chip.textContent = `${state.groupSizes.get(key) || 2} SAME NAME${isBest ? ' · BEST' : ''}`;
      chip.title = `Show only the ${state.groupSizes.get(key) || 2} cards named like "${card.name}"`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        focusGroup(key);
      });
      meta.appendChild(chip);
    }
    info.appendChild(name);
    info.appendChild(meta);
    tile.appendChild(info);

    if (state.selected.has(card.id)) tile.classList.add('is-selected');
    tile.addEventListener('click', () => {
      // On a phone there is no shift-click, so Select mode turns a plain tap
      // into a selection toggle instead of opening the card.
      if (state.selectMode) {
        if (state.selected.has(card.id)) state.selected.delete(card.id);
        else state.selected.add(card.id);
        state.lastToggledIndex = index;
        renderGrid();
        return;
      }
      openCard(card.id);
    });
    els.grid.appendChild(tile);
  });
}

function focusGroup(key) {
  state.focusKey = key;
  state.lastToggledIndex = null;
  els.search.value = '';
  renderGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearFocus() {
  state.focusKey = null;
  state.lastToggledIndex = null;
  renderGrid();
}

function renderFocusBar() {
  if (!state.focusKey) {
    els.focusBar.classList.add('hidden');
    return;
  }
  const list = state.shown;
  const best = list.find((c) => state.bestIds.has(c.id));
  els.focusBar.classList.remove('hidden');
  els.focusLabel.textContent =
    `Showing ${list.length} cards named like "${list[0]?.name ?? state.focusKey}"` +
    (best?.overallScore != null ? ` — best is ${best.name} at ${best.overallScore}/10` : '');
}

function renderSelectionBar() {
  const n = state.selected.size;
  const shown = state.shown || [];
  const allShownSelected = shown.length > 0 && shown.every((c) => state.selected.has(c.id));

  els.shownCount.textContent = `${shown.length} card${shown.length === 1 ? '' : 's'} shown`;
  els.selectAllShownBtn.textContent = allShownSelected ? 'Deselect all shown' : `Select all shown (${shown.length})`;
  els.selectAllShownBtn.classList.toggle('hidden', shown.length === 0);
  els.selectDupeLosersBtn.classList.toggle('hidden', els.filterBy.value !== 'duplicates');
  renderFocusBar();

  els.selectionCount.textContent = n ? `${n} selected` : '';
  for (const btn of [els.scoreSelectedBtn, els.copySelectedBtn, els.deleteSelectedBtn, els.clearSelectionBtn]) {
    btn.classList.toggle('hidden', n === 0);
  }
  els.deleteSelectedBtn.textContent = n ? `Delete selected (${n})` : 'Delete selected';
  els.copySelectedBtn.textContent = n ? `Copy selected (${n}) to…` : 'Copy selected to…';
}

async function openCard(id) {
  const data = await api(`/api/cards/${encodeURIComponent(id)}`);
  const entry = data.entry;
  const result = entry?.result;

  let html = `<h2>${escapeHtml(data.name)}</h2>`;
  html += `<div class="modal-actions">
    <button data-action="score">${result ? 'Rescore' : 'Score this card'}</button>
    <button data-action="delete" class="danger">Delete</button>
  </div>`;

  if (entry?.error) {
    html += `<p style="color:var(--red)">Last attempt failed: ${escapeHtml(entry.error)}</p>`;
  }

  if (result) {
    html += `<div class="overall-block">
      <div class="overall-score">${result.overall_score} / 10</div>
      ${result.partial
        ? '<div class="partial-note">Score only. This score was recovered from a previous session, so the written critique is not available — click <b>Rescore</b> above to generate it. The card\'s own text is shown below so you can still judge it yourself.</div>'
        : `<div>${escapeHtml(result.summary || '')}</div>`}
      ${result.top_priority_improvements?.length ? `<ol class="priority-list">${result.top_priority_improvements.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>` : ''}
    </div>`;

    for (const [field, f] of Object.entries(result.fields)) {
      html += `<div class="field-block">
        <div class="field-title"><span>${escapeHtml(field.replace(/_/g, ' '))}</span><span class="field-score">${f.score ?? '–'}/10</span></div>
        <div class="field-sub"><b>Strengths:</b> ${escapeHtml(f.strengths || '—')}</div>
        <div class="field-sub"><b>Weaknesses:</b> ${escapeHtml(f.weaknesses || '—')}</div>
        <div class="field-sub"><b>Suggestions:</b> ${escapeHtml(f.suggestions || '—')}</div>
      </div>`;
    }
  } else if (!entry?.error) {
    html += `<p>Not scored yet.</p>`;
  }

  // The card's own text, straight from the PNG. For a score-only entry this is
  // the whole point — without a critique you still need to see what the card
  // actually says to decide whether to keep it. Open by default when there is
  // no critique to read, collapsed otherwise.
  const populated = Object.entries(data.fields || {}).filter(([, v]) => v && v.trim());
  if (populated.length) {
    const noCritique = !result || result.partial || Object.keys(result.fields || {}).length === 0;
    html += `<details class="card-content" ${noCritique ? 'open' : ''}>
      <summary>Card content (${populated.length} field${populated.length === 1 ? '' : 's'})</summary>
      ${populated.map(([name, text]) => `
        <div class="field-block">
          <div class="field-title"><span>${escapeHtml(name.replace(/_/g, ' '))}</span><span class="field-score">~${Math.ceil(text.length / 4)} tok</span></div>
          <pre class="card-field-text">${escapeHtml(text)}</pre>
        </div>`).join('')}
    </details>`;
  }

  els.modalBody.innerHTML = html;
  els.modalBackdrop.classList.remove('hidden');

  els.modalBody.querySelector('[data-action="score"]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Scoring…';
    try {
      await api(`/api/cards/${encodeURIComponent(id)}/score`, { method: 'POST' });
      await loadCards();
      await openCard(id);
    } catch (err) {
      alert(`Scoring failed: ${err.message}`);
      e.target.disabled = false;
    }
  });

  els.modalBody.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Move "${data.name}" to trash?`)) return;
    await api('/api/cards/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    closeModal();
    await loadCards();
  });
}

function closeModal() {
  els.modalBackdrop.classList.add('hidden');
  els.modalBody.innerHTML = '';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function renderScanPanel(job) {
  const finished = job.done + job.errors;
  const pct = job.total ? Math.round((finished / job.total) * 100) : 100;
  els.progressFill.style.width = `${pct}%`;
  els.progressLabel.textContent = `${finished} / ${job.total} processed (${pct}%)`;

  // Scored and failed are shown as separate figures on purpose: a run that is
  // failing every card still advances the bar, which previously made a broken
  // run look like a slow one.
  const stats = [
    { label: 'Scored', value: job.done, cls: 'is-ok' },
    { label: 'Failed', value: job.errors, cls: job.errors ? 'is-error' : '' },
    { label: 'In flight', value: `${job.inFlight}/${job.concurrency}` },
    { label: 'Rate', value: job.perHour != null ? `${Math.round(job.perHour)}/hr` : '…' },
    { label: 'Median', value: fmtDuration(job.medianLatencyMs) },
    { label: 'ETA', value: job.status === 'running' ? fmtDuration(job.etaMs) : 'done' },
    { label: 'Elapsed', value: fmtDuration(job.elapsedMs) },
  ];
  els.scanStats.innerHTML = stats
    .map((s) => `<div class="scan-stat ${s.cls || ''}"><b>${escapeHtml(String(s.value))}</b><span>${escapeHtml(s.label)}</span></div>`)
    .join('');

  els.scanActive.innerHTML = job.active.length
    ? job.active
        .map((a) => {
          // Flag requests that have been waiting a long time — the visible symptom
          // of a model that's too slow, rather than silently sitting there.
          const slow = a.elapsedMs > 30000;
          return `<li><span>${escapeHtml(a.file)}</span><span class="${slow ? 'slow' : 'dim'}">${fmtDuration(a.elapsedMs)}${slow ? ' ⚠' : ''}</span></li>`;
        })
        .join('')
    : '<li><span class="dim">idle</span></li>';

  els.scanRecent.innerHTML = job.recent.length
    ? job.recent
        .map((r) =>
          r.error
            ? `<li><span title="${escapeHtml(r.error)}">${escapeHtml(r.file)}</span><span class="bad">failed ${fmtDuration(r.tookMs)}</span></li>`
            : `<li><span>${escapeHtml(r.name || r.file)}</span><span class="ok">${r.overallScore}/10 · ${fmtDuration(r.tookMs)}</span></li>`,
        )
        .join('')
    : '<li><span class="dim">nothing yet</span></li>';
}

async function pollJob(jobId) {
  els.scanPanel.classList.remove('hidden');
  els.hideScanPanelBtn.classList.add('hidden'); // only offered once the run ends
  let lastGridRefresh = Date.now();
  let job;

  while (true) {
    job = await api(`/api/score/batch/${jobId}`);
    renderScanPanel(job);

    if (job.status !== 'running') {
      if (job.fatalError) alert(`Batch scoring failed to start: ${job.fatalError}`);
      break;
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Rebuilding the whole grid re-requests every thumbnail. At a few thousand
    // cards that starved the server's scoring pool, so refresh it sparingly
    // while a job runs — the panel above is the live feedback.
    if (Date.now() - lastGridRefresh > 20000) {
      lastGridRefresh = Date.now();
      await loadCards();
    }
  }

  await loadCards();
  renderScanPanel(job);
  // Leave the finished summary up so the run's outcome is reviewable, but let
  // it be dismissed now that nothing is streaming into it.
  els.hideScanPanelBtn.classList.remove('hidden');

  if (job.errors > 0) {
    // Say *why* they failed rather than only how many — the fix for timeouts
    // (slower model / longer deadline) is the opposite of the fix for unusable
    // output (different model / more tokens).
    let why = '';
    try {
      const f = await api('/api/failures');
      if (f.groups?.length) {
        why = '\n\nWhy they failed:\n' + f.groups.map((g) => `  ${g.count}x  ${g.kind}`).join('\n');
      }
    } catch {
      // breakdown is a nicety; never let it swallow the main message
    }
    alert(
      `${job.errors} of ${job.done + job.errors} cards failed to score.${why}\n\n` +
      `Failed cards are not lost — "Scan unscored" retries them.\n\n` +
      `For a live check against your API, run:  node src/cli.js doctor`,
    );
  }
}

async function startBatch(body) {
  const { jobId } = await api('/api/score/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pollJob(jobId);
}

async function loadTrash() {
  const { items } = await api('/api/trash');
  els.trashList.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = item.file;
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Restore';
    restoreBtn.className = 'secondary';
    restoreBtn.addEventListener('click', async () => {
      await api('/api/trash/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [item.file] }) });
      await loadTrash();
      await loadCards();
    });
    li.appendChild(label);
    li.appendChild(restoreBtn);
    els.trashList.appendChild(li);
  }
}

els.search.addEventListener('input', renderGrid);
els.sortBy.addEventListener('change', renderGrid);
els.filterBy.addEventListener('change', () => {
  state.focusKey = null;
  renderGrid();
});
els.clearFocusBtn.addEventListener('click', clearFocus);
els.selectFocusLosersBtn.addEventListener('click', () => {
  for (const card of state.shown) {
    if (!state.bestIds.has(card.id)) state.selected.add(card.id);
  }
  renderGrid();
});

els.scanUnscoredBtn.addEventListener('click', () => startBatch({ scope: 'unscored' }));
els.rescanAllBtn.addEventListener('click', () => {
  if (confirm('Rescore ALL cards? This re-runs every card through the model, which costs time/money on a paid API.')) {
    startBatch({ scope: 'all', rescore: true });
  }
});

els.scoreSelectedBtn.addEventListener('click', () => startBatch({ scope: 'selected', ids: [...state.selected], rescore: true }));
els.deleteSelectedBtn.addEventListener('click', async () => {
  const ids = [...state.selected];
  if (ids.length === 0) return;

  // Deleting hundreds at once deserves more than a bare count — show the score
  // range going out and a few names, so a mis-set filter is obvious before it
  // sweeps away good cards.
  const chosen = state.cards.filter((c) => state.selected.has(c.id));
  const scores = chosen.map((c) => c.overallScore).filter((s) => s != null);
  const scoreLine = scores.length
    ? `Scores range ${Math.min(...scores)} – ${Math.max(...scores)}.`
    : 'None of these have been scored yet.';
  const sample = chosen.slice(0, 5).map((c) => `  • ${c.name}${c.overallScore != null ? ` (${c.overallScore}/10)` : ''}`).join('\n');
  const more = chosen.length > 5 ? `\n  …and ${chosen.length - 5} more` : '';

  if (!confirm(`Move ${ids.length} card${ids.length === 1 ? '' : 's'} to trash?\n\n${scoreLine}\n\n${sample}${more}\n\nThis moves the files to data/trash/ — you can restore them from the Trash panel.`)) return;

  const res = await api('/api/cards/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selected.clear();
  await loadCards();
  if (res.errors?.length) {
    alert(`Moved ${res.moved.length} to trash. ${res.errors.length} could not be moved:\n\n${res.errors.slice(0, 5).map((e) => `${e.file}: ${e.error}`).join('\n')}`);
  }
});
els.clearSelectionBtn.addEventListener('click', () => {
  state.selected.clear();
  renderGrid();
});

// The point of the filters is to isolate a group (e.g. "Score below 4") and act
// on all of it at once — ticking several hundred checkboxes by hand is not a
// workflow. This selects/deselects exactly what the current filter+search shows.
els.hideScanPanelBtn.addEventListener('click', () => els.scanPanel.classList.add('hidden'));

els.selectModeBtn.addEventListener('click', () => {
  state.selectMode = !state.selectMode;
  els.selectModeBtn.classList.toggle('active', state.selectMode);
  document.body.classList.toggle('select-mode', state.selectMode);
  els.selectModeBtn.textContent = state.selectMode ? 'Select mode: ON' : 'Select mode';
  renderGrid();
});

// A local backup of just the score numbers. Cheap insurance: if the data file
// is ever lost or split, these can be imported back without re-paying for the
// scoring (node src/cli.js import-scores <file>).
els.exportScoresBtn.addEventListener('click', () => {
  const scores = state.cards
    .filter((c) => c.overallScore != null)
    .map((c) => ({ id: c.id, name: c.name, overallScore: c.overallScore, tokenEstimate: c.tokenEstimate }));
  if (!scores.length) {
    alert('No scored cards to export yet.');
    return;
  }
  const payload = { exportedAt: new Date().toISOString(), charactersDir: els.dirLabel.textContent, scores };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.download = `sillyscorereview-scores-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// The whole point of the duplicates view: keep the best of each near-identical
// group and select the rest for culling, without hand-picking.
els.selectDupeLosersBtn.addEventListener('click', () => {
  let n = 0;
  for (const list of state.groups.values()) {
    for (const card of list) {
      if (!state.bestIds.has(card.id)) { state.selected.add(card.id); n++; }
    }
  }
  renderGrid();
  if (n === 0) alert('No similar-name groups found — every card name looks unique.');
});

els.selectAllShownBtn.addEventListener('click', () => {
  const shown = state.shown || [];
  const allSelected = shown.length > 0 && shown.every((c) => state.selected.has(c.id));
  for (const card of shown) {
    if (allSelected) state.selected.delete(card.id);
    else state.selected.add(card.id);
  }
  renderGrid();
});

els.trashToggleBtn.addEventListener('click', async () => {
  els.trashPanel.classList.remove('hidden');
  await loadTrash();
});
els.closeTrashBtn.addEventListener('click', () => els.trashPanel.classList.add('hidden'));
els.emptyTrashBtn.addEventListener('click', async () => {
  if (!confirm('Permanently delete everything in trash? This cannot be undone.')) return;
  await api('/api/trash/empty', { method: 'POST' });
  await loadTrash();
});

async function browseFolder(targetPath) {
  const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
  try {
    const data = await api(`/api/browse${qs}`);
    currentBrowse = data;
    els.folderPathInput.value = data.path;
    els.folderInfo.textContent = `${data.cardCount} card file${data.cardCount === 1 ? '' : 's'} directly in this folder`;
    els.folderList.innerHTML = '';
    for (const dir of data.dirs) {
      const li = document.createElement('li');
      li.textContent = `📁 ${dir.name}`;
      li.addEventListener('click', () => browseFolder(dir.path));
      els.folderList.appendChild(li);
    }
  } catch (err) {
    els.folderInfo.textContent = err.message;
  }
}

// The folder panel does double duty: picking the library to review, and picking
// a destination to copy cards into. Same browser, different verb.
let folderPurpose = 'switch';

function setFolderPurpose(purpose) {
  folderPurpose = purpose;
  const copying = purpose === 'copy';
  els.folderPanelTitle.textContent = copying ? 'Copy cards to…' : 'Choose characters folder';
  els.folderPanelHint.innerHTML = copying
    ? 'Browse to the folder you want the selected cards copied into, or type a full path — a folder that does not exist yet will be created. The originals stay exactly where they are.'
    : 'Browse to the folder holding your SillyTavern card PNGs/JSON (e.g. <code>SillyTavern/data/default-user/characters</code>), or paste the full path directly.';
  els.useFolderBtn.classList.toggle('hidden', copying);
  els.copyHereBtn.classList.toggle('hidden', !copying);
}

async function openFolderPanel(purpose, startAt) {
  setFolderPurpose(purpose);
  els.folderPanel.classList.remove('hidden');
  await browseFolder(startAt);
}

els.folderBtn.addEventListener('click', async () => {
  await openFolderPanel('switch', els.dirLabel.textContent || undefined);
});
els.closeFolderBtn.addEventListener('click', () => els.folderPanel.classList.add('hidden'));
els.folderGoBtn.addEventListener('click', () => browseFolder(els.folderPathInput.value.trim()));
els.folderPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') browseFolder(els.folderPathInput.value.trim());
});
els.folderHomeBtn.addEventListener('click', async () => {
  const data = await api('/api/browse');
  browseFolder(data.home);
});
els.folderUpBtn.addEventListener('click', () => {
  if (currentBrowse?.parent) browseFolder(currentBrowse.parent);
});
els.useFolderBtn.addEventListener('click', async () => {
  if (!currentBrowse) return;
  try {
    const data = await api('/api/settings/characters-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: currentBrowse.path }),
    });
    els.folderPanel.classList.add('hidden');
    await loadCards();
    if (!data.persisted) {
      alert(`Folder switched for this session, but couldn't save it to config.json (${data.persistError}). You'll need to pick it again next time you start the server, or set "charactersDir" in config.json yourself.`);
    }
  } catch (err) {
    alert(`Could not switch folder: ${err.message}`);
  }
});

els.copySelectedBtn.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  // Start from the parent of the current library — the destination is almost
  // always a sibling folder ("keepers", "to fix"), not somewhere far away.
  const start = currentBrowse?.path || els.dirLabel.textContent || undefined;
  await openFolderPanel('copy', start);
});

els.copyHereBtn.addEventListener('click', async () => {
  const ids = [...state.selected];
  if (ids.length === 0) {
    alert('Nothing is selected to copy.');
    return;
  }
  // A typed path wins over the browsed one, so a not-yet-existing folder can be
  // named and created in one step.
  const destination = els.folderPathInput.value.trim() || currentBrowse?.path || '';
  if (!destination) return;
  if (!confirm(`Copy ${ids.length} card${ids.length === 1 ? '' : 's'} to:\n\n${destination}\n\nThe originals stay where they are.`)) return;

  els.copyHereBtn.disabled = true;
  const previousLabel = els.copyHereBtn.textContent;
  els.copyHereBtn.textContent = 'Copying…';
  try {
    const res = await api('/api/cards/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, destination }),
    });
    els.folderPanel.classList.add('hidden');
    const parts = [`Copied ${res.copied.length} card${res.copied.length === 1 ? '' : 's'} to ${res.destination}.`];
    if (res.skipped.length) parts.push(`${res.skipped.length} were already there.`);
    if (res.errors.length) {
      parts.push(`${res.errors.length} failed:`);
      parts.push(res.errors.slice(0, 5).map((e) => `  • ${e.file}: ${e.error}`).join('\n'));
    }
    parts.push('\nScores were copied across too, so opening that folder later will show them without a rescan.');
    alert(parts.join('\n'));
  } catch (err) {
    alert(`Could not copy: ${err.message}`);
  } finally {
    els.copyHereBtn.disabled = false;
    els.copyHereBtn.textContent = previousLabel;
  }
});

let settingsPresets = {};

async function openSettings() {
  els.settingsPanel.classList.remove('hidden');
  els.settingsMsg.textContent = 'Loading…';
  try {
    const data = await api('/api/settings');
    settingsPresets = data.presets;
    els.settingsProvider.innerHTML = Object.entries(settingsPresets)
      .map(([key, p]) => `<option value="${key}">${escapeHtml(p.label)}</option>`)
      .join('');
    els.settingsProvider.value = data.provider;
    els.settingsBaseUrl.value = data.baseURL || '';
    els.settingsConcurrency.value = data.concurrency;
    els.settingsRpm.value = data.requestsPerMinute ?? 0;
    els.settingsTimeout.value = Math.round((data.timeoutMs ?? 120000) / 1000);
    els.settingsModelCustom.value = data.model || '';
    els.apiKeyStatus.textContent = data.apiKeySet ? '(a key is saved — leave blank to keep it)' : '(none saved yet)';
    els.settingsApiKey.value = '';
    els.settingsModelSelect.innerHTML = `<option value="">— save settings, then Refresh list —</option>`;
    els.settingsMsg.textContent = '';
    els.concurrencyHint.textContent = settingsPresets[data.provider]?.rateLimitNote || '';
    updateThroughputHint();
  } catch (err) {
    els.settingsMsg.textContent = `Could not load settings: ${err.message}`;
  }
}

async function loadModelList(messagePrefix = '') {
  els.settingsMsg.textContent = `${messagePrefix}Loading model list…`;
  try {
    const { models } = await api('/api/models');
    els.settingsModelSelect.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    if (els.settingsModelCustom.value && models.includes(els.settingsModelCustom.value)) {
      els.settingsModelSelect.value = els.settingsModelCustom.value;
    }
    els.settingsMsg.textContent = `${messagePrefix}${models.length} model${models.length === 1 ? '' : 's'} available. Pick one above, or type a name manually.`;
  } catch (err) {
    els.settingsMsg.textContent = `${messagePrefix}Couldn't load the model list (${err.message}). Type the model name manually instead.`;
  }
}

els.settingsBtn.addEventListener('click', openSettings);
els.closeSettingsBtn.addEventListener('click', () => els.settingsPanel.classList.add('hidden'));

els.settingsProvider.addEventListener('change', () => {
  const preset = settingsPresets[els.settingsProvider.value];
  if (preset) els.settingsBaseUrl.value = preset.baseURL;
  els.settingsModelSelect.innerHTML = `<option value="">— save settings, then Refresh list —</option>`;
  els.concurrencyHint.textContent = preset?.rateLimitNote || '';
  if (preset?.requestsPerMinute !== undefined) els.settingsRpm.value = preset.requestsPerMinute;
  if (preset?.maxConcurrency && Number(els.settingsConcurrency.value) > preset.maxConcurrency) {
    els.settingsConcurrency.value = preset.maxConcurrency;
  }
  updateThroughputHint();
});

// Show what the current pacing actually means in cards/hour, so the tradeoff is
// concrete rather than an abstract number.
function updateThroughputHint() {
  const rpm = Number(els.settingsRpm.value) || 0;
  const conc = Number(els.settingsConcurrency.value) || 1;
  const total = state.cards.length;
  if (!rpm) {
    els.throughputHint.textContent = 'No pacing: requests go as fast as concurrency allows. Only safe for a local model on your own hardware.';
    return;
  }
  const perHour = rpm * 60;
  const hours = total ? total / perHour : null;
  const eta = hours == null ? '' : hours < 1 ? ` — about ${Math.round(hours * 60)} min for all ${total} cards` : ` — about ${hours.toFixed(1)} h for all ${total} cards`;
  els.throughputHint.textContent =
    `${rpm}/min = up to ${perHour} cards/hour${eta}. ` +
    `Reaching that also needs the model to answer in under ~${(conc / rpm * 60).toFixed(0)}s; slower than that and concurrency (${conc}) becomes the limit instead.`;
}

els.settingsRpm.addEventListener('input', updateThroughputHint);
els.settingsConcurrency.addEventListener('input', updateThroughputHint);

els.settingsModelSelect.addEventListener('change', () => {
  if (els.settingsModelSelect.value) els.settingsModelCustom.value = els.settingsModelSelect.value;
});

els.refreshModelsBtn.addEventListener('click', () => loadModelList());

els.saveSettingsBtn.addEventListener('click', async () => {
  const body = {
    provider: els.settingsProvider.value,
    baseURL: els.settingsBaseUrl.value.trim(),
    model: els.settingsModelCustom.value.trim(),
    concurrency: Number(els.settingsConcurrency.value) || undefined,
    requestsPerMinute: els.settingsRpm.value === '' ? undefined : Number(els.settingsRpm.value),
    timeoutMs: els.settingsTimeout.value ? Number(els.settingsTimeout.value) * 1000 : undefined,
  };
  if (els.settingsApiKey.value.trim()) body.apiKey = els.settingsApiKey.value.trim();

  els.saveSettingsBtn.disabled = true;
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    els.settingsApiKey.value = '';
    els.apiKeyStatus.textContent = '(a key is saved — leave blank to keep it)';
    const savedMsg = data.persisted
      ? 'Saved. '
      : `Saved for this session only — couldn't write config.json (${data.persistError}). `;
    await loadModelList(savedMsg);
  } catch (err) {
    els.settingsMsg.textContent = `Save failed: ${err.message}`;
  } finally {
    els.saveSettingsBtn.disabled = false;
  }
});

els.modalClose.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

loadCards().catch(async (err) => {
  // Most likely first run: no charactersDir picked yet. Guide straight to the folder picker.
  els.emptyState.textContent = `Couldn't read the characters folder yet (${err.message}). Use "Change folder" below to pick it.`;
  els.emptyState.classList.remove('hidden');
  await openFolderPanel('switch');
});
