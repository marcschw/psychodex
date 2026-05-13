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
  searchContext: { patientIndex: null, selectedDiagnosis: null },
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

  const timeout = setTimeout(() => showError('Laden dauert zu lange – mögliche Ursache: IndexedDB blockiert oder Netzwerkfehler.'), 12000);

  try {
    if (typeof Dexie === 'undefined') throw new Error('Dexie nicht geladen – bitte neu laden.');
    await Promise.all([loadAllICD(state), loadICDIndex()]);
    await loadFromDB();
    clearTimeout(timeout);
    renderApp();
    setupNav();
    setupShiftListeners();
    setupDiagnosisModalListeners();
    setupLevelupListeners();
    setupCategoryModalListeners();
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
  const xp    = state.profile?.totalXP ?? 0;
  const rank  = getRankForXP(xp);
  const next  = getNextRank(rank.level);
  const pct   = next
    ? ((xp - rank.xpRequired) / (next.xpRequired - rank.xpRequired)) * 100
    : 100;

  document.getElementById('header-rank-name').textContent = `${rank.title} ${rank.subtitle}`;
  document.getElementById('header-level').textContent = `Rang ${rank.level}`;
  document.getElementById('header-xp-fill').style.width = `${Math.min(100, pct)}%`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const xp   = state.profile?.totalXP ?? 0;
  const rank = getRankForXP(xp);
  const next = getNextRank(rank.level);
  const pct  = next
    ? ((xp - rank.xpRequired) / (next.xpRequired - rank.xpRequired)) * 100
    : 100;

  document.getElementById('rank-title').textContent    = rank.title;
  document.getElementById('rank-subtitle').textContent = rank.subtitle;
  document.getElementById('rank-level').textContent    = `Rang ${rank.level} / 18`;
  document.getElementById('xp-current').textContent    = xp.toLocaleString('de-AT');
  document.getElementById('xp-needed').textContent     = next ? next.xpRequired.toLocaleString('de-AT') : '∞';
  document.getElementById('xp-bar-fill').style.width   = `${Math.min(100, Math.max(0, pct))}%`;
  const pctEl = document.getElementById('xp-pct');
  if (pctEl) pctEl.textContent = `${Math.round(Math.min(100, pct))}%`;
  document.getElementById('rank-card-bg').style.backgroundImage =
    `url('assets/images/ranks/${rank.title.toLowerCase()}.jpg')`;

  const streak = calcStreak(state.shifts);
  document.getElementById('streak-icon').textContent  = streak.frozen ? '🧊' : '🔥';
  document.getElementById('streak-value').textContent = streak.count;
  const totalHours = state.shifts.reduce((s, sh) => s + (sh.type === 'full' ? 12 : 6.5), 0);
  document.getElementById('total-hours').textContent  = `${totalHours}h`;
  document.getElementById('total-catches').textContent = state.catches.length;

  const catchEl = document.getElementById('recent-catches');
  catchEl.innerHTML = state.catches.length
    ? state.catches.slice(0, 5).map(c => `
        <div class="recent-item">
          <div class="recent-code">${c.code}</div>
          <div class="recent-info">
            <div class="recent-name">${c.name}</div>
            <div class="recent-meta">+${c.xpEarned} XP · ${fmtDate(c.caughtAt)}</div>
          </div>
          <div class="catch-badge">✓</div>
        </div>`).join('')
    : '<div class="empty-state">Noch keine Diagnosen – starte deinen ersten Dienst!</div>';

  const shiftEl = document.getElementById('recent-shifts');
  shiftEl.innerHTML = state.shifts.length
    ? state.shifts.slice(0, 3).map(s => `
        <div class="recent-item">
          <div class="shift-icon">${s.type === 'full' ? '☀️' : '🌅'}</div>
          <div class="recent-info">
            <div class="recent-name">${fmtDateShort(s.date)}</div>
            <div class="recent-meta">${s.type === 'full' ? 'Ganztags 12h' : 'Früh/Spät 6,5h'} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
        </div>`).join('')
    : '<div class="empty-state">Noch keine Dienste geloggt.</div>';
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
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
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
  document.querySelectorAll('.type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
}

function goBackToInfo() {
  showStep('step-shift-info');
}

function goToPatients() {
  const dateVal = document.getElementById('shift-date').value;
  if (!dateVal) { alert('Bitte Datum auswählen.'); return; }
  const active = document.querySelector('.type-btn.active');
  state.activeShift = {
    date: dateVal,
    type: active.dataset.type,
    xpBase: parseInt(active.dataset.xp),
    patients: []
  };
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
  state.activeShift.patients.push({ ageGroup: '31-50', gender: 'weiblich', diagnoses: [] });
  const card = buildPatientCard(idx, state.activeShift.patients[idx]);
  document.getElementById('patient-list').appendChild(card);
}

function buildPatientCard(idx, patient) {
  const card = document.createElement('div');
  card.className = 'patient-card';
  card.id = `patient-card-${idx}`;
  card.innerHTML = `
    <div class="patient-header">
      <span class="patient-num">Patient ${idx + 1}</span>
      <button class="btn-icon btn-remove-patient" title="Entfernen">✕</button>
    </div>
    <div class="patient-demographics">
      <select class="demo-select" data-field="ageGroup">
        <option value="18-30" ${patient.ageGroup === '18-30' ? 'selected' : ''}>18–30 J.</option>
        <option value="31-50" ${patient.ageGroup === '31-50' ? 'selected' : ''}>31–50 J.</option>
        <option value="51+"   ${patient.ageGroup === '51+'   ? 'selected' : ''}>51+ J.</option>
      </select>
      <select class="demo-select" data-field="gender">
        <option value="weiblich" ${patient.gender === 'weiblich' ? 'selected' : ''}>Weiblich</option>
        <option value="männlich" ${patient.gender === 'männlich' ? 'selected' : ''}>Männlich</option>
        <option value="divers"   ${patient.gender === 'divers'   ? 'selected' : ''}>Divers</option>
      </select>
    </div>
    <div class="patient-diagnoses" id="diagnoses-${idx}">
      <div class="no-diag-hint">Noch keine Diagnose</div>
    </div>
    <button class="btn-search-diag">🔬 Diagnose suchen & fangen</button>`;

  card.querySelector('.btn-remove-patient').addEventListener('click', () => removePatient(idx));
  card.querySelector('.btn-search-diag').addEventListener('click', () => openDiagnosisSearch(idx));
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

// ─── Diagnosis Search ─────────────────────────────────────────────────────────
function setupDiagnosisModalListeners() {
  document.getElementById('diag-modal-close').addEventListener('click', closeDiagnosisModal);
  document.getElementById('diag-modal-backdrop').addEventListener('click', closeDiagnosisModal);
  document.getElementById('diag-search-input').addEventListener('input', onSearch);
  document.getElementById('btn-catch-diagnosis').addEventListener('click', catchDiagnosis);
  document.getElementById('komorbid-checkbox').addEventListener('change', updateXPPreview);
}

function openDiagnosisSearch(patientIndex) {
  state.searchContext = { patientIndex, selectedDiagnosis: null };
  document.getElementById('diag-search-input').value = '';
  document.getElementById('diag-search-results').innerHTML = '';
  document.getElementById('diag-detail').classList.add('hidden');
  document.getElementById('komorbid-checkbox').checked = false;
  document.getElementById('diagnosis-modal').classList.remove('hidden');
  document.getElementById('diag-search-input').focus();
}

function closeDiagnosisModal() {
  document.getElementById('diagnosis-modal').classList.add('hidden');
  state.searchContext = { patientIndex: null, selectedDiagnosis: null };
}

function onSearch(e) {
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('diag-search-results');
  document.getElementById('diag-detail').classList.add('hidden');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  const results = searchDiagnoses(state.icdFlat, q);
  if (!results.length) {
    resultsEl.innerHTML = '<div class="no-results">Keine Treffer für „' + q + '"</div>';
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
      ${preview.isFirstDiag    ? '<span class="xp-chip bonus-diag">+150 Erste Diagnose!</span>' : ''}
      ${preview.isFirstKat     ? '<span class="xp-chip bonus-kat">+300 Erste Kategorie!</span>' : ''}
      ${preview.komorbidBonus  ? `<span class="xp-chip bonus-k">+Komorbidität 20%</span>` : ''}
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
  if (state.searchContext.selectedDiagnosis) {
    renderDiagnosisDetail(state.searchContext.selectedDiagnosis);
  }
}

function previewXP(diagnosis, hasComorbidity) {
  const caughtCodes   = new Set(state.catches.map(c => c.code));
  const caughtKats    = new Set(state.catches.map(c => c.kategorie));
  // Include current-shift catches
  state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
    caughtCodes.add(d.diagnosis.code);
    caughtKats.add(d.diagnosis.kategorie);
  }));
  const base = 20 * diagnosis.seltenheit_score;
  let total  = base;
  const isFirstDiag  = !caughtCodes.has(diagnosis.code);
  const isFirstKat   = !caughtKats.has(diagnosis.kategorie);
  if (isFirstKat)  total += 300;
  if (isFirstDiag) total += 150;
  let komorbidBonus = 0;
  if (hasComorbidity) { komorbidBonus = Math.round(total * 0.2); total += komorbidBonus; }
  return { base, total, isFirstDiag, isFirstKat, komorbidBonus };
}

function catchDiagnosis() {
  const { patientIndex, selectedDiagnosis } = state.searchContext;
  if (!selectedDiagnosis || patientIndex === null) return;

  const hasComorbidity = document.getElementById('komorbid-checkbox').checked;
  const caughtCodes    = new Set(state.catches.map(c => c.code));
  const caughtKats     = new Set(state.catches.map(c => c.kategorie));
  state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
    caughtCodes.add(d.diagnosis.code);
    caughtKats.add(d.diagnosis.kategorie);
  }));

  const xpResult = calculateCatchXP(selectedDiagnosis, hasComorbidity, caughtCodes, caughtKats);
  state.activeShift.patients[patientIndex].diagnoses.push({
    diagnosis: selectedDiagnosis,
    hasComorbidity,
    xpEarned: xpResult.total
  });

  renderPatientDiagnoses(patientIndex, state.activeShift.patients[patientIndex]);
  closeDiagnosisModal();
  showXPPopup(xpResult.total, xpResult.bonuses);
}

// ─── Finish Shift ─────────────────────────────────────────────────────────────
async function finishShift() {
  if (!state.activeShift) return;
  const btn = document.getElementById('btn-finish-shift');
  btn.disabled = true;
  btn.textContent = 'Speichern…';

  try {
    const flameBonus   = calculateFlameBonus(state.activeShift.date);
    const diagnosisXP  = state.activeShift.patients
      .flatMap(p => p.diagnoses)
      .reduce((s, d) => s + d.xpEarned, 0);
    const totalXP      = state.activeShift.xpBase + flameBonus + diagnosisXP;

    const shiftId = await db.shiftLogs.add({
      date: state.activeShift.date,
      type: state.activeShift.type,
      xpEarned: totalXP,
      patientCount: state.activeShift.patients.length,
      createdAt: new Date().toISOString()
    });

    for (const patient of state.activeShift.patients) {
      for (const { diagnosis, hasComorbidity, xpEarned } of patient.diagnoses) {
        await db.caughtDiagnoses.add({
          code: diagnosis.code, name: diagnosis.name,
          kategorie: diagnosis.kategorie, shiftId,
          ageGroup: patient.ageGroup, gender: patient.gender,
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

    const oldRank = getRankForXP(oldXP);
    const newRank = getRankForXP(newXP);

    state.activeShift = null;
    resetShiftForm();
    navigateTo('dashboard');
    updateHeader();

    const bonusList = [];
    if (flameBonus > 0) bonusList.push({ label: '🔥 Flame-Bonus (24h)', xp: flameBonus });
    showXPPopup(totalXP, bonusList);

    if (newRank.level > oldRank.level) {
      setTimeout(() => showLevelUpModal(newRank), 1800);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Dienst abschließen ✓';
  }
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
  document.getElementById('levelup-close').addEventListener('click', () => {
    document.getElementById('levelup-modal').classList.add('hidden');
  });
}

function showLevelUpModal(rank) {
  document.getElementById('levelup-rank-name').textContent    = rank.title;
  document.getElementById('levelup-rank-subtitle').textContent = rank.subtitle;
  document.getElementById('levelup-rank-level').textContent   = `Rang ${rank.level}`;
  document.getElementById('levelup-modal').classList.remove('hidden');
}

// ─── PsychoDex ────────────────────────────────────────────────────────────────
function renderPsychoDex() {
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const total  = state.icdFlat.length;
  const caught = state.icdFlat.filter(d => caughtCodes.has(d.code)).length;

  document.getElementById('dex-caught-count').textContent = caught;
  document.getElementById('dex-total-count').textContent  = total;
  document.getElementById('dex-progress-fill').style.width =
    total ? `${(caught / total) * 100}%` : '0%';

  const gridEl = document.getElementById('category-grid');
  gridEl.innerHTML = (state.icdIndex?.categories || []).map(cat => {
    const diags     = state.icdData[cat.code] || [];
    const catCaught = diags.filter(d => caughtCodes.has(d.code)).length;
    const catTotal  = diags.length;
    const pct       = catTotal ? Math.round((catCaught / catTotal) * 100) : 0;
    return `
      <div class="category-card" data-cat="${cat.code}" style="--cat-color:${cat.color}">
        <div class="cat-bg" style="background-image:url('assets/images/categories/${cat.code.toLowerCase()}.jpg')"></div>
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

  gridEl.querySelectorAll('.category-card').forEach(card => {
    card.addEventListener('click', () => openCategoryModal(card.dataset.cat));
  });
}

function setupCategoryModalListeners() {
  document.getElementById('modal-close').addEventListener('click', closeCategoryModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeCategoryModal);
}

function openCategoryModal(catCode) {
  const diags       = state.icdData[catCode] || [];
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const catInfo     = state.icdIndex?.categories.find(c => c.code === catCode);

  document.getElementById('modal-category-title').textContent =
    catInfo ? `${catInfo.emoji} ${catInfo.label} – ${catInfo.name}` : catCode;

  document.getElementById('modal-diagnoses-list').innerHTML = diags.length
    ? diags.map(d => {
        const caught = caughtCodes.has(d.code);
        const stars  = '★'.repeat(d.seltenheit_score) + '☆'.repeat(10 - d.seltenheit_score);
        return `
          <div class="diag-list-item ${caught ? 'is-caught' : ''}">
            <div class="diag-list-left">
              <span class="diag-list-code">${d.code}</span>
              <div>
                <div class="diag-list-name">${d.name}</div>
                <div class="diag-list-rarity">${stars}</div>
              </div>
            </div>
            <div class="diag-list-status">${caught ? '✓' : '○'}</div>
          </div>`;
      }).join('')
    : '<div class="empty-state">Keine Diagnosen für diese Kategorie.</div>';

  document.getElementById('category-modal').classList.remove('hidden');
}

function closeCategoryModal() {
  document.getElementById('category-modal').classList.add('hidden');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const xp         = state.profile?.totalXP ?? 0;
  const shifts     = state.shifts.length;
  const hours      = state.shifts.reduce((s, sh) => s + (sh.type === 'full' ? 12 : 6.5), 0);
  const avgXP      = shifts ? Math.round(xp / shifts) : 0;

  document.getElementById('stat-total-xp').textContent    = xp.toLocaleString('de-AT');
  document.getElementById('stat-total-shifts').textContent = shifts;
  document.getElementById('stat-avg-xp').textContent       = avgXP;
  document.getElementById('stat-hours').textContent        = `${hours}h`;

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
      const cls = [
        'heatmap-cell',
        shiftSet.has(ds) ? 'hm-active' : '',
        ds === todayStr  ? 'hm-today'  : '',
        date > today     ? 'hm-future' : ''
      ].filter(Boolean).join(' ');
      html += `<div class="${cls}" title="${ds}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderCategoryChart() {
  const el    = document.getElementById('category-chart');
  const cats  = Object.keys(state.icdData);
  if (!cats.length) { el.innerHTML = '<div class="empty-state">Keine Daten.</div>'; return; }

  const byKat = {};
  state.catches.forEach(c => { byKat[c.kategorie] = (byKat[c.kategorie] || 0) + 1; });
  const maxVal = Math.max(...Object.values(byKat), 1);

  el.innerHTML = cats.map(cat => {
    const count = byKat[cat] || 0;
    const total = (state.icdData[cat] || []).length;
    const pct   = Math.round((count / maxVal) * 100);
    return `
      <div class="chart-row">
        <div class="chart-label">${cat}x</div>
        <div class="chart-track"><div class="chart-fill" style="width:${pct}%"></div></div>
        <div class="chart-count">${count}/${total}</div>
      </div>`;
  }).join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtDate = iso =>
  new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' });

const fmtDateShort = ds =>
  new Date(ds).toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' });

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
