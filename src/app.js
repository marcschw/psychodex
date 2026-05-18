import db from './db.js';
import { loadAllICD, searchDiagnoses } from './icd-loader.js';
import { calculateCatchXP, calculateFlameBonus } from './xp-engine.js';
import { RANKS, getRankForXP, getNextRank } from './ranks.js';
import { MISSION_POOL, TIER_LABELS, calcMissionProgress, pickNewMission } from './missions.js';
import { checkAchievements, ACHIEVEMENTS, SECRET_ACHIEVEMENTS, ACH_TIER_LABELS } from './achievements.js';

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
  hoursFilter: 'all',           // 'all' | 'früh' | 'spät' | 'full'
  diagInfoStack: [],             // navigation stack for info modal back button
  diagInfoCurrentCode: null,
  profile: null,
  shifts: [],
  catches: [],
  missions: [],
  unlockedAchievements: [],
  currentCategoryCode: null,
  diagCatchStack: []        // [{code, checkedKeys}] for back-navigation in catch modal
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Normalize kategorie to the 2-char block code (F0-F9) used as icdData keys.
// Handles old DB data where sub-categories like "F40","F41" were stored.
const normalizeKat = k => (k && k.length > 2) ? k.slice(0, 2) : (k || '');

const rarityInfo = score => {
  if (score <= 2) return { label: 'Häufig',        color: '#9ca3af' };
  if (score <= 4) return { label: 'Gelegentlich',  color: '#10b981' };
  if (score <= 6) return { label: 'Ungewöhnlich',  color: '#60a5fa' };
  if (score <= 8) return { label: 'Selten',         color: '#a78bfa' };
  return             { label: 'Extrem selten',  color: '#f59e0b' };
};

// ─── Symptom Parsing & Checkboxes ────────────────────────────────────────────
function splitCommaOutsideParens(str) {
  const items = [];
  let depth = 0, start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') depth--;
    else if (str[i] === ',' && depth === 0) {
      items.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(str.slice(start).trim());
  return items.filter(Boolean);
}

function parseSymptomItems(symptomText) {
  const t = symptomText.trim();

  // Header-only: ends with ":" → render as section label, not a checkbox
  if (t.endsWith(':')) return { type: 'header' };

  // Helper: split a numbered-list string on (N) markers
  const splitNumbered = str => str
    .split(/(?=\(\d+\))/)
    .map(s => s.replace(/^\(\d+\)\s*/, '').replace(/[;,]\s*$/, '').trim())
    .filter(Boolean);

  // Numbered list after colon: "header text: (1) item; (2) item"
  // Use /:\s*\(1\)/ to anchor on item 1 specifically (avoids matching ranges like (1)-(4))
  const colonNumIdx = t.search(/:\s*\(1\)\s/);
  if (colonNumIdx !== -1) {
    const header = t.slice(0, colonNumIdx).trim();
    const listPart = t.slice(colonNumIdx + 1).trim();
    const items = splitNumbered(listPart);
    if (items.length > 1) return { type: 'compound', header, items };
  }

  // Numbered list after dash/em-dash: "header – (1) item (2) item"
  // Require space around dash to avoid matching (1)-(4) ranges
  const dashNumIdx = t.search(/\s[–\-]\s(?=\(\d+\))/);
  if (dashNumIdx !== -1) {
    const header = t.slice(0, dashNumIdx).trim();
    const listPart = t.slice(dashNumIdx).replace(/^\s*[–\-]\s*/, '');
    const items = splitNumbered(listPart);
    if (items.length > 1) return { type: 'compound', header, items };
  }

  // Starts with numbered list: "(1) item (2) item"
  if (/^\(\d+\)/.test(t)) {
    const items = splitNumbered(t);
    if (items.length > 1) return { type: 'compound', header: '', items };
  }

  // Simple colon+comma list: "header: item1, item2" (only when NOT a numbered list after colon)
  const colonIdx = t.indexOf(': ');
  if (colonIdx !== -1) {
    const rest = t.slice(colonIdx + 2).trim();
    if (!/^\(\d+\)/.test(rest)) {
      const header = t.slice(0, colonIdx).trim();
      const items = splitCommaOutsideParens(rest);
      if (items.length > 1) return { type: 'compound', header, items };
    }
  }

  return { type: 'single' };
}

function renderSymptomCheckboxes(symptomList, kind, savedChecked, itemClass) {
  const isView = kind === 'view';
  const sc = savedChecked || [];
  const cls = itemClass ? ` ${itemClass}` : '';
  return symptomList.map(symptomText => {
    const parsed = parseSymptomItems(symptomText);
    if (parsed.type === 'header') {
      return `<li class="symptom-item symptom-section-header${cls}"><span class="sym-section-label">${symptomText}</span></li>`;
    }
    if (parsed.type === 'compound') {
      const minMatch = (parsed.header || '').match(/(?:mindestens|mind\.)\s*(\d+)/i);
      const minReq = minMatch ? parseInt(minMatch[1]) : null;
      const subHtml = parsed.items.map(item => {
        const key = `${symptomText}::${item}`;
        const ck = sc.includes(key) ? ' checked' : '';
        return `<li class="sym-sub-item"><label class="sym-label${isView ? ' sym-view' : ''}"><input type="checkbox" class="sym-cb" data-key="${key.replace(/"/g, '&quot;')}"${ck}${isView ? ' disabled' : ''}><span class="sym-box"></span><span class="sym-text">${item}</span></label></li>`;
      }).join('');
      const minAttr = minReq ? ` data-min-required="${minReq}"` : '';
      const badge   = minReq ? `<span class="sym-min-badge">0/${minReq}</span>` : '';
      return `<li class="symptom-item sym-compound${cls}"${minAttr}><div class="sym-compound-header-row"><span class="sym-compound-header">${parsed.header || symptomText}</span>${badge}</div><ul class="symptom-sub-list">${subHtml}</ul></li>`;
    }
    const ck = sc.includes(symptomText) ? ' checked' : '';
    return `<li class="symptom-item${cls}"><label class="sym-label${isView ? ' sym-view' : ''}"><input type="checkbox" class="sym-cb" data-key="${symptomText.replace(/"/g, '&quot;')}"${ck}${isView ? ' disabled' : ''}><span class="sym-box"></span><span class="sym-text">${symptomText}</span></label></li>`;
  }).join('');
}

function collectCheckedSymptoms() {
  return [...document.querySelectorAll('#diag-pflicht-list .sym-cb:checked, #diag-optional-list .sym-cb:checked')]
    .map(cb => cb.dataset.key);
}

// Initialises live "X/N" counters on compound items with data-min-required.
// interactive=true wires up change listeners; false just sets initial count.
function initSymptomCounters(container, interactive) {
  container.querySelectorAll('[data-min-required]').forEach(li => {
    const minReq = parseInt(li.dataset.minRequired);
    const badge  = li.querySelector('.sym-min-badge');
    if (!badge) return;
    const update = () => {
      const n = li.querySelectorAll('.sym-cb:checked').length;
      badge.textContent = `${n}/${minReq}`;
      badge.classList.toggle('sym-min-ok', n >= minReq);
      li.classList.toggle('sym-compound-ok', n >= minReq);
    };
    update();
    if (interactive) {
      li.querySelectorAll('.sym-cb').forEach(cb =>
        cb.addEventListener('change', update));
    }
  });
}

// ─── Hours Helpers ────────────────────────────────────────────────────────────
function calcShiftHours(shift) {
  const base = shift.type === 'full' ? 12 : shift.type === 'samstag' ? 7 : 6.5;
  return base + (shift.extensionMinutes || 0) / 60;
}
function calcTotalHours() {
  const entries = state.profile?.extraHourEntries;
  const extra = Array.isArray(entries)
    ? entries.reduce((s, e) => s + (e.hours || 0), 0)
    : (state.profile?.extraHours || 0);
  return state.shifts.reduce((s, sh) => s + calcShiftHours(sh), 0) + extra;
}
function getExtraHoursTotal() {
  const entries = state.profile?.extraHourEntries;
  return Array.isArray(entries)
    ? entries.reduce((s, e) => s + (e.hours || 0), 0)
    : (state.profile?.extraHours || 0);
}
const fmtDateTime = ts => new Date(ts).toLocaleString('de-AT', {
  day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
});

// ─── Service Worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── Lazy Image Loader ────────────────────────────────────────────────────────
// Sets background-image from data-bg only when element enters viewport.
// Avoids fetching hundreds of diagnosis images until the user actually opens a category.
const lazyObserver = (() => {
  if (!('IntersectionObserver' in window)) {
    // Fallback: apply all immediately
    return el => el.querySelectorAll('[data-bg]').forEach(t => {
      t.style.backgroundImage = t.dataset.bg;
    });
  }
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const t = entry.target;
      t.style.backgroundImage = t.dataset.bg;
      obs.unobserve(t);
    });
  }, { rootMargin: '300px' });
  return container => container.querySelectorAll('[data-bg]').forEach(el => obs.observe(el));
})();

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
    try { await ensureMissionSlots(); } catch (e) { console.warn('Mission init:', e); }
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
    setupDiagInfoModal();
    setupStreakModal();
    setupXPInfoModal();
    setupRankTableModal();
    setupSettingsInputs();
    setupDashboardCardListeners();
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
  if (state.profile.targetHours == null) state.profile.targetHours = 480;
  if (state.profile.extraHours  == null) state.profile.extraHours  = 0;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  try {
    state.missions = await db.missions.toArray();
  } catch { state.missions = []; }
  try {
    state.unlockedAchievements = await db.unlockedAchievements.toArray();
  } catch { state.unlockedAchievements = []; }

  // Migrate old single-number extraHours to entries array
  if (!Array.isArray(state.profile.extraHourEntries)) {
    const legacy = state.profile.extraHours || 0;
    state.profile.extraHourEntries = legacy > 0
      ? [{ id: Date.now(), hours: legacy, comment: 'Übertrag (migriert)', from: null, to: null }]
      : [];
    await db.profile.update(state.profile.id, { extraHourEntries: state.profile.extraHourEntries });
  }
}

// ─── Escape key closes any open modal ─────────────────────────────────────────
function setupEscapeKey() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openModals = [
      { id: 'xp-info-modal',        fn: closeXPInfoModal },
      { id: 'rank-table-modal',     fn: closeRankTableModal },
      { id: 'diag-info-modal',      fn: closeDiagInfoModal },
      { id: 'streak-modal',         fn: closeStreakModal },
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

  // Total hours + progress
  const totalHoursNum = calcTotalHours();
  const totalHours    = totalHoursNum.toFixed(1).replace(/\.0$/, '');
  const targetH       = state.profile?.targetHours || 480;
  const hPct          = Math.min(100, Math.max(0, (totalHoursNum / targetH) * 100));
  document.getElementById('total-hours').textContent = `${totalHours}h`;
  document.getElementById('hp-fill').style.width     = `${hPct}%`;
  document.getElementById('hp-pct').textContent      = `${Math.round(hPct)}%`;
  document.getElementById('hp-abs').textContent      = `${totalHours} / ${targetH}h`;
  document.getElementById('total-catches').textContent = state.catches.length;

  // Stat card clicks
  const hoursCard   = document.getElementById('stat-hours-card');
  const catchesCard = document.getElementById('stat-catches-card');
  const streakCard  = document.getElementById('stat-streak-card');
  hoursCard.onclick   = openHoursModal;
  catchesCard.onclick = openCatchesModal;
  streakCard.onclick  = openStreakModal;

  // Recent catches
  const catchEl = document.getElementById('recent-catches');
  catchEl.innerHTML = state.catches.length
    ? state.catches.slice(0, 5).map(c => {
        const { color: rarColor } = rarityInfo(c.seltenheit_score ?? 5);
        return `
        <div class="recent-item catch-clickable" data-code="${c.code}">
          <div class="recent-diag-thumb-wrap">
            <img src="assets/images/diagnoses/${c.code.toLowerCase()}.png"
                 class="recent-diag-thumb" alt="" onerror="this.style.display='none'" loading="lazy">
          </div>
          <div class="recent-info">
            <div class="recent-name">
              <span class="recent-code-badge" style="color:${rarColor}">${c.code}</span>
              ${c.name}
            </div>
            <div class="recent-meta">+${c.xpEarned} XP · ${fmtDate(c.caughtAt)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <div class="catch-badge">✓</div>
            <button class="btn-icon btn-delete-catch" data-id="${c.id}" title="Löschen">🗑</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty-state">Noch keine Diagnosen – starte deinen ersten Dienst!</div>';

  catchEl.querySelectorAll('.btn-delete-catch').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteCatch(parseInt(btn.dataset.id));
    });
  });
  catchEl.querySelectorAll('.catch-clickable').forEach(item =>
    item.addEventListener('click', () => openDiagInfoModal(item.dataset.code)));

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
  state.activeShift.patients.push({ ageGroup: '31-50', gender: 'weiblich', patientType: 'interview', time: null, diagnoses: [] });
  document.getElementById('patient-list').appendChild(buildPatientCard(idx, state.activeShift.patients[idx]));
}

function buildPatientCard(idx, patient) {
  const card = document.createElement('div');
  card.className = 'patient-card';
  card.id = `patient-card-${idx}`;
  const pt = patient.patientType || 'interview';
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
      <select class="demo-select" data-field="time">
        <option value="">Uhrzeit</option>
        ${Array.from({length:12},(_,i)=>`<option value="${i+8}"${patient.time===i+8?' selected':''}>${String(i+8).padStart(2,'0')}:00</option>`).join('')}
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
        const field = e.target.dataset.field;
        const val   = e.target.value;
        state.activeShift.patients[idx][field] = field === 'time' ? (val === '' ? null : parseInt(val)) : val;
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
  document.getElementById('btn-standalone-catch').addEventListener('click', () => openStandaloneCatch());
  document.getElementById('btn-symptom-finder').addEventListener('click', openSymptomFinder);
  document.querySelectorAll('.diag-modal-tab').forEach(tab =>
    tab.addEventListener('click', () => switchDiagTab(tab.dataset.tab)));
}

function openDiagnosisSearch(patientIndex) {
  state.searchContext = { patientIndex, selectedDiagnosis: null, standalone: false };
  state.addToShiftContext = null;
  const patient = state.activeShift?.patients[patientIndex];
  resetDiagSearchUI();
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
  switchDiagTab('search');
}

function switchDiagTab(tab) {
  document.querySelectorAll('.diag-modal-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('diag-pane-search').classList.toggle('hidden', tab !== 'search');
  document.getElementById('diag-pane-browse').classList.toggle('hidden', tab !== 'browse');
  // diag-detail intentionally NOT hidden here – persists across tab switches
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

  const cards = diags.map(d => {
    const caught = caughtCodes.has(d.code);
    const { label: rarLabel, color: rarColor } = rarityInfo(d.seltenheit_score);
    return `
      <div class="diag-mosaic-card ${caught ? 'is-caught' : ''}" data-code="${d.code}">
        <div class="dmc-bg" data-bg="url('assets/images/diagnoses/${d.code.toLowerCase()}.png')"></div>
        <div class="dmc-overlay"></div>
        <div class="dmc-content">
          <div class="dmc-top"><span class="dmc-code">${d.code}</span></div>
          <div class="dmc-bottom">
            <div class="dmc-name">${d.name}</div>
            <div class="dmc-rarity" style="color:${rarColor}">${rarLabel}</div>
          </div>
        </div>
        ${caught ? '<div class="dmc-caught-badge">✓</div>' : ''}
      </div>`;
  }).join('');

  listEl.innerHTML = `
    <div class="diag-browse-back" id="diag-browse-back-btn">← Zurück zu Kategorien</div>
    <div class="section-header" style="margin-top:0">${catInfo?.emoji || ''} ${catInfo?.name || catCode}</div>
    <div class="diag-mosaic-grid" id="diag-browse-mosaic">${cards}</div>`;

  lazyObserver(listEl.querySelector('#diag-browse-mosaic'));

  listEl.querySelector('#diag-browse-back-btn')?.addEventListener('click', () => {
    listEl.classList.add('hidden');
    catsEl.classList.remove('hidden');
  });
  listEl.querySelectorAll('.diag-mosaic-card').forEach(item =>
    item.addEventListener('click', () => {
      const code = item.dataset.code;
      if (caughtCodes.has(code)) {
        openDiagInfoModal(code);
      } else {
        const diag = state.icdFlat.find(d => d.code === code);
        if (!diag) return;
        // Switch to search tab so the catch button is immediately visible
        switchDiagTab('search');
        showDiagnosisDetail(diag);
      }
    }));
}

function closeDiagnosisModal() {
  document.getElementById('diagnosis-modal').classList.add('hidden');
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: false };
  state.addToShiftContext = null;
  state.diagCatchStack = [];
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
  const caughtCodes = new Set(state.catches.map(c => c.code));
  resultsEl.innerHTML = results.map(d => {
    const { label: rarLabel, color: rarColor } = rarityInfo(d.seltenheit_score);
    const caught = caughtCodes.has(d.code);
    return `
    <div class="search-result-item ${caught ? 'result-caught' : ''}" data-code="${d.code}">
      <div class="result-thumb">
        <img src="assets/images/diagnoses/${d.code.toLowerCase()}.png" alt=""
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
             loading="lazy" class="result-thumb-img">
        <div class="result-thumb-fallback" style="display:none">${d.code.slice(0, 3)}</div>
      </div>
      <div class="result-info">
        <span class="result-code">${d.code}</span>
        <span class="result-name">${d.name}</span>
        <span class="result-rarity" style="color:${rarColor}">${rarLabel}</span>
      </div>
      ${caught ? '<span class="result-caught-badge">✓</span>' : ''}
    </div>`; }).join('');
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

function renderDiagnosisDetail(diagnosis, savedChecked = []) {
  const preview = previewXP(diagnosis);
  const { label: rarLabel, color: rarColor } = rarityInfo(diagnosis.seltenheit_score);
  const hasBack = state.diagCatchStack.length > 0;
  document.getElementById('diag-detail-header').innerHTML = `
    ${hasBack ? '<button class="cat-detail-back" id="diag-catch-back-btn">← Zurück</button>' : ''}
    <div class="cat-detail-hero">
      <div class="cat-detail-img-wrap">
        <img src="assets/images/diagnoses/${diagnosis.code.toLowerCase()}.png" class="cat-detail-img" alt=""
             onerror="this.style.display='none'">
      </div>
      <div class="cat-detail-heading">
        <div class="diag-code-big">${diagnosis.code}</div>
        <div class="diag-name-big" style="font-size:14px">${diagnosis.name}</div>
        <div class="xp-preview-chips" style="margin-top:6px">
          <span class="xp-chip base">Basis: ${preview.base} XP</span>
          <span style="font-size:10px;font-weight:700;color:${rarColor}">${rarLabel}</span>
          ${preview.isFirstDiag   ? '<span class="xp-chip bonus-diag">+150</span>' : ''}
          ${preview.isFirstKat    ? '<span class="xp-chip bonus-kat">+300 Kat!</span>' : ''}
          ${preview.komorbidBonus ? '<span class="xp-chip bonus-k">+20%</span>' : ''}
        </div>
      </div>
    </div>`;

  const pflicht  = diagnosis.diagnose_kriterien?.pflicht_symptome  || [];
  const optional = diagnosis.diagnose_kriterien?.optionale_symptome || [];
  const pflichtEl  = document.getElementById('diag-pflicht-list');
  const optionalEl = document.getElementById('diag-optional-list');
  pflichtEl.innerHTML  = renderSymptomCheckboxes(pflicht,  'catch', savedChecked, 'symptom-pflicht');
  optionalEl.innerHTML = renderSymptomCheckboxes(optional, 'catch', savedChecked, 'symptom-optional');
  initSymptomCounters(pflichtEl,  true);
  initSymptomCounters(optionalEl, true);

  document.getElementById('diag-catch-back-btn')?.addEventListener('click', () => {
    const prev = state.diagCatchStack.pop();
    if (!prev) return;
    const prevDiag = state.icdFlat.find(d => d.code === prev.code);
    if (!prevDiag) return;
    state.searchContext.selectedDiagnosis = prevDiag;
    renderDiagnosisDetail(prevDiag, prev.checkedKeys);
  });

  const navigateLinked = code => {
    const target = state.icdFlat.find(d => d.code === code);
    if (!target) return;
    state.diagCatchStack.push({ code: diagnosis.code, checkedKeys: collectCheckedSymptoms() });
    state.searchContext.selectedDiagnosis = target;
    renderDiagnosisDetail(target);
  };

  const chipContainer = document.getElementById('diag-komorbid-chips');
  chipContainer.innerHTML = renderLinkedChips(diagnosis.komorbiditaeten, diagnosis.code);
  chipContainer.querySelectorAll('.linked-chip').forEach(btn =>
    btn.addEventListener('click', () => navigateLinked(btn.dataset.code)));
  const diffEl = document.getElementById('diag-diff-text');
  diffEl.innerHTML = renderLinkedChips(diagnosis.differentialdiagnose, diagnosis.code);
  diffEl.querySelectorAll('.linked-chip').forEach(btn =>
    btn.addEventListener('click', () => navigateLinked(btn.dataset.code)));
}

function updateXPPreview() {
  if (state.searchContext.selectedDiagnosis) renderDiagnosisDetail(state.searchContext.selectedDiagnosis);
}

function getAutoComorbidity() {
  const { patientIndex, standalone } = state.searchContext;
  if (standalone) return false;
  if (state.addToShiftContext) {
    const { shiftId, patientIndex: pkey } = state.addToShiftContext;
    if (pkey == null) return false;
    return state.catches.filter(c =>
      c.shiftId === shiftId && String(c.patientIndex) === String(pkey)).length >= 1;
  }
  if (patientIndex !== null && state.activeShift?.patients[patientIndex]) {
    return (state.activeShift.patients[patientIndex].diagnoses.length || 0) >= 1;
  }
  return false;
}

function previewXP(diagnosis) {
  const hasComorbidity = getAutoComorbidity();
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const caughtKats  = new Set(state.catches.map(c => normalizeKat(c.kategorie)));
  state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
    caughtCodes.add(d.diagnosis.code);
    caughtKats.add(normalizeKat(d.diagnosis.kategorie));
  }));
  const base = 20 * diagnosis.seltenheit_score;
  let total  = base;
  const isFirstDiag = !caughtCodes.has(diagnosis.code);
  const isFirstKat  = !caughtKats.has(normalizeKat(diagnosis.kategorie));
  if (isFirstKat)  total += 300;
  if (isFirstDiag) total += 150;
  let komorbidBonus = 0;
  if (hasComorbidity) { komorbidBonus = Math.round(total * 0.2); total += komorbidBonus; }
  return { base, total, isFirstDiag, isFirstKat, komorbidBonus };
}

function catchDiagnosis() {
  const { patientIndex, selectedDiagnosis, standalone } = state.searchContext;
  if (!selectedDiagnosis) return;

  const checkedSymptoms = collectCheckedSymptoms();
  const hasComorbidity = getAutoComorbidity();
  const caughtCodes    = new Set(state.catches.map(c => c.code));
  const caughtKats     = new Set(state.catches.map(c => normalizeKat(c.kategorie)));
  if (!standalone) {
    state.activeShift?.patients.forEach(p => p.diagnoses.forEach(d => {
      caughtCodes.add(d.diagnosis.code);
      caughtKats.add(normalizeKat(d.diagnosis.kategorie));
    }));
  }
  const normDiag = { ...selectedDiagnosis, kategorie: normalizeKat(selectedDiagnosis.kategorie) };
  const xpResult = calculateCatchXP(normDiag, hasComorbidity, caughtCodes, caughtKats);

  // Adding to an existing shift's patient (from shift detail view)
  if (state.addToShiftContext) {
    saveToExistingShiftPatient(selectedDiagnosis, hasComorbidity, xpResult,
      state.addToShiftContext.shiftId, state.addToShiftContext.patientIndex, checkedSymptoms);
    return;
  }

  // Adding within active shift form
  if (!standalone && patientIndex !== null) {
    state.activeShift.patients[patientIndex].diagnoses.push({
      diagnosis: selectedDiagnosis, hasComorbidity, xpEarned: xpResult.total, checkedSymptoms
    });
    renderPatientDiagnoses(patientIndex, state.activeShift.patients[patientIndex]);
    closeDiagnosisModal();
    showXPPopup(xpResult.total, xpResult.bonuses);
    return;
  }

  // Standalone: offer shift assignment
  closeDiagnosisModal();
  state.pendingStandaloneCatch = { diagnosis: selectedDiagnosis, hasComorbidity, xpResult, checkedSymptoms };
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
  const { diagnosis, hasComorbidity, xpResult, checkedSymptoms } = pending;
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
    checkedSymptoms: checkedSymptoms || [],
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
  refreshMissionProgress();
  applyAchievements();
}

async function createShiftAndSaveCatch(pending, shiftType) {
  const { diagnosis, hasComorbidity, xpResult, checkedSymptoms } = pending;
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
    checkedSymptoms: checkedSymptoms || [],
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
  refreshMissionProgress();
  applyAchievements();
}

async function saveStandaloneCatch(pending) {
  const { diagnosis, hasComorbidity, xpResult, checkedSymptoms } = pending;
  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId: null,
    ageGroup: null, gender: null, patientType: 'standalone',
    patientIndex: null,
    hasComorbidity, xpEarned: xpResult.total,
    checkedSymptoms: checkedSymptoms || [],
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
  refreshMissionProgress();
  applyAchievements();
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
      patientCount: state.activeShift.patients.filter(p => p.diagnoses.length > 0).length,
      createdAt: new Date().toISOString()
    });

    for (let pi = 0; pi < state.activeShift.patients.length; pi++) {
      const patient = state.activeShift.patients[pi];
      for (const { diagnosis, hasComorbidity, xpEarned, checkedSymptoms } of patient.diagnoses) {
        await db.caughtDiagnoses.add({
          code: diagnosis.code, name: diagnosis.name,
          kategorie: diagnosis.kategorie, shiftId,
          ageGroup: patient.ageGroup, gender: patient.gender,
          patientType: patient.patientType || 'erstgespraech',
          patientIndex: pi,
          patientTime: patient.time ?? null,
          hasComorbidity, xpEarned,
          checkedSymptoms: checkedSymptoms || [],
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
    refreshMissionProgress();
    applyAchievements();
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

// ─── Achievements ─────────────────────────────────────────────────────────────
const _achToastQueue = [];
let _achToastBusy = false;

function showAchievementToasts(items) {
  items.forEach(item => _achToastQueue.push(item));
  _drainAchToast();
}

function _drainAchToast() {
  if (_achToastBusy || !_achToastQueue.length) return;
  _achToastBusy = true;
  const item  = _achToastQueue.shift();
  const toast = document.getElementById('achievement-toast');
  const label = document.getElementById('ach-toast-label');
  document.getElementById('ach-toast-icon').textContent = item.icon;
  document.getElementById('ach-toast-name').textContent = item.name;
  document.getElementById('ach-toast-meta').textContent =
    item.isSecret ? `Secret · +${item.xp} XP` : `${ACH_TIER_LABELS[item.tier]} · +${item.xp} XP`;
  if (label) label.textContent = item.isSecret ? '🔓 Secret Achievement!' : 'Badge freigeschaltet!';
  toast.classList.toggle('ach-toast-secret', !!item.isSecret);
  toast.style.display = 'flex';
  toast.classList.remove('ach-toast-hide');
  toast.classList.add('ach-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.replace('ach-toast-show', 'ach-toast-hide');
    setTimeout(() => {
      toast.style.display = 'none';
      _achToastBusy = false;
      _drainAchToast();
    }, 380);
  }, 4200);
}

async function applyAchievements() {
  try {
    const newUnlocks = await checkAchievements(state, db);
    if (!newUnlocks.length) return;
    const bonusXP = newUnlocks.reduce((s, u) => s + u.xp, 0);
    const oldXP   = state.profile.totalXP ?? 0;
    const newXP   = oldXP + bonusXP;
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
    updateHeader();
    checkLevelUp(newXP, oldXP);
    if (state.currentTab === 'stats') renderAchievements();
    showAchievementToasts(newUnlocks);
  } catch (e) { console.warn('Achievement check:', e); }
}

function renderAchievements() {
  const el = document.getElementById('achievements-section');
  if (!el) return;
  const maxTierMap  = {};
  const secretsDone = new Set();
  (state.unlockedAchievements || []).forEach(a => {
    if (!maxTierMap[a.badgeId] || maxTierMap[a.badgeId] < a.tier)
      maxTierMap[a.badgeId] = a.tier;
    secretsDone.add(a.badgeId);
  });

  const regularCards = ACHIEVEMENTS.map(ach => {
    const maxTier = maxTierMap[ach.id] || 0;
    const dots = [1, 2, 3].map(t =>
      `<span class="ach-dot${t <= maxTier ? ' ach-dot-earned' : ''}"></span>`
    ).join('');
    return `<div class="ach-card ach-tier-${maxTier}">
      <div class="ach-img-wrap">
        <img class="ach-img" src="assets/images/badges/${ach.id}.png"
             onerror="this.style.display='none'" alt="">
        <span class="ach-emoji">${ach.icon}</span>
      </div>
      <div class="ach-info">
        <div class="ach-name">${ach.name}</div>
        <div class="ach-desc">${ach.description}</div>
        ${maxTier > 0 ? `<div class="ach-tier-label">${ACH_TIER_LABELS[maxTier]}</div>` : ''}
      </div>
      <div class="ach-dots">${dots}</div>
    </div>`;
  }).join('');

  const secretCards = SECRET_ACHIEVEMENTS.map(ach => {
    const isUnlocked = secretsDone.has(ach.id);
    if (isUnlocked) {
      return `<div class="ach-card ach-tier-3 ach-secret-unlocked">
        <div class="ach-img-wrap">
          <img class="ach-img" src="assets/images/badges/${ach.id}.png"
               onerror="this.style.display='none'" alt="">
          <span class="ach-emoji">${ach.icon}</span>
        </div>
        <div class="ach-info">
          <div class="ach-name">${ach.name}</div>
          <div class="ach-desc">${ach.description}</div>
          <div class="ach-tier-label ach-secret-label">🔓 Secret · +${ach.xp} XP</div>
        </div>
      </div>`;
    }
    return `<div class="ach-card ach-tier-0 ach-secret-locked">
      <div class="ach-img-wrap"><span class="ach-emoji" style="filter:brightness(0) invert(.15)">⬛</span></div>
      <div class="ach-info">
        <div class="ach-name">${ach.name}</div>
        <div class="ach-desc">??? (Geheimnis)</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML =
    `<div class="ach-grid">${regularCards}</div>
     <div class="section-subheader">Secret Achievements</div>
     <div class="ach-grid">${secretCards}</div>`;
}

// ─── XP Popup ─────────────────────────────────────────────────────────────────
function showXPPopup(xp, bonuses = []) {
  const popup = document.getElementById('xp-popup');
  const text  = document.getElementById('xp-popup-text');
  let html = `<span class="popup-main">+${xp} XP</span>`;
  bonuses.forEach(b => {
    html += b.xp ? `<span class="popup-bonus">${b.label}: +${b.xp}</span>`
                 : `<span class="popup-bonus">${b.label}</span>`;
  });
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
  const numStars     = rank.level <= 6 ? 1 : rank.level <= 12 ? 2 : 3;
  const prevNumStars = (rank.level - 1) <= 6 ? 1 : (rank.level - 1) <= 12 ? 2 : 3;
  const isNewStar    = numStars > prevNumStars;

  const imgWrap = document.getElementById('levelup-img-wrap');
  const img     = document.getElementById('levelup-img');
  imgWrap.style.display = '';
  img.style.display     = '';
  img.src               = `assets/images/ranks/${rank.title.toLowerCase()}.png`;
  img.alt               = rank.title;

  document.getElementById('levelup-stars').innerHTML = Array.from({length: numStars}, (_, i) => {
    const isLast = i === numStars - 1;
    const cls    = isLast ? (isNewStar ? 'star-new' : 'star-last') : 'star-old';
    return `<span class="levelup-star ${cls}" style="animation-delay:${(.3 + i * .13).toFixed(2)}s">⭐</span>`;
  }).join('');

  document.getElementById('levelup-rank-name').textContent     = rank.title;
  document.getElementById('levelup-rank-subtitle').textContent  = rank.subtitle;
  document.getElementById('levelup-rank-level').textContent    = `Rang ${rank.level} / 18`;
  document.getElementById('levelup-modal').classList.remove('hidden');
}

// ─── Mission Control ─────────────────────────────────────────────────────────
async function ensureMissionSlots() {
  const currentLevel   = getRankForXP(state.profile?.totalXP ?? 0).level;
  const activeMissions = state.missions.filter(m => !m.completedAt);
  const usedSlots      = activeMissions.map(m => m.slotIndex);
  const existingIds    = activeMissions.map(m => m.missionId);

  for (let slot = 0; slot < 3; slot++) {
    if (!usedSlots.includes(slot)) {
      const missionId = pickNewMission(currentLevel, existingIds);
      if (!missionId) continue;
      const id         = await db.missions.add({ slotIndex: slot, missionId, activatedAt: new Date().toISOString(), completedAt: null });
      const newMission = await db.missions.get(id);
      state.missions.push(newMission);
      existingIds.push(missionId);
    }
  }
}

async function refreshMissionProgress() {
  const activeMissions = state.missions.filter(m => !m.completedAt);
  let anyCompleted = false;

  for (const mission of activeMissions) {
    const mDef = MISSION_POOL.find(m => m.id === mission.missionId);
    if (!mDef) continue;

    const catchesSince = state.catches.filter(c => c.caughtAt >= mission.activatedAt);
    const shiftsSince  = state.shifts.filter(s =>
      (s.createdAt || `${s.date}T00:00:00`) >= mission.activatedAt
    );

    const { done } = calcMissionProgress(mDef, catchesSince, shiftsSince, state.icdFlat);

    if (done) {
      const now    = new Date().toISOString();
      await db.missions.update(mission.id, { completedAt: now });
      mission.completedAt = now;

      const oldXP = state.profile.totalXP ?? 0;
      const newXP = oldXP + mDef.reward;
      await db.profile.update(state.profile.id, { totalXP: newXP });
      state.profile.totalXP = newXP;

      showXPPopup(mDef.reward, [{ label: `🎯 Mission: ${mDef.title}`, xp: 0 }]);
      checkLevelUp(newXP, oldXP);
      anyCompleted = true;
    }
  }

  if (anyCompleted) {
    updateHeader();
    if (state.currentTab === 'dashboard') renderDashboard();
    setTimeout(async () => {
      await ensureMissionSlots();
      if (state.currentTab === 'dex') renderMissions();
    }, 1800);
  }

  if (state.currentTab === 'dex') renderMissions();
}

function renderMissions() {
  const gridEl = document.getElementById('missions-grid');
  if (!gridEl) return;
  const activeMissions = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);

  if (!activeMissions.length) {
    gridEl.innerHTML = db.missions
      ? '<div class="empty-state">Missionen werden initialisiert…</div>'
      : `<div class="empty-state" style="text-align:center">Missionen nicht verfügbar.<br><small style="color:var(--text-dim)">Bitte Seite neu laden (Strg+Shift+R)</small></div>`;
    return;
  }

  gridEl.innerHTML = activeMissions.map(am => {
    const mDef = MISSION_POOL.find(m => m.id === am.missionId);
    if (!mDef) return '';

    const catchesSince = state.catches.filter(c => c.caughtAt >= am.activatedAt);
    const shiftsSince  = state.shifts.filter(s =>
      (s.createdAt || `${s.date}T00:00:00`) >= am.activatedAt
    );
    const { current, target } = calcMissionProgress(mDef, catchesSince, shiftsSince, state.icdFlat);
    const pct = Math.min(100, Math.round((current / target) * 100));

    return `
      <div class="mission-card tier-${mDef.tier}">
        <div class="mission-card-header">
          <span class="mission-tier-badge">${TIER_LABELS[mDef.tier]}</span>
          <span class="mission-reward">+${mDef.reward.toLocaleString('de-AT')} XP</span>
        </div>
        <div class="mission-title">${mDef.title}</div>
        <div class="mission-desc">${mDef.description}</div>
        <div class="mission-progress-row">
          <div class="mission-prog-track">
            <div class="mission-prog-fill" style="width:${pct}%"></div>
          </div>
          <span class="mission-prog-text">${current} / ${target}</span>
        </div>
        ${mDef.badge ? `<div class="mission-badge">${mDef.badge}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── PsychoDex ────────────────────────────────────────────────────────────────
function renderPsychoDex() {
  const hasActive = state.missions.some(m => !m.completedAt);
  if (!hasActive && db.missions) {
    ensureMissionSlots().then(() => renderMissions()).catch(() => {});
  }
  renderMissions();

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
    const cardClass = ['category-card',
      catCaught > 0 ? 'has-catches' : '',
      pct >= 50 ? 'high-completion' : ''
    ].filter(Boolean).join(' ');
    return `
      <div class="${cardClass}" data-cat="${cat.code}" style="--cat-color:${cat.color}">
        <div class="cat-bg" data-bg="url('assets/images/categories/mosaike/${cat.code.toLowerCase()}.png'),url('assets/images/categories/${cat.code.toLowerCase()}.png')"></div>
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
  lazyObserver(gridEl);
  gridEl.querySelectorAll('.category-card').forEach(card =>
    card.addEventListener('click', () => openCategoryModal(card.dataset.cat)));
}

// ─── Category Modal ───────────────────────────────────────────────────────────
function setupCategoryModalListeners() {
  document.getElementById('modal-close').addEventListener('click', e => {
    e.stopPropagation(); closeCategoryModal();
  });
  document.getElementById('modal-backdrop').addEventListener('click', closeCategoryModal);
  const handleCatSearch = () => {
    if (!state.currentCategoryCode) return;
    const q = document.getElementById('cat-search-input').value;
    document.getElementById('cat-mosaic-pane').classList.remove('hidden');
    document.getElementById('cat-detail-pane').classList.add('hidden');
    renderCatMosaicGrid(state.currentCategoryCode, q);
  };
  const catSearchEl = document.getElementById('cat-search-input');
  catSearchEl.addEventListener('input', handleCatSearch);
  catSearchEl.addEventListener('keyup', handleCatSearch);
}

function openCategoryModal(catCode) {
  state.currentCategoryCode = catCode;
  const catInfo = state.icdIndex?.categories.find(c => c.code === catCode);
  document.getElementById('modal-category-title').textContent =
    catInfo ? `${catInfo.emoji} ${catInfo.label} – ${catInfo.name}` : catCode;
  document.getElementById('cat-search-input').value = '';
  document.getElementById('cat-mosaic-pane').classList.remove('hidden');
  document.getElementById('cat-detail-pane').classList.add('hidden');
  renderCatMosaicGrid(catCode, '');
  document.getElementById('category-modal').classList.remove('hidden');
}

function renderCatMosaicGrid(catCode, query) {
  const allDiags    = state.icdData[catCode] || [];
  const q           = query.toLowerCase().trim();
  const diags       = q
    ? allDiags.filter(d => d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
    : allDiags;
  const caughtCodes = new Set(state.catches.map(c => c.code));
  const listEl      = document.getElementById('modal-diagnoses-list');
  listEl.className  = 'diag-mosaic-grid';

  if (!diags.length) {
    listEl.innerHTML = q
      ? `<div class="empty-state">Kein Treffer für „${q}"</div>`
      : '<div class="empty-state">Keine Diagnosen für diese Kategorie.</div>';
    return;
  }
  listEl.innerHTML = diags.map(d => {
    const caught = caughtCodes.has(d.code);
    const { label, color } = rarityInfo(d.seltenheit_score);
    const imgUrl = `url('assets/images/diagnoses/${d.code.toLowerCase()}.png')`;
    return `
      <div class="diag-mosaic-card ${caught ? 'is-caught' : ''}" data-code="${d.code}">
        <div class="dmc-bg" style="background-image:${imgUrl}"></div>
        <div class="dmc-overlay"></div>
        <div class="dmc-content">
          <div class="dmc-top"><span class="dmc-code">${d.code}</span></div>
          <div class="dmc-bottom">
            <div class="dmc-name">${d.name}</div>
            <div class="dmc-rarity" style="color:${color}">${label} (${d.seltenheit_score})</div>
          </div>
        </div>
        ${caught ? '<div class="dmc-caught-badge">✓</div>' : ''}
      </div>`;
  }).join('');
  listEl.querySelectorAll('.diag-mosaic-card').forEach(item =>
    item.addEventListener('click', () => openCatDiagDetail(item.dataset.code)));
}

function openCatDiagDetail(code) {
  const diag = state.icdFlat.find(d => d.code === code);
  if (!diag) return;
  const isCaught     = new Set(state.catches.map(c => c.code)).has(code);
  const lastCatch    = state.catches.find(c => c.code === code);
  const savedChecked = lastCatch?.checkedSymptoms || [];
  const { label: rarLabel, color: rarColor } = rarityInfo(diag.seltenheit_score);
  const pflicht  = diag.diagnose_kriterien?.pflicht_symptome || [];
  const optional = diag.diagnose_kriterien?.optionale_symptome || [];
  const base     = 20 * diag.seltenheit_score;

  const body = document.getElementById('cat-detail-body');
  body.innerHTML = `
    <button class="cat-detail-back" id="cat-back-btn">← Zurück</button>
    <div class="cat-detail-hero">
      <div class="cat-detail-img-wrap">
        <img src="assets/images/diagnoses/${diag.code.toLowerCase()}.png" class="cat-detail-img" alt=""
             onerror="this.style.display='none'">
      </div>
      <div class="cat-detail-heading">
        <div class="diag-code-big">${diag.code}</div>
        <div class="diag-name-big" style="font-size:14px">${diag.name}</div>
        <div class="xp-preview-chips" style="margin-top:6px">
          <span class="xp-chip base">Basis: ${base} XP</span>
          <span style="font-size:10px;font-weight:700;color:${rarColor}">${rarLabel}</span>
          ${isCaught ? '<span class="xp-chip" style="background:rgba(16,185,129,.15);color:var(--success);border:1px solid rgba(16,185,129,.3)">✓ Gefangen</span>' : ''}
        </div>
      </div>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label diag-label-pflicht">🔴 Pflicht-Symptome</div>
      <ul class="symptom-list">${renderSymptomCheckboxes(pflicht, 'view', savedChecked, 'symptom-pflicht')}</ul>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label diag-label-optional">💡 Optionale Symptome</div>
      <ul class="symptom-list">${renderSymptomCheckboxes(optional, 'view', savedChecked, 'symptom-optional')}</ul>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label">Häufige Komorbiditäten</div>
      <div class="komorbid-chips">${renderLinkedChips(diag.komorbiditaeten, code)}</div>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label">Differentialdiagnose</div>
      <div class="komorbid-chips">${renderLinkedChips(diag.differentialdiagnose, code)}</div>
    </div>
    ${!isCaught ? `<button class="btn-catch" id="cat-detail-catch-btn">🎯 Jetzt fangen!</button>` : ''}`;

  initSymptomCounters(body, !isCaught);
  document.getElementById('cat-mosaic-pane').classList.add('hidden');
  document.getElementById('cat-detail-pane').classList.remove('hidden');

  document.getElementById('cat-back-btn').addEventListener('click', () => {
    document.getElementById('cat-detail-pane').classList.add('hidden');
    document.getElementById('cat-mosaic-pane').classList.remove('hidden');
  });
  body.querySelectorAll('.linked-chip').forEach(btn =>
    btn.addEventListener('click', () => openCatDiagDetail(btn.dataset.code)));
  document.getElementById('cat-detail-catch-btn')?.addEventListener('click', () => {
    closeCategoryModal(); openStandaloneCatch(diag);
  });
}

function closeCategoryModal() {
  document.getElementById('category-modal').classList.add('hidden');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const xp     = state.profile?.totalXP ?? 0;
  const shifts = state.shifts.length;
  const hours  = calcTotalHours();
  const avgXP  = shifts ? Math.round(xp / shifts) : 0;
  document.getElementById('stat-total-xp').textContent     = xp.toLocaleString('de-AT');
  document.getElementById('stat-total-shifts').textContent  = shifts;
  document.getElementById('stat-avg-xp').textContent        = avgXP;
  document.getElementById('stat-hours').textContent         = `${hours.toFixed(1).replace('.0','')}h`;
  const ti = document.getElementById('target-hours-input');
  if (ti) ti.value = state.profile?.targetHours ?? 480;
  renderExtraHoursSettings();
  renderHeatmap();
  renderCategoryChart();
  renderAchievements();
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
  state.catches.forEach(c => { const k = normalizeKat(c.kategorie); byKat[k] = (byKat[k] || 0) + 1; });
  el.innerHTML = cats.map(cat => {
    const count = byKat[cat] || 0;
    const total = (state.icdData[cat] || []).length;
    const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
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
      (btn.dataset.type === 'früh' && !['spät','full','samstag'].includes(shift.type))));
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
  const oldBase = shift.type === 'full' ? 120 : shift.type === 'samstag' ? 70 : 65;
  const newBase = newType === 'full' ? 120 : newType === 'samstag' ? 70 : 65;
  const xpDelta = newBase - oldBase;
  await db.shiftLogs.update(state.editingShiftId, { date: newDate, type: newType, xpEarned: shift.xpEarned + xpDelta, updatedAt: new Date().toISOString() });
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
        patientType: c.patientType || 'erstgespraech',
        patientTime: c.patientTime ?? null,
        catches: [], index: key
      });
    }
    patientMap.get(key).catches.push(c);
  });

  const extMins  = shift.extensionMinutes || 0;
  const shiftH   = calcShiftHours(shift).toFixed(1).replace('.0','');
  const extLabel = extMins > 0 ? `+${extMins}min (${shiftH}h)` : `${shiftH}h`;
  let html = `
    <div class="shift-detail-header">
      <div class="shift-detail-info">
        <div class="shift-detail-date">${shiftIcon(shift.type)} ${fmtDateShort(shift.date)} · ${shiftLabel(shift.type)}</div>
        <div class="shift-detail-meta">+${shift.xpEarned} XP · ${shift.patientCount} Patient(en)</div>
        <div class="shift-timestamps">
          <span>📅 ${fmtDateTime(shift.createdAt)}</span>
          ${shift.updatedAt ? `<span>✏️ ${fmtDateTime(shift.updatedAt)}</span>` : ''}
        </div>
      </div>
      <button class="btn-icon" id="btn-edit-this-shift" data-id="${shift.id}" title="Bearbeiten">✎</button>
    </div>
    <div class="shift-extend-row">
      <span class="shift-extend-label">Gesamt: <span id="shift-ext-display" class="shift-ext-val">${extLabel}</span></span>
      <button class="btn-extend" id="btn-ext-minus">−15min</button>
      <button class="btn-extend" id="btn-ext-plus">+15min</button>
    </div>`;

  if (patientMap.size === 0) {
    html += '<div class="empty-state">Keine Diagnosen für diesen Dienst.</div>';
  }

  let pNum = 1;
  for (const [, p] of patientMap) {
    const timeStr  = p.patientTime != null ? ` · ${String(p.patientTime).padStart(2,'0')}:00 Uhr` : '';
    const demoLabel = `${p.ageGroup} J · ${p.gender} · ${p.patientType === 'erstgespraech' ? 'Erstgespräch' : 'Interview'}${timeStr}`;
    html += `<div class="patient-section" data-pkey="${p.index}">
      <div class="patient-section-header">
        <div>
          <div class="patient-section-label">Patient ${pNum}</div>
          <div class="patient-section-demo">${demoLabel}</div>
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn-icon btn-edit-patient-demo" data-pkey="${p.index}" title="Demografik bearbeiten">✎</button>
          <button class="btn-icon btn-delete-shift-patient" data-pkey="${p.index}" title="Patient löschen">🗑</button>
        </div>
      </div>
      <div class="patient-diags" id="pdiags-${shift.id}-${p.index}">`;

    p.catches.forEach(c => {
      html += `<div class="patient-diag-row">
        <div class="pd-thumb">
          <img src="assets/images/diagnoses/${c.code.toLowerCase()}.png" class="pd-thumb-img" alt=""
               onerror="this.style.display='none'" loading="lazy">
        </div>
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

  body.querySelector('#btn-ext-plus')?.addEventListener('click', async () => {
    await setShiftExtension(shift.id, (shift.extensionMinutes || 0) + 15);
  });
  body.querySelector('#btn-ext-minus')?.addEventListener('click', async () => {
    const curr = shift.extensionMinutes || 0;
    if (curr >= 15) await setShiftExtension(shift.id, curr - 15);
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

  body.querySelectorAll('.btn-delete-shift-patient').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteShiftPatient(btn.dataset.pkey, shift);
    });
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
    </select>
    <select class="demo-select-sm" data-field="patientTime">
      <option value="">Uhr</option>
      ${Array.from({length:12},(_,i)=>`<option value="${i+8}"${p.patientTime===i+8?'selected':''}>${String(i+8).padStart(2,'0')}:00</option>`).join('')}
    </select>`;
  section.querySelector('.patient-section-header').after(row);
  row.querySelectorAll('.demo-select-sm').forEach(sel => {
    sel.addEventListener('change', async () => {
      const field = sel.dataset.field;
      const raw   = sel.value;
      const val   = field === 'patientTime' ? (raw === '' ? null : parseInt(raw)) : raw;
      p[field] = val;
      for (const c of p.catches) {
        await db.caughtDiagnoses.update(c.id, { [field]: val });
      }
      state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
      // Update display in patient section header
      const demoEl = section.querySelector('.patient-section-demo');
      if (demoEl) {
        const timeStr  = p.patientTime != null ? ` · ${String(p.patientTime).padStart(2,'0')}:00 Uhr` : '';
        demoEl.textContent = `${p.ageGroup} J · ${p.gender} · ${p.patientType === 'erstgespraech' ? 'Erstgespräch' : 'Interview'}${timeStr}`;
      }
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

async function deleteShiftPatient(pkey, shift) {
  const patientCatches = state.catches.filter(c => c.shiftId === shift.id &&
    (c.patientIndex != null ? String(c.patientIndex) === String(pkey) : `${c.ageGroup}-${c.gender}-${c.patientType}` === pkey));
  if (!confirm(`Patient mit ${patientCatches.length} Diagnose(n) wirklich löschen?`)) return;
  const removedXP = patientCatches.reduce((s, c) => s + (c.xpEarned ?? 0), 0);
  for (const c of patientCatches) await db.caughtDiagnoses.delete(c.id);
  const newShiftXP = Math.max(0, (shift.xpEarned || 0) - removedXP);
  const newPatientCount = Math.max(0, (shift.patientCount || 1) - 1);
  await db.shiftLogs.update(shift.id, { xpEarned: newShiftXP, patientCount: newPatientCount });
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - removedXP);
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  updateHeader();
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

async function saveToExistingShiftPatient(diagnosis, hasComorbidity, xpResult, shiftId, patientKey, checkedSymptoms) {
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
    checkedSymptoms: checkedSymptoms || [],
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
  refreshMissionProgress();
  applyAchievements();

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
  state.hoursFilter = 'all';
  renderHoursModalBody();
  document.getElementById('hours-modal').classList.remove('hidden');
}

function renderHoursModalBody() {
  const body     = document.getElementById('hours-modal-body');
  const all      = state.shifts;
  const filtered = state.hoursFilter === 'all' ? all : all.filter(s => s.type === state.hoursFilter);
  const totalH   = calcTotalHours();
  const nFr = all.filter(s => s.type === 'früh').length;
  const nSp = all.filter(s => s.type === 'spät').length;
  const nFu = all.filter(s => s.type === 'full').length;
  const extra = getExtraHoursTotal();

  body.innerHTML = `
    <div class="hours-summary">
      <div>
        <div class="hours-total">${totalH.toFixed(1).replace('.0','')}h</div>
        <div class="hours-label">Gesamt${extra > 0 ? ` (+${extra.toFixed(1).replace('.0','')}h Extra)` : ''}</div>
      </div>
      <div style="text-align:right;font-size:12px;color:var(--text-dim);line-height:1.9">
        <div>🌅 Früh: ${nFr}×</div>
        <div>🌇 Spät: ${nSp}×</div>
        <div>☀️ Ganztags: ${nFu}×</div>
      </div>
    </div>
    <div class="hours-filter-row">
      <button class="hours-filter-btn${state.hoursFilter==='all'?' active':''}" data-filter="all">Alle (${all.length})</button>
      <button class="hours-filter-btn${state.hoursFilter==='früh'?' active':''}" data-filter="früh">🌅 Früh (${nFr})</button>
      <button class="hours-filter-btn${state.hoursFilter==='spät'?' active':''}" data-filter="spät">🌇 Spät (${nSp})</button>
      <button class="hours-filter-btn${state.hoursFilter==='full'?' active':''}" data-filter="full">☀️ Ganztags (${nFu})</button>
    </div>
    <div class="hours-list">
      ${filtered.length ? filtered.map(s => `
        <div class="hours-row" data-id="${s.id}">
          <div class="hours-row-icon">${shiftIcon(s.type)}</div>
          <div class="hours-row-info">
            <div class="hours-row-date">${fmtDateShort(s.date)}</div>
            <div class="hours-row-meta">${shiftLabel(s.type)}${s.extensionMinutes ? ` +${s.extensionMinutes}min` : ''} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
          <div class="hours-row-val">${calcShiftHours(s).toFixed(1).replace('.0','')}h</div>
        </div>`).join('')
      : '<div class="empty-state">Keine Dienste in dieser Kategorie.</div>'}
    </div>`;

  body.querySelectorAll('.hours-filter-btn').forEach(btn =>
    btn.addEventListener('click', () => { state.hoursFilter = btn.dataset.filter; renderHoursModalBody(); }));
  body.querySelectorAll('.hours-row').forEach(row =>
    row.addEventListener('click', () => { closeHoursModal(); openShiftDetailModal(parseInt(row.dataset.id)); }));
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
    <div class="catch-detail-item catch-clickable" data-code="${c.code}">
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
  body.querySelectorAll('.catch-clickable').forEach(item =>
    item.addEventListener('click', e => {
      if (!e.target.closest('.btn-delete-catch-modal')) openDiagInfoModal(item.dataset.code);
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

const shiftIcon  = t => t === 'full' ? '☀️' : t === 'spät' ? '🌇' : t === 'samstag' ? '🗓️' : '🌅';
const shiftLabel = t => t === 'full' ? 'Ganztags 12h' : t === 'spät' ? 'Spät 6,5h' : t === 'samstag' ? 'Samstag 7h' : 'Früh 6,5h';

// ─── Diagnosis Info Modal ─────────────────────────────────────────────────────
function setupDiagInfoModal() {
  document.getElementById('diag-info-close').addEventListener('click', e => {
    e.stopPropagation(); closeDiagInfoModal();
  });
  document.getElementById('diag-info-backdrop').addEventListener('click', closeDiagInfoModal);
}

function closeDiagInfoModal() {
  document.getElementById('diag-info-modal').classList.add('hidden');
}

function renderLinkedChips(items, currentCode) {
  if (typeof items === 'string') {
    return items.trim()
      ? items.trim().split(/,\s*(?=[A-ZÜÄÖ])/).map(chunk => {
          const match = chunk.match(/\b(F\d{2}(?:\.\d+)?)\b/);
          if (match) {
            const linkedCode = match[1];
            if (linkedCode !== currentCode && state.icdFlat.find(d => d.code === linkedCode)) {
              return `<button class="komorbid-chip linked-chip" data-code="${linkedCode}">${chunk}</button>`;
            }
          }
          return `<span class="komorbid-chip">${chunk}</span>`;
        }).join('')
      : '';
  }
  return (items || []).map(item => {
    const match = item.match(/\b(F\d{2}(?:\.\d+)?)\b/);
    if (match) {
      const linkedCode = match[1];
      if (linkedCode !== currentCode && state.icdFlat.find(d => d.code === linkedCode)) {
        return `<button class="komorbid-chip linked-chip" data-code="${linkedCode}">${item}</button>`;
      }
    }
    return `<span class="komorbid-chip">${item}</span>`;
  }).join('');
}

function renderDiagInfoBody(code) {
  const diag = state.icdFlat.find(d => d.code === code);
  if (!diag) return;
  state.diagInfoCurrentCode = code;
  const isCaught = new Set(state.catches.map(c => c.code)).has(code);
  const base     = 20 * diag.seltenheit_score;
  const lastCatch = state.catches.find(c => c.code === code);
  const savedChecked = lastCatch?.checkedSymptoms || [];
  const pflicht  = diag.diagnose_kriterien?.pflicht_symptome || [];
  const optional = diag.diagnose_kriterien?.optionale_symptome || [];
  document.getElementById('diag-info-title').textContent = diag.code;
  document.getElementById('diag-info-body').innerHTML = `
    ${state.diagInfoStack.length > 0 ? `<button class="diag-info-back" id="diag-info-back-btn">← Zurück</button>` : ''}
    <div class="diag-detail-header">
      <div class="diag-code-big">${diag.code}</div>
      <div class="diag-name-big">${diag.name}</div>
      <div class="xp-preview-chips">
        <span class="xp-chip base">Basis: ${base} XP · ★${diag.seltenheit_score}/10</span>
        ${isCaught
          ? '<span class="xp-chip" style="background:rgba(16,185,129,.15);color:var(--success);border:1px solid rgba(16,185,129,.3)">✓ Bereits gefangen</span>'
          : '<span class="xp-chip" style="background:rgba(124,58,237,.1);color:var(--accent);border:1px solid rgba(124,58,237,.3)">Noch nicht gefangen</span>'}
      </div>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label diag-label-pflicht">🔴 Pflicht-Symptome</div>
      <ul class="symptom-list">${renderSymptomCheckboxes(pflicht, 'view', savedChecked, 'symptom-pflicht')}</ul>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label diag-label-optional">💡 Optionale Symptome</div>
      <ul class="symptom-list">${renderSymptomCheckboxes(optional, 'view', savedChecked, 'symptom-optional')}</ul>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label">Häufige Komorbiditäten</div>
      <div class="komorbid-chips" id="diag-info-komorbid">${renderLinkedChips(diag.komorbiditaeten, code)}</div>
    </div>
    <div class="diag-detail-section">
      <div class="diag-detail-label">Differentialdiagnose</div>
      <div class="komorbid-chips" id="diag-info-diff">${renderLinkedChips(diag.differentialdiagnose, code)}</div>
    </div>
    ${!isCaught ? `<button class="btn-catch" id="diag-info-catch-btn">🎯 Jetzt fangen!</button>` : ''}`;
  initSymptomCounters(document.getElementById('diag-info-body'), false);
  document.getElementById('diag-info-back-btn')?.addEventListener('click', () => {
    const prev = state.diagInfoStack.pop();
    if (prev) renderDiagInfoBody(prev);
  });
  document.getElementById('diag-info-body').querySelectorAll('.linked-chip').forEach(btn =>
    btn.addEventListener('click', () => navigateDiagInfoTo(btn.dataset.code)));
  document.getElementById('diag-info-catch-btn')?.addEventListener('click', () => {
    closeDiagInfoModal(); openStandaloneCatch(diag);
  });
}

function navigateDiagInfoTo(code) {
  if (state.diagInfoCurrentCode) state.diagInfoStack.push(state.diagInfoCurrentCode);
  renderDiagInfoBody(code);
}

function openDiagInfoModal(code) {
  state.diagInfoStack = [];
  state.diagInfoCurrentCode = null;
  renderDiagInfoBody(code);
  document.getElementById('diag-info-modal').classList.remove('hidden');
}

// ─── Streak Modal ──────────────────────────────────────────────────────────────
function setupStreakModal() {
  document.getElementById('streak-modal-close').addEventListener('click', e => {
    e.stopPropagation(); closeStreakModal();
  });
  document.getElementById('streak-backdrop').addEventListener('click', closeStreakModal);
}

function closeStreakModal() {
  document.getElementById('streak-modal').classList.add('hidden');
}

function openStreakModal() {
  const isoWeek = d => {
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const y = tmp.getUTCFullYear();
    const w = Math.ceil((((tmp - new Date(Date.UTC(y, 0, 1))) / 86400000) + 1) / 7);
    return `${y}-W${String(w).padStart(2, '0')}`;
  };
  const weekLabel = isoW => {
    const [year, week] = isoW.split('-W');
    return `KW ${week} / ${year}`;
  };

  const streak = calcStreak(state.shifts);
  const today  = new Date();
  const weeks  = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - i * 7); return isoWeek(d);
  });

  const shiftsByWeek = {};
  state.shifts.forEach(s => {
    const w = isoWeek(new Date(s.date));
    if (!shiftsByWeek[w]) shiftsByWeek[w] = [];
    shiftsByWeek[w].push(s);
  });

  const statusText = streak.frozen
    ? 'Eingefroren – diese Woche fehlt noch ein Dienst'
    : streak.count === 0 ? 'Noch kein Streak' : 'Aktiver Streak 🔥';

  document.getElementById('streak-modal-body').innerHTML = `
    <div class="streak-summary">
      <div class="streak-big-icon">${streak.frozen ? '🧊' : streak.count > 0 ? '🔥' : '—'}</div>
      <div>
        <div class="streak-big-count">${streak.count} Woche${streak.count !== 1 ? 'n' : ''}</div>
        <div class="streak-big-status">${statusText}</div>
      </div>
    </div>
    <div class="section-header">Aktivität (letzte 13 Wochen)</div>
    <div class="streak-weeks">
      ${weeks.map(w => {
        const shifts = shiftsByWeek[w] || [];
        const hasShift = shifts.length > 0;
        const totalXP  = shifts.reduce((a, s) => a + s.xpEarned, 0);
        return `
          <div class="streak-week-row ${hasShift ? 'has-shift' : ''}">
            <div class="streak-week-dot ${hasShift ? 'dot-active' : ''}"></div>
            <div class="streak-week-label">${weekLabel(w)}</div>
            <div class="streak-week-shifts">
              ${hasShift
                ? shifts.map(s => `<button class="streak-shift-pill" data-id="${s.id}" title="${shiftLabel(s.type)}">${shiftIcon(s.type)} ${fmtDateShort(s.date)}</button>`).join('')
                : '<span class="streak-week-empty">—</span>'}
            </div>
            <div class="streak-week-xp">${hasShift ? '+' + totalXP + ' XP' : ''}</div>
          </div>`;
      }).join('')}
    </div>`;
  document.getElementById('streak-modal-body').querySelectorAll('.streak-shift-pill').forEach(btn =>
    btn.addEventListener('click', () => { closeStreakModal(); openShiftDetailModal(parseInt(btn.dataset.id)); }));
  document.getElementById('streak-modal').classList.remove('hidden');
}

// ─── Export / Import ──────────────────────────────────────────────────────────
function setupExportImport() {
  document.getElementById('btn-export')?.addEventListener('click', exportData);
  document.getElementById('import-file-input')?.addEventListener('change', importData);
}

async function exportData() {
  const shifts       = await db.shiftLogs.toArray();
  const catches      = await db.caughtDiagnoses.toArray();
  const missions     = await db.missions.toArray();
  const achievements = await db.unlockedAchievements.toArray();
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    profile:      { totalXP: state.profile?.totalXP ?? 0 },
    shifts:       shifts.map(({ id, ...s }) => s),
    catches:      catches.map(({ id, ...c }) => c),
    missions:     missions.map(({ id, ...m }) => m),
    achievements: achievements.map(({ id, ...a }) => a)
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
    const achCount = data.achievements?.length ?? 0;
    const msnCount = data.missions?.length ?? 0;
    if (!confirm(`Alle aktuellen Daten werden ersetzt.\n${data.shifts.length} Dienste, ${data.catches.length} Diagnosen, ${achCount} Achievements, ${msnCount} Missionen werden importiert.\n\nFortfahren?`)) return;

    await db.profile.clear();
    await db.shiftLogs.clear();
    await db.caughtDiagnoses.clear();
    if (db.missions)             await db.missions.clear();
    if (db.unlockedAchievements) await db.unlockedAchievements.clear();

    await db.profile.add({ totalXP: data.profile?.totalXP ?? 0, createdAt: new Date().toISOString() });
    for (const s of data.shifts)  await db.shiftLogs.add(s);
    for (const c of data.catches) await db.caughtDiagnoses.add(c);
    if (db.missions && Array.isArray(data.missions))
      for (const m of data.missions) await db.missions.add(m);
    if (db.unlockedAchievements && Array.isArray(data.achievements))
      for (const a of data.achievements) await db.unlockedAchievements.add(a);

    await loadFromDB();
    renderApp();
    alert(`Import erfolgreich: ${data.shifts.length} Dienste, ${data.catches.length} Diagnosen, ${achCount} Achievements geladen.`);
    navigateTo('stats');
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
  e.target.value = '';
}

// ─── XP Info Modal ────────────────────────────────────────────────────────────
function setupXPInfoModal() {
  document.getElementById('xp-info-close').addEventListener('click', e => { e.stopPropagation(); closeXPInfoModal(); });
  document.getElementById('xp-info-backdrop').addEventListener('click', closeXPInfoModal);
}
function closeXPInfoModal() { document.getElementById('xp-info-modal').classList.add('hidden'); }
function openXPInfoModal() {
  document.getElementById('xp-info-body').innerHTML = `
    <div class="xp-info-source">
      <div class="xp-info-source-title">⏱ Zeit-XP (pro Dienst)</div>
      <div class="xp-info-row"><span>🌅 Früh / 🌇 Spät (6,5h)</span><span class="xp-info-val">65 XP</span></div>
      <div class="xp-info-row"><span>🗓️ Samstag (7h, 10–16 Uhr)</span><span class="xp-info-val">70 XP</span></div>
      <div class="xp-info-row"><span>☀️ Ganztags (12h)</span><span class="xp-info-val">120 XP</span></div>
    </div>
    <div class="xp-info-source">
      <div class="xp-info-source-title">🔬 Diagnose-Catch</div>
      <div class="xp-info-row"><span>Basis: 20 × Seltenheit (★1–★10)</span><span class="xp-info-val">20–200 XP</span></div>
      <div class="xp-info-row"><span>Bsp: F32.1 Mittelschwere Depression (★6)</span><span class="xp-info-val">120 XP</span></div>
      <div class="xp-info-row"><span>Bsp: F20.0 Paranoide Schizophrenie (★7)</span><span class="xp-info-val">140 XP</span></div>
    </div>
    <div class="xp-info-source">
      <div class="xp-info-source-title">🎯 First-Catch Boni (einmalig pro Diagnose/Kategorie)</div>
      <div class="xp-info-row"><span>Erste spezifische Diagnose (z.B. erste F32.1)</span><span class="xp-info-val">+150 XP</span></div>
      <div class="xp-info-row"><span>Erste Diagnose einer Kategorie (z.B. erste F3x)</span><span class="xp-info-val">+300 XP</span></div>
    </div>
    <div class="xp-info-source">
      <div class="xp-info-source-title">💡 Komorbidität (automatisch)</div>
      <div class="xp-info-row"><span>Patient hat schon ≥1 Diagnose → +20% auf Catch</span><span class="xp-info-val">+20%</span></div>
      <div class="xp-info-row"><span>Bsp: Zweite Diagnose F41.0 (★6) = 120 × 1.2</span><span class="xp-info-val">144 XP</span></div>
    </div>
    <div class="xp-info-source">
      <div class="xp-info-source-title">🔥 Flame-Bonus</div>
      <div class="xp-info-row"><span>Dienst innerhalb 24h nach Dienstende eingetragen</span><span class="xp-info-val">+25 XP</span></div>
    </div>
    <div class="xp-info-source">
      <div class="xp-info-source-title">📊 Beispiel-Dienst (bester Fall)</div>
      <div class="xp-info-row"><span>🌅 Frühdienst Basis</span><span class="xp-info-val">65 XP</span></div>
      <div class="xp-info-row"><span>F32.1 ★6 (Erst-Diagnose + Erst-Kategorie)</span><span class="xp-info-val">120+150+300 XP</span></div>
      <div class="xp-info-row"><span>F41.0 ★6 Komorbidität (selbe Kategorie, kein First-Kat)</span><span class="xp-info-val">120×1.2+150 = 294 XP</span></div>
      <div class="xp-info-row"><span>Flame-Bonus (innerhalb 24h)</span><span class="xp-info-val">+25 XP</span></div>
      <div class="xp-info-row" style="border-top:1px solid rgba(255,255,255,.1);margin-top:4px;padding-top:8px">
        <strong>Total</strong><span class="xp-info-val" style="color:var(--success)"><strong>954 XP</strong></span>
      </div>
    </div>`;
  document.getElementById('xp-info-modal').classList.remove('hidden');
}

// ─── Rank Table Modal ─────────────────────────────────────────────────────────
function buildXPTimeline() {
  const events = [];
  state.shifts.forEach(s => { if (s.createdAt) events.push({ time: s.createdAt, xp: s.xpEarned || 0 }); });
  state.catches.filter(c => !c.shiftId).forEach(c => { if (c.caughtAt) events.push({ time: c.caughtAt, xp: c.xpEarned || 0 }); });
  events.sort((a, b) => a.time.localeCompare(b.time));
  let running = 0;
  return events.map(e => { running += e.xp; return { ...e, total: running }; });
}

function getRankUnlockDates() {
  const timeline   = buildXPTimeline();
  const unlockDates = {};
  RANKS.forEach(rank => {
    if (rank.xpRequired === 0) {
      unlockDates[rank.level] = timeline.length > 0 ? timeline[0].time : null;
    } else {
      const ev = timeline.find(e => e.total >= rank.xpRequired);
      if (ev) unlockDates[rank.level] = ev.time;
    }
  });
  return unlockDates;
}

function setupRankTableModal() {
  document.getElementById('rank-table-close').addEventListener('click', e => { e.stopPropagation(); closeRankTableModal(); });
  document.getElementById('rank-table-backdrop').addEventListener('click', closeRankTableModal);
  document.getElementById('rank-table-body').addEventListener('click', e => {
    if (e.target.id === 'recalc-xp-btn') recalculateXP();
  });
}
function closeRankTableModal() { document.getElementById('rank-table-modal').classList.add('hidden'); }
function openRankTableModal() {
  const xp          = state.profile?.totalXP ?? 0;
  const currentRank = getRankForXP(xp);
  const unlockDates = getRankUnlockDates();
  const stars = l => l <= 6 ? '⭐' : l <= 12 ? '⭐⭐' : '⭐⭐⭐';
  const fmtD  = ts => new Date(ts).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' });

  document.getElementById('rank-table-body').innerHTML = `
    <div class="rank-table-current-xp">Aktuell: <strong>${xp.toLocaleString('de-AT')} XP</strong></div>
    <button id="recalc-xp-btn" class="btn-secondary recalc-xp-btn">XP neu berechnen</button>
    ${RANKS.map(rank => {
      const isCurrent  = rank.level === currentRank.level;
      const unlockDate = unlockDates[rank.level];
      const isUnlocked = unlockDate != null;
      const cls        = isCurrent ? 'is-current' : isUnlocked ? 'is-unlocked' : 'is-locked';
      return `
        <div class="rank-table-row ${cls}">
          <div class="rank-table-num">${rank.level}</div>
          <div class="rank-table-info">
            <div class="rank-table-name">${rank.title} ${stars(rank.level)}</div>
            <div class="rank-table-sub">${rank.subtitle}</div>
          </div>
          <div style="text-align:right;min-width:80px">
            ${isCurrent ? '<div class="rank-table-badge">◈ AKTUELL</div>' : ''}
            ${isUnlocked && !isCurrent ? `<div class="rank-table-date">${fmtD(unlockDate)}</div>` : ''}
            ${isCurrent && unlockDate ? `<div class="rank-table-date">${fmtD(unlockDate)}</div>` : ''}
            ${!isUnlocked ? `<div class="rank-table-xp-needed">${rank.xpRequired.toLocaleString('de-AT')} XP</div>` : ''}
          </div>
        </div>`;
    }).join('')}`;
  document.getElementById('rank-table-modal').classList.remove('hidden');
}

async function recalculateXP() {
  if (!confirm('XP komplett neu berechnen?\n\nAlle XP werden aus gespeicherten Diensten, Diagnosen, Achievements und Missionen neu summiert.')) return;

  const btn = document.getElementById('recalc-xp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Berechne…'; }

  const shifts   = await db.shiftLogs.toArray();
  const catches  = await db.caughtDiagnoses.toArray();
  const missions = await db.missions.toArray();
  const unlocked = await db.unlockedAchievements.toArray();

  const shiftXP  = shifts.reduce((s, sh) => s + (sh.xpEarned ?? 0), 0);
  const catchXP  = catches.reduce((s, c)  => s + (c.xpEarned  ?? 0), 0);

  const achievementXP = unlocked.reduce((sum, a) => {
    const def = ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (def) return sum + (def.tiers[a.tier - 1]?.xp ?? 0);
    const sec = SECRET_ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (sec) return sum + (sec.xp ?? 0);
    return sum;
  }, 0);

  const missionXP = missions.reduce((sum, m) => {
    if (!m.completedAt) return sum;
    const def = MISSION_POOL.find(x => x.id === m.missionId);
    return sum + (def?.reward ?? 0);
  }, 0);

  const newXP = shiftXP + catchXP + achievementXP + missionXP;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;

  updateHeader();
  renderDashboard();
  openRankTableModal();
}

// ─── Dashboard Card Listeners ─────────────────────────────────────────────────
function setupDashboardCardListeners() {
  document.getElementById('rank-card').addEventListener('click', e => {
    if (!e.target.closest('#rank-xp-container')) openRankTableModal();
  });
  document.getElementById('rank-xp-container').addEventListener('click', e => {
    e.stopPropagation();
    openXPInfoModal();
  });
}

// ─── Extra Hours ──────────────────────────────────────────────────────────────
function renderExtraHoursSettings() {
  const el = document.getElementById('extra-hours-section');
  if (!el) return;
  const entries = state.profile?.extraHourEntries || [];
  const total   = entries.reduce((s, e) => s + (e.hours || 0), 0);
  const fmtD    = ds => new Date(ds).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit' });
  const rangeTxt = e => {
    if (e.from && e.to) return `${fmtD(e.from)} – ${fmtD(e.to)}`;
    if (e.from) return `ab ${fmtD(e.from)}`;
    if (e.to)   return `bis ${fmtD(e.to)}`;
    return '';
  };

  el.innerHTML = `
    <div class="extra-total">${total.toFixed(1).replace('.0','')}h gesamt</div>
    <div class="extra-entries-list">
      ${entries.map(e => `
        <div class="extra-entry">
          <div class="extra-entry-info">
            <span class="extra-entry-h">${e.hours}h</span>
            ${e.comment ? `<span class="extra-entry-cmt">${e.comment}</span>` : ''}
            ${rangeTxt(e) ? `<span class="extra-entry-rng">${rangeTxt(e)}</span>` : ''}
          </div>
          <button class="btn-icon btn-del-extra" data-id="${e.id}" title="Löschen">🗑</button>
        </div>`).join('')}
    </div>
    <div id="extra-add-form" class="extra-add-form hidden">
      <div class="extra-form-row">
        <input type="number" id="eaf-hours" class="setting-input" placeholder="h" min="0.5" step="0.5" style="width:64px">
        <input type="text" id="eaf-comment" class="setting-input" placeholder="Kommentar" style="flex:1;min-width:0">
      </div>
      <div class="extra-form-row">
        <input type="date" id="eaf-from" class="setting-input" style="flex:1;min-width:0">
        <span class="extra-form-sep">–</span>
        <input type="date" id="eaf-to" class="setting-input" style="flex:1;min-width:0">
      </div>
      <div class="extra-form-btns">
        <button id="eaf-save" class="btn-primary" style="flex:1;padding:8px 12px;position:relative;z-index:1">Speichern</button>
        <button id="eaf-cancel" class="btn-secondary" style="padding:8px 12px">✕</button>
      </div>
    </div>
    <button id="btn-add-extra" class="btn-secondary" style="width:100%;margin-top:8px;padding:8px;font-size:12px">+ Extra-Stunden hinzufügen</button>`;

  el.querySelectorAll('.btn-del-extra').forEach(btn =>
    btn.addEventListener('click', () => deleteExtraHourEntry(parseInt(btn.dataset.id))));

  el.querySelector('#btn-add-extra')?.addEventListener('click', () => {
    el.querySelector('#extra-add-form').classList.remove('hidden');
    el.querySelector('#btn-add-extra').classList.add('hidden');
    el.querySelector('#eaf-hours').focus();
  });
  el.querySelector('#eaf-cancel')?.addEventListener('click', () => {
    el.querySelector('#extra-add-form').classList.add('hidden');
    el.querySelector('#btn-add-extra').classList.remove('hidden');
  });
  el.querySelector('#eaf-save')?.addEventListener('click', saveExtraHourEntry);
}

async function saveExtraHourEntry() {
  const hours   = parseFloat(document.getElementById('eaf-hours')?.value) || 0;
  const comment = document.getElementById('eaf-comment')?.value?.trim() || '';
  const from    = document.getElementById('eaf-from')?.value   || null;
  const to      = document.getElementById('eaf-to')?.value     || null;
  if (hours <= 0) { document.getElementById('eaf-hours')?.focus(); return; }

  const entries = [...(state.profile.extraHourEntries || []),
    { id: Date.now(), hours, comment, from: from || null, to: to || null }];
  await db.profile.update(state.profile.id, { extraHourEntries: entries });
  state.profile.extraHourEntries = entries;
  renderExtraHoursSettings();
  if (state.currentTab === 'dashboard') renderDashboard();
}

async function deleteExtraHourEntry(entryId) {
  const entries = (state.profile.extraHourEntries || []).filter(e => e.id !== entryId);
  await db.profile.update(state.profile.id, { extraHourEntries: entries });
  state.profile.extraHourEntries = entries;
  renderExtraHoursSettings();
  if (state.currentTab === 'dashboard') renderDashboard();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function setupSettingsInputs() {
  const targetInput = document.getElementById('target-hours-input');
  if (targetInput) {
    targetInput.value = state.profile?.targetHours ?? 480;
    targetInput.addEventListener('change', async () => {
      const val = Math.max(1, Math.round(parseFloat(targetInput.value)) || 480);
      targetInput.value = val;
      await db.profile.update(state.profile.id, { targetHours: val });
      state.profile.targetHours = val;
      if (state.currentTab === 'dashboard') renderDashboard();
    });
  }
}

// ─── Shift Extension ──────────────────────────────────────────────────────────
async function setShiftExtension(shiftId, newMinutes) {
  await db.shiftLogs.update(shiftId, { extensionMinutes: newMinutes, updatedAt: new Date().toISOString() });
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  const shift  = state.shifts.find(s => s.id === shiftId);
  if (shift) renderShiftDetailBody(shift);
  if (state.currentTab === 'dashboard') renderDashboard();
  else if (state.currentTab === 'stats') renderStats();
}

// ─── Privacy Disclaimer ───────────────────────────────────────────────────────
(function setupPrivacyBadge() {
  const badge = document.getElementById('privacy-badge');
  const close = document.getElementById('privacy-close');
  if (!badge || !close) return;
  if (localStorage.getItem('privacy-dismissed') === '1') badge.classList.add('dismissed');
  close.addEventListener('click', () => {
    badge.classList.add('dismissed');
    localStorage.setItem('privacy-dismissed', '1');
  });
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
