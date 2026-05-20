import db from './db.js';
import { loadAllICD, searchDiagnoses } from './icd-loader.js';
import { calculateCatchXP, calculateShiftXP, calculateFlameBonus, calculateNoteXP, SLOT_TYPES, SHIFT_HOURS, MEAL_HINTS, BREAK_PRESETS, SLOT_TIPS, CATEGORY_XP_MODIFIER, CATEGORY_META } from './xp-engine.js';
import { RANKS, getRankForXP, getNextRank } from './ranks.js';
import { MISSION_POOL, TIER_LABELS, calcMissionProgress, pickNewMission } from './missions.js';
import { checkAchievements, ACHIEVEMENTS, SECRET_ACHIEVEMENTS, ACH_TIER_LABELS } from './achievements.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  currentTab: 'log',
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
  diagCatchStack: [],       // [{code, checkedKeys}] for back-navigation in catch modal
  plannerShiftId: null,     // ID of the currently open planner shift
  plannerSlots: [],         // schedule slots for the open planner shift
  slotAddContext: null,     // { shiftId, startH, startM, selectedType, flags:[]}
  alarmFired: new Set(),    // set of slot IDs that already triggered alarm
  alarmInterval: null,
  mealModalContext: null,   // { shift, hint } for meal add/edit modal
  mealModalIcon: '☕',
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
function calcCounterHours(counter) {
  const from = counter.fromDate;
  const shifts = from ? state.shifts.filter(s => s.date >= from) : state.shifts;
  return shifts.reduce((s, sh) => s + calcShiftHours(sh), 0) + getExtraHoursTotal();
}
function calcShiftHours(shift) {
  const base = shift.type === 'full' ? 12 : shift.type === 'samstag' ? 7 : shift.type === 'schulung' ? 6 : 6.5;
  return base + (shift.extensionMinutes || 0) / 60;
}
function fmtShiftDuration(shift) {
  const h = calcShiftHours(shift);
  const whole = Math.floor(h);
  const mins  = Math.round((h - whole) * 60);
  return mins ? `${whole}h ${mins}min` : `${whole}h`;
}
function shiftLabelFull(shift) {
  const name = shift.type === 'full' ? 'Ganztags' : shift.type === 'spät' ? 'Spät'
    : shift.type === 'samstag' ? 'Samstag' : shift.type === 'schulung' ? 'Schulung' : 'Früh';
  return `${name} ${fmtShiftDuration(shift)}`;
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
    setupPlannerListeners();
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
  try {
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  } catch { state.shifts = []; }
  try {
    state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  } catch { state.catches = []; }
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

  // Migrate to named hourCounters
  if (!Array.isArray(state.profile.hourCounters)) {
    state.profile.hourCounters = [{
      id: 1, name: 'Propädeutikum',
      targetHours: state.profile.targetHours || 480,
      fromDate: null
    }];
    await db.profile.update(state.profile.id, { hourCounters: state.profile.hourCounters });
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
  if (tab === 'log') renderPlannerTab();
  if (tab === 'dex') renderPsychoDex();
  if (tab === 'stats') renderStats();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderApp() {
  renderPlannerTab();
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

  // Named hours counters
  renderHoursCounters();
  // stat card still shows total
  const totalHoursNum = calcTotalHours();
  document.getElementById('total-hours').textContent = `${totalHoursNum.toFixed(1).replace(/\.0$/, '')}h`;
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
            <div class="recent-meta">${shiftLabelFull(s)} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
          ${!s.note ? '<span class="shift-no-log-badge" title="Kein Dienst-Log — Bonus-XP verfügbar!">📝</span>' : '<span style="font-size:12px;color:var(--text-dim)">›</span>'}
        </div>`).join('')
    : '<div class="empty-state">Noch keine Dienste geloggt.</div>';

  shiftEl.querySelectorAll('.shift-item-clickable').forEach(item => {
    item.addEventListener('click', () => openShiftDetailModal(parseInt(item.dataset.id)));
  });

  // Active planner shift banner
  const plannerBannerEl = document.getElementById('dashboard-planner-banner');
  if (plannerBannerEl) {
    const openShift = state.shifts.find(s => s.plannerActive);
    if (openShift) {
      plannerBannerEl.innerHTML = `
        <div class="planner-dash-banner">
          <span>${shiftIcon(openShift.type)} <strong>${fmtDateShort(openShift.date)} · ${shiftLabel(openShift.type)}</strong> läuft</span>
          <button class="btn-secondary" style="font-size:11px;padding:4px 10px"
            id="btn-goto-planner">Zum Planer →</button>
        </div>`;
      plannerBannerEl.querySelector('#btn-goto-planner')
        ?.addEventListener('click', () => navigateTo('log'));
    } else {
      plannerBannerEl.innerHTML = '';
    }
  }
}

// ─── Hours Counters ───────────────────────────────────────────────────────────
function renderHoursCounters() {
  const el = document.getElementById('hours-counters');
  if (!el) return;
  const counters = state.profile?.hourCounters || [];
  el.innerHTML = counters.map(c => {
    const h = calcCounterHours(c);
    const t = c.targetHours || 480;
    const pct = Math.min(100, Math.round((h / t) * 100));
    const fromTxt = c.fromDate
      ? `ab ${new Date(c.fromDate + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' })}`
      : '';
    return `
      <div class="hours-counter-card" data-counter-id="${c.id}">
        <div class="hc-top">
          <span class="hc-name">${c.name}</span>
          <span class="hc-pct">${pct}%</span>
        </div>
        <div class="hc-bar-wrap"><div class="hc-bar-fill" style="width:${pct}%"></div></div>
        <div class="hc-abs">${h.toFixed(1).replace('.0','')}h / ${t}h${fromTxt ? ` · ${fromTxt}` : ''}</div>
      </div>`;
  }).join('');
  el.querySelectorAll('.hours-counter-card').forEach(card => {
    card.addEventListener('click', () => {
      const cid = parseInt(card.dataset.counterId);
      state.hoursModalCounter = cid;
      openHoursModal();
    });
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
  let safety = 0;
  while (shiftWeeks.has(isoWeek(cursor)) && safety++ < 500) {
    count++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return { count, frozen };
}

// ─── Planner ──────────────────────────────────────────────────────────────────
const padT = (h, m) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
const toMins = (h, m) => h * 60 + m;

function shiftHours(type) { return SHIFT_HOURS[type] || SHIFT_HOURS['früh']; }

function getMealHints(shift) {
  if (shift.mealHints) return shift.mealHints;
  return (MEAL_HINTS[shift.type] || []).map((h, i) => ({ ...h, id: i + 1 }));
}

async function renderPlannerTab() {
  // Find any open planner shift
  const openShift = state.shifts.find(s => s.plannerActive);
  state.plannerShiftId = openShift?.id ?? null;

  document.getElementById('planner-no-shift').classList.toggle('hidden', !!openShift);
  document.getElementById('planner-active-shift').classList.toggle('hidden', !openShift);

  if (!openShift) {
    // Set default date
    const dateEl = document.getElementById('planner-date');
    if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
    renderPlannerPastShifts();
    return;
  }

  // Load slots
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(openShift.id).sortBy('startHour');

  // Show notification permission banner if not yet granted/dismissed
  const notifBanner = document.getElementById('notif-prompt-banner');
  if (notifBanner && 'Notification' in window) {
    const dismissed = localStorage.getItem('notif-banner-dismissed');
    const shouldShow = Notification.permission === 'default' && !dismissed;
    notifBanner.classList.toggle('hidden', !shouldShow);
  }

  // Header
  const catMeta = CATEGORY_META[openShift.category || 'regulär'];
  document.getElementById('planner-shift-title').innerHTML =
    `${shiftIcon(openShift.type)} ${fmtDateShort(openShift.date)} · ${shiftLabel(openShift.type)} <span class="cat-badge cat-badge-${openShift.category || 'regulär'}">${catMeta.icon} ${catMeta.label}</span>`;
  updatePlannerXP(openShift);
  renderTimeline(openShift);
  startAlarmScheduler();
}

function updatePlannerXP(shift) {
  const slotTotal = state.plannerSlots.reduce((s, sl) => s + (sl.xpEarned || 0), 0);
  const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
  const meta = CATEGORY_META[shift.category || 'regulär'];
  const base = Math.round(calculateShiftXP(shift.type) * modifier);
  const flame = calculateFlameBonus(shift.date);
  const catBadge = `<span class="cat-badge cat-badge-${shift.category || 'regulär'}">${meta.icon} ${meta.label}</span>`;
  document.getElementById('planner-shift-xp').innerHTML =
    `${catBadge} · +${base + flame} XP bei Abschluss · ${slotTotal} XP Aktivitäten`;
}

function renderSchulungTimeline(shift) {
  const tl = document.getElementById('planner-timeline');
  tl.innerHTML = `
    <div class="schulung-note-wrapper">
      <div class="schulung-hint">📚 Schulungsdienst · Keine Einträge möglich</div>
      <textarea class="schulung-note-area" id="schulung-note-area" rows="6"
        placeholder="Notizen zur Schulung…">${shift.note || ''}</textarea>
      <div class="schulung-note-hint">Wird automatisch gespeichert</div>
    </div>`;
  let saveTimer;
  tl.querySelector('#schulung-note-area').addEventListener('input', e => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      db.shiftLogs.update(shift.id, { note: e.target.value });
      const s = state.shifts.find(x => x.id === shift.id);
      if (s) s.note = e.target.value;
    }, 800);
  });
}

function renderTimeline(shift) {
  if (shift.type === 'schulung') { renderSchulungTimeline(shift); return; }

  const { start, end } = shiftHours(shift.type);
  const startM = toMins(...start);
  const endM   = toMins(...end);
  const meals  = getMealHints(shift).map(h => ({ ...h, mins: toMins(h.h, h.m) }));

  // Build a sorted list of slot time ranges
  const slots = [...state.plannerSlots].sort((a, b) => toMins(a.startHour, a.startMinute) - toMins(b.startHour, b.startMinute));

  // Build rows: gap → slot → gap → meal hints in gaps → ...
  const rows = [];
  let cursor = startM;

  const pushHourTicks = (from, to) => {
    if (from >= to) return;
    let c = from;
    // If gap starts at :30, push one button from :30 to next full hour first
    if (c % 60 !== 0) {
      const nextHour = Math.ceil(c / 60) * 60;
      rows.push({ kind: 'gap', from: c, to: Math.min(nextHour, to) });
      c = nextHour;
    }
    // One button per full hour
    while (c < to) {
      rows.push({ kind: 'gap', from: c, to: Math.min(c + 60, to) });
      c += 60;
    }
  };

  const pushGaps = (from, to) => {
    // Insert meal hints within the gap
    const inRange = meals.filter(m => m.mins >= from && m.mins < to);
    inRange.sort((a, b) => a.mins - b.mins);
    let c = from;
    for (const m of inRange) {
      if (c < m.mins) pushHourTicks(c, m.mins);
      rows.push({ kind:'meal', ...m });
      c = m.mins;
    }
    if (c < to) pushHourTicks(c, to);
  };

  for (const slot of slots) {
    const slotStart = toMins(slot.startHour, slot.startMinute);
    const slotEnd   = toMins(slot.endHour, slot.endMinute);
    if (cursor < slotStart) pushGaps(cursor, slotStart);
    rows.push({ kind:'slot', slot });
    cursor = slotEnd;
  }
  if (cursor < endM) pushGaps(cursor, endM);

  const tl = document.getElementById('planner-timeline');
  tl.innerHTML = rows.map(row => {
    if (row.kind === 'meal') {
      return `<div class="tl-meal" data-meal-id="${row.id}">
        <span class="tl-meal-time">${padT(row.h, row.m)}</span>
        <span class="tl-meal-icon">${row.icon}</span>
        <span class="tl-meal-label">${row.label}</span>
        <button class="tl-meal-del" data-meal-id="${row.id}" title="Löschen">🗑</button>
      </div>`;
    }
    if (row.kind === 'gap') {
      const label = padT(Math.floor(row.from/60), row.from%60);
      return `<button class="tl-gap" data-startm="${row.from}" data-endm="${row.to}">
        <span class="tl-gap-time">${label}</span>
        <span class="tl-gap-add">＋ Eintrag</span>
      </button>`;
    }
    // slot
    const { slot } = row;
    const def = SLOT_TYPES[slot.type] || {};
    const flags = slot.flags?.length ? slot.flags.map(f => `<span class="slot-flag">${f.toUpperCase()}</span>`).join('') : '';
    const commentHtml = slot.comment ? `<div class="tl-slot-comment">${slot.comment}</div>` : '';
    return `<div class="tl-slot slot-${slot.type}" data-slot-id="${slot.id}">
      <div class="tl-slot-main">
        <span class="tl-slot-icon">${def.icon}</span>
        <div class="tl-slot-info">
          <div class="tl-slot-label">${def.label} ${flags}</div>
          <div class="tl-slot-time">${padT(slot.startHour,slot.startMinute)}–${padT(slot.endHour,slot.endMinute)} · +${slot.xpEarned} XP</div>
          ${commentHtml}
        </div>
        <button class="tl-slot-delete btn-icon" data-slot-id="${slot.id}" title="Löschen">🗑</button>
      </div>
    </div>`;
  }).join('');

  // Wire gaps → slot add
  tl.querySelectorAll('.tl-gap').forEach(btn => {
    btn.addEventListener('click', () => {
      const startM2 = parseInt(btn.dataset.startm);
      openSlotAddModal(shift.id, Math.floor(startM2/60), startM2%60);
    });
  });

  // Wire slot clicks → tips/detail
  tl.querySelectorAll('.tl-slot').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tl-slot-delete')) return;
      const slot = state.plannerSlots.find(s => s.id === parseInt(el.dataset.slotId));
      if (slot) openSlotDetailModal(slot, 'planner');
    });
  });

  // Wire delete buttons
  tl.querySelectorAll('.tl-slot-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteSlot(parseInt(btn.dataset.slotId), shift);
    });
  });

  // Wire meal hint edit / delete
  // Tap row → edit; tap delete button → delete
  tl.querySelectorAll('.tl-meal').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.tl-meal-del')) return;
      const id = parseInt(row.dataset.mealId);
      const hint = getMealHints(shift).find(h => h.id === id);
      openMealModal(shift, hint);
    });
  });

  tl.querySelectorAll('.tl-meal-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.mealId);
      const updated = getMealHints(shift).filter(h => h.id !== id);
      await db.shiftLogs.update(shift.id, { mealHints: updated });
      state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
      renderTimeline({ ...shift, mealHints: updated });
    });
  });
}

function renderPlannerPastShifts() {
  const today = new Date().toISOString().split('T')[0];
  const nextCardEl = document.getElementById('planner-next-card');
  const listEl = document.getElementById('planner-past-shifts');
  const isUnopened = s => s.importedFrom === 'xml' && !s.closedAt;
  const allNonActive = state.shifts.filter(s => !s.plannerActive);

  // Upcoming: XML-imported, not yet opened, today or future — sorted ascending
  const upcoming = allNonActive
    .filter(s => isUnopened(s) && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const next = upcoming[0] ?? null;
  const moreUpcoming = upcoming.slice(1, 4);

  // Past: completed or manually created (no importedFrom), most recent first
  const past = allNonActive
    .filter(s => !isUnopened(s))
    .slice(0, 5);

  // ── Next shift card ──────────────────────────────────────────────────────
  if (nextCardEl) {
    if (next) {
      const meta = CATEGORY_META[next.category || 'regulär'];
      const isToday = next.date === today;
      nextCardEl.innerHTML = `
        <div class="planner-next-card">
          <div class="planner-next-label">${isToday ? '📍 Heute' : '⏭ Nächster Dienst'}</div>
          <div class="planner-next-date">${fmtDateLong(next.date)}</div>
          <div class="planner-next-meta">
            ${shiftIcon(next.type)} ${shiftLabel(next.type)} ·
            <span class="cat-badge cat-badge-${next.category || 'regulär'}">${meta.icon} ${meta.label}</span>
          </div>
          <button class="btn-open-next" data-id="${next.id}">Dienst öffnen →</button>
        </div>`;
      nextCardEl.querySelector('.btn-open-next').addEventListener('click', () =>
        openImportedShift(next.id));
    } else {
      nextCardEl.innerHTML = '';
    }
  }

  // ── List ────────────────────────────────────────────────────────────────
  let html = '';

  if (moreUpcoming.length) {
    html += `<div class="section-header">Geplante Dienste</div>`;
    html += moreUpcoming.map(s => {
      const meta = CATEGORY_META[s.category || 'regulär'];
      return `<div class="recent-item">
        <div class="shift-icon">${shiftIcon(s.type)}</div>
        <div class="recent-info">
          <div class="recent-name">${fmtDateShort(s.date)}</div>
          <div class="recent-meta">${shiftLabelFull(s)} · <span class="cat-badge cat-badge-${s.category || 'regulär'}">${meta.icon} ${meta.label}</span></div>
        </div>
        <button class="btn-open-imported" data-id="${s.id}">Öffnen</button>
      </div>`;
    }).join('');
  }

  if (past.length) {
    html += `<div class="section-header">Letzte Dienste</div>`;
    html += past.map(s => {
      const meta = s.category ? CATEGORY_META[s.category] : null;
      const catBadge = meta ? `<span class="cat-badge cat-badge-${s.category}">${meta.icon} ${meta.label}</span>` : '';
      return `<div class="recent-item shift-item-clickable" data-id="${s.id}">
        <div class="shift-icon">${shiftIcon(s.type)}</div>
        <div class="recent-info">
          <div class="recent-name">${fmtDateShort(s.date)} ${catBadge}</div>
          <div class="recent-meta">${shiftLabelFull(s)} · +${s.xpEarned} XP</div>
        </div>
        <span style="font-size:12px;color:var(--text-dim)">›</span>
      </div>`;
    }).join('');
  }

  if (!html && !next) {
    html = '<div class="empty-state">Noch keine Dienste. Erstelle deinen ersten Dienst unten!</div>';
  }

  if (listEl) {
    listEl.innerHTML = html;
    listEl.querySelectorAll('.shift-item-clickable').forEach(item =>
      item.addEventListener('click', () => openShiftDetailModal(parseInt(item.dataset.id))));
    listEl.querySelectorAll('.btn-open-imported').forEach(btn =>
      btn.addEventListener('click', () => openImportedShift(parseInt(btn.dataset.id))));
  }
}

async function openImportedShift(shiftId) {
  if (state.shifts.find(s => s.plannerActive)) {
    alert('Bitte zuerst den aktiven Dienst abschließen.');
    return;
  }
  await db.shiftLogs.update(shiftId, { plannerActive: true });
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerShiftId = shiftId;
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shiftId).sortBy('startHour');
  state.alarmFired = new Set();
  renderPlannerTab();
  startAlarmScheduler();
}

function setupPlannerListeners() {
  // Type buttons in planner
  document.querySelectorAll('#planner-type-selector .type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#planner-type-selector .type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Category buttons in planner
  document.querySelectorAll('#planner-category-selector .cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#planner-category-selector .cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('btn-start-planner-shift').addEventListener('click', startPlannerShift);
  document.getElementById('btn-close-planner-shift').addEventListener('click', closePlannerShift);
  document.getElementById('slot-add-close').addEventListener('click', () => document.getElementById('slot-add-modal').classList.add('hidden'));
  document.getElementById('slot-add-backdrop').addEventListener('click', () => document.getElementById('slot-add-modal').classList.add('hidden'));
  document.getElementById('btn-save-slot').addEventListener('click', saveSlot);
  document.getElementById('slot-detail-close').addEventListener('click', () => document.getElementById('slot-detail-modal').classList.add('hidden'));
  document.getElementById('slot-detail-backdrop').addEventListener('click', () => document.getElementById('slot-detail-modal').classList.add('hidden'));
  document.getElementById('slot-tips-close').addEventListener('click', () => document.getElementById('slot-tips-modal').classList.add('hidden'));
  document.getElementById('slot-tips-backdrop').addEventListener('click', () => document.getElementById('slot-tips-modal').classList.add('hidden'));

  // Slot type buttons inside add modal
  const grid = document.getElementById('slot-type-grid');
  grid.innerHTML = Object.entries(SLOT_TYPES).map(([key, def]) =>
    `<button class="slot-type-btn" data-type="${key}">
       <span>${def.icon}</span>
       <span>${def.label}</span>
       <span class="slot-type-xp">+${def.xp} XP</span>
     </button>`
  ).join('');
  grid.querySelectorAll('.slot-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.slot-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const def = SLOT_TYPES[btn.dataset.type];
      const flagsRow = document.getElementById('slot-flags-row');
      flagsRow.classList.toggle('hidden', btn.dataset.type !== 'erstgespraech');
      // Auto-set end time for fixed-duration types
      if (def.fixed && state.slotAddContext) {
        const endMins = toMins(state.slotAddContext.startH, state.slotAddContext.startM) + def.durationH * 60 + def.durationM;
        document.getElementById('slot-end-time').value = padT(Math.floor(endMins/60), endMins%60);
        setTimeToggleActive('end', endMins % 60);
      }
      if (state.slotAddContext) state.slotAddContext.selectedType = btn.dataset.type;
    });
  });

  document.querySelectorAll('.flag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const flag = btn.dataset.flag;
      if (!state.slotAddContext) return;
      const flags = state.slotAddContext.flags;
      if (btn.classList.contains('active')) { if (!flags.includes(flag)) flags.push(flag); }
      else { state.slotAddContext.flags = flags.filter(f => f !== flag); }
    });
  });

  // Notification permission banner
  const btnEnable = document.getElementById('btn-enable-notif');
  const btnDismiss = document.getElementById('btn-dismiss-notif');
  if (btnEnable) {
    btnEnable.addEventListener('click', async () => {
      await requestNotificationPermission();
      document.getElementById('notif-prompt-banner').classList.add('hidden');
      localStorage.setItem('notif-banner-dismissed', '1');
    });
  }
  if (btnDismiss) {
    btnDismiss.addEventListener('click', () => {
      document.getElementById('notif-prompt-banner').classList.add('hidden');
      localStorage.setItem('notif-banner-dismissed', '1');
    });
  }

  // :00 / :30 time toggles
  document.querySelectorAll('.time-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field === 'start' ? 'slot-start-time' : 'slot-end-time';
      const input = document.getElementById(field);
      const [h] = (input.value || '00:00').split(':').map(Number);
      const mins = parseInt(btn.dataset.mins);
      input.value = padT(h, mins);
      setTimeToggleActive(btn.dataset.field, mins);
    });
  });

  // Meal hint modal
  document.getElementById('meal-hint-close').addEventListener('click', () =>
    document.getElementById('meal-hint-modal').classList.add('hidden'));
  document.getElementById('meal-hint-backdrop').addEventListener('click', () =>
    document.getElementById('meal-hint-modal').classList.add('hidden'));
  document.getElementById('btn-save-meal-hint').addEventListener('click', saveMealHint);
  document.getElementById('btn-add-meal-hint').addEventListener('click', () => {
    const openShift = state.shifts.find(s => s.plannerActive);
    if (openShift) openMealModal(openShift);
  });

  // Meal preset buttons
  document.querySelectorAll('.meal-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mealModalIcon = btn.dataset.icon;
      const labelInput = document.getElementById('meal-label');
      if (!labelInput.value) labelInput.value = btn.dataset.label;
      document.querySelectorAll('.meal-preset-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
    });
  });
}

function setTimeToggleActive(field, mins) {
  document.querySelectorAll(`.time-toggle-btn[data-field="${field}"]`).forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.mins) === mins));
}

async function startPlannerShift() {
  const dateVal = document.getElementById('planner-date').value;
  if (!dateVal) { alert('Bitte Datum auswählen.'); return; }
  const activeBtn = document.querySelector('#planner-type-selector .type-btn.active');
  const type = activeBtn?.dataset.type || 'früh';
  const catBtn = document.querySelector('#planner-category-selector .cat-btn.active');
  const category = catBtn?.dataset.category || 'regulär';

  const shiftId = await db.shiftLogs.add({
    date: dateVal, type, category,
    xpEarned: 0, patientCount: 0,
    plannerShift: true, plannerActive: true,
    createdAt: new Date().toISOString(),
    mealHints: (MEAL_HINTS[type] || []).map((h, i) => ({ ...h, id: i + 1 })),
  });

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerShiftId = shiftId;
  state.plannerSlots = [];
  state.alarmFired = new Set();

  // Request notification permission once per session (non-blocking)
  requestNotificationPermission();

  renderPlannerTab();
}

async function closePlannerShift() {
  if (!state.plannerShiftId) return;
  if (!confirm('Dienst abschließen?')) return;

  const shift = state.shifts.find(s => s.id === state.plannerShiftId);
  if (!shift) return;

  const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
  const xpBase = Math.round(calculateShiftXP(shift.type) * modifier);
  const flame  = calculateFlameBonus(shift.date);
  const totalBase = xpBase + flame;

  await db.shiftLogs.update(state.plannerShiftId, {
    plannerActive: false,
    xpEarned: (shift.xpEarned || 0) + totalBase,
    closedAt: new Date().toISOString()
  });

  const oldXP = state.profile.totalXP ?? 0;
  const newXP = oldXP + totalBase;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerShiftId = null;
  state.plannerSlots   = [];
  stopAlarmScheduler();

  updateHeader();
  const bonuses = [{ label: `${shiftLabelFull(shift)} abgeschlossen`, xp: xpBase }];
  if (flame > 0) bonuses.push({ label: '⚡ Flame Bonus', xp: flame });
  showXPPopup(totalBase, bonuses);
  checkLevelUp(newXP, oldXP);

  renderPlannerTab();
  renderDashboard();
}

function openSlotAddModal(shiftId, startH, startM, source = 'planner') {
  state.slotAddContext = { shiftId, startH, startM, selectedType: null, flags: [], source };

  // Reset UI
  document.querySelectorAll('#slot-type-grid .slot-type-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.flag-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('slot-flags-row').classList.add('hidden');
  document.getElementById('slot-comment').value = '';
  document.getElementById('slot-start-time').value = padT(startH, startM);

  // Default end = startH + 1
  document.getElementById('slot-end-time').value = padT(startH + 1, startM);

  // Activate toggle buttons matching the initial minutes
  setTimeToggleActive('start', startM);
  setTimeToggleActive('end', startM);

  document.getElementById('slot-add-modal').classList.remove('hidden');
}

async function saveSlot() {
  const ctx = state.slotAddContext;
  if (!ctx?.selectedType) { alert('Bitte Eintragstyp auswählen.'); return; }

  const def = SLOT_TYPES[ctx.selectedType];
  const [sh, sm] = document.getElementById('slot-start-time').value.split(':').map(Number);
  const [eh, em] = document.getElementById('slot-end-time').value.split(':').map(Number);
  if (isNaN(sh) || isNaN(eh)) { alert('Bitte Zeiten ausfüllen.'); return; }
  if (toMins(eh, em) <= toMins(sh, sm)) { alert('Endzeit muss nach Startzeit liegen.'); return; }

  const comment = document.getElementById('slot-comment').value.trim();

  const shift = state.shifts.find(s => s.id === ctx.shiftId);
  const modifier = CATEGORY_XP_MODIFIER[shift?.category || 'regulär'];
  const xp = Math.round(def.xp * modifier);

  const slotId = await db.scheduleSlots.add({
    shiftId: ctx.shiftId, type: ctx.selectedType,
    startHour: sh, startMinute: sm,
    endHour: eh,   endMinute: em,
    flags: [...ctx.flags], comment,
    xpEarned: xp, createdAt: new Date().toISOString()
  });

  // Award XP
  const newShiftXP = (shift?.xpEarned || 0) + xp;
  await db.shiftLogs.update(ctx.shiftId, { xpEarned: newShiftXP });
  const oldXP = state.profile.totalXP ?? 0;
  const newXP = oldXP + xp;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(ctx.shiftId).sortBy('startHour');

  document.getElementById('slot-add-modal').classList.add('hidden');
  showXPPopup(xp, [{ label: def.label, xp }]);
  updateHeader();
  checkLevelUp(newXP, oldXP);
  applyAchievements();

  const updatedShift = state.shifts.find(s => s.id === ctx.shiftId);
  if (updatedShift) {
    if (ctx.source === 'detail') {
      renderShiftDetailBody(updatedShift);
    } else {
      updatePlannerXP(updatedShift);
      renderTimeline(updatedShift);
    }
  }

  // Offer to enter diagnoses for patient-contact slots
  if (def.patientContact) {
    setTimeout(() => {
      if (confirm(`${def.icon} ${def.label} gespeichert. Diagnosen jetzt eintragen?`)) {
        openAddToShiftDiagSearch(ctx.shiftId, slotId);
      }
    }, 300);
  }
}

async function deleteSlot(slotId, shift, source = 'planner') {
  const slot = await db.scheduleSlots.get(slotId);
  if (!slot) return;
  if (!confirm(`${SLOT_TYPES[slot.type]?.label || 'Eintrag'} löschen?`)) return;

  await db.scheduleSlots.delete(slotId);
  const xpBack = slot.xpEarned || 0;
  const newShiftXP = Math.max(0, (shift.xpEarned || 0) - xpBack);
  await db.shiftLogs.update(shift.id, { xpEarned: newShiftXP });
  const newXP = Math.max(0, (state.profile.totalXP ?? 0) - xpBack);
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
  updateHeader();
  const updatedShift = state.shifts.find(s => s.id === shift.id);
  if (!updatedShift) return;
  if (source === 'detail') {
    renderShiftDetailBody(updatedShift);
  } else {
    updatePlannerXP(updatedShift);
    renderTimeline(updatedShift);
  }
}

function openSlotDetailModal(slot, source = 'planner') {
  const def  = SLOT_TYPES[slot.type] || {};
  const tips = SLOT_TIPS[slot.type]  || {};
  const hasTips = !!(tips.sections?.length || tips.tips?.length || tips.docHint);
  const tipTotal = tips.sections ? tips.sections.reduce((s, sec) => s + sec.items.length, 0) : (tips.tips || []).length;
  const tipDone  = (slot.checkedTips || []).length;
  const isPatient = !!def.patientContact;

  const flagsHtml = slot.flags?.length
    ? `<div class="slot-flag-list">${slot.flags.map(f => `<span class="slot-flag">${f.toUpperCase()}</span>`).join('')}</div>`
    : '';
  const demoNote = slot.flags?.includes('demo')
    ? `<div class="slot-demo-reminder">🎓 Studierende ${slot.startHour}:${String(slot.startMinute).padStart(2,'0')} − 15 min = <strong>${padT(slot.startHour - (slot.startMinute < 15 ? 1 : 0), (slot.startMinute - 15 + 60) % 60)}</strong> im EG abholen!</div>`
    : '';

  const slotCatches = state.catches.filter(c => c.slotId === slot.id);
  const diagHtml = isPatient ? `
    <div class="slot-diag-section">
      <div class="slot-diag-header">
        Diagnosen
        <button class="slot-diag-add-inline" id="btn-slot-add-diag">＋</button>
      </div>
      ${slotCatches.length
        ? slotCatches.map(c => `
            <div class="slot-diag-row">
              <button class="slot-diag-check ${c.documented ? 'slot-diag-check-done' : ''}" data-catch-id="${c.id}" title="Dokumentiert">${c.documented ? '✓' : ''}</button>
              <span class="slot-diag-code">${c.code}</span>
              <span class="slot-diag-name ${c.documented ? 'slot-diag-done' : ''}">${c.name}</span>
              <button class="slot-diag-del btn-icon" data-catch-id="${c.id}" title="Entfernen">🗑</button>
            </div>`).join('')
        : '<div class="slot-diag-empty">Noch keine Diagnosen erfasst.</div>'}
    </div>` : '';

  document.getElementById('slot-detail-title').textContent = `${def.icon} ${def.label}`;
  document.getElementById('slot-detail-body').innerHTML = `
    <div class="slot-detail-time">${padT(slot.startHour,slot.startMinute)} – ${padT(slot.endHour,slot.endMinute)}</div>
    ${flagsHtml}
    ${demoNote}
    ${slot.comment ? `<div class="slot-comment-display">${slot.comment}</div>` : ''}
    ${diagHtml}
    <div class="slot-detail-actions">
      ${isPatient ? `<button class="btn-primary" id="btn-slot-add-diag-bar">＋ Diagnose</button>` : ''}
      ${hasTips ? `<button class="btn-secondary" id="btn-slot-tips">☑️ Checkliste${tipTotal ? ` <span class="tip-btn-count">${tipDone}/${tipTotal}</span>` : ''}</button>` : ''}
      <button class="btn-secondary" id="btn-slot-detail-edit">✏️</button>
      <button class="btn-danger"    id="btn-slot-detail-delete">🗑</button>
    </div>
  `;

  const shift = state.shifts.find(s => s.id === slot.shiftId);

  document.getElementById('btn-slot-tips')?.addEventListener('click', () => openSlotTipsModal(slot));
  document.getElementById('btn-slot-detail-edit').addEventListener('click', () => openSlotEditForm(slot, source));
  document.getElementById('btn-slot-detail-delete').addEventListener('click', async () => {
    document.getElementById('slot-detail-modal').classList.add('hidden');
    if (shift) await deleteSlot(slot.id, shift, source);
  });

  if (isPatient) {
    const openDiag = () => openSlotDiagCatch(slot, source);
    document.getElementById('btn-slot-add-diag')?.addEventListener('click', openDiag);
    document.getElementById('btn-slot-add-diag-bar')?.addEventListener('click', openDiag);
    document.querySelectorAll('.slot-diag-del').forEach(btn =>
      btn.addEventListener('click', () =>
        deleteSlotCatch(parseInt(btn.dataset.catchId), slot, source)));
    document.querySelectorAll('.slot-diag-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        const catchId = parseInt(btn.dataset.catchId);
        const c = state.catches.find(x => x.id === catchId);
        if (!c) return;
        c.documented = !c.documented;
        await db.caughtDiagnoses.update(catchId, { documented: c.documented });
        btn.classList.toggle('slot-diag-check-done', c.documented);
        btn.textContent = c.documented ? '✓' : '';
        btn.closest('.slot-diag-row').querySelector('.slot-diag-name')
          .classList.toggle('slot-diag-done', c.documented);
      });
    });
  }

  document.getElementById('slot-detail-modal').classList.remove('hidden');
}

function openSlotTipsModal(slot) {
  const def  = SLOT_TYPES[slot.type] || {};
  const tips = SLOT_TIPS[slot.type]  || {};
  const checked = new Set(slot.checkedTips || []);

  // Build flat list of { key, text } items
  const allItems = tips.sections
    ? tips.sections.flatMap((sec, si) => sec.items.map((t, ii) => ({ key: `${si}-${ii}`, text: t, section: sec.label, sectionIdx: si, itemIdx: ii })))
    : (tips.tips || []).map((t, ii) => ({ key: `flat-${ii}`, text: t, section: null }));

  const total = allItems.length;
  const doneCount = allItems.filter(it => checked.has(it.key)).length;

  const itemHtml = item => `
    <label class="tip-check-item ${checked.has(item.key) ? 'tip-check-done' : ''}" data-key="${item.key}">
      <span class="tip-check-box">${checked.has(item.key) ? '✓' : ''}</span>
      <span class="tip-check-text">${item.text}</span>
    </label>`;

  let bodyHtml = '';
  if (tips.sections) {
    bodyHtml = tips.sections.map((sec, si) => `
      <div class="slot-tips-header">${sec.label}</div>
      <div class="tip-check-list">${sec.items.map((t, ii) => itemHtml({ key: `${si}-${ii}`, text: t })).join('')}</div>`).join('');
  } else {
    bodyHtml = `<div class="tip-check-list">${(tips.tips || []).map((t, ii) => itemHtml({ key: `flat-${ii}`, text: t })).join('')}</div>`;
  }

  document.getElementById('slot-tips-title').textContent = `${def.icon} ${def.label} – Checkliste`;
  document.getElementById('slot-tips-body').innerHTML = `
    <div class="tip-progress-bar-wrap">
      <div class="tip-progress-bar" id="tip-progress-bar" style="width:${total ? Math.round(doneCount/total*100) : 0}%"></div>
    </div>
    <div class="tip-progress-label" id="tip-progress-label">${doneCount} / ${total} erledigt</div>
    ${bodyHtml}
    ${tips.docHint ? `<div class="slot-doc-hint">📄 ${tips.docHint}</div>` : ''}
  `;

  // Wire tap/click on each item
  document.getElementById('slot-tips-body').querySelectorAll('.tip-check-item').forEach(label => {
    label.addEventListener('click', async () => {
      const key = label.dataset.key;
      const nowChecked = label.classList.toggle('tip-check-done');
      label.querySelector('.tip-check-box').textContent = nowChecked ? '✓' : '';

      if (nowChecked) checked.add(key); else checked.delete(key);
      const newChecked = [...checked];

      // Update in-memory slot
      const mem = state.plannerSlots.find(s => s.id === slot.id);
      if (mem) mem.checkedTips = newChecked;
      slot.checkedTips = newChecked;

      // Persist
      await db.scheduleSlots.update(slot.id, { checkedTips: newChecked });

      // Update progress in tips modal
      const done = newChecked.length;
      document.getElementById('tip-progress-bar').style.width = `${total ? Math.round(done/total*100) : 0}%`;
      document.getElementById('tip-progress-label').textContent = `${done} / ${total} erledigt`;
      // Update counter badge on the button in slot detail modal (behind this modal)
      const badge = document.querySelector('#btn-slot-tips .tip-btn-count');
      if (badge) badge.textContent = `${done}/${total}`;
    });
  });

  document.getElementById('slot-tips-modal').classList.remove('hidden');
}

function openSlotDiagCatch(slot, source) {
  state.addToShiftContext = { shiftId: slot.shiftId, patientIndex: null, slotId: slot.id, slotSource: source };
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: true };
  document.getElementById('slot-detail-modal').classList.add('hidden');
  resetDiagSearchUI();
  document.getElementById('diagnosis-modal').classList.remove('hidden');
  document.getElementById('diag-search-input').focus();
}

async function deleteSlotCatch(catchId, slot, source) {
  const c = state.catches.find(x => x.id === catchId);
  if (!c) return;
  if (!confirm(`"${c.code}" aus diesem Termin entfernen?\n−${c.xpEarned} XP werden abgezogen.`)) return;
  await db.caughtDiagnoses.delete(catchId);
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - (c.xpEarned || 0));
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  const shift = state.shifts.find(s => s.id === slot.shiftId);
  if (shift) {
    await db.shiftLogs.update(shift.id, { xpEarned: Math.max(0, (shift.xpEarned || 0) - (c.xpEarned || 0)) });
  }
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  updateHeader();
  const freshSlot = await db.scheduleSlots.get(slot.id);
  if (freshSlot) openSlotDetailModal(freshSlot, source);
}

function openSlotEditForm(slot, source) {
  const def = SLOT_TYPES[slot.type] || {};
  document.getElementById('slot-detail-title').textContent = `✏️ ${def.icon} ${def.label}`;
  const hasDemo = slot.type === 'erstgespraech';

  document.getElementById('slot-detail-body').innerHTML = `
    <div class="form-row">
      <label class="form-label">Von</label>
      <input type="time" id="slot-edit-start" class="form-input" value="${padT(slot.startHour, slot.startMinute)}">
    </div>
    <div class="form-row">
      <label class="form-label">Bis</label>
      <input type="time" id="slot-edit-end" class="form-input" value="${padT(slot.endHour, slot.endMinute)}">
    </div>
    <div class="form-row">
      <label class="form-label">Kommentar</label>
      <textarea id="slot-edit-comment" class="form-input" rows="3" placeholder="Notiz…">${slot.comment || ''}</textarea>
    </div>
    ${hasDemo ? `
    <div class="form-row">
      <label class="form-label">Flags</label>
      <button class="flag-btn${slot.flags?.includes('demo') ? ' active' : ''}" id="slot-edit-flag-demo" data-flag="demo">🎓 Demo</button>
    </div>` : ''}
    <div class="slot-edit-btns">
      <button class="btn-primary"   id="btn-slot-edit-save">Speichern</button>
      <button class="btn-secondary" id="btn-slot-edit-cancel">Abbrechen</button>
    </div>
  `;

  if (hasDemo) {
    document.getElementById('slot-edit-flag-demo').addEventListener('click', e =>
      e.currentTarget.classList.toggle('active'));
  }

  document.getElementById('btn-slot-edit-cancel').addEventListener('click', () =>
    openSlotDetailModal(slot, source));

  document.getElementById('btn-slot-edit-save').addEventListener('click', () =>
    saveSlotEdit(slot, source));
}

async function saveSlotEdit(slot, source) {
  const startVal = document.getElementById('slot-edit-start').value;
  const endVal   = document.getElementById('slot-edit-end').value;
  const comment  = document.getElementById('slot-edit-comment').value.trim();
  if (!startVal || !endVal) { alert('Bitte Start- und Endzeit angeben.'); return; }

  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);

  const flags = [];
  const demoBtn = document.getElementById('slot-edit-flag-demo');
  if (demoBtn?.classList.contains('active')) flags.push('demo');

  await db.scheduleSlots.update(slot.id, {
    startHour: sh, startMinute: sm,
    endHour: eh,   endMinute: em,
    comment: comment || null,
    flags,
  });

  document.getElementById('slot-detail-modal').classList.add('hidden');

  const shift = state.shifts.find(s => s.id === slot.shiftId);
  if (!shift) return;

  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
  if (source === 'detail') {
    renderShiftDetailBody(shift);
  } else {
    renderTimeline(shift);
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

async function showSystemNotification(title, body, tag) {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      icon:  '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png',
      tag,
      renotify: false,
      silent: false,
    });
  } catch { /* SW not available – silent fail */ }
}

// ─── Meal Hint Modal ──────────────────────────────────────────────────────────
function openMealModal(shift, hint = null) {
  state.mealModalContext = { shift, hint };
  state.mealModalIcon = hint ? hint.icon : '☕';

  const now = new Date();
  document.getElementById('meal-time').value = hint
    ? padT(hint.h, hint.m)
    : padT(now.getHours(), 0);
  document.getElementById('meal-label').value = hint ? hint.label : '';

  document.querySelectorAll('.meal-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.icon === state.mealModalIcon && btn.dataset.label === (hint?.label ?? ''));
  });

  document.getElementById('meal-hint-modal').classList.remove('hidden');
}

async function saveMealHint() {
  const ctx = state.mealModalContext;
  if (!ctx) return;

  const timeVal = document.getElementById('meal-time').value;
  const labelVal = document.getElementById('meal-label').value.trim();
  if (!timeVal || !labelVal) { alert('Bitte Zeit und Bezeichnung angeben.'); return; }

  const [h, m] = timeVal.split(':').map(Number);
  const existing = getMealHints(ctx.shift);
  let updated;
  if (ctx.hint) {
    updated = existing.map(x => x.id === ctx.hint.id
      ? { ...x, h, m, icon: state.mealModalIcon, label: labelVal }
      : x);
  } else {
    const newId = existing.length ? Math.max(...existing.map(x => x.id)) + 1 : 1;
    updated = [...existing, { id: newId, h, m, icon: state.mealModalIcon, label: labelVal }];
  }

  await db.shiftLogs.update(ctx.shift.id, { mealHints: updated });
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  document.getElementById('meal-hint-modal').classList.add('hidden');

  const fresh = state.shifts.find(s => s.id === ctx.shift.id);
  if (fresh && state.plannerShiftId === fresh.id) renderTimeline(fresh);
}

// ─── Alarm Scheduler ──────────────────────────────────────────────────────────
function startAlarmScheduler() {
  stopAlarmScheduler();
  state.alarmInterval = setInterval(checkAlarms, 60_000);
  checkAlarms();
}
function stopAlarmScheduler() {
  if (state.alarmInterval) { clearInterval(state.alarmInterval); state.alarmInterval = null; }
}

function checkAlarms() {
  if (!state.plannerShiftId || !state.plannerSlots.length) return;
  const now     = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  // Is patient contact happening right now?
  const patientNow = state.plannerSlots.some(s => {
    if (!SLOT_TYPES[s.type]?.patientContact) return false;
    return toMins(s.startHour, s.startMinute) <= nowMins && nowMins < toMins(s.endHour, s.endMinute);
  });
  if (patientNow) return;

  // Find slots starting in 9–11 minutes
  for (const slot of state.plannerSlots) {
    if (state.alarmFired.has(slot.id)) continue;
    const diff = toMins(slot.startHour, slot.startMinute) - nowMins;
    if (diff >= 9 && diff <= 11) {
      const def  = SLOT_TYPES[slot.type] || {};
      const time = padT(slot.startHour, slot.startMinute);
      const msg  = `${def.icon || '⏰'} ${def.label} um ${time}`;

      // In-app banner
      const banner = document.getElementById('planner-alarm-banner');
      if (banner) {
        banner.textContent = `⏰ In ~10 min: ${msg}`;
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 10_000);
      }

      // System notification (Android / iOS 16.4+ installed PWA)
      showSystemNotification(
        `⏰ In ~10 Minuten`,
        msg,
        `alarm-slot-${slot.id}`
      );

      state.alarmFired.add(slot.id);
    }
  }
}

// ─── Shift Form ───────────────────────────────────────────────────────────────
function setDefaultDate() {
  const today = new Date().toISOString().split('T')[0];
  const el1 = document.getElementById('shift-date');
  if (el1) el1.value = today;
  const el2 = document.getElementById('planner-date');
  if (el2 && !el2.value) el2.value = today;
}

function setupShiftListeners() {
  // Legacy shift form elements (may not exist if replaced by planner)
  document.getElementById('btn-next-to-patients')?.addEventListener('click', goToPatients);
  document.getElementById('btn-back-to-info')?.addEventListener('click', goBackToInfo);
  document.getElementById('btn-add-patient')?.addEventListener('click', addPatientCard);
  document.getElementById('btn-finish-shift')?.addEventListener('click', finishShift);
}

function resetShiftForm() {
  document.getElementById('patient-list') && (document.getElementById('patient-list').innerHTML = '');
  state.activeShift = null;
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
    <div class="cat-detail-img-banner">
      <img src="assets/images/diagnoses/${diagnosis.code.toLowerCase()}.png" class="cat-detail-img-full" alt=""
           onerror="this.parentElement.style.display='none'">
    </div>
    <div class="cat-detail-heading">
      <div class="diag-code-big">${diagnosis.code}</div>
      <div class="diag-name-big" style="font-size:14px">${diagnosis.name}</div>
      <div class="xp-preview-chips" style="margin-top:6px">
        <span class="xp-chip base">Basis: ${preview.base} XP</span>
        <span style="font-size:10px;font-weight:700;color:${rarColor}">${rarLabel}</span>
        ${preview.isFirstDiag   ? '<span class="xp-chip bonus-diag">+50 Erste!</span>' : ''}
        ${preview.komorbidBonus ? '<span class="xp-chip bonus-k">+20%</span>' : ''}
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
  const base = 15 * diagnosis.seltenheit_score;
  let total  = base;
  const isFirstDiag = !caughtCodes.has(diagnosis.code);
  const isFirstKat  = !caughtKats.has(normalizeKat(diagnosis.kategorie));
  if (isFirstDiag) total += 50;
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
  renderHourCountersSettings();
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
    <span><strong>${fmtDateShort(shift.date)}</strong> · ${shiftLabelFull(shift)} · +${shift.xpEarned} XP · ${shift.patientCount} Pat.</span>
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

async function renderShiftDetailBody(shift) {
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
  const actualPatientCount = patientMap.size;
  if (shift.patientCount !== actualPatientCount) {
    db.shiftLogs.update(shift.id, { patientCount: actualPatientCount });
    shift.patientCount = actualPatientCount;
  }
  const noteXPPreview = !shift.noteAddedAt
    ? `+${calculateNoteXP(shift.date, new Date().toISOString())} XP jetzt`
    : '';
  let html = `
    <div class="shift-detail-header">
      <div class="shift-detail-info">
        <div class="shift-detail-date">${shiftIcon(shift.type)} ${fmtDateShort(shift.date)} · ${shiftLabelFull(shift)}</div>
        <div class="shift-detail-meta">+${shift.xpEarned} XP · ${actualPatientCount} Patient(en)</div>
        <div class="shift-timestamps">
          <span>📅 ${fmtDateTime(shift.createdAt)}</span>
          ${shift.updatedAt ? `<span>✏️ ${fmtDateTime(shift.updatedAt)}</span>` : ''}
        </div>
      </div>
      <button class="btn-icon" id="btn-edit-this-shift" data-id="${shift.id}" title="Bearbeiten">✎</button>
    </div>
    <div class="shift-note-section">
      <div class="shift-note-header">
        <span class="shift-note-label">📝 Dienst-Log</span>
        ${!shift.noteAddedAt
          ? `<span class="shift-note-xp-hint">Noch kein Log — jetzt schreiben für <strong>${noteXPPreview}</strong></span>`
          : `<span class="shift-note-timestamp">Geloggt: ${fmtDateTime(shift.noteAddedAt)}</span>`}
      </div>
      <textarea class="shift-note-textarea" id="shift-note-area" placeholder="Wie war der Dienst? Besondere Fälle, Eindrücke, Lernpunkte…" rows="4">${shift.note || ''}</textarea>
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
      html += `<div class="patient-diag-row pd-row-clickable" data-code="${c.code}">
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
  </button>`;

  // Planner slots section
  if (shift.plannerShift) {
    const shiftSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
    if (shiftSlots.length || true) {
      html += `<div class="detail-slots-section">
        <div class="detail-slots-header">
          <span class="detail-slots-title">📋 Planer-Einträge</span>
          <button class="btn-secondary detail-add-slot-btn" id="btn-detail-add-slot">+ Eintrag</button>
        </div>
        <div class="detail-slots-list">
          ${shiftSlots.length ? shiftSlots.map(sl => {
            const def = SLOT_TYPES[sl.type] || {};
            return `<div class="detail-slot-row" data-slot-id="${sl.id}">
              <span class="detail-slot-icon">${def.icon || '📌'}</span>
              <div class="detail-slot-info">
                <span class="detail-slot-label">${def.label || sl.type}</span>
                <span class="detail-slot-time">${padT(sl.startHour,sl.startMinute)}–${padT(sl.endHour,sl.endMinute)} · +${sl.xpEarned} XP</span>
                ${sl.comment ? `<span class="detail-slot-comment">${sl.comment}</span>` : ''}
              </div>
              <button class="btn-icon detail-slot-del" data-slot-id="${sl.id}">🗑</button>
            </div>`;
          }).join('') : '<div class="detail-slots-empty">Keine Einträge</div>'}
        </div>
      </div>`;
    }
  }

  html += `<button class="btn-danger" id="btn-delete-this-shift" data-id="${shift.id}">🗑 Dienst löschen</button>`;

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

  body.querySelectorAll('.pd-row-clickable').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.btn-delete-shift-catch')) return;
      openDiagInfoModal(row.dataset.code);
    });
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

  const noteArea = body.querySelector('#shift-note-area');
  if (noteArea) {
    let noteTimer = null;
    noteArea.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => saveShiftNote(shift, noteArea.value), 1200);
    });
    noteArea.addEventListener('blur', () => {
      clearTimeout(noteTimer);
      saveShiftNote(shift, noteArea.value);
    });
  }

  // Planner slot actions
  body.querySelector('#btn-detail-add-slot')?.addEventListener('click', () => {
    const { start } = shiftHours(shift.type);
    openSlotAddModal(shift.id, start[0], start[1], 'detail');
  });
  body.querySelectorAll('.detail-slot-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSlot(parseInt(btn.dataset.slotId), shift, 'detail');
    });
  });
  body.querySelectorAll('.detail-slot-row').forEach(row => {
    row.addEventListener('click', async e => {
      if (e.target.closest('.detail-slot-del')) return;
      const slot = await db.scheduleSlots.get(parseInt(row.dataset.slotId));
      if (slot) openSlotDetailModal(slot, 'detail');
    });
  });
}

async function saveShiftNote(shift, noteText) {
  const hadNote = !!(shift.note && shift.note.trim().length > 0);
  const isNew   = !hadNote && noteText.trim().length > 0;
  const now     = new Date().toISOString();
  const updates = { note: noteText };
  if (isNew) updates.noteAddedAt = now;

  await db.shiftLogs.update(shift.id, updates);
  shift.note = noteText;

  if (isNew) {
    shift.noteAddedAt = now;
    const noteXP = calculateNoteXP(shift.date, now);
    const oldXP  = state.profile.totalXP ?? 0;
    const newXP  = oldXP + noteXP;
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();

    const header = document.querySelector('.shift-note-header');
    if (header) {
      header.innerHTML = `<span class="shift-note-label">📝 Dienst-Log</span><span class="shift-note-timestamp">Geloggt: ${fmtDateTime(now)}</span>`;
    }
    showXPPopup(noteXP, [{ label: 'Dienst geloggt!', xp: noteXP }]);
    updateHeader();
    checkLevelUp(newXP, oldXP);
    applyAchievements();
  } else {
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  }
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

  const fromSlotId  = state.addToShiftContext?.slotId   ?? null;
  const fromSlotSrc = state.addToShiftContext?.slotSource ?? 'planner';

  await db.caughtDiagnoses.add({
    code: diagnosis.code, name: diagnosis.name,
    kategorie: diagnosis.kategorie, shiftId,
    ageGroup, gender, patientType,
    patientIndex: patientIndex ?? 0,
    hasComorbidity, xpEarned: xpResult.total,
    checkedSymptoms: checkedSymptoms || [],
    caughtAt: new Date().toISOString(),
    slotId: fromSlotId,
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

  if (fromSlotId) {
    const freshSlot = await db.scheduleSlots.get(fromSlotId);
    if (freshSlot) openSlotDetailModal(freshSlot, fromSlotSrc);
  } else {
    openShiftDetailModal(shiftId);
  }
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
  if (state.hoursModalCounter == null) {
    const counters = state.profile?.hourCounters || [];
    state.hoursModalCounter = counters[0]?.id ?? null;
  }
  renderHoursModalBody();
  document.getElementById('hours-modal').classList.remove('hidden');
}

function buildDonut(segments) {
  // segments: [{ pct, color }]
  const r = 40, cx = 50, cy = 50, stroke = 14;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const paths = segments.map(({ pct, color }) => {
    const len = (pct / 100) * circ;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
      stroke-width="${stroke}" stroke-dasharray="${len} ${circ - len}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
    return el;
  });
  return `<svg width="100" height="100" viewBox="0 0 100 100">${paths.join('')}</svg>`;
}

function renderHoursModalBody() {
  const body     = document.getElementById('hours-modal-body');
  const counters = state.profile?.hourCounters || [];
  const counter  = counters.find(c => c.id === state.hoursModalCounter) || counters[0];
  const baseShifts = counter?.fromDate
    ? state.shifts.filter(s => s.date >= counter.fromDate)
    : state.shifts;
  const all      = baseShifts;
  const filtered = state.hoursFilter === 'all' ? all : all.filter(s => s.type === state.hoursFilter);
  const totalH   = counter ? calcCounterHours(counter) : calcTotalHours();
  const targetH  = counter?.targetHours || 480;
  const extra    = getExtraHoursTotal();

  const types = ['früh','spät','full','samstag','schulung'];
  const typeCounts = Object.fromEntries(types.map(t => [t, all.filter(s=>s.type===t)]));
  const typeHours  = Object.fromEntries(types.map(t => [t, typeCounts[t].reduce((s,sh)=>s+calcShiftHours(sh),0)]));
  const nFr = typeCounts['früh'].length, nSp = typeCounts['spät'].length,
        nFu = typeCounts['full'].length, nSa = typeCounts['samstag'].length,
        nSc = typeCounts['schulung'].length;

  const shiftH = Object.values(typeHours).reduce((a,b)=>a+b, 0);
  const donutSegments = shiftH > 0 ? [
    { pct: (typeHours['früh']    / shiftH) * 100, color: '#3b82f6' },
    { pct: (typeHours['spät']    / shiftH) * 100, color: '#8b5cf6' },
    { pct: (typeHours['full']    / shiftH) * 100, color: '#f59e0b' },
    { pct: (typeHours['samstag'] / shiftH) * 100, color: '#10b981' },
    { pct: (typeHours['schulung']/ shiftH) * 100, color: '#6366f1' },
  ].filter(s => s.pct > 0) : [];

  const fromDate = counter?.fromDate ? all.reduce((min,s) => s.date < min ? s.date : min, counter.fromDate) : (all.length ? [...all].sort((a,b)=>a.date.localeCompare(b.date))[0]?.date : null);
  const toDate   = all.length ? [...all].sort((a,b)=>b.date.localeCompare(a.date))[0]?.date : null;
  const fmtD = d => d ? new Date(d+'T12:00:00').toLocaleDateString('de-AT',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–';

  const counterTabs = counters.length > 1 ? `
    <div class="hours-counter-tabs">
      ${counters.map(c=>`<button class="hct-btn${c.id===counter?.id?' active':''}" data-cid="${c.id}">${c.name}</button>`).join('')}
    </div>` : '';

  body.innerHTML = `
    ${counterTabs}
    <div class="hours-summary">
      <div class="hours-donut">${donutSegments.length ? buildDonut(donutSegments) : '<div class="donut-empty">–</div>'}</div>
      <div class="hours-summary-info">
        <div class="hours-total">${totalH.toFixed(1).replace('.0','')}h <span style="font-size:14px;color:var(--text-dim)">/ ${targetH}h</span></div>
        <div class="hours-label">${counter?.name || 'Gesamt'}</div>
        <div class="hours-range">${fmtD(fromDate)} – ${fmtD(toDate)}</div>
        <div class="hours-type-legend">
          ${nFr ? `<span style="color:#3b82f6">🌅 ${nFr}×</span>` : ''}
          ${nSp ? `<span style="color:#8b5cf6">🌇 ${nSp}×</span>` : ''}
          ${nFu ? `<span style="color:#f59e0b">☀️ ${nFu}×</span>` : ''}
          ${nSa ? `<span style="color:#10b981">🗓️ ${nSa}×</span>` : ''}
          ${nSc ? `<span style="color:#6366f1">📚 ${nSc}×</span>` : ''}
          ${extra > 0 ? `<span style="color:var(--text-dim)">+${extra.toFixed(1).replace('.0','')}h Extra</span>` : ''}
        </div>
      </div>
    </div>
    <div class="hours-filter-row">
      <button class="hours-filter-btn${state.hoursFilter==='all'?' active':''}" data-filter="all">Alle (${all.length})</button>
      ${nFr ? `<button class="hours-filter-btn${state.hoursFilter==='früh'?' active':''}" data-filter="früh">🌅 Früh</button>` : ''}
      ${nSp ? `<button class="hours-filter-btn${state.hoursFilter==='spät'?' active':''}" data-filter="spät">🌇 Spät</button>` : ''}
      ${nFu ? `<button class="hours-filter-btn${state.hoursFilter==='full'?' active':''}" data-filter="full">☀️ Ganztags</button>` : ''}
      ${nSa ? `<button class="hours-filter-btn${state.hoursFilter==='samstag'?' active':''}" data-filter="samstag">🗓️ Samstag</button>` : ''}
    </div>
    <div class="hours-list">
      ${filtered.length ? filtered.map(s => `
        <div class="hours-row" data-id="${s.id}">
          <div class="hours-row-icon">${shiftIcon(s.type)}</div>
          <div class="hours-row-info">
            <div class="hours-row-date">${fmtDateShort(s.date)}</div>
            <div class="hours-row-meta">${shiftLabelFull(s)} · +${s.xpEarned} XP · ${s.patientCount} Pat.</div>
          </div>
          <div class="hours-row-val">${calcShiftHours(s).toFixed(1).replace('.0','')}h</div>
        </div>`).join('')
      : '<div class="empty-state">Keine Dienste in diesem Zeitraum.</div>'}
    </div>`;

  body.querySelectorAll('.hct-btn').forEach(btn =>
    btn.addEventListener('click', () => { state.hoursModalCounter = parseInt(btn.dataset.cid); state.hoursFilter = 'all'; renderHoursModalBody(); }));
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

const fmtDateLong = ds =>
  new Date(ds + 'T12:00:00').toLocaleDateString('de-AT', { weekday:'long', day:'numeric', month:'long' });

const shiftIcon  = t => t === 'full' ? '☀️' : t === 'spät' ? '🌇' : t === 'samstag' ? '🗓️' : t === 'schulung' ? '📚' : '🌅';
const shiftLabel = t => t === 'full' ? 'Ganztags 12h' : t === 'spät' ? 'Spät 6,5h' : t === 'samstag' ? 'Samstag 7h' : t === 'schulung' ? 'Schulung 6h' : 'Früh 6,5h';

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
    <div class="cat-detail-img-banner">
      <img src="assets/images/diagnoses/${diag.code.toLowerCase()}.png" class="cat-detail-img-full" alt=""
           onerror="this.parentElement.style.display='none'">
    </div>
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
  document.getElementById('xml-import-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    await importShiftsFromXML(text);
    e.target.value = '';
  });
}

async function exportData() {
  const shifts   = await db.shiftLogs.toArray();
  const catches  = await db.caughtDiagnoses.toArray();
  const missions = await db.missions.toArray();
  const achievements = await db.unlockedAchievements.toArray();
  const slots    = await db.scheduleSlots.toArray();
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    profile:      { totalXP: state.profile?.totalXP ?? 0 },
    shifts:       shifts.map(({ id, ...s }) => s),
    catches:      catches.map(({ id, ...c }) => c),
    missions:     missions.map(({ id, ...m }) => m),
    achievements: achievements.map(({ id, ...a }) => a),
    slots:        slots.map(({ id, ...sl }) => sl),
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
    const achCount  = data.achievements?.length ?? 0;
    const msnCount  = data.missions?.length ?? 0;
    const slotCount = data.slots?.length ?? 0;
    if (!confirm(`Alle aktuellen Daten werden ersetzt.\n${data.shifts.length} Dienste, ${data.catches.length} Diagnosen, ${slotCount} Planer-Einträge, ${achCount} Achievements, ${msnCount} Missionen werden importiert.\n\nFortfahren?`)) return;

    await db.profile.clear();
    await db.shiftLogs.clear();
    await db.caughtDiagnoses.clear();
    if (db.missions)             await db.missions.clear();
    if (db.unlockedAchievements) await db.unlockedAchievements.clear();
    if (db.scheduleSlots)        await db.scheduleSlots.clear();

    await db.profile.add({ totalXP: data.profile?.totalXP ?? 0, createdAt: new Date().toISOString() });
    for (const s of data.shifts)  await db.shiftLogs.add(s);
    for (const c of data.catches) await db.caughtDiagnoses.add(c);
    if (db.missions && Array.isArray(data.missions))
      for (const m of data.missions) await db.missions.add(m);
    if (db.unlockedAchievements && Array.isArray(data.achievements))
      for (const a of data.achievements) await db.unlockedAchievements.add(a);
    if (db.scheduleSlots && Array.isArray(data.slots))
      for (const sl of data.slots) await db.scheduleSlots.add(sl);

    await loadFromDB();
    renderApp();
    alert(`Import erfolgreich: ${data.shifts.length} Dienste, ${data.catches.length} Diagnosen, ${slotCount} Planer-Einträge, ${achCount} Achievements geladen.`);
    navigateTo('stats');
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
  e.target.value = '';
}

async function importShiftsFromXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) { alert('XML-Fehler: Datei konnte nicht gelesen werden.'); return; }

  const dienste = Array.from(doc.querySelectorAll('dienst'));
  if (!dienste.length) { alert('Keine Dienste in der XML-Datei gefunden.'); return; }

  const halbtagToType = { AM: 'früh', PM: 'spät', SAT: 'samstag', FULL: 'full' };

  const getCategory = (typ, spalte) => {
    if (typ === 'training') return 'training';
    if ((spalte || '').toLowerCase().includes('senior')) return 'senior';
    return 'regulär';
  };

  const existingShifts = await db.shiftLogs.toArray();
  const existingKeys = new Set(existingShifts.map(s => `${s.date}_${s.type}`));

  let imported = 0, skipped = 0;

  for (const el of dienste) {
    const datum   = el.getAttribute('datum');
    const halbtag = el.getAttribute('halbtag');
    const typ     = el.getAttribute('typ') || '';
    const spalte  = el.getAttribute('spalte') || '';

    if (!datum || !halbtag) { skipped++; continue; }

    const type = halbtagToType[halbtag] || 'spät';
    const category = getCategory(typ, spalte);
    const key = `${datum}_${type}`;

    if (existingKeys.has(key)) { skipped++; continue; }

    await db.shiftLogs.add({
      date: datum, type, category,
      xpEarned: 0, patientCount: 0,
      plannerShift: true, plannerActive: false,
      importedFrom: 'xml',
      createdAt: new Date().toISOString()
    });
    existingKeys.add(key);
    imported++;
  }

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  renderPlannerTab();
  renderDashboard();
  alert(`XML importiert: ${imported} neue Dienste angelegt, ${skipped} übersprungen.`);
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
  // Use shift.date (actual shift day) as event time — not createdAt (logging day)
  state.shifts.forEach(s => {
    const time = s.date ? s.date + 'T12:00:00.000Z' : s.createdAt;
    if (time) events.push({ time, xp: s.xpEarned || 0 });
    if (s.noteAddedAt && s.note?.trim()) {
      events.push({ time: s.noteAddedAt, xp: calculateNoteXP(s.date, s.noteAddedAt) });
    }
  });
  state.catches.filter(c => !c.shiftId).forEach(c => { if (c.caughtAt) events.push({ time: c.caughtAt, xp: c.xpEarned || 0 }); });
  (state.unlockedAchievements || []).forEach(a => {
    if (!a.unlockedAt) return;
    const def = ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (def) { events.push({ time: a.unlockedAt, xp: def.tiers[a.tier - 1]?.xp ?? 0 }); return; }
    const sec = SECRET_ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (sec) events.push({ time: a.unlockedAt, xp: sec.xp ?? 0 });
  });
  (state.missions || []).forEach(m => {
    if (!m.completedAt) return;
    const def = MISSION_POOL.find(x => x.id === m.missionId);
    if (def) events.push({ time: m.completedAt, xp: def.reward ?? 0 });
  });
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
      const hasXP      = xp >= rank.xpRequired;
      const unlockDate = unlockDates[rank.level];
      const isUnlocked = hasXP;
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
            ${isUnlocked && unlockDate ? `<div class="rank-table-date">${fmtD(unlockDate)}</div>` : ''}
            ${!isUnlocked ? `<div class="rank-table-xp-needed">${rank.xpRequired.toLocaleString('de-AT')} XP</div>` : ''}
          </div>
        </div>`;
    }).join('')}`;
  document.getElementById('rank-table-modal').classList.remove('hidden');
}

async function recalculateXP() {
  if (!confirm('XP komplett neu berechnen?\n\nAlle Diagnosen werden mit der aktuellen Formel neu kalkuliert und gespeichert.')) return;

  const btn = document.getElementById('recalc-xp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Berechne…'; }

  // All catches in chronological order to replay bonus logic correctly
  const allCatches = await db.caughtDiagnoses.orderBy('caughtAt').toArray();

  const seenCodes = new Set();
  const seenKats  = new Set();
  const patientCatchCount = new Map(); // "shiftId_patientIndex" → count

  for (const c of allCatches) {
    const diagDef    = state.icdFlat.find(d => d.code === c.code);
    const seltenheit = diagDef?.seltenheit_score ?? 5;
    const kat        = normalizeKat(c.kategorie);

    const patKey        = `${c.shiftId}_${c.patientIndex}`;
    const prevCount     = patientCatchCount.get(patKey) ?? 0;
    const hasComorbidity = c.shiftId != null && c.patientIndex != null && prevCount >= 1;

    const result = calculateCatchXP(
      { code: c.code, seltenheit_score: seltenheit, kategorie: kat },
      hasComorbidity, seenCodes, seenKats
    );

    await db.caughtDiagnoses.update(c.id, { xpEarned: result.total });
    c.xpEarned = result.total;

    seenCodes.add(c.code);
    seenKats.add(kat);
    patientCatchCount.set(patKey, prevCount + 1);
  }

  // Build lookup tables
  const allShifts = await db.shiftLogs.toArray();
  const allSlots  = await db.scheduleSlots.toArray();

  const catchesByShift = {};
  allCatches.forEach(c => {
    if (c.shiftId != null) {
      (catchesByShift[c.shiftId] = catchesByShift[c.shiftId] || []).push(c);
    }
  });
  const slotsByShift = {};
  allSlots.forEach(sl => {
    (slotsByShift[sl.shiftId] = slotsByShift[sl.shiftId] || []).push(sl);
  });

  let totalXP = 0;
  for (const shift of allShifts) {
    let newShiftXP;
    if (shift.plannerShift) {
      // Planner shift: category-modified base + flame only when closed; slots counted separately
      const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
      const base  = shift.plannerActive ? 0 : Math.round(calculateShiftXP(shift.type) * modifier);
      const closedRef = new Date(shift.closedAt || shift.createdAt || shift.date);
      const flame = (!shift.plannerActive && (closedRef - new Date(shift.date)) / 3600000 <= 24) ? 25 : 0;
      const catchSum = (catchesByShift[shift.id] || []).reduce((s, c) => s + c.xpEarned, 0);
      const slotSum  = (slotsByShift[shift.id]  || []).reduce((s, sl) => s + (sl.xpEarned || 0), 0);
      newShiftXP = base + flame + catchSum + slotSum;
    } else {
      const shiftBase = calculateShiftXP(shift.type);
      const createdAt = new Date(shift.createdAt || shift.date);
      const flame = (createdAt - new Date(shift.date)) / 3600000 <= 24 ? 25 : 0;
      const catchSum = (catchesByShift[shift.id] || []).reduce((s, c) => s + c.xpEarned, 0);
      newShiftXP = shiftBase + flame + catchSum;
    }
    await db.shiftLogs.update(shift.id, { xpEarned: newShiftXP });
    totalXP += newShiftXP;
  }

  // Standalone catches (no shift)
  totalXP += allCatches.filter(c => c.shiftId == null).reduce((s, c) => s + c.xpEarned, 0);

  // Non-planner slot XP (safety: should be 0, all slots belong to planner shifts)
  totalXP += allSlots
    .filter(sl => !allShifts.find(s => s.id === sl.shiftId && s.plannerShift))
    .reduce((sum, sl) => sum + (sl.xpEarned || 0), 0);

  // Achievements
  const unlocked = await db.unlockedAchievements.toArray();
  totalXP += unlocked.reduce((sum, a) => {
    const def = ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (def) return sum + (def.tiers[a.tier - 1]?.xp ?? 0);
    const sec = SECRET_ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (sec) return sum + (sec.xp ?? 0);
    return sum;
  }, 0);

  // Missions
  const missions = await db.missions.toArray();
  totalXP += missions.reduce((sum, m) => {
    if (!m.completedAt) return sum;
    const def = MISSION_POOL.find(x => x.id === m.missionId);
    return sum + (def?.reward ?? 0);
  }, 0);

  // Shift notes
  totalXP += allShifts
    .filter(s => s.noteAddedAt)
    .reduce((sum, s) => sum + calculateNoteXP(s.date, s.noteAddedAt), 0);

  await db.profile.update(state.profile.id, { totalXP });
  state.profile.totalXP = totalXP;
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();

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

// ─── Hour Counters Settings ───────────────────────────────────────────────────
function renderHourCountersSettings() {
  const el = document.getElementById('hour-counters-settings');
  if (!el) return;
  const counters = state.profile?.hourCounters || [];
  el.innerHTML = counters.map((c, i) => `
    <div class="hcs-item" data-id="${c.id}">
      <div class="hcs-row">
        <input class="setting-input hcs-name" type="text" value="${c.name}" placeholder="Name" data-id="${c.id}">
        ${counters.length > 1 ? `<button class="btn-icon hcs-del" data-id="${c.id}" title="Löschen">🗑</button>` : ''}
      </div>
      <div class="hcs-row">
        <label class="hcs-sub">Ziel</label>
        <input class="setting-input hcs-target" type="number" value="${c.targetHours}" min="1" max="5000" style="width:80px" data-id="${c.id}">
        <span class="hcs-sub">h</span>
        <label class="hcs-sub" style="margin-left:8px">Ab</label>
        <input class="setting-input hcs-from" type="date" value="${c.fromDate || ''}" data-id="${c.id}" style="flex:1;min-width:0">
      </div>
    </div>`).join('') +
    (counters.length < 2 ? `<button id="btn-add-counter" class="btn-secondary" style="width:100%;margin-top:8px;padding:8px;font-size:12px">+ Zweiten Zähler hinzufügen</button>` : '');

  el.querySelectorAll('.hcs-name').forEach(inp => inp.addEventListener('change', async e => {
    await updateCounter(parseInt(e.target.dataset.id), { name: e.target.value.trim() || 'Zähler' });
  }));
  el.querySelectorAll('.hcs-target').forEach(inp => inp.addEventListener('change', async e => {
    const val = parseInt(e.target.value);
    if (val > 0) await updateCounter(parseInt(e.target.dataset.id), { targetHours: val });
  }));
  el.querySelectorAll('.hcs-from').forEach(inp => inp.addEventListener('change', async e => {
    await updateCounter(parseInt(e.target.dataset.id), { fromDate: e.target.value || null });
  }));
  el.querySelectorAll('.hcs-del').forEach(btn => btn.addEventListener('click', async () => {
    const id = parseInt(btn.dataset.id);
    const updated = (state.profile.hourCounters || []).filter(c => c.id !== id);
    await saveCounters(updated);
    renderHourCountersSettings();
    renderHoursCounters();
  }));
  const addBtn = el.querySelector('#btn-add-counter');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const newId = Date.now();
    const updated = [...(state.profile.hourCounters || []),
      { id: newId, name: 'Zähler 2', targetHours: 480, fromDate: null }];
    await saveCounters(updated);
    renderHourCountersSettings();
    renderHoursCounters();
  });
}

async function saveCounters(counters) {
  await db.profile.update(state.profile.id, { hourCounters: counters });
  state.profile.hourCounters = counters;
}

async function updateCounter(id, patch) {
  const counters = (state.profile.hourCounters || []).map(c => c.id === id ? { ...c, ...patch } : c);
  await saveCounters(counters);
  renderHoursCounters();
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
  // counter settings are wired in renderHourCountersSettings
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
