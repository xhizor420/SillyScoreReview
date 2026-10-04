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
  renderLimit: 0,         // how many of state.shown are actually built as DOM
  scoreBucket: null,      // 1-10: show only cards scoring in [n, n+1) — set by the distribution chart
  charactersDir: '',      // the folder being reviewed (the header label is display-only)
};

const els = {
  grid: document.getElementById('grid'),
  emptyState: document.getElementById('emptyState'),
  stats: document.getElementById('stats'),
  dirLabel: document.getElementById('dirLabel'),
  search: document.getElementById('search'),
  sortBy: document.getElementById('sortBy'),
  filterBy: document.getElementById('filterBy'),
  fastScanBtn: document.getElementById('fastScanBtn'),
  critiqueScanBtn: document.getElementById('critiqueScanBtn'),
  rescanAllBtn: document.getElementById('rescanAllBtn'),
  trashToggleBtn: document.getElementById('trashToggleBtn'),
  exportScoresBtn: document.getElementById('exportScoresBtn'),
  scanPanel: document.getElementById('scanPanel'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  scanStats: document.getElementById('scanStats'),
  hideScanPanelBtn: document.getElementById('hideScanPanelBtn'),
  stopScanBtn: document.getElementById('stopScanBtn'),
  dist: document.getElementById('dist'),
  distHint: document.getElementById('distHint'),
  distTooltip: document.getElementById('distTooltip'),
  moreBtn: document.getElementById('moreBtn'),
  moreMenu: document.getElementById('moreMenu'),
  promptsBtn: document.getElementById('promptsBtn'),
  densityComfy: document.getElementById('densityComfy'),
  densityCompact: document.getElementById('densityCompact'),
  scanBanner: document.getElementById('scanBanner'),
  scanBannerText: document.getElementById('scanBannerText'),
  resumeScanBtn: document.getElementById('resumeScanBtn'),
  bannerSettingsBtn: document.getElementById('bannerSettingsBtn'),
  backupList: document.getElementById('backupList'),
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
  critiqueSelectedBtn: document.getElementById('critiqueSelectedBtn'),
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
  settingsDetail: document.getElementById('settingsDetail'),
  settingsMaxTokens: document.getElementById('settingsMaxTokens'),
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
  if (!res.ok) {
    const err = new Error(json.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function loadCards() {
  const data = await api('/api/cards');
  state.cards = data.cards;
  state.charactersDir = data.charactersDir;
  // The label truncates from the left so the end of a long path (the folder
  // that matters) stays visible. That needs right-to-left layout, which would
  // otherwise move the leading "/" or "C:\\" to the far end — the LRM marks
  // pin it in place. Code that needs the path reads state.charactersDir.
  els.dirLabel.textContent = `\u200E${data.charactersDir}\u200E`;
  els.dirLabel.title = data.charactersDir;
  computeGroups();   // once per load, not per render
  renderStats();
  renderGrid();
}

/**
 * The numbers a culling session starts from, as a row of stat tiles. Each one
 * that names a set of cards is also a shortcut to that set.
 */
function renderStats() {
  const total = state.cards.length;
  const scoredCards = state.cards.filter((c) => c.overallScore != null);
  const scored = scoredCards.length;
  const errored = state.cards.filter((c) => c.error).length;
  const unscored = state.cards.filter((c) => c.overallScore == null && !c.error).length;
  const stale = state.cards.filter((c) => c.promptStale).length;
  const avg = scored ? (scoredCards.reduce((sum, c) => sum + c.overallScore, 0) / scored).toFixed(1) : '—';

  const tiles = [
    { value: total.toLocaleString(), label: 'cards', filter: 'all' },
    { value: scored.toLocaleString(), label: 'scored', filter: 'scored' },
    { value: avg, label: 'average' },
    { value: unscored.toLocaleString(), label: 'not scored yet', filter: 'unscored', hideIfZero: true },
    { value: errored.toLocaleString(), label: 'failed', filter: 'unscored', tone: 'bad', hideIfZero: true },
    { value: stale.toLocaleString(), label: 'older prompt', filter: 'prompt-stale', tone: 'warn', hideIfZero: true,
      title: 'Scored before you changed the prompt. Filter to these to rescore just them.' },
  ].filter((t) => !(t.hideIfZero && t.value === '0'));

  els.stats.replaceChildren(...tiles.map((t) => {
    const el = document.createElement(t.filter ? 'button' : 'div');
    el.className = `stat ${t.tone ? `tone-${t.tone}` : ''}`;
    if (t.title) el.title = t.title;
    const b = document.createElement('b');
    b.textContent = t.value;
    const span = document.createElement('span');
    span.textContent = t.label;
    el.append(b, span);
    if (t.filter) {
      el.addEventListener('click', () => {
        state.scoreBucket = null;
        state.focusKey = null;
        els.filterBy.value = t.filter;
        renderGrid();
        renderDistribution();
      });
    }
    return el;
  }));
  renderDistribution();
}

/**
 * How the scores are spread: one column per whole-number score (1.0-1.9,
 * 2.0-2.9, … 9.0-10). Answers "how many cards would I lose below 4?" at a
 * glance, and each column is a filter — click 3 to see exactly those cards.
 *
 * One hue throughout (magnitude, not identity). When a column is the active
 * filter it keeps the hue and the rest recede to gray, so the selection reads
 * without a legend. Colours were checked against this dashboard's dark surface
 * (blue clears 3:1; the recessive gray was stepped up until it did too).
 */
function renderDistribution() {
  const counts = new Array(10).fill(0);
  for (const c of state.cards) {
    if (c.overallScore == null) continue;
    counts[Math.min(9, Math.max(0, Math.floor(c.overallScore) - 1))]++;
  }
  const max = Math.max(1, ...counts);
  const active = state.scoreBucket;

  els.dist.classList.toggle('has-active', active != null);
  els.distHint.textContent = active != null
    ? `showing ${counts[active - 1].toLocaleString()} card${counts[active - 1] === 1 ? '' : 's'} scoring ${active}.0–${active === 10 ? '10' : `${active}.9`} · click again to show all`
    : 'click a bar to show just those cards';

  els.dist.replaceChildren(...counts.map((n, i) => {
    const bucket = i + 1;
    const range = bucket === 10 ? '10' : `${bucket}.0–${bucket}.9`;
    const btn = document.createElement('button');
    btn.className = `dist-col${active === bucket ? ' is-active' : ''}`;
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(active === bucket));
    btn.setAttribute('aria-label', `Score ${range}: ${n} card${n === 1 ? '' : 's'}. ${active === bucket ? 'Showing these — press to show all.' : 'Press to show only these.'}`);
    const bar = document.createElement('span');
    bar.className = 'dist-bar';
    // A zero bucket keeps a hairline so the axis reads as continuous.
    bar.style.height = n ? `${Math.max(4, Math.round((n / max) * 100))}%` : '1px';
    const label = document.createElement('span');
    label.className = 'dist-label';
    label.textContent = String(bucket);
    btn.append(bar, label);

    const show = () => {
      // Values lead, labels follow; built with textContent, never innerHTML.
      const strong = document.createElement('b');
      strong.textContent = `${n.toLocaleString()} card${n === 1 ? '' : 's'}`;
      const sub = document.createElement('span');
      sub.textContent = ` scored ${range}`;
      els.distTooltip.replaceChildren(strong, sub);
      els.distTooltip.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      const host = els.dist.closest('.overview').getBoundingClientRect();
      els.distTooltip.style.left = `${Math.round(r.left - host.left + r.width / 2)}px`;
      els.distTooltip.style.top = `${Math.round(r.top - host.top - 8)}px`;
    };
    const hide = () => els.distTooltip.classList.add('hidden');
    btn.addEventListener('pointerenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('pointerleave', hide);
    btn.addEventListener('blur', hide);
    btn.addEventListener('click', () => {
      state.scoreBucket = state.scoreBucket === bucket ? null : bucket;
      state.focusKey = null;
      if (state.scoreBucket != null) els.filterBy.value = 'all';
      renderGrid();
      renderDistribution();
    });
    return btn;
  }));
}

function passesFilter(card) {
  // Focusing one name group overrides the dropdown — you asked to see these
  // specific cards, so show all of them regardless of score/scored state.
  if (state.focusKey) return state.groupOf.get(card.id) === state.focusKey;
  if (state.scoreBucket != null) {
    if (card.overallScore == null) return false;
    // Same bucketing as the chart: 3 means 3.0-3.9, and 10 means exactly 10.
    return Math.min(10, Math.max(1, Math.floor(card.overallScore))) === state.scoreBucket;
  }
  const f = els.filterBy.value;
  if (f === 'prompt-stale') return card.promptStale === true;
  if (f === 'duplicates') return state.dupeIds.has(card.id);
  if (f === 'unscored') return card.overallScore == null || card.error;
  if (f === 'below4') return card.overallScore != null && card.overallScore < 4;
  if (f === 'below6') return card.overallScore != null && card.overallScore < 6;
  if (f === 'scored') return card.overallScore != null;
  if (f === 'fast-scored') return card.brief === true;
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

function renderGrid({ keepWindow = false } = {}) {
  if (!keepWindow) state.renderLimit = PAGE_SIZE;
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

  // Build only as much of the grid as can be on screen, and extend it as you
  // scroll. At 3,765 cards the full grid is ~34,000 DOM nodes and half a second
  // to build — paid again on every keystroke, filter change and selection.
  // Everything else (filtering, "Select all shown", the duplicate groups) still
  // works on the whole list; only the DOM is windowed.
  state.renderLimit = Math.min(cards.length, Math.max(PAGE_SIZE, state.renderLimit || PAGE_SIZE));
  appendTiles(cards.slice(0, state.renderLimit), 0);
}

const PAGE_SIZE = 240;

/** Renders one page of tiles into the grid. `offset` keeps shift-click ranges honest. */
function appendTiles(cards, offset) {
  const frag = document.createDocumentFragment();
  cards.forEach((card, i) => {
    const index = offset + i;
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
    // A card not scored yet only has its filename to go on; drop the extension
    // so the grid reads as names rather than a file listing.
    const shownName = card.name.replace(/\.(png|json)$/i, '');
    name.title = shownName;
    name.textContent = shownName;
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = card.tokenEstimate != null ? `~${card.tokenEstimate} tok` : '';

    // An improved card is only interesting next to what it came from, so the
    // tile carries the uplift rather than making you open it to find out.
    if (card.previousScore != null) {
      const chip = document.createElement('span');
      if (card.overallScore != null) {
        const diff = Math.round((card.overallScore - card.previousScore) * 10) / 10;
        chip.className = `dupe-tag ${diff > 0 ? 'uplift-up' : diff < 0 ? 'uplift-down' : ''}`;
        chip.textContent = `${card.previousScore} → ${card.overallScore}`;
        chip.title = `Edited card: was ${card.previousScore}/10, now ${card.overallScore}/10`;
      } else {
        chip.className = 'dupe-tag';
        chip.textContent = 'EDITED · UNSCORED';
        chip.title = `Edited since it was scored (${card.previousScore}/10 before). Score it to see the new number.`;
      }
      meta.appendChild(document.createElement('br'));
      meta.appendChild(chip);
    }

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
        renderGrid({ keepWindow: true });
        return;
      }
      openCard(card.id);
    });
    frag.appendChild(tile);
  });
  els.grid.appendChild(frag);
  updateMoreRow();
}

/**
 * Shows how much of the list is on screen and extends it — on scroll, or by
 * pressing the row. Without this, "3,765 cards shown" but only 240 tiles built
 * would be a lie.
 */
function updateMoreRow() {
  let row = document.getElementById('gridMore');
  const total = state.shown.length;
  const drawn = els.grid.querySelectorAll('.card-tile').length;
  if (drawn >= total) {
    row?.remove();
    return;
  }
  if (!row) {
    row = document.createElement('button');
    row.id = 'gridMore';
    row.className = 'grid-more secondary';
    row.addEventListener('click', showMore);
    els.grid.after(row);
  }
  row.textContent = `Showing ${drawn} of ${total} — show more`;
}

function showMore() {
  const drawn = els.grid.querySelectorAll('.card-tile').length;
  if (drawn >= state.shown.length) return;
  state.renderLimit = Math.min(state.shown.length, drawn + PAGE_SIZE);
  appendTiles(state.shown.slice(drawn, state.renderLimit), drawn);
}

// Extend the grid before the bottom is reached, so scrolling feels continuous.
window.addEventListener('scroll', () => {
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) showMore();
}, { passive: true });

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
  for (const btn of [els.scoreSelectedBtn, els.critiqueSelectedBtn, els.copySelectedBtn, els.deleteSelectedBtn, els.clearSelectionBtn]) {
    btn.classList.toggle('hidden', n === 0);
  }
  els.deleteSelectedBtn.textContent = n ? `Delete selected (${n})` : 'Delete selected';
  els.copySelectedBtn.textContent = n ? `Copy selected (${n}) to…` : 'Copy selected to…';
  els.scoreSelectedBtn.textContent = n ? `Fast score (${n})` : 'Fast score';
  els.critiqueSelectedBtn.textContent = n ? `Full critique (${n})` : 'Full critique';
}

async function openCard(id) {
  const data = await api(`/api/cards/${encodeURIComponent(id)}`);
  const entry = data.entry;
  const result = entry?.result;

  let html = `<h2>${escapeHtml(data.name)}</h2>`;
  const briefOnly = Boolean(result?.brief);
  html += `<div class="modal-actions">
    <button data-action="score">${briefOnly ? 'Rescore with full critique' : result ? 'Rescore' : 'Score this card'}</button>
    <button data-action="improve" title="${result && !result.partial && !briefOnly
      ? 'Ideas aimed at this card\'s critique, then precise edits for the ones you tick — each shown in place, side by side, before anything is saved.'
      : 'Writes the full critique first, then ideas aimed at it, then precise edits for the ones you tick — each shown in place, side by side, before anything is saved.'}">Improve with AI</button>
    <button data-action="edit" class="secondary">Edit text</button>
    <button data-action="delete" class="danger">Delete</button>
  </div>`;

  if (entry?.error) {
    html += `<p style="color:var(--red)">Last attempt failed: ${escapeHtml(entry.error)}</p>`;
  }

  if (entry?.previousScore != null && result?.overall_score != null) {
    const diff = Math.round((result.overall_score - entry.previousScore) * 10) / 10;
    html += `<div class="uplift ${diff > 0 ? 'is-good' : diff < 0 ? 'is-bad' : ''}">
      ${entry.improvedFrom ? `Improved from <b>${escapeHtml(entry.improvedFrom)}</b>: ` : 'After editing: '}
      ${entry.previousScore} → ${result.overall_score} / 10 ${diff > 0 ? `(+${diff})` : diff < 0 ? `(${diff})` : '(no change)'}
    </div>`;
  } else if (entry?.previousScore != null && !result) {
    html += `<div class="uplift">Edited — previously scored ${entry.previousScore}/10. Score it again to see whether it improved.</div>`;
  }

  if (result) {
    html += `<div class="overall-block">
      <div class="overall-score">${result.overall_score} / 10</div>
      ${result.partial
        ? '<div class="partial-note">Score only. This score was recovered from a previous session, so the written critique is not available — click <b>Rescore</b> above to generate it. The card\'s own text is shown below so you can still judge it yourself.</div>'
        : result.brief
          ? '<div class="partial-note">Scored in <b>fast mode</b>: every field got a score, but no written critique was generated — that is what makes a fast pass several times quicker. Click <b>Rescore with full critique</b> above for the strengths, weaknesses and suggestions.</div>'
          : `<div>${escapeHtml(result.summary || '')}</div>`}
      ${result.top_priority_improvements?.length ? `<ol class="priority-list">${result.top_priority_improvements.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>` : ''}
    </div>`;

    for (const [field, f] of Object.entries(result.fields)) {
      const hasCritique = f.strengths || f.weaknesses || f.suggestions;
      html += `<div class="field-block">
        <div class="field-title"><span>${escapeHtml(fieldLabel(field))}</span><span class="field-score">${f.score ?? '–'}/10</span></div>
        ${hasCritique ? `<div class="field-sub"><b>Strengths:</b> ${escapeHtml(f.strengths || '—')}</div>
        <div class="field-sub"><b>Weaknesses:</b> ${escapeHtml(f.weaknesses || '—')}</div>
        <div class="field-sub"><b>Suggestions:</b> ${escapeHtml(f.suggestions || '—')}</div>` : ''}
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
          <div class="field-title"><span>${escapeHtml(fieldLabel(name))}</span></div>
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
      await api(`/api/cards/${encodeURIComponent(id)}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Opening a single card is the moment you want the written feedback,
        // so this always asks for it even when scans are set to fast mode.
        body: JSON.stringify({ detail: 'full' }),
      });
      await loadCards();
      await openCard(id);
    } catch (err) {
      alert(`Scoring failed: ${err.message}`);
      e.target.disabled = false;
    }
  });

  els.modalBody.querySelector('[data-action="improve"]').addEventListener('click', () => startImprove(id, data.name));
  els.modalBody.querySelector('[data-action="edit"]').addEventListener('click', () => startManualEdit(id, data.name, data.fields || {}));

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

/**
 * The scan's own account of anything unusual: paused on a fatal error, waiting
 * out an outage, slowed down by the provider, or on its automatic retry pass.
 * Each says what happened and what (if anything) you need to do.
 */
function renderScanBanner(job) {
  let html = '';
  let tone = 'info';
  let showResume = false;
  let showSettings = false;

  if (job.status === 'running' && job.state === 'paused') {
    tone = 'bad';
    showResume = true;
    showSettings = job.pauseKind === 'auth' || job.pauseKind === 'model';
    const title = { auth: 'Paused — API key rejected', credits: 'Paused — out of credits', model: 'Paused — model not found' }[job.pauseKind] || 'Paused';
    html = `<b>${escapeHtml(title)}.</b> ${escapeHtml(job.pauseReason || '')}`;
  } else if (job.status === 'running' && job.state === 'waiting') {
    tone = 'warn';
    const nextIn = job.nextProbeInMs != null ? ` Checking again in ${Math.ceil(job.nextProbeInMs / 1000)}s.` : '';
    html = `<b>Can't reach the provider</b> (for ${fmtDuration(job.waitingForMs)}). The scan is waiting instead of failing cards, and will carry on by itself as soon as the connection is back.${nextIn} Nothing is lost.`;
  } else if (job.status === 'running' && job.phase === 'retrying') {
    html = `<b>Retry pass:</b> trying the ${job.retryTotal} card${job.retryTotal === 1 ? '' : 's'} that failed for temporary reasons (slow answer, cut-off reply, provider hiccup) once more${job.recovered ? ` — ${job.recovered} recovered so far` : ''}.`;
  } else if (job.status === 'running' && job.pacing?.slowedDown) {
    tone = 'warn';
    html = `<b>Slowed down:</b> the provider answered "too many requests", so the scan is pacing itself at ${job.pacing.currentRpm}/min instead of ${job.pacing.ceilingRpm}/min. It speeds back up on its own once things are quiet.`;
  } else if (job.status !== 'running' && job.recovered) {
    html = `The automatic retry pass recovered <b>${job.recovered}</b> card${job.recovered === 1 ? '' : 's'} that failed the first time.`;
  }

  els.scanBanner.classList.toggle('hidden', !html);
  els.scanBanner.className = `scan-banner tone-${tone}${html ? '' : ' hidden'}`;
  els.scanBannerText.innerHTML = html;
  els.resumeScanBtn.classList.toggle('hidden', !showResume);
  els.bannerSettingsBtn.classList.toggle('hidden', !showSettings);
}

function renderScanPanel(job) {
  renderScanBanner(job);
  const finished = job.done + job.errors;
  const pct = job.total ? Math.round((finished / job.total) * 100) : 100;
  els.progressFill.style.width = `${pct}%`;
  els.progressLabel.textContent =
    `${finished} / ${job.total} processed (${pct}%)` +
    (job.stopping ? ' — stopping, letting in-flight cards finish…' : job.status === 'stopped' ? ` — stopped, ${job.skipped} not started` : '');

  // Scored and failed are shown as separate figures on purpose: a run that is
  // failing every card still advances the bar, which previously made a broken
  // run look like a slow one.
  const stats = [
    { label: 'Scored', value: job.done, cls: 'is-ok' },
    { label: 'Failed', value: job.errors, cls: job.errors ? 'is-error' : '' },
    { label: 'In flight', value: `${job.inFlight}/${job.concurrency}` },
    { label: 'Rate', value: job.perHour != null ? `${Math.round(job.perHour)}/hr` : '…' },
    { label: 'Median', value: fmtDuration(job.medianLatencyMs) },
    { label: 'ETA', value: job.stopping ? 'stopping' : job.state === 'paused' ? 'paused' : job.state === 'waiting' ? 'waiting' : job.status === 'running' ? fmtDuration(job.etaMs) : job.status === 'stopped' ? 'stopped' : 'done' },
    ...(job.pacing?.enabled ? [{ label: 'Pace', value: `${job.pacing.currentRpm}/min`, cls: job.pacing.slowedDown ? 'is-error' : '' }] : []),
    { label: 'Elapsed', value: fmtDuration(job.elapsedMs) },
    { label: 'Mode', value: job.detail === 'fast' ? 'fast' : 'full' },
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

let currentJobId = null;

async function pollJob(jobId) {
  currentJobId = jobId;
  els.scanPanel.classList.remove('hidden');
  els.hideScanPanelBtn.classList.add('hidden'); // only offered once the run ends
  els.stopScanBtn.classList.remove('hidden');
  els.stopScanBtn.disabled = false;
  els.stopScanBtn.textContent = 'Stop scan';
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

  currentJobId = null;
  await loadCards();
  renderScanPanel(job);
  // Leave the finished summary up so the run's outcome is reviewable, but let
  // it be dismissed now that nothing is streaming into it.
  els.hideScanPanelBtn.classList.remove('hidden');
  els.stopScanBtn.classList.add('hidden');

  if (job.status === 'stopped') {
    alert(
      `Scan stopped. ${job.done} card${job.done === 1 ? '' : 's'} scored${job.errors ? `, ${job.errors} failed` : ''}` +
      `${job.skipped ? `, ${job.skipped} not started` : ''}.\n\n` +
      `Every score that finished is saved. "${job.detail === 'fast' ? 'Fast score' : 'Full critique'}" picks up exactly where this left off.`,
    );
    return;
  }

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
      `Failed cards are not lost — "${job.detail === 'fast' ? 'Fast score' : 'Full critique'}" retries them.\n\n` +
      `For a live check against your API, run:  node src/cli.js doctor`,
    );
  }
}

async function startBatch(body) {
  let jobId;
  try {
    ({ jobId } = await api('/api/score/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  } catch (err) {
    // Only one scan runs at a time (two would together exceed the provider's
    // rate limit). If one is already going — from this tab before a reload, or
    // from your phone — show that one.
    if (err.status === 409 && err.body?.jobId) {
      if (currentJobId === err.body.jobId) return;
      alert('A scan is already running (perhaps started from another device). Showing it here.');
      await pollJob(err.body.jobId);
      return;
    }
    throw err;
  }
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

let searchTimer = null;
els.search.addEventListener('input', () => {
  // Re-rendering on every keystroke made typing in a 3,000-card collection lag
  // by about a second per character. One render after you stop is enough.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderGrid(), 120);
});
els.sortBy.addEventListener('change', renderGrid);
els.filterBy.addEventListener('change', () => {
  state.focusKey = null;
  state.scoreBucket = null; // one filter at a time, so nothing is hidden by a filter you can't see
  renderGrid();
  renderDistribution();
});
els.clearFocusBtn.addEventListener('click', clearFocus);
els.selectFocusLosersBtn.addEventListener('click', () => {
  for (const card of state.shown) {
    if (!state.bestIds.has(card.id)) state.selected.add(card.id);
  }
  renderGrid();
});

// ---- "More" menu: the less frequent actions, out of the way of the main one ----
function setMenu(open) {
  els.moreMenu.classList.toggle('hidden', !open);
  els.moreBtn.setAttribute('aria-expanded', String(open));
  if (open) els.moreMenu.querySelector('button')?.focus();
}
els.moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(els.moreMenu.classList.contains('hidden'));
});
els.moreMenu.addEventListener('click', () => setMenu(false)); // picking an item closes it
document.addEventListener('click', (e) => {
  if (!els.moreMenu.classList.contains('hidden') && !e.target.closest('.menu')) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.moreMenu.classList.contains('hidden')) {
    setMenu(false);
    els.moreBtn.focus();
  }
});

// ---- card size: large art, or compact to see more of a big library at once ----
function setDensity(mode, persist = true) {
  document.body.classList.toggle('density-compact', mode === 'compact');
  els.densityComfy.setAttribute('aria-pressed', String(mode !== 'compact'));
  els.densityCompact.setAttribute('aria-pressed', String(mode === 'compact'));
  if (persist) {
    try { localStorage.setItem('ssr_density', mode); } catch { /* not persisted — fine */ }
  }
}
els.densityComfy.addEventListener('click', () => setDensity('comfy'));
els.densityCompact.addEventListener('click', () => setDensity('compact'));
try {
  setDensity(localStorage.getItem('ssr_density') || 'comfy', false);
} catch {
  setDensity('comfy', false);
}

// The two ways to scan, side by side. The usual order for a big library is
// Fast score → delete what you don't want → Full critique on what's left; the
// second only ever spends requests on cards that don't have a critique yet.
els.fastScanBtn.addEventListener('click', () => {
  const n = state.cards.filter((c) => c.overallScore == null).length;
  if (!n) {
    alert('Every card already has a score.\n\nTo rescore some, select them and press "Fast score" in the selection bar.');
    return;
  }
  startBatch({ scope: 'unscored', detail: 'fast' });
});
els.critiqueScanBtn.addEventListener('click', () => {
  const unscored = state.cards.filter((c) => c.overallScore == null).length;
  const fast = state.cards.filter((c) => c.overallScore != null && c.brief).length;
  const n = unscored + fast;
  if (!n) {
    alert('Every card already has a full critique.\n\nTo redo some, select them and press "Full critique" in the selection bar.');
    return;
  }
  if (n > 50) {
    const parts = [fast && `${fast.toLocaleString()} fast-scored`, unscored && `${unscored.toLocaleString()} not scored yet`].filter(Boolean);
    const tip = unscored > 200
      ? '\n\nTip: for a big library, "Fast score" first and delete what you don\'t want — then this only critiques the keepers.'
      : '';
    if (!confirm(`Write a full critique for ${n.toLocaleString()} cards (${parts.join(', ')})?${tip}`)) return;
  }
  startBatch({ scope: 'uncritiqued', rescore: true, detail: 'full' });
});
els.rescanAllBtn.addEventListener('click', () => {
  if (confirm('Rescore ALL cards? This re-runs every card through the model, which costs time/money on a paid API.')) {
    startBatch({ scope: 'all', rescore: true });
  }
});

// The mode is in the button, not in Settings: switching Settings back and forth
// to critique your keepers was a trap (forget, and you re-ran fast scoring on them).
els.scoreSelectedBtn.addEventListener('click', () =>
  startBatch({ scope: 'selected', ids: [...state.selected], rescore: true, detail: 'fast' }));
els.critiqueSelectedBtn.addEventListener('click', () => {
  const n = state.selected.size;
  if (n > 50 && !confirm(`Write a full critique for ${n} cards? Full critiques are much slower than fast scores — this is the deep pass, meant for the cards you're keeping.`)) return;
  startBatch({ scope: 'selected', ids: [...state.selected], rescore: true, detail: 'full' });
});
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
els.resumeScanBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  els.resumeScanBtn.disabled = true;
  try {
    await api(`/api/score/batch/${currentJobId}/resume`, { method: 'POST' });
  } catch (err) {
    alert(`Could not resume: ${err.message}`);
  } finally {
    els.resumeScanBtn.disabled = false;
  }
});
els.bannerSettingsBtn.addEventListener('click', () => openSettings());

els.stopScanBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  els.stopScanBtn.disabled = true;
  els.stopScanBtn.textContent = 'Stopping…';
  try {
    await api(`/api/score/batch/${currentJobId}/stop`, { method: 'POST' });
  } catch (err) {
    els.stopScanBtn.disabled = false;
    els.stopScanBtn.textContent = 'Stop scan';
    alert(`Could not stop the scan: ${err.message}`);
  }
});

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
  const payload = { exportedAt: new Date().toISOString(), charactersDir: state.charactersDir, scores };
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
  await openFolderPanel('switch', state.charactersDir || undefined);
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
  const start = currentBrowse?.path || state.charactersDir || undefined;
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

async function loadBackups() {
  try {
    const data = await api('/api/backups');
    if (!data.backups.length) {
      els.backupList.innerHTML = '<li class="dim">No backups yet — one is taken the first time the dashboard opens this folder.</li>';
      return;
    }
    els.backupList.innerHTML = data.backups
      .map((b) => `<li>
        <span>${escapeHtml(b.name.split('--').slice(1).join(' · '))}</span>
        <span class="dim">${b.scoredCount} scored / ${b.cardCount} cards</span>
      </li>`)
      .join('');
  } catch (err) {
    els.backupList.innerHTML = `<li class="dim">Could not read backups: ${escapeHtml(err.message)}</li>`;
  }
}

async function openSettings() {
  els.settingsPanel.classList.remove('hidden');
  loadBackups();
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
    els.settingsDetail.value = data.scoreDetail || 'full';
    els.settingsMaxTokens.value = data.maxTokens ?? 0;
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
  const fast = els.settingsDetail.value === 'fast';
  if (!rpm) {
    els.throughputHint.textContent = 'No pacing: requests go as fast as concurrency allows. Only safe for a local model on your own hardware.';
    return;
  }
  const perHour = rpm * 60;
  const hours = total ? total / perHour : null;
  const eta = hours == null ? '' : hours < 1 ? ` — about ${Math.round(hours * 60)} min for all ${total} cards` : ` — about ${hours.toFixed(1)} h for all ${total} cards`;
  els.throughputHint.textContent =
    `${rpm}/min = up to ${perHour} cards/hour${eta}. ` +
    `Reaching that also needs the model to answer in under ~${(conc / rpm * 60).toFixed(0)}s; slower than that and concurrency (${conc}) becomes the limit instead.` +
    (fast
      ? ' Fast mode makes each answer short, which is what gets you near that ceiling.'
      : ' Full critique means a long answer per card — switch Scoring detail to Fast for a first pass.');
}

els.settingsRpm.addEventListener('input', updateThroughputHint);
els.settingsConcurrency.addEventListener('input', updateThroughputHint);
els.settingsDetail.addEventListener('change', updateThroughputHint);

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
    scoreDetail: els.settingsDetail.value,
    maxTokens: els.settingsMaxTokens.value === '' ? undefined : Math.max(0, Number(els.settingsMaxTokens.value) || 0),
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

// ---------------------------------------------------------------------------
// Card editor / AI improvement
//
// Improve with AI is three steps, each feeding the next:
//   1. Rating — the full critique (written first if the card only has a fast
//      score).
//   2. Choose ideas — the model records the card's canon (what makes it
//      itself, each fact quoted from the card) and proposes changes of a stated
//      kind: fix, combine, extend, trim — what would take it to a 10/10. You
//      tick what you want. Card only: the lorebook isn't part of this.
//   3. Review changes — the ideas come back as precise edits to the card's own
//      text, never a rewrite of whole fields. Each is shown in place, card now
//      beside card after, with a live check for any detail it would remove.
//      You allow, adjust or refuse each one. Only then does anything touch a
//      file, and saving defaults to a NEW card.
//
// "Edit text" is the same save path without the model: every field in a
// textarea.
// ---------------------------------------------------------------------------

let editor = null;

function fieldLabel(field) {
  if (field === 'character_note') return 'character\'s note';
  return String(field).replace(/_/g, ' ');
}

function highlightWords(tokens, cls) {
  return tokens.map((t) => (t.changed ? `<mark class="${cls}">${escapeHtml(t.text)}</mark>` : escapeHtml(t.text))).join('');
}

const KIND_INFO = {
  fix: { label: 'Fix', hint: 'Corrects a contradiction or error so it matches the canon' },
  combine: { label: 'Combine', hint: 'Merges scattered or repeated details into one passage that keeps all of them' },
  extend: { label: 'Extend', hint: 'Adds something concrete for the model to play, built on what the card already says' },
  trim: { label: 'Trim', hint: 'Removes repetition or reader-facing text — check nothing distinctive goes with it' },
};

function kindPill(kind) {
  const k = KIND_INFO[kind];
  return k ? `<span class="pill kind-pill kind-${kind}" title="${escapeHtml(k.hint)}">${k.label}</span>` : '';
}

const ASPECT_LABEL = {
  look: 'Look', personality: 'Personality', voice: 'Voice', goals: 'Goals', relationships: 'Relationships',
  powers: 'Powers', setting: 'Setting', format: 'Format', other: 'Also keep',
};

function stepper(active) {
  const steps = ['Rating', 'Choose ideas', 'Review changes'];
  return `<ol class="stepper">${steps.map((s, i) =>
    `<li class="${i + 1 === active ? 'is-active' : i + 1 < active ? 'is-done' : ''}">${i + 1}. ${s}</li>`).join('')}</ol>`;
}

// ---- step 1 → 2: critique (if needed), then ideas ----

let ideasState = null;

async function startImprove(id, name) {
  // The chain is critique → ideas → edits, each feeding the next: the ideas
  // aim at what the critique found, and the edits carry out the ideas you
  // ticked. A card with only a fast score (or none) gets its critique written
  // first — it's saved to the card, so it isn't spent twice.
  const known = state.cards.find((c) => c.id === id);
  let critiqueFailed = null;
  let critiqued = false;
  if (!known || known.overallScore == null || known.brief) {
    els.modalBody.innerHTML = `<h2>Improve: ${escapeHtml(name)}</h2>${stepper(1)}
      <p class="editor-working">Writing the full critique first, so the ideas can aim at what it finds…</p>
      <p class="folder-hint">Request 1 of 2. The critique is saved to the card.</p>`;
    try {
      await api(`/api/cards/${encodeURIComponent(id)}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ detail: 'full' }),
      });
      critiqued = true;
      loadCards().catch(() => {}); // refresh the grid behind the modal
    } catch (err) {
      critiqueFailed = err.message; // ideas from the text alone still beat nothing
    }
  }
  els.modalBody.innerHTML = `<h2>Improve: ${escapeHtml(name)}</h2>${stepper(2)}
    <p class="editor-working">Reading the card and its critique, and drafting ideas…</p>
    <p class="folder-hint">${critiqued || critiqueFailed ? 'Request 2 of 2' : 'One request'}. Nothing is changed in this step.</p>`;
  try {
    const data = await api(`/api/cards/${encodeURIComponent(id)}/ideas`, { method: 'POST' });
    const preTick = (i) => !i.risk && ['fix', 'combine', 'extend'].includes(i.kind) && i.impact !== 'low';
    ideasState = {
      id,
      name: data.name,
      previousScore: data.previousScore,
      hadCritique: data.hadCritique,
      critiqueFailed,
      canon: (data.canon || []).map((c) => ({ ...c, keep: true })),
      extraKeep: '',
      ideas: data.ideas,
      // Pre-tick what is clearly worth it and doesn't risk the card's feel.
      // A trim is never pre-ticked: removing things is always your call.
      chosen: new Set(data.ideas.filter(preTick).map((i) => i.id)),
    };
    renderIdeas();
  } catch (err) {
    showImproveError(id, name, err);
  }
}

function showImproveError(id, name, err) {
  els.modalBody.innerHTML = `<h2>${escapeHtml(name)}</h2>
    <p style="color:var(--red)">Could not improve this card: ${escapeHtml(err.message)}</p>`;
  const back = document.createElement('button');
  back.textContent = 'Back to the card';
  back.addEventListener('click', () => openCard(id));
  els.modalBody.appendChild(back);
}

function renderIdeas() {
  const st = ideasState;
  const impactLabel = { high: 'High impact', medium: 'Medium', low: 'Low' };

  let html = `<h2>Improve: ${escapeHtml(st.name)}</h2>${stepper(2)}`;
  if (!st.hadCritique) {
    html += `<div class="partial-note">${st.critiqueFailed
      ? `The full critique couldn't be written (${escapeHtml(st.critiqueFailed)}), so these ideas are based on the text alone.
        Close this and press <b>Improve with AI</b> again to retry the critique.`
      : `This card has no complete critique, so these ideas are based on the text alone.
        For ideas aimed at what a critique finds, close this and press <b>Rescore with full critique</b> first.`}</div>`;
  }
  html += `<p class="folder-hint">Tick the changes you want. They come back as <b>precise edits to the card's own
    text</b> — never a rewrite of whole fields — and you see each one in place, beside the original, before anything
    is saved.</p>`;

  // The canon, grouped by aspect: what every change must leave intact.
  const groups = {};
  st.canon.forEach((c, i) => { (groups[c.aspect] ||= []).push({ ...c, i }); });
  html += `<section class="keep-box canon-box">
    <h3>The canon — what makes this card itself</h3>
    <p class="folder-hint">Sent with every change as a hard rule. Quoted lines are also checked word for word in the
      review. Untick anything you're happy to see changed.</p>
    ${Object.keys(ASPECT_LABEL).filter((a) => groups[a]).map((a) => `<div class="canon-group">
      <h4>${ASPECT_LABEL[a]}</h4>
      ${groups[a].map((c) => `<label class="canon-item ${c.keep ? '' : 'is-off'}">
        <input type="checkbox" data-canon="${c.i}" ${c.keep ? 'checked' : ''} />
        <span><span class="canon-fact">${escapeHtml(c.fact)}</span>${c.quote ? ` <q class="canon-quote">${escapeHtml(c.quote)}</q>` : ''}</span>
      </label>`).join('')}
    </div>`).join('')}
    <label class="field-label" for="keepText">Anything else to keep — one per line</label>
    <textarea id="keepText" rows="2" spellcheck="true" placeholder="e.g. Her outfit stays exactly as described">${escapeHtml(st.extraKeep)}</textarea>
  </section>`;

  html += `<section class="ideas-list"><h3>Ideas <span class="folder-hint" id="ideasCount"></span></h3>`;
  html += st.ideas.map((idea) => `
    <label class="idea ${st.chosen.has(idea.id) ? 'is-chosen' : ''}" data-idea="${escapeHtml(idea.id)}">
      <input type="checkbox" ${st.chosen.has(idea.id) ? 'checked' : ''} />
      <div class="idea-body">
        <div class="idea-head">
          ${kindPill(idea.kind)}
          <b>${escapeHtml(idea.title)}</b>
          <span class="pill">${escapeHtml(idea.fieldLabel || fieldLabel(idea.field))}</span>
          <span class="pill impact-${escapeHtml(idea.impact)}">${escapeHtml(impactLabel[idea.impact] || idea.impact)}</span>
        </div>
        <div class="idea-change">${escapeHtml(idea.change)}</div>
        ${idea.why ? `<div class="field-sub"><b>Why:</b> ${escapeHtml(idea.why)}</div>` : ''}
        ${idea.quotes?.length ? `<ul class="idea-quotes">${idea.quotes.map((q) => `<li>“${escapeHtml(q.length > 220 ? `${q.slice(0, 220)}…` : q)}”</li>`).join('')}</ul>` : ''}
        ${idea.risk ? `<div class="idea-risk">⚠ Could change the feel: ${escapeHtml(idea.risk)}</div>` : ''}
      </div>
    </label>`).join('');
  html += `</section>`;

  html += `<div class="editor-footer">
    <div class="editor-buttons">
      <button id="rewriteBtn" class="primary">Make the changes</button>
      <button class="secondary" id="ideasAllBtn">Tick all</button>
      <button class="secondary" id="ideasBackBtn">Back to the card</button>
    </div>
    <p id="ideasMsg" class="folder-hint"></p>
  </div>`;
  els.modalBody.innerHTML = html;

  const refresh = () => {
    const n = st.chosen.size;
    els.modalBody.querySelector('#ideasCount').textContent = `${n} of ${st.ideas.length} ticked`;
    const btn = els.modalBody.querySelector('#rewriteBtn');
    btn.disabled = n === 0;
    btn.textContent = n ? `Make ${n} change${n === 1 ? '' : 's'}` : 'Tick at least one idea';
    const parts = new Set(st.ideas.filter((i) => st.chosen.has(i.id)).map((i) => i.fieldLabel || fieldLabel(i.field)));
    els.modalBody.querySelector('#ideasMsg').textContent = n
      ? `Will edit: ${[...parts].join(', ')}. Everything outside the edited passages stays word for word.`
      : '';
  };

  for (const label of els.modalBody.querySelectorAll('.idea')) {
    const box = label.querySelector('input');
    box.addEventListener('change', () => {
      const idv = label.dataset.idea;
      if (box.checked) st.chosen.add(idv); else st.chosen.delete(idv);
      label.classList.toggle('is-chosen', box.checked);
      refresh();
    });
  }
  for (const box of els.modalBody.querySelectorAll('[data-canon]')) {
    box.addEventListener('change', () => {
      st.canon[Number(box.dataset.canon)].keep = box.checked;
      box.closest('.canon-item').classList.toggle('is-off', !box.checked);
    });
  }
  els.modalBody.querySelector('#keepText').addEventListener('input', (e) => { st.extraKeep = e.target.value; });
  els.modalBody.querySelector('#ideasAllBtn').addEventListener('click', () => {
    st.ideas.forEach((i) => st.chosen.add(i.id));
    renderIdeas();
  });
  els.modalBody.querySelector('#ideasBackBtn').addEventListener('click', () => openCard(st.id));
  els.modalBody.querySelector('#rewriteBtn').addEventListener('click', runRewrite);
  refresh();
}

async function runRewrite() {
  const st = ideasState;
  const chosen = st.ideas.filter((i) => st.chosen.has(i.id));
  const canon = st.canon.filter((c) => c.keep).map(({ aspect, fact, quote }) => ({ aspect, fact, quote }))
    .concat(st.extraKeep.split('\n').map((l) => l.trim()).filter(Boolean).map((fact) => ({ aspect: 'other', fact, quote: '' })));
  const keepQuotes = [...new Set(canon.map((c) => c.quote).filter(Boolean))];
  els.modalBody.innerHTML = `<h2>Improve: ${escapeHtml(st.name)}</h2>${stepper(3)}
    <p class="editor-working">Making ${chosen.length} change${chosen.length === 1 ? '' : 's'} as edits to the card's own text…</p>
    <p class="folder-hint">Nothing is saved until you've looked at each one.</p>`;
  try {
    const data = await api(`/api/cards/${encodeURIComponent(st.id)}/improve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ideas: chosen, canon, keep: canon.map((c) => c.fact), keepQuotes }),
    });
    startReview(data, { keepQuotes });
  } catch (err) {
    showImproveError(st.id, st.name, err);
  }
}

// ---- step 3: review the edits ----

function startReview(data, { keepQuotes = [] } = {}) {
  const parts = Object.keys(data.before).map((target) => ({
    target,
    label: data.labels?.[target] || fieldLabel(target),
    before: data.before[target],
    edits: data.edits
      .filter((e) => e.target === target)
      .map((e, order) => ({ ...e, order, origNew: e.new, use: true })),
    handEdited: false,
    after: '',
  }));
  editor = {
    id: data.id,
    name: data.name,
    source: 'improve',
    headline: data.headline,
    previousScore: data.previousScore,
    parts,
    unplaced: data.unplaced || [],
    rest: data.rest || '',
    keepQuotes,
  };
  CardEdits.defaultUses(parts, reviewExtraText());
  renderReview();
}

/** The rest of the card — for "is this detail still anywhere?". */
function reviewExtraText() {
  return editor.rest;
}

function partFinal(p) {
  return p.handEdited ? p.after : CardEdits.compose(p.before, p.edits);
}

/** A little of the surrounding text, cut at word boundaries, so a change can be read in place. */
function contextOf(text, start, end, n = 150) {
  let a = Math.max(0, start - n);
  let b = Math.min(text.length, end + n);
  if (a > 0) { const sp = text.indexOf(' ', a); if (sp !== -1 && sp < start) a = sp + 1; }
  if (b < text.length) { const sp = text.lastIndexOf(' ', b); if (sp > end) b = sp; }
  return { pre: (a > 0 ? '…' : '') + text.slice(a, start), post: text.slice(end, b) + (b < text.length ? '…' : '') };
}

function editSidesHtml(p, e) {
  const { pre, post } = contextOf(p.before, e.start, e.end);
  const w = TextDiff.wordDiff(e.old, e.new);
  const caret = (title) => `<span class="edit-caret" title="${title}">⁁</span>`;
  const oldMid = e.old ? `<span class="edit-old">${highlightWords(w.old, 'w-del')}</span>` : caret('The new text goes here');
  const newMid = e.new ? `<span class="edit-new">${highlightWords(w.new, 'w-add')}</span>` : caret('Removed from here');
  return `<div class="edit-side side-old"><span class="hunk-label">Card now</span>${escapeHtml(pre)}${oldMid}${escapeHtml(post)}</div>
    <div class="edit-side side-new"><span class="hunk-label">With this change</span>${escapeHtml(pre)}${newMid}${escapeHtml(post)}</div>`;
}

function actionLabel(e) {
  return { replace: e.new ? 'Reworded' : 'Removed', insert_after: 'Added', insert_before: 'Added' }[e.action] || 'Change';
}

function editCardHtml(p, pi, e, ei) {
  const key = `${pi}-${ei}`;
  const shape = e.old ? (e.new ? 'replace' : 'remove') : 'insert';
  return `<div class="edit-card ${e.use ? 'is-on' : 'is-off'} is-${shape}" data-edit="${key}">
    <div class="edit-head">
      <label class="edit-use"><input type="checkbox" data-use="${key}" ${e.use ? 'checked' : ''} ${p.handEdited ? 'disabled' : ''} />
        <span>Use this change</span></label>
      ${kindPill(e.kind)}
      <b class="edit-title">${escapeHtml(e.ideaTitle || actionLabel(e))}</b>
      <span class="edit-shape">${actionLabel(e)}</span>
    </div>
    ${e.why ? `<div class="field-sub">${escapeHtml(e.why)}</div>` : ''}
    <div class="edit-sides" data-sides="${key}">${editSidesHtml(p, e)}</div>
    <div class="edit-check" data-check="${key}"></div>
    <details class="edit-tweak">
      <summary>Adjust this change</summary>
      <textarea class="editor-text" data-tweak="${key}" rows="${Math.min(10, Math.max(3, Math.ceil(e.new.length / 70) + 1))}" spellcheck="true">${escapeHtml(e.new)}</textarea>
      <button class="secondary small" data-untweak="${key}" ${e.new === e.origNew ? 'disabled' : ''}>Back to the suggestion</button>
    </details>
  </div>`;
}

function renderReview() {
  const { name, headline, previousScore, parts } = editor;
  let html = `<h2>Review changes: ${escapeHtml(name)}</h2>${stepper(3)}`;
  html += `<div id="lostQuotes"></div>`;
  html += `<div class="editor-intro">
    <p>${escapeHtml(headline || 'The model suggested the changes below.')}</p>
    <p class="folder-hint">Each change edits one exact passage — everything else stays word for word. A change that would
      remove a detail found nowhere else in the card starts <b>off</b>; the rest start on. Nothing is saved until you
      press Save, and saving makes a <b>new card file</b> by default.${previousScore != null ? ` The original scores <b>${previousScore}/10</b>.` : ''}</p>
  </div>
  <div class="review-bar">
    <span id="reviewSummary"></span>
    <span class="review-bar-buttons">
      <button class="secondary small" id="useSafeBtn">Use all safe changes</button>
      <button class="secondary small" id="useNoneBtn">Use none</button>
    </span>
  </div>`;

  parts.forEach((p, pi) => {
    html += `<section class="edit-target" data-part="${pi}">
      <div class="field-title"><span>${escapeHtml(p.label)}</span></div>
      <div class="editor-warnings" data-warn="${pi}"></div>
      <div class="edit-list">${p.edits.map((e, ei) => editCardHtml(p, pi, e, ei)).join('')}</div>
      <details class="whole-compare" data-compare="${pi}">
        <summary>Compare the whole field side by side</summary>
        <div class="compare-cols" data-cols="${pi}"></div>
      </details>
      <details class="hand-edit" ${p.handEdited ? 'open' : ''}>
        <summary>Edit the final text by hand</summary>
        <textarea class="editor-text" data-final="${pi}" rows="8" spellcheck="false"></textarea>
        <div class="hand-note ${p.handEdited ? '' : 'hidden'}" data-hand="${pi}">
          You've edited this by hand, so the change switches above are paused (they'd overwrite your edit).
          <button class="secondary small" data-rehand="${pi}">Discard my edits and go back to the switches</button>
        </div>
      </details>
    </section>`;
  });

  if (editor.unplaced.length) {
    html += `<details class="unplaced" open>
      <summary>${editor.unplaced.length} suggestion${editor.unplaced.length === 1 ? '' : 's'} couldn't be placed — nothing in the card changes for ${editor.unplaced.length === 1 ? 'it' : 'them'}</summary>
      <p class="folder-hint">The model quoted text that isn't in the card exactly, or is there more than once, so there's no
        safe place to put the change. Copy anything you like into "Edit the final text by hand".</p>
      ${editor.unplaced.map((u) => `<div class="unplaced-item">
        <div class="field-sub"><b>${escapeHtml(u.label || u.target)}</b> — ${escapeHtml(u.reason)}${u.ideaTitle ? ` · from “${escapeHtml(u.ideaTitle)}”` : ''}</div>
        ${u.find ? `<div class="dim">Quoted: “${escapeHtml(u.find.length > 240 ? `${u.find.slice(0, 240)}…` : u.find)}”</div>` : ''}
        ${u.text ? `<pre class="card-field-text">${escapeHtml(u.text)}</pre>` : ''}
      </div>`).join('')}
    </details>`;
  }

  html += editorFooterHtml();
  // A fresh container per render: the listeners below live and die with it,
  // instead of piling up on the modal across reviews.
  const root = document.createElement('div');
  root.innerHTML = html;
  els.modalBody.replaceChildren(root);

  const editAt = (key) => { const [pi, ei] = key.split('-').map(Number); return { p: parts[pi], pi, e: parts[pi].edits[ei] }; };

  root.addEventListener('change', (ev) => {
    const use = ev.target.closest('[data-use]');
    if (use) {
      editAt(use.dataset.use).e.use = use.checked;
      refreshReview();
    }
  });
  root.addEventListener('input', (ev) => {
    const tweak = ev.target.closest('[data-tweak]');
    if (tweak) {
      const { p, e } = editAt(tweak.dataset.tweak);
      e.new = tweak.value;
      els.modalBody.querySelector(`[data-sides="${tweak.dataset.tweak}"]`).innerHTML = editSidesHtml(p, e);
      els.modalBody.querySelector(`[data-untweak="${tweak.dataset.tweak}"]`).disabled = e.new === e.origNew;
      refreshReview();
      return;
    }
    const fin = ev.target.closest('[data-final]');
    if (fin) {
      // Typing in the final text means you've taken over this part: the
      // switches would overwrite your edit, so they pause.
      const p = parts[Number(fin.dataset.final)];
      p.after = fin.value;
      if (!p.handEdited && fin.value !== CardEdits.compose(p.before, p.edits)) {
        p.handEdited = true;
        for (const box of els.modalBody.querySelectorAll(`[data-part="${fin.dataset.final}"] [data-use]`)) box.disabled = true;
      }
      refreshReview();
    }
  });
  root.addEventListener('click', (ev) => {
    const un = ev.target.closest('[data-untweak]');
    if (un) {
      const { p, e } = editAt(un.dataset.untweak);
      e.new = e.origNew;
      els.modalBody.querySelector(`[data-tweak="${un.dataset.untweak}"]`).value = e.new;
      els.modalBody.querySelector(`[data-sides="${un.dataset.untweak}"]`).innerHTML = editSidesHtml(p, e);
      un.disabled = true;
      refreshReview();
      return;
    }
    const re = ev.target.closest('[data-rehand]');
    if (re) {
      const p = parts[Number(re.dataset.rehand)];
      p.handEdited = false;
      for (const box of els.modalBody.querySelectorAll(`[data-part="${re.dataset.rehand}"] [data-use]`)) box.disabled = false;
      refreshReview();
    }
  });
  for (const d of els.modalBody.querySelectorAll('[data-compare]')) d.addEventListener('toggle', () => refreshReview());
  els.modalBody.querySelector('#useSafeBtn').addEventListener('click', () => {
    CardEdits.defaultUses(parts, reviewExtraText());
    for (const box of els.modalBody.querySelectorAll('[data-use]')) box.checked = editAt(box.dataset.use).e.use;
    refreshReview();
  });
  els.modalBody.querySelector('#useNoneBtn').addEventListener('click', () => {
    for (const p of parts) if (!p.handEdited) for (const e of p.edits) e.use = false;
    for (const box of els.modalBody.querySelectorAll('[data-use]')) box.checked = false;
    refreshReview();
  });
  wireEditorFooter();
  refreshReview();
}

/**
 * Brings everything in the review up to date with the current choices: each
 * change's on/off state and detail check, each part's final text and length,
 * the whole-field comparison (when open), the summary, and the warnings about
 * protected lines and lost macros.
 */
function refreshReview() {
  const { parts } = editor;
  const extra = reviewExtraText();
  let on = 0;
  let total = 0;
  let wouldLose = 0;

  parts.forEach((p, pi) => {
    p.edits.forEach((e, ei) => {
      const key = `${pi}-${ei}`;
      total++;
      if (e.use) on++;
      const card = els.modalBody.querySelector(`[data-edit="${key}"]`);
      card.classList.toggle('is-on', e.use && !p.handEdited);
      card.classList.toggle('is-off', !e.use || p.handEdited);
      const { lost, corrected } = CardEdits.editImpact(parts, p, e, extra);
      const check = els.modalBody.querySelector(`[data-check="${key}"]`);
      const fmt = (terms) => terms.slice(0, 10).map((t) => `“${escapeHtml(t)}”`).join(', ') + (terms.length > 10 ? `, and ${terms.length - 10} more` : '');
      const list = fmt(lost);
      if (corrected.length) {
        check.className = 'edit-check tone-info';
        check.innerHTML = `Corrects: ${fmt(corrected)} — replaced on purpose, to match the canon.`;
      } else if (lost.length) {
        wouldLose++;
        check.className = 'edit-check tone-bad';
        check.innerHTML = `⚠ Would remove details found nowhere else in the card: ${list}. Adjust the change to keep them, or leave it off.`;
      } else {
        check.className = 'edit-check tone-good';
        check.textContent = e.old ? '✓ Keeps every detail.' : '✓ Adds only — nothing is removed.';
      }
    });

    const final = partFinal(p);
    const warn = els.modalBody.querySelector(`[data-warn="${pi}"]`);
    const problems = macroWarnings(p.before, final);
    warn.innerHTML = problems.map((w) => `<div class="editor-warning tone-bad">⚠ ${escapeHtml(w)}</div>`).join('');
    const ta = els.modalBody.querySelector(`[data-final="${pi}"]`);
    if (ta && !p.handEdited && document.activeElement !== ta) ta.value = final;
    els.modalBody.querySelector(`[data-hand="${pi}"]`)?.classList.toggle('hidden', !p.handEdited);
    const cmp = els.modalBody.querySelector(`[data-compare="${pi}"]`);
    if (cmp?.open) {
      const sp = p.handEdited
        ? { old: [{ text: p.before }], new: [{ text: p.after }] }
        : CardEdits.spans(p.before, p.edits);
      const side = (list, cls) => list.map((s) => (s.mark ? `<mark class="${cls}">${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('');
      els.modalBody.querySelector(`[data-cols="${pi}"]`).innerHTML = `
        <div class="compare-col"><span class="hunk-label">Card now</span><div class="compare-text">${side(sp.old, 'w-del')}</div></div>
        <div class="compare-col"><span class="hunk-label">After your choices</span><div class="compare-text">${side(sp.new, 'w-add')}</div></div>`;
    }
  });

  const summary = els.modalBody.querySelector('#reviewSummary');
  summary.textContent = `Using ${on} of ${total} change${total === 1 ? '' : 's'}` +
    (wouldLose ? ` · ${wouldLose} would remove details (check before using)` : '') +
    (editor.unplaced.length ? ` · ${editor.unplaced.length} couldn't be placed` : '');
  renderLostQuotes();
}

/**
 * The canon's quoted lines that are no longer anywhere in the card. Checked
 * live, so leaving a change off or restoring a line by hand clears it.
 */
function renderLostQuotes() {
  const box = els.modalBody.querySelector('#lostQuotes');
  if (!box || !editor?.keepQuotes?.length) return;
  const extra = reviewExtraText();
  const after = CardEdits.wholeCard(editor.parts, extra);
  const before = editor.parts.map((p) => p.before).concat(editor.rest).join('\n');
  const norm = (t) => t.replace(/\s+/g, ' ');
  const lost = editor.keepQuotes.filter((q) => norm(before).includes(norm(q)) && !norm(after).includes(norm(q)));
  box.innerHTML = lost.length
    ? `<div class="editor-warning tone-bad">⚠ ${lost.length === 1 ? 'A canon line you protected is' : `${lost.length} canon lines you protected are`} no longer in the card:
        ${lost.map((q) => `<div class="lost-quote">“${escapeHtml(q)}”</div>`).join('')}
        Leave off the change that removes it, or adjust that change to keep it.</div>`
    : '';
}

// ---- hand editing ("Edit text"), and saving for both ----

function startManualEdit(id, name, fields) {
  editor = {
    id,
    name,
    source: 'manual',
    rows: Object.entries(fields).filter(([, text]) => text && text.trim()).map(([field, text]) => ({ field, before: text, after: text })),
  };
  renderManualEditor();
}

function renderManualEditor() {
  let html = `<h2>Edit card: ${escapeHtml(editor.name)}</h2>
    <div class="editor-intro"><p class="folder-hint">Edit the card's own text. Saving as a new card leaves the original
    alone; replacing it keeps a restorable copy in Trash either way.</p></div>`;
  html += editor.rows.map((row, i) => `<div class="editor-row" data-row="${i}">
      <div class="field-title"><span>${escapeHtml(fieldLabel(row.field))}</span></div>
      <div class="editor-warnings" data-warn="${i}"></div>
      <textarea class="editor-text" data-text="${i}" rows="8" spellcheck="false">${escapeHtml(row.after)}</textarea>
      <div class="editor-row-actions"><button class="secondary" data-revert="${i}">Revert this field</button></div>
    </div>`).join('');
  html += editorFooterHtml();
  els.modalBody.innerHTML = html;

  const refreshRow = (i) => {
    const row = editor.rows[i];
    const warnings = macroWarnings(row.before, row.after);
    els.modalBody.querySelector(`[data-warn="${i}"]`).innerHTML = warnings.map((w) => `<div class="editor-warning">⚠ ${escapeHtml(w)}</div>`).join('');
    els.modalBody.querySelector(`[data-row="${i}"]`).classList.toggle('is-changed', row.after !== row.before);
  };
  editor.rows.forEach((row, i) => {
    const ta = els.modalBody.querySelector(`[data-text="${i}"]`);
    ta.addEventListener('input', () => { row.after = ta.value; refreshRow(i); });
    els.modalBody.querySelector(`[data-revert="${i}"]`).addEventListener('click', () => { ta.value = row.before; row.after = row.before; refreshRow(i); });
    refreshRow(i);
  });
  wireEditorFooter();
}

/**
 * Losing a repeated {{user}} is fine editing; losing the last one means the
 * text no longer addresses the user (or the character) at all, which breaks
 * how the card plugs into SillyTavern. Also: a field emptied entirely.
 */
function macroWarnings(before, after) {
  const out = [];
  const dropped = ['user', 'char'].filter((m) => {
    const re = new RegExp(`\\{\\{${m}\\}\\}`, 'gi');
    return (before.match(re) || []).length > 0 && (after.match(re) || []).length === 0;
  });
  if (dropped.length) out.push(`No ${dropped.map((m) => `{{${m}}}`).join(' or ')} left — the original used it.`);
  if (!after.trim() && before.trim()) out.push('This is now empty.');
  return out;
}

function editorFooterHtml() {
  return `<div class="editor-footer">
    <label class="editor-check"><input type="checkbox" id="editorRescore" checked /> Score it after saving</label>
    <div class="editor-buttons">
      <button data-save="new">Save as new card</button>
      <button class="secondary" data-save="replace">Replace original</button>
      <button class="secondary" data-cancel="1">Cancel</button>
    </div>
    <p id="editorMsg" class="folder-hint"></p>
  </div>`;
}

function wireEditorFooter() {
  els.modalBody.querySelector('[data-cancel]').addEventListener('click', () => openCard(editor.id));
  for (const btn of els.modalBody.querySelectorAll('[data-save]')) {
    btn.addEventListener('click', () => saveEditor(btn.dataset.save));
  }
}

/** What saving would write: the changed fields. */
function collectChanges() {
  const fields = {};
  if (editor.source === 'manual') {
    for (const row of editor.rows) if (row.after !== row.before) fields[row.field] = row.after;
  } else {
    for (const p of editor.parts) {
      const final = partFinal(p);
      if (final !== p.before) fields[p.target] = final;
    }
  }
  return fields;
}

async function saveEditor(mode) {
  const msg = els.modalBody.querySelector('#editorMsg');
  const fields = collectChanges();
  const nFields = Object.keys(fields).length;
  if (!nFields) {
    msg.textContent = editor.source === 'improve'
      ? 'No change is in use yet — switch on at least one (or edit the text), or Cancel.'
      : 'Nothing has changed yet — edit something, or Cancel.';
    return;
  }
  // Changes that would lose details, a lost canon line, or lost macros.
  const problems = [...els.modalBody.querySelectorAll('.edit-card.is-on .edit-check.tone-bad, #lostQuotes .editor-warning, [data-warn] .editor-warning')];
  if (problems.length && !confirm(`${problems.length} of the changes you're using would lose something (marked ⚠).\n\nSave anyway?`)) return;
  if (mode === 'replace' && !confirm(
    `Overwrite "${editor.name}" with this version?\n\n${nFields} field${nFields === 1 ? '' : 's'} change${nFields === 1 ? 's' : ''}. A copy of the current file is kept in Trash, so this is undoable.`,
  )) return;

  const rescore = els.modalBody.querySelector('#editorRescore').checked;
  for (const b of els.modalBody.querySelectorAll('[data-save]')) b.disabled = true;
  msg.textContent = rescore ? 'Saving and scoring…' : 'Saving…';

  try {
    const res = await api(`/api/cards/${encodeURIComponent(editor.id)}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields, mode, rescore }),
    });
    await loadCards();

    const now = res.entry?.result?.overall_score;
    const was = res.previousScore;
    let verdict = '';
    if (now != null && was != null) {
      const diff = Math.round((now - was) * 10) / 10;
      verdict = diff > 0 ? `${was} → ${now} / 10  (+${diff})` : diff < 0 ? `${was} → ${now} / 10  (${diff})` : `still ${now} / 10`;
    } else if (now != null) {
      verdict = `${now} / 10`;
    }
    const lines = [
      mode === 'new' ? `Saved as a new card: ${res.file}` : `Replaced ${res.file}`,
      verdict ? `Score: ${verdict}` : 'Saved — not scored yet.',
    ];
    if (res.entry?.scoreError) lines.push(`(Saved fine, but scoring it failed: ${res.entry.scoreError})`);
    if (res.backedUpAs) lines.push(`The previous version is in Trash as: ${res.backedUpAs}`);
    alert(lines.join('\n\n'));
    await openCard(res.file);
  } catch (err) {
    msg.textContent = `Could not save: ${err.message}`;
    for (const b of els.modalBody.querySelectorAll('[data-save]')) b.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Prompts panel
//
// Edit what the model is told, per prompt (full critique, fast scoring,
// improve). Drafts are kept per tab while the panel is open, so switching tabs
// never throws away an edit. The locked response format is shown read-only.
// ---------------------------------------------------------------------------

const promptUi = {
  kinds: [],          // from GET /api/prompts
  active: 'full',
  drafts: {},         // kind -> unsaved text
  staleScores: 0,
};

const pels = {
  panel: document.getElementById('promptsPanel'),
  close: document.getElementById('closePromptsBtn'),
  tabs: document.getElementById('promptTabs'),
  description: document.getElementById('promptDescription'),
  text: document.getElementById('promptText'),
  state: document.getElementById('promptState'),
  count: document.getElementById('promptCount'),
  advice: document.getElementById('promptAdvice'),
  format: document.getElementById('promptFormat'),
  save: document.getElementById('savePromptBtn'),
  discard: document.getElementById('discardPromptBtn'),
  reset: document.getElementById('resetPromptBtn'),
  msg: document.getElementById('promptMsg'),
  card: document.getElementById('promptCard'),
  preview: document.getElementById('previewPromptBtn'),
  test: document.getElementById('testPromptBtn'),
  output: document.getElementById('promptOutput'),
  stale: document.getElementById('promptStale'),
};

function currentKind() {
  return promptUi.kinds.find((k) => k.kind === promptUi.active);
}

function draftFor(kind) {
  return promptUi.drafts[kind] ?? promptUi.kinds.find((k) => k.kind === kind)?.instructions ?? '';
}

function isDirty(kind) {
  const k = promptUi.kinds.find((x) => x.kind === kind);
  return k != null && promptUi.drafts[kind] != null && promptUi.drafts[kind] !== k.instructions;
}

function renderPromptTabs() {
  pels.tabs.replaceChildren(...promptUi.kinds.map((k) => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(k.kind === promptUi.active));
    b.textContent = k.label;
    if (isDirty(k.kind)) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.title = 'Unsaved changes';
      b.append(dot);
    } else if (k.isCustom) {
      const tag = document.createElement('span');
      tag.className = 'tab-tag';
      tag.textContent = 'edited';
      b.append(tag);
    }
    b.addEventListener('click', () => {
      promptUi.drafts[promptUi.active] = pels.text.value;
      promptUi.active = k.kind;
      pels.output.replaceChildren();
      renderPromptEditor();
    });
    return b;
  }));
}

let adviseTimer = null;
function renderPromptMeta() {
  const k = currentKind();
  const text = pels.text.value;
  const dirty = text !== k.instructions;
  const custom = k.isCustom || text !== k.defaultInstructions;
  pels.state.textContent = dirty ? 'unsaved changes' : custom ? 'edited' : 'default';
  pels.state.className = `pill ${dirty ? 'tone-warn' : custom ? 'tone-accent' : ''}`;
  pels.count.textContent = `${text.length.toLocaleString()} characters · ~${Math.ceil(text.length / 4).toLocaleString()} tokens sent with every card`;
  pels.save.disabled = !dirty;
  pels.discard.disabled = !dirty;
  pels.reset.disabled = text === k.defaultInstructions && !k.isCustom;

  // Advice comes from the server so the same rules apply as on save.
  clearTimeout(adviseTimer);
  adviseTimer = setTimeout(async () => {
    try {
      const r = await api('/api/prompts/advise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: k.kind, instructions: pels.text.value }),
      });
      pels.advice.replaceChildren(
        ...r.problems.map((t) => noteEl(t, 'bad')),
        ...r.advice.map((t) => noteEl(t, 'warn')),
      );
    } catch {
      // advice is a nicety
    }
  }, 250);
}

function noteEl(text, tone) {
  const d = document.createElement('div');
  d.className = `editor-warning tone-${tone}`;
  d.textContent = `${tone === 'bad' ? '✕' : '⚠'} ${text}`;
  return d;
}

function renderPromptEditor() {
  const k = currentKind();
  if (!k) return;
  renderPromptTabs();
  pels.description.textContent = k.description;
  pels.text.value = draftFor(k.kind);
  pels.format.textContent = k.format;
  pels.msg.textContent = '';
  // Only the scoring prompts can make a score "stale"; improve doesn't score.
  pels.stale.textContent = k.kind !== 'improve' && promptUi.staleScores
    ? `${promptUi.staleScores.toLocaleString()} existing score${promptUi.staleScores === 1 ? ' was' : 's were'} made with a different prompt than the one now saved. Filter to "Scored with an older prompt" to rescore just those — nothing is rescored automatically.`
    : '';
  renderPromptMeta();
}

function fillCardPicker() {
  // Scored cards first (a test can then be compared with their current score),
  // capped so a 3,000-card library doesn't build a 3,000-row dropdown.
  const scored = state.cards.filter((c) => c.overallScore != null).sort((a, b) => a.name.localeCompare(b.name));
  const rest = state.cards.filter((c) => c.overallScore == null).sort((a, b) => a.name.localeCompare(b.name));
  const list = [...scored, ...rest].slice(0, 400);
  const previous = pels.card.value;
  pels.card.replaceChildren(...list.map((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name.replace(/\.(png|json)$/i, '')}${c.overallScore != null ? ` — currently ${c.overallScore}/10` : ' — not scored yet'}`;
    return o;
  }));
  if (previous && list.some((c) => c.id === previous)) pels.card.value = previous;
}

async function openPrompts(kind) {
  pels.panel.classList.remove('hidden');
  pels.msg.textContent = 'Loading…';
  try {
    const data = await api('/api/prompts');
    promptUi.kinds = data.kinds;
    promptUi.staleScores = data.staleScores;
    if (kind) promptUi.active = kind;
    fillCardPicker();
    renderPromptEditor();
  } catch (err) {
    pels.msg.textContent = `Could not load prompts: ${err.message}`;
  }
}

pels.text.addEventListener('input', () => {
  promptUi.drafts[promptUi.active] = pels.text.value;
  renderPromptMeta();
  renderPromptTabs();
});

pels.close.addEventListener('click', () => {
  promptUi.drafts[promptUi.active] = pels.text.value;
  const unsaved = promptUi.kinds.filter((k) => isDirty(k.kind)).map((k) => k.label);
  if (unsaved.length && !confirm(`Close without saving your changes to: ${unsaved.join(', ')}?`)) return;
  promptUi.drafts = {};
  pels.panel.classList.add('hidden');
});

async function savePrompt(body, doneMessage) {
  pels.save.disabled = true;
  try {
    const saved = await api('/api/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const i = promptUi.kinds.findIndex((k) => k.kind === saved.kind);
    promptUi.kinds[i] = { ...promptUi.kinds[i], ...saved };
    delete promptUi.drafts[saved.kind];
    // A saved scoring prompt changes which scores count as "older prompt".
    const fresh = await api('/api/prompts');
    promptUi.staleScores = fresh.staleScores;
    renderPromptEditor();
    pels.msg.textContent = saved.persisted
      ? doneMessage
      : `${doneMessage} — but it could not be written to config.json (${saved.persistError}), so it lasts until the dashboard restarts.`;
    await loadCards(); // refresh the "older prompt" counts on the dashboard
  } catch (err) {
    pels.msg.textContent = `Not saved: ${err.message}`;
    renderPromptMeta();
  }
}

pels.save.addEventListener('click', () => {
  savePrompt({ kind: promptUi.active, instructions: pels.text.value },
    'Saved. Scans and rescores from now on use this prompt; existing scores are left as they are.');
});

pels.discard.addEventListener('click', () => {
  delete promptUi.drafts[promptUi.active];
  renderPromptEditor();
});

pels.reset.addEventListener('click', () => {
  const k = currentKind();
  if (!confirm(`Put the ${k.label} prompt back to the built-in default? Your edited version will be lost.`)) return;
  savePrompt({ kind: promptUi.active, reset: true }, 'Back to the default prompt.');
});

function outputBlock(title, text) {
  const wrap = document.createElement('div');
  wrap.className = 'field-block';
  const h = document.createElement('div');
  h.className = 'field-title';
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.className = 'card-field-text';
  pre.textContent = text;
  wrap.append(h, pre);
  return wrap;
}

pels.preview.addEventListener('click', async () => {
  pels.output.replaceChildren(noteEl('Building…', 'warn'));
  try {
    const r = await api('/api/prompts/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: promptUi.active, instructions: pels.text.value, cardId: pels.card.value || undefined }),
    });
    const head = document.createElement('p');
    head.className = 'folder-hint';
    head.textContent = `Exactly what one request for "${r.cardName}" contains — about ${r.approxTokens.toLocaleString()} tokens. Nothing was sent.`;
    pels.output.replaceChildren(head, outputBlock('System message (your instructions + the format)', r.system), outputBlock('User message (the card)', r.user));
  } catch (err) {
    pels.output.replaceChildren(noteEl(err.message, 'bad'));
  }
});

pels.test.addEventListener('click', async () => {
  pels.test.disabled = true;
  pels.output.replaceChildren(noteEl('Sending one request…', 'warn'));
  try {
    const r = await api('/api/prompts/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: promptUi.active, instructions: pels.text.value, cardId: pels.card.value || undefined }),
    });
    pels.output.replaceChildren(renderTestResult(r));
  } catch (err) {
    // When the answer couldn't be used, what the model actually said is the
    // most useful thing to see — so it opens by itself.
    const raw = repliesSection(err.body?.replies, { open: true });
    pels.output.replaceChildren(noteEl(`The test request failed: ${err.message}`, 'bad'), ...(raw ? [raw] : []));
  } finally {
    pels.test.disabled = false;
  }
});

function renderTestResult(r) {
  const box = document.createElement('div');
  box.className = 'test-result';
  const head = document.createElement('p');
  head.className = 'folder-hint';
  head.textContent = `"${r.cardName}" · answered in ${(r.tookMs / 1000).toFixed(1)}s · nothing was saved to the card.`;
  box.append(head);

  const out = r.output;
  const raw = repliesSection(r.replies);
  if (promptUi.active === 'improve') {
    const h = document.createElement('p');
    h.textContent = out.headline || 'The model proposed these edits:';
    box.append(h);
    for (const e of out.edits || []) {
      const body = `${e.old ? `Replaces: “${e.old}”` : `After: “${e.anchor}”`}\n→ ${e.new || '(removed)'}`;
      box.append(outputBlock(`${e.label} · ${actionLabel(e)}${e.why ? ` · ${e.why}` : ''}`, body));
    }
    if (out.unplaced?.length) {
      box.append(noteEl(`${out.unplaced.length} edit${out.unplaced.length === 1 ? '' : 's'} couldn't be placed: ${[...new Set(out.unplaced.map((u) => u.reason))].join('; ')}.`, 'warn'));
    }
    if (raw) box.append(raw);
    return box;
  }
  if (promptUi.active === 'ideas') {
    if (out.canon?.length) {
      box.append(outputBlock('The canon — what makes this card itself',
        out.canon.map((c) => `• ${ASPECT_LABEL[c.aspect] || c.aspect}: ${c.fact}${c.quote ? `  “${c.quote}”` : ''}`).join('\n')));
    }
    for (const idea of out.ideas || []) {
      const lines = [idea.change, idea.why && `Why: ${idea.why}`, ...(idea.quotes || []).map((q) => `“${q}”`), idea.risk && `Risk: ${idea.risk}`].filter(Boolean);
      box.append(outputBlock(`${KIND_INFO[idea.kind]?.label || idea.kind} · ${idea.fieldLabel || fieldLabel(idea.field)} · ${idea.impact} impact — ${idea.title}`, lines.join('\n')));
    }
    if (raw) box.append(raw);
    return box;
  }
  const big = document.createElement('div');
  big.className = 'overall-block';
  const score = document.createElement('div');
  score.className = 'overall-score';
  score.textContent = `${out.overall_score} / 10`;
  big.append(score);
  if (r.currentScore != null) {
    const cmp = document.createElement('div');
    const diff = Math.round((out.overall_score - r.currentScore) * 10) / 10;
    cmp.textContent = `Currently ${r.currentScore}/10 with the saved prompt — this version scores it ${diff === 0 ? 'the same' : `${diff > 0 ? '+' : ''}${diff}`}.`;
    big.append(cmp);
  }
  if (out.summary) {
    const sum = document.createElement('div');
    sum.textContent = out.summary;
    big.append(sum);
  }
  box.append(big);
  for (const [field, f] of Object.entries(out.fields || {})) {
    const lines = [f.strengths && `Strengths: ${f.strengths}`, f.weaknesses && `Weaknesses: ${f.weaknesses}`, f.suggestions && `Suggestions: ${f.suggestions}`].filter(Boolean);
    box.append(outputBlock(`${field.replace(/_/g, ' ')} — ${f.score ?? '–'}/10`, lines.join('\n') || '(scores only)'));
  }
  if (raw) box.append(raw);
  return box;
}

/**
 * The model's replies exactly as they arrived — thinking, stray text and all —
 * with why each one stopped and what it cost. Above it is what the dashboard
 * made of the reply; this is what the model actually said.
 */
function repliesSection(replies, { open = false } = {}) {
  if (!replies?.length) return null;
  const d = document.createElement('details');
  d.className = 'raw-replies';
  d.open = open;
  const sum = document.createElement('summary');
  sum.textContent = replies.length > 1
    ? `What the model sent back (${replies.length} replies — an answer that couldn't be used was asked for again)`
    : 'What the model sent back';
  d.append(sum);
  replies.forEach((reply, i) => {
    const u = reply.usage || {};
    const sent = u.prompt_tokens ?? u.input_tokens;
    const got = u.completion_tokens ?? u.output_tokens;
    const thinking = u.completion_tokens_details?.reasoning_tokens;
    const facts = [
      reply.latencyMs != null && `${(reply.latencyMs / 1000).toFixed(1)}s`,
      reply.finishReason && (reply.finishReason === 'length' ? 'stopped: cut off by a length limit' : `stopped: ${reply.finishReason}`),
      sent != null && `${sent.toLocaleString()} tokens in`,
      got != null && `${got.toLocaleString()} out${thinking ? ` (${thinking.toLocaleString()} thinking)` : ''}`,
    ].filter(Boolean);
    const p = document.createElement('p');
    p.className = 'folder-hint';
    p.textContent = `${replies.length > 1 ? `Reply ${i + 1}: ` : ''}${facts.join(' · ') || 'no details reported by the provider'}`;
    d.append(p);
    if (reply.reasoning) {
      const t = document.createElement('details');
      const ts = document.createElement('summary');
      ts.textContent = `Thinking (${reply.reasoning.length.toLocaleString()} characters)`;
      const pre = document.createElement('pre');
      pre.className = 'card-field-text';
      pre.textContent = reply.reasoning;
      t.append(ts, pre);
      d.append(t);
    }
    d.append(outputBlock('Answer, as received', reply.content || '(empty — the model sent no answer text)'));
  });
  return d;
}

els.promptsBtn.addEventListener('click', () => openPrompts());

els.modalClose.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

// A scan runs on the server, not in this tab — reloading the page, or opening
// the dashboard on another device, should show the scan that is already going
// rather than leave you guessing (or tempt you into starting a second one).
async function reattachToRunningScan() {
  try {
    const { jobId } = await api('/api/score/active');
    if (jobId && jobId !== currentJobId) await pollJob(jobId);
  } catch {
    // no scan endpoint reachable yet — nothing to attach to
  }
}

loadCards().then(reattachToRunningScan).catch(async (err) => {
  // Most likely first run: no charactersDir picked yet. Guide straight to the folder picker.
  els.emptyState.textContent = `Couldn't read the characters folder yet (${err.message}). Use "Change folder" below to pick it.`;
  els.emptyState.classList.remove('hidden');
  await openFolderPanel('switch');
});
