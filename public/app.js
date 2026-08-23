const state = {
  cards: [],
  shown: [],
  selected: new Set(),
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
  selectAllShownBtn: document.getElementById('selectAllShownBtn'),
  scoreSelectedBtn: document.getElementById('scoreSelectedBtn'),
  deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
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
  const f = els.filterBy.value;
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
  state.shown = cards; // what "Select all shown" acts on

  els.grid.innerHTML = '';
  els.emptyState.classList.toggle('hidden', cards.length > 0);
  renderSelectionBar();

  for (const card of cards) {
    const tile = document.createElement('div');
    tile.className = 'card-tile';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'card-checkbox';
    checkbox.checked = state.selected.has(card.id);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
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
    info.appendChild(name);
    info.appendChild(meta);
    tile.appendChild(info);

    tile.addEventListener('click', () => openCard(card.id));
    els.grid.appendChild(tile);
  }
}

function renderSelectionBar() {
  const n = state.selected.size;
  const shown = state.shown || [];
  const allShownSelected = shown.length > 0 && shown.every((c) => state.selected.has(c.id));

  els.shownCount.textContent = `${shown.length} card${shown.length === 1 ? '' : 's'} shown`;
  els.selectAllShownBtn.textContent = allShownSelected ? 'Deselect all shown' : `Select all shown (${shown.length})`;
  els.selectAllShownBtn.classList.toggle('hidden', shown.length === 0);

  els.selectionCount.textContent = n ? `${n} selected` : '';
  for (const btn of [els.scoreSelectedBtn, els.deleteSelectedBtn, els.clearSelectionBtn]) {
    btn.classList.toggle('hidden', n === 0);
  }
  els.deleteSelectedBtn.textContent = n ? `Delete selected (${n})` : 'Delete selected';
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
      <div>${escapeHtml(result.summary || '')}</div>
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

  if (job.errors > 0 && job.errors >= job.done) {
    alert(
      `${job.errors} of ${job.done + job.errors} cards FAILED to score.\n\n` +
      `This usually means the model is too slow (requests timing out) or is returning ` +
      `unusable output.\n\nRun this in a terminal to find out exactly why:\n\n    node src/cli.js doctor`,
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
els.filterBy.addEventListener('change', renderGrid);

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

els.folderBtn.addEventListener('click', async () => {
  els.folderPanel.classList.remove('hidden');
  await browseFolder(els.dirLabel.textContent || undefined);
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
  els.folderPanel.classList.remove('hidden');
  await browseFolder();
});
