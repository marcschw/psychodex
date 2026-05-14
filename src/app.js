import db from './db.js';
import { loadAllICD, searchDiagnoses } from './icd-loader.js';
import { calculateCatchXP, calculateFlameBonus } from './xp-engine.js';
import { RANKS, getRankForXP, getNextRank } from './ranks.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  currentTab: 'dashboard',
  icdData: {},
  icdFlat: [],
  icdIndex: null,
  activeShift: null,
  editingShiftId: null,
  searchContext: { patientIndex: null, selectedDiagnosis: null, standalone: false },
  addToShiftContext: null,     // { shiftId, patientIndex } when adding diag to existing shift
  pendingStandaloneCatch: null, // { diagnosis, hasComorbidity, xpResult } while assigning
  symptomSelected: [],          // array of selected symptom strings
  catchesSort: 'chrono',        // 'chrono' | 'alpha' | 'category'
  profile: null,
  shifts: [],
  catches: []
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const showError = msg => {
    document.getElementById('loading-screen').innerHTML =
      `<div class="load-error">${msg}<br><button onclick="location.reload()" style="margin-top:16px;padding:10px 24px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Neu laden</button></div>`;
  };

  const timeout = setTimeout(() =>
    showError('Laden dauert zu lange – mögliche Ursache: IndexedDB blockiert.'), 12000);

  try {
    if (typeof Dexie === 'undefined') throw new Error('Dexie nicht geladen.');
    await Promise.all([loadAllICD(state), loadICDIndex()]);
    await loadFromDB();
    clearTimeout(timeout);
    renderApp();
    setupNav();
    setupShiftListeners();
    setupDiagnosisModalListeners();
    setupLevelupListeners();
    setupCategoryModalListeners();
    setupEditShiftListeners();
    setupShiftDetailListeners();
    setupSymptomFinderListeners();
    setupHoursModalListeners();
    setupCatchesModalListeners();
    setupShiftAssignListeners();
    setupExportImport();
    setupEscapeKey();
    setDefaultDate();
    document.getElementById('loading-screen').classList.add('fade-out');
    setTimeout(() => {
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('main-content').classList.remove('hidden');
    }, 500);
  } catch (err) {
    clearTimeout(timeout);
    showError(`Fehler: ${err.message}`);
  }
}

async function loadICDIndex() {
  try {
    const res = await fetch('data/icd/index.json');
    state.icdIndex = await res.json();
  } catch { state.icdIndex = { categories: [] }; }
}

// ─── DB ───────────────────────────────────────────────────────────────────────
async function loadFromDB() {
  let profiles = await db.profile.toArray();
  if (!profiles.length) {
    const id = await db.profile.add({ totalXP: 0, createdAt: new Date().toISOString() });
    profiles = [await db.profile.get(id)];
  }
  state.profile = profiles[0];
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
}

// ─── Escape key closes any open modal ─────────────────────────────────────────
function setupEscapeKey() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openModals = [
      { id: 'diagnosis-modal',      fn: closeDiagnosisModal },
      { id: 'category-modal',       fn: closeCategoryModal },
      { id: 'edit-shift-modal',     fn: closeEditShiftModal },
      { id: 'shift-detail-modal',   fn: closeShiftDetailModal },
      { id: 'symptom-finder-modal', fn: closeSymptomFinder },
      { id: 'hours-modal',          fn: closeHoursModal },
      { id: 'catches-modal',        fn: closeCatchesModal },
      { id: 'shift-assign-modal',   fn: closeShiftAssignModal },
    ];
    for (const { id, fn } of openModals) {
      if (!document.getElementById(id)?.classList.contains('hidden')) { fn(); break; }
    }
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
  });
}

function navigateTo(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const tabEl = document.getElementById(`tab-${tab}`);
  const btnEl = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'log') resetShiftForm();
  if (tab === 'dex') renderPsychoDex();
  if (tab === 'stats') renderStats();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderApp() {
  renderDashboard();
  updateHeader();
}

function updateHeader() {
  const xp   = state.profile?.totalXP ?? 0;
  const rank = getRankForXP(xp);
  const next = getNextRank(rank.level);
  const pct  = next ? ((xp - rank.xpRequired) / (next.xpRequired - rank.xpRequired)) * 100 : 100;
  document.getElementById('header-rank-name').textContent = `${rank.title} ${rank.subtitle}`;
  document.getElementById('header-level').textContent = `Rang ${rank.level}`;
  document.getElementById('header-xp-fill').style.width = `${Math.min(100, pct)}%`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const xp   = state.profile?.totalXP ?? 0;
  const rank = getRankForXP(xp);
  const next = getNextRank(rank.level);
  const pct  = next ? ((xp - rank.xpRequired) / (next.xpRequired - rank.xpRequired)) * 100 : 100;

  document.getElementById('rank-title').textContent    = rank.title;
  document.getElementById('rank-subtitle').textContent = rank.subtitle;
  document.getElementById('rank-level').textContent    = `Rang ${rank.level} / 18`;
  document.getElementById('xp-current').textContent    = xp.toLocaleString('de-AT');
  document.getElementById('xp-needed').textContent     = next ? next.xpRequired.toLocaleString('de-AT') : '∞';
  document.getElementById('xp-bar-fill').style.width   = `${Math.min(100, Math.max(0, pct))}%`;
  document.getElementById('xp-pct').textContent        = `${Math.round(Math.min(100, pct))}%`;

  // Rank image as actual <img>
  const imgEl = document.getElementById('rank-card-img');
  imgEl.src   = `assets/images/ranks/${rank.title.toLowerCase()}.png`;
  imgEl.alt   = rank.title;
  imgEl.style.opacity = '1';

  // Stars: 1 for levels 1-6, 2 for 7-12, 3 for 13-18
  const numStars = rank.level <= 6 ? 1 : rank.level <= 12 ? 2 : 3;
  document.getElementById('rank-stars').textContent = '⭐'.repeat(numStars);

  // Streak
  const streak = calcStreak(state.shifts);
  document.getElementById('streak-icon').textContent  = streak.frozen ? '🧊' : '🔥';
  document.getElementById('streak-value').textContent = streak.count;

  // Total hours
  const totalHours = state.shifts.reduce((s, sh) => s + (sh.type === 'full' ? 12 : 6.5), 0)
    .toFixed(1).replace(/\.0$/, '');
  document.getElementById('total-hours').textContent  = `${totalHours}h`;
  document.getElementById('total-catches').textContent = state.catches.length;

  // Stat card clicks
  const hoursCard   = document.getElementById('stat-hours-card');
  const catchesCard = document.getElementById('stat-catches-card');
  hoursCard.onclick   = openHoursModal;
  catchesCard.onclick = openCatchesModal;

  // Recent catches
  const catchEl = document.getElementById('recent-catches');
  catchEl.innerHTML = state.catches.length
    ? state.catches.slice(0, 5).map(c => `
        <div class="recent-item">
          <div class="recent-code">${c.code}</div>
          <div class="recent-info">
            <div class="recent-name">${c.name}</div>
            <div class="recent-meta">+${c.xpEarned} XP · ${fmtDate(c.caughtAt)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <div class="catch-badge">✓</div>
            <button class="btn-icon btn-delete-catch" data-id="${c.id}" title="Löschen">🗑</button>
          </div>
        </div>`).join('')
    : '<div class="empty-state">Noch keine Diagnosen – starte deinen ersten Dienst!</div>';

  catchEl.querySelectorAll('.btn-delete-catch').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteCatch(parseInt(btn.dataset.id));
    });
  });

  // Recent shifts – clickable for detail view
  const shiftEl = document.getElementById('recent-shifts');
  shiftEl.innerHTML = state.shifts.length
    ? state.shifts.slice(0, 5).map(s => `
        <div class="recent-item shift-item-clickable" data-id="${s.id}" style="cursor:pointer">
          <div class="shift-icon">${shiftIcon(s.type)}</div>
          <div class="recent-info">
            <div class="recent-name">${fmtDateShort(s.date)}</div>
            <div class="recent-meta">${shiftLabel(s.type)} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
          <span style="font-size:12px;color:var(--text-dim)">›</span>
        </div>`).join('')
    : '<div class="empty-state">Noch keine Dienste geloggt.</div>';

  shiftEl.querySelectorAll('.shift-item-clickable').forEach(item => {
    item.addEventListener('click', () => openShiftDetailModal(parseInt(item.dataset.id)));
  });
}

// ─── Streak ───────────────────────────────────────────────────────────────────
function calcStreak(shifts) {
  if (!shifts.length) return { count: 0, frozen: false };
  const isoWeek = d => {
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const y = tmp.getUTCFullYear();
    const w = Math.ceil((((tmp - new Date(Date.UTC(y, 0, 1))) / 86400000) + 1) / 7);
    return `${y}-W${String(w).padStart(2, '0')}`;
  };
  const today = new Date();
  const shiftWeeks = new Set(shifts.map(s => isoWeek(new Date(s.date))));
  const thisWeek = isoWeek(today);
  const lastWeekDate = new Date(today);
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeek = isoWeek(lastWeekDate);

  let frozen = false;
  let cursor = new Date(today);
  if (!shiftWeeks.has(thisWeek)) {
    if (shiftWeeks.has(lastWeek)) frozen = true;
    cursor.setDate(cursor.getDate() - 7);
  }
  let count = 0;
  while (shiftWeeks.has(isoWeek(cursor))) {
    count++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return { count, frozen };
}

// ─── Shift Form ───────────────────────────────────────────────────────────────
function setDefaultDate() {
  const el = document.getElementById('shift-date');
  if (el) el.value = new Date().toISOString().split('T')[0];
}

function setupShiftListeners() {
  document.querySelectorAll('#step-shift-info .type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#step-shift-info .type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('btn-next-to-patients').addEventListener('click', goToPatients);
  document.getElementById('btn-back-to-info').addEventListener('click', goBackToInfo);
  document.getElementById('btn-add-patient').addEventListener('click', addPatientCard);
  document.getElementById('btn-finish-shift').addEventListener('click', finishShift);
}

function resetShiftForm() {
  showStep('step-shift-info');
  document.getElementById('patient-list').innerHTML = '';
  state.activeShift = null;
  setDefaultDate();
  document.querySelectorAll('#step-shift-info .type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
}

function goBackToInfo() { showStep('step-shift-info'); }

function goToPatients() {
  const dateVal = document.getElementById('shift-date').value;
  if (!dateVal) { alert('Bitte Datum auswählen.'); return; }
  const active = document.querySelector('#step-shift-info .type-btn.active');
  state.activeShift = { date: dateVal, type: active.dataset.type, xpBase: parseInt(active.dataset.xp), patients: [] };
  showStep('step-patients');
}

function showStep(id) {
  document.querySelectorAll('.step-card').forEach(c => c.classList.add('hidden-step'));
  document.getElementById(id)?.classList.remove('hidden-step');
}

// ─── Patient Cards ────────────────────────────────────────────────────────────
function addPatientCard() {
  if (!state.activeShift) return;
  const idx = state.activeShift.patients.length;
  state.activeShift.patients.push({ ageGroup: '31-50', gender: 'weiblich', patientType: 'erstgespraech', diagnoses: [] });
  document.getElementById('patient-list').appendChild(buildPatientCard(idx, state.activeShift.patients[idx]));
}

function buildPatientCard(idx, patient) {
  const card = document.createElement('div');
  card.className = 'patient-card';
  card.id = `patient-card-${idx}`;
  const pt = patient.patientType || 'erstgespraech';
  card.innerHTML = `
    <div class="patient-header">
      <span class="patient-num">Patient ${idx + 1}</span>
      <button class="btn-icon btn-remove-patient" title="Entfernen">✕</button>
    </div>
    <div class="patient-demographics">
      <select class="demo-select" data-field="ageGroup">
        <option value="18-30" ${patient.ageGroup==='18-30'?'selected':''}>18–30 J.</option>
        <option value="31-50" ${patient.ageGroup==='31-50'?'selected':''}>31–50 J.</option>
        <option value="51+"   ${patient.ageGroup==='51+'  ?'selected':''}>51+ J.</option>
      </select>
      <select class="demo-select" data-field="gender">
        <option value="weiblich" ${patient.gender==='weiblich'?'selected':''}>Weiblich</option>
        <option value="männlich" ${patient.gender==='männlich'?'selected':''}>Männlich</option>
        <option value="divers"   ${patient.gender==='divers'  ?'selected':''}>Divers</option>
      </select>
      <select class="demo-select demo-wide" data-field="patientType">
        <option value="erstgespraech" ${pt==='erstgespraech'?'selected':''}>Erstgespräch</option>
        <option value="interview"     ${pt==='interview'    ?'selected':''}>Interview</option>
      </select>
    </div>
    <div class="patient-diagnoses" id="diagnoses-${idx}">
      <div class="no-diag-hint">Noch keine Diagnose</div>
    </div>
    <button class="btn-search-diag">🔬 Diagnose suchen & fangen</button>`;

  card.querySelector('.btn-remove-patient').addEventListener('click', () => removePatient(idx));
  card.querySelector('.btn-search-diag').addEventListener('click', () => openDiagnosisSearch(idx));
  const diagBtn = card.querySelector('.btn-search-diag');
  card.querySelectorAll('.demo-select').forEach(sel => {
    sel.addEventListener('change', e => {
      if (state.activeShift?.patients[idx]) {
        state.activeShift.patients[idx][e.target.dataset.field] = e.target.value;
        }
    });
  });
  renderPatientDiagnoses(idx, patient);
  return card;
}

function removePatient(idx) {
  if (!state.activeShift) return;
  state.activeShift.patients.splice(idx, 1);
  redrawPatientList();
}

function redrawPatientList() {
  const listEl = document.getElementById('patient-list');
  listEl.innerHTML = '';
  state.activeShift.patients.forEach((p, i) => listEl.appendChild(buildPatientCard(i, p)));
}

function renderPatientDiagnoses(idx, patient) {
  const el = document.getElementById(`diagnoses-${idx}`);
  if (!el) return;
  if (!patient.diagnoses.length) {
    el.innerHTML = '<div class="no-diag-hint">Noch keine Diagnose</div>';
    return;
  }
  el.innerHTML = patient.diagnoses.map(d => `
    <div class="caught-diag-item">
      <span class="caught-code">${d.diagnosis.code}</span>
      <span class="caught-name">${d.diagnosis.name}</span>
      <span class="caught-xp">+${d.xpEarned} XP</span>
    </div>`).join('');
}

// ─── Diagnosis Search Modal ───────────────────────────────────────────────────
function setupDiagnosisModalListeners() {
  document.getElementById('diag-modal-close').addEventListener('click', e => {
    e.stopPropagation();
    closeDiagnosisModal();
  });
  document.getElementById('diag-modal-backdrop').addEventListener('click', closeDiagnosisModal);
  document.getElementById('diag-search-input').addEventListener('input', onSearch);
  document.getElementById('btn-catch-diagnosis').addEventListener('click', catchDiagnosis);
  document.getElementById('komorbid-checkbox').addEventListener('change', updateXPPreview);
  document.getElementById('btn-standalone-catch').addEventListener('click', () => openStandaloneCatch());
  document.getElementById('btn-symptom-finder').addEventListener('click', openSymptomFinder);
  document.querySelectorAll('.diag-modal-tab').forEach(tab =>
    tab.addEventListener('click', () => switchDiagTab(tab.dataset.tab)));
}

function openDiagnosisSearch(patientIndex) {
  state.searchContext = { patientIndex, selectedDiagnosis: null, standalone: false };
  state.addToShiftContext = null;
  const patient = state.activeShift?.patients[patientIndex];
  const autoKomorbid = patient && patient.diagnoses.length >= 1;
  resetDiagSearchUI();
  document.getElementById('komorbid-checkbox').checked = autoKomorbid;
  document.getElementById('diagnosis-modal').classList.remove('hidden');
  document.getElementById('diag-search-input').focus();
}

function openStandaloneCatch(prefillDiagnosis = null) {
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: true };
  state.addToShiftContext = null;
  resetDiagSearchUI();
  document.getElementById('diagnosis-modal').classList.remove('hidden');
  if (prefillDiagnosis) showDiagnosisDetail(prefillDiagnosis);
  else document.getElementById('diag-search-input').focus();
}

// Used when adding a diagnosis to a specific existing shift/patient
function openAddToShiftDiagSearch(shiftId, patientIndex) {
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: true };
  state.addToShiftContext = { shiftId, patientIndex };
  resetDiagSearchUI();
  document.getElementById('diagnosis-modal').classList.remove('hidden');
  document.getElementById('diag-search-input').focus();
}

function resetDiagSearchUI() {
  document.getElementById('diag-search-input').value = '';
  document.getElementById('diag-search-results').innerHTML = '';
  document.getElementById('diag-detail').classList.add('hidden');
  document.getElementById('komorbid-checkbox').checked = false;
  switchDiagTab('search');
}

function switchDiagTab(tab) {
  document.querySelectorAll('.diag-modal-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('diag-pane-search').classList.toggle('hidden', tab !== 'search');
  document.getElementById('diag-pane-browse').classList.toggle('hidden', tab !== 'browse');
  document.getElementById('diag-detail').classList.add('hidden');
  if (tab === 'browse') renderDiagBrowseCats();
}

function renderDiagBrowseCats() {
  const catsEl = document.getElementById('diag-browse-cats');
  const listEl = document.getElementById('diag-browse-list');
  const caughtCodes = new Set(state.catches.map(c => c.code));
  listEl.classList.add('hidden');
  catsEl.classList.remove('hidden');
  catsEl.innerHTML = (state.icdIndex?.categories || []).map(cat => {
    const diags = state.icdData[cat.code] || [];
    const catCaught = diags.filter(d => caughtCodes.has(d.code)).length;
    return `
      <button class="diag-browse-cat-btn" data-cat="${cat.code}">
        <div class="diag-browse-cat-emoji">${cat.emoji}</div>
        <div class="diag-browse-cat-label">${cat.code}</div>
        <div class="diag-browse-cat-name">${cat.name}</div>
        <div class="diag-browse-cat-count">${catCaught}/${diags.length}</div>
      </button>`;
  }).join('');
  catsEl.querySelectorAll('.diag-browse-cat-btn').forEach(btn =>
    btn.addEventListener('click', () => renderDiagBrowseList(btn.dataset.cat)));
}

function renderDiagBrowseList(catCode) {
  const catsEl = document.getElementById('diag-browse-cats');
  const listEl = document.getElementById('diag-browse-list');
  const diags = state.icdData[catCode] || [];
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const catInfo = state.icdIndex?.categories.find(c => c.code === catCode);
  catsEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.className = 'diag-browse-list';
  listEl.innerHTML = `
    <div class="diag-browse-back" id="diag-browse-back-btn">← Zurück zu Kategorien</div>
    <div class="section-header" style="margin-top:0">${catInfo?.emoji || ''} ${catInfo?.name || catCode}</div>
    ${diags.map(d => {
      const caught = caughtCodes.has(d.code);
      return `
        <div class="diag-browse-item ${caught ? 'is-caught' : ''}" data-code="${d.code}">
          <span class="diag-list-code">${d.code}</span>
          <div style="flex:1;min-width:0">
            <div class="diag-list-name">${d.name}</div>
            <div class="diag-list-rarity">${'★'.repeat(d.seltenheit_score)}${'☆'.repeat(10 - d.seltenheit_score)}</div>
          </div>
          <span class="diag-list-status">${caught ? '✓' : '🔬'}</span>
        </div>`;
    }).join('')}`;
  listEl.querySelector('#diag-browse-back-btn')?.addEventListener('click', () => {
    listEl.classList.add('hidden');
    catsEl.classList.remove('hidden');
  });
  listEl.querySelectorAll('.diag-browse-item:not(.is-caught)').forEach(item =>
    item.addEventListener('click', () => {
      const diag = state.icdFlat.find(d => d.code === item.dataset.code);
      if (diag) showDiagnosisDetail(diag);
    }));
}

function closeDiagnosisModal() {
  document.getElementById('diagnosis-modal').classList.add('hidden');
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: false };
  state.addToShiftContext = null;
}

function onSearch(e) {
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('diag-search-results');
  document.getElementById('diag-detail').classList.add('hidden');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }
  const results = searchDiagnoses(state.icdFlat, q);
  if (!results.length) {
    resultsEl.innerHTML = `<div class="no-results">Keine Treffer für „${q}"</div>`;
    return;
  }
  resultsEl.innerHTML = results.map(d => `
    <div class="search-result-item" data-code="${d.code}">
      <span class="result-code">${d.code}</span>
      <span class="result-name">${d.name}</span>
      <span class="result-rarity" title="Seltenheit">★${d.seltenheit_score}</span>
    </div>`).join('');
  resultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const diag = state.icdFlat.find(d => d.code === item.dataset.code);
      if (diag) showDiagnosisDetail(diag);
    });
  });
}

function showDiagnosisDetail(diagnosis) {
  state.searchContext.selectedDiagnosis = diagnosis;
  document.getElementById('diag-search-results').innerHTML = '';
  document.getElementById('diag-detail').classList.remove('hidden');
  renderDiagnosisDetail(diagnosis);
}

function renderDiagnosisDetail(diagnosis) {
  const preview = previewXP(diagnosis, document.getElementById('komorbid-checkbox').checked);
  document.getElementById('diag-detail-header').innerHTML = `
    <div class="diag-code-big">${diagnosis.code}</div>
    <div class="diag-name-big">${diagnosis.name}</div>
    <div class="xp-preview-chips">
      <span class="xp-chip base">Basis: ${preview.base} XP</span>
      ${preview.isFirstDiag   ? '<span class="xp-chip bonus-diag">+150 Erste Diagnose!</span>' : ''}
      ${preview.isFirstKat    ? '<span class="xp-chip bonus-kat">+300 Erste Kategorie!</span>' : ''}
      ${preview.komorbidBonus ? '<span class="xp-chip bonus-k">+Komorbidität 20%</span>' : ''}
    </div>`;
  const mk = l => `<li class="symptom-item">${l}</li>`;
  document.getElementById('diag-pflicht-list').innerHTML =
    (diagnosis.diagnose_kriterien?.pflicht_symptome || []).map(mk).join('');
  document.getElementById('diag-optional-list').innerHTML =
    (diagnosis.diagnose_kriterien?.optionale_symptome || []).map(mk).join('');
  document.getElementById('diag-komorbid-chips').innerHTML =
    (diagnosis.komorbiditaeten || []).map(k => `<span class="komorbid-chip">${k}</span>`).join('');
  document.getElementById('diag-diff-text').textContent = diagnosis.differentialdiagnose || '';
}

function updateXPPreview() {
  if (state.searchContext.selectedDiagnosis) renderDiagnosisDetail(state.searchContext.selectedDiagnosis);
}

function previewXP(diagnosis, hasComorbidity) {
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const caughtKats  = new Set(state.catches.map(c => c.kategorie));
  state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
    caughtCodes.add(d.diagnosis.code);
    caughtKats.add(d.diagnosis.kategorie);
  }));
  const base = 20 * diagnosis.seltenheit_score;
  let total  = base;
  const isFirstDiag = !caughtCodes.has(diagnosis.code);
  const isFirstKat  = !caughtKats.has(diagnosis.kategorie);
  if (isFirstKat)  total += 300;
  if (isFirstDiag) total += 150;
  let komorbidBonus = 0;
  if (hasComorbidity) { komorbidBonus = Math.round(total * 0.2); total += komorbidBonus; }
  return { base, total, isFirstDiag, isFirstKat, komorbidBonus };
}

function catchDiagnosis() {
  const { patientIndex, selectedDiagnosis, standalone } = state.searchContext;
  if (!selectedDiagnosis) return;

  const hasComorbidity = document.getElementById('komorbid-checkbox').checked;
  const caughtCodes    = new Set(state.catches.map(c => c.code));
  const caughtKats     = new Set(state.catches.map(c => c.kategorie));
  if (!standalone) {
    state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
      caughtCodes.add(d.diagnosis.code);
      caughtKats.add(d.diagnosis.kategorie);
    }));
  }
  const xpResult = calculateCatchXP(selectedDiagnosis, hasComorbidity, caughtCodes, caughtKats);

  // Adding to an existing shift's patient (from shift detail view)
  if (state.addToShiftContext) {
    saveToExistingShiftPatient(selectedDiagnosis, hasComorbidity, xpResult,
      state.addToShiftContext.shiftId, state.addToShiftContext.patientIndex);
    return;
  }

  // Adding within active shift form
  if (!standalone && patientIndex !== null) {
    state.activeShift.patients[patientIndex].diagnoses.push({
      diagnosis: selectedDiagnosis, hasComorbidity, xpEarned: xpResult.total
    });
    renderPatientDiagnoses(patientIndex, state.activeShift.patients[patientIndex]);
    closeDiagnosisModal();
    showXPPopup(xpResult.total, xpResult.bonuses);
    return;
  }

  // Standalone: offer shift assignment
  closeDiagnosisModal();
  state.pendingStandaloneCatch = { diagnosis: selectedDiagnosis, hasComorbidity, xpResult };
  openShiftAssignModal();
}

// ─── Shift Assignment (after standalone catch) ────────────────────────────────
function setupShiftAssignListeners() {
  document.getElementById('shift-assign-close').addEventListener('click', e => {
    e.stopPropagation();
    closeShiftAssignModal();
  });
  document.getElementById('shift-assign-backdrop').addEventListener('click', closeShiftAssignModal);
}

function openShiftAssignModal() {
  const today = new Date().toISOString().split('T')[0];
  const todayShift = state.shifts.find(s => s.date === today);
  const hour = new Date().getHours();
  const autoType = hour < 14 ? 'früh' : 'spät';

  const body = document.getElementById('shift-assign-body');
  body.innerHTML = '';

  if (todayShift) {
    const opt1 = document.createElement('div');
    opt1.className = 'assign-option assign-primary';
    opt1.innerHTML = `
      <div class="assign-option-title">${shiftIcon(todayShift.type)} Zum heutigen Dienst hinzufügen</div>
      <div class="assign-option-meta">${fmtDateShort(todayShift.date)} · ${shiftLabel(todayShift.type)} · ${todayShift.patientCount} Pat.</div>`;
    opt1.addEventListener('click', () => {
      closeShiftAssignModal();
      saveToTodayShift(state.pendingStandaloneCatch, todayShift.id);
    });
    body.appendChild(opt1);
  } else {
    const opt1 = document.createElement('div');
    opt1.className = 'assign-option assign-primary';
    const label = autoType === 'früh' ? '🌅 Neuen Früh-Dienst (6,5h) anlegen' : '🌇 Neuen Spät-Dienst (6,5h) anlegen';
    opt1.innerHTML = `
      <div class="assign-option-title">${label}</div>
      <div class="assign-option-meta">Dienst für heute wird automatisch erstellt</div>`;
    opt1.addEventListener('click', () => {
      closeShiftAssignModal();
      createShiftAndSaveCatch(state.pendingStandaloneCatch, autoType);
    });
    body.appendChild(opt1);
  }

  const opt2 = document.createElement('div');
  opt2.className = 'assign-option';
  opt2.innerHTML = `
    <div class="assign-option-title">💾 Standalone speichern</div>
    <div class="assign-option-meta">Diagnose ohne Dienst-Zuordnung speichern</div>`;
  opt2.addEventListener('click', () => {
    closeShiftAssignModal();
    saveStandaloneCatch(state.pendingStandaloneCatch);
  });
  body.appendChild(opt2);

  document.getElementById('shift-assign-modal').classList.remove('hidden');
}

function closeShiftAssignModal() {
  document.getElementById('shift-assign-modal').classList.add('hidden');
  // Don't discard pending – user might have accidentally closed
}

async function saveToTodayShift(pending, shiftId) {
  const { diagnosis, hasComorbidity, xpResult } = pending;
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) { await saveStandaloneCatch(pending); return; }

  // Get highest patientIndex for this shift so far
  const shiftCatches = state.catches.filter(c => c.shiftId === shiftId);
  const maxPIdx = shiftCatches.reduce((m, c) => Math.max(m, c.patientIndex ?? 0), -1);
  const newPIdx = maxPIdx + 1;

  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId,
    ageGroup: 'unbekannt', gender: 'unbekannt', patientType: 'standalone',
    patientIndex: newPIdx,
    hasComorbidity, xpEarned: xpResult.total,
    caughtAt: new Date().toISOString()
  });

  await db.shiftLogs.update(shiftId, {
    xpEarned: (shift.xpEarned || 0) + xpResult.total,
    patientCount: (shift.patientCount || 0) + 1
  });

  const newTotal = (state.profile.totalXP ?? 0) + xpResult.total;
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

  showXPPopup(xpResult.total, xpResult.bonuses);
  updateHeader();
  if (state.currentTab === 'dashboard') renderDashboard();
  else if (state.currentTab === 'dex') renderPsychoDex();
  checkLevelUp(newTotal, (state.profile.totalXP ?? 0) - xpResult.total);
}

async function createShiftAndSaveCatch(pending, shiftType) {
  const { diagnosis, hasComorbidity, xpResult } = pending;
  const today = new Date().toISOString().split('T')[0];
  const xpBase = shiftType === 'full' ? 120 : 65;
  const flameBonus = calculateFlameBonus(today);
  const shiftXP = xpBase + flameBonus + xpResult.total;

  const shiftId = await db.shiftLogs.add({
    date: today, type: shiftType,
    xpEarned: shiftXP, patientCount: 1,
    createdAt: new Date().toISOString()
  });

  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId,
    ageGroup: 'unbekannt', gender: 'unbekannt', patientType: 'erstgespraech',
    patientIndex: 0,
    hasComorbidity, xpEarned: xpResult.total,
    caughtAt: new Date().toISOString()
  });

  const oldXP  = state.profile.totalXP ?? 0;
  const newXP  = oldXP + shiftXP;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

  const bonusList = [];
  if (flameBonus > 0) bonusList.push({ label: '🔥 Flame-Bonus', xp: flameBonus });
  bonusList.push(...xpResult.bonuses);
  showXPPopup(shiftXP, bonusList);
  updateHeader();
  if (state.currentTab === 'dashboard') renderDashboard();
  checkLevelUp(newXP, oldXP);
}

async function saveStandaloneCatch(pending) {
  const { diagnosis, hasComorbidity, xpResult } = pending;
  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId: null,
    ageGroup: null, gender: null, patientType: 'standalone',
    patientIndex: null,
    hasComorbidity, xpEarned: xpResult.total,
    caughtAt: new Date().toISOString()
  });
  const oldXP  = state.profile.totalXP ?? 0;
  const newXP  = oldXP + xpResult.total;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

  showXPPopup(xpResult.total, xpResult.bonuses);
  updateHeader();
  if (state.currentTab === 'dashboard') renderDashboard();
  else if (state.currentTab === 'dex') renderPsychoDex();
  checkLevelUp(newXP, oldXP);
}

// ─── Finish Shift ─────────────────────────────────────────────────────────────
async function finishShift() {
  if (!state.activeShift) return;
  const btn = document.getElementById('btn-finish-shift');
  btn.disabled = true; btn.textContent = 'Speichern…';
  try {
    const flameBonus  = calculateFlameBonus(state.activeShift.date);
    const diagnosisXP = state.activeShift.patients.flatMap(p => p.diagnoses).reduce((s, d) => s + d.xpEarned, 0);
    const totalXP     = state.activeShift.xpBase + flameBonus + diagnosisXP;

    const shiftId = await db.shiftLogs.add({
      date: state.activeShift.date, type: state.activeShift.type,
      xpEarned: totalXP,
      patientCount: state.activeShift.patients.length,
      createdAt: new Date().toISOString()
    });

    for (let pi = 0; pi < state.activeShift.patients.length; pi++) {
      const patient = state.activeShift.patients[pi];
      for (const { diagnosis, hasComorbidity, xpEarned } of patient.diagnoses) {
        await db.caughtDiagnoses.add({
          code: diagnosis.code, name: diagnosis.name,
          kategorie: diagnosis.kategorie, shiftId,
          ageGroup: patient.ageGroup, gender: patient.gender,
          patientType: patient.patientType || 'erstgespraech',
          patientIndex: pi,
          hasComorbidity, xpEarned,
          caughtAt: new Date().toISOString()
        });
      }
    }

    const oldXP = state.profile.totalXP ?? 0;
    const newXP = oldXP + totalXP;
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
    state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
    state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

    state.activeShift = null;
    resetShiftForm();
    navigateTo('dashboard');
    updateHeader();

    const bonusList = [];
    if (flameBonus > 0) bonusList.push({ label: '🔥 Flame-Bonus (24h)', xp: flameBonus });
    showXPPopup(totalXP, bonusList);
    checkLevelUp(newXP, oldXP);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Dienst abschließen ✓';
  }
}

function checkLevelUp(newXP, oldXP) {
  const newRank = getRankForXP(newXP);
  if (getRankForXP(oldXP).level < newRank.level)
    setTimeout(() => showLevelUpModal(newRank), 1800);
}

// ─── XP Popup ─────────────────────────────────────────────────────────────────
function showXPPopup(xp, bonuses = []) {
  const popup = document.getElementById('xp-popup');
  const text  = document.getElementById('xp-popup-text');
  let html = `<span class="popup-main">+${xp} XP</span>`;
  bonuses.forEach(b => { html += `<span class="popup-bonus">${b.label}: +${b.xp}</span>`; });
  text.innerHTML = html;
  popup.classList.remove('hidden', 'popup-hide');
  popup.classList.add('popup-show');
  clearTimeout(popup._timer);
  popup._timer = setTimeout(() => {
    popup.classList.replace('popup-show', 'popup-hide');
    setTimeout(() => popup.classList.add('hidden'), 400);
  }, 2800);
}

// ─── Level Up ─────────────────────────────────────────────────────────────────
function setupLevelupListeners() {
  document.getElementById('levelup-close').addEventListener('click', () =>
    document.getElementById('levelup-modal').classList.add('hidden'));
}

function showLevelUpModal(rank) {
  document.getElementById('levelup-rank-name').textContent     = rank.title;
  document.getElementById('levelup-rank-subtitle').textContent  = rank.subtitle;
  document.getElementById('levelup-rank-level').textContent    = `Rang ${rank.level}`;
  document.getElementById('levelup-modal').classList.remove('hidden');
}

// ─── PsychoDex ────────────────────────────────────────────────────────────────
function renderPsychoDex() {
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const total  = state.icdFlat.length;
  const caught = state.icdFlat.filter(d => caughtCodes.has(d.code)).length;
  document.getElementById('dex-caught-count').textContent = caught;
  document.getElementById('dex-total-count').textContent  = total;
  document.getElementById('dex-progress-fill').style.width = total ? `${(caught/total)*100}%` : '0%';

  const gridEl = document.getElementById('category-grid');
  gridEl.innerHTML = (state.icdIndex?.categories || []).map(cat => {
    const diags     = state.icdData[cat.code] || [];
    const catCaught = diags.filter(d => caughtCodes.has(d.code)).length;
    const catTotal  = diags.length;
    const pct       = catTotal ? Math.round((catCaught / catTotal) * 100) : 0;
    return `
      <div class="category-card" data-cat="${cat.code}" style="--cat-color:${cat.color}">
        <div class="cat-bg" style="background-image:url('assets/images/categories/${cat.code.toLowerCase()}.png')"></div>
        <div class="cat-overlay"></div>
        <div class="cat-content">
          <div class="cat-emoji">${cat.emoji}</div>
          <div class="cat-label">${cat.label}</div>
          <div class="cat-name">${cat.name}</div>
          <div class="cat-stats">
            <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%"></div></div>
            <span class="cat-count">${catCaught}/${catTotal}</span>
          </div>
        </div>
      </div>`;
  }).join('');
  gridEl.querySelectorAll('.category-card').forEach(card =>
    card.addEventListener('click', () => openCategoryModal(card.dataset.cat)));
}

// ─── Category Modal ───────────────────────────────────────────────────────────
function setupCategoryModalListeners() {
  document.getElementById('modal-close').addEventListener('click', e => {
    e.stopPropagation();
    closeCategoryModal();
  });
  document.getElementById('modal-backdrop').addEventListener('click', closeCategoryModal);
}

function openCategoryModal(catCode) {
  const diags       = state.icdData[catCode] || [];
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const catInfo     = state.icdIndex?.categories.find(c => c.code === catCode);
  document.getElementById('modal-category-title').textContent =
    catInfo ? `${catInfo.emoji} ${catInfo.label} – ${catInfo.name}` : catCode;
  const listEl = document.getElementById('modal-diagnoses-list');
  listEl.innerHTML = diags.length
    ? diags.map(d => {
        const caught = caughtCodes.has(d.code);
        const stars  = '★'.repeat(d.seltenheit_score) + '☆'.repeat(10 - d.seltenheit_score);
        return `
          <div class="diag-list-item ${caught ? 'is-caught' : ''}" data-code="${d.code}">
            <div class="diag-list-left">
              <span class="diag-list-code">${d.code}</span>
              <div>
                <div class="diag-list-name">${d.name}</div>
                <div class="diag-list-rarity">${stars}</div>
              </div>
            </div>
            <div class="diag-list-status">${caught ? '✓' : '🔬'}</div>
          </div>`;
      }).join('')
    : '<div class="empty-state">Keine Diagnosen für diese Kategorie.</div>';

  listEl.querySelectorAll('.diag-list-item:not(.is-caught)').forEach(item => {
    item.addEventListener('click', () => {
      const diag = state.icdFlat.find(d => d.code === item.dataset.code);
      if (diag) { closeCategoryModal(); openStandaloneCatch(diag); }
    });
  });
  document.getElementById('category-modal').classList.remove('hidden');
}

function closeCategoryModal() {
  document.getElementById('category-modal').classList.add('hidden');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const xp     = state.profile?.totalXP ?? 0;
  const shifts = state.shifts.length;
  const hours  = parseFloat(state.shifts.reduce((s, sh) => s + (sh.type === 'full' ? 12 : 6.5), 0).toFixed(1));
  const avgXP  = shifts ? Math.round(xp / shifts) : 0;
  document.getElementById('stat-total-xp').textContent     = xp.toLocaleString('de-AT');
  document.getElementById('stat-total-shifts').textContent  = shifts;
  document.getElementById('stat-avg-xp').textContent        = avgXP;
  document.getElementById('stat-hours').textContent         = `${hours}h`;
  renderHeatmap();
  renderCategoryChart();
}

function renderHeatmap() {
  const el    = document.getElementById('heatmap');
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const WEEKS = 52;
  const shiftSet = new Set(state.shifts.map(s => s.date));
  const start = new Date(today);
  start.setDate(start.getDate() - WEEKS * 7 + 1);
  let html = '';
  for (let w = 0; w < WEEKS; w++) {
    html += '<div class="heatmap-col">';
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      const ds = date.toISOString().split('T')[0];
      const cls = ['heatmap-cell', shiftSet.has(ds) ? 'hm-active' : '',
        ds === todayStr ? 'hm-today' : '', date > today ? 'hm-future' : ''].filter(Boolean).join(' ');
      html += `<div class="${cls}" title="${ds}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.heatmap-cell.hm-active').forEach(cell =>
    cell.addEventListener('click', () => showHeatmapDetail(cell.title)));
}

function showHeatmapDetail(dateStr) {
  const detail = document.getElementById('heatmap-detail');
  const shift  = state.shifts.find(s => s.date === dateStr);
  if (!shift) { detail.classList.add('hidden'); return; }
  const catches = state.catches.filter(c => c.shiftId === shift.id);
  detail.innerHTML = `
    <span>${shiftIcon(shift.type)}</span>
    <span><strong>${fmtDateShort(shift.date)}</strong> · ${shiftLabel(shift.type)} · +${shift.xpEarned} XP · ${shift.patientCount} Pat.</span>
    ${catches.length ? `<span style="color:var(--success)">${catches.length} Diagnosen: ${catches.map(c=>c.code).join(', ')}</span>` : ''}
    <span class="heatmap-detail-close" id="hd-close">✕</span>`;
  detail.classList.remove('hidden');
  detail.querySelector('#hd-close').addEventListener('click', () => detail.classList.add('hidden'));
}

function renderCategoryChart() {
  const el   = document.getElementById('category-chart');
  const cats = Object.keys(state.icdData);
  if (!cats.length) { el.innerHTML = '<div class="empty-state">Keine Daten.</div>'; return; }
  const byKat = {};
  state.catches.forEach(c => { byKat[c.kategorie] = (byKat[c.kategorie] || 0) + 1; });
  const maxVal = Math.max(...Object.values(byKat), 1);
  el.innerHTML = cats.map(cat => {
    const count = byKat[cat] || 0;
    const total = (state.icdData[cat] || []).length;
    const pct   = Math.round((count / maxVal) * 100);
    return `
      <div class="chart-row" data-cat="${cat}">
        <div class="chart-label">${cat}</div>
        <div class="chart-track"><div class="chart-fill" style="width:${pct}%"></div></div>
        <div class="chart-count">${count}/${total}</div>
      </div>`;
  }).join('');
  el.querySelectorAll('.chart-row').forEach(row =>
    row.addEventListener('click', () => openCategoryModal(row.dataset.cat)));
}

// ─── Delete Catch ─────────────────────────────────────────────────────────────
async function deleteCatch(catchId) {
  const c = state.catches.find(x => x.id === catchId);
  if (!c) return;
  if (!confirm(`Diagnose "${c.code} – ${c.name}" wirklich löschen?\n−${c.xpEarned} XP werden abgezogen.`)) return;
  await db.caughtDiagnoses.delete(catchId);
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - c.xpEarned);
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  renderDashboard();
  updateHeader();
}

// ─── Edit Shift Modal ─────────────────────────────────────────────────────────
function setupEditShiftListeners() {
  document.getElementById('edit-shift-close').addEventListener('click', e => {
    e.stopPropagation();
    closeEditShiftModal();
  });
  document.getElementById('edit-shift-backdrop').addEventListener('click', closeEditShiftModal);
  document.getElementById('edit-type-selector').querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('edit-type-selector').querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('btn-save-edit-shift').addEventListener('click', saveEditShift);
}

function openEditShiftModal(shiftId) {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  state.editingShiftId = shiftId;
  document.getElementById('edit-shift-date').value = shift.date;
  document.getElementById('edit-type-selector').querySelectorAll('.type-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.type === shift.type ||
      (btn.dataset.type === 'früh' && !['spät','full'].includes(shift.type))));
  document.getElementById('edit-shift-modal').classList.remove('hidden');
}

function closeEditShiftModal() {
  document.getElementById('edit-shift-modal').classList.add('hidden');
  state.editingShiftId = null;
}

async function saveEditShift() {
  const shift = state.shifts.find(s => s.id === state.editingShiftId);
  if (!shift) return;
  const newDate = document.getElementById('edit-shift-date').value;
  const newType = document.getElementById('edit-type-selector').querySelector('.type-btn.active')?.dataset.type || shift.type;
  const oldBase = shift.type === 'full' ? 120 : 65;
  const newBase = newType === 'full' ? 120 : 65;
  const xpDelta = newBase - oldBase;
  await db.shiftLogs.update(state.editingShiftId, { date: newDate, type: newType, xpEarned: shift.xpEarned + xpDelta });
  if (xpDelta !== 0) {
    const newTotal = (state.profile.totalXP ?? 0) + xpDelta;
    await db.profile.update(state.profile.id, { totalXP: newTotal });
    state.profile.totalXP = newTotal;
  }
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  closeEditShiftModal();
  renderDashboard();
  updateHeader();
}

// ─── Shift Detail Modal ───────────────────────────────────────────────────────
function setupShiftDetailListeners() {
  document.getElementById('shift-detail-close').addEventListener('click', e => {
    e.stopPropagation();
    closeShiftDetailModal();
  });
  document.getElementById('shift-detail-backdrop').addEventListener('click', closeShiftDetailModal);
}

function openShiftDetailModal(shiftId) {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  document.getElementById('shift-detail-title').textContent =
    `${shiftIcon(shift.type)} ${fmtDateShort(shift.date)}`;
  renderShiftDetailBody(shift);
  document.getElementById('shift-detail-modal').classList.remove('hidden');
}

function renderShiftDetailBody(shift) {
  const body = document.getElementById('shift-detail-body');
  const shiftCatches = state.catches.filter(c => c.shiftId === shift.id);

  // Group by patientIndex (or fallback to demo combo)
  const patientMap = new Map();
  shiftCatches.forEach(c => {
    const key = c.patientIndex != null ? c.patientIndex : `${c.ageGroup}-${c.gender}-${c.patientType}`;
    if (!patientMap.has(key)) {
      patientMap.set(key, {
        ageGroup: c.ageGroup || '?', gender: c.gender || '?',
        patientType: c.patientType || 'erstgespraech', catches: [], index: key
      });
    }
    patientMap.get(key).catches.push(c);
  });

  let html = `
    <div class="shift-detail-header">
      <div class="shift-detail-info">
        <div class="shift-detail-date">${shiftIcon(shift.type)} ${fmtDateShort(shift.date)} · ${shiftLabel(shift.type)}</div>
        <div class="shift-detail-meta">+${shift.xpEarned} XP · ${shift.patientCount} Patient(en)</div>
      </div>
      <button class="btn-icon" id="btn-edit-this-shift" data-id="${shift.id}" title="Bearbeiten">✎</button>
    </div>`;

  if (patientMap.size === 0) {
    html += '<div class="empty-state">Keine Diagnosen für diesen Dienst.</div>';
  }

  let pNum = 1;
  for (const [, p] of patientMap) {
    const demoLabel = `${p.ageGroup} J · ${p.gender} · ${p.patientType === 'erstgespraech' ? 'Erstgespräch' : 'Interview'}`;
    html += `<div class="patient-section" data-pkey="${p.index}">
      <div class="patient-section-header">
        <div>
          <div class="patient-section-label">Patient ${pNum}</div>
          <div class="patient-section-demo">${demoLabel}</div>
        </div>
        <button class="btn-icon btn-edit-patient-demo" data-pkey="${p.index}" title="Demografik bearbeiten">✎</button>
      </div>
      <div class="patient-diags" id="pdiags-${shift.id}-${p.index}">`;

    p.catches.forEach(c => {
      html += `<div class="patient-diag-row">
        <span class="pd-code">${c.code}</span>
        <span class="pd-name">${c.name}</span>
        <span class="pd-xp">+${c.xpEarned} XP</span>
        <button class="btn-icon btn-delete-shift-catch" data-id="${c.id}" title="Diagnose löschen">🗑</button>
      </div>`;
    });

    html += `</div>
      <button class="patient-section-add btn-add-diag-to-patient" data-shiftid="${shift.id}" data-pkey="${p.index}">+ Diagnose hinzufügen</button>
    </div>`;
    pNum++;
  }

  // Add new patient section
  html += `<button class="patient-section-add" id="btn-add-new-patient-to-shift" data-shiftid="${shift.id}"
    style="display:block;width:100%;padding:12px;border:1px dashed rgba(124,58,237,.3);border-radius:var(--r);color:var(--accent);margin-top:8px">
    + Neuer Patient & Diagnose
  </button>
  <button class="btn-danger" id="btn-delete-this-shift" data-id="${shift.id}">🗑 Dienst löschen</button>`;

  body.innerHTML = html;

  // Wire up buttons
  body.querySelector('#btn-edit-this-shift')?.addEventListener('click', e => {
    e.stopPropagation();
    closeShiftDetailModal();
    openEditShiftModal(parseInt(e.currentTarget.dataset.id));
  });

  body.querySelectorAll('.btn-delete-shift-catch').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteShiftCatch(parseInt(btn.dataset.id), shift);
    });
  });

  body.querySelectorAll('.btn-add-diag-to-patient').forEach(btn => {
    btn.addEventListener('click', () => {
      const pkey = btn.dataset.pkey;
      closeShiftDetailModal();
      openAddToShiftDiagSearch(shift.id, pkey);
    });
  });

  body.querySelector('#btn-add-new-patient-to-shift')?.addEventListener('click', () => {
    closeShiftDetailModal();
    openAddToShiftDiagSearch(shift.id, null);
  });

  body.querySelector('#btn-delete-this-shift')?.addEventListener('click', () =>
    deleteShift(parseInt(body.querySelector('#btn-delete-this-shift').dataset.id)));

  // Patient demo edit buttons
  body.querySelectorAll('.btn-edit-patient-demo').forEach(btn => {
    btn.addEventListener('click', () => togglePatientEditRow(btn.dataset.pkey, shift.id, patientMap));
  });
}

function togglePatientEditRow(pkey, shiftId, patientMap) {
  const p = patientMap.get(isNaN(pkey) ? pkey : parseInt(pkey));
  if (!p) return;
  const existingRow = document.getElementById(`edit-row-${pkey}`);
  if (existingRow) { existingRow.remove(); return; }
  const section = document.querySelector(`.patient-section[data-pkey="${pkey}"]`);
  if (!section) return;
  const row = document.createElement('div');
  row.className = 'patient-edit-row';
  row.id = `edit-row-${pkey}`;
  row.innerHTML = `
    <select class="demo-select-sm" data-field="ageGroup">
      ${['18-30','31-50','51+'].map(v => `<option ${p.ageGroup===v?'selected':''}>${v}</option>`).join('')}
    </select>
    <select class="demo-select-sm" data-field="gender">
      ${['weiblich','männlich','divers'].map(v => `<option ${p.gender===v?'selected':''}>${v}</option>`).join('')}
    </select>
    <select class="demo-select-sm" data-field="patientType">
      <option value="erstgespraech" ${p.patientType==='erstgespraech'?'selected':''}>Erstgesp.</option>
      <option value="interview" ${p.patientType==='interview'?'selected':''}>Interview</option>
    </select>`;
  section.querySelector('.patient-section-header').after(row);
  row.querySelectorAll('.demo-select-sm').forEach(sel => {
    sel.addEventListener('change', async () => {
      const field = sel.dataset.field;
      const val   = sel.value;
      p[field] = val;
      // Update all catches of this patient
      for (const c of p.catches) {
        await db.caughtDiagnoses.update(c.id, { [field]: val });
      }
      state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
    });
  });
}

async function deleteShiftCatch(catchId, shift) {
  const c = state.catches.find(x => x.id === catchId);
  if (!c) return;
  if (!confirm(`Diagnose "${c.code}" aus diesem Dienst löschen?\n−${c.xpEarned} XP werden abgezogen.`)) return;
  await db.caughtDiagnoses.delete(catchId);
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - c.xpEarned);
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  await db.shiftLogs.update(shift.id, { xpEarned: Math.max(0, (shift.xpEarned || 0) - c.xpEarned) });
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  updateHeader();
  // Re-render shift detail
  const updatedShift = state.shifts.find(s => s.id === shift.id);
  if (updatedShift) renderShiftDetailBody(updatedShift);
}

async function deleteShift(shiftId) {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  if (!confirm(`Dienst vom ${fmtDateShort(shift.date)} wirklich löschen?\nAlle verknüpften Diagnosen und XP werden entfernt.`)) return;
  const shiftCatches = state.catches.filter(c => c.shiftId === shiftId);
  const diagXP = shiftCatches.reduce((s, c) => s + (c.xpEarned || 0), 0);
  for (const c of shiftCatches) await db.caughtDiagnoses.delete(c.id);
  await db.shiftLogs.delete(shiftId);
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - shift.xpEarned);
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  closeShiftDetailModal();
  renderDashboard();
  updateHeader();
}

function closeShiftDetailModal() {
  document.getElementById('shift-detail-modal').classList.add('hidden');
}

async function saveToExistingShiftPatient(diagnosis, hasComorbidity, xpResult, shiftId, patientKey) {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  const shiftCatches = state.catches.filter(c => c.shiftId === shiftId);

  let ageGroup = 'unbekannt', gender = 'unbekannt', patientType = 'erstgespraech';
  let patientIndex;

  if (patientKey != null) {
    // Find patient data from existing catches
    const patientCatches = shiftCatches.filter(c =>
      (c.patientIndex != null ? String(c.patientIndex) : `${c.ageGroup}-${c.gender}-${c.patientType}`) === String(patientKey));
    if (patientCatches.length) {
      ageGroup = patientCatches[0].ageGroup;
      gender   = patientCatches[0].gender;
      patientType = patientCatches[0].patientType;
      patientIndex = patientCatches[0].patientIndex ?? patientKey;
    }
  } else {
    // New patient
    const maxPIdx = shiftCatches.reduce((m, c) => Math.max(m, c.patientIndex ?? 0), -1);
    patientIndex = maxPIdx + 1;
  }

  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId,
    ageGroup, gender, patientType,
    patientIndex: patientIndex ?? 0,
    hasComorbidity, xpEarned: xpResult.total,
    caughtAt: new Date().toISOString()
  });

  const newShiftXP = (shift.xpEarned || 0) + xpResult.total;
  const newPatCount = patientKey == null ? (shift.patientCount || 0) + 1 : shift.patientCount;
  await db.shiftLogs.update(shiftId, { xpEarned: newShiftXP, patientCount: newPatCount });

  const oldXP = state.profile.totalXP ?? 0;
  const newXP = oldXP + xpResult.total;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

  showXPPopup(xpResult.total, xpResult.bonuses);
  updateHeader();
  if (state.currentTab === 'dashboard') renderDashboard();
  checkLevelUp(newXP, oldXP);

  // Re-open shift detail
  const updatedShift = state.shifts.find(s => s.id === shiftId);
  if (updatedShift) openShiftDetailModal(shiftId);
}

// ─── Symptom Finder ───────────────────────────────────────────────────────────
function setupSymptomFinderListeners() {
  document.getElementById('symptom-finder-close').addEventListener('click', e => {
    e.stopPropagation();
    closeSymptomFinder();
  });
  document.getElementById('symptom-finder-backdrop').addEventListener('click', closeSymptomFinder);
  document.getElementById('symptom-search-input').addEventListener('input', onSymptomSearch);
}

function openSymptomFinder() {
  state.symptomSelected = [];
  document.getElementById('symptom-search-input').value = '';
  renderSymptomChips();
  document.getElementById('symptom-search-results').innerHTML = '';
  document.getElementById('symptom-diag-header').style.display = 'none';
  document.getElementById('symptom-diag-list').innerHTML = '';
  document.getElementById('symptom-finder-modal').classList.remove('hidden');
  document.getElementById('symptom-search-input').focus();
}

function closeSymptomFinder() {
  document.getElementById('symptom-finder-modal').classList.add('hidden');
}

function getAllSymptoms() {
  const set = new Set();
  state.icdFlat.forEach(d => {
    (d.diagnose_kriterien?.pflicht_symptome || []).forEach(s => set.add(s));
    (d.diagnose_kriterien?.optionale_symptome || []).forEach(s => set.add(s));
  });
  return [...set];
}

function onSymptomSearch(e) {
  const q = e.target.value.trim().toLowerCase();
  const resultEl = document.getElementById('symptom-search-results');
  if (q.length < 2) { resultEl.innerHTML = ''; return; }

  const allSymptoms = getAllSymptoms();
  const matches = allSymptoms.filter(s =>
    s.toLowerCase().includes(q) && !state.symptomSelected.includes(s)
  ).slice(0, 12);

  if (!matches.length) {
    resultEl.innerHTML = '<div class="no-results">Kein passendes Symptom gefunden</div>';
    return;
  }

  resultEl.innerHTML = matches.map(s => {
    const idx = s.toLowerCase().indexOf(q);
    const highlighted = idx >= 0
      ? s.slice(0, idx) + '<mark>' + s.slice(idx, idx + q.length) + '</mark>' + s.slice(idx + q.length)
      : s;
    return `<div class="symptom-match-item" data-symptom="${s.replace(/"/g,'&quot;')}">${highlighted}</div>`;
  }).join('');

  resultEl.querySelectorAll('.symptom-match-item').forEach(item => {
    item.addEventListener('click', () => {
      selectSymptom(item.dataset.symptom);
      document.getElementById('symptom-search-input').value = '';
      resultEl.innerHTML = '';
      document.getElementById('symptom-search-input').focus();
    });
  });
}

function selectSymptom(symptom) {
  if (!state.symptomSelected.includes(symptom)) {
    state.symptomSelected.push(symptom);
    renderSymptomChips();
    scoreAndRenderDiagSuggestions();
  }
}

function removeSymptom(symptom) {
  state.symptomSelected = state.symptomSelected.filter(s => s !== symptom);
  renderSymptomChips();
  scoreAndRenderDiagSuggestions();
}

function renderSymptomChips() {
  const el = document.getElementById('symptom-selected-chips');
  el.innerHTML = state.symptomSelected.map(s => `
    <div class="symptom-chip" data-symptom="${s.replace(/"/g,'&quot;')}">
      <span>${s.length > 35 ? s.slice(0,33)+'…' : s}</span>
      <span class="symptom-chip-x">✕</span>
    </div>`).join('');
  el.querySelectorAll('.symptom-chip').forEach(chip =>
    chip.addEventListener('click', () => removeSymptom(chip.dataset.symptom)));
}

function scoreAndRenderDiagSuggestions() {
  const header = document.getElementById('symptom-diag-header');
  const listEl = document.getElementById('symptom-diag-list');

  if (!state.symptomSelected.length) {
    header.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  const selectedLower = state.symptomSelected.map(s => s.toLowerCase());

  const scored = state.icdFlat.map(d => {
    const allS = [
      ...(d.diagnose_kriterien?.pflicht_symptome || []),
      ...(d.diagnose_kriterien?.optionale_symptome || [])
    ];
    const totalS = allS.length;
    if (!totalS) return null;
    let matchCount = 0;
    for (const sel of selectedLower) {
      if (allS.some(s => s.toLowerCase().includes(sel) || sel.includes(s.toLowerCase().substring(0, 8)))) {
        matchCount++;
      }
    }
    if (!matchCount) return null;
    const score = matchCount / selectedLower.length;
    return { d, matchCount, totalS, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 10);

  if (!scored.length) {
    listEl.innerHTML = '<div class="empty-state">Keine passenden Diagnosen gefunden.</div>';
    header.style.display = '';
    return;
  }

  header.style.display = '';
  const caughtCodes = new Set(state.catches.map(c => c.code));

  listEl.innerHTML = scored.map(({ d, matchCount, score }) => {
    const pct  = Math.round(score * 100);
    const caught = caughtCodes.has(d.code);
    return `
      <div class="symptom-diag-item" data-code="${d.code}">
        <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0;align-items:center;width:48px">
          <div class="symptom-diag-score-bar">
            <div class="symptom-diag-score-fill" style="width:${pct}%"></div>
          </div>
          <div class="symptom-diag-score-pct">${pct}%</div>
        </div>
        <div class="symptom-diag-info">
          <div class="symptom-diag-code">${d.code} · ★${d.seltenheit_score}</div>
          <div class="symptom-diag-name">${d.name}</div>
        </div>
        ${caught
          ? '<span style="font-size:11px;color:var(--success)">✓</span>'
          : `<button class="symptom-diag-catch" data-code="${d.code}">Fangen</button>`}
      </div>`;
  }).join('');

  listEl.querySelectorAll('.symptom-diag-catch').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const diag = state.icdFlat.find(d => d.code === btn.dataset.code);
      if (diag) { closeSymptomFinder(); openStandaloneCatch(diag); }
    });
  });

  listEl.querySelectorAll('.symptom-diag-item').forEach(item => {
    item.addEventListener('click', () => {
      const diag = state.icdFlat.find(d => d.code === item.dataset.code);
      if (diag) { closeSymptomFinder(); openStandaloneCatch(diag); }
    });
  });
}

// ─── Hours Modal ──────────────────────────────────────────────────────────────
function setupHoursModalListeners() {
  document.getElementById('hours-modal-close').addEventListener('click', e => {
    e.stopPropagation();
    closeHoursModal();
  });
  document.getElementById('hours-backdrop').addEventListener('click', closeHoursModal);
}

function openHoursModal() {
  const body = document.getElementById('hours-modal-body');
  const totalHours = state.shifts.reduce((s, sh) => s + (sh.type === 'full' ? 12 : 6.5), 0);
  const totalFrueh = state.shifts.filter(s => s.type === 'früh').length;
  const totalSpat  = state.shifts.filter(s => s.type === 'spät').length;
  const totalFull  = state.shifts.filter(s => s.type === 'full').length;

  body.innerHTML = `
    <div class="hours-summary">
      <div>
        <div class="hours-total">${totalHours.toFixed(1).replace('.0','')}h</div>
        <div class="hours-label">Gesamt</div>
      </div>
      <div style="text-align:right;font-size:12px;color:var(--text-dim);line-height:1.8">
        <div>🌅 Früh: ${totalFrueh}× (${(totalFrueh*6.5).toFixed(1).replace('.0','')}h)</div>
        <div>🌇 Spät: ${totalSpat}× (${(totalSpat*6.5).toFixed(1).replace('.0','')}h)</div>
        <div>☀️ Ganztags: ${totalFull}× (${totalFull*12}h)</div>
      </div>
    </div>
    <div class="hours-list">
      ${state.shifts.map(s => `
        <div class="hours-row" data-id="${s.id}">
          <div class="hours-row-icon">${shiftIcon(s.type)}</div>
          <div class="hours-row-info">
            <div class="hours-row-date">${fmtDateShort(s.date)}</div>
            <div class="hours-row-meta">${shiftLabel(s.type)} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
          <div class="hours-row-val">${s.type === 'full' ? '12h' : '6,5h'}</div>
        </div>`).join('')}
    </div>`;

  body.querySelectorAll('.hours-row').forEach(row => {
    row.addEventListener('click', () => {
      closeHoursModal();
      openShiftDetailModal(parseInt(row.dataset.id));
    });
  });

  document.getElementById('hours-modal').classList.remove('hidden');
}

function closeHoursModal() {
  document.getElementById('hours-modal').classList.add('hidden');
}

// ─── Catches Modal ────────────────────────────────────────────────────────────
function setupCatchesModalListeners() {
  document.getElementById('catches-modal-close').addEventListener('click', e => {
    e.stopPropagation();
    closeCatchesModal();
  });
  document.getElementById('catches-backdrop').addEventListener('click', closeCatchesModal);
}

function openCatchesModal() {
  renderCatchesModalBody();
  document.getElementById('catches-modal').classList.remove('hidden');
}

function renderCatchItem(c) {
  return `
    <div class="catch-detail-item">
      <div class="catch-detail-top">
        <span class="catch-detail-code">${c.code}</span>
        <span class="catch-detail-name">${c.name}</span>
        <span class="catch-detail-xp">+${c.xpEarned} XP</span>
        <button class="btn-icon btn-delete-catch-modal" data-id="${c.id}" title="Löschen">🗑</button>
      </div>
      <div class="catch-detail-meta">
        <span class="catch-detail-tag">${fmtDate(c.caughtAt)}</span>
        ${c.ageGroup ? `<span class="catch-detail-tag">${c.ageGroup} J</span>` : ''}
        ${c.gender ? `<span class="catch-detail-tag">${c.gender}</span>` : ''}
        ${c.patientType ? `<span class="catch-detail-tag">${c.patientType === 'erstgespraech' ? 'Erstgesp.' : c.patientType}</span>` : ''}
        ${c.hasComorbidity ? '<span class="catch-detail-tag" style="color:var(--accent-blue)">Komorbid ✓</span>' : ''}
      </div>
    </div>`;
}

function renderCatchesModalBody() {
  const body = document.getElementById('catches-modal-body');
  if (!state.catches.length) {
    body.innerHTML = '<div class="empty-state">Noch keine Diagnosen gefangen.</div>';
    return;
  }

  let sorted = [...state.catches];
  if (state.catchesSort === 'alpha') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  } else if (state.catchesSort === 'category') {
    sorted.sort((a, b) => (a.kategorie || '').localeCompare(b.kategorie || '') || a.code.localeCompare(b.code));
  }

  const isCatView = state.catchesSort === 'category';
  let listHTML = '';
  if (isCatView) {
    const groups = {};
    sorted.forEach(c => { const k = c.kategorie || '?'; if (!groups[k]) groups[k] = []; groups[k].push(c); });
    listHTML = Object.entries(groups).map(([cat, catches]) =>
      `<div class="catch-cat-header">${cat}</div>${catches.map(renderCatchItem).join('')}`
    ).join('');
  } else {
    listHTML = sorted.map(renderCatchItem).join('');
  }

  body.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">
      ${state.catches.length} Diagnosen · ${new Set(state.catches.map(c=>c.kategorie)).size} Kategorien
    </div>
    <div class="sort-bar">
      <button class="sort-btn ${state.catchesSort==='chrono'?'active':''}" data-sort="chrono">🕐 Neueste</button>
      <button class="sort-btn ${state.catchesSort==='alpha'?'active':''}" data-sort="alpha">A–Z</button>
      <button class="sort-btn ${state.catchesSort==='category'?'active':''}" data-sort="category">📂 Kategorie</button>
    </div>
    <div class="catches-list">${listHTML}</div>`;

  body.querySelectorAll('.sort-btn').forEach(btn =>
    btn.addEventListener('click', () => { state.catchesSort = btn.dataset.sort; renderCatchesModalBody(); }));
  body.querySelectorAll('.btn-delete-catch-modal').forEach(btn =>
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteCatch(parseInt(btn.dataset.id));
      renderCatchesModalBody();
    }));
}

function closeCatchesModal() {
  document.getElementById('catches-modal').classList.add('hidden');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtDate = iso =>
  new Date(iso).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'2-digit' });

const fmtDateShort = ds =>
  new Date(ds).toLocaleDateString('de-AT', { weekday:'short', day:'2-digit', month:'2-digit' });

const shiftIcon  = t => t === 'full' ? '☀️' : t === 'spät' ? '🌇' : '🌅';
const shiftLabel = t => t === 'full' ? 'Ganztags 12h' : t === 'spät' ? 'Spät 6,5h' : 'Früh 6,5h';

// ─── Export / Import ──────────────────────────────────────────────────────────
function setupExportImport() {
  document.getElementById('btn-export')?.addEventListener('click', exportData);
  document.getElementById('import-file-input')?.addEventListener('change', importData);
}

async function exportData() {
  const shifts  = await db.shiftLogs.toArray();
  const catches = await db.caughtDiagnoses.toArray();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profile:  { totalXP: state.profile?.totalXP ?? 0 },
    shifts:   shifts.map(({ id, ...s }) => s),
    catches:  catches.map(({ id, ...c }) => c)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `psychodex-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version || !Array.isArray(data.shifts) || !Array.isArray(data.catches)) {
      alert('Ungültige Backup-Datei.');
      return;
    }
    if (!confirm(`Alle aktuellen Daten werden ersetzt.\n${data.shifts.length} Dienste, ${data.catches.length} Diagnosen werden importiert.\n\nFortfahren?`)) return;

    await db.profile.clear();
    await db.shiftLogs.clear();
    await db.caughtDiagnoses.clear();
    await db.profile.add({ totalXP: data.profile?.totalXP ?? 0, createdAt: new Date().toISOString() });
    for (const s of data.shifts)  await db.shiftLogs.add(s);
    for (const c of data.catches) await db.caughtDiagnoses.add(c);

    await loadFromDB();
    renderApp();
    alert(`Import erfolgreich: ${data.shifts.length} Dienste, ${data.catches.length} Diagnosen geladen.`);
    navigateTo('stats');
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
  e.target.value = '';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
