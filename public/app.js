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
  scanUnscoredBtn: document.getElementById('scanUnscoredBtn'),
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
  const briefOnly = Boolean(result?.brief);
  html += `<div class="modal-actions">
    <button data-action="score">${briefOnly ? 'Rescore with full critique' : result ? 'Rescore' : 'Score this card'}</button>
    <button data-action="improve" title="${result && !result.partial
      ? 'Rewrites the weak fields using this card\'s own critique. You review and edit the result before anything is saved.'
      : 'Score this card first for a critique-guided rewrite — or improve it now on the text alone.'}">Improve with AI</button>
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
        <div class="field-title"><span>${escapeHtml(field.replace(/_/g, ' '))}</span><span class="field-score">${f.score ?? '–'}/10</span></div>
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
      'Every score that finished is saved. "Scan unscored" picks up exactly where this left off.',
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
      `Failed cards are not lost — "Scan unscored" retries them.\n\n` +
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
// Scoring a collection is only half the job — the point of finding the best
// Raven is to then make it better. This is the "improve it" half: the model
// rewrites the weak fields using its own critique, you review the result field
// by field (and hand-edit it), and only then does anything touch a file. Saving
// defaults to a NEW card, so the original is never the thing being gambled.
// ---------------------------------------------------------------------------

let editor = null; // { id, name, source, headline, previousScore, rows: [...] }

function tokensOf(text) {
  return Math.ceil((text || '').length / 4);
}

function fieldLabel(field) {
  return field.replace(/_/g, ' ');
}

/** Rows for the "Improve with AI" review: only the fields the model rewrote. */
function rowsFromProposal(data) {
  return Object.entries(data.fields).map(([field, f]) => ({
    field,
    before: data.before[field] ?? '',
    after: f.text,
    why: f.why || '',
    inflated: f.inflated,
    lostMacros: f.lostMacros,
  }));
}

/** Rows for hand-editing: every field that has text, unchanged to start with. */
function rowsFromCard(fields) {
  return Object.entries(fields)
    .filter(([, text]) => text && text.trim())
    .map(([field, text]) => ({ field, before: text, after: text, why: '', inflated: false, lostMacros: false }));
}

function renderEditor() {
  const { id, name, source, headline, previousScore, rows } = editor;
  const improving = source === 'improve';

  let html = `<h2>${improving ? 'Improved draft' : 'Edit card'}: ${escapeHtml(name)}</h2>`;

  html += `<div class="editor-intro">`;
  if (improving) {
    html += `<p>${escapeHtml(headline || 'The model rewrote the fields below.')}</p>
      <p class="folder-hint">Nothing has been saved yet. Edit any of it by hand, then save — by default as a
      <b>new card</b>, leaving the original untouched.${previousScore != null ? ` The original scores <b>${previousScore}/10</b>.` : ''}</p>`;
  } else {
    html += `<p class="folder-hint">Edit the card's own text. Saving as a new card leaves the original alone;
      replacing it keeps a restorable copy in Trash either way.</p>`;
  }
  html += `</div>`;

  html += rows
    .map((row, i) => {
      const changed = row.after !== row.before;
      return `<div class="editor-row ${changed ? 'is-changed' : ''}" data-row="${i}">
        <div class="field-title">
          <span>${escapeHtml(fieldLabel(row.field))}</span>
          <span class="token-delta" data-delta="${i}"></span>
        </div>
        ${row.why ? `<div class="field-sub"><b>Change:</b> ${escapeHtml(row.why)}</div>` : ''}
        <div class="editor-warnings" data-warn="${i}"></div>
        ${row.before
          ? `<details class="before-block">
               <summary>Original (${tokensOf(row.before)} tok)</summary>
               <pre class="card-field-text">${escapeHtml(row.before)}</pre>
             </details>`
          : ''}
        <textarea class="editor-text" data-text="${i}" rows="8" spellcheck="false">${escapeHtml(row.after)}</textarea>
        <div class="editor-row-actions">
          <button class="secondary" data-revert="${i}">Revert this field</button>
        </div>
      </div>`;
    })
    .join('');

  html += `<div class="editor-footer">
    <label class="editor-check"><input type="checkbox" id="editorRescore" checked /> Score it after saving</label>
    <div class="editor-buttons">
      <button data-save="new">Save as new card</button>
      <button class="secondary" data-save="replace">Replace original</button>
      <button class="secondary" data-cancel="1">Cancel</button>
    </div>
    <p id="editorMsg" class="folder-hint"></p>
  </div>`;

  els.modalBody.innerHTML = html;

  // Token counts and warnings update as you type, because the single most
  // useful signal while editing a card is "am I making this longer again?".
  function refreshRow(i) {
    const row = editor.rows[i];
    const ta = els.modalBody.querySelector(`[data-text="${i}"]`);
    row.after = ta.value;
    const before = tokensOf(row.before);
    const after = tokensOf(row.after);
    const diff = after - before;
    const delta = els.modalBody.querySelector(`[data-delta="${i}"]`);
    const sign = diff > 0 ? '+' : '';
    delta.textContent = `${before} → ${after} tok (${sign}${diff})`;
    delta.className = `token-delta ${diff > Math.max(10, before * 0.15) ? 'is-bad' : diff < 0 ? 'is-good' : ''}`;

    const warnings = [];
    if (diff > Math.max(10, before * 0.15) && before >= 40) {
      warnings.push('Longer than the original — a padded card scores worse, not better.');
    }
    // Losing a repeated macro is fine editing; losing the last one means the
    // card no longer addresses the user (or itself) at all, which breaks it.
    const dropped = ['user', 'char'].filter((m) => {
      const re = new RegExp(`\\{\\{${m}\\}\\}`, 'g');
      return (row.before.match(re) || []).length > 0 && (row.after.match(re) || []).length === 0;
    });
    if (dropped.length) {
      warnings.push(`No ${dropped.map((m) => `{{${m}}}`).join(' or ')} left — the original used it.`);
    }
    if (!row.after.trim() && row.before.trim()) warnings.push('This field is now empty.');
    els.modalBody.querySelector(`[data-warn="${i}"]`).innerHTML = warnings
      .map((w) => `<div class="editor-warning">⚠ ${escapeHtml(w)}</div>`)
      .join('');
    els.modalBody.querySelector(`[data-row="${i}"]`).classList.toggle('is-changed', row.after !== row.before);
  }

  rows.forEach((_, i) => {
    refreshRow(i);
    els.modalBody.querySelector(`[data-text="${i}"]`).addEventListener('input', () => refreshRow(i));
    els.modalBody.querySelector(`[data-revert="${i}"]`).addEventListener('click', () => {
      els.modalBody.querySelector(`[data-text="${i}"]`).value = editor.rows[i].before;
      refreshRow(i);
    });
  });

  els.modalBody.querySelector('[data-cancel]').addEventListener('click', () => openCard(id));
  for (const btn of els.modalBody.querySelectorAll('[data-save]')) {
    btn.addEventListener('click', () => saveEditor(btn.dataset.save));
  }
}

async function saveEditor(mode) {
  const msg = els.modalBody.querySelector('#editorMsg');
  const changed = {};
  for (const row of editor.rows) {
    if (row.after !== row.before) changed[row.field] = row.after;
  }
  if (!Object.keys(changed).length) {
    msg.textContent = 'Nothing has changed yet — edit something, or Cancel.';
    return;
  }
  if (mode === 'replace' && !confirm(
    `Overwrite "${editor.name}" with this version?\n\n` +
    `${Object.keys(changed).length} field(s) change. A copy of the current file is kept in Trash, so this is undoable.`,
  )) return;

  const rescore = els.modalBody.querySelector('#editorRescore').checked;
  for (const b of els.modalBody.querySelectorAll('[data-save]')) b.disabled = true;
  msg.textContent = rescore ? 'Saving and scoring…' : 'Saving…';

  try {
    const res = await api(`/api/cards/${encodeURIComponent(editor.id)}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: changed, mode, rescore }),
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

async function startImprove(id, name) {
  els.modalBody.innerHTML = `<h2>${escapeHtml(name)}</h2>
    <p class="editor-working">Asking the model to rewrite the weak fields…</p>
    <p class="folder-hint">This is one request and takes about as long as scoring a card. Nothing is saved
    until you review it.</p>`;
  try {
    const data = await api(`/api/cards/${encodeURIComponent(id)}/improve`, { method: 'POST' });
    editor = {
      id,
      name: data.name,
      source: 'improve',
      headline: data.headline,
      previousScore: data.previousScore,
      rows: rowsFromProposal(data),
    };
    renderEditor();
  } catch (err) {
    els.modalBody.innerHTML = `<h2>${escapeHtml(name)}</h2>
      <p style="color:var(--red)">Could not improve this card: ${escapeHtml(err.message)}</p>`;
    const back = document.createElement('button');
    back.textContent = 'Back to the card';
    back.addEventListener('click', () => openCard(id));
    els.modalBody.appendChild(back);
  }
}

function startManualEdit(id, name, fields) {
  editor = { id, name, source: 'manual', headline: '', previousScore: null, rows: rowsFromCard(fields) };
  renderEditor();
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
    pels.output.replaceChildren(noteEl(`The test request failed: ${err.message}`, 'bad'));
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
  if (promptUi.active === 'improve') {
    const h = document.createElement('p');
    h.textContent = out.headline || 'The model proposed these changes:';
    box.append(h);
    for (const [field, f] of Object.entries(out.fields)) {
      box.append(outputBlock(`${field.replace(/_/g, ' ')} · ${f.tokensBefore} → ${f.tokensAfter} tok${f.why ? ` · ${f.why}` : ''}`, f.text));
    }
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
  return box;
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
