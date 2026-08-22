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
};

function scoreClass(score, error) {
  if (error) return 'score-error';
  if (score == null) return 'score-unscored';
  if (score >= 8) return 'score-great';
  if (score >= 6) return 'score-good';
  if (score >= 4) return 'score-mediocre';
  return 'score-weak';
}

async function api(url, options) {
  const res = await fetch(url, options);
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
  while (true) {
    const job = await api(`/api/score/batch/${jobId}`);
    const pct = job.total ? Math.round(((job.done + job.errors) / job.total) * 100) : 100;
    els.progressFill.style.width = `${pct}%`;
    els.progressLabel.textContent = `Scoring ${job.done + job.errors}/${job.total} (${job.errors} errors)`;
    if (job.status !== 'running') {
      if (job.fatalError) alert(`Batch scoring failed to start: ${job.fatalError}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    await loadCards();
  }
  els.progressBar.classList.add('hidden');
  await loadCards();
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

els.modalClose.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

loadCards().catch((err) => {
  els.emptyState.textContent = `Failed to load cards: ${err.message}`;
  els.emptyState.classList.remove('hidden');
});
