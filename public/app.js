const state = {
  cards: [],
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
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  selectionBar: document.getElementById('selectionBar'),
  selectionCount: document.getElementById('selectionCount'),
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
  concurrencyHint: document.getElementById('concurrencyHint'),
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

  els.grid.innerHTML = '';
  els.emptyState.classList.toggle('hidden', cards.length > 0);

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
  els.selectionBar.classList.toggle('hidden', n === 0);
  els.selectionCount.textContent = `${n} selected`;
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

async function pollJob(jobId) {
  els.progressBar.classList.remove('hidden');
  const startedAt = Date.now();
  let lastGridRefresh = 0;

  while (true) {
    const job = await api(`/api/score/batch/${jobId}`);
    const finished = job.done + job.errors;
    const pct = job.total ? Math.round((finished / job.total) * 100) : 100;
    els.progressFill.style.width = `${pct}%`;

    // Report scored and failed separately — counting failures as "progress"
    // hides a run that is churning without actually scoring anything.
    const elapsedMin = (Date.now() - startedAt) / 60000;
    let label = `Scored ${job.done}/${job.total}`;
    if (job.errors) label += ` · ${job.errors} FAILED`;
    if (elapsedMin > 0.3 && finished > 0) {
      const perHour = finished / (elapsedMin / 60);
      const etaH = (job.total - finished) / Math.max(perHour, 0.01);
      label += ` · ${perHour.toFixed(0)}/hr · ETA ${etaH < 1 ? `${Math.round(etaH * 60)}m` : `${etaH.toFixed(1)}h`}`;
    }
    els.progressLabel.textContent = label;

    if (job.status !== 'running') {
      if (job.fatalError) alert(`Batch scoring failed to start: ${job.fatalError}`);
      break;
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Rebuilding the whole grid re-requests every thumbnail. At a few thousand
    // cards that starved the server's scoring pool, so refresh it sparingly
    // while a job runs — the progress line above is the live feedback.
    if (Date.now() - lastGridRefresh > 20000) {
      lastGridRefresh = Date.now();
      await loadCards();
    }
  }

  els.progressBar.classList.add('hidden');
  await loadCards();

  const job = await api(`/api/score/batch/${jobId}`).catch(() => null);
  if (job && job.errors > 0 && job.errors >= job.done) {
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
  if (!confirm(`Move ${state.selected.size} card(s) to trash?`)) return;
  await api('/api/cards/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...state.selected] }) });
  state.selected.clear();
  renderSelectionBar();
  await loadCards();
});
els.clearSelectionBtn.addEventListener('click', () => {
  state.selected.clear();
  renderSelectionBar();
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
    els.settingsModelCustom.value = data.model || '';
    els.apiKeyStatus.textContent = data.apiKeySet ? '(a key is saved — leave blank to keep it)' : '(none saved yet)';
    els.settingsApiKey.value = '';
    els.settingsModelSelect.innerHTML = `<option value="">— save settings, then Refresh list —</option>`;
    els.settingsMsg.textContent = '';
    els.concurrencyHint.textContent = settingsPresets[data.provider]?.rateLimitNote || '';
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
});

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
