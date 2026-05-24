import db from './db.js';
import { loadAllICD, searchDiagnoses } from './icd-loader.js';
import { calculateCatchXP, calculateShiftXP, calculateFlameBonus, calculateNoteXP, SLOT_TYPES, SHIFT_HOURS, MEAL_HINTS, BREAK_PRESETS, SLOT_TIPS, CATEGORY_XP_MODIFIER, CATEGORY_META, ROULETTE_DROPS, DIAGNOSTIC_VERIFY_XP, CONSUMABLE_XP } from './xp-engine.js';
import { RANKS, getRankForXP, getNextRank } from './ranks.js';
import { MISSION_POOL, TIER_LABELS, calcMissionProgress, pickNewMission } from './missions.js';
import { checkAchievements, ACHIEVEMENTS, SECRET_ACHIEVEMENTS, ACH_TIER_LABELS } from './achievements.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  currentTab: 'home',
  homeSelectedShiftId: null,
  expandedSlotId: null,
  collapsedSlotIds: new Set(),
  calMonth: null,
  icdfCollection: { symptoms: [], diagnoses: [] },
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
  statsSubTab: 'overview',
  swipeDir: null,
  supLogs: [],
  supHours: 0,
};

let _editingSuspectedCodes = []; // working copy while slot-edit form is open

// ─── Team / Colleague Constants ───────────────────────────────────────────────
const TAG_ICONS = {
  'favorit-a': '♥',
  'favorit-b': '♡',
  'favorit-c': '♦',
  'adhd':      'Ⓐ',
  'achtung':   '⚠️',
  'bekannt':   '★',
};
const TAG_LABELS = {
  'favorit-a': '♥ Top-Favorit',
  'favorit-b': '♡ Favorit',
  'favorit-c': '♦ Cool / interessant',
  'adhd':      'Ⓐ ADHS',
  'achtung':   '⚠️ Unangenehm / Vorsicht',
  'bekannt':   '★ Bekannt',
};
const TEAM_META = {
  D: { label: 'Deutsches Team',             color: '#60a5fa' },
  I: { label: 'Internationales Team',       color: '#34d399' },
  F: { label: 'Forschungsteam / Bindung',   color: '#a78bfa' },
  T: { label: 'Training',                   color: '#f59e0b' },
};
const TEAM_ORDER = ['D', 'I', 'F', 'T'];
const teamDotSvg = color => `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><circle cx='20' cy='20' r='18' fill='${encodeURIComponent(color)}'/></svg>`;
function xmlTypToTeam(typ) {
  if (typ === 'training') return 'T';
  if (typ === 'int')      return 'I';
  if (typ === 'forschung' || typ === 'bindung') return 'F';
  return 'D';
}
// Derive per-colleague team from funktion string (takes priority over shift-level team)
function inferColleagueTeam(funktion) {
  const f = (funktion || '').trim().toUpperCase();
  if (f === 'DEU-BINDUNG')   return 'F'; // before generic DEU-* check
  if (f.startsWith('DEU-'))  return 'D';
  if (f.startsWith('INT-'))  return 'I';
  if (/^TRAINING\s*\d*$/.test(f)) return 'T';
  if (f.startsWith('FORSCH') || f.startsWith('BIND')) return 'F';
  return null;
}

const FUNK_OPTIONS = [
  'DEU-A-Seniorassistent',
  'DEU-B','DEU-C','DEU-D','DEU-E','DEU-F','DEU-G',
  'DEU-Bindung',
  'Training 1','Training 2',
  'INT-A-Seniorassistent','INT-B',
  'Forschung 1','Forschung 2','Forschung 3','Forschung 4','Forschung 5','Forschung 6',
];
function effectiveTeam(c) {
  return inferColleagueTeam(c.funktion) || c.team || 'D';
}
function tagIconsHTML(tags) {
  return (tags || []).map(t => TAG_ICONS[t] || t).join(' ');
}
function teamButtonPreviewHTML(colleagues) {
  if (!colleagues || !colleagues.length) return '';
  const isSenior = c => effectiveTeam(c) === 'D' && (c.funktion || '').toLowerCase().includes('senior');
  const deuReg   = colleagues.filter(c => effectiveTeam(c) === 'D' && !isSenior(c));
  const senior   = colleagues.some(isSenior);
  const training = colleagues.filter(c => effectiveTeam(c) === 'T');
  const parts = [];
  if (deuReg.length || senior) parts.push(`D: ${deuReg.length}/6`);
  if (senior) parts.push('S');
  if (training.length) parts.push(`T: ${training.length}/2`);
  return parts.join(' ') || '';
}

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
  if (shift.customStart != null && shift.customEnd != null)
    return Math.max(0, (shift.customEnd - shift.customStart) / 60);
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
function shiftGroupKey(shift) {
  if (shift.type === 'schulung') return 'schulung';
  if (shift.type === 'samstag') return 'samstag';
  if (shift.type === 'full')    return `full_${shift.category || 'regulär'}`;
  return shift.category || 'regulär';
}
function shiftGroupLabel(shift) {
  if (shift.type === 'schulung') return 'Schulung';
  if (shift.type === 'samstag') return 'Samstagsdienst';
  if (shift.type === 'full')    return 'Ganztagsdienst';
  const cat = shift.category || 'regulär';
  return cat === 'training' ? 'Trainingsdienst' : cat === 'senior' ? 'Seniordienst' : 'regulärer Dienst';
}
function shiftNumber(shift) {
  const key = shiftGroupKey(shift);
  const sorted = state.shifts.slice().sort((a, b) =>
    a.date !== b.date ? a.date.localeCompare(b.date) : a.id - b.id
  );
  const n = sorted.filter(s => shiftGroupKey(s) === key &&
    (s.date < shift.date || (s.date === shift.date && s.id <= shift.id))
  ).length;
  return `${shiftGroupLabel(shift)} #${n}`;
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
      `<div class="load-error">
        <img src="assets/images/errors/error_state.png" class="error-state-img" alt="">
        <div>${msg}</div>
        <button onclick="location.reload()" style="margin-top:16px;padding:10px 24px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Neu laden</button>
      </div>`;
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
    setupICDFCollectionListeners();
    setupTeamModal();
    setupOtherTeamsModal();
    setupShiftAdvModal();
    setupMissionModals();
    setupEscapeKey();
    document.getElementById('badge-lb-close').addEventListener('click', closeBadgeLightbox);
    document.getElementById('badge-lb-backdrop').addEventListener('click', closeBadgeLightbox);
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

  // Auto-close any plannerActive shifts whose date has already passed
  const todayStr = new Date().toISOString().split('T')[0];
  const overdueActive = state.shifts.filter(s => s.plannerActive && s.date < todayStr);
  if (overdueActive.length) {
    for (const shift of overdueActive) {
      const upd = { plannerActive: false, closedAt: shift.date + 'T23:59:59.000Z' };
      if (!shift.baseXPAwarded) {
        const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
        const xpBase = Math.round(calculateShiftXP(shift.type) * modifier);
        upd.xpEarned = (shift.xpEarned || 0) + xpBase;
        state.profile.totalXP = (state.profile.totalXP ?? 0) + xpBase;
        await db.profile.update(state.profile.id, { totalXP: state.profile.totalXP });
      }
      await db.shiftLogs.update(shift.id, upd);
    }
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
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
      { id: 'roulette-modal',       fn: () => document.getElementById('roulette-modal').classList.add('hidden') },
      { id: 'supervision-modal',    fn: () => document.getElementById('supervision-modal').classList.add('hidden') },
      { id: 'verify-modal',         fn: () => document.getElementById('verify-modal').classList.add('hidden') },
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
  document.querySelectorAll('.stats-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchStatsSubTab(btn.dataset.subtab));
  });

  // Swipe left/right on home tab → navigate shifts
  const homeEl = document.getElementById('tab-home');
  if (homeEl) {
    addSwipeHandler(homeEl,
      () => document.getElementById('btn-snav-next')?.click(),
      () => document.getElementById('btn-snav-prev')?.click()
    );
  }

  // Swipe left/right on stats tab → cycle sub-tabs
  const statsEl = document.getElementById('tab-stats');
  if (statsEl) {
    const SUBTABS = ['overview', 'dienste', 'diagnosen', 'badges'];
    addSwipeHandler(statsEl,
      () => {
        const i = SUBTABS.indexOf(state.statsSubTab);
        if (i < SUBTABS.length - 1) switchStatsSubTab(SUBTABS[i + 1]);
      },
      () => {
        const i = SUBTABS.indexOf(state.statsSubTab);
        if (i > 0) switchStatsSubTab(SUBTABS[i - 1]);
      }
    );
  }
}

const SUBTAB_ORDER = ['overview', 'dienste', 'diagnosen', 'badges'];

function switchStatsSubTab(name) {
  const oldIdx = SUBTAB_ORDER.indexOf(state.statsSubTab);
  const newIdx = SUBTAB_ORDER.indexOf(name);
  state.statsSubTab = name;
  document.querySelectorAll('.stats-subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.subtab === name));
  document.querySelectorAll('.stats-panel').forEach(p =>
    p.classList.toggle('stats-panel-hidden', p.id !== `stats-panel-${name}`));
  if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
    const panel = document.getElementById(`stats-panel-${name}`);
    if (panel) {
      panel.classList.remove('swipe-in-right', 'swipe-in-left');
      void panel.offsetWidth;
      panel.classList.add(newIdx > oldIdx ? 'swipe-in-right' : 'swipe-in-left');
    }
  }
}

function addSwipeHandler(el, onLeft, onRight, minDist = 50) {
  let sx = 0, sy = 0, locked = false;
  el.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    locked = false;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (locked) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < minDist || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) onLeft();
    else         onRight();
  }, { passive: true });
  // Lock out swipe if user is clearly scrolling vertically
  el.addEventListener('touchmove', e => {
    const dy = Math.abs(e.touches[0].clientY - sy);
    const dx = Math.abs(e.touches[0].clientX - sx);
    if (dy > dx * 1.2) locked = true;
  }, { passive: true });
}

function navigateTo(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.body.classList.toggle('tab-home-active', tab === 'home');
  const tabEl = document.getElementById(`tab-${tab}`);
  const btnEl = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
  if (tab === 'home') renderHomeTab();
  if (tab === 'diagnosen') renderDiagnosenTab();
  if (tab === 'icdf') renderICDFTab();
  if (tab === 'stats') renderStats();
  if (tab === 'settings') renderSettingsTab();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderApp() {
  loadICDFCollection();
  document.body.classList.add('tab-home-active');
  renderHomeTab();
  updateHeader();
}

function updateHeader() {
  if (state.currentTab === 'stats') renderDashboard();
}

async function inlineSaveShift(shift, updates) {
  if (updates.type && updates.type !== shift.type) {
    const oldXP = Math.round(calculateShiftXP(shift.type) * (CATEGORY_XP_MODIFIER[shift.category || 'regulär'] ?? 1));
    const newXP = Math.round(calculateShiftXP(updates.type) * (CATEGORY_XP_MODIFIER[shift.category || 'regulär'] ?? 1));
    const delta = newXP - oldXP;
    updates.xpEarned = (shift.xpEarned || 0) + delta;
    if (delta) {
      const total = Math.max(0, (state.profile.totalXP ?? 0) + delta);
      await db.profile.update(state.profile.id, { totalXP: total });
      state.profile.totalXP = total;
    }
  }
  if (updates.category && updates.category !== (shift.category || 'regulär')) {
    const oldXP = Math.round(calculateShiftXP(shift.type) * (CATEGORY_XP_MODIFIER[shift.category || 'regulär'] ?? 1));
    const newXP = Math.round(calculateShiftXP(shift.type) * (CATEGORY_XP_MODIFIER[updates.category] ?? 1));
    const delta = newXP - oldXP;
    updates.xpEarned = (shift.xpEarned || 0) + delta;
    if (delta) {
      const total = Math.max(0, (state.profile.totalXP ?? 0) + delta);
      await db.profile.update(state.profile.id, { totalXP: total });
      state.profile.totalXP = total;
    }
  }
  if ('note' in updates) {
    const hadNote = !!(shift.note && shift.note.trim().length > 0);
    if (!hadNote && updates.note.trim().length > 0 && !shift.noteAddedAt) {
      updates.noteAddedAt = new Date().toISOString();
      const noteXP = calculateNoteXP(shift.date, updates.noteAddedAt);
      updates.xpEarned = (shift.xpEarned || 0) + noteXP;
      const total = (state.profile.totalXP ?? 0) + noteXP;
      await db.profile.update(state.profile.id, { totalXP: total });
      state.profile.totalXP = total;
    }
  }
  updates.updatedAt = new Date().toISOString();
  await db.shiftLogs.update(shift.id, updates);
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  Object.assign(shift, updates);
}

// ─── Game stats (rank card + streak + recent — now rendered in Stats tab) ─────
function renderDashboard() {
  const xp   = state.profile?.totalXP ?? 0;
  const rank = getRankForXP(xp);
  const next = getNextRank(rank.level);
  const pct  = next ? ((xp - rank.xpRequired) / (next.xpRequired - rank.xpRequired)) * 100 : 100;

  const kaffeeKomaActive = state.profile.kaffeeKomaUntil && new Date(state.profile.kaffeeKomaUntil) > new Date();
  document.getElementById('rank-title').textContent    = kaffeeKomaActive ? '☕ Kaffee-Junkie' : rank.title;
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

  // Stars: within-title progression (3 levels per title block)
  const starPos = ((rank.level - 1) % 3) + 1;
  document.getElementById('rank-stars').textContent = '★'.repeat(starPos) + '☆'.repeat(3 - starPos);

  // Streak
  const streak = calcStreak(state.shifts);
  document.getElementById('streak-icon').textContent  = streak.frozen ? '🧊' : '🔥';
  document.getElementById('streak-value').textContent = streak.count;

  // Named hours counters
  renderHoursCounters();
  // stat card still shows total
  const totalHoursNum = calcTotalHours();
  document.getElementById('total-hours').textContent = `${totalHoursNum.toFixed(1).replace(/\.0$/, '')}h`;

  // Stat card clicks
  const hoursCard  = document.getElementById('stat-hours-card');
  const streakCard = document.getElementById('stat-streak-card');
  const supCard    = document.getElementById('stat-sup-hours-card');
  if (hoursCard)  hoursCard.onclick  = openHoursModal;
  if (streakCard) streakCard.onclick = openStreakModal;
  if (supCard)    supCard.onclick    = () => openHoursModal('supervision');
}

// ─── Hours Counters ───────────────────────────────────────────────────────────
function renderHoursCounters() {
  const el = document.getElementById('hours-counters');
  if (!el) return;
  const counters = state.profile?.hourCounters || [];
  const supHours  = state.supHours ?? 0;
  const supTarget = state.profile?.supervisionTarget ?? 30;
  const supPct    = Math.min(100, Math.round((supHours / supTarget) * 100));
  const supColor  = supPct >= 100 ? '#10b981' : '#8b5cf6';

  const counterCards = counters.map(c => {
    const h = calcCounterHours(c);
    const t = c.targetHours || 480;
    const pct = Math.min(100, Math.round((h / t) * 100));
    const fromTxt = c.fromDate
      ? `ab ${new Date(c.fromDate + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' })}`
      : '';
    const nm = (c.name || '').toLowerCase();
    const trackerBg = nm.includes('psych') ? 'url(./assets/images/trackers/tracker_psy.png)'
      : nm.includes('fach') ? 'url(./assets/images/trackers/tracker_fach.png)' : '';
    return `
      <div class="hours-counter-card${trackerBg ? ' has-tracker-bg' : ''}"
           data-counter-id="${c.id}"
           ${trackerBg ? `style="--tracker-bg:${trackerBg}"` : ''}>
        <div class="hc-top">
          <span class="hc-name">${c.name}</span>
          <span class="hc-pct">${pct}%</span>
        </div>
        <div class="hc-bar-wrap"><div class="hc-bar-fill" style="width:${pct}%"></div></div>
        <div class="hc-abs">${h.toFixed(1).replace('.0','')}h / ${t}h${fromTxt ? ` · ${fromTxt}` : ''}</div>
      </div>`;
  }).join('');

  const supCard = `
    <div class="hours-counter-card sup-counter-card" data-counter-id="supervision">
      <div class="hc-top">
        <span class="hc-name">Supervision</span>
        <span class="hc-pct" style="color:${supColor}">${supPct}%</span>
      </div>
      <div class="hc-bar-wrap"><div class="hc-bar-fill" style="width:${supPct}%;background:${supColor}"></div></div>
      <div class="hc-abs">${supHours}h / ${supTarget}h</div>
    </div>`;

  el.innerHTML = counterCards + supCard;

  el.querySelectorAll('.hours-counter-card:not(.sup-counter-card)').forEach(card => {
    card.addEventListener('click', () => {
      state.hoursModalCounter = parseInt(card.dataset.counterId);
      openHoursModal();
    });
  });
  el.querySelector('.sup-counter-card')?.addEventListener('click', () => {
    openHoursModal('supervision');
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

// ─── Drag-and-drop sort ───────────────────────────────────────────────────────
function makeSortable(list, onSort) {
  let item = null, ghost = null, placeholder = null, offsetY = 0;

  function items() { return [...list.querySelectorAll('[data-sid]')]; }

  function start(e) {
    const handle = e.target.closest('[data-drag]');
    if (!handle) return;
    e.preventDefault();
    item = handle.closest('[data-sid]');
    if (!item) return;

    const rect = item.getBoundingClientRect();
    offsetY = (e.touches?.[0] || e).clientY - rect.top;

    ghost = item.cloneNode(true);
    ghost.style.cssText = `position:fixed;left:${rect.left}px;width:${rect.width}px;top:${rect.top}px;`
      + `opacity:.85;pointer-events:none;z-index:9999;border-radius:10px;`
      + `box-shadow:0 8px 24px rgba(0,0,0,.4);transition:none;`;
    document.body.appendChild(ghost);

    placeholder = document.createElement('div');
    placeholder.className = 'sort-placeholder';
    placeholder.style.height = rect.height + 'px';
    item.replaceWith(placeholder);

    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchend', end);
    document.addEventListener('mouseup', end);
  }

  function move(e) {
    if (!ghost) return;
    e.preventDefault();
    const y = (e.touches?.[0] || e).clientY;
    ghost.style.top = (y - offsetY) + 'px';

    let placed = false;
    for (const el of items()) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        list.insertBefore(placeholder, el);
        placed = true;
        break;
      }
    }
    if (!placed) list.appendChild(placeholder);
  }

  function end() {
    if (!ghost) return;
    ghost.remove();
    placeholder.replaceWith(item);
    item.style.transform = '';
    ghost = null; placeholder = null; item = null;
    onSort(items().map(el => parseInt(el.dataset.sid)));
    document.removeEventListener('touchmove', move);
    document.removeEventListener('mousemove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('mouseup', end);
  }

  list.addEventListener('touchstart', start, { passive: false });
  list.addEventListener('mousedown', start);
}

// ─── Home Tab ─────────────────────────────────────────────────────────────────
const padT = (h, m) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
const toMins = (h, m) => h * 60 + m;

function shiftHours(typeOrShift) {
  if (typeOrShift && typeof typeOrShift === 'object') {
    const sh = typeOrShift;
    if (sh.customStart != null && sh.customEnd != null) {
      return {
        start: [Math.floor(sh.customStart / 60), sh.customStart % 60],
        end:   [Math.floor(sh.customEnd   / 60), sh.customEnd   % 60],
      };
    }
    return SHIFT_HOURS[sh.type] || SHIFT_HOURS['früh'];
  }
  return SHIFT_HOURS[typeOrShift] || SHIFT_HOURS['früh'];
}

function getMealHints(shift) {
  if (shift.mealHints) return shift.mealHints;
  return (MEAL_HINTS[shift.type] || []).map((h, i) => ({ ...h, id: i + 1 }));
}

async function renderHomeTab() {
  const today = new Date().toISOString().split('T')[0];

  // Pick shift: today's shift if exists, else most recent past, else nearest future
  if (!state.homeSelectedShiftId || !state.shifts.find(s => s.id === state.homeSelectedShiftId)) {
    const todayShift = state.shifts.find(s => s.date === today);
    const past       = state.shifts.filter(s => s.date < today).sort((a, b) => b.date.localeCompare(a.date));
    const upcoming   = state.shifts.filter(s => s.date > today).sort((a, b) => a.date.localeCompare(b.date));
    state.homeSelectedShiftId = (todayShift ?? past[0] ?? upcoming[0])?.id ?? null;
  }

  const shift   = state.shifts.find(s => s.id === state.homeSelectedShiftId) ?? null;
  const panel   = document.getElementById('home-shift-panel');
  const tlEl    = document.getElementById('home-timeline');
  const breakBtn= document.getElementById('btn-add-home-break');
  const alarmBn = document.getElementById('planner-alarm-banner');

  if (!shift) {
    panel.innerHTML = `<div class="home-no-shift">
      <img src="./assets/images/empty/empty_shifts.png" class="empty-state-img" alt="">
      <div>Noch keine Dienste</div>
      <div style="font-size:13px;color:var(--text-dim);margin-top:6px">Tippe auf einen Kalendertag um einen Dienst zu erstellen</div>
    </div>`;
    tlEl.innerHTML = '';
    breakBtn.classList.add('hidden');
    if (alarmBn) alarmBn.classList.add('hidden');
    const notifBanner = document.getElementById('notif-prompt-banner');
    if (notifBanner) notifBanner.classList.add('hidden');
    renderDiagnosticReminders(today);
  } else {
    // Clear stale timeline immediately before the async slot load to prevent
    // a previous shift's content from persisting during navigation
    tlEl.innerHTML = '';
    state.plannerShiftId = shift.id;
    state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');

    const slotTotal = state.plannerSlots.reduce((s, sl) => s + (sl.xpEarned || 0), 0);
    const modifier  = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
    const base      = Math.round(calculateShiftXP(shift.type) * modifier);
    const xpLabel   = shift.baseXPAwarded
      ? `✓ Basis-XP · +${slotTotal} XP Einträge`
      : `+${base} Basis · +${slotTotal} XP Einträge`;

    const prettyDateStr = new Date(shift.date + 'T12:00:00')
      .toLocaleDateString('de-AT', { weekday:'short', day:'2-digit', month:'2-digit', year:'2-digit' });
    const { start: sh_s, end: sh_e } = shiftHours(shift);
    const timeRange = `${String(sh_s[0]).padStart(2,'0')}:${String(sh_s[1]).padStart(2,'0')} – ${String(sh_e[0]).padStart(2,'0')}:${String(sh_e[1]).padStart(2,'0')}`;
    const colleagues = shift.colleagues || [];
    const hasTeam = colleagues.length > 0;
    const hideIcons = localStorage.getItem('hide-team-icons') === '1';

    const vmActive = ['früh','full'].includes(shift.type);
    const nmActive = ['spät','full'].includes(shift.type);
    const isSpecial = ['samstag','schulung'].includes(shift.type);
    const specialChip = isSpecial ? `<span class="home-special-chip">${shiftIcon(shift.type)} ${shiftLabel(shift.type)}</span>` : '';

    // Include self in team counts
    const selfUserName = localStorage.getItem('psychodex-user-name') || '';
    const colleaguesWithSelf = (() => {
      const list = [...colleagues];
      if (selfUserName && !list.some(c => c.name.toLowerCase() === selfUserName.toLowerCase())) {
        const selfTeam = shift.category === 'training' ? 'T' : 'D';
        const selfFunk = shift.category === 'senior' ? 'Seniorassistent (Ich)' : '(Ich)';
        list.push({ name: selfUserName, funktion: selfFunk, team: selfTeam, tags: [] });
      }
      return list;
    })();

    // Team counts info (left side of team row)
    const teamInfoHTML = (() => {
      if (!hasTeam && !selfUserName) return '';
      const isSenior = c => effectiveTeam(c) === 'D' && (c.funktion || '').toLowerCase().includes('senior');
      const deuReg   = colleaguesWithSelf.filter(c => effectiveTeam(c) === 'D' && !isSenior(c));
      const senior   = colleaguesWithSelf.some(isSenior);
      const training = colleaguesWithSelf.filter(c => effectiveTeam(c) === 'T');
      const tagCounts = {};
      if (!hideIcons) for (const c of colleagues) for (const tag of (c.tags || [])) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      const parts = [];
      if (deuReg.length || senior) parts.push(`<span class="team-info-chip" style="color:${TEAM_META.D.color}">D: ${deuReg.length}/6</span>`);
      if (senior) parts.push(`<span class="team-info-chip" style="color:#f59e0b">S</span>`);
      if (training.length) parts.push(`<span class="team-info-chip" style="color:${TEAM_META.T.color}">T: ${training.length}/2</span>`);
      const tags = Object.entries(tagCounts)
        .map(([tag, n]) => `<span class="team-info-chip">${TAG_ICONS[tag] || tag}${n > 1 ? ` ${n}` : ''}</span>`)
        .join('');
      return `<div class="home-team-info">${parts.join('')}${tags}</div>`;
    })();

    const bannerMap = { 'früh':'frueh', 'spät':'spaet', 'samstag':'samstag', 'full':'full', 'schulung':'schulung' };
    const bannerFile = bannerMap[shift.type] ? `url(./assets/images/banners/${bannerMap[shift.type]}_banner.png)` : '';

    panel.innerHTML = `
      <div class="home-shift-inline-edit${bannerFile ? ' home-shift-banner' : ''}"
           ${bannerFile ? `style="--shift-banner-url:${bannerFile}"` : ''}>
        <div class="home-date-row">
          <div class="home-date-badge">
            <span class="home-date-pretty">${prettyDateStr}</span>
            <span class="home-date-time">${timeRange}</span>
            <button class="home-date-edit-btn" id="btn-home-date-edit" title="Datum & Zeit verschieben">✏️</button>
          </div>
        </div>
        ${hasTeam ? `
        <div class="home-team-row">
          ${teamInfoHTML}
          <div class="home-team-btns">
            <button class="home-team-btn" id="btn-home-team" title="Rolecall">👥 ${teamButtonPreviewHTML(colleaguesWithSelf)}</button>
            <button class="home-team-btn home-zut-btn" id="btn-home-zut" title="Zuteilung">📋</button>
            <button class="home-icons-toggle" id="btn-icons-toggle" title="${hideIcons ? 'Tag-Icons zeigen' : 'Tag-Icons ausblenden'}">${hideIcons ? '◎' : '◉'}</button>
          </div>
        </div>` : ''}
        <div class="home-inline-row">
          <span class="home-shift-num">${shiftNumber(shift)}</span>
          <span class="home-inline-xp">${xpLabel}</span>
          <button id="btn-delete-home-shift" class="btn-icon home-del-btn" title="Dienst löschen">🗑</button>
        </div>
        <div class="home-type-compact-row">
          ${isSpecial ? specialChip : `
            <button class="home-half-btn${vmActive ? ' active' : ''}" id="btn-home-vm">VM</button>
            <button class="home-half-btn${nmActive ? ' active' : ''}" id="btn-home-nm">NM</button>`}
          <button class="home-adv-btn" id="btn-home-adv" title="Erweiterte Einstellungen">⚙️</button>
        </div>
        ${shift.type !== 'schulung' ? `
        <textarea id="home-edit-note" class="home-note-area" rows="6"
          placeholder="Dienst-Log / Notizen…">${shift.note || ''}</textarea>` : ''}
      </div>`;

    // Date edit button opens reschedule modal
    document.getElementById('btn-home-date-edit').addEventListener('click', () =>
      openRescheduleModal(shift));
    const teamBtn = document.getElementById('btn-home-team');
    if (teamBtn) teamBtn.addEventListener('click', () => openTeamModal(shift));
    document.getElementById('btn-home-zut')?.addEventListener('click', () => openZuteilungScreen(shift));
    const iconsToggle = document.getElementById('btn-icons-toggle');
    if (iconsToggle) iconsToggle.addEventListener('click', () => {
      localStorage.setItem('hide-team-icons', hideIcons ? '' : '1');
      renderHomeTab();
    });
    document.getElementById('btn-home-vm').addEventListener('click', () => {
      let newType;
      if (isSpecial)           newType = 'früh';
      else if (vmActive && nmActive) newType = 'spät';
      else if (!vmActive)      newType = nmActive ? 'full' : 'früh';
      else                     return;
      inlineSaveShift(shift, { type: newType });
    });
    document.getElementById('btn-home-nm').addEventListener('click', () => {
      let newType;
      if (isSpecial)           newType = 'spät';
      else if (nmActive && vmActive) newType = 'früh';
      else if (!nmActive)      newType = vmActive ? 'full' : 'spät';
      else                     return;
      inlineSaveShift(shift, { type: newType });
    });
    document.getElementById('btn-home-adv').addEventListener('click', () =>
      openShiftAdvModal(shift));
    const noteEl = document.getElementById('home-edit-note');
    if (noteEl) {
      noteEl.addEventListener('blur', e => inlineSaveShift(shift, { note: e.target.value }));
      document.getElementById('btn-save-fab').addEventListener('click', () =>
        inlineSaveShift(shift, { note: noteEl.value }));
    }
    document.getElementById('btn-delete-home-shift').addEventListener('click', async () => {
      if (!confirm('Dienst löschen?')) return;
      const xpBack = shift.xpEarned || 0;
      await db.scheduleSlots.where('shiftId').equals(shift.id).delete();
      await db.shiftLogs.delete(shift.id);
      const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - xpBack);
      await db.profile.update(state.profile.id, { totalXP: newTotal });
      state.profile.totalXP = newTotal;
      state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
      state.homeSelectedShiftId = null;
      renderHomeTab();
    });

    renderHomeMissions();
    renderDiagnosticReminders(today);

    // Notification banner (only for today's shift)
    const notifBanner = document.getElementById('notif-prompt-banner');
    if (notifBanner && 'Notification' in window) {
      const dismissed = localStorage.getItem('notif-banner-dismissed');
      const showNotif = shift.date === today && Notification.permission === 'default' && !dismissed;
      notifBanner.classList.toggle('hidden', !showNotif);
    }

    renderTimeline(shift);
    breakBtn.classList.remove('hidden');
    if (shift.date === today) startAlarmScheduler();
  }

  // Apply swipe animation to content wrapper
  if (state.swipeDir) {
    const vc = document.getElementById('home-view-content');
    if (vc) {
      vc.classList.remove('swipe-in-right', 'swipe-in-left');
      void vc.offsetWidth;
      vc.classList.add(state.swipeDir === 'next' ? 'swipe-in-right' : 'swipe-in-left');
    }
    state.swipeDir = null;
  }

  if (!state.calMonth) state.calMonth = today.slice(0, 7);
  renderShiftNav();
}

// ─── Clinic Closures (holidays + special) ─────────────────────────────────────
// Add entries here for future vacation weeks etc.
const CLINIC_CLOSURES = [
  { from: '2026-08-10', to: '2026-08-16', label: 'Ambulanz Ferien' },
];

function getClinicClosureDates() {
  const map = new Map();
  for (const { from, to, label } of CLINIC_CLOSURES) {
    const cur = new Date(from + 'T12:00:00');
    const end = new Date(to   + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().split('T')[0];
      map.set(ds, label);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return map;
}

// ─── Austrian Public Holidays ─────────────────────────────────────────────────
function easterSunday(y) {
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),
        h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
        l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
        mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;
  return new Date(y, mo-1, dy);
}
function getAustrianHolidays(year) {
  const p2 = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
  const add = (base, days) => { const d=new Date(base); d.setDate(d.getDate()+days); return d; };
  const e = easterSunday(year);
  return new Map([
    [`${year}-01-01`, 'Neujahr'],
    [`${year}-01-06`, 'Heilige Drei Könige'],
    [`${year}-05-01`, 'Staatsfeiertag'],
    [`${year}-08-15`, 'Mariä Himmelfahrt'],
    [`${year}-10-26`, 'Nationalfeiertag'],
    [`${year}-11-01`, 'Allerheiligen'],
    [`${year}-12-08`, 'Mariä Empfängnis'],
    [`${year}-12-25`, 'Christtag'],
    [`${year}-12-26`, 'Stefanitag'],
    [fmt(add(e,  1)), 'Ostermontag'],
    [fmt(add(e, 39)), 'Christi Himmelfahrt'],
    [fmt(add(e, 49)), 'Pfingstmontag'],
    [fmt(add(e, 60)), 'Fronleichnam'],
  ]);
}

function renderMonthCalendar() {
  const calEl = document.getElementById('home-calendar');
  if (!calEl) return;

  const [year, month] = state.calMonth.split('-').map(Number);
  const today = new Date().toISOString().split('T')[0];

  const monthLabel = new Date(year, month - 1, 1)
    .toLocaleDateString('de-AT', { month: 'long', year: 'numeric' });
  const lbl = document.getElementById('cal-month-label');
  if (lbl) lbl.textContent = monthLabel;

  const monthShifts = state.shifts.filter(s => s.date.startsWith(state.calMonth));
  const past    = monthShifts.filter(s => s.date <= today);
  const future  = monthShifts.filter(s => s.date >  today);
  const pastH   = past.reduce((s, sh)   => s + calcShiftHours(sh), 0);
  const futureH = future.reduce((s, sh) => s + calcShiftHours(sh), 0);

  const curMon = today.slice(0, 7);
  let statsText = '';
  if (state.calMonth === curMon) {
    statsText = `${past.length}/${monthShifts.length} Dienste · ${pastH.toFixed(1).replace('.0','')}/${(pastH+futureH).toFixed(1).replace('.0','')}h`;
  } else if (state.calMonth < curMon) {
    statsText = `${past.length} Dienste · ${pastH.toFixed(1).replace('.0','')}h`;
  } else {
    statsText = `${future.length} Dienste geplant · ${futureH.toFixed(1).replace('.0','')}h`;
  }
  const statsEl = document.getElementById('cal-month-stats');
  if (statsEl) statsEl.textContent = statsText;

  const shiftByDay = {};
  monthShifts.forEach(s => {
    const d = parseInt(s.date.slice(8));
    if (!shiftByDay[d]) shiftByDay[d] = [];
    shiftByDay[d].push(s);
  });

  const firstDow  = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0=Mon
  const daysInMon = new Date(year, month, 0).getDate();
  const holidays  = new Map([...getAustrianHolidays(year), ...getClinicClosureDates()]);

  // Find next upcoming shift date for distinct highlight
  const nextShiftDate = state.shifts
    .filter(s => s.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null;

  let html = `<div class="cal-weekdays"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span class="cal-weekend">Sa</span><span class="cal-weekend cal-sun-label">So</span></div><div class="cal-grid">`;
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell cal-empty"></div>';

  for (let d = 1; d <= daysInMon; d++) {
    const ds  = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = (new Date(year, month - 1, d).getDay() + 6) % 7; // 0=Mon..6=Sun
    const isSunday    = dow === 6;
    const holidayName = holidays.get(ds) ?? null;
    const isBlocked   = isSunday || !!holidayName;
    const dsh = shiftByDay[d] || [];
    const isToday      = ds === today;
    const isPast       = ds < today;
    const isSelected   = dsh.some(s => s.id === state.homeSelectedShiftId);
    const isNextShift  = ds === nextShiftDate && !isToday;

    const dots = dsh.map(s => {
      const op   = s.date < today ? '.45' : '1';
      const icon = shiftIcon(s.type);
      return `<span class="cal-dot-icon" style="opacity:${op}" title="${shiftLabel(s.type)}">${icon}</span>`;
    }).join('');

    const cls = ['cal-cell',
      isSunday    ? 'cal-sunday'    : '',
      holidayName ? 'cal-holiday'   : '',
      isToday     ? 'cal-today'     : '',
      isPast      ? 'cal-past'      : '',
      isSelected  ? 'cal-selected'  : '',
      isNextShift ? 'cal-next-shift': '',
      dsh.length  ? 'cal-has-shift' : '',
    ].filter(Boolean).join(' ');

    const ids   = dsh.map(s => s.id).join(',');
    const title = holidayName ? ` title="${holidayName}"` : '';
    html += `<div class="${cls}" data-date="${ds}" data-shift-ids="${ids}"${title}>
      <span class="cal-day-num">${d}</span>
      ${holidayName ? '<span class="cal-holiday-dot">🇦🇹</span>' : ''}
      ${dots ? `<div class="cal-dots">${dots}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  calEl.innerHTML = html;

  calEl.querySelectorAll('.cal-cell:not(.cal-empty):not(.cal-sunday):not(.cal-holiday)').forEach(cell => {
    cell.addEventListener('click', async () => {
      const ids = cell.dataset.shiftIds;
      if (ids) {
        state.homeSelectedShiftId = parseInt(ids.split(',')[0]);
        closeCalModal();
        renderHomeTab();
      } else {
        closeCalModal();
        openQuickCreateModal(cell.dataset.date);
      }
    });
  });
}

function renderShiftNav() {
  const sorted = state.shifts.slice().sort((a, b) => a.date.localeCompare(b.date));
  const selIdx = sorted.findIndex(s => s.id === state.homeSelectedShiftId);
  const prevShift = selIdx > 0 ? sorted[selIdx - 1] : null;
  const nextShift = selIdx >= 0 && selIdx < sorted.length - 1 ? sorted[selIdx + 1] : null;

  const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit' });

  const prevBtn  = document.getElementById('btn-snav-prev');
  const nextBtn  = document.getElementById('btn-snav-next');
  const prevDate = document.getElementById('snav-prev-date');
  const nextDate = document.getElementById('snav-next-date');
  if (!prevBtn) return;

  if (prevShift) {
    prevDate.textContent = fmtDate(prevShift.date);
    prevBtn.disabled = false;
    prevBtn.onclick = () => { state.swipeDir = 'prev'; state.homeSelectedShiftId = prevShift.id; renderHomeTab(); };
  } else {
    prevDate.textContent = '—';
    prevBtn.disabled = true;
    prevBtn.onclick = null;
  }
  if (nextShift) {
    nextDate.textContent = fmtDate(nextShift.date);
    nextBtn.disabled = false;
    nextBtn.onclick = () => { state.swipeDir = 'next'; state.homeSelectedShiftId = nextShift.id; renderHomeTab(); };
  } else {
    nextDate.textContent = '—';
    nextBtn.disabled = true;
    nextBtn.onclick = null;
  }
}

// ─── Shift Advanced Settings Modal ───────────────────────────────────────────
function openShiftAdvModal(shift) {
  const modal   = document.getElementById('shift-adv-modal');
  const typeRow = document.getElementById('shift-adv-type-row');
  const catRow  = document.getElementById('shift-adv-cat-row');
  if (!modal) return;

  const renderAdv = (s) => {
    typeRow.innerHTML = ['samstag','schulung'].map(t => `
      <button class="adv-type-btn${s.type === t ? ' active' : ''}" data-type="${t}">
        ${shiftIcon(t)} ${shiftLabel(t)}
      </button>`).join('');
    catRow.innerHTML = ['training','regulär','senior'].map(c => {
      const m = CATEGORY_META[c];
      return `<button class="adv-cat-btn${(s.category||'regulär') === c ? ' active' : ''}" data-cat="${c}">${m.icon} ${m.label}</button>`;
    }).join('');

    typeRow.querySelectorAll('.adv-type-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        const newType = s.type === btn.dataset.type ? 'spät' : btn.dataset.type;
        await inlineSaveShift(s, { type: newType });
        const updated = state.shifts.find(x => x.id === s.id);
        if (updated) { Object.assign(s, updated); renderAdv(s); }
      }));
    catRow.querySelectorAll('.adv-cat-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        await inlineSaveShift(s, { category: btn.dataset.cat });
        const updated = state.shifts.find(x => x.id === s.id);
        if (updated) { Object.assign(s, updated); renderAdv(s); }
      }));
  };

  renderAdv(shift);
  modal.classList.remove('hidden');
}

function setupShiftAdvModal() {
  const close = () => document.getElementById('shift-adv-modal').classList.add('hidden');
  document.getElementById('shift-adv-close').addEventListener('click', close);
  document.getElementById('shift-adv-backdrop').addEventListener('click', close);
}

function openRescheduleModal(shift) {
  const modal = document.getElementById('shift-reschedule-modal');
  if (!modal) return;

  const { start, end } = shiftHours(shift);
  const fmt2 = n => String(n).padStart(2, '0');
  document.getElementById('reschedule-date').value  = shift.date;
  document.getElementById('reschedule-start').value = `${fmt2(start[0])}:${fmt2(start[1])}`;
  document.getElementById('reschedule-end').value   = `${fmt2(end[0])}:${fmt2(end[1])}`;

  modal.classList.remove('hidden');

  const close = () => modal.classList.add('hidden');
  document.getElementById('shift-reschedule-close').onclick  = close;
  document.getElementById('shift-reschedule-cancel').onclick = close;
  document.getElementById('shift-reschedule-backdrop').onclick = close;

  document.getElementById('shift-reschedule-save').onclick = async () => {
    const newDate  = document.getElementById('reschedule-date').value;
    const startVal = document.getElementById('reschedule-start').value;
    const endVal   = document.getElementById('reschedule-end').value;
    if (!newDate || !startVal || !endVal) return;

    const [sh, sm] = startVal.split(':').map(Number);
    const [eh, em] = endVal.split(':').map(Number);
    const customStart = sh * 60 + sm;
    const customEnd   = eh * 60 + em;

    // Check if times match the shift type defaults (if so, clear custom times)
    const def = SHIFT_HOURS[shift.type] || SHIFT_HOURS['früh'];
    const defStart = def.start[0] * 60 + def.start[1];
    const defEnd   = def.end[0]   * 60 + def.end[1];
    const isDefault = customStart === defStart && customEnd === defEnd;

    const updates = {
      date: newDate,
      customStart: isDefault ? null : customStart,
      customEnd:   isDefault ? null : customEnd,
    };
    await inlineSaveShift(shift, updates);
    close();
  };
}

// ─── Team Attendance Modal ────────────────────────────────────────────────────
function openTeamModal(shift) {
  const modal   = document.getElementById('team-modal');
  const body    = document.getElementById('team-modal-body');
  const titleEl = document.getElementById('team-modal-title');
  const subEl   = document.getElementById('team-modal-subtitle');

  const dateObj  = new Date(shift.date + 'T12:00:00');
  const wdShort  = dateObj.toLocaleDateString('de-AT', { weekday:'short' });
  const dtShort  = dateObj.toLocaleDateString('de-AT', { day:'numeric', month:'numeric', year:'numeric' });
  const typeAbbr = { früh:'VM', spät:'NM', samstag:'SAT', full:'Ganztag', schulung:'Sch' }[shift.type] || '';
  const typeLabel= { früh:'Vormittag', spät:'Nachmittag', samstag:'Samstag', full:'Ganztag', schulung:'Schulung' }[shift.type] || '';
  titleEl.textContent = `Rolecall – ${wdShort} ${dtShort} ${typeAbbr}`;

  const { start: ss, end: se } = shiftHours(shift);
  const tr = `${String(ss[0]).padStart(2,'0')}:${String(ss[1]).padStart(2,'0')}–${String(se[0]).padStart(2,'0')}:${String(se[1]).padStart(2,'0')}`;
  const dtLong = dateObj.toLocaleDateString('de-AT', { weekday:'long', day:'numeric', month:'numeric', year:'numeric' });
  subEl.textContent = `${dtLong} · ${typeLabel} (${tr})`;

  const userName  = localStorage.getItem('psychodex-user-name') || '';
  const hideIcons = localStorage.getItem('hide-team-icons') === '1';
  const selfTeam  = shift.category === 'training' ? 'T' : 'D';
  const selfFunk  = shift.category === 'senior' ? 'Seniorassistent (Ich)' : '(Ich)';

  // Mutable working list — source of truth for save
  const working = (shift.colleagues || []).map(c => ({ ...c }));

  const isSenior  = c => effectiveTeam(c) === 'D' && (c.funktion || '').toLowerCase().includes('senior');
  const personTiers = shift.zuteilung?.personTiers || {};
  const dotColor  = c => isSenior(c) ? '#f59e0b' : (TEAM_META[effectiveTeam(c)]?.color || TEAM_META.D.color);
  const avatarSrc = c => {
    const t = effectiveTeam(c);
    if (t !== 'D' && t !== 'T') return teamDotSvg(TEAM_META[t]?.color || '#666');
    if (isSenior(c)) return ANIMAL_TIERS[0].img;
    if (t === 'T') return TRAINEE_AVATARS[1].img;
    const tier = personTiers[c.name];
    return tier && ANIMAL_TIERS[tier - 1] ? ANIMAL_TIERS[tier - 1].img : ANIMAL_TIERS[6].img;
  };

  let editingIdx = null; // null = add mode, >=0 = edit existing working[editingIdx]

  const renderBody = () => {
    // Build display: self-entry + working list, each tagged with working index
    const display = working.map((c, i) => ({ ...c, _wi: i }));
    if (userName && !display.some(c => c.name.toLowerCase() === userName.toLowerCase())) {
      display.unshift({ name: userName, funktion: selfFunk, team: selfTeam, tags: [], present: true, _self: true, _wi: -1 });
    }

    const rcDisplay    = display.filter(c => effectiveTeam(c) === 'D' || effectiveTeam(c) === 'T');
    const otherDisplay = display.filter(c => effectiveTeam(c) !== 'D' && effectiveTeam(c) !== 'T' && !c._self);

    // Sort: Senior first, then by stunden desc, Training last (keep their relative order)
    rcDisplay.sort((a, b) => {
      const aSen = effectiveTeam(a) === 'D' && (a.funktion || '').toLowerCase().includes('senior');
      const bSen = effectiveTeam(b) === 'D' && (b.funktion || '').toLowerCase().includes('senior');
      const aTrn = effectiveTeam(a) === 'T';
      const bTrn = effectiveTeam(b) === 'T';
      if (aSen && !bSen) return -1;
      if (!aSen && bSen) return 1;
      if (aTrn && !bTrn) return 1;
      if (!aTrn && bTrn) return -1;
      return (b.stunden || 0) - (a.stunden || 0);
    });

    const present = rcDisplay.filter(c => c.present).length;
    const fehlen  = rcDisplay.length - present;

    const groups = { D: [], T: [] };
    for (const c of rcDisplay) groups[effectiveTeam(c)].push(c);

    const editing = editingIdx !== null ? working[editingIdx] : null;
    const funkOpts = f => FUNK_OPTIONS.map(o => `<option value="${o}"${editing && o === editing.funktion ? ' selected' : ''}>${o}</option>`).join('');

    body.innerHTML = `
      <div class="rolecall-status">
        <span class="rolecall-fehlen">${fehlen} fehlen</span>
        <span class="rolecall-dot">·</span>
        <span class="rolecall-anwesend">${present} anwesend</span>
      </div>
      ${['D','T'].filter(t => groups[t].length).map(t => `
        <div class="team-group-header" style="color:${TEAM_META[t].color}">${TEAM_META[t].label}</div>
        ${groups[t].map(c => `
          <label class="team-colleague-row${c.present ? ' is-present' : ''}">
            <input type="checkbox" class="team-colleague-check" data-wi="${c._wi}" ${c.present ? 'checked' : ''}>
            <img class="rc-avatar" src="${avatarSrc(c)}" alt="" style="border-color:${dotColor(c)}">
            <div class="team-colleague-info">
              <div class="team-colleague-name">${c.name}${c._self ? ' <span class="team-self-badge">Ich</span>' : ''}</div>
              <div class="team-colleague-func" style="color:${isSenior(c) ? '#f59e0b' : ''}">${c.funktion}</div>
            </div>
            ${!hideIcons && c.stunden != null ? `<div class="team-colleague-seniority">${c.stunden}h · ${c.pct != null ? c.pct + '%' : ''}</div>` : ''}
            ${!hideIcons && (c.tags||[]).length ? `<div class="team-colleague-tags">${tagIconsHTML(c.tags)}</div>` : ''}
            ${!c._self ? `
              <button class="rc-edit-btn" data-wi="${c._wi}" title="Bearbeiten">✏️</button>
              <button class="rc-del-btn"  data-wi="${c._wi}" title="Entfernen">✕</button>` : ''}
          </label>
        `).join('')}
      `).join('')}
      ${otherDisplay.length ? `<button class="other-teams-link" id="btn-other-teams">👁 Andere Teams (${otherDisplay.length})</button>` : ''}
      <div class="rc-add-form">
        <input type="text" class="rc-add-name" id="rc-add-name"
               placeholder="${editing ? '' : 'Name…'}"
               value="${editing ? editing.name.replace(/"/g,'&quot;') : ''}">
        <select class="rc-add-funk" id="rc-add-funk">${funkOpts()}</select>
        <button class="rc-add-btn" id="rc-add-btn">${editing ? '✓' : '＋'}</button>
        ${editing ? `<button class="rc-cancel-btn" id="rc-cancel-btn">✗</button>` : ''}
      </div>
      ${editing ? `<div class="rc-seniority-row">
        <input type="number" class="rc-add-stunden" id="rc-add-stunden" placeholder="Stunden" step="0.1" min="0"
          value="${editing.stunden != null ? editing.stunden : ''}" style="width:80px">
        <span style="font-size:12px;color:var(--text-dim)">h</span>
        <input type="number" class="rc-add-pct" id="rc-add-pct" placeholder="%" step="0.1" min="0" max="100"
          value="${editing.pct != null ? editing.pct : ''}" style="width:60px">
        <span style="font-size:12px;color:var(--text-dim)">%</span>
      </div>` : ''}
      ${editing ? `<div class="rc-tag-row">
        ${Object.entries(TAG_ICONS).map(([k,v]) => `<button class="rc-tag-btn${(editing.tags||[]).includes(k)?' active':''}" data-tag="${k}" title="${TAG_LABELS[k]||k}">${v}</button>`).join('')}
        <span class="rc-tag-hint">Tags</span>
      </div>` : ''}`;

    // Status update
    const updateStatus = () => {
      const checks = body.querySelectorAll('.team-colleague-check');
      const p = Array.from(checks).filter(x => x.checked).length;
      body.querySelector('.rolecall-fehlen').textContent   = `${checks.length - p} fehlen`;
      body.querySelector('.rolecall-anwesend').textContent = `${p} anwesend`;
    };

    // Checkboxes
    body.querySelectorAll('.team-colleague-check').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.closest('.team-colleague-row').classList.toggle('is-present', cb.checked);
        const wi = parseInt(cb.dataset.wi);
        if (wi >= 0) working[wi].present = cb.checked;
        updateStatus();
      });
    });

    // Edit buttons — pre-fill form and scroll to it
    body.querySelectorAll('.rc-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        editingIdx = parseInt(btn.dataset.wi);
        renderBody();
        body.querySelector('#rc-add-name')?.focus();
      });
    });

    // Delete buttons
    body.querySelectorAll('.rc-del-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const wi = parseInt(btn.dataset.wi);
        if (wi < 0) return;
        if (!confirm(`„${working[wi].name}" aus der Liste entfernen?`)) return;
        working.splice(wi, 1);
        if (editingIdx === wi) editingIdx = null;
        renderBody();
      });
    });

    // Add / save edit
    const doSubmit = () => {
      const name = body.querySelector('#rc-add-name').value.trim();
      const funk = body.querySelector('#rc-add-funk').value;
      if (!name) { body.querySelector('#rc-add-name').focus(); return; }
      const tags = Array.from(body.querySelectorAll('.rc-tag-btn.active')).map(b => b.dataset.tag);
      const stundenVal = body.querySelector('#rc-add-stunden')?.value;
      const pctVal     = body.querySelector('#rc-add-pct')?.value;
      const stunden    = stundenVal !== '' && stundenVal !== null && stundenVal !== undefined ? parseFloat(stundenVal) : undefined;
      const pct        = pctVal     !== '' && pctVal     !== null && pctVal     !== undefined ? parseFloat(pctVal)     : undefined;
      if (editingIdx !== null) {
        working[editingIdx].name     = name;
        working[editingIdx].funktion = funk;
        working[editingIdx].team     = inferColleagueTeam(funk) || 'D';
        working[editingIdx].tags     = tags;
        if (stunden !== undefined) working[editingIdx].stunden = stunden;
        if (pct     !== undefined) working[editingIdx].pct     = pct;
        editingIdx = null;
      } else {
        working.push({ name, funktion: funk, team: inferColleagueTeam(funk) || 'D', tags, present: false,
          ...(stunden !== undefined && { stunden }),
          ...(pct     !== undefined && { pct }),
        });
      }
      renderBody();
    };
    body.querySelector('#rc-add-btn')?.addEventListener('click', doSubmit);
    body.querySelector('#rc-add-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
    body.querySelector('#rc-cancel-btn')?.addEventListener('click', () => { editingIdx = null; renderBody(); });

    body.querySelectorAll('.rc-tag-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        btn.classList.toggle('active');
      });
    });

    body.querySelector('#btn-other-teams')?.addEventListener('click', () =>
      openOtherTeamsModal(working, hideIcons, renderBody));
  };

  renderBody();
  modal.classList.remove('hidden');

  document.getElementById('team-modal-save').onclick = async () => {
    // Sync any uncaptured checkbox state before saving
    body.querySelectorAll('.team-colleague-check').forEach(cb => {
      const wi = parseInt(cb.dataset.wi);
      if (wi >= 0 && wi < working.length) working[wi].present = cb.checked;
    });
    await db.shiftLogs.update(shift.id, { colleagues: working });
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
    modal.classList.add('hidden');
    await applyRolecallBonuses(shift, working);
    renderHomeTab();
  };
  document.getElementById('team-modal-zuteilung').onclick = async () => {
    body.querySelectorAll('.team-colleague-check').forEach(cb => {
      const wi = parseInt(cb.dataset.wi);
      if (wi >= 0 && wi < working.length) working[wi].present = cb.checked;
    });
    await db.shiftLogs.update(shift.id, { colleagues: working });
    state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
    modal.classList.add('hidden');
    openZuteilungScreen(shift);
  };
}

function setupTeamModal() {
  const close = () => document.getElementById('team-modal').classList.add('hidden');
  document.getElementById('team-modal-close').addEventListener('click', close);
  document.getElementById('team-modal-backdrop').addEventListener('click', close);
  document.getElementById('team-modal-cancel').addEventListener('click', close);
}

function openOtherTeamsModal(working, hideIcons, onChanged) {
  const modal = document.getElementById('other-teams-modal');
  const body  = document.getElementById('other-teams-body');
  let otherEditIdx = null;

  const renderOther = () => {
    const others = working.map((c, i) => ({ ...c, _wi: i }))
      .filter(c => effectiveTeam(c) !== 'D' && effectiveTeam(c) !== 'T');
    const groups = {};
    for (const c of others) {
      const t = effectiveTeam(c);
      if (!groups[t]) groups[t] = [];
      groups[t].push(c);
    }
    const editing = otherEditIdx !== null ? working[otherEditIdx] : null;

    body.innerHTML = (others.length
      ? TEAM_ORDER.filter(t => groups[t]).map(t => `
        <div class="team-group-header" style="color:${TEAM_META[t].color}">${TEAM_META[t].label}</div>
        ${groups[t].map(c => `
          <div class="team-colleague-row" style="cursor:default">
            <img class="rc-avatar" src="${teamDotSvg(TEAM_META[t]?.color || '#666')}" alt="" style="border-color:${TEAM_META[t]?.color || '#666'}">
            <div class="team-colleague-info">
              <div class="team-colleague-name">${c.name}</div>
              <div class="team-colleague-func">${c.funktion}</div>
            </div>
            ${!hideIcons && (c.tags||[]).length ? `<div class="team-colleague-tags">${tagIconsHTML(c.tags)}</div>` : ''}
            <button class="rc-edit-btn" data-wi="${c._wi}" title="Bearbeiten">✏️</button>
            <button class="rc-del-btn"  data-wi="${c._wi}" title="Entfernen">✕</button>
          </div>
        `).join('')}
      `).join('')
      : '<div class="empty-state">Keine anderen Teams</div>') + `
    <div class="rc-add-form">
      <input type="text" class="rc-add-name" id="rc-other-name"
             placeholder="Name…" value="${editing ? editing.name.replace(/"/g,'&quot;') : ''}">
      <select class="rc-add-funk" id="rc-other-funk">
        ${FUNK_OPTIONS.map(f => `<option value="${f}"${editing && f===editing.funktion?' selected':''}>${f}</option>`).join('')}
      </select>
      ${editing ? `
        <button class="rc-add-btn" id="rc-other-save">✓</button>
        <button class="rc-cancel-btn" id="rc-other-cancel">✗</button>` : `
        <button class="rc-add-btn" id="rc-other-add">＋</button>`}
    </div>`;

    body.querySelectorAll('.rc-edit-btn').forEach(btn => btn.addEventListener('click', () => {
      otherEditIdx = parseInt(btn.dataset.wi); renderOther();
      body.querySelector('#rc-other-name')?.focus();
    }));
    body.querySelectorAll('.rc-del-btn').forEach(btn => btn.addEventListener('click', () => {
      const wi = parseInt(btn.dataset.wi);
      if (wi < 0) return;
      if (!confirm(`„${working[wi].name}" aus der Liste entfernen?`)) return;
      working.splice(wi, 1);
      otherEditIdx = null; renderOther(); onChanged();
    }));
    body.querySelector('#rc-other-save')?.addEventListener('click', () => {
      const name = body.querySelector('#rc-other-name').value.trim();
      const funk = body.querySelector('#rc-other-funk').value;
      if (!name) return;
      working[otherEditIdx].name = name;
      working[otherEditIdx].funktion = funk;
      working[otherEditIdx].team = inferColleagueTeam(funk) || 'D';
      otherEditIdx = null; renderOther(); onChanged();
    });
    body.querySelector('#rc-other-cancel')?.addEventListener('click', () => { otherEditIdx = null; renderOther(); });
    body.querySelector('#rc-other-add')?.addEventListener('click', () => {
      const name = body.querySelector('#rc-other-name').value.trim();
      const funk = body.querySelector('#rc-other-funk').value;
      if (!name) { body.querySelector('#rc-other-name').focus(); return; }
      working.push({ name, funktion: funk, team: inferColleagueTeam(funk)||'D', tags:[], present:false });
      renderOther(); onChanged();
    });
    body.querySelector('#rc-other-name')?.addEventListener('keydown', e => {
      if (e.key==='Enter') (body.querySelector('#rc-other-save')||body.querySelector('#rc-other-add'))?.click();
    });
  };

  renderOther();
  modal.classList.remove('hidden');
}

function setupOtherTeamsModal() {
  const close = () => document.getElementById('other-teams-modal').classList.add('hidden');
  document.getElementById('other-teams-close').addEventListener('click', close);
  document.getElementById('other-teams-backdrop').addEventListener('click', close);
}

function openCalModal() {
  const modal = document.getElementById('cal-modal');
  if (!modal) return;
  renderMonthCalendar();
  modal.classList.remove('hidden');
}

function closeCalModal() {
  document.getElementById('cal-modal')?.classList.add('hidden');
}

function openQuickCreateModal(dateStr) {
  const modal = document.getElementById('quick-create-modal');
  if (!modal) return;
  document.getElementById('quick-create-title').textContent =
    `Neuer Dienst · ${new Date(dateStr + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit' })}`;
  modal._pendingDate = dateStr;

  // Smart defaults: Saturday → samstag; others → last non-samstag type/category
  const isSaturday = new Date(dateStr + 'T12:00:00').getDay() === 6;
  let defaultType = 'früh';
  let defaultCat  = 'regulär';
  if (isSaturday) {
    defaultType = 'samstag';
  } else {
    const lastShift = state.shifts
      .filter(s => s.type !== 'samstag' && s.date < dateStr)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (lastShift) {
      if (lastShift.type === 'früh' || lastShift.type === 'spät') defaultType = lastShift.type;
      if (lastShift.category) defaultCat = lastShift.category;
    }
  }

  modal.querySelectorAll('#qc-type-selector .type-btn').forEach(b => b.classList.remove('active'));
  modal.querySelector(`#qc-type-selector [data-type="${defaultType}"]`)?.classList.add('active');
  modal.querySelectorAll('#qc-cat-selector .cat-btn').forEach(b => b.classList.remove('active'));
  modal.querySelector(`#qc-cat-selector [data-category="${defaultCat}"]`)?.classList.add('active');
  modal.classList.remove('hidden');
}

async function quickCreateShift(dateStr, type, category) {
  const today = new Date().toISOString().split('T')[0];
  const shiftId = await db.shiftLogs.add({
    date: dateStr, type, category,
    xpEarned: 0, patientCount: 0,
    plannerShift: true,
    plannerActive: dateStr === today,
    createdAt: new Date().toISOString(),
    mealHints: (MEAL_HINTS[type] || []).map((h, i) => ({ ...h, id: i + 1 })),
  });

  if (dateStr > today) {
    const xpBase = Math.round(calculateShiftXP(type) * CATEGORY_XP_MODIFIER[category]);
    await db.shiftLogs.update(shiftId, { xpEarned: xpBase, baseXPAwarded: true });
    const oldXP = state.profile.totalXP ?? 0;
    const newXP = oldXP + xpBase;
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
    updateHeader();
    showXPPopup(xpBase, [{ label: `${shiftLabel(type)} geplant`, xp: xpBase }]);
    checkLevelUp(newXP, oldXP);
  }

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.homeSelectedShiftId = shiftId;
  renderHomeTab();
}

function renderSchulungTimeline(shift) {
  const tl = document.getElementById('home-timeline');
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

  const { start, end } = shiftHours(shift);
  const startM = toMins(...start);
  const endM   = toMins(...end);
  const meals  = getMealHints(shift).map(h => ({ ...h, mins: toMins(h.h, h.m) }));

  const slots = [...state.plannerSlots].sort((a, b) => toMins(a.startHour, a.startMinute) - toMins(b.startHour, b.startMinute));

  // Breaks are overlaid on the row they fall within – not standalone rows
  const breaksIn = (from, to) => meals.filter(m => m.mins >= from && m.mins < to);

  const rows = [];
  let cursor = startM;

  const pushHourTicks = (from, to) => {
    if (from >= to) return;
    let c = from;
    if (c % 60 !== 0) {
      const nextHour = Math.ceil(c / 60) * 60;
      const e2 = Math.min(nextHour, to);
      rows.push({ kind: 'gap', from: c, to: e2, breaks: breaksIn(c, e2) });
      c = nextHour;
    }
    while (c < to) {
      const e2 = Math.min(c + 60, to);
      rows.push({ kind: 'gap', from: c, to: e2, breaks: breaksIn(c, e2) });
      c += 60;
    }
  };

  for (const slot of slots) {
    const slotStart = toMins(slot.startHour, slot.startMinute);
    const slotEnd   = toMins(slot.endHour, slot.endMinute);
    if (cursor < slotStart) pushHourTicks(cursor, slotStart);
    rows.push({ kind: 'slot', slot, breaks: breaksIn(slotStart, slotEnd) });
    cursor = slotEnd;
  }
  if (cursor < endM) pushHourTicks(cursor, endM);

  const breakStripHtml = (rowBreaks) => rowBreaks.length
    ? `<div class="tl-break-strip">${rowBreaks.map(m =>
        `<span class="tl-break-badge" data-meal-id="${m.id}">
          <span>${m.icon}</span>
          <span class="tl-break-badge-time">${padT(m.h, m.m)}</span>
          <span class="tl-break-badge-label">${m.label}</span>
          <button class="tl-meal-del" data-meal-id="${m.id}" title="Löschen">🗑</button>
        </span>`).join('')}</div>`
    : '';

  // Determine which patient slots have diagnoses (for global toggle visibility)
  const patientSlotIds = slots.filter(s => !!(SLOT_TYPES[s.type]?.patientContact)).map(s => s.id);
  const allCollapsed = patientSlotIds.length > 0 && patientSlotIds.every(id => state.collapsedSlotIds.has(id));

  const tl = document.getElementById('home-timeline');

  // Global expand/collapse button (only when there are patient slots)
  const globalToggleHtml = patientSlotIds.length > 0
    ? `<div class="tl-global-toggle-row">
        <button class="tl-global-toggle-btn" id="tl-global-toggle">
          ${allCollapsed ? '▼ Details einblenden' : '▲ Details ausblenden'}
        </button>
       </div>`
    : '';

  const emptyPlannerHtml = slots.length === 0
    ? `<div class="tl-empty-hint"><img src="./assets/images/empty/empty_planner.png" class="empty-state-img" alt=""><div style="font-size:13px;color:var(--text-dim);margin-top:4px">Noch keine Einträge – tippe auf ＋ um zu beginnen</div></div>`
    : '';
  tl.innerHTML = emptyPlannerHtml + globalToggleHtml + rows.map(row => {
    if (row.kind === 'gap') {
      const label = padT(Math.floor(row.from/60), row.from%60);
      return `<div class="tl-gap-wrap">
        <button class="tl-gap" data-startm="${row.from}" data-endm="${row.to}">
          <span class="tl-gap-time">${label}</span>
          <span class="tl-gap-add">＋ Eintrag</span>
        </button>
        ${breakStripHtml(row.breaks)}
      </div>`;
    }
    // slot
    const { slot } = row;
    const def = SLOT_TYPES[slot.type] || {};
    // Default: expanded (show diagnoses). Collapsed only if explicitly in set.
    const isExpanded = !state.collapsedSlotIds.has(slot.id);
    const flags = slot.flags?.length ? slot.flags.map(f => `<span class="slot-flag">${f.toUpperCase()}</span>`).join('') : '';
    const commentHtml = slot.comment ? `<div class="tl-slot-comment">${slot.comment}</div>` : '';
    const isPatient = !!def.patientContact;
    const tips = SLOT_TIPS[slot.type] || {};
    const hasTips = !!(tips.sections?.length || tips.tips?.length || tips.docHint);

    // Diagnosis list + actions – shown when expanded (or not a patient slot)
    let detailHtml = '';
    if (isPatient) {
      const slotCatches = state.catches.filter(c => c.slotId === slot.id)
        .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      const diagCards = slotCatches.map(c =>
        `<div class="tl-diag-card" data-catch-id="${c.id}" data-code="${c.code}">
          <img class="tl-diag-thumb" src="assets/images/diagnoses/${c.code.toLowerCase()}.png" alt="" onerror="this.style.display='none'" loading="lazy">
          <div class="tl-diag-content">
            <span class="tl-diag-code">${c.code}</span>
            <span class="tl-diag-name">${c.name}</span>
          </div>
          <button class="tl-diag-del btn-icon" data-catch-id="${c.id}">🗑</button>
        </div>`
      ).join('');
      const diagListHtml = slotCatches.length
        ? `<div class="tl-inline-diag-list">${diagCards}</div>` : '';
      const hasVerifyPending = (slot.suspectedCodes?.length > 0) && !slot.seniorCode;
      detailHtml = `<div class="tl-slot-detail${isExpanded ? '' : ' tl-slot-detail--hidden'}">
        ${diagListHtml}
        <div class="tl-inline-actions">
          <button class="tl-inline-btn tl-inline-add-diag" title="Diagnose hinzufügen">➕</button>
          ${hasVerifyPending ? '<button class="tl-inline-btn tl-inline-verify" title="Therapeut*In Diagnose prüfen">🔍</button>' : ''}
          <button class="tl-inline-btn tl-inline-recall" title="Patient aus früherem Dienst">📋</button>
          ${hasTips ? '<button class="tl-inline-btn tl-inline-tips" title="Checkliste">✅</button>' : ''}
          <button class="tl-inline-btn tl-inline-edit" title="Bearbeiten">✏️</button>
          <button class="tl-inline-btn tl-inline-move" title="Verschieben">↕️</button>
          <button class="tl-inline-btn tl-inline-del btn-danger-sm" title="Löschen">🗑</button>
        </div>
      </div>`;
    } else {
      // Non-patient slots: actions always visible, no diag list
      detailHtml = `<div class="tl-slot-detail">
        <div class="tl-inline-actions">
          ${hasTips ? '<button class="tl-inline-btn tl-inline-tips" title="Checkliste">✅</button>' : ''}
          <button class="tl-inline-btn tl-inline-edit" title="Bearbeiten">✏️</button>
          <button class="tl-inline-btn tl-inline-move" title="Verschieben">↕️</button>
          <button class="tl-inline-btn tl-inline-del btn-danger-sm" title="Löschen">🗑</button>
        </div>
      </div>`;
    }

    return `<div class="tl-slot slot-${slot.type}${isPatient && isExpanded ? ' tl-slot--expanded' : ''}" data-slot-id="${slot.id}">
      <div class="tl-slot-main">
        <span class="tl-drag-handle" data-drag title="Verschieben">⠿</span>
        <span class="tl-slot-icon">${def.icon}</span>
        <div class="tl-slot-info">
          <div class="tl-slot-label">${def.label} ${flags}</div>
          <div class="tl-slot-time">${padT(slot.startHour,slot.startMinute)}–${padT(slot.endHour,slot.endMinute)} · +${slot.xpEarned} XP</div>
          ${commentHtml}
        </div>
        ${isPatient ? `<button class="tl-slot-chevron" data-chevron title="${isExpanded ? 'Einklappen' : 'Einblenden'}">${isExpanded ? '▲' : '▼'}</button>` : ''}
        <button class="tl-slot-delete btn-icon" data-slot-id="${slot.id}" title="Löschen">🗑</button>
      </div>
      ${detailHtml}
      ${breakStripHtml(row.breaks)}
    </div>`;
  }).join('');

  // Wire global toggle
  document.getElementById('tl-global-toggle')?.addEventListener('click', () => {
    if (allCollapsed) {
      state.collapsedSlotIds.clear();
    } else {
      patientSlotIds.forEach(id => state.collapsedSlotIds.add(id));
    }
    renderTimeline(shift);
  });

  // Wire gaps → slot add
  tl.querySelectorAll('.tl-gap').forEach(btn => {
    btn.addEventListener('click', () => {
      const startM2 = parseInt(btn.dataset.startm);
      openSlotAddModal(shift.id, Math.floor(startM2/60), startM2%60);
    });
  });

  // Wire chevron → per-slot toggle
  tl.querySelectorAll('[data-chevron]').forEach(chevron => {
    chevron.addEventListener('click', e => {
      e.stopPropagation();
      const slotEl = chevron.closest('.tl-slot');
      const slotId = parseInt(slotEl.dataset.slotId);
      if (state.collapsedSlotIds.has(slotId)) {
        state.collapsedSlotIds.delete(slotId);
      } else {
        state.collapsedSlotIds.add(slotId);
      }
      renderTimeline(shift);
    });
  });

  // Wire inline actions (always visible – present on all slots)
  tl.querySelectorAll('.tl-slot').forEach(el => {
    const slotId = parseInt(el.dataset.slotId);
    const slot = state.plannerSlots.find(s => s.id === slotId);
    if (!slot) return;
    el.querySelector('.tl-inline-add-diag')?.addEventListener('click', e => {
      e.stopPropagation(); openSlotDiagCatch(slot, 'planner');
    });
    el.querySelector('.tl-inline-verify')?.addEventListener('click', e => {
      e.stopPropagation(); openVerifyModal(slot);
    });
    el.querySelector('.tl-inline-recall')?.addEventListener('click', e => {
      e.stopPropagation(); openRecallPatientModal(slot, shift);
    });
    el.querySelector('.tl-inline-tips')?.addEventListener('click', e => {
      e.stopPropagation(); openSlotTipsModal(slot);
    });
    el.querySelector('.tl-inline-edit')?.addEventListener('click', e => {
      e.stopPropagation(); openSlotEditForm(slot, 'planner');
    });
    el.querySelector('.tl-inline-move')?.addEventListener('click', e => {
      e.stopPropagation(); openMoveSlotModal(slot, shift);
    });
    el.querySelector('.tl-inline-del')?.addEventListener('click', async e => {
      e.stopPropagation();
      state.collapsedSlotIds.delete(slot.id);
      await deleteSlot(slot.id, shift);
    });
    el.querySelectorAll('.tl-diag-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await deleteSlotCatch(parseInt(btn.dataset.catchId), slot, 'planner');
      });
    });
    el.querySelectorAll('.tl-diag-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.tl-diag-del')) return;
        openDiagInfoModal(card.dataset.code, parseInt(card.dataset.catchId));
      });
    });
  });

  // Wire delete buttons
  tl.querySelectorAll('.tl-slot-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteSlot(parseInt(btn.dataset.slotId), shift);
    });
  });

  // Wire break badge tap → check-off (XP) on first tap, edit on badge label tap
  tl.querySelectorAll('.tl-break-badge').forEach(badge => {
    badge.addEventListener('click', async e => {
      if (e.target.closest('.tl-meal-del')) return;
      e.stopPropagation();
      const id = parseInt(badge.dataset.mealId);
      const hint = getMealHints(shift).find(h => h.id === id);

      // Check off: award XP once per meal
      const checkedKey = `meal-checked-${shift.id}-${id}`;
      if (!sessionStorage.getItem(checkedKey)) {
        sessionStorage.setItem(checkedKey, '1');
        const sanity = CONSUMABLE_XP.sanity.labels.includes(hint?.label);
        const koffein = CONSUMABLE_XP.koffein.labels.includes(hint?.label);
        if (sanity) {
          const xp = CONSUMABLE_XP.sanity.xp;
          const newTotal = (state.profile.totalXP ?? 0) + xp;
          await db.profile.update(state.profile.id, { totalXP: newTotal });
          state.profile.totalXP = newTotal;
          showXPPopup(xp, [{ label: CONSUMABLE_XP.sanity.label }]);
          badge.classList.add('meal-checked');
        } else if (koffein) {
          const shiftBoostKey = `koffein-shift-${shift.id}`;
          sessionStorage.setItem(shiftBoostKey, '1');
          showXPPopup(0, [{ label: CONSUMABLE_XP.koffein.label }]);
          badge.classList.add('meal-checked');
        }
        return;
      }
      // Already checked: open edit
      openMealModal(shift, hint);
    });
  });

  // Wire break delete buttons
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

  setupTimelineDrag(tl, shift);
}

function setupTimelineDrag(tl, shift) {
  let dragSlotId = null, dragEl = null;

  function onMove(e) {
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const gap = el?.closest('.tl-gap');
    tl.querySelectorAll('.tl-gap').forEach(g => g.classList.remove('tl-gap--drag-over'));
    if (gap) gap.classList.add('tl-gap--drag-over');
  }

  async function onUp(e) {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    if (dragEl) dragEl.classList.remove('tl-dragging');
    tl.querySelectorAll('.tl-gap').forEach(g => g.classList.remove('tl-gap--drag-over'));

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const gap = el?.closest('.tl-gap');
    if (gap && dragSlotId) {
      const newStartM = parseInt(gap.dataset.startm);
      const slot = state.plannerSlots.find(s => s.id === dragSlotId);
      if (slot) {
        const durationM = toMins(slot.endHour, slot.endMinute) - toMins(slot.startHour, slot.startMinute);
        const newEndM = newStartM + durationM;
        await db.scheduleSlots.update(dragSlotId, {
          startHour: Math.floor(newStartM / 60), startMinute: newStartM % 60,
          endHour:   Math.floor(newEndM / 60),   endMinute:   newEndM % 60,
        });
        state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
        renderTimeline(shift);
      }
    }
    dragSlotId = null; dragEl = null;
  }

  function onCancel() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    tl.querySelectorAll('.tl-gap').forEach(g => g.classList.remove('tl-gap--drag-over'));
    if (dragEl) dragEl.classList.remove('tl-dragging');
    dragSlotId = null; dragEl = null;
  }

  tl.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-drag]');
    if (!handle) return;
    const slotEl = handle.closest('[data-slot-id]');
    if (!slotEl) return;
    e.preventDefault();
    dragSlotId = parseInt(slotEl.dataset.slotId);
    dragEl = slotEl;
    dragEl.classList.add('tl-dragging');
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });
}

async function openImportedShift(shiftId) {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) return;
  const today = new Date().toISOString().split('T')[0];
  const isFuture = shift.date > today;
  const updates = { plannerActive: true };

  // Future shifts get base XP immediately (no manual close needed)
  if (isFuture && !shift.baseXPAwarded) {
    const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
    const xpBase = Math.round(calculateShiftXP(shift.type) * modifier);
    updates.xpEarned = (shift.xpEarned || 0) + xpBase;
    updates.baseXPAwarded = true;
    const oldXP = state.profile.totalXP ?? 0;
    const newXP = oldXP + xpBase;
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
    updateHeader();
    showXPPopup(xpBase, [{ label: `${shiftLabelFull(shift)} geplant`, xp: xpBase }]);
    checkLevelUp(newXP, oldXP);
  }

  await db.shiftLogs.update(shiftId, updates);
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerShiftId = shiftId;
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shiftId).sortBy('startHour');
  state.alarmFired = new Set();
  state.homeSelectedShiftId = shiftId;
  renderHomeTab();
  if (!isFuture) startAlarmScheduler();
}

function setupPlannerListeners() {
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
  document.getElementById('btn-add-home-break').addEventListener('click', () => {
    const shift = state.shifts.find(s => s.id === state.homeSelectedShiftId);
    if (shift) openMealModal(shift);
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

  // Calendar navigation
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderMonthCalendar();
  });
  document.getElementById('cal-next')?.addEventListener('click', () => {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(y, m, 1);
    state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderMonthCalendar();
  });

  // Calendar modal
  document.getElementById('btn-open-cal')?.addEventListener('click', openCalModal);
  document.getElementById('cal-modal-backdrop')?.addEventListener('click', closeCalModal);

  // Quick-create shift modal
  const qcModal = document.getElementById('quick-create-modal');
  document.getElementById('quick-create-close')?.addEventListener('click', () => qcModal?.classList.add('hidden'));
  document.getElementById('quick-create-backdrop')?.addEventListener('click', () => qcModal?.classList.add('hidden'));
  document.querySelectorAll('#qc-type-selector .type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#qc-type-selector .type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.querySelectorAll('#qc-cat-selector .cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#qc-cat-selector .cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('btn-save-quick-create')?.addEventListener('click', async () => {
    const modal = document.getElementById('quick-create-modal');
    const dateStr = modal?._pendingDate;
    if (!dateStr) return;
    const type = modal.querySelector('#qc-type-selector .type-btn.active')?.dataset.type || 'früh';
    const cat  = modal.querySelector('#qc-cat-selector .cat-btn.active')?.dataset.category || 'regulär';
    modal.classList.add('hidden');
    await quickCreateShift(dateStr, type, cat);
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

  state.homeSelectedShiftId = shiftId;
  renderHomeTab();
}

async function closePlannerShift() {
  if (!state.plannerShiftId) return;
  if (!confirm('Dienst abschließen?')) return;

  const shift = state.shifts.find(s => s.id === state.plannerShiftId);
  if (!shift) return;

  const modifier = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
  // Skip base XP if already awarded (opened as future shift)
  const xpBase = shift.baseXPAwarded ? 0 : Math.round(calculateShiftXP(shift.type) * modifier);
  const flame  = shift.baseXPAwarded ? 0 : calculateFlameBonus(shift.date);
  const totalBase = xpBase + flame;

  await db.shiftLogs.update(state.plannerShiftId, {
    plannerActive: false,
    xpEarned: (shift.xpEarned || 0) + totalBase,
    closedAt: new Date().toISOString()
  });

  const oldXP = state.profile.totalXP ?? 0;
  const newXP = oldXP + totalBase;
  if (totalBase > 0) {
    await db.profile.update(state.profile.id, { totalXP: newXP });
    state.profile.totalXP = newXP;
  }

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerShiftId = null;
  state.plannerSlots   = [];
  stopAlarmScheduler();

  updateHeader();
  if (totalBase > 0) {
    const bonuses = [{ label: `${shiftLabelFull(shift)} abgeschlossen`, xp: xpBase }];
    if (flame > 0) bonuses.push({ label: '⚡ Flame Bonus', xp: flame });
    showXPPopup(totalBase, bonuses);
    checkLevelUp(newXP, oldXP);
  }

  renderHomeTab();
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

  document.getElementById('slot-add-modal').classList.add('hidden');
  showXPPopup(xp, [{ label: def.label, xp }]);
  updateHeader();
  checkLevelUp(newXP, oldXP);
  applyAchievements();

  const updatedShift = state.shifts.find(s => s.id === ctx.shiftId);
  if (updatedShift) {
    if (ctx.source === 'detail') {
      renderShiftDetailBody(updatedShift);
    } else if (state.plannerShiftId === ctx.shiftId) {
      state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(ctx.shiftId).sortBy('startHour');
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

function updatePlannerXP(shift) {
  const slotTotal = state.plannerSlots.reduce((s, sl) => s + (sl.xpEarned || 0), 0);
  const modifier  = CATEGORY_XP_MODIFIER[shift.category || 'regulär'];
  const base      = Math.round(calculateShiftXP(shift.type) * modifier);
  const xpLabel   = shift.baseXPAwarded
    ? `✓ Basis-XP · +${slotTotal} XP Einträge`
    : `+${base} Basis · +${slotTotal} XP Einträge`;
  const el = document.querySelector('.home-inline-xp');
  if (el) el.textContent = xpLabel;
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
  updateHeader();
  const updatedShift = state.shifts.find(s => s.id === shift.id);
  if (!updatedShift) return;
  if (source === 'detail') {
    renderShiftDetailBody(updatedShift);
  } else if (state.plannerShiftId === shift.id) {
    state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
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

  const slotCatches = state.catches
    .filter(c => c.slotId === slot.id)
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
  const diagHtml = isPatient ? `
    <div class="slot-diag-section">
      <div class="slot-diag-header">
        Diagnosen
        <button class="slot-diag-add-inline" id="btn-slot-add-diag">＋</button>
      </div>
      <div class="slot-diag-list">
      ${slotCatches.length
        ? slotCatches.map(c => `
            <div class="slot-diag-row" data-sid="${c.id}">
              <span class="drag-handle" data-drag title="Verschieben">⠿</span>
              <button class="slot-diag-check ${c.documented ? 'slot-diag-check-done' : ''}" data-catch-id="${c.id}">${c.documented ? '✓' : ''}</button>
              <span class="slot-diag-code">${c.code}</span>
              <span class="slot-diag-name ${c.documented ? 'slot-diag-done' : ''}">${c.name}</span>
              <button class="slot-diag-del btn-icon" data-catch-id="${c.id}" title="Entfernen">🗑</button>
            </div>`).join('')
        : '<div class="slot-diag-empty">Noch keine Diagnosen erfasst.</div>'}
      </div>
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

    const diagList = document.querySelector('.slot-diag-list');
    if (diagList && slotCatches.length > 1) {
      makeSortable(diagList, async ids => {
        for (let i = 0; i < ids.length; i++) {
          await db.caughtDiagnoses.update(ids[i], { sortOrder: i });
          const c = state.catches.find(x => x.id === ids[i]);
          if (c) c.sortOrder = i;
        }
      });
    }

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
  if (source === 'planner') {
    const freshShift = state.shifts.find(s => s.id === slot.shiftId);
    if (freshShift && state.plannerShiftId === freshShift.id) renderTimeline(freshShift);
  } else {
    const freshSlot = await db.scheduleSlots.get(slot.id);
    if (freshSlot) openSlotDetailModal(freshSlot, source);
  }
}

function openSlotEditForm(slot, source) {
  const def = SLOT_TYPES[slot.type] || {};
  document.getElementById('slot-detail-title').textContent = `✏️ ${def.icon} ${def.label}`;
  const hasFlags = slot.type === 'erstgespraech';
  // All available flags per slot type
  const SLOT_FLAGS = {
    erstgespraech: [
      { key: 'demo',          label: '🎓 Demo' },
      { key: 'international', label: '🌍 International' },
    ],
  };
  const slotFlags = SLOT_FLAGS[slot.type] || [];

  const isPatient = !!SLOT_TYPES[slot.type]?.patientContact;
  const terminInterviewField = ['anmeldung'].includes(slot.type)
    ? `<div class="form-row">
        <label class="form-label">📅 Interview-Termin</label>
        <input type="date" id="slot-edit-termin-interview" class="form-input" value="${slot.terminInterview || ''}">
      </div>` : '';
  const terminErstgespraechField = ['interview'].includes(slot.type)
    ? `<div class="form-row">
        <label class="form-label">📅 Erstgesprächs-Termin</label>
        <input type="date" id="slot-edit-termin-erst" class="form-input" value="${slot.terminErstgespraech || ''}">
      </div>` : '';

  const slotCatchesForEdit = isPatient ? state.catches.filter(c => c.slotId === slot.id) : [];
  const firstCatch = slotCatchesForEdit[0];
  const editAgeGroup = slot.ageGroup || firstCatch?.ageGroup || '';
  const editGender   = slot.gender   || firstCatch?.gender   || '';

  const patientFields = isPatient ? `
    <div class="form-row">
      <label class="form-label">🔖 Kürzel / Notiz</label>
      <input type="text" id="slot-edit-notes" class="form-input" placeholder="Codename…" value="${(slot.patientNotes || '').replace(/"/g,'&quot;')}">
    </div>
    <div class="form-row">
      <label class="form-label">👤 Altersgruppe</label>
      <select id="slot-edit-agegroup" class="form-input">
        <option value="">—</option>
        <option value="18-30" ${editAgeGroup==='18-30'?'selected':''}>18–30 J.</option>
        <option value="31-50" ${editAgeGroup==='31-50'?'selected':''}>31–50 J.</option>
        <option value="51+"   ${editAgeGroup==='51+'  ?'selected':''}>51+ J.</option>
      </select>
    </div>
    <div class="form-row">
      <label class="form-label">⚧ Geschlecht</label>
      <select id="slot-edit-gender" class="form-input">
        <option value="">—</option>
        <option value="weiblich" ${editGender==='weiblich'?'selected':''}>Weiblich</option>
        <option value="männlich" ${editGender==='männlich'?'selected':''}>Männlich</option>
        <option value="divers"   ${editGender==='divers'  ?'selected':''}>Divers</option>
      </select>
    </div>
    <div class="form-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <label class="form-label">🩺 Erfasste Diagnosen</label>
      <div id="slot-edit-catches-wrap"></div>
    </div>
    <div class="form-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <label class="form-label">🎯 Verdachts-Diagnosen</label>
      <div class="susp-chips-wrap" id="susp-chips-wrap"></div>
      <div class="susp-inline-wrap hidden" id="susp-search-wrap">
        <input type="text" id="susp-search-q" class="form-input" placeholder="Diagnose suchen…" autocomplete="off">
        <div id="susp-search-res" class="susp-search-results"></div>
      </div>
      <button type="button" class="btn-secondary" id="btn-susp-add">＋ Diagnose hinzufügen</button>
    </div>
    ${terminInterviewField}
    ${terminErstgespraechField}
    <div class="form-row" style="align-items:center;gap:12px">
      <label class="form-label" style="margin-bottom:0">❌ Ausfall</label>
      <input type="checkbox" id="slot-edit-ausfall" style="width:20px;height:20px;accent-color:#f87171" ${slot.ausfall ? 'checked' : ''}>
    </div>` : '';

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
      <textarea id="slot-edit-comment" class="form-input" rows="2" placeholder="Notiz…">${slot.comment || ''}</textarea>
    </div>
    ${patientFields}
    ${hasFlags ? `
    <div class="form-row">
      <label class="form-label">Flags</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${slotFlags.map(f =>
          `<button class="flag-btn${slot.flags?.includes(f.key) ? ' active' : ''}" data-edit-flag="${f.key}">${f.label}</button>`
        ).join('')}
      </div>
    </div>` : ''}
    <div class="slot-edit-btns">
      <button class="btn-primary"   id="btn-slot-edit-save">Speichern</button>
      <button class="btn-secondary" id="btn-slot-edit-cancel">Abbrechen</button>
    </div>
  `;

  if (hasFlags) {
    document.querySelectorAll('[data-edit-flag]').forEach(btn =>
      btn.addEventListener('click', e => e.currentTarget.classList.toggle('active')));
  }

  if (isPatient) {
    _editingSuspectedCodes = [...(slot.suspectedCodes || [])];

    const renderSuspChips = () => {
      const wrap = document.getElementById('susp-chips-wrap');
      if (!wrap) return;
      wrap.innerHTML = _editingSuspectedCodes.map((c, i) =>
        `<span class="susp-chip">
          <span class="susp-chip-code">${c.code}</span>
          <span class="susp-chip-title">${c.title || ''}</span>
          <button type="button" class="susp-chip-rm" data-idx="${i}">✕</button>
        </span>`
      ).join('');
      wrap.querySelectorAll('.susp-chip-rm').forEach(btn =>
        btn.addEventListener('click', e => {
          e.preventDefault();
          _editingSuspectedCodes.splice(parseInt(btn.dataset.idx), 1);
          renderSuspChips();
        })
      );
    };
    renderSuspChips();

    const renderCatchChips = () => {
      const wrap = document.getElementById('slot-edit-catches-wrap');
      if (!wrap) return;
      const cats = state.catches.filter(c => c.slotId === slot.id);
      if (!cats.length) {
        wrap.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">(keine)</span>';
        return;
      }
      wrap.innerHTML = cats.map(c =>
        `<span class="susp-chip">
          <span class="susp-chip-code">${c.code}</span>
          <span class="susp-chip-title">${c.name || ''}</span>
          <button type="button" class="susp-chip-rm" data-catch-id="${c.id}">✕</button>
        </span>`
      ).join('');
      wrap.querySelectorAll('.susp-chip-rm[data-catch-id]').forEach(btn =>
        btn.addEventListener('click', async e => {
          e.preventDefault();
          await db.caughtDiagnoses.delete(parseInt(btn.dataset.catchId));
          state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
          renderCatchChips();
        })
      );
    };
    renderCatchChips();

    document.getElementById('btn-susp-add')?.addEventListener('click', e => {
      e.preventDefault();
      const wrap = document.getElementById('susp-search-wrap');
      wrap?.classList.toggle('hidden');
      if (!wrap?.classList.contains('hidden'))
        document.getElementById('susp-search-q')?.focus();
    });

    document.getElementById('susp-search-q')?.addEventListener('input', e => {
      const q = e.target.value.trim();
      const res = document.getElementById('susp-search-res');
      if (!res) return;
      if (q.length < 2) { res.innerHTML = ''; return; }
      const results = searchDiagnoses(state.icdFlat, q).slice(0, 8);
      res.innerHTML = results.map(d =>
        `<div class="susp-search-item" data-code="${d.code}" data-title="${(d.name||'').replace(/"/g,'&quot;')}">
          <span class="susp-si-code">${d.code}</span>
          <span class="susp-si-title">${d.name}</span>
        </div>`
      ).join('');
      res.querySelectorAll('.susp-search-item').forEach(item =>
        item.addEventListener('click', () => {
          if (!_editingSuspectedCodes.some(c => c.code === item.dataset.code))
            _editingSuspectedCodes.push({ code: item.dataset.code, title: item.dataset.title });
          document.getElementById('susp-search-q').value = '';
          res.innerHTML = '';
          document.getElementById('susp-search-wrap')?.classList.add('hidden');
          renderSuspChips();
        })
      );
    });
  }

  document.getElementById('btn-slot-edit-cancel').addEventListener('click', () => {
    if (source === 'planner') {
      document.getElementById('slot-detail-modal').classList.add('hidden');
    } else {
      openSlotDetailModal(slot, source);
    }
  });

  document.getElementById('btn-slot-edit-save').addEventListener('click', () =>
    saveSlotEdit(slot, source));

  document.getElementById('slot-detail-modal').classList.remove('hidden');
}

async function saveSlotEdit(slot, source) {
  const startVal = document.getElementById('slot-edit-start').value;
  const endVal   = document.getElementById('slot-edit-end').value;
  const comment  = document.getElementById('slot-edit-comment').value.trim();
  if (!startVal || !endVal) { alert('Bitte Start- und Endzeit angeben.'); return; }

  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);

  const flags = [];
  document.querySelectorAll('[data-edit-flag]').forEach(btn => {
    if (btn.classList.contains('active')) flags.push(btn.dataset.editFlag);
  });

  const isPatient = !!SLOT_TYPES[slot.type]?.patientContact;
  const patientNotes = isPatient ? (document.getElementById('slot-edit-notes')?.value.trim() || null) : undefined;
  const suspectedCodes = isPatient ? [..._editingSuspectedCodes] : undefined;
  const terminInterview = document.getElementById('slot-edit-termin-interview')?.value || undefined;
  const terminErstgespraech = document.getElementById('slot-edit-termin-erst')?.value || undefined;
  const ausfallChecked = document.getElementById('slot-edit-ausfall')?.checked ?? false;
  const wasAusfall = slot.ausfall;
  const ageGroup = isPatient ? (document.getElementById('slot-edit-agegroup')?.value || null) : undefined;
  const gender   = isPatient ? (document.getElementById('slot-edit-gender')?.value   || null) : undefined;

  const updates = {
    startHour: sh, startMinute: sm,
    endHour: eh,   endMinute: em,
    comment: comment || null,
    flags,
    ...(patientNotes !== undefined && { patientNotes }),
    ...(suspectedCodes !== undefined && { suspectedCodes }),
    ...(terminInterview !== undefined && { terminInterview }),
    ...(terminErstgespraech !== undefined && { terminErstgespraech }),
    ...(isPatient && { ausfall: ausfallChecked }),
    ...(ageGroup !== undefined && { ageGroup }),
    ...(gender   !== undefined && { gender }),
  };

  await db.scheduleSlots.update(slot.id, updates);

  if (isPatient && (ageGroup !== undefined || gender !== undefined)) {
    const linkedCatches = await db.caughtDiagnoses.where('slotId').equals(slot.id).toArray();
    for (const c of linkedCatches) {
      await db.caughtDiagnoses.update(c.id, {
        ...(ageGroup !== undefined && ageGroup && { ageGroup }),
        ...(gender   !== undefined && gender   && { gender }),
      });
    }
    state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  }

  document.getElementById('slot-detail-modal').classList.add('hidden');

  const shift = state.shifts.find(s => s.id === slot.shiftId);
  if (!shift) return;

  // Ausfall-Roulette: first time ausfall is set
  if (isPatient && ausfallChecked && !wasAusfall) {
    triggerAusfallRoulette(slot, shift);
  }

  if (source === 'detail') {
    renderShiftDetailBody(shift);
  } else if (state.plannerShiftId === shift.id) {
    state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
    renderTimeline(shift);
  }
}

// ─── Ausfall-Roulette ─────────────────────────────────────────────────────────
async function triggerAusfallRoulette(slot, shift) {
  const drop = ROULETTE_DROPS[Math.floor(Math.random() * ROULETTE_DROPS.length)];

  // Apply effect
  if (drop.flat) {
    const newTotal = (state.profile.totalXP ?? 0) + drop.flat;
    await db.profile.update(state.profile.id, { totalXP: newTotal });
    state.profile.totalXP = newTotal;
    await db.scheduleSlots.update(slot.id, { xpEarned: (slot.xpEarned||0) + drop.flat, rouletteEffect: drop.id });
  }
  if (drop.effect === 'freeze_streak') {
    await db.profile.update(state.profile.id, { streakFrozenUntil: new Date().toISOString() });
    state.profile.streakFrozenUntil = new Date().toISOString();
  }
  if (drop.effect === 'kaffeekoma') {
    const until = new Date(Date.now() + drop.durationMs).toISOString();
    await db.profile.update(state.profile.id, { kaffeeKomaUntil: until });
    state.profile.kaffeeKomaUntil = until;
  }
  if (drop.effect === 'verify_boost_20') {
    await db.profile.update(state.profile.id, { verifyBoost20: true });
    state.profile.verifyBoost20 = true;
  }
  await db.scheduleSlots.update(slot.id, { rouletteEffect: drop.id });

  openRouletteModal(drop);
}

function openRouletteModal(drop) {
  const modal = document.getElementById('roulette-modal');
  if (!modal) return;
  document.getElementById('roulette-drop-img').src   = drop.img;
  document.getElementById('roulette-drop-label').textContent = drop.label;
  document.getElementById('roulette-drop-desc').textContent  = drop.desc;
  modal.classList.remove('hidden');
  document.getElementById('roulette-modal-close').onclick = () => modal.classList.add('hidden');
  document.getElementById('roulette-backdrop').onclick    = () => modal.classList.add('hidden');
}

// ─── Diagnostic Verify ────────────────────────────────────────────────────────
let _verifyTherapistCodes = [];

function openVerifyModal(slot) {
  const modal = document.getElementById('verify-modal');
  if (!modal) return;
  const isEdit = !!(slot.seniorCode || slot.therapistCodes?.length);
  const label = slot.patientNotes ? `„${slot.patientNotes}"` : `Slot #${slot.id}`;
  document.getElementById('verify-modal-label').textContent = label;

  // Show catches first, then suspectedCodes as fallback for "Dein Verdacht"
  const slotCatches = state.catches.filter(c => c.slotId === slot.id);
  const myDx = slotCatches.length > 0
    ? slotCatches.map(c => ({ code: c.code, title: c.name || '' }))
    : (slot.suspectedCodes || []);
  document.getElementById('verify-suspected').innerHTML = myDx.length
    ? myDx.map(c => `<span class="susp-chip"><span class="susp-chip-code">${c.code}</span><span class="susp-chip-title">${c.title||''}</span></span>`).join('')
    : '<span style="color:var(--text-dim);font-size:13px">(kein Verdacht)</span>';

  // Pre-fill therapist data when editing an already-verified slot
  if (isEdit) {
    _verifyTherapistCodes = slot.therapistCodes?.length
      ? [...slot.therapistCodes]
      : (slot.seniorCode ? [{ code: slot.seniorCode, title: '' }] : []);
    document.getElementById('verify-therapist-name').value = slot.therapistName || '';
  } else {
    document.getElementById('verify-therapist-name').value = '';
    _verifyTherapistCodes = [];
  }

  const saveBtn = document.getElementById('verify-save');
  if (saveBtn) saveBtn.textContent = isEdit ? 'Speichern' : 'Vergleichen & XP';

  const renderVerifyChips = () => {
    const wrap = document.getElementById('verify-therapist-chips');
    if (!wrap) return;
    wrap.innerHTML = _verifyTherapistCodes.map((c, i) =>
      `<span class="susp-chip"><span class="susp-chip-code">${c.code}</span><span class="susp-chip-title">${c.title || ''}</span><button type="button" class="susp-chip-rm" data-idx="${i}">✕</button></span>`
    ).join('');
    wrap.querySelectorAll('.susp-chip-rm').forEach(btn =>
      btn.addEventListener('click', e => {
        e.preventDefault();
        _verifyTherapistCodes.splice(parseInt(btn.dataset.idx), 1);
        renderVerifyChips();
      })
    );
  };
  renderVerifyChips();

  document.getElementById('btn-verify-therapist-add').onclick = e => {
    e.preventDefault();
    const wrap = document.getElementById('verify-therapist-search-wrap');
    wrap?.classList.toggle('hidden');
    if (!wrap?.classList.contains('hidden'))
      document.getElementById('verify-therapist-search-q')?.focus();
  };

  document.getElementById('verify-therapist-search-q').oninput = e => {
    const q = e.target.value.trim();
    const res = document.getElementById('verify-therapist-search-res');
    if (!res) return;
    if (q.length < 2) { res.innerHTML = ''; return; }
    const results = searchDiagnoses(state.icdFlat, q).slice(0, 8);
    res.innerHTML = results.map(d =>
      `<div class="susp-search-item" data-code="${d.code}" data-title="${(d.name||'').replace(/"/g,'&quot;')}">
        <span class="susp-si-code">${d.code}</span><span class="susp-si-title">${d.name}</span>
      </div>`
    ).join('');
    res.querySelectorAll('.susp-search-item').forEach(item =>
      item.addEventListener('click', () => {
        if (!_verifyTherapistCodes.some(c => c.code === item.dataset.code))
          _verifyTherapistCodes.push({ code: item.dataset.code, title: item.dataset.title });
        document.getElementById('verify-therapist-search-q').value = '';
        res.innerHTML = '';
        document.getElementById('verify-therapist-search-wrap')?.classList.add('hidden');
        renderVerifyChips();
      })
    );
  };

  modal.classList.remove('hidden');

  document.getElementById('verify-backdrop').onclick = () => modal.classList.add('hidden');
  document.getElementById('verify-cancel').onclick   = () => modal.classList.add('hidden');
  document.getElementById('verify-save').onclick     = async () => {
    if (!_verifyTherapistCodes.length) { alert('Bitte mindestens eine Diagnose hinzufügen.'); return; }
    const therapistName = document.getElementById('verify-therapist-name').value.trim();
    modal.classList.add('hidden');
    await applyVerifyXP(slot, _verifyTherapistCodes, therapistName, isEdit);
  };
}

async function applyVerifyXP(slot, therapistCodes, therapistName, isEdit = false) {
  const seniorCode = therapistCodes.map(c => c.code.trim().toUpperCase())[0] || '';

  if (isEdit) {
    // Editing an already-verified slot: update data only, no XP change
    await db.scheduleSlots.update(slot.id, {
      seniorCode,
      therapistCodes,
      therapistName: therapistName || slot.therapistName || '',
    });
    state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(slot.shiftId).sortBy('startHour');
    if (state.currentTab === 'diagnosen') renderDiagnosenTab();
    if (state.currentTab === 'home') {
      const openShift = state.shifts.find(s => s.id === slot.shiftId);
      if (openShift) renderShiftDetailBody(openShift);
    }
    return;
  }

  // First-time verification: calculate XP from catches (or suspectedCodes as fallback)
  const slotCatches = state.catches.filter(c => c.slotId === slot.id);
  const myDx = slotCatches.length > 0
    ? slotCatches.map(c => c.code.trim().toUpperCase())
    : (slot.suspectedCodes || []).map(c => c.code.trim().toUpperCase());
  const thCodes = therapistCodes.map(c => c.code.trim().toUpperCase());

  const matchKind = sc => {
    if (thCodes.includes(sc))                                    return DIAGNOSTIC_VERIFY_XP.exact;
    if (thCodes.some(tc => tc.slice(0, 3) === sc.slice(0, 3))) return DIAGNOSTIC_VERIFY_XP.partial;
    if (thCodes.some(tc => tc.slice(0, 2) === sc.slice(0, 2))) return DIAGNOSTIC_VERIFY_XP.partial;
    return DIAGNOSTIC_VERIFY_XP.miss;
  };
  const comparisons = myDx.length > 0 ? myDx.map(matchKind) : [DIAGNOSTIC_VERIFY_XP.miss];

  let totalXP = comparisons.reduce((s, r) => s + r.xp, 0);

  if (state.profile.verifyBoost20) {
    totalXP = Math.round(totalXP * 1.2);
    await db.profile.update(state.profile.id, { verifyBoost20: false });
    state.profile.verifyBoost20 = false;
  }

  const counts = {};
  comparisons.forEach(r => { counts[r.label] = (counts[r.label] || 0) + 1; });
  const bonuses = Object.entries(counts).map(([label, count]) => {
    const r = Object.values(DIAGNOSTIC_VERIFY_XP).find(v => v.label === label);
    return { label: `${count > 1 ? count + '× ' : ''}${label}`, xp: r.xp * count };
  });

  const bestResult = comparisons.reduce((best, r) => r.xp > best.xp ? r : best, comparisons[0]);

  const oldVerifyXP = slot.verifyXP || 0;
  const xpDiff = totalXP - oldVerifyXP;
  await db.scheduleSlots.update(slot.id, {
    seniorCode,
    therapistCodes,
    therapistName: therapistName || '',
    terminInterviewDone: true,
    xpEarned: Math.max(0, (slot.xpEarned || 0) + xpDiff),
    verifyXP: totalXP,
  });

  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) + xpDiff);
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;

  if (xpDiff > 0) showXPPopup(xpDiff, bonuses);

  const imgEl = document.getElementById('verify-result-img');
  if (imgEl) {
    imgEl.src = bestResult.img;
    imgEl.classList.remove('hidden');
    setTimeout(() => imgEl.classList.add('hidden'), 3000);
  }

  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(slot.shiftId).sortBy('startHour');
  const today = new Date().toISOString().slice(0, 10);
  renderDiagnosticReminders(today);
  renderDashboard();
  if (state.currentTab === 'diagnosen') renderDiagnosenTab();
  if (state.currentTab === 'home') {
    const openShift = state.shifts.find(s => s.id === slot.shiftId);
    if (openShift) renderShiftDetailBody(openShift);
  }
}

// ─── Recall Patient Modal ─────────────────────────────────────────────────────
async function openRecallPatientModal(targetSlot, shift) {
  const allSlots = await db.scheduleSlots.toArray();
  const shiftMap = Object.fromEntries(state.shifts.map(s => [s.id, s]));

  const patients = allSlots
    .filter(s => (s.type === 'patient' || SLOT_TYPES[s.type]?.patientContact) && s.shiftId !== shift.id);

  const patientsWithTermin = patients.filter(p => p.terminInterview || p.terminErstgespraech);

  const fmtD = str => str
    ? new Date(str).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : null;

  const earliestTermin = p => p.terminInterview || p.terminErstgespraech || null;
  const priority = p => {
    const rd = earliestTermin(p);
    const slotDiags = state.catches.filter(c => c.slotId === p.id);
    if (rd && rd.slice(0, 10) === shift.date) return 0;
    if (rd || slotDiags.length) return 1;
    return 2;
  };
  patients.sort((a, b) => priority(a) - priority(b) || b.shiftId - a.shiftId);
  patientsWithTermin.sort((a, b) => priority(a) - priority(b) || b.shiftId - a.shiftId);

  const existing = document.getElementById('recall-modal');
  if (existing) existing.remove();

  const buildItemsHtml = list => list.length
    ? list.map(p => {
        const slotShift  = shiftMap[p.shiftId];
        const dateStr    = fmtD(slotShift?.date) ?? '—';
        const timeStr    = `${String(p.startHour ?? 0).padStart(2,'0')}:${String(p.startMinute ?? 0).padStart(2,'0')}`;
        const typeLbl    = SLOT_TYPES[p.type]?.label ?? p.type;
        const kuerzel    = p.patientNotes || '(kein Kürzel)';
        const isToday    = p.terminInterview?.slice(0,10) === shift.date || p.terminErstgespraech?.slice(0,10) === shift.date;
        const termins    = [
          p.terminInterview     ? `Termin für Interview: ${fmtD(p.terminInterview)}` : null,
          p.terminErstgespraech ? `Termin für Erstgespräch: ${fmtD(p.terminErstgespraech)}` : null,
        ].filter(Boolean);
        const slotDiags  = state.catches.filter(c => c.slotId === p.id);
        const diagRows   = slotDiags.map(c =>
          `<div class="recall-diag-row">
            <img class="recall-diag-img" src="assets/images/diagnoses/${c.code}.png" alt="" onerror="this.style.display='none'">
            <span class="recall-diag-code">${c.code}</span>
            <span class="recall-diag-name">${c.name}</span>
          </div>`
        ).join('');
        return `<div class="recall-item${isToday ? ' recall-item--today' : ''}" data-id="${p.id}">
          <div class="recall-item-header">
            <span class="recall-item-kuerzel">${kuerzel}</span>
            ${isToday ? '<span class="recall-today-tag">↩ Heute</span>' : ''}
          </div>
          <div class="recall-item-session">${typeLbl} · ${dateStr} · ${timeStr}</div>
          ${termins.map(t => `<div class="recall-item-return">📅 ${t}</div>`).join('')}
          ${diagRows ? `<div class="recall-diag-list">${diagRows}</div>` : ''}
        </div>`;
      }).join('')
    : '<div style="color:var(--text-dim);font-size:13px;padding:16px 0">Keine früheren Patienten gefunden.</div>';

  const modal = document.createElement('div');
  modal.id = 'recall-modal';
  modal.innerHTML = `
    <div class="modal-backdrop" id="recall-backdrop"></div>
    <div class="modal-sheet">
      <div class="sheet-header">
        <div class="modal-title">📋 Früheren Patienten übernehmen</div>
      </div>
      <div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="recall-filter-termin" checked style="width:16px;height:16px;accent-color:var(--accent)">
        <label for="recall-filter-termin" style="font-size:13px;color:var(--text-muted);cursor:pointer">Nur mit Termin</label>
      </div>
      <div class="sheet-body" id="recall-list-body" style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto">
        ${buildItemsHtml(patientsWithTermin)}
      </div>
      <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,.07)">
        <button id="recall-cancel" class="btn-secondary" style="width:100%">Abbrechen</button>
      </div>
    </div>`;
  modal.className = 'modal';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('recall-backdrop').onclick = close;
  document.getElementById('recall-cancel').onclick   = close;

  const renderItems = showAll => {
    const listBody = document.getElementById('recall-list-body');
    if (!listBody) return;
    const list = showAll ? patients : patientsWithTermin;
    listBody.innerHTML = buildItemsHtml(list);
    listBody.querySelectorAll('.recall-item').forEach(item => {
      item.addEventListener('click', async () => {
        const src = (showAll ? patients : patientsWithTermin).find(p => p.id === parseInt(item.dataset.id));
        if (!src) return;
        close();
        await db.scheduleSlots.update(targetSlot.id, {
          patientNotes:   src.patientNotes,
          suspectedCodes: src.suspectedCodes || [],
        });
        const srcCatches = state.catches.filter(c => c.slotId === src.id);
        for (const c of srcCatches) {
          const { id: _ignore, ...rest } = c;
          await db.caughtDiagnoses.add({ ...rest, slotId: targetSlot.id, xpEarned: 0 });
        }
        state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
        if (state.plannerShiftId === shift.id) {
          state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).sortBy('startHour');
          renderTimeline(shift);
        }
      });
    });
  };

  document.getElementById('recall-filter-termin').addEventListener('change', e => {
    renderItems(!e.target.checked);
  });

  // Wire initial click handlers on the already-rendered list
  renderItems(false);
}

// ─── Diagnosen Tab ────────────────────────────────────────────────────────────

function _dxCompare(suspectedCodes, therapistCodes) {
  const norm = arr => (arr || []).map(c =>
    typeof c === 'string' ? { code: c, title: '' } : { code: c.code, title: c.title || c.name || '' });
  const myObjs = norm(suspectedCodes);
  const thObjs = norm(therapistCodes);
  const susp    = myObjs.map(c => c.code.trim().toUpperCase());
  const thCodes = thObjs.map(c => c.code.trim().toUpperCase());
  const matchKind = (sc, list) => {
    if (list.includes(sc))                                    return 'exact';
    if (list.some(tc => tc.slice(0, 3) === sc.slice(0, 3))) return 'partial';
    if (list.some(tc => tc.slice(0, 2) === sc.slice(0, 2))) return 'partial';
    return 'miss';
  };
  const myRows = myObjs.map(obj => {
    const sc = obj.code.trim().toUpperCase();
    return { code: sc, title: obj.title, kind: matchKind(sc, thCodes) };
  });
  const thRows = thObjs.map(obj => {
    const tc = obj.code.trim().toUpperCase();
    return { code: tc, title: obj.title, kind: matchKind(tc, susp) };
  });
  const comparisons = susp.length > 0
    ? susp.map(sc => DIAGNOSTIC_VERIFY_XP[matchKind(sc, thCodes)])
    : [DIAGNOSTIC_VERIFY_XP.miss];
  const xp = comparisons.reduce((s, r) => s + r.xp, 0);
  return { myRows, thRows, xp };
}

// ─── Zuteilung ─────────────────────────────────────────────────────────────────

const ZUTEIL_ROLES = {
  kassa:      { label:'Kassa',      short:'K',   icon:'💰', color:'#f59e0b', burden:3 },
  backoffice: { label:'Backoffice', short:'BO',  icon:'🖥️',  color:'#3b82f6', burden:2 },
  '5stock':   { label:'5. Stock',   short:'5F',  icon:'🏥', color:'#10b981', burden:2 },
  termin:     { label:'Termin',     short:'T',   icon:'📋', color:'#8b5cf6', burden:3 },
  system:     { label:'Ins System', short:'Sy',  icon:'💾', color:'#6366f1', burden:1 },
  pause:      { label:'Pause',      short:'P',   icon:'☕', color:'#6b7280', burden:0 },
  assist:     { label:'Assistenz',  short:'As',  icon:'👥', color:'#ec4899', burden:1 },
};

const TERMIN_DEFS = {
  anmeldung:    { label:'Anmeldung',    icon:'📝', dur:1 },
  interview:    { label:'Interview',    icon:'🎤', dur:2 },
  erstgesprach: { label:'Erstgespräch', icon:'💬', dur:1 },
};

const ANIMAL_TIERS = [
  { tier: 1, img: './assets/images/avatars/stars/avatar_draco.png',     name: 'Draco',      desc: 'Der Drache' },
  { tier: 2, img: './assets/images/avatars/stars/avatar_ursa.png',      name: 'Ursa Major', desc: 'Der Große Bär' },
  { tier: 3, img: './assets/images/avatars/stars/avatar_lupus.png',     name: 'Lupus',      desc: 'Der Wolf' },
  { tier: 4, img: './assets/images/avatars/stars/avatar_aquila.png',    name: 'Aquila',     desc: 'Der Adler' },
  { tier: 5, img: './assets/images/avatars/stars/avatar_vulpecula.png', name: 'Vulpecula',  desc: 'Der Fuchs' },
  { tier: 6, img: './assets/images/avatars/stars/avatar_noctua.png',    name: 'Noctua',     desc: 'Die Eule' },
  { tier: 7, img: './assets/images/avatars/stars/avatar_corvus.png',    name: 'Corvus',     desc: 'Der Rabe' },
];
const TRAINEE_AVATARS = [
  { img: './assets/images/avatars/stars/avatar_training_1.png', name: 'Doppelstern', desc: 'Mentoring' },
  { img: './assets/images/avatars/stars/avatar_training_2.png', name: 'Protostern',  desc: 'Neubeginn' },
];

function getZuteilBlocks(shift, blockSize) {
  const h = shiftHours(shift);
  const startH = Math.ceil((h.start[0]*60+h.start[1]) / (blockSize*60)) * blockSize;
  const endH   = Math.floor((h.end[0]*60+h.end[1]) / (blockSize*60)) * blockSize;
  const blocks = [];
  for (let s = startH; s < endH; s += blockSize) {
    blocks.push({ key:`${s}-${s+blockSize}`, start:s, end:s+blockSize,
      label:`${String(s).padStart(2,'0')}–${String(s+blockSize).padStart(2,'0')}` });
  }
  return blocks;
}

async function openZuteilungScreen(shift) {
  const modal = document.getElementById('zuteilung-modal');
  const inner = document.getElementById('zut-inner');
  const fresh = await db.shiftLogs.get(shift.id);
  if (!fresh) return;

  const userName = localStorage.getItem('psychodex-user-name') || '';
  const people = [];
  if (userName) people.push({
    name: userName,
    funktion: fresh.category === 'senior' ? 'Seniorassistent' : fresh.category === 'training' ? 'Training' : 'Assistent',
    present: true, _self: true,
    _isSenior: fresh.category === 'senior',
    _isTrainee: fresh.category === 'training',
  });
  for (const c of (fresh.colleagues||[])) {
    const team = effectiveTeam(c);
    if ((team === 'D' || team === 'T') && c.name.toLowerCase() !== userName.toLowerCase())
      people.push({ ...c, _isTrainee: team === 'T', _isSenior: c.funktion?.toLowerCase().includes('senior') ?? false });
  }

  let zData = fresh.zuteilung ? JSON.parse(JSON.stringify(fresh.zuteilung)) : {};
  zData.blockSize    = zData.blockSize    || 2;
  zData.assignments  = zData.assignments  || {};
  zData.personStates = zData.personStates || {};
  zData.termine      = zData.termine      || [];
  zData.undoStack    = zData.undoStack    || [];
  zData.planB        = zData.planB        || null;
  zData.dualPlanActive = zData.dualPlanActive || false;
  zData.planAPersons   = zData.planAPersons   || null;
  zData.redoStack      = [];                        // in-memory only, not persisted
  zData.stationView    = zData.stationView    || false;
  zData.personTiers    = zData.personTiers    || null;

  const saveData = () => {
    const { redoStack, ...saveable } = zData;
    return db.shiftLogs.update(fresh.id, { zuteilung: JSON.parse(JSON.stringify({
      ...saveable, undoStack: saveable.undoStack.slice(-20)
    })) });
  };

  const pushUndo = () => {
    zData.undoStack.push(JSON.parse(JSON.stringify({
      assignments: zData.assignments, personStates: zData.personStates, termine: zData.termine,
      planB: zData.planB, dualPlanActive: zData.dualPlanActive, planAPersons: zData.planAPersons,
      blockSize: zData.blockSize, personTiers: zData.personTiers,
    })));
    zData.redoStack = [];
    if (zData.undoStack.length > 20) zData.undoStack.shift();
  };

  // Init tiers on first open
  if (!zData.personTiers) {
    zData.personTiers = {};
    const nonSeniors = people.filter(p => !p._isSenior);
    people.filter(p => p._isSenior).forEach(p => { zData.personTiers[p.name] = 1; });
    const remainTiers = [2,3,4,5,6,7];
    for (let i = remainTiers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remainTiers[i], remainTiers[j]] = [remainTiers[j], remainTiers[i]];
    }
    nonSeniors.forEach((p, i) => { zData.personTiers[p.name] = remainTiers[i] ?? (i + 2); });
    saveData();
  }

  const render = () => renderZuteilGrid(inner, fresh, zData, people, { saveData, pushUndo, render });
  modal.classList.remove('hidden');
  render();

  // Notify if people from planB have since arrived (checked in rolecall after auto-assign ran)
  if (zData.dualPlanActive && zData.planAPersons) {
    const nowPresent = people.filter(p => {
      const ps = zData.personStates[p.name] || {};
      return p.present && !ps.notYetPresent;
    }).map(p => p.name);
    const newArrivals = nowPresent.filter(n => !zData.planAPersons.includes(n));
    if (newArrivals.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'zut-arrival-banner';
      banner.textContent = `🔔 ${newArrivals.join(', ')} ${newArrivals.length === 1 ? 'ist' : 'sind'} angekommen – Auto-Zuteilung neu ausführen!`;
      inner.prepend(banner);
      setTimeout(() => banner.remove(), 6000);
    }
  }

  document.getElementById('zut-backdrop').onclick = () => modal.classList.add('hidden');
}

function renderZuteilGrid(inner, shift, zData, people, { saveData, pushUndo, render }) {
  const blocks = getZuteilBlocks(shift, zData.blockSize);

  const isAvail = (p, block) => {
    if (!p.present) return false;
    const ps = zData.personStates[p.name] || {};
    if (ps.notYetPresent) return false;
    if (ps.earlyLeave) {
      const [lh] = ps.earlyLeave.split(':').map(Number);
      if (block.start >= lh) return false;
    }
    return true;
  };

  const presentCount = people.filter(p => {
    const ps = zData.personStates[p.name] || {};
    return p.present && !ps.notYetPresent;
  }).length;

  const planASet = new Set(zData.planAPersons || []);

  // Appointment numbering: per-type chronological (Interview #1/#2, Erstgespräch #1, etc.)
  const terminSorted = [...zData.termine].sort((a, b) =>
    ((a.startHour ?? a.hour) - (b.startHour ?? b.hour)) || (a.id - b.id));
  const terminNum = t => terminSorted.findIndex(x => x.id === t.id) + 1;
  const terminByType = {};
  for (const type of Object.keys(TERMIN_DEFS)) {
    terminByType[type] = terminSorted.filter(t => t.type === type);
  }
  const getTerminForCell = (personName, block) => {
    let t = terminSorted.find(tt => {
      if (tt.personName !== personName) return false;
      const tH = tt.startHour ?? tt.hour;
      const def = TERMIN_DEFS[tt.type];
      return def && block.start >= tH && block.start < tH + def.dur;
    });
    if (!t) t = terminSorted.find(tt => {
      const tH = tt.startHour ?? tt.hour;
      const def = TERMIN_DEFS[tt.type];
      return def && block.start >= tH && block.start < tH + def.dur;
    });
    return t ?? null;
  };
  const getTerminInfoForCell = (personName, block) => {
    const t = getTerminForCell(personName, block);
    if (!t) return null;
    const def = TERMIN_DEFS[t.type];
    const typeNum = terminByType[t.type].findIndex(x => x.id === t.id) + 1;
    return { icon: def.icon, num: typeNum, id: t.id };
  };

  // Person color for station view
  const PERSON_COLORS = [
    '#f59e0b','#10b981','#3b82f6','#ec4899','#8b5cf6','#06b6d4','#f97316','#a3e635',
    '#ef4444','#84cc16','#14b8a6','#6366f1','#f43f5e','#22d3ee','#d946ef','#fb923c',
    '#e879f9','#34d399','#60a5fa','#fbbf24','#a78bfa','#2dd4bf','#f87171','#86efac',
  ];
  const personColor = name => {
    let h = 0;
    for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    return PERSON_COLORS[Math.abs(h) % PERSON_COLORS.length];
  };
  const personInitials = name => name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

  // ── Person view grid ────────────────────────────────────────────────────────
  const bodyRows = people.map(p => {
    const ps = zData.personStates[p.name] || {};
    const earlyMark = ps.earlyLeave ? `<span class="zut-early-tag">⏰${ps.earlyLeave}</span>` : '';
    const absent = !p.present;
    const isPlanBRow = zData.dualPlanActive && (!p.present || ps.notYetPresent);
    const firstName = p.name.split(' ')[0];
    const cells = blocks.map(b => {
      const key = `${p.name}::${b.key}`;
      const role = zData.assignments[key];
      const ri   = role ? ZUTEIL_ROLES[role] : null;
      const unavail = !isAvail(p, b);
      const terminInfo = ri && role === 'termin' ? getTerminInfoForCell(p.name, b) : null;
      const cellInner = ri
        ? `<span class="zut-cell-icon">${terminInfo ? terminInfo.icon : ri.icon}</span><span class="zut-role-short">${terminInfo ? '#' + terminInfo.num : ri.short}</span>`
        : `<span class="zut-empty-dot">·</span>`;
      const terminDragAttrs = terminInfo ? `draggable="true" data-terminid="${terminInfo.id}"` : '';
      return `<td class="zut-cell${unavail?' zut-cell-unavail':''}">
        <button class="zut-cell-btn${ri?' has-role':''}${isPlanBRow?' plan-b-cell':''}" data-key="${key}"
                style="${ri?`background:${ri.color}1a;border-color:${ri.color}55;color:${ri.color}`:''}"
                ${unavail?'disabled':''} ${terminDragAttrs}>${cellInner}</button></td>`;
    }).join('');
    const tierNum = zData.personTiers?.[p.name];
    const tierInfo = tierNum ? ANIMAL_TIERS[tierNum - 1] : null;
    const tierAvatar = p._isTrainee
      ? TRAINEE_AVATARS[1]
      : tierInfo ?? null;
    const badges = [
      tierAvatar ? `<img class="zut-tier-avatar" src="${tierAvatar.img}" title="${tierAvatar.name} · ${tierAvatar.desc}" alt="${tierAvatar.name}">` : '',
      p._self ? '<span class="team-self-badge">Ich</span>' : '',
      p._isSenior ? '<span class="zut-senior-tag">★</span>' : '',
      p._isTrainee ? '<span class="zut-trainee-tag">🎓</span>' : '',
      isPlanBRow ? '<span class="zut-planb-tag">Plan B</span>' : '',
    ].filter(Boolean).join('');
    return `<tr class="zut-row${absent?' zut-row-absent':''}${ps.notYetPresent&&!absent?' zut-row-notyet':''}">
      <td class="zut-td-name">
        <div class="zut-person-name zut-person-clickable" data-pname="${p.name}" title="${p.name}">${firstName}${badges?' '+badges:''}</div>
        <div class="zut-person-sub">
          ${!absent?`<button class="zut-checkin-btn${ps.notYetPresent?' absent':' present'}" data-pname="${p.name}">${ps.notYetPresent?'⏳':'✓'}</button>`:''}
          ${earlyMark}
          ${!absent?`<button class="zut-early-btn${ps.earlyLeave?' active':''}" data-pname="${p.name}" title="Frühgang">⏰</button>`:''}
        </div>
      </td>${cells}</tr>`;
  }).join('');

  const covRow = `<tr class="zut-cov-row">
    <td class="zut-td-name"><span class="zut-cov-label">Abdeckung</span></td>
    ${blocks.map(b => {
      const roles = people
        .filter(p => !zData.dualPlanActive || planASet.has(p.name))
        .map(p => zData.assignments[`${p.name}::${b.key}`]).filter(Boolean);
      const hasK = roles.includes('kassa'), hasB = roles.includes('backoffice');
      return `<td class="zut-cell" style="text-align:center;padding:4px 2px">
        <span style="color:${hasK?'#10b981':'#ef4444'};font-size:11px;font-weight:700">K</span>
        <span style="color:${hasB?'#10b981':'#ef4444'};font-size:11px;font-weight:700">B</span></td>`;
    }).join('')}
  </tr>`;

  // ── Station view grid ───────────────────────────────────────────────────────
  const stationGridHtml = (() => {
    // Termin rows: static display only
    const chipCell = (covering, needsAlert) => {
      if (!covering.length)
        return `<td class="zut-cell zut-station-cell"${needsAlert?' style="background:rgba(239,68,68,.09)"':''}>${needsAlert?'<span class="zut-station-gap">!</span>':''}</td>`;
      return `<td class="zut-cell zut-station-cell">${covering.map(p => {
        const color = personColor(p.name);
        return `<span class="zut-station-chip" style="background:${color}33;border:1.5px solid ${color}88;color:${color}" data-pname="${p.name}" title="${p.name}">${personInitials(p.name)}</span>`;
      }).join('')}</td>`;
    };
    // Role rows: draggable chips + droppable cells
    const roleChipCell = (covering, needsAlert, blockKey, roleKey) => {
      const drop = `data-blockkey="${blockKey}" data-role="${roleKey}"`;
      if (!covering.length)
        return `<td class="zut-cell zut-station-cell zut-station-drop" ${drop}${needsAlert?' style="background:rgba(239,68,68,.09)"':''}>${needsAlert?'<span class="zut-station-gap">!</span>':''}</td>`;
      return `<td class="zut-cell zut-station-cell zut-station-drop" ${drop}>${covering.map(p => {
        const color = personColor(p.name);
        return `<span class="zut-station-chip" draggable="true" style="background:${color}33;border:1.5px solid ${color}88;color:${color}" data-pname="${p.name}" data-blockkey="${blockKey}" data-role="${roleKey}" title="${p.name}">${personInitials(p.name)}</span>`;
      }).join('')}</td>`;
    };
    const terminTypes = [...new Set(terminSorted.map(t => t.type))];
    const terminRows = terminTypes.map(type => {
      const def = TERMIN_DEFS[type];
      const typeTermins = terminSorted.filter(t => t.type === type);
      const cells = blocks.map(b => {
        const covering = [];
        for (const t of typeTermins) {
          const tH = t.startHour ?? t.hour;
          if (b.start < tH || b.start >= tH + def.dur) continue;
          if (t.personName) {
            const person = people.find(p => p.name === t.personName);
            if (person && !covering.some(c => c.name === person.name)) covering.push(person);
          }
        }
        const anyInRange = typeTermins.some(t => { const tH = t.startHour ?? t.hour; return b.start >= tH && b.start < tH + def.dur; });
        const needsAlert = anyInRange && covering.length === 0 && typeTermins.some(t => !t.isInternational);
        return chipCell(covering, needsAlert);
      }).join('');
      return `<tr><td class="zut-td-name zut-station-name-td zut-station-short-td">${def.icon}<span class="zut-station-role-short">${def.label}</span></td>${cells}</tr>`;
    }).join('');
    const roleRows = ['kassa','backoffice','5stock'].map(rk => {
      const ri = ZUTEIL_ROLES[rk];
      if (!ri) return '';
      const cells = blocks.map(b => {
        const covering = people.filter(p => zData.assignments[`${p.name}::${b.key}`] === rk);
        return roleChipCell(covering, (rk === 'kassa' || rk === 'backoffice') && covering.length === 0, b.key, rk);
      }).join('');
      return `<tr><td class="zut-td-name zut-station-name-td zut-station-short-td">${ri.icon}<span class="zut-station-role-short">${ri.short}</span></td>${cells}</tr>`;
    }).filter(Boolean).join('');
    return `<table class="zut-table"><thead><tr>
        <th class="zut-th-name" style="min-width:70px">Station</th>
        ${blocks.map(b=>`<th class="zut-th-block">${b.label}</th>`).join('')}
      </tr></thead><tbody>${terminRows}${roleRows}</tbody></table>`;
  })();

  const shiftH   = shiftHours(shift);
  const tlStartH = shiftH.start[0];
  const tlEndH   = shiftH.end[0] + (shiftH.end[1] > 0 ? 1 : 0);
  const tlHours  = Array.from({ length: tlEndH - tlStartH }, (_, i) => tlStartH + i);

  const tlCols = tlHours.map(h => {
    const chips = terminSorted
      .filter(t => (t.startHour ?? t.hour) === h)
      .map(t => {
        const def = TERMIN_DEFS[t.type];
        const num = terminByType[t.type].findIndex(x => x.id === t.id) + 1;
        const pInit = t.personName ? personInitials(t.personName) : '';
        const badges = `${t.isInternational ? '<span class="zut-chip-badge">INT</span>' : t.isDemo ? '<span class="zut-chip-badge">D</span>' : ''}`;
        const titleParts = [def.label, t.personName, t.isDemo&&!t.isInternational?'Demo':null, t.isInternational?'International':null].filter(Boolean);
        return `<div class="zut-tl-chip${t.isInternational?' zut-chip-intl':''}${t.personName?' zut-chip-ok':''}" data-tid="${t.id}" draggable="true" title="${titleParts.join(' · ')}">
          <span class="zut-chip-icon">${def.icon}</span>
          <span class="zut-chip-num">#${num}</span>
          ${pInit?`<span class="zut-chip-person">${pInit}</span>`:''}
          ${t.personName?'<span class="zut-chip-check">✓</span>':''}
          ${badges}
        </div>`;
      }).join('');
    return `<div class="zut-tl-col" data-hour="${h}">
      <div class="zut-tl-hour">${String(h).padStart(2,'0')}</div>
      <div class="zut-tl-dropzone">${chips}</div>
    </div>`;
  }).join('');

  const dateStr = new Date(shift.date+'T12:00').toLocaleDateString('de-AT',{weekday:'short',day:'numeric',month:'numeric'});


  inner.innerHTML = `
    <div class="zut-header">
      <div><div class="zut-title">📋 Zuteilung</div><div class="zut-subtitle">${dateStr} · ${shiftLabel(shift.type)}</div></div>
      <div class="zut-header-actions">
        <button class="zut-hdr-btn" id="zut-undo-btn"${!zData.undoStack.length?' disabled':''} title="Rückgängig">↩</button>
        <button class="zut-hdr-btn" id="zut-redo-btn"${!zData.redoStack?.length?' disabled':''} title="Wiederholen">↪</button>
        <button class="zut-hdr-btn" id="zut-reset-btn" title="Zurücksetzen">🔄</button>
        <button class="zut-hdr-btn" id="zut-size-btn" title="Blockgröße umschalten">${zData.blockSize}h</button>
        <button class="zut-hdr-close" id="zut-close-btn">✕</button>
      </div>
    </div>
    <div class="zut-termin-section${zData.stationView?' hidden':''}">
      <div class="zut-termin-add-row">
        <span class="zut-bar-label">Termine</span>
        <button class="zut-termin-add-btn" data-type="anmeldung" title="Anmeldung">📝+</button>
        <button class="zut-termin-add-btn" data-type="erstgesprach" title="Erstgespräch">💬+</button>
        <button class="zut-termin-add-btn" data-type="interview" title="Interview">🎤+</button>
      </div>
      <div class="zut-tl-scroll">${tlCols}</div>
    </div>
    ${zData.dualPlanActive ? `<div class="zut-dual-banner">⚠️ Backup-Plan aktiv · ${people.length - (zData.planAPersons?.length || 0)} Person(en) fehlen noch</div>` : ''}
    <div class="zut-view-toggle-row">
      <button class="zut-view-tab${!zData.stationView?' active':''}" id="zut-view-person">👤 Personen</button>
      <button class="zut-view-tab${zData.stationView?' active':''}" id="zut-view-station">🏥 Stationen</button>
    </div>
    <div class="zut-grid-wrap">
      ${zData.stationView ? stationGridHtml : `<table class="zut-table">
        <thead><tr>
          <th class="zut-th-name">Person (${presentCount})</th>
          ${blocks.map(b=>`<th class="zut-th-block">${b.label}</th>`).join('')}
        </tr></thead>
        <tbody>${bodyRows}${covRow}</tbody>
      </table>`}
    </div>
    <div class="zut-footer">
      <div class="zut-present-label">${presentCount} anwesend · ${people.length} gesamt</div>
      <button class="btn-secondary" id="zut-seniority-btn" title="Tier nach Dienstalter vergeben">🏅 Dienstalter</button>
      <button class="btn-primary" id="zut-auto-btn">⚡ Auto-Zuteilung</button>
    </div>`;

  // ── Event handlers ──────────────────────────────────────────────────────────
  inner.querySelector('#zut-close-btn').onclick = () =>
    document.getElementById('zuteilung-modal').classList.add('hidden');

  inner.querySelector('#zut-undo-btn').onclick = () => {
    if (!zData.undoStack.length) return;
    const cur = JSON.parse(JSON.stringify({ assignments: zData.assignments, personStates: zData.personStates,
      termine: zData.termine, planB: zData.planB, dualPlanActive: zData.dualPlanActive, planAPersons: zData.planAPersons, blockSize: zData.blockSize }));
    (zData.redoStack = zData.redoStack || []).push(cur);
    const snap = zData.undoStack.pop();
    Object.assign(zData, snap); saveData(); render();
  };

  inner.querySelector('#zut-redo-btn').onclick = () => {
    if (!zData.redoStack?.length) return;
    const cur = JSON.parse(JSON.stringify({ assignments: zData.assignments, personStates: zData.personStates,
      termine: zData.termine, planB: zData.planB, dualPlanActive: zData.dualPlanActive, planAPersons: zData.planAPersons, blockSize: zData.blockSize }));
    zData.undoStack.push(cur);
    const snap = zData.redoStack.pop();
    Object.assign(zData, snap); saveData(); render();
  };

  inner.querySelector('#zut-reset-btn').onclick = () => {
    if (!confirm('Alle Zuteilungen zurücksetzen?')) return;
    pushUndo(); zData.assignments = {}; saveData(); render();
  };

  inner.querySelector('#zut-size-btn').onclick = () => {
    pushUndo();
    const oldSize = zData.blockSize, newSize = oldSize === 2 ? 1 : 2;
    const oldBlocks = getZuteilBlocks(shift, oldSize);
    const newBlocks = getZuteilBlocks(shift, newSize);
    const newAsgn = {};
    for (const [key, role] of Object.entries(zData.assignments)) {
      const [name, bk] = key.split('::');
      const ob = oldBlocks.find(b => b.key === bk);
      if (!ob) continue;
      for (const nb of newBlocks) {
        if (nb.start >= ob.start && nb.end <= ob.end) {
          const nk = `${name}::${nb.key}`;
          if (!newAsgn[nk]) newAsgn[nk] = role;
        }
      }
    }
    zData.blockSize = newSize;
    zData.assignments = newAsgn;
    saveData(); render();
  };

  inner.querySelector('#zut-seniority-btn').onclick = () => {
    pushUndo();
    const newTiers = {};
    const seniors  = people.filter(p => p._isSenior);
    const sortable = people.filter(p => !p._isSenior && !p._isTrainee);
    sortable.sort((a, b) => (b.stunden || 0) - (a.stunden || 0));
    if (seniors.length > 0) {
      seniors.forEach(p => { newTiers[p.name] = 1; });
      const availTiers = [2, 3, 4, 5, 6, 7];
      sortable.forEach((p, i) => { newTiers[p.name] = availTiers[i] ?? (i + 2); });
    } else {
      const allTiers = [1, 2, 3, 4, 5, 6, 7];
      sortable.forEach((p, i) => { newTiers[p.name] = allTiers[i] ?? (i + 1); });
    }
    zData.personTiers = newTiers;
    saveData(); render();
  };

  inner.querySelector('#zut-auto-btn').onclick = () => {
    pushUndo();
    const result = autoAssignZuteilung(getZuteilBlocks(shift, zData.blockSize), people, zData);
    zData.assignments    = result.assignments;
    zData.planB          = result.planB;
    zData.dualPlanActive = result.dualPlanActive;
    zData.planAPersons   = result.planAPersons;
    zData.termine        = result.resolvedTermine ?? zData.termine;
    saveData(); render();
  };

  inner.querySelector('#zut-view-person').onclick = () => { zData.stationView = false; saveData(); render(); };
  inner.querySelector('#zut-view-station').onclick = () => { zData.stationView = true; saveData(); render(); };

  inner.querySelectorAll('.zut-termin-add-btn').forEach(btn => {
    btn.onclick = () => {
      const type  = btn.dataset.type;
      const dur   = TERMIN_DEFS[type]?.dur ?? 1;
      const sameType = zData.termine.filter(t => t.type === type);
      const baseH = type === 'anmeldung' ? tlStartH : tlStartH + 2;
      let h = baseH;
      // Find first slot that doesn't overlap any existing termin of the same type
      while (h < tlEndH) {
        const overlaps = sameType.some(t => {
          const tH = t.startHour ?? t.hour;
          return h < tH + dur && h + dur > tH;
        });
        if (!overlaps) break;
        h += dur;
      }
      if (h + dur > tlEndH) h = Math.max(baseH, tlEndH - dur);
      pushUndo();
      zData.termine.push({ id: Date.now(), type, startHour: h, personName: null });
      saveData(); render();
    };
  });

  inner.querySelectorAll('.zut-tl-chip').forEach(chip => {
    let touchStart = null;
    chip.addEventListener('touchstart', e => {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      chip.classList.add('zut-chip-dragging');
    }, { passive: true });
    chip.addEventListener('touchmove', e => {
      if (!touchStart) return;
      const { clientX, clientY } = e.touches[0];
      const dx = clientX - touchStart.x, dy = clientY - touchStart.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) chip.dataset.moved = '1';
      inner.querySelectorAll('.zut-tl-col').forEach(c => c.classList.remove('zut-drop-target'));
      document.elementFromPoint(clientX, clientY)?.closest('.zut-tl-col')?.classList.add('zut-drop-target');
    }, { passive: true });
    chip.addEventListener('touchend', e => {
      chip.classList.remove('zut-chip-dragging');
      inner.querySelectorAll('.zut-tl-col').forEach(c => c.classList.remove('zut-drop-target'));
      const wasDrag = chip.dataset.moved === '1';
      delete chip.dataset.moved; touchStart = null;
      const tid = parseInt(chip.dataset.tid);
      const t = zData.termine.find(t => t.id === tid);
      if (!t) return;
      if (!wasDrag) { openZuteilEditTermin(t, tlHours, people, zData, saveData, pushUndo, render); return; }
      const { clientX, clientY } = e.changedTouches[0];
      const col = document.elementFromPoint(clientX, clientY)?.closest('.zut-tl-col');
      if (!col) { render(); return; }
      const newH = parseInt(col.dataset.hour);
      if ((t.startHour ?? t.hour) !== newH) { pushUndo(); t.startHour = newH; saveData(); }
      render();
    });
    chip.addEventListener('dragstart', e => {
      chip.dataset.dragging = '1';
      e.dataTransfer.setData('text/plain', chip.dataset.tid);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => chip.classList.add('zut-chip-dragging'), 0);
    });
    chip.addEventListener('dragend', () => { chip.classList.remove('zut-chip-dragging'); delete chip.dataset.dragging; });
    chip.addEventListener('click', e => {
      if (chip.dataset.dragging) return;
      e.stopPropagation();
      const t = zData.termine.find(t => t.id === parseInt(chip.dataset.tid));
      if (t) openZuteilEditTermin(t, tlHours, people, zData, saveData, pushUndo, render);
    });
  });

  inner.querySelectorAll('.zut-tl-col').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      inner.querySelectorAll('.zut-tl-col').forEach(c => c.classList.remove('zut-drop-target'));
      col.classList.add('zut-drop-target');
    });
    col.addEventListener('dragleave', () => col.classList.remove('zut-drop-target'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('zut-drop-target');
      const tid = parseInt(e.dataTransfer.getData('text/plain'));
      const t = zData.termine.find(t => t.id === tid);
      const newH = parseInt(col.dataset.hour);
      if (t && (t.startHour ?? t.hour) !== newH) { pushUndo(); t.startHour = newH; saveData(); render(); }
    });
  });

  inner.querySelectorAll('.zut-checkin-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation(); pushUndo();
      const ps = zData.personStates[btn.dataset.pname] || {};
      zData.personStates[btn.dataset.pname] = { ...ps, notYetPresent: !ps.notYetPresent };
      saveData(); render();
    };
  });

  inner.querySelectorAll('.zut-early-btn').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); openZuteilEarlyLeave(btn.dataset.pname, zData, saveData, pushUndo, render); };
  });

  inner.querySelectorAll('.zut-cell-btn:not([disabled])').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); showZuteilPicker(btn, btn.dataset.key, zData, saveData, pushUndo, render); };
  });

  inner.querySelectorAll('.zut-person-clickable').forEach(el => {
    el.addEventListener('click', () => openPersonTierModal(el.dataset.pname, people, zData, saveData, render));
  });

  // Station chip click → person modal (only non-draggable chips in termin rows)
  inner.querySelectorAll('.zut-station-chip[data-pname]:not([draggable])').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      openPersonTierModal(chip.dataset.pname, people, zData, saveData, render);
    });
  });

  // ── Station view drag-and-drop ─────────────────────────────────────────────
  let stationDrag = null;
  inner.querySelectorAll('.zut-station-chip[draggable]').forEach(chip => {
    chip.addEventListener('dragstart', e => {
      stationDrag = { pname: chip.dataset.pname, blockkey: chip.dataset.blockkey };
      e.dataTransfer.setData('text/plain', chip.dataset.pname);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => chip.classList.add('zut-chip-dragging'), 0);
    });
    chip.addEventListener('dragend', () => chip.classList.remove('zut-chip-dragging'));
    chip.addEventListener('click', e => {
      e.stopPropagation();
      openPersonTierModal(chip.dataset.pname, people, zData, saveData, render);
    });
  });
  inner.querySelectorAll('.zut-station-drop').forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('zut-drop-target'); });
    cell.addEventListener('dragleave', e => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('zut-drop-target'); });
    cell.addEventListener('drop', e => {
      e.preventDefault(); cell.classList.remove('zut-drop-target');
      if (!stationDrag) return;
      const { pname, blockkey: fromBlock } = stationDrag;
      const toBlock = cell.dataset.blockkey;
      const toRole  = cell.dataset.role;
      stationDrag = null;
      if (fromBlock === toBlock) return;
      pushUndo();
      delete zData.assignments[`${pname}::${fromBlock}`];
      zData.assignments[`${pname}::${toBlock}`] = toRole;
      saveData(); render();
    });
  });

  // ── Person view: termin cell drag to reassign appointment ──────────────────
  let terminDrag = null;
  inner.querySelectorAll('.zut-cell-btn[data-terminid]').forEach(btn => {
    btn.addEventListener('dragstart', e => {
      const tid = parseInt(btn.dataset.terminid);
      const [fromPname] = btn.dataset.key.split('::');
      terminDrag = { tid, fromPname };
      e.dataTransfer.setData('text/plain', String(tid));
      e.dataTransfer.effectAllowed = 'move';
    });
    btn.addEventListener('dragend', () => { terminDrag = null; });
  });
  inner.querySelectorAll('.zut-cell-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('dragover', e => {
      if (!terminDrag) return;
      const [toPname] = btn.dataset.key.split('::');
      if (toPname !== terminDrag.fromPname) { e.preventDefault(); btn.classList.add('zut-drop-target'); }
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('zut-drop-target'));
    btn.addEventListener('drop', e => {
      e.preventDefault(); btn.classList.remove('zut-drop-target');
      if (!terminDrag) return;
      const { tid, fromPname } = terminDrag;
      const [toPname] = btn.dataset.key.split('::');
      terminDrag = null;
      if (toPname === fromPname) return;
      const termin = zData.termine.find(t => t.id === tid);
      if (!termin) return;
      const def = TERMIN_DEFS[termin.type];
      const tHour = termin.startHour ?? termin.hour;
      pushUndo();
      blocks.forEach(b => {
        if (b.start >= tHour && b.start < tHour + def.dur) {
          delete zData.assignments[`${fromPname}::${b.key}`];
          zData.assignments[`${toPname}::${b.key}`] = 'termin';
        }
      });
      const idx = zData.termine.findIndex(t => t.id === tid);
      if (idx >= 0) zData.termine[idx].personName = toPname;
      saveData(); render();
    });
  });
}

function showZuteilPicker(triggerBtn, cellKey, zData, saveData, pushUndo, render) {
  document.querySelectorAll('.zut-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'zut-picker';
  const cur = zData.assignments[cellKey];
  const entries = [
    ...Object.entries(ZUTEIL_ROLES).filter(([k]) => k !== 'system' && k !== 'termin'),
    ['termin', { label:'Anmeldung',    icon: TERMIN_DEFS.anmeldung.icon    }],
    ['termin', { label:'Interview',    icon: TERMIN_DEFS.interview.icon     }],
    ['termin', { label:'Erstgespräch', icon: TERMIN_DEFS.erstgesprach.icon  }],
    ['', { label:'Leer', icon:'✕' }],
  ];
  picker.innerHTML = entries.map(([key,r]) =>
    `<button class="zut-picker-btn${cur===key?' active':''}" data-role="${key}">
       <span class="zut-picker-icon">${r.icon}</span>
       <span class="zut-picker-lbl">${r.label}</span></button>`
  ).join('');
  document.body.appendChild(picker);
  const rect = triggerBtn.getBoundingClientRect();
  const ph = 230;
  const top  = rect.bottom + 4 + ph > window.innerHeight ? rect.top - ph - 4 : rect.bottom + 4;
  const left = Math.min(Math.max(rect.left - 60, 8), window.innerWidth - 218);
  picker.style.cssText = `position:fixed;top:${Math.max(4,top)}px;left:${left}px`;
  picker.querySelectorAll('.zut-picker-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      pushUndo();
      if (btn.dataset.role === '') delete zData.assignments[cellKey];
      else zData.assignments[cellKey] = btn.dataset.role;
      picker.remove(); saveData(); render();
    };
  });
  requestAnimationFrame(() =>
    document.addEventListener('click', () => picker.remove(), { once:true })
  );
}

function openPersonTierModal(personName, people, zData, saveData, render) {
  const person = people.find(p => p.name === personName);
  if (!person) return;
  const currentTier = zData.personTiers?.[personName] ?? null;
  const existing = document.getElementById('person-tier-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'person-tier-modal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" id="ptm-backdrop"></div>
    <div class="modal-sheet">
      <div class="sheet-header">
        <div class="modal-title" style="display:flex;align-items:center;gap:8px">
          ${currentTier ? `<img class="zut-tier-avatar-lg" src="${ANIMAL_TIERS[currentTier-1].img}" alt="">` : ''}
          ${personName}
        </div>
      </div>
      <div class="sheet-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-dim)">
          ${person._isSenior?'★ Seniorassistent · ':''}${person._isTrainee?'🎓 Ausbildung · ':''}${person._self?'(Ich)':''}
        </div>
        ${person.stunden != null ? `<div style="font-size:13px;color:var(--text-muted)">${person.stunden}h · ${person.pct != null ? person.pct + '%' : ''} Dienstalter</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:6px">
          <label class="form-label">Sternbild</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${ANIMAL_TIERS.map(t => `<button class="ptm-tier-btn${t.tier===currentTier?' ptm-tier-active':''}" data-tier="${t.tier}" title="${t.desc}">
              <img src="${t.img}" alt="${t.name}" style="width:32px;height:32px;object-fit:contain;display:block;margin:0 auto 2px">
              <span style="font-size:9px;display:block;text-align:center">${t.name}</span>
            </button>`).join('')}
          </div>
        </div>
      </div>
      <div class="sheet-footer">
        <button id="ptm-cancel" class="btn-secondary">Abbrechen</button>
        <button id="ptm-save" class="btn-primary" style="flex:1">Speichern</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  let selectedTier = currentTier;
  modal.querySelectorAll('.ptm-tier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedTier = parseInt(btn.dataset.tier);
      modal.querySelectorAll('.ptm-tier-btn').forEach(b => b.classList.remove('ptm-tier-active'));
      btn.classList.add('ptm-tier-active');
    });
  });
  const close = () => modal.remove();
  document.getElementById('ptm-backdrop').onclick = close;
  document.getElementById('ptm-cancel').onclick = close;
  document.getElementById('ptm-save').onclick = () => {
    if (!zData.personTiers) zData.personTiers = {};
    if (selectedTier) zData.personTiers[personName] = selectedTier;
    saveData(); render(); close();
  };
}

function openZuteilEarlyLeave(personName, zData, saveData, pushUndo, render) {
  document.querySelectorAll('.zut-popup').forEach(p => p.remove());
  const ps = zData.personStates[personName] || {};
  const popup = document.createElement('div');
  popup.className = 'zut-popup';
  popup.innerHTML = `
    <div class="zut-popup-title">⏰ Frühgang · ${personName.split(' ')[0]}</div>
    <div class="zut-popup-row"><span>Uhrzeit</span>
      <input type="time" id="zp-early" value="${ps.earlyLeave||''}" class="form-input" style="width:90px;padding:4px 8px">
    </div>
    <div class="zut-popup-btns">
      <button class="btn-primary" id="zp-save">OK</button>
      ${ps.earlyLeave?'<button class="btn-secondary" id="zp-clear">Löschen</button>':''}
      <button class="btn-secondary" id="zp-cancel">Abbrechen</button>
    </div>`;
  document.getElementById('zuteilung-modal').appendChild(popup);
  const close = () => popup.remove();
  popup.querySelector('#zp-cancel').onclick = close;
  const clearBtn = popup.querySelector('#zp-clear');
  if (clearBtn) clearBtn.onclick = () => {
    pushUndo();
    zData.personStates[personName] = { ...ps, earlyLeave: null };
    close(); saveData(); render();
  };
  popup.querySelector('#zp-save').onclick = () => {
    pushUndo();
    zData.personStates[personName] = { ...ps, earlyLeave: popup.querySelector('#zp-early').value || null };
    close(); saveData(); render();
  };
}

function openZuteilEditTermin(termin, tlHours, people, zData, saveData, pushUndo, render) {
  document.querySelectorAll('.zut-popup').forEach(p => p.remove());
  const def = TERMIN_DEFS[termin.type];
  const cur  = termin.startHour ?? termin.hour;
  const presentPeople = people.filter(p => p.present && !(zData.personStates[p.name]||{}).notYetPresent && !p._isTrainee);
  const isEG = termin.type === 'erstgesprach';
  const popup = document.createElement('div');
  popup.className = 'zut-popup';
  popup.innerHTML = `
    <div class="zut-popup-title">${def.icon} ${def.label}</div>
    <div class="zut-popup-row"><span>Uhrzeit</span>
      <select id="zp-thour" class="form-input" style="flex:1">
        ${tlHours.map(h=>`<option value="${h}"${h===cur?' selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}
      </select></div>
    ${isEG ? `
    <label class="zut-popup-row"><span>Demo-Termin</span>
      <input type="checkbox" id="zp-demo" ${termin.isDemo?'checked':''}></label>
    <label class="zut-popup-row" id="zp-intl-row" style="${!termin.isDemo?'display:none':''}"><span>🌍 International</span>
      <input type="checkbox" id="zp-intl" ${termin.isInternational?'checked':''}></label>
    ` : ''}
    <div class="zut-popup-row" id="zp-person-row" style="${termin.isInternational?'display:none':''}"><span>Person</span>
      <select id="zp-tperson" class="form-input" style="flex:1">
        <option value=""${!termin.personName?' selected':''}>– optional –</option>
        ${presentPeople.map(p=>`<option value="${p.name}"${p.name===termin.personName?' selected':''}>${p.name}${p._isSenior?' ★':''}</option>`).join('')}
      </select></div>
    <div class="zut-popup-btns">
      <button class="btn-primary" id="zp-tsave">Speichern</button>
      <button class="btn-secondary" id="zp-tcancel">Abbrechen</button>
    </div>
    <button class="btn-secondary" id="zp-tdel" style="width:100%;margin-top:6px;color:#f87171;border-color:rgba(248,113,113,.4)">🗑 Löschen</button>`;
  document.getElementById('zuteilung-modal').appendChild(popup);

  // Demo toggle shows/hides International + person row
  if (isEG) {
    popup.querySelector('#zp-demo').onchange = e => {
      popup.querySelector('#zp-intl-row').style.display = e.target.checked ? '' : 'none';
      if (!e.target.checked) popup.querySelector('#zp-intl').checked = false;
      popup.querySelector('#zp-person-row').style.display = '';
    };
    popup.querySelector('#zp-intl').onchange = e => {
      popup.querySelector('#zp-person-row').style.display = e.target.checked ? 'none' : '';
    };
  }

  const close = () => popup.remove();
  popup.querySelector('#zp-tcancel').onclick = close;
  popup.querySelector('#zp-tdel').onclick = () => {
    pushUndo();
    zData.termine = zData.termine.filter(t => t.id !== termin.id);
    close(); saveData(); render();
  };
  popup.querySelector('#zp-tsave').onclick = () => {
    pushUndo();
    const idx = zData.termine.findIndex(t => t.id === termin.id);
    if (idx >= 0) {
      zData.termine[idx].startHour = parseInt(popup.querySelector('#zp-thour').value);
      if (isEG) {
        const isDemo  = popup.querySelector('#zp-demo').checked;
        const isIntl  = popup.querySelector('#zp-intl').checked;
        zData.termine[idx].isDemo         = isDemo;
        zData.termine[idx].isInternational = isIntl;
        zData.termine[idx].personName     = isIntl ? null : (popup.querySelector('#zp-tperson').value || null);
      } else {
        zData.termine[idx].personName = popup.querySelector('#zp-tperson').value || null;
      }
    }
    close(); saveData(); render();
  };
}

function runAutoAssign(allowedPeopleIn, blocks, termine, personStates, blockSize, { planBMode = false, personTiers = {} } = {}) {
  // Shuffle for variety on each call
  const allowedPeople = [...allowedPeopleIn];
  for (let i = allowedPeople.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allowedPeople[i], allowedPeople[j]] = [allowedPeople[j], allowedPeople[i]];
  }
  const result = {};
  const terminCount = Object.fromEntries(allowedPeople.map(p => [p.name, 0]));
  const trainees    = allowedPeople.filter(p => p._isTrainee);
  const nonTrainees = allowedPeople.filter(p => !p._isTrainee);

  // Availability helpers
  const isAvailAtBlock = (p, block, bi) => {
    if (!p.present) return false;
    const ps = personStates[p.name] || {};
    if (ps.notYetPresent) {
      if (!planBMode) return false;
      if (bi === 0) return false; // late arrivals skip first block in planB
    }
    if (ps.earlyLeave) {
      const [lh] = ps.earlyLeave.split(':').map(Number);
      if (block.start >= lh) return false;
    }
    return true;
  };

  const isAvailAtHour = (p, hour) => {
    if (!p.present) return false;
    const ps = personStates[p.name] || {};
    if (ps.notYetPresent) {
      if (!planBMode) return false;
      if (blocks[1] && hour < blocks[1].start) return false;
    }
    if (ps.earlyLeave) {
      const [lh] = ps.earlyLeave.split(':').map(Number);
      if (hour >= lh) return false;
    }
    return true;
  };

  // ── Step 1: Resolve termine (auto-assign person if unset) ─────────────────
  // Process chronologically so earlier appointments are assigned first
  const termineSorted1 = [...termine].sort((a, b) =>
    ((a.startHour ?? a.hour) - (b.startHour ?? b.hour)) || (a.id - b.id));
  const resolvedTermine = [];
  for (const t of termineSorted1) {
    const tHour = t.startHour ?? t.hour;
    const def = TERMIN_DEFS[t.type];

    // International demos: DEU team doesn't do them (trainees may still assist)
    if (t.isInternational) { resolvedTermine.push({ ...t, personName: null }); continue; }

    // Manually assigned to a valid non-trainee: keep it
    if (t.personName && nonTrainees.some(p => p.name === t.personName)) { resolvedTermine.push(t); continue; }

    const avail = nonTrainees.filter(p => {
      if (!isAvailAtHour(p, tHour)) return false;
      // Termin + follow-up block must fit before early leave
      const ps = personStates[p.name] || {};
      if (ps.earlyLeave) {
        const [lh] = ps.earlyLeave.split(':').map(Number);
        if (tHour + def.dur + blockSize > lh) return false;
      }
      // Don't assign if person already has a conflicting termin
      return !resolvedTermine.some(rt => {
        if (rt.personName !== p.name) return false;
        const rtH = rt.startHour ?? rt.hour;
        const rtDef = TERMIN_DEFS[rt.type];
        return rtDef && tHour < rtH + rtDef.dur && tHour + def.dur > rtH;
      });
    }).sort((a, b) => {
      // Round-robin: score = terminCount * 8 + tierNum
      const ta = personTiers[a.name] ?? (a._isSenior ? 1 : 4);
      const tb = personTiers[b.name] ?? (b._isSenior ? 1 : 4);
      return (terminCount[a.name] * 8 + ta) - (terminCount[b.name] * 8 + tb);
    });

    if (!avail.length) { resolvedTermine.push(t); continue; }
    const pick = avail[0];
    terminCount[pick.name]++;
    resolvedTermine.push({ ...t, personName: pick.name });
  }

  // ── Step 2: Apply termin blocks ───────────────────────────────────────────
  for (const t of resolvedTermine) {
    if (!t.personName) continue;
    const def = TERMIN_DEFS[t.type];
    const tHour = t.startHour ?? t.hour;
    for (const b of blocks) {
      if (b.start >= tHour && b.start < tHour + def.dur)
        result[`${t.personName}::${b.key}`] = 'termin';
    }
  }

  // ── Step 3: Init burden + roleCounts ──────────────────────────────────────
  const burden     = Object.fromEntries(allowedPeople.map(p => [p.name, 0]));
  const roleCounts = Object.fromEntries(allowedPeople.map(p => [p.name, {}]));
  for (const [key, role] of Object.entries(result)) {
    const [name] = key.split('::');
    if (burden[name] === undefined) continue;
    burden[name] += ZUTEIL_ROLES[role]?.burden || 0;
    roleCounts[name][role] = (roleCounts[name][role] || 0) + 1;
  }

  // ── Step 4: Assign trainee shadowing (round-robin, max 1 trainee per block) ─
  let assistIdx = 0;
  const traineeBlocksUsed = new Set(); // track blocks already occupied by a trainee
  for (const t of resolvedTermine) {
    if (!trainees.length) break;
    const tHour = t.startHour ?? t.hour;
    const def = TERMIN_DEFS[t.type];
    const tBlocks = blocks.filter(b => b.start >= tHour && b.start < tHour + def.dur);
    if (!tBlocks.length) continue;

    for (let attempt = 0; attempt < trainees.length; attempt++) {
      const tr = trainees[(assistIdx + attempt) % trainees.length];
      const canAssist = tBlocks.every(b => {
        const bi = blocks.indexOf(b);
        return isAvailAtBlock(tr, b, bi) && !result[`${tr.name}::${b.key}`] && !traineeBlocksUsed.has(b.key);
      });
      if (canAssist) {
        for (const b of tBlocks) {
          const targetRole = (t.personName && result[`${t.personName}::${b.key}`]) || 'termin';
          result[`${tr.name}::${b.key}`] = targetRole;
          burden[tr.name] += ZUTEIL_ROLES[targetRole]?.burden || 0;
          roleCounts[tr.name][targetRole] = (roleCounts[tr.name][targetRole] || 0) + 1;
          traineeBlocksUsed.add(b.key);
        }
        assistIdx = (assistIdx + attempt + 1) % trainees.length;
        break;
      }
    }
  }

  // ── Step 5: Main assignment loop ───────────────────────────────────────────
  const getScore = (p, roleKey) =>
    (burden[p.name] || 0) + (roleCounts[p.name][roleKey] || 0) * (ZUTEIL_ROLES[roleKey]?.burden || 1);
  const pickByScore = (pool, roleKey) =>
    pool.slice().sort((a, b) => getScore(a, roleKey) - getScore(b, roleKey))[0];

  const assign = (p, block, role) => {
    result[`${p.name}::${block.key}`] = role;
    burden[p.name] += ZUTEIL_ROLES[role]?.burden || 0;
    roleCounts[p.name][role] = (roleCounts[p.name][role] || 0) + 1;
  };
  const free = (block, bi) =>
    allowedPeople.filter(p => isAvailAtBlock(p, block, bi) && !result[`${p.name}::${block.key}`]);

  const hadTerminRecently = (p, bi) => {
    if (bi === 0) return false;
    return result[`${p.name}::${blocks[bi - 1].key}`] === 'termin';
  };
  const prevRole = (bi, role) =>
    bi > 0 ? allowedPeople.filter(p => result[`${p.name}::${blocks[bi-1].key}`] === role) : [];

  for (const [bi, block] of blocks.entries()) {
    // Kassa: 1 non-trainee; prefer same person as prev block (2-block ≈ :30 stints); buffer after termin
    if (!allowedPeople.some(p => result[`${p.name}::${block.key}`] === 'kassa')) {
      const pool = free(block, bi).filter(p => !p._isTrainee);
      const prev = prevRole(bi, 'kassa').filter(p => pool.includes(p) && !hadTerminRecently(p, bi));
      const pref = prev.length ? prev : pool.filter(p => !hadTerminRecently(p, bi));
      const p = pickByScore(pref.length ? pref : pool.length ? pool : free(block, bi), 'kassa');
      if (p) assign(p, block, 'kassa');
    }
    // Backoffice: up to 2; prefer same people as prev block
    const prevBO = prevRole(bi, 'backoffice');
    for (let slot = 0; slot < 2; slot++) {
      if (allowedPeople.filter(p => result[`${p.name}::${block.key}`] === 'backoffice').length >= 2) break;
      const pool = free(block, bi).filter(p => !p._isTrainee);
      const pref = prevBO.filter(p => pool.includes(p));
      const pick = pickByScore(pref.length ? pref : pool.length ? pool : free(block, bi), 'backoffice');
      if (pick) assign(pick, block, 'backoffice');
      else break;
    }
    // 5. Stock: always assign when someone is free; prefer same person as prev block
    if (!allowedPeople.some(p => result[`${p.name}::${block.key}`] === '5stock')) {
      const pool = free(block, bi).filter(p => !p._isTrainee);
      const prev5 = prevRole(bi, '5stock').filter(p => pool.includes(p));
      const p = pickByScore(prev5.length ? prev5 : pool.length ? pool : free(block, bi), '5stock');
      if (p) assign(p, block, '5stock');
    }
    // Fill remaining with backoffice (cap 2); extras left empty (Leer)
    for (const p of free(block, bi)) {
      if (allowedPeople.filter(q => result[`${q.name}::${block.key}`] === 'backoffice').length < 2)
        assign(p, block, 'backoffice');
    }
  }

  return { assignments: result, resolvedTermine };
}

function autoAssignZuteilung(blocks, people, zData) {
  const { termine, personStates, blockSize } = zData;
  const presentPeople = people.filter(p => {
    const ps = personStates[p.name] || {};
    return p.present && !ps.notYetPresent;
  });
  const absentPeople = people.filter(p => {
    const ps = personStates[p.name] || {};
    return !p.present || ps.notYetPresent;
  });

  const { assignments: planA, resolvedTermine } = runAutoAssign(presentPeople, blocks, termine, personStates, blockSize, { personTiers: zData.personTiers || {} });

  if (absentPeople.length > 0) {
    const { assignments: planBAssign } = runAutoAssign(people, blocks, termine, personStates, blockSize, { planBMode: true, personTiers: zData.personTiers || {} });
    const merged = { ...planA };
    for (const p of absentPeople) {
      for (const b of blocks) {
        const key = `${p.name}::${b.key}`;
        if (planBAssign[key]) merged[key] = planBAssign[key];
      }
    }
    return {
      assignments: merged,
      planB: planBAssign,
      dualPlanActive: true,
      planAPersons: presentPeople.map(p => p.name),
      resolvedTermine,
    };
  }

  return {
    assignments: planA,
    planB: null,
    dualPlanActive: false,
    planAPersons: presentPeople.map(p => p.name),
    resolvedTermine,
  };
}

// ─── Rolecall Gamification Bonuses ────────────────────────────────────────────
async function applyRolecallBonuses(shift, colleagues) {
  // Only award once per shift (track with a flag on the shift object)
  if (shift.rolecallBonusAwarded) return;

  const present = colleagues.filter(c => c.present);
  const bonusList = [];
  let totalBonus = 0;

  // Gefahrenzulage: +25 XP per achtung colleague
  const gefahren = present.filter(c => (c.tags||[]).includes('achtung'));
  if (gefahren.length) {
    const xp = gefahren.length * 25;
    bonusList.push({ label: `⚠️ Gefahrenzulage ×${gefahren.length}`, xp });
    totalBonus += xp;
  }

  if (!totalBonus && !bonusList.length) {
    // Mark as checked even with no bonus so we don't re-check
    await db.shiftLogs.update(shift.id, { rolecallBonusAwarded: true });
    return;
  }

  const newTotal = (state.profile.totalXP ?? 0) + totalBonus;
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  await db.shiftLogs.update(shift.id, {
    xpEarned: (shift.xpEarned || 0) + totalBonus,
    rolecallBonusAwarded: true,
  });

  if (totalBonus > 0) showXPPopup(totalBonus, bonusList);

  // Check for rolecall secret achievements
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  const newUnlocks = await checkAchievements(state, db);
  for (const u of newUnlocks) {
    if (u.xp) {
      const t2 = (state.profile.totalXP ?? 0) + u.xp;
      await db.profile.update(state.profile.id, { totalXP: t2 });
      state.profile.totalXP = t2;
    }
    setTimeout(() => showXPPopup(u.xp || 0, [{ label: `${u.icon} ${u.name}` }]), 1200);
  }
}

function openMoveSlotModal(slot, currentShift) {
  const def = SLOT_TYPES[slot.type] || {};
  const otherShifts = state.shifts
    .filter(s => s.id !== currentShift.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  document.getElementById('slot-detail-title').textContent = `⤴ ${def.icon} ${def.label} verschieben`;
  document.getElementById('slot-detail-body').innerHTML = otherShifts.length === 0
    ? `<div style="color:var(--text-dim);font-size:14px;padding:8px 0">Keine anderen Dienste vorhanden.</div>
       <div class="slot-edit-btns"><button class="btn-secondary" id="btn-move-slot-cancel">Schließen</button></div>`
    : `<div class="form-row">
        <label class="form-label">Ziel-Dienst</label>
        <select id="move-slot-target" class="form-input">
          ${otherShifts.map(s =>
            `<option value="${s.id}">${s.date} · ${shiftIcon(s.type)} ${shiftLabel(s.type)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="slot-edit-btns">
        <button class="btn-primary"   id="btn-move-slot-confirm">Verschieben</button>
        <button class="btn-secondary" id="btn-move-slot-cancel">Abbrechen</button>
      </div>`;

  document.getElementById('btn-move-slot-cancel').addEventListener('click', () =>
    document.getElementById('slot-detail-modal').classList.add('hidden'));

  if (otherShifts.length > 0) {
    document.getElementById('btn-move-slot-confirm').addEventListener('click', async () => {
      const targetId = parseInt(document.getElementById('move-slot-target').value);
      await moveSlotToShift(slot, currentShift, targetId);
    });
  }

  document.getElementById('slot-detail-modal').classList.remove('hidden');
}

async function moveSlotToShift(slot, fromShift, toShiftId) {
  const toShift = state.shifts.find(s => s.id === toShiftId);
  if (!toShift) return;

  await db.scheduleSlots.update(slot.id, { shiftId: toShiftId });

  // Adjust XP on both shifts
  const xp = slot.xpEarned || 0;
  await db.shiftLogs.update(fromShift.id, { xpEarned: Math.max(0, (fromShift.xpEarned || 0) - xp) });
  await db.shiftLogs.update(toShiftId,    { xpEarned: (toShift.xpEarned || 0) + xp });

  state.shifts      = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(fromShift.id).sortBy('startHour');

  document.getElementById('slot-detail-modal').classList.add('hidden');

  const freshShift = state.shifts.find(s => s.id === fromShift.id);
  if (freshShift) renderTimeline(freshShift);
  updatePlannerXP(freshShift || fromShift);
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

  // ── Kassensturz: every hour at x:30 while a kassa slot is active ──────────
  const nowMin = now.getMinutes();
  if (nowMin >= 29 && nowMin <= 31) {
    const kassaActive = state.plannerSlots.some(s =>
      SLOT_TYPES[s.type]?.halfHour &&
      toMins(s.startHour, s.startMinute) <= nowMins &&
      nowMins < toMins(s.endHour, s.endMinute)
    );
    if (kassaActive) {
      const alarmKey = `kassa-${now.getHours()}:30`;
      if (!state.alarmFired.has(alarmKey)) {
        const timeStr = `${now.getHours()}:30`;
        const banner = document.getElementById('planner-alarm-banner');
        if (banner) {
          banner.textContent = `💰 Kassensturz um ${timeStr}`;
          banner.classList.remove('hidden');
          setTimeout(() => banner.classList.add('hidden'), 15_000);
        }
        showSystemNotification('💰 Kassensturz', `Kassensturz um ${timeStr} fällig`, `kassa-${timeStr}`);
        state.alarmFired.add(alarmKey);
      }
    }
  }

  // ── Slot start alarm: 9–11 minutes before ─────────────────────────────────
  for (const slot of state.plannerSlots) {
    if (state.alarmFired.has(slot.id)) continue;
    const diff = toMins(slot.startHour, slot.startMinute) - nowMins;
    if (diff >= 9 && diff <= 11) {
      const def  = SLOT_TYPES[slot.type] || {};
      const time = padT(slot.startHour, slot.startMinute);
      const msg  = `${def.icon || '⏰'} ${def.label} um ${time}`;

      const banner = document.getElementById('planner-alarm-banner');
      if (banner) {
        banner.textContent = `⏰ In ~10 min: ${msg}`;
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 10_000);
      }
      showSystemNotification(`⏰ In ~10 Minuten`, msg, `alarm-slot-${slot.id}`);
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
  const slotSrc = state.addToShiftContext?.slotSource;
  const slotShiftId = state.addToShiftContext?.shiftId;
  document.getElementById('diagnosis-modal').classList.add('hidden');
  state.searchContext = { patientIndex: null, selectedDiagnosis: null, standalone: false };
  state.addToShiftContext = null;
  state.diagCatchStack = [];
  // If we came from the planner timeline, refresh it (only if still on same shift)
  if (slotSrc === 'planner' && slotShiftId != null && state.plannerShiftId === slotShiftId) {
    const freshShift = state.shifts.find(s => s.id === slotShiftId);
    if (freshShift) renderTimeline(freshShift);
  }
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
  let xpResult = calculateCatchXP(normDiag, hasComorbidity, caughtCodes, caughtKats);
  // Apply Koffein-Kick +10% if active for this shift
  const activeShiftId = state.addToShiftContext?.shiftId ?? state.activeShift?.id ?? null;
  if (activeShiftId && sessionStorage.getItem(`koffein-shift-${activeShiftId}`)) {
    const boost = Math.round(xpResult.total * CONSUMABLE_XP.koffein.boost);
    xpResult = { ...xpResult, total: xpResult.total + boost, bonuses: [...xpResult.bonuses, { label: '☕ Koffein-Kick', xp: boost }] };
  }

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
  if (state.currentTab === 'stats') renderDashboard();
  else if (state.currentTab === 'icdf') renderPsychoDex();
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
  if (state.currentTab === 'stats') renderDashboard();
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
  if (state.currentTab === 'stats') renderDashboard();
  else if (state.currentTab === 'icdf') renderPsychoDex();
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
    navigateTo('stats');
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

  const starRow = (earned, total, color = '#7c3aed') =>
    Array.from({length: total}, (_, i) => i < earned
      ? `<span class="ach-star ach-star-on" style="color:${color}">★</span>`
      : `<span class="ach-star ach-star-off">☆</span>`
    ).join('');

  const secretStarCount = xp => xp <= 400 ? 1 : xp <= 700 ? 2 : 3;

  const badgeCard = ({ id, icon, name, desc, stars, tierClass, clickable, locked }) =>
    `<div class="ach-card ${tierClass}${clickable ? ' ach-img-clickable' : ''}"
          data-badge-id="${id}" data-badge-icon="${icon}">
      <img class="ach-img" src="assets/images/badges/${id}.png"
           onload="this.nextElementSibling.style.display='none'"
           onerror="this.style.display='none'" alt="">
      <div class="ach-emoji-bg">${locked ? '🔒' : icon}</div>
      <div class="ach-card-gradient">
        <div class="ach-card-stars">${stars}</div>
        <div class="ach-name">${name}</div>
        <div class="ach-desc">${locked ? '??? (Geheimnis)' : desc}</div>
      </div>
    </div>`;

  const regularCards = ACHIEVEMENTS.map(ach => {
    const maxTier = maxTierMap[ach.id] || 0;
    const unlocked = maxTier > 0;
    const color = maxTier === 3 ? '#f59e0b' : '#7c3aed';
    return badgeCard({
      id: ach.id, icon: ach.icon, name: ach.name, desc: ach.description,
      stars: starRow(maxTier, 3, color),
      tierClass: `ach-tier-${maxTier}`,
      clickable: unlocked, locked: false,
    });
  }).join('');

  const secretCards = SECRET_ACHIEVEMENTS.map(ach => {
    const isUnlocked = secretsDone.has(ach.id);
    const starCount = secretStarCount(ach.xp);
    const stars = isUnlocked
      ? starRow(starCount, 3, '#f59e0b')
      : starRow(0, starCount, '#f59e0b');
    return badgeCard({
      id: ach.id, icon: ach.icon, name: ach.name, desc: ach.description,
      stars,
      tierClass: isUnlocked ? 'ach-tier-3 ach-secret-unlocked' : 'ach-tier-0 ach-secret-locked',
      clickable: isUnlocked, locked: !isUnlocked,
    });
  }).join('');

  el.innerHTML =
    `<div class="ach-actions-row">
       <button id="btn-recalc-achievements" class="btn-secondary" style="font-size:12px;padding:7px 14px">🔄 Neu bewerten</button>
     </div>
     <div class="ach-grid">${regularCards}</div>
     <div class="section-subheader">Secret Achievements</div>
     <div class="ach-grid">${secretCards}</div>`;

  el.querySelector('#btn-recalc-achievements')?.addEventListener('click', recalculateAchievements);

  el.querySelectorAll('.ach-img-clickable').forEach(card => {
    card.addEventListener('click', () => openBadgeLightbox(card.dataset.badgeId, card.dataset.badgeIcon));
  });
}

function openBadgeLightbox(id, icon) {
  const lb    = document.getElementById('badge-lightbox');
  const img   = document.getElementById('badge-lb-img');
  const emoji = document.getElementById('badge-lb-emoji');

  img.src = `assets/images/badges/large/${id}.jpg`;
  img.onload  = () => { emoji.style.display = 'none'; };
  img.onerror = () => { img.style.display = 'none'; emoji.textContent = icon; emoji.style.display = 'flex'; };
  emoji.style.display = 'none';
  img.style.display = 'block';

  // Populate badge info below the image
  const reg = ACHIEVEMENTS.find(a => a.id === id);
  const sec = SECRET_ACHIEVEMENTS.find(a => a.id === id);
  const ach = reg || sec;
  const maxTier = (state.unlockedAchievements || [])
    .filter(a => a.badgeId === id)
    .reduce((m, a) => Math.max(m, a.tier), 0);

  const starFn = (earned, total, color) =>
    Array.from({length: total}, (_, i) =>
      `<span style="font-size:20px;color:${i < earned ? color : 'rgba(255,255,255,.2)'}">${i < earned ? '★' : '☆'}</span>`
    ).join('');

  let starsHtml = '', xpText = '';
  if (reg) {
    const color = maxTier === 3 ? '#f59e0b' : '#7c3aed';
    starsHtml = starFn(maxTier, 3, color);
    if (maxTier > 0) xpText = `+${reg.tiers[maxTier - 1].xp} XP`;
  } else if (sec) {
    const count = sec.xp <= 400 ? 1 : sec.xp <= 700 ? 2 : 3;
    starsHtml = starFn(count, 3, '#f59e0b');
    xpText = `+${sec.xp} XP · Secret`;
  }

  const nameEl = document.getElementById('badge-lb-name');
  const descEl = document.getElementById('badge-lb-desc');
  const starsEl = document.getElementById('badge-lb-stars');
  const xpEl   = document.getElementById('badge-lb-xp');
  if (nameEl)  nameEl.textContent  = ach?.name || '';
  if (descEl)  descEl.textContent  = ach?.description || '';
  if (starsEl) starsEl.innerHTML   = starsHtml;
  if (xpEl)    xpEl.textContent    = xpText;

  lb.classList.remove('hidden');
}

function closeBadgeLightbox() {
  document.getElementById('badge-lightbox').classList.add('hidden');
}

// ─── Recalculate Achievements ─────────────────────────────────────────────────
async function recalculateAchievements() {
  const btn = document.getElementById('btn-recalc-achievements');
  if (btn) { btn.disabled = true; btn.textContent = 'Berechne…'; }

  try {
    // Reload latest state from DB
    state.unlockedAchievements = await db.unlockedAchievements.toArray();

    // Re-evaluate regular tiered achievements
    for (const ach of ACHIEVEMENTS) {
      const { count, thresholds } = ach._check(state);
      for (let i = 0; i < thresholds.length; i++) {
        const tier = i + 1;
        const shouldBeUnlocked = count >= thresholds[i];
        const existing = state.unlockedAchievements.find(a => a.badgeId === ach.id && a.tier === tier);
        if (!shouldBeUnlocked && existing) {
          // Remove invalid entry from DB
          await db.unlockedAchievements.delete(existing.id);
        } else if (shouldBeUnlocked && !existing) {
          // Add missing entry
          const entry = { badgeId: ach.id, tier, unlockedAt: new Date().toISOString() };
          entry.id = await db.unlockedAchievements.add(entry);
        }
      }
    }

    // Re-evaluate secret achievements
    for (const ach of SECRET_ACHIEVEMENTS) {
      const { triggered } = ach._check(state);
      const existing = state.unlockedAchievements.find(a => a.badgeId === ach.id && a.tier === 1);
      if (!triggered && existing) {
        await db.unlockedAchievements.delete(existing.id);
      } else if (triggered && !existing) {
        const entry = { badgeId: ach.id, tier: 1, unlockedAt: new Date().toISOString() };
        entry.id = await db.unlockedAchievements.add(entry);
      }
    }

    // Reload updated achievements into state
    state.unlockedAchievements = await db.unlockedAchievements.toArray();

    // Recompute totalXP from all sources (without confirm dialog, without recalculating catch XP)
    const allShifts = await db.shiftLogs.toArray();
    const allCatches = await db.caughtDiagnoses.toArray();
    const allSlots = await db.scheduleSlots.toArray();
    const allMissions = await db.missions.toArray();

    let newTotal = 0;

    // Shifts (already stored xpEarned)
    newTotal += allShifts.reduce((s, sh) => s + (sh.xpEarned || 0), 0);

    // Standalone catches (no shift)
    newTotal += allCatches.filter(c => c.shiftId == null).reduce((s, c) => s + (c.xpEarned || 0), 0);

    // Non-planner slot XP
    const plannerShiftIds = new Set(allShifts.filter(s => s.plannerShift).map(s => s.id));
    newTotal += allSlots
      .filter(sl => !plannerShiftIds.has(sl.shiftId))
      .reduce((s, sl) => s + (sl.xpEarned || 0), 0);

    // Achievements XP
    newTotal += state.unlockedAchievements.reduce((sum, a) => {
      const def = ACHIEVEMENTS.find(x => x.id === a.badgeId);
      if (def) return sum + (def.tiers[a.tier - 1]?.xp ?? 0);
      const sec = SECRET_ACHIEVEMENTS.find(x => x.id === a.badgeId);
      if (sec) return sum + (sec.xp ?? 0);
      return sum;
    }, 0);

    // Missions XP
    newTotal += allMissions.reduce((sum, m) => {
      if (!m.completedAt) return sum;
      const def = MISSION_POOL.find(x => x.id === m.missionId);
      return sum + (def?.reward ?? 0);
    }, 0);

    // Shift notes XP
    newTotal += allShifts
      .filter(s => s.noteAddedAt)
      .reduce((sum, s) => sum + calculateNoteXP(s.date, s.noteAddedAt), 0);

    await db.profile.update(state.profile.id, { totalXP: newTotal });
    state.profile.totalXP = newTotal;

    renderAchievements();
    updateHeader();
    renderDashboard();
  } catch (e) {
    console.warn('recalculateAchievements:', e);
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Neu bewerten'; }
  }
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

  // Auto-expire missions that are 1+ month+1day old and have >= 2 shifts since activation
  const nowMs = Date.now();
  for (const mission of activeMissions) {
    if (mission.completedAt) continue; // skip already completed
    const activatedMs = new Date(mission.activatedAt).getTime();
    const expiryMs = activatedMs + (31 * 24 * 60 * 60 * 1000); // 31 days = 1 month + 1 day approx
    if (nowMs >= expiryMs) {
      const shiftsSince = state.shifts.filter(s => (s.createdAt || `${s.date}T00:00:00`) >= mission.activatedAt).length;
      if (shiftsSince >= 2) {
        const expiredAt = new Date().toISOString();
        await db.missions.update(mission.id, { completedAt: expiredAt, timedOut: true });
        mission.completedAt = expiredAt;
        anyCompleted = true;
      }
    }
  }

  if (anyCompleted) {
    updateHeader();
    if (state.currentTab === 'stats') renderDashboard();
    setTimeout(async () => {
      await ensureMissionSlots();
      if (state.currentTab === 'stats') renderMissions();
    }, 1800);
  }

  if (state.currentTab === 'stats') renderMissions();
}

function renderSettingsTab() {
  renderHourCountersSettings();
  renderExtraHoursSettings();
  // Supervision target
  const supEl = document.getElementById('setting-sup-target');
  if (supEl) {
    supEl.value = state.profile?.supervisionTarget ?? 30;
    supEl.onchange = async (e) => {
      const val = parseFloat(e.target.value);
      if (val > 0) {
        await db.profile.update(state.profile.id, { supervisionTarget: val });
        state.profile.supervisionTarget = val;
        renderSupervisionStats();
      }
    };
  }
}

// ─── Supervision Logging ──────────────────────────────────────────────────────
async function renderSupervisionStats() {
  const logs = await db.supervisionLogs.orderBy('date').toArray();
  state.supLogs  = logs;
  state.supHours = logs.reduce((s, l) => s + (l.duration || 0), 0);
  const elHours = document.getElementById('supervision-hours');
  if (elHours) elHours.textContent = `${state.supHours}h`;
  const secEl = document.getElementById('sup-progress-section');
  if (secEl) secEl.style.display = 'none';
  renderHoursCounters();
}

async function openSupervisionSheet() {
  const logs = await db.supervisionLogs.orderBy('date').reverse().toArray();
  const existing = document.getElementById('sup-sheet-modal');
  if (existing) existing.remove();

  const renderRows = (container, logs) => {
    if (!logs.length) {
      container.innerHTML = '<div class="sup-empty">Noch keine Supervisionen eingetragen.</div>';
      return;
    }
    container.innerHTML = logs.map(l => {
      const d = new Date(l.date + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'2-digit' });
      return `<div class="sup-log-row" data-id="${l.id}">
        <div class="sup-log-main">
          <span class="sup-log-date">${d}</span>
          <span class="sup-log-dur">${l.duration}h</span>
          ${l.supervisor ? `<span class="sup-log-sup">${l.supervisor}</span>` : ''}
        </div>
        <div class="sup-log-actions">
          <button class="btn-icon sup-edit-btn" data-id="${l.id}">✏️</button>
          <button class="btn-icon sup-del-btn btn-danger-sm" data-id="${l.id}">🗑</button>
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll('.sup-edit-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        const log = logs.find(l => l.id === parseInt(btn.dataset.id));
        if (log) { modal.remove(); openSupervisionModal(log); }
      })
    );
    container.querySelectorAll('.sup-del-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        const log = logs.find(l => l.id === parseInt(btn.dataset.id));
        if (!log || !confirm(`Supervision vom ${log.date} (${log.duration}h) löschen?`)) return;
        await deleteSupervision(log);
        modal.remove();
      })
    );
  };

  const hours = logs.reduce((s, l) => s + (l.duration || 0), 0);
  const modal = document.createElement('div');
  modal.id = 'sup-sheet-modal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" id="sup-sheet-backdrop"></div>
    <div class="modal-sheet modal-sheet-tall">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <div class="modal-title">🎓 Supervisionen · ${hours}h gesamt</div>
        <button class="sup-add-btn" id="sup-sheet-add-btn">＋ Hinzufügen</button>
      </div>
      <div class="sheet-body" style="padding:12px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:0" id="sup-sheet-body"></div>
    </div>`;
  document.body.appendChild(modal);
  renderRows(modal.querySelector('#sup-sheet-body'), logs);
  document.getElementById('sup-sheet-backdrop').onclick = () => modal.remove();
  document.getElementById('sup-sheet-add-btn').onclick  = () => { modal.remove(); openSupervisionModal(); };
}

function openSupervisionModal(editLog = null) {
  const modal = document.getElementById('supervision-modal');
  if (!modal) return;
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('supervision-edit-id').value    = editLog ? editLog.id : '';
  document.getElementById('supervision-modal-title').textContent = editLog ? '🎓 Supervision bearbeiten' : '🎓 Supervision eintragen';
  document.getElementById('supervision-date').value       = editLog ? editLog.date : today;
  document.getElementById('supervision-duration').value   = editLog ? editLog.duration : '';
  document.getElementById('supervision-supervisor').value = editLog?.supervisor ?? '';
  modal.classList.remove('hidden');
  document.getElementById('supervision-backdrop').onclick = () => modal.classList.add('hidden');
  document.getElementById('supervision-cancel').onclick   = () => modal.classList.add('hidden');
  document.getElementById('supervision-save').onclick     = saveSupervision;
}

async function saveSupervision() {
  const date       = document.getElementById('supervision-date').value;
  const durStr     = document.getElementById('supervision-duration').value;
  const supervisor = document.getElementById('supervision-supervisor').value.trim();
  const duration   = parseFloat(durStr);
  const editId     = document.getElementById('supervision-edit-id').value;
  if (!date || isNaN(duration) || duration <= 0) { alert('Bitte Datum und Dauer angeben.'); return; }

  const xp = Math.round(250 * duration);

  if (editId) {
    const old = await db.supervisionLogs.get(parseInt(editId));
    const oldXP = old?.xpEarned ?? 0;
    await db.supervisionLogs.update(parseInt(editId), { date, duration, supervisor: supervisor || null, xpEarned: xp });
    const delta = xp - oldXP;
    if (delta !== 0) {
      const newTotal = (state.profile.totalXP ?? 0) + delta;
      await db.profile.update(state.profile.id, { totalXP: newTotal });
      state.profile.totalXP = newTotal;
    }
  } else {
    await db.supervisionLogs.add({ date, duration, supervisor: supervisor || null, notes: '', xpEarned: xp });
    const newTotal = (state.profile.totalXP ?? 0) + xp;
    await db.profile.update(state.profile.id, { totalXP: newTotal });
    state.profile.totalXP = newTotal;
    showXPPopup(xp, [{ label: `🎓 Supervision ${duration}h` }]);
  }

  document.getElementById('supervision-modal').classList.add('hidden');
  renderSupervisionStats();
  renderDashboard();
}

async function deleteSupervision(log) {
  await db.supervisionLogs.delete(log.id);
  const newTotal = Math.max(0, (state.profile.totalXP ?? 0) - (log.xpEarned || 0));
  await db.profile.update(state.profile.id, { totalXP: newTotal });
  state.profile.totalXP = newTotal;
  renderSupervisionStats();
  renderDashboard();
}

// ─── Missions Strip ───────────────────────────────────────────────────────────
function renderMissionsStrip() {
  const el = document.getElementById('missions-strip');
  if (!el) return;
  const active = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);
  if (!active.length) { el.innerHTML = ''; return; }
  el.innerHTML = active.map(am => {
    const def = MISSION_POOL.find(m => m.id === am.missionId);
    if (!def) return '';
    const catchesSince = state.catches.filter(c => c.caughtAt >= am.activatedAt);
    const shiftsSince  = state.shifts.filter(s => (s.createdAt || `${s.date}T00:00:00`) >= am.activatedAt);
    const { current, target } = calcMissionProgress(def, catchesSince, shiftsSince, state.icdFlat);
    const pct = Math.min(100, Math.round((current / target) * 100));
    return `<button class="mission-pill tier-${def.tier}" data-mission-id="${am.id}">
      <div class="mp-tier-dot tier-dot-${def.tier}"></div>
      <div class="mp-body">
        <div class="mp-title">${def.title}</div>
        <div class="mp-bar"><div class="mp-fill" style="width:${pct}%"></div></div>
      </div>
      <span class="mp-pct">${pct}%</span>
    </button>`;
  }).join('') + `<button class="mission-history-pill" id="btn-mission-history" title="Challenge History">📜</button>`;
  el.querySelectorAll('.mission-pill').forEach(pill =>
    pill.addEventListener('click', () => {
      const am = state.missions.find(m => m.id === parseInt(pill.dataset.missionId));
      if (am) openMissionDetailModal(am);
    })
  );
  document.getElementById('btn-mission-history')?.addEventListener('click', openChallengeHistoryModal);
}

let _missionModalAm    = null;
let _missionSwipeActive = false;

function _renderMissionDetailBody(am) {
  const def = MISSION_POOL.find(m => m.id === am.missionId);
  if (!def) return;
  const body = document.getElementById('mission-detail-body');
  const catchesSince = state.catches.filter(c => c.caughtAt >= am.activatedAt);
  const shiftsSince  = state.shifts.filter(s => (s.createdAt || `${s.date}T00:00:00`) >= am.activatedAt);
  const { current, target } = calcMissionProgress(def, catchesSince, shiftsSince, state.icdFlat);
  const cbsModal = missionCheckboxes(current, target, def.tier, def.emoji || '🎯');
  const active = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);
  const idx = active.findIndex(m => m.id === am.id);
  const dotsHtml = active.length > 1
    ? `<div class="mm-dots-row">${active.map((_, i) => `<span class="mm-dot${i === idx ? ' mm-dot--active' : ''}"></span>`).join('')}</div>`
    : '';
  body.innerHTML = `
    <div style="text-align:center;margin-bottom:18px">
      <div class="mission-modal-icon tier-${def.tier}">${def.emoji || '🎯'}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:8px">
      <span class="mission-modal-tier-badge tier-${def.tier}">${TIER_LABELS[def.tier]}</span>
      <div class="mission-modal-title" style="margin:0">${def.title}</div>
    </div>
    <div class="mission-modal-desc">${def.description}</div>
    ${cbsModal ? `<div style="margin:18px 0 4px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap;font-size:15px">${cbsModal}</div>` : ''}
    <div class="mission-modal-reward tier-${def.tier}">+${def.reward.toLocaleString('de-AT')} XP</div>
    ${def.badge ? `<div class="mission-modal-badge">${def.badge}</div>` : ''}
    <div class="mission-modal-meta">Aktiv seit ${new Date(am.activatedAt).toLocaleDateString('de-AT',{day:'2-digit',month:'2-digit',year:'2-digit'})}</div>
    ${dotsHtml}`;
}

function openMissionDetailModal(am) {
  _missionModalAm = am;
  _renderMissionDetailBody(am);
  const card = document.querySelector('.mission-modal-card');
  if (card) { card.style.cssText = ''; }
  document.getElementById('mission-detail-modal').classList.remove('hidden');
}

function _navigateMission(dir) {
  if (_missionSwipeActive) return;
  const active = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);
  if (active.length <= 1) return;
  const idx = active.findIndex(m => m.id === _missionModalAm?.id);
  if (idx < 0) return;
  const newAm = active[((idx + dir) + active.length) % active.length];
  _missionSwipeActive = true;
  const card = document.querySelector('.mission-modal-card');
  if (!card) { _missionSwipeActive = false; return; }
  const outX = dir > 0 ? 'calc(-50% - 110vw)' : 'calc(-50% + 110vw)';
  const inX  = dir > 0 ? 'calc(-50% + 110vw)' : 'calc(-50% - 110vw)';
  card.style.animation = 'none';
  card.style.transition = 'transform 0.2s cubic-bezier(.4,0,.2,1),opacity 0.18s';
  card.style.transform = `translate(${outX},-50%)`;
  card.style.opacity = '0';
  setTimeout(() => {
    _missionModalAm = newAm;
    _renderMissionDetailBody(newAm);
    card.style.transition = 'none';
    card.style.transform = `translate(${inX},-50%)`;
    card.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.style.transition = 'transform 0.2s cubic-bezier(.4,0,.2,1),opacity 0.18s';
      card.style.transform = 'translate(-50%,-50%)';
      card.style.opacity = '1';
      setTimeout(() => { _missionSwipeActive = false; }, 220);
    }));
  }, 200);
}

function openChallengeHistoryModal() {
  const completed = state.missions.filter(m => m.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const modal = document.getElementById('challenge-history-modal');
  const body  = document.getElementById('challenge-history-body');
  body.innerHTML = completed.length ? completed.map(am => {
    const def = MISSION_POOL.find(m => m.id === am.missionId);
    if (!def) return '';
    const date = new Date(am.completedAt).toLocaleDateString('de-AT',{day:'2-digit',month:'2-digit',year:'2-digit'});
    return `<div class="ch-row">
      <div class="ch-main">
        <div class="ch-title">${def.emoji ? def.emoji + ' ' : ''}${def.title}</div>
        <div class="ch-desc">${def.description}</div>
        <div class="ch-meta">${TIER_LABELS[def.tier]} · ${date}</div>
      </div>
      <div class="ch-reward">+${def.reward.toLocaleString('de-AT')} XP</div>
    </div>`;
  }).join('') : '<div class="empty-state">Noch keine abgeschlossenen Challenges</div>';
  modal.classList.remove('hidden');
}

const MISSION_TIER_COLORS = { 1:'#9ca3af', 2:'#60a5fa', 3:'#a78bfa' };

const missionCheckboxes = (current, target, tier = 3, emoji = '🎯') => {
  if (target <= 1) return '';
  const color = MISSION_TIER_COLORS[tier] || 'var(--accent)';
  return Array.from({length: target}, (_, i) => {
    const done = i < current;
    return `<span class="m-cb${done ? ' m-cb--done' : ''}" style="font-size:1.1em;${done ? `filter:none;opacity:1;` : 'filter:grayscale(1);opacity:0.35;'}">${emoji}</span>`;
  }).join('');
};

function setupMissionModals() {
  const mModal = document.getElementById('mission-detail-modal');
  document.getElementById('mission-detail-close').addEventListener('click', () => mModal.classList.add('hidden'));
  document.getElementById('mission-detail-backdrop').addEventListener('click', () => mModal.classList.add('hidden'));
  document.getElementById('challenge-history-close').addEventListener('click', () =>
    document.getElementById('challenge-history-modal').classList.add('hidden'));
  document.getElementById('challenge-history-backdrop').addEventListener('click', () =>
    document.getElementById('challenge-history-modal').classList.add('hidden'));
  // Swipe between missions
  let _swipeX0 = 0;
  mModal.addEventListener('touchstart', e => { _swipeX0 = e.touches[0].clientX; }, { passive: true });
  mModal.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _swipeX0;
    if (Math.abs(dx) > 50) _navigateMission(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function renderHomeMissions() {
  const el = document.getElementById('home-missions-mini');
  if (!el) return;
  const active = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);
  if (!active.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = active.slice(0, 3).map(am => {
    const def = MISSION_POOL.find(m => m.id === am.missionId);
    if (!def) return '';
    const catchesSince = state.catches.filter(c => c.caughtAt >= am.activatedAt);
    const shiftsSince  = state.shifts.filter(s => (s.createdAt || `${s.date}T00:00:00`) >= am.activatedAt);
    const { current, target } = calcMissionProgress(def, catchesSince, shiftsSince, state.icdFlat);
    const cbs = missionCheckboxes(current, target, def.tier, def.emoji || '🎯');
    return `<button class="hm-mission-pill tier-${def.tier}" data-mission-id="${am.id}">
      <div class="hm-mp-dots">${cbs}</div>
      <div class="hm-mp-body">
        <span class="hm-mp-emoji">${def.emoji||''}</span>
        <div class="hm-mp-title">${def.title}</div>
      </div>
    </button>`;
  }).join('');
  el.querySelectorAll('.hm-mission-pill[data-mission-id]').forEach(pill =>
    pill.addEventListener('click', () => {
      const am = state.missions.find(m => String(m.id) === String(pill.dataset.missionId));
      if (am) openMissionDetailModal(am);
    })
  );
}

// ─── Diagnostic Loop Reminders ────────────────────────────────────────────────
async function renderDiagnosticReminders(today) {
  const el = document.getElementById('diag-reminders');
  if (!el) return;

  // Collect all patient-contact slots that have termin dates set
  const allSlots = await db.scheduleSlots.toArray();
  const reminders = [];

  for (const slot of allSlots) {
    if (!SLOT_TYPES[slot.type]?.patientContact) continue;
    const label = slot.patientNotes ? `„${slot.patientNotes}"` : `Slot #${slot.id}`;

    if (slot.terminInterview && !slot.terminInterviewDone) {
      const d = slot.terminInterview.slice(0, 10);
      if (d <= today) {
        reminders.push({
          icon: '📝', urgent: d === today,
          text: d === today
            ? `Heute Interview mit ${label} – Zeit, den Verdacht zu prüfen!`
            : `Überfällig: Interview mit ${label} war ${d}`,
          slotId: slot.id,
          action: 'interview',
        });
      }
    }
    if (slot.terminErstgespraech && !slot.seniorCode) {
      const d = slot.terminErstgespraech.slice(0, 10);
      if (d <= today) {
        reminders.push({
          icon: '🔍', urgent: d === today,
          text: d === today
            ? `Heute Erstgespräch mit ${label} – Akten-Check vorbereiten!`
            : `Akten-Check: Was hat der/die Therapeut*In bei ${label} diagnostiziert? (${d})`,
          slotId: slot.id,
          action: 'verify',
        });
      }
    }
  }

  if (!reminders.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = reminders.map(r => `
    <div class="diag-reminder${r.urgent ? ' diag-reminder--urgent' : ''}" data-slot-id="${r.slotId}" data-action="${r.action}">
      <span class="diag-reminder-icon">${r.icon}</span>
      <span class="diag-reminder-text">${r.text}</span>
      <button class="diag-reminder-btn">Öffnen ›</button>
    </div>`).join('');

  el.querySelectorAll('[data-slot-id]').forEach(row => {
    row.querySelector('.diag-reminder-btn').addEventListener('click', async () => {
      const slot = await db.scheduleSlots.get(parseInt(row.dataset.slotId));
      if (!slot) return;
      if (row.dataset.action === 'verify') {
        openVerifyModal(slot);
      } else {
        openSlotEditForm(slot, 'planner');
      }
    });
  });
}

function renderMissions() {
  const gridEl = document.getElementById('missions-grid');
  if (!gridEl) return;
  const activeMissions = state.missions.filter(m => !m.completedAt).sort((a, b) => a.slotIndex - b.slotIndex);
  const missionCardHtml = (am, mDef, _pct, current, target, done = false) => {
    const dateStr = done && am.completedAt
      ? new Date(am.completedAt).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'2-digit' })
      : null;
    const cbs = done ? '' : missionCheckboxes(current, target, mDef.tier, mDef.emoji || '🎯');
    const doneLabel = done ? `<span class="m-done-date">${dateStr || '✓'}</span>` : '';
    return `
      <div class="mission-card tier-${mDef.tier}${done ? ' mission-card--done' : ''}">
        <div class="mc-left">
          <div class="mc-icon-circle">
            <span class="mc-emoji">${mDef.emoji || '🎯'}</span>
          </div>
        </div>
        <div class="mc-right">
          <div class="mission-card-header">
            <span class="mission-tier-badge">${TIER_LABELS[mDef.tier]}</span>
            <span class="mission-reward">${done ? '✓ ' : ''}+${mDef.reward.toLocaleString('de-AT')} XP</span>
          </div>
          <div class="mission-title">${mDef.title}</div>
          <div class="mission-desc">${mDef.description}</div>
          ${cbs ? `<div class="mission-progress-row">${cbs}</div>` : doneLabel}
        </div>
      </div>`;
  };

  if (!activeMissions.length) {
    gridEl.innerHTML = db.missions
      ? '<div class="empty-state">Missionen werden initialisiert…</div>'
      : `<div class="empty-state" style="text-align:center">Missionen nicht verfügbar.<br><small style="color:var(--text-dim)">Bitte Seite neu laden (Strg+Shift+R)</small></div>`;
  } else {
    gridEl.innerHTML = activeMissions.map(am => {
      const mDef = MISSION_POOL.find(m => m.id === am.missionId);
      if (!mDef) return '';
      const catchesSince = state.catches.filter(c => c.caughtAt >= am.activatedAt);
      const shiftsSince  = state.shifts.filter(s => (s.createdAt || `${s.date}T00:00:00`) >= am.activatedAt);
      const { current, target } = calcMissionProgress(mDef, catchesSince, shiftsSince, state.icdFlat);
      const pct = Math.min(100, Math.round((current / target) * 100));
      return missionCardHtml(am, mDef, pct, current, target, false);
    }).join('');
  }

  // Embed completed history below
  const histEl = document.getElementById('missions-history-section');
  if (!histEl) return;
  const completed = state.missions.filter(m => m.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  if (!completed.length) { histEl.innerHTML = ''; return; }
  histEl.innerHTML = `<div class="section-header" style="margin-top:20px">✅ Abgeschlossene Missionen</div>`
    + completed.map(am => {
        const mDef = MISSION_POOL.find(m => m.id === am.missionId);
        if (!mDef) return '';
        return missionCardHtml(am, mDef, 100, 1, 1, true);
      }).join('');
}

// ─── Diagnosen Tab ────────────────────────────────────────────────────────────
function _dxMatchKind(sc, thCodes) {
  if (thCodes.includes(sc))                                    return 'exact';
  if (thCodes.some(tc => tc.slice(0, 3) === sc.slice(0, 3))) return 'partial';
  if (thCodes.some(tc => tc.slice(0, 2) === sc.slice(0, 2))) return 'partial';
  return 'miss';
}

async function renderDiagnosenTab() {
  const el = document.getElementById('diagnosen-tab-content');
  if (!el) return;

  const filter = document.querySelector('.dx-filter-btn.active')?.dataset.filter || 'all';

  // Wire filter buttons (idempotent)
  document.querySelectorAll('.dx-filter-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.dx-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDiagnosenTab();
    };
  });

  const allSlots = await db.scheduleSlots.toArray();
  const patientSlots = allSlots
    .filter(s => !!SLOT_TYPES[s.type]?.patientContact)
    .sort((a, b) => {
      const shiftA = state.shifts.find(sh => sh.id === a.shiftId);
      const shiftB = state.shifts.find(sh => sh.id === b.shiftId);
      const dateA = shiftA?.date || '';
      const dateB = shiftB?.date || '';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return (a.startHour * 60 + (a.startMinute || 0)) - (b.startHour * 60 + (b.startMinute || 0));
    });

  const isVerified = s => !!(s.seniorCode || s.therapistCodes?.length);
  const isOffen    = s => !isVerified(s);

  const visible = patientSlots.filter(s => {
    if (filter === 'verified') return isVerified(s);
    if (filter === 'offen')    return isOffen(s);
    return true;
  });

  if (!visible.length) {
    el.innerHTML = '<div class="empty-state">Keine Patiententermine gefunden.</div>';
    return;
  }

  const fmtD = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–';

  let html = '';
  for (const s of visible) {
    const def      = SLOT_TYPES[s.type] || {};
    const shift    = state.shifts.find(sh => sh.id === s.shiftId);
    const timeStr  = padT(s.startHour, s.startMinute ?? 0);
    const dateStr  = shift ? fmtD(shift.date) : '–';
    const verified = isVerified(s);
    const kuerzel  = s.patientNotes || '';

    const slotCatches = state.catches.filter(c => c.slotId === s.id);
    const myDxObjs = slotCatches.length > 0
      ? slotCatches.map(c => ({ code: c.code.trim().toUpperCase(), title: c.name || '' }))
      : (s.suspectedCodes || []).map(c => ({ code: c.code.trim().toUpperCase(), title: c.title || '' }));

    let bodyHtml = '';
    if (verified) {
      const thObjs = (s.therapistCodes || []).map(c => ({ code: c.code.trim().toUpperCase(), title: c.title || '' }));
      if (!thObjs.length && s.seniorCode) thObjs.push({ code: s.seniorCode.trim().toUpperCase(), title: '' });
      const thCodes = thObjs.map(o => o.code);
      const myCodes = myDxObjs.map(o => o.code);

      const myRows = myDxObjs.map(o => ({ ...o, kind: _dxMatchKind(o.code, thCodes) }));
      const thRows = thObjs.map(o => ({ ...o, kind: _dxMatchKind(o.code, myCodes) }));

      const kindClass = k => k === 'exact' ? 'dx-chip dx-chip--exact' : k === 'partial' ? 'dx-chip dx-chip--partial' : 'dx-chip dx-chip--miss';
      const kindSym   = k => k === 'exact' ? '✓' : k === 'partial' ? '≈' : '✗';

      const myChips = myRows.map(r =>
        `<button class="${kindClass(r.kind)} dx-chip-clickable" data-code="${r.code}">
          <span class="dx-chip-sym">${kindSym(r.kind)}</span>
          <span class="dx-chip-code">${r.code}</span>
          ${r.title ? `<span class="dx-chip-name">${r.title}</span>` : ''}
        </button>`
      ).join('') || '<span class="dx-empty-label">keine</span>';

      const thChips = thRows.map(r =>
        `<button class="${kindClass(r.kind)} dx-chip-clickable" data-code="${r.code}">
          <span class="dx-chip-sym">${kindSym(r.kind)}</span>
          <span class="dx-chip-code">${r.code}</span>
          ${r.title ? `<span class="dx-chip-name">${r.title}</span>` : ''}
        </button>`
      ).join('') || '<span class="dx-empty-label">keine</span>';

      bodyHtml = `
        <div class="dx-compare-grid">
          <div class="dx-col">
            <div class="dx-col-title">Meine Diagnosen</div>
            <div class="dx-chips">${myChips}</div>
          </div>
          <div class="dx-col">
            <div class="dx-col-title">Therapeut${s.therapistName ? ` · ${s.therapistName}` : ''}</div>
            <div class="dx-chips">${thChips}</div>
          </div>
        </div>
        <div class="dx-item-footer">
          <button class="dx-action-btn" data-action="edit" data-slot-id="${s.id}">Bearbeiten</button>
        </div>`;
    } else {
      const catchChips = slotCatches.map(c =>
        `<button class="dx-chip dx-chip-clickable" data-code="${c.code}">
          <span class="dx-chip-code">${c.code}</span>
          <span class="dx-chip-name">${c.name || ''}</span>
        </button>`
      ).join('') || '<span class="dx-empty-label">keine Diagnosen erfasst</span>';

      bodyHtml = `
        <div class="dx-chips" style="margin:8px 0">${catchChips}</div>
        <div class="dx-item-footer">
          <button class="dx-action-btn dx-action-btn-primary" data-action="verify" data-slot-id="${s.id}">Vergleichen</button>
        </div>`;
    }

    html += `<div class="dx-item">
      <div class="dx-item-header">
        <div>
          <span class="dx-item-type">${def.icon} ${def.label}</span>
          <span class="dx-item-date">${dateStr} · ${timeStr}</span>
          ${kuerzel ? `<span class="dx-item-kuerzel">„${kuerzel}"</span>` : ''}
        </div>
        <span class="dx-badge ${verified ? 'dx-badge--done' : 'dx-badge--offen'}">${verified ? '✓' : '–'}</span>
      </div>
      ${bodyHtml}
    </div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('.dx-chip-clickable[data-code]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openDiagInfoModal(btn.dataset.code);
    });
  });

  el.querySelectorAll('[data-action="verify"][data-slot-id]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const slot = await db.scheduleSlots.get(parseInt(btn.dataset.slotId));
      if (slot) openVerifyModal(slot);
    });
  });

  el.querySelectorAll('[data-action="edit"][data-slot-id]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const slot = await db.scheduleSlots.get(parseInt(btn.dataset.slotId));
      if (slot) openVerifyModal(slot);
    });
  });
}

// ─── ICD-F Tab ────────────────────────────────────────────────────────────────
function renderICDFTab() {
  renderICDFCollectionPanel();
  renderPsychoDex();
}

function loadICDFCollection() {
  try {
    const stored = localStorage.getItem('icdf-collection');
    if (stored) state.icdfCollection = JSON.parse(stored);
  } catch { state.icdfCollection = { symptoms: [], diagnoses: [] }; }
}

function saveICDFCollection() {
  localStorage.setItem('icdf-collection', JSON.stringify(state.icdfCollection));
}

function addToICDFCollection(type, item) {
  if (!state.icdfCollection) state.icdfCollection = { symptoms: [], diagnoses: [] };
  if (type === 'symptom') {
    if (!state.icdfCollection.symptoms.includes(item)) {
      state.icdfCollection.symptoms.push(item);
      saveICDFCollection();
      renderICDFCollectionPanel();
    }
  } else if (type === 'diagnosis') {
    if (!state.icdfCollection.diagnoses.find(d => d.code === item.code)) {
      state.icdfCollection.diagnoses.push({ code: item.code, name: item.name });
      saveICDFCollection();
      renderICDFCollectionPanel();
    }
  }
}

function renderICDFCollectionPanel() {
  const panel   = document.getElementById('icdf-collection-panel');
  const toggle  = document.getElementById('btn-toggle-icdf-collection');
  if (!panel || !toggle) return;

  const col = state.icdfCollection || { symptoms: [], diagnoses: [] };
  const hasContent = col.symptoms.length || col.diagnoses.length;

  if (!hasContent) {
    panel.classList.add('hidden');
    toggle.classList.add('hidden');
    return;
  }

  toggle.classList.remove('hidden');
  toggle.textContent = panel.classList.contains('hidden')
    ? `🧩 Sammlung (${col.symptoms.length + col.diagnoses.length})`
    : '🧩 Sammlung schließen';

  if (!panel.classList.contains('hidden')) {
    // Symptoms
    const chipsEl = document.getElementById('icdf-symptom-chips');
    if (chipsEl) {
      chipsEl.innerHTML = col.symptoms.map(s =>
        `<span class="icdf-chip">${s}<button class="icdf-chip-del" data-symptom="${s.replace(/"/g, '&quot;')}">✕</button></span>`
      ).join('') || '<span style="color:var(--text-dim);font-size:12px">Keine Symptome gesammelt</span>';
      chipsEl.querySelectorAll('.icdf-chip-del').forEach(btn => {
        btn.addEventListener('click', () => {
          state.icdfCollection.symptoms = state.icdfCollection.symptoms.filter(s => s !== btn.dataset.symptom);
          saveICDFCollection();
          renderICDFCollectionPanel();
        });
      });
    }

    // Diagnoses
    const diagEl = document.getElementById('icdf-diag-chips');
    if (diagEl) {
      diagEl.innerHTML = col.diagnoses.map(d =>
        `<span class="icdf-chip icdf-chip-diag" data-code="${d.code}">
          <span class="icdf-chip-code">${d.code}</span> ${d.name}
          <button class="icdf-chip-del" data-code="${d.code}">✕</button>
        </span>`
      ).join('') || '<span style="color:var(--text-dim);font-size:12px">Keine Diagnosen gesammelt</span>';
      diagEl.querySelectorAll('.icdf-chip-diag').forEach(chip => {
        chip.addEventListener('click', e => {
          if (e.target.closest('.icdf-chip-del')) return;
          openDiagInfoModal(chip.dataset.code);
        });
      });
      diagEl.querySelectorAll('.icdf-chip-del').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          state.icdfCollection.diagnoses = state.icdfCollection.diagnoses.filter(d => d.code !== btn.dataset.code);
          saveICDFCollection();
          renderICDFCollectionPanel();
        });
      });
    }
  }
}

function setupICDFCollectionListeners() {
  document.getElementById('btn-toggle-icdf-collection')?.addEventListener('click', () => {
    const panel = document.getElementById('icdf-collection-panel');
    panel?.classList.toggle('hidden');
    renderICDFCollectionPanel();
  });
  document.getElementById('btn-icdf-clear-symptoms')?.addEventListener('click', () => {
    state.icdfCollection.symptoms = [];
    saveICDFCollection();
    renderICDFCollectionPanel();
  });
  document.getElementById('btn-icdf-clear-diags')?.addEventListener('click', () => {
    state.icdfCollection.diagnoses = [];
    saveICDFCollection();
    renderICDFCollectionPanel();
  });
  document.getElementById('btn-icdf-add-symptom')?.addEventListener('click', () => {
    const inp = document.getElementById('icdf-symptom-add');
    const val = inp?.value.trim();
    if (val) { addToICDFCollection('symptom', val); inp.value = ''; }
  });
  document.getElementById('icdf-symptom-add')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) { addToICDFCollection('symptom', val); e.target.value = ''; }
    }
  });
  document.getElementById('icdf-caught-bar')?.addEventListener('click', openCatchesModal);
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
    <div class="cat-detail-action-row">
      ${!isCaught ? `<button class="btn-catch" id="cat-detail-catch-btn">🎯 Jetzt fangen!</button>` : ''}
      <button class="btn-secondary icdf-collect-btn" id="cat-detail-collect-btn" style="font-size:13px;padding:8px 14px">🧩 Sammeln</button>
    </div>`;

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
  document.getElementById('cat-detail-collect-btn')?.addEventListener('click', () => {
    addToICDFCollection('diagnosis', diag);
    const btn = document.getElementById('cat-detail-collect-btn');
    if (btn) { btn.textContent = '✓ Gesammelt'; btn.disabled = true; }
  });
}

function closeCategoryModal() {
  document.getElementById('category-modal').classList.add('hidden');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  renderDashboard();

  const hasActive = state.missions.some(m => !m.completedAt);
  if (!hasActive && db.missions) ensureMissionSlots().then(() => renderMissions()).catch(() => {});
  renderMissions();

  const xp     = state.profile?.totalXP ?? 0;
  const el = id => document.getElementById(id);
  const heatmapStart = renderHeatmap();
  const heatmapHeader = document.getElementById('heatmap-section-header');
  if (heatmapHeader && heatmapStart) {
    const startLabel = new Date(heatmapStart + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' });
    heatmapHeader.textContent = `Dienst-Aktivität (seit ${startLabel})`;
  }
  renderCategoryChart();
  renderAchievements();

  // Update sub-tab summary chips
  const rank = getRankForXP(xp);
  const starPos = ((rank.level - 1) % 3) + 1;
  const starsStr = '★'.repeat(starPos) + '☆'.repeat(3 - starPos);
  const earnedBadges = new Set((state.unlockedAchievements || []).map(a => a.badgeId)).size;
  const totalBadges  = (ACHIEVEMENTS.length + SECRET_ACHIEVEMENTS.length);
  if (el('sstab-overview-stat'))  el('sstab-overview-stat').textContent  = `${rank.title} ${starsStr}`;
  const activeMissionCount = (state.missions || []).filter(m => !m.completedAt).length;
  if (el('sstab-dienste-stat'))   el('sstab-dienste-stat').textContent   = `${activeMissionCount} aktiv`;
  if (el('sstab-diagnosen-stat')) el('sstab-diagnosen-stat').textContent = `${state.catches.length} gefangen`;
  if (el('sstab-badges-stat'))    el('sstab-badges-stat').textContent    = `${earnedBadges} / ${totalBadges}`;

  renderSupervisionStats();

  // Apply current sub-tab visibility
  switchStatsSubTab(state.statsSubTab);
}

function renderHeatmap() {
  const el       = document.getElementById('heatmap');
  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Build date → { shift, color, isFuture } map
  const shiftMap = new Map();
  for (const shift of state.shifts) {
    const isFuture = shift.date > todayStr;
    let color;
    if (isFuture) {
      color = null; // future shifts get a fixed CSS class, not an activity color
    } else {
      const asgn = shift.zuteilung?.assignments;
      let fraction;
      if (asgn && Object.keys(asgn).length > 0) {
        const vals = Object.values(asgn);
        fraction = vals.filter(v => v !== 'pause').length / vals.length;
      } else {
        try {
          const h = shiftHours(shift);
          const durMins = (h.end[0]*60 + h.end[1]) - (h.start[0]*60 + h.start[1]);
          fraction = Math.min(1, durMins / 480);
        } catch { fraction = 1; }
      }
      const hue = Math.round(fraction * 110);
      color = `hsl(${hue},70%,48%)`;
    }
    shiftMap.set(shift.date, { id: shift.id, color, isFuture });
  }

  // Start: Monday of first shift week (past or future)
  const allDates = state.shifts.map(s => s.date).sort();
  const firstDate = allDates[0] || null;
  let start;
  if (firstDate) {
    start = new Date(firstDate + 'T12:00:00');
    const dow = start.getDay() || 7;
    start.setDate(start.getDate() - (dow - 1));
  } else {
    start = new Date(today);
    start.setDate(start.getDate() - 52 * 7 + 1);
  }
  const maxStart = new Date(today);
  maxStart.setDate(maxStart.getDate() - 104 * 7);
  if (start < maxStart) start = maxStart;

  const startStr  = start.toISOString().split('T')[0];
  const msPerWeek = 7 * 24 * 3600 * 1000;
  // Extend 9 weeks into the future (~2 months)
  const WEEKS = Math.min(112, Math.ceil((today - start) / msPerWeek) + 9);

  let html = '';
  for (let w = 0; w < WEEKS; w++) {
    html += '<div class="heatmap-col">';
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      const ds    = date.toISOString().split('T')[0];
      const entry = shiftMap.get(ds);
      const isFutureShift = entry?.isFuture;
      const cls = ['heatmap-cell',
        entry ? (isFutureShift ? 'hm-future-shift' : 'hm-active') : '',
        ds === todayStr ? 'hm-today' : '',
        date > today && !entry ? 'hm-future' : '',
      ].filter(Boolean).join(' ');
      const styleAttr = entry && !isFutureShift && ds !== todayStr
        ? ` style="background:${entry.color};box-shadow:0 0 5px ${entry.color}66"` : '';
      const dataAttr  = entry ? ` data-shift-id="${entry.id}"` : '';
      html += `<div class="${cls}"${styleAttr}${dataAttr} title="${ds}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;

  el.querySelectorAll('.heatmap-cell[data-shift-id]').forEach(cell => {
    cell.addEventListener('click', () => openShiftDetailModal(parseInt(cell.dataset.shiftId)));
  });

  return startStr;
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
  document.getElementById('edit-cat-selector').querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('edit-cat-selector').querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
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
      (btn.dataset.type === 'früh' && !['spät','full','samstag','schulung'].includes(shift.type))));
  const shiftCat = shift.category || 'regulär';
  document.getElementById('edit-cat-selector').querySelectorAll('.cat-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.category === shiftCat));
  document.getElementById('edit-shift-modal').classList.remove('hidden');
}

function closeEditShiftModal() {
  document.getElementById('edit-shift-modal').classList.add('hidden');
  state.editingShiftId = null;
}

function _baseShiftXP(type) {
  if (type === 'full') return 120;
  if (type === 'samstag') return 70;
  if (type === 'schulung') return 40;
  return 65;
}

async function saveEditShift() {
  const shift = state.shifts.find(s => s.id === state.editingShiftId);
  if (!shift) return;
  const newDate = document.getElementById('edit-shift-date').value;
  const newType = document.getElementById('edit-type-selector').querySelector('.type-btn.active')?.dataset.type || shift.type;
  const newCat  = document.getElementById('edit-cat-selector').querySelector('.cat-btn.active')?.dataset.category || shift.category || 'regulär';

  const updates = { date: newDate, type: newType, category: newCat, updatedAt: new Date().toISOString() };

  // Only adjust XP for shifts where base XP is already earned
  if (!shift.plannerActive || shift.baseXPAwarded) {
    const oldShiftXP = Math.round(_baseShiftXP(shift.type) * (CATEGORY_XP_MODIFIER[shift.category || 'regulär'] ?? 1));
    const newShiftXP = Math.round(_baseShiftXP(newType) * (CATEGORY_XP_MODIFIER[newCat] ?? 1));
    const xpDelta = newShiftXP - oldShiftXP;
    updates.xpEarned = (shift.xpEarned || 0) + xpDelta;
    if (xpDelta !== 0) {
      const newTotal = (state.profile.totalXP ?? 0) + xpDelta;
      await db.profile.update(state.profile.id, { totalXP: newTotal });
      state.profile.totalXP = newTotal;
    }
  }

  await db.shiftLogs.update(state.editingShiftId, updates);
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  closeEditShiftModal();

  // Refresh home tab if this is the currently displayed shift
  if (state.homeSelectedShiftId === shift.id) {
    renderHomeTab();
  }

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

  // Load planner slots early so we can use their times in the patient map
  const shiftSlots = await db.scheduleSlots.where('shiftId').equals(shift.id).toArray();
  shiftSlots.sort((a, b) => {
    if (a.sortOrder != null && b.sortOrder != null) return a.sortOrder - b.sortOrder;
    return (a.startHour * 60 + (a.startMinute || 0)) - (b.startHour * 60 + (b.startMinute || 0));
  });
  const slotMap = new Map(shiftSlots.map(s => [s.id, s]));
  const catchesBySlot = new Map();
  shiftCatches.forEach(c => {
    if (c.slotId != null) {
      if (!catchesBySlot.has(c.slotId)) catchesBySlot.set(c.slotId, []);
      catchesBySlot.get(c.slotId).push(c);
    }
  });

  // Separate patient-contact slots from non-patient slots
  const patientSlots    = shiftSlots.filter(sl => SLOT_TYPES[sl.type]?.patientContact);
  const nonPatientSlots = shiftSlots.filter(sl => !SLOT_TYPES[sl.type]?.patientContact);

  // Legacy catches: those NOT linked to any slot (old-style entries)
  const legacyCatches = shiftCatches.filter(c => c.slotId == null);
  const legacyPatientMap = new Map();
  legacyCatches.forEach(c => {
    const key = c.patientIndex != null ? c.patientIndex : `${c.ageGroup}-${c.gender}-${c.patientType}`;
    if (!legacyPatientMap.has(key)) {
      legacyPatientMap.set(key, {
        ageGroup: c.ageGroup || '?', gender: c.gender || '?',
        patientType: c.patientType || 'erstgespraech',
        patientTime: c.patientTime ?? null,
        catches: [], index: key
      });
    }
    legacyPatientMap.get(key).catches.push(c);
  });
  const sortedLegacy = [...legacyPatientMap.entries()]
    .sort(([, a], [, b]) => (a.patientTime ?? 9999) - (b.patientTime ?? 9999));

  const actualPatientCount = patientSlots.length + legacyPatientMap.size;
  if (shift.patientCount !== actualPatientCount) {
    db.shiftLogs.update(shift.id, { patientCount: actualPatientCount });
    shift.patientCount = actualPatientCount;
  }
  const extMins  = shift.extensionMinutes || 0;
  const shiftH   = calcShiftHours(shift).toFixed(1).replace('.0','');
  const extLabel = extMins > 0 ? `+${extMins}min (${shiftH}h)` : `${shiftH}h`;
  const noteXPPreview = !shift.noteAddedAt
    ? `+${calculateNoteXP(shift.date, new Date().toISOString())} XP jetzt`
    : '';

  let html = `
    <div class="shift-detail-header">
      <div class="shift-detail-info">
        <div class="shift-detail-date">${shiftIcon(shift.type)} ${fmtDateShort(shift.date)} · ${shiftLabelFull(shift)}</div>
        <div class="shift-detail-meta">+${shift.xpEarned} XP · ${actualPatientCount} Termin(e)</div>
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

  if (patientSlots.length === 0 && legacyPatientMap.size === 0) {
    html += '<div class="empty-state">Keine Diagnosen für diesen Dienst.</div>';
  }

  // ── Patient-contact slots (merged "Termin" + slot info) ───────────────────
  for (const sl of patientSlots) {
    const def        = SLOT_TYPES[sl.type] || {};
    const slotCatches = (catchesBySlot.get(sl.id) || [])
      .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
    const verified   = !!sl.seniorCode;
    const kuerzel    = sl.patientNotes || '';
    const timeLabel  = `${padT(sl.startHour, sl.startMinute ?? 0)}–${padT(sl.endHour, sl.endMinute ?? 0)}`;

    const catchRows = slotCatches.map(c => `
      <div class="patient-diag-row pd-row-clickable" data-code="${c.code}" data-catch-id="${c.id}">
        <div class="pd-thumb">
          <img src="assets/images/diagnoses/${c.code.toLowerCase()}.png" class="pd-thumb-img" alt=""
               onerror="this.style.display='none'" loading="lazy">
        </div>
        <span class="pd-code">${c.code}</span>
        <span class="pd-name">${c.name}</span>
        <span class="pd-xp">+${c.xpEarned} XP</span>
        <button class="btn-icon btn-delete-shift-catch" data-id="${c.id}" title="Diagnose löschen">🗑</button>
      </div>`).join('');

    const suspHtml = (sl.suspectedCodes || []).length
      ? `<div class="ps-susp-row"><span class="ps-susp-label">Verdacht:</span>${
          sl.suspectedCodes.map(c =>
            `<span class="dsd-chip dsd-chip-susp" title="${c.title||''}">${c.code}</span>`).join('')
        }</div>`
      : '';

    const thCodes = sl.therapistCodes?.length
      ? sl.therapistCodes
      : (sl.seniorCode ? [{ code: sl.seniorCode }] : []);
    const thHtml = verified
      ? `<div class="ps-susp-row"><span class="ps-susp-label">Experte:</span>${
          thCodes.map(c => `<span class="dsd-chip dsd-chip-th" title="${c.title||''}">${c.code}</span>`).join('')
        }${sl.therapistName ? `<span class="dsd-therapist">&nbsp;${sl.therapistName}</span>` : ''}</div>`
      : '';

    const verifyBtn = verified
      ? `<button class="dx-action-btn btn-slot-verify" data-slot-id="${sl.id}">Bearbeiten</button>`
      : `<button class="dx-action-btn dx-action-btn-primary btn-slot-verify" data-slot-id="${sl.id}">Vergleichen</button>`;

    html += `<div class="patient-section ps-slot" data-slot-id="${sl.id}">
      <div class="patient-section-header">
        <div>
          <div class="patient-section-label">${def.icon} ${def.label} · ${timeLabel} · +${sl.xpEarned} XP</div>
          ${kuerzel ? `<div class="patient-section-demo">${kuerzel}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          ${verifyBtn}
          <button class="btn-icon btn-slot-edit-form" data-slot-id="${sl.id}" title="Slot bearbeiten">✎</button>
          <button class="btn-icon btn-slot-del-row" data-slot-id="${sl.id}" title="Slot löschen">🗑</button>
        </div>
      </div>
      ${suspHtml}
      <div class="patient-diags" id="pdiags-${shift.id}-${sl.id}">${catchRows}</div>
      ${thHtml}
      <button class="patient-section-add btn-add-diag-to-slot" data-slotid="${sl.id}" data-shiftid="${shift.id}">+ Diagnose hinzufügen</button>
    </div>`;
  }

  // ── Legacy catches (no slotId) ────────────────────────────────────────────
  let pNum = patientSlots.length + 1;
  for (const [, p] of sortedLegacy) {
    const timeStr    = p.patientTime != null ? `${String(p.patientTime).padStart(2,'0')}:00 Uhr · ` : '';
    const timeKey    = p.patientTime != null ? `${String(p.patientTime).padStart(2,'0')}:00` : null;
    const typeLabel  = p.patientType === 'erstgespraech' ? 'Erstgespräch' : 'Interview';
    const termLabel  = timeKey ? `Termin ${timeKey}` : `Termin ${pNum}`;
    const ageStr     = (p.ageGroup && p.ageGroup !== 'unbekannt') ? `${p.ageGroup} J · ` : '';
    const genderStr  = (p.gender  && p.gender  !== 'unbekannt') ? `${p.gender} · ` : '';
    const demoLabel  = `${timeStr}${ageStr}${genderStr}${typeLabel}`;

    html += `<div class="patient-section" data-pkey="${p.index}">
      <div class="patient-section-header">
        <div>
          <div class="patient-section-label">${termLabel}</div>
          <div class="patient-section-demo">${demoLabel}</div>
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn-icon btn-move-patient" data-pkey="${p.index}" title="Termin verschieben">↗</button>
          <button class="btn-icon btn-edit-patient-demo" data-pkey="${p.index}" title="Demografik bearbeiten">✎</button>
          <button class="btn-icon btn-delete-shift-patient" data-pkey="${p.index}" title="Termin löschen">🗑</button>
        </div>
      </div>
      <div class="patient-diags" id="pdiags-${shift.id}-${p.index}">`;

    p.catches.forEach(c => {
      html += `<div class="patient-diag-row pd-row-clickable" data-code="${c.code}" data-catch-id="${c.id}">
        <div class="pd-thumb">
          <img src="assets/images/diagnoses/${c.code.toLowerCase()}.png" class="pd-thumb-img" alt=""
               onerror="this.style.display='none'" loading="lazy">
        </div>
        <span class="pd-code">${c.code}</span>
        <span class="pd-name">${c.name}</span>
        <span class="pd-xp">+${c.xpEarned} XP</span>
        ${legacyPatientMap.size > 1 ? `<button class="btn-icon btn-move-diag" data-id="${c.id}" data-pkey="${p.index}" title="Patient wechseln">↗</button>` : ''}
        <button class="btn-icon btn-delete-shift-catch" data-id="${c.id}" title="Diagnose löschen">🗑</button>
      </div>`;
    });

    html += `</div>
      <button class="patient-section-add btn-add-diag-to-patient" data-shiftid="${shift.id}" data-pkey="${p.index}">+ Diagnose hinzufügen</button>
    </div>`;
    pNum++;
  }

  html += `<button class="patient-section-add" id="btn-add-new-patient-to-shift" data-shiftid="${shift.id}"
    style="display:block;width:100%;padding:12px;border:1px dashed rgba(124,58,237,.3);border-radius:var(--r);color:var(--accent);margin-top:8px">
    + Neuer Termin & Diagnose
  </button>`;

  // ── Non-patient planner slots ─────────────────────────────────────────────
  if (nonPatientSlots.length || (shift.plannerShift && !patientSlots.length)) {
    const rowsHtml = nonPatientSlots.length ? nonPatientSlots.map(sl => {
      const def = SLOT_TYPES[sl.type] || {};
      return `<div class="detail-slot-row" data-slot-id="${sl.id}" data-sid="${sl.id}">
        <span class="drag-handle" data-drag title="Verschieben">⠿</span>
        <span class="detail-slot-icon">${def.icon || '📌'}</span>
        <div class="detail-slot-info">
          <span class="detail-slot-label">${def.label || sl.type}</span>
          <span class="detail-slot-time">${padT(sl.startHour,sl.startMinute)}–${padT(sl.endHour,sl.endMinute)} · +${sl.xpEarned} XP</span>
          ${sl.comment ? `<span class="detail-slot-comment">${sl.comment}</span>` : ''}
        </div>
        <button class="btn-icon detail-slot-del" data-slot-id="${sl.id}">🗑</button>
      </div>`;
    }).join('') : '<div class="detail-slots-empty">Keine Einträge</div>';

    html += `<div class="detail-slots-section">
      <div class="detail-slots-header">
        <span class="detail-slots-title">📋 Planer-Einträge</span>
        <button class="btn-secondary detail-add-slot-btn" id="btn-detail-add-slot">+ Eintrag</button>
      </div>
      <div class="detail-slots-list" id="detail-slots-sortable">${rowsHtml}</div>
    </div>`;
  } else if (shiftSlots.length === 0 && shift.plannerShift) {
    html += `<div class="detail-slots-section">
      <div class="detail-slots-header">
        <span class="detail-slots-title">📋 Planer-Einträge</span>
        <button class="btn-secondary detail-add-slot-btn" id="btn-detail-add-slot">+ Eintrag</button>
      </div>
      <div class="detail-slots-list" id="detail-slots-sortable"><div class="detail-slots-empty">Keine Einträge</div></div>
    </div>`;
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
      if (e.target.closest('.btn-delete-shift-catch') || e.target.closest('.btn-move-diag')) return;
      body.querySelectorAll('.move-diag-menu').forEach(m => m.remove());
      openDiagInfoModal(row.dataset.code);
    });
  });

  body.querySelectorAll('.btn-delete-shift-catch').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteShiftCatch(parseInt(btn.dataset.id), shift);
    });
  });

  // Add diagnosis to a patient-contact slot
  body.querySelectorAll('.btn-add-diag-to-slot').forEach(btn => {
    btn.addEventListener('click', () => {
      const slotId = parseInt(btn.dataset.slotid);
      state.addToShiftContext = { shiftId: shift.id, patientIndex: null, slotId, slotSource: 'detail' };
      closeShiftDetailModal();
      openAddToShiftDiagSearch(shift.id, null);
    });
  });

  // Add diagnosis to legacy patient section
  body.querySelectorAll('.btn-add-diag-to-patient').forEach(btn => {
    btn.addEventListener('click', () => {
      const pkey = btn.dataset.pkey;
      closeShiftDetailModal();
      openAddToShiftDiagSearch(shift.id, pkey);
    });
  });

  // Slot verify / edit verify
  body.querySelectorAll('.btn-slot-verify').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const slotId = parseInt(btn.dataset.slotId);
      const slot   = await db.scheduleSlots.get(slotId);
      if (slot) openVerifyModal(slot);
    });
  });

  // Slot edit form
  body.querySelectorAll('.btn-slot-edit-form').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      db.scheduleSlots.get(parseInt(btn.dataset.slotId)).then(slot => {
        if (slot) openSlotEditForm(slot, 'detail');
      });
    });
  });

  // Slot delete (from patient slot row)
  body.querySelectorAll('.btn-slot-del-row').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSlot(parseInt(btn.dataset.slotId), shift, 'detail');
    });
  });

  body.querySelectorAll('.btn-move-diag').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      body.querySelectorAll('.move-diag-menu').forEach(m => m.remove());
      const catchId = parseInt(btn.dataset.id);
      const currentPkey = btn.dataset.pkey;
      const menu = document.createElement('div');
      menu.className = 'move-diag-menu';
      let pNum = 1;
      for (const [pkey] of legacyPatientMap) {
        const opt = document.createElement('button');
        opt.className = 'move-diag-option';
        if (String(pkey) === String(currentPkey)) {
          opt.textContent = `Termin ${pNum} (aktuell)`;
          opt.disabled = true;
        } else {
          opt.textContent = `→ Termin ${pNum}`;
          opt.addEventListener('click', async () => {
            await db.caughtDiagnoses.update(catchId, { patientIndex: pkey });
            state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
            renderShiftDetailBody(shift);
          });
        }
        menu.appendChild(opt);
        pNum++;
      }
      btn.closest('.patient-diag-row').after(menu);
    });
  });

  body.querySelector('#btn-add-new-patient-to-shift')?.addEventListener('click', () => {
    closeShiftDetailModal();
    openAddToShiftDiagSearch(shift.id, null);
  });

  body.querySelector('#btn-delete-this-shift')?.addEventListener('click', () =>
    deleteShift(parseInt(body.querySelector('#btn-delete-this-shift').dataset.id)));

  // Patient demo edit buttons (legacy sections only)
  body.querySelectorAll('.btn-move-patient').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      body.querySelectorAll('.move-patient-menu').forEach(m => m.remove());
      const pkey = btn.dataset.pkey;
      const p = patientMap.get(isNaN(pkey) ? pkey : parseInt(pkey));

      const allShifts = state.shifts.slice().sort((a, b) => a.date.localeCompare(b.date));
      const shiftOptions = allShifts.map(sh =>
        `<option value="${sh.id}" ${sh.id === shift.id ? 'selected' : ''}>${fmtDateShort(sh.date)} ${shiftIcon(sh.type)} ${shiftLabel(sh.type)}${sh.id === shift.id ? ' (aktuell)' : ''}</option>`
      ).join('');

      const currentTimeVal = p?.patientTime != null
        ? `${String(p.patientTime).padStart(2,'0')}:00`
        : '';

      const menu = document.createElement('div');
      menu.className = 'move-patient-menu slot-move-menu';
      menu.innerHTML = `
        <div class="slot-move-menu-inner">
          <div class="slot-move-row">
            <label>Uhrzeit</label>
            <input type="time" id="move-patient-time" value="${currentTimeVal}" placeholder="—">
          </div>
          <div class="slot-move-row">
            <label>Dienst</label>
            <select id="move-patient-shift">${shiftOptions}</select>
          </div>
          <div class="slot-move-actions">
            <button class="btn-primary move-patient-confirm">Verschieben</button>
            <button class="btn-secondary move-patient-cancel">Abbrechen</button>
          </div>
        </div>`;
      btn.closest('.patient-section-header').after(menu);

      menu.querySelector('.move-patient-cancel').addEventListener('click', e => {
        e.stopPropagation();
        menu.remove();
      });

      menu.querySelector('.move-patient-confirm').addEventListener('click', async e => {
        e.stopPropagation();
        const timeVal    = menu.querySelector('#move-patient-time').value;
        const newShiftId = parseInt(menu.querySelector('#move-patient-shift').value);
        const newTime    = timeVal ? parseInt(timeVal.split(':')[0]) : null;
        menu.remove();
        await movePatientToShift(pkey, shift, newShiftId, patientMap, newTime);
      });
    });
  });

  body.querySelectorAll('.btn-edit-patient-demo').forEach(btn => {
    btn.addEventListener('click', () => togglePatientEditRow(btn.dataset.pkey, shift.id, legacyPatientMap));
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
    const { start } = shiftHours(shift);
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
      if (e.target.closest('.detail-slot-del') || e.target.closest('[data-drag]')) return;
      const slot = await db.scheduleSlots.get(parseInt(row.dataset.slotId));
      if (slot) openSlotDetailModal(slot, 'detail');
    });
  });

  const slotsList = body.querySelector('#detail-slots-sortable');
  if (slotsList && shiftSlots.length > 1) {
    makeSortable(slotsList, async ids => {
      for (let i = 0; i < ids.length; i++) {
        await db.scheduleSlots.update(ids[i], { sortOrder: i });
        const s = state.plannerSlots.find(x => x.id === ids[i]);
        if (s) s.sortOrder = i;
      }
    });
  }
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

async function movePatientToShift(pkey, sourceShift, targetShiftId, patientMap, newPatientTime = undefined) {
  const keyVal = isNaN(pkey) ? pkey : parseInt(pkey);
  const p = patientMap.get(keyVal);
  if (!p || !p.catches.length) return;

  // Next available patientIndex in target shift
  const targetCatches = state.catches.filter(c => c.shiftId === targetShiftId);
  const newPIdx = targetCatches.reduce((m, c) => Math.max(m, c.patientIndex ?? -1), -1) + 1;

  const catchUpdates = { shiftId: targetShiftId, patientIndex: newPIdx };
  if (newPatientTime !== undefined) catchUpdates.patientTime = newPatientTime;

  for (const c of p.catches) {
    await db.caughtDiagnoses.update(c.id, catchUpdates);
  }

  // Refresh patientCount on both shifts
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();
  const srcCount = new Set(state.catches.filter(c => c.shiftId === sourceShift.id && c.patientIndex != null).map(c => c.patientIndex)).size;
  const tgtCount = new Set(state.catches.filter(c => c.shiftId === targetShiftId && c.patientIndex != null).map(c => c.patientIndex)).size;
  await db.shiftLogs.update(sourceShift.id, { patientCount: srcCount });
  await db.shiftLogs.update(targetShiftId, { patientCount: tgtCount });
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();

  const updatedShift = state.shifts.find(s => s.id === sourceShift.id);
  if (updatedShift) renderShiftDetailBody(updatedShift);
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
        const timeStr   = p.patientTime != null ? `${String(p.patientTime).padStart(2,'0')}:00 Uhr · ` : '';
        const ageStr2   = (p.ageGroup && p.ageGroup !== 'unbekannt') ? `${p.ageGroup} J · ` : '';
        const genStr2   = (p.gender   && p.gender   !== 'unbekannt') ? `${p.gender} · ` : '';
        const typeLabel = p.patientType === 'erstgespraech' ? 'Erstgespräch' : 'Interview';
        demoEl.textContent = `${timeStr}${ageStr2}${genStr2}${typeLabel}`;
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

  const fromSlotId  = state.addToShiftContext?.slotId   ?? null;
  const fromSlotSrc = state.addToShiftContext?.slotSource ?? 'planner';

  if (patientKey != null) {
    // Find patient data from existing catches for this patient key
    const patientCatches = shiftCatches.filter(c =>
      (c.patientIndex != null ? String(c.patientIndex) : `${c.ageGroup}-${c.gender}-${c.patientType}`) === String(patientKey));
    if (patientCatches.length) {
      ageGroup = patientCatches[0].ageGroup;
      gender   = patientCatches[0].gender;
      patientType = patientCatches[0].patientType;
      patientIndex = patientCatches[0].patientIndex ?? patientKey;
    }
  } else if (fromSlotId != null) {
    // Adding from a slot: all diagnoses for the same slot belong to the same patient
    const slotCatches = shiftCatches.filter(c => c.slotId === fromSlotId);
    if (slotCatches.length) {
      // Reuse the patientIndex of existing catches for this slot
      ageGroup    = slotCatches[0].ageGroup;
      gender      = slotCatches[0].gender;
      patientType = slotCatches[0].patientType;
      patientIndex = slotCatches[0].patientIndex ?? 0;
    } else {
      // First diagnosis for this slot → new patient
      const maxPIdx = shiftCatches.reduce((m, c) => Math.max(m, c.patientIndex ?? -1), -1);
      patientIndex = maxPIdx + 1;
    }
  } else {
    // New patient from shift detail
    const maxPIdx = shiftCatches.reduce((m, c) => Math.max(m, c.patientIndex ?? -1), -1);
    patientIndex = maxPIdx + 1;
  }

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
  // Only count new patient when this is genuinely the first catch for a new patient
  const isNewPatient = patientKey == null && !(fromSlotId != null && shiftCatches.some(c => c.slotId === fromSlotId));
  const newPatCount = isNewPatient ? (shift.patientCount || 0) + 1 : shift.patientCount;
  await db.shiftLogs.update(shiftId, { xpEarned: newShiftXP, patientCount: newPatCount });

  const oldXP = state.profile.totalXP ?? 0;
  const newXP = oldXP + xpResult.total;
  await db.profile.update(state.profile.id, { totalXP: newXP });
  state.profile.totalXP = newXP;
  state.shifts  = await db.shiftLogs.orderBy('date').reverse().toArray();
  state.catches = await db.caughtDiagnoses.orderBy('caughtAt').reverse().toArray();

  showXPPopup(xpResult.total, xpResult.bonuses);
  updateHeader();
  if (state.currentTab === 'stats') renderDashboard();
  checkLevelUp(newXP, oldXP);
  refreshMissionProgress();
  applyAchievements();

  if (fromSlotId) {
    if (fromSlotSrc === 'planner') {
      // Stay in planner – close diag modal and re-render timeline (only if still on same shift)
      document.getElementById('diagnosis-modal').classList.add('hidden');
      state.addToShiftContext = null;
      state.diagCatchStack = [];
      if (state.plannerShiftId === shiftId) {
        state.plannerSlots = await db.scheduleSlots.where('shiftId').equals(shiftId).sortBy('startHour');
        const freshShift = state.shifts.find(s => s.id === shiftId);
        if (freshShift) renderTimeline(freshShift);
      }
    } else {
      const freshSlot = await db.scheduleSlots.get(fromSlotId);
      if (freshSlot) openSlotDetailModal(freshSlot, fromSlotSrc);
    }
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

function openHoursModal(tab = null) {
  state.hoursFilter = 'all';
  if (tab === 'supervision') {
    state.hoursModalCounter = 'supervision';
  } else if (state.hoursModalCounter == null || state.hoursModalCounter === 'supervision') {
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

function _isoMondayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - (dow - 1));
  return d.toISOString().split('T')[0];
}

function _isoWeekNum(mondayStr) {
  const d = new Date(mondayStr + 'T12:00:00');
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1));
  return Math.round((d - startOfWeek1) / (7 * 86400000)) + 1;
}

function buildWeeklyHistogram(shifts) {
  if (!shifts.length) return '';
  const today = new Date().toISOString().split('T')[0];
  const weekMap = new Map();
  shifts.forEach(sh => {
    const key = _isoMondayKey(sh.date);
    if (!weekMap.has(key)) weekMap.set(key, { hours: 0, hasPast: false, hasFuture: false });
    const entry = weekMap.get(key);
    entry.hours += calcShiftHours(sh);
    if (sh.date <= today) entry.hasPast = true; else entry.hasFuture = true;
  });
  const weeks = [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxH = Math.max(...weeks.map(([, v]) => v.hours), 1);
  const currentWeek = _isoMondayKey(today);
  const bars = weeks.map(([key, { hours, hasPast, hasFuture }]) => {
    const pct = Math.max(Math.round((hours / maxH) * 100), 3);
    const isCurrent = key === currentWeek;
    const isFuture = !hasPast && hasFuture;
    const cls = isCurrent ? 'hh-bar hh-bar-current' : isFuture ? 'hh-bar hh-bar-future' : 'hh-bar';
    const val = hours >= 10 ? `${Math.round(hours)}` : `${hours.toFixed(1)}`;
    return `<div class="hh-col" title="KW${_isoWeekNum(key)} · ${hours.toFixed(1)}h">
      <div class="hh-val">${val}</div>
      <div class="hh-bar-wrap"><div class="${cls}" style="height:${pct}%"></div></div>
      <div class="hh-label">KW${_isoWeekNum(key)}</div>
    </div>`;
  }).join('');
  return `<div class="hours-histogram-title">Wöchentliche Entwicklung</div>
    <div class="hours-histogram-wrap"><div class="hours-histogram">${bars}</div></div>`;
}

function calcCompletionEstimates(targetH, pastItems, getH, getDateStr) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const fmtD     = d => d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtSpd   = hpd => `${(hpd * 7).toFixed(1)} h/Wo`;

  const pastH     = pastItems.reduce((s, it) => s + getH(it), 0);
  const remaining = targetH - pastH;

  if (remaining <= 0) return {
    overallEst: '🎉 Erreicht', overallSpeed: '',
    monthEst:   '🎉 Erreicht', monthSpeed:   '',
  };
  if (!pastItems.length) return {
    overallEst: '–', overallSpeed: '',
    monthEst:   '–', monthSpeed:   '',
  };

  // 1) Seit erstem Dienst: pastH / Tage seit erstem Dienst = h/Tag
  let overallEst = '–', overallSpeed = '';
  const sorted  = [...pastItems].sort((a, b) => getDateStr(a).localeCompare(getDateStr(b)));
  const firstD  = new Date(getDateStr(sorted[0]) + 'T12:00:00');
  const daysEl  = Math.max(1, (today - firstD) / 86400000);
  const hPerDay = pastH / daysEl;
  if (hPerDay > 0) {
    overallSpeed = fmtSpd(hPerDay);
    overallEst   = fmtD(new Date(today.getTime() + (remaining / hPerDay) * 86400000));
  }

  // 2) Letzte 4 Wochen: Stunden in letzten 28 Tagen / 28 Tage = h/Tag
  let monthEst = '–', monthSpeed = '';
  const cutoff      = new Date(today.getTime() - 28 * 86400000).toISOString().slice(0, 10);
  const recentItems = pastItems.filter(it => getDateStr(it) >= cutoff && getDateStr(it) <= todayStr);
  if (recentItems.length) {
    const recentH    = recentItems.reduce((s, it) => s + getH(it), 0);
    const hPerDay28  = recentH / 28;
    if (hPerDay28 > 0) {
      monthSpeed = fmtSpd(hPerDay28);
      monthEst   = fmtD(new Date(today.getTime() + (remaining / hPerDay28) * 86400000));
    }
  }

  return { overallEst, overallSpeed, monthEst, monthSpeed };
}

function buildSupervisionHistogram(logs) {
  if (!logs.length) return '';
  const monthMap = new Map();
  logs.forEach(l => {
    const key = l.date.slice(0, 7); // YYYY-MM
    if (!monthMap.has(key)) monthMap.set(key, 0);
    monthMap.set(key, monthMap.get(key) + (l.duration || 0));
  });
  const months = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxH = Math.max(...months.map(([, h]) => h), 1);
  const today = new Date().toISOString().slice(0, 7);
  const bars = months.map(([key, hours]) => {
    const pct = Math.max(Math.round((hours / maxH) * 100), 4);
    const isCurrent = key === today;
    const cls = isCurrent ? 'hh-bar hh-bar-current' : 'hh-bar';
    const [yr, mo] = key.split('-');
    const label = new Date(`${key}-15`).toLocaleDateString('de-AT', { month: 'short' }) + ` '${yr.slice(2)}`;
    return `<div class="hh-col" title="${label} · ${hours}h">
      <div class="hh-val">${hours}h</div>
      <div class="hh-bar-wrap"><div class="${cls}" style="height:${pct}%"></div></div>
      <div class="hh-label">${label}</div>
    </div>`;
  }).join('');
  return `<div class="hours-histogram-title">Monatliche Entwicklung</div>
    <div class="hours-histogram-wrap"><div class="hours-histogram">${bars}</div></div>`;
}

function renderHoursModalBody() {
  const body     = document.getElementById('hours-modal-body');
  const counters = state.profile?.hourCounters || [];
  const isSup    = state.hoursModalCounter === 'supervision';

  // Always show tab bar (counters + supervision)
  const counterTabs = `
    <div class="hours-counter-tabs">
      ${counters.map(c => `<button class="hct-btn${c.id === state.hoursModalCounter && !isSup ? ' active' : ''}" data-cid="${c.id}">${c.name}</button>`).join('')}
      <button class="hct-btn${isSup ? ' active' : ''}" data-cid="supervision">Supervision</button>
    </div>`;

  if (isSup) {
    const logs      = state.supLogs || [];
    const hours     = state.supHours ?? logs.reduce((s, l) => s + (l.duration || 0), 0);
    const target    = state.profile?.supervisionTarget ?? 30;
    const pct       = Math.min(100, Math.round((hours / target) * 100));
    const todayStr  = new Date().toISOString().slice(0, 10);
    const pastLogs  = logs.filter(l => l.date <= todayStr);
    const { overallEst, overallSpeed, monthEst, monthSpeed } = calcCompletionEstimates(
      target, pastLogs, l => l.duration || 0, l => l.date
    );

    // Donut by supervisor
    const supMap = {};
    logs.forEach(l => {
      const k = l.supervisor || '(ohne)';
      supMap[k] = (supMap[k] || 0) + (l.duration || 0);
    });
    const supColors = ['#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#6366f1'];
    const supEntries = Object.entries(supMap);
    const donutSegs = hours > 0 ? supEntries.map(([, h], i) => ({
      pct: (h / hours) * 100, color: supColors[i % supColors.length]
    })) : [];

    const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'2-digit' });

    body.innerHTML = `
      ${counterTabs}
      <div class="hours-summary">
        <div class="hours-donut">${donutSegs.length ? buildDonut(donutSegs) : '<div class="donut-empty">–</div>'}</div>
        <div class="hours-summary-info">
          <div class="hours-total">${hours}h <span style="font-size:14px;color:var(--text-dim)">/ ${target}h</span></div>
          <div class="hours-label">Supervision · ${pct}% erledigt</div>
          <div class="hours-type-legend" style="margin-top:6px">
            ${supEntries.map(([sup, h], i) =>
              `<span style="color:${supColors[i % supColors.length]}">${sup}: ${h}h</span>`
            ).join('')}
          </div>
        </div>
      </div>
      <div class="completion-estimates">
        <div class="ce-title">Prognose bis ${target}h</div>
        <div class="ce-row"><span class="ce-label">Ø seit Start</span><span class="ce-speed">${overallSpeed}</span><span class="ce-date">${overallEst}</span></div>
        <div class="ce-row"><span class="ce-label">Ø letzte 4 Wochen</span><span class="ce-speed">${monthSpeed}</span><span class="ce-date">${monthEst}</span></div>
      </div>
      ${buildSupervisionHistogram(logs)}
      <div class="hours-list">
        ${logs.length ? [...logs].sort((a,b)=>b.date.localeCompare(a.date)).map(l => `
          <div class="hours-row">
            <div class="hours-row-icon">🎓</div>
            <div class="hours-row-info">
              <div class="hours-row-date">${fmtD(l.date)}</div>
              <div class="hours-row-meta">${l.supervisor ? l.supervisor : 'Supervision'}</div>
            </div>
            <div class="hours-row-val">${l.duration}h</div>
          </div>`).join('')
        : '<div class="empty-state">Noch keine Supervisionen eingetragen.</div>'}
      </div>`;

    body.querySelectorAll('.hct-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        if (btn.dataset.cid === 'supervision') {
          state.hoursModalCounter = 'supervision';
        } else {
          state.hoursModalCounter = parseInt(btn.dataset.cid);
          state.hoursFilter = 'all';
        }
        renderHoursModalBody();
      }));
    return;
  }

  // ── Hours tab ──
  const counter  = counters.find(c => c.id === state.hoursModalCounter) || counters[0];
  const baseShifts = counter?.fromDate
    ? state.shifts.filter(s => s.date >= counter.fromDate)
    : state.shifts;
  const all      = baseShifts;
  const filtered = state.hoursFilter === 'all' ? all : all.filter(s => s.type === state.hoursFilter);
  const totalH   = counter ? calcCounterHours(counter) : calcTotalHours();
  const targetH  = counter?.targetHours || 480;
  const extra    = getExtraHoursTotal();
  const pct      = Math.min(100, Math.round((totalH / targetH) * 100));

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

  const todayStr = new Date().toISOString().slice(0, 10);
  const pastShifts = all.filter(s => s.date <= todayStr);
  const { overallEst, overallSpeed, monthEst, monthSpeed } = calcCompletionEstimates(
    targetH, pastShifts, sh => calcShiftHours(sh), sh => sh.date
  );

  // "Mit geplanten" indicator: include future planned shifts
  const futureShifts = all.filter(s => s.date > todayStr);
  const plannedH = futureShifts.reduce((sum, s) => sum + calcShiftHours(s), 0);
  const withPlannedH = totalH + plannedH;
  let withPlannedHtml = '';
  if (plannedH > 0) {
    if (withPlannedH >= targetH) {
      const allSorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
      let cumH = 0;
      let reachDate = null;
      for (const sh of allSorted) {
        cumH += calcShiftHours(sh);
        if (cumH >= targetH) { reachDate = sh.date; break; }
      }
      withPlannedHtml = `<div class="hours-planned" style="font-size:12px;color:var(--text-dim);margin-top:4px">Prognose mit Geplanten: ${reachDate ? fmtD(reachDate) : '–'}</div>`;
    } else {
      const withPct = Math.round((withPlannedH / targetH) * 100);
      withPlannedHtml = `<div class="hours-planned" style="font-size:12px;color:var(--text-dim);margin-top:4px">Mit Geplanten: ${withPlannedH.toFixed(1)}h (${withPct}%)</div>`;
    }
  }

  body.innerHTML = `
    ${counterTabs}
    <div class="hours-summary">
      <div class="hours-donut">${donutSegments.length ? buildDonut(donutSegments) : '<div class="donut-empty">–</div>'}</div>
      <div class="hours-summary-info">
        <div class="hours-total">${totalH.toFixed(1).replace('.0','')}h <span style="font-size:14px;color:var(--text-dim)">/ ${targetH}h</span></div>
        <div class="hours-label">${counter?.name || 'Gesamt'} · ${pct}% erledigt</div>
        ${withPlannedHtml}
        <div class="hours-range">${fmtD(fromDate)} – ${fmtD(toDate)}</div>
        <div class="hours-type-legend">
          ${nFr ? `<span style="color:#3b82f6">🌅 ${nFr}×</span>` : ''}
          ${nSp ? `<span style="color:#8b5cf6">🌇 ${nSp}×</span>` : ''}
          ${nFu ? `<span style="color:#f59e0b">☀️ ${nFu}×</span>` : ''}
          ${nSa ? `<span style="color:#10b981">🗓️ ${nSa}×</span>` : ''}
          ${nSc ? `<span style="color:#6366f1">📚 ${nSc}×</span>` : ''}
          ${extra > 0 ? `<span style="color:var(--text-dim)">+${extra.toFixed(1).replace('.0','')}h Extra</span>` : ''}
        </div>
        ${(() => {
          const catGroups = {};
          all.forEach(s => { const cat = s.category || 'regulär'; catGroups[cat] = (catGroups[cat] || 0) + 1; });
          const cats = Object.entries(catGroups);
          if (cats.length <= 1) return '';
          return `<div class="hours-type-legend" style="margin-top:4px">${cats.map(([cat, cnt]) => {
            const meta = CATEGORY_META[cat] || { label: cat, icon: '💼', color: '#3b82f6' };
            return `<span style="color:${meta.color}">${meta.icon} ${meta.label}: ${cnt}×</span>`;
          }).join(' ')}</div>`;
        })()}
      </div>
    </div>
    <div class="completion-estimates">
      <div class="ce-title">Prognose bis ${targetH}h</div>
      <div class="ce-row"><span class="ce-label">Ø seit Start</span><span class="ce-speed">${overallSpeed}</span><span class="ce-date">${overallEst}</span></div>
      <div class="ce-row"><span class="ce-label">Ø letzte 4 Wochen</span><span class="ce-speed">${monthSpeed}</span><span class="ce-date">${monthEst}</span></div>
    </div>
    <div class="hours-filter-row">
      <button class="hours-filter-btn${state.hoursFilter==='all'?' active':''}" data-filter="all">Alle (${all.length})</button>
      ${nFr ? `<button class="hours-filter-btn${state.hoursFilter==='früh'?' active':''}" data-filter="früh">🌅 Früh</button>` : ''}
      ${nSp ? `<button class="hours-filter-btn${state.hoursFilter==='spät'?' active':''}" data-filter="spät">🌇 Spät</button>` : ''}
      ${nFu ? `<button class="hours-filter-btn${state.hoursFilter==='full'?' active':''}" data-filter="full">☀️ Ganztags</button>` : ''}
      ${nSa ? `<button class="hours-filter-btn${state.hoursFilter==='samstag'?' active':''}" data-filter="samstag">🗓️ Samstag</button>` : ''}
    </div>
    ${buildWeeklyHistogram(all)}
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
    btn.addEventListener('click', () => {
      if (btn.dataset.cid === 'supervision') {
        state.hoursModalCounter = 'supervision';
      } else {
        state.hoursModalCounter = parseInt(btn.dataset.cid);
        state.hoursFilter = 'all';
      }
      renderHoursModalBody();
    }));
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
    body.innerHTML = '<div class="empty-state"><img src="./assets/images/empty/empty_diagnoses.png" class="empty-state-img" alt=""><div>Noch keine Diagnosen gefangen.</div></div>';
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

function renderDiagInfoBody(code, catchId) {
  const diag = state.icdFlat.find(d => d.code === code);
  if (!diag) return;
  state.diagInfoCurrentCode = code;
  const isCaught = new Set(state.catches.map(c => c.code)).has(code);
  const base     = 20 * diag.seltenheit_score;
  const catchRecord = catchId
    ? state.catches.find(c => c.id === catchId)
    : state.catches.find(c => c.code === code);
  const savedChecked = catchRecord?.checkedSymptoms || [];
  const interactive = !!catchId;
  const kind = interactive ? 'catch' : 'view';
  const pflicht  = diag.diagnose_kriterien?.pflicht_symptome || [];
  const optional = diag.diagnose_kriterien?.optionale_symptome || [];
  document.getElementById('diag-info-title').textContent = diag.code;
  const body = document.getElementById('diag-info-body');
  body.scrollTop = 0;
  body.innerHTML = `
    <div class="diag-img-hero">
      <img src="assets/images/diagnoses/${diag.code.toLowerCase()}.png" class="diag-img-hero-img" alt=""
           onerror="this.closest('.diag-img-hero').style.display='none'">
    </div>
    <div class="diag-body-content">
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
        <ul class="symptom-list">${renderSymptomCheckboxes(pflicht, kind, savedChecked, 'symptom-pflicht')}</ul>
      </div>
      <div class="diag-detail-section">
        <div class="diag-detail-label diag-label-optional">💡 Optionale Symptome</div>
        <ul class="symptom-list">${renderSymptomCheckboxes(optional, kind, savedChecked, 'symptom-optional')}</ul>
      </div>
      <div class="diag-detail-section">
        <div class="diag-detail-label">Häufige Komorbiditäten</div>
        <div class="komorbid-chips" id="diag-info-komorbid">${renderLinkedChips(diag.komorbiditaeten, code)}</div>
      </div>
      <div class="diag-detail-section">
        <div class="diag-detail-label">Differentialdiagnose</div>
        <div class="komorbid-chips" id="diag-info-diff">${renderLinkedChips(diag.differentialdiagnose, code)}</div>
      </div>
      ${!isCaught ? `<button class="btn-catch" id="diag-info-catch-btn">🎯 Jetzt fangen!</button>` : ''}
    </div>`;
  // Hero parallax: translate + blur + fade as user scrolls
  if (body._heroScroll) body.removeEventListener('scroll', body._heroScroll);
  const heroEl  = body.querySelector('.diag-img-hero');
  const heroImg = body.querySelector('.diag-img-hero-img');
  if (heroImg && heroEl) {
    body._heroScroll = () => {
      const s = body.scrollTop;
      const h = heroEl.offsetHeight || 220;
      const p = Math.min(1, s / (h * 0.75));
      heroImg.style.transform = `translateY(${s * 0.38}px) scale(${1 + p * 0.06})`;
      heroImg.style.opacity   = String(Math.max(0, 1 - p * 1.1));
      heroImg.style.filter    = `blur(${Math.min(14, p * 18)}px)`;
    };
    body.addEventListener('scroll', body._heroScroll, { passive: true });
    heroImg.addEventListener('click', () => openDiagLightbox(heroImg.src));
  }
  initSymptomCounters(body, interactive);
  if (interactive && catchRecord) {
    const saveSymptoms = async () => {
      const checked = [...body.querySelectorAll('.sym-cb:checked')].map(cb => cb.dataset.key);
      await db.caughtDiagnoses.update(catchRecord.id, { checkedSymptoms: checked });
      catchRecord.checkedSymptoms = checked;
    };
    body.querySelectorAll('.sym-cb').forEach(cb => cb.addEventListener('change', saveSymptoms));
  }
  document.getElementById('diag-info-back-btn')?.addEventListener('click', () => {
    const prev = state.diagInfoStack.pop();
    if (prev) renderDiagInfoBody(prev);
  });
  body.querySelectorAll('.linked-chip').forEach(btn =>
    btn.addEventListener('click', () => navigateDiagInfoTo(btn.dataset.code)));
  document.getElementById('diag-info-catch-btn')?.addEventListener('click', () => {
    closeDiagInfoModal(); openStandaloneCatch(diag);
  });
}

function navigateDiagInfoTo(code) {
  if (state.diagInfoCurrentCode) state.diagInfoStack.push(state.diagInfoCurrentCode);
  renderDiagInfoBody(code);
}

function openDiagInfoModal(code, catchId) {
  state.diagInfoStack = [];
  state.diagInfoCurrentCode = null;
  renderDiagInfoBody(code, catchId);
  document.getElementById('diag-info-modal').classList.remove('hidden');
}

function openDiagLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'diag-lightbox';
  lb.innerHTML = `<img src="${src}" class="diag-lightbox-img" alt="">`;
  document.body.appendChild(lb);
  lb.addEventListener('click', () => lb.remove());
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
    ${streak.frozen ? `<img src="./assets/images/streak/streak_frozen.png" class="streak-visual-img" alt="">` : ''}
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
  const shifts       = await db.shiftLogs.toArray();
  const catches      = await db.caughtDiagnoses.toArray();
  const missions     = await db.missions.toArray();
  const achievements = await db.unlockedAchievements.toArray();
  const slots        = await db.scheduleSlots.toArray();
  // Export full profile (all fields) so hourCounters / extraHourEntries survive round-trips
  const { id: _pid, ...profileFields } = state.profile ?? {};
  const payload = {
    version:    5,
    exportedAt: new Date().toISOString(),
    profile:    profileFields,
    shifts,
    catches,
    missions,
    achievements,
    slots,
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
    const teamCount = data.shifts.filter(s => (s.colleagues||[]).length > 0).length;
    if (!confirm(
      `Alle aktuellen Daten werden ersetzt.\n\n` +
      `${data.shifts.length} Dienste (${teamCount} mit Team), ${data.catches.length} Diagnosen, ` +
      `${slotCount} Planer-Einträge, ${achCount} Achievements, ${msnCount} Missionen.\n\n` +
      `Version: ${data.version} · Erstellt: ${data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('de-AT') : '?'}\n\nFortfahren?`
    )) return;

    // Use a single transaction for atomicity
    await db.transaction('rw',
      db.profile, db.shiftLogs, db.caughtDiagnoses, db.missions,
      db.unlockedAchievements, db.scheduleSlots,
      async () => {
        await db.profile.clear();
        await db.shiftLogs.clear();
        await db.caughtDiagnoses.clear();
        await db.missions.clear();
        await db.unlockedAchievements.clear();
        await db.scheduleSlots.clear();

        // Restore full profile (v5 has all fields; v4 and below only had totalXP)
        const profileToStore = {
          totalXP:          data.profile?.totalXP ?? 0,
          hourCounters:     data.profile?.hourCounters     ?? null,
          extraHourEntries: data.profile?.extraHourEntries ?? null,
          extraHours:       data.profile?.extraHours       ?? 0,
          createdAt:        data.profile?.createdAt        ?? new Date().toISOString(),
        };
        await db.profile.add(profileToStore);

        if (data.version >= 4) {
          // v4/v5: records carry original IDs — put() restores FK integrity
          for (const s  of data.shifts)       await db.shiftLogs.put(s);
          for (const c  of data.catches)      await db.caughtDiagnoses.put(c);
          for (const m  of data.missions)     await db.missions.put(m);
          for (const a  of data.achievements) await db.unlockedAchievements.put(a);
          for (const sl of data.slots)        await db.scheduleSlots.put(sl);
        } else {
          // v3 legacy: IDs were stripped — assign positional IDs to preserve FK links
          for (let i = 0; i < data.shifts.length; i++)
            await db.shiftLogs.put({ ...data.shifts[i], id: i + 1 });
          if (Array.isArray(data.slots))
            for (let i = 0; i < data.slots.length; i++)
              await db.scheduleSlots.put({ ...data.slots[i], id: i + 1 });
          for (const c of data.catches)      await db.caughtDiagnoses.add(c);
          if (Array.isArray(data.missions))
            for (const m of data.missions)   await db.missions.add(m);
          if (Array.isArray(data.achievements))
            for (const a of data.achievements) await db.unlockedAchievements.add(a);
        }
      }
    );

    await loadFromDB();
    renderApp();
    alert(
      `Import erfolgreich ✓\n\n` +
      `${data.shifts.length} Dienste, ${data.catches.length} Diagnosen, ` +
      `${slotCount} Planer-Einträge, ${achCount} Achievements, ${msnCount} Missionen.` +
      (teamCount ? `\n${teamCount} Dienste mit Team-Daten.` : '')
    );
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

  const halbtagToType = { AM: 'früh', PM: 'spät', NM: 'spät', SAT: 'samstag', FULL: 'full' };

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

    const shiftTeam = xmlTypToTeam(typ);
    const colleagues = Array.from(el.querySelectorAll('kollege')).map(k => {
      const funktion = k.getAttribute('funktion') || '';
      const stunden  = k.getAttribute('stunden_danach') ? parseFloat(k.getAttribute('stunden_danach')) : null;
      const pct      = k.getAttribute('pct')            ? parseFloat(k.getAttribute('pct'))            : null;
      return {
        name:     k.getAttribute('name') || '',
        funktion,
        tags:     (k.getAttribute('tags') || '').split(',').map(t => t.trim()).filter(Boolean),
        team:     inferColleagueTeam(funktion) || shiftTeam,
        present:  false,
        ...(stunden !== null && { stunden }),
        ...(pct     !== null && { pct }),
      };
    });

    if (existingKeys.has(key)) {
      // Always merge latest XML colleague data (funktion, tags, stunden, pct) into existing shift,
      // preserving the present (check-in) state and keeping any colleagues not in the XML.
      const existing = existingShifts.find(s => s.date === datum && s.type === type);
      if (existing && colleagues.length) {
        const merged = [...(existing.colleagues || [])];
        for (const xmlC of colleagues) {
          const idx = merged.findIndex(ec => ec.name === xmlC.name);
          if (idx >= 0) {
            merged[idx] = { ...merged[idx], ...xmlC, present: merged[idx].present };
          } else {
            merged.push(xmlC);
          }
        }
        await db.shiftLogs.update(existing.id, { colleagues: merged });
      }
      skipped++;
      continue;
    }

    await db.shiftLogs.add({
      date: datum, type, category,
      xpEarned: 0, patientCount: 0,
      plannerShift: true, plannerActive: false,
      importedFrom: 'xml',
      colleagues,
      createdAt: new Date().toISOString()
    });
    existingKeys.add(key);
    imported++;
  }

  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  renderHomeTab();
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

async function openXPBreakdownModal() {
  // Compute XP breakdown from current state
  const catchXP = state.catches.reduce((s, c) => s + (c.xpEarned || 0), 0);
  const achXP = (state.unlockedAchievements || []).reduce((s, a) => {
    const def = ACHIEVEMENTS.find(x => x.id === a.badgeId);
    if (def) return s + (def.tiers[a.tier - 1]?.xp ?? 0);
    const sec = SECRET_ACHIEVEMENTS.find(x => x.id === a.badgeId);
    return s + (sec?.xp ?? 0);
  }, 0);
  const missionXP = (state.missions || []).filter(m => m.completedAt).reduce((s, m) => {
    const def = MISSION_POOL.find(x => x.id === m.missionId);
    return s + (def?.reward ?? 0);
  }, 0);
  const noteXP = state.shifts.filter(sh => sh.noteAddedAt).reduce((s, sh) =>
    s + calculateNoteXP(sh.date, sh.noteAddedAt), 0);
  const shiftBaseXP = state.shifts.reduce((s, sh) => {
    if (sh.plannerActive && !sh.baseXPAwarded) return s; // not yet earned
    const base = sh.plannerShift
      ? Math.round(_baseShiftXP(sh.type) * (CATEGORY_XP_MODIFIER[sh.category || 'regulär'] ?? 1))
      : _baseShiftXP(sh.type);
    const refDate = sh.plannerShift ? (sh.closedAt || sh.createdAt) : (sh.createdAt || sh.date);
    const flame = ((new Date(refDate) - new Date(sh.date)) / 3600000) <= 24 ? 25 : 0;
    return s + base + flame;
  }, 0);
  const total = state.profile?.totalXP ?? 0;

  document.getElementById('xp-info-body').innerHTML = `
    <div class="xp-breakdown-title">Gesamt: ${total.toLocaleString('de-AT')} XP</div>
    ${[
      ['⏱ Dienst-Basis', shiftBaseXP],
      ['🔬 Diagnosen', catchXP],
      ['🏅 Achievements', achXP],
      ['🎯 Missionen', missionXP],
      ['📝 Dienst-Logs', noteXP],
    ].map(([label, xp]) => `
      <div class="xp-info-row">
        <span>${label}</span>
        <span class="xp-info-val">+${xp.toLocaleString('de-AT')} XP</span>
      </div>`).join('')}
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1)">
      <button id="btn-recalc-xp-modal" class="btn-secondary" style="width:100%;padding:10px;font-size:13px">
        🔄 XP neu berechnen
      </button>
    </div>`;
  document.getElementById('xp-info-modal').classList.remove('hidden');
  document.getElementById('btn-recalc-xp-modal')?.addEventListener('click', async () => {
    closeXPInfoModal();
    await recalculateXP();
  });
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
      const baseIsEarned = shift.baseXPAwarded || !shift.plannerActive;
      const base  = baseIsEarned ? Math.round(calculateShiftXP(shift.type) * modifier) : 0;
      const closedRef = new Date(shift.closedAt || shift.createdAt || shift.date);
      const flame = (!shift.plannerActive && !shift.baseXPAwarded && (closedRef - new Date(shift.date)) / 3600000 <= 24) ? 25 : 0;
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
    (counters.length < 2 ? `<button id="btn-add-counter" class="io-btn" style="width:100%;margin-top:8px">+ Zweiten Zähler</button>` : '');

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
    <button id="btn-add-extra" class="io-btn" style="width:100%;margin-top:8px">+ Extra-Stunden</button>`;

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
  if (state.currentTab === 'stats') renderDashboard();
}

async function deleteExtraHourEntry(entryId) {
  const entries = (state.profile.extraHourEntries || []).filter(e => e.id !== entryId);
  await db.profile.update(state.profile.id, { extraHourEntries: entries });
  state.profile.extraHourEntries = entries;
  renderExtraHoursSettings();
  if (state.currentTab === 'stats') renderDashboard();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function setupSettingsInputs() {
  // counter settings are wired in renderHourCountersSettings
  const nameInput = document.getElementById('setting-user-name');
  if (nameInput) {
    nameInput.value = localStorage.getItem('psychodex-user-name') || '';
    nameInput.addEventListener('change', e => {
      localStorage.setItem('psychodex-user-name', e.target.value.trim());
    });
  }
}

// ─── Shift Extension ──────────────────────────────────────────────────────────
async function setShiftExtension(shiftId, newMinutes) {
  await db.shiftLogs.update(shiftId, { extensionMinutes: newMinutes, updatedAt: new Date().toISOString() });
  state.shifts = await db.shiftLogs.orderBy('date').reverse().toArray();
  const shift  = state.shifts.find(s => s.id === shiftId);
  if (shift) renderShiftDetailBody(shift);
  if (state.currentTab === 'stats') renderDashboard();
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
