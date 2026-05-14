// ─── Mission Pool ─────────────────────────────────────────────────────────────
export const MISSION_POOL = [

  // ─── Tier 1 – Common ──────────────────────────────────────────────────────
  {
    id: 'c1_catch3',
    tier: 1,
    title: 'Erste Schritte',
    description: 'Fange 3 Diagnosen.',
    condition: { type: 'count_catches', target: 3 },
    reward: 150, minLevel: 1,
  },
  {
    id: 'c2_shifts2',
    tier: 1,
    title: 'Diensttreue',
    description: 'Logge 2 Dienste.',
    condition: { type: 'count_shifts_logged', target: 2 },
    reward: 150, minLevel: 1,
  },
  {
    id: 'c3_f3_x1',
    tier: 1,
    title: 'Affektiver Einstieg',
    description: 'Fange eine Diagnose aus dem F3-Bereich (Affektive Störungen).',
    condition: { type: 'count_in_category', target: 1, param: 'F3' },
    reward: 175, minLevel: 1,
  },
  {
    id: 'c4_f4_x1',
    tier: 1,
    title: 'Angst & Stress',
    description: 'Fange eine Diagnose aus dem F4-Bereich (Neurotische Störungen).',
    condition: { type: 'count_in_category', target: 1, param: 'F4' },
    reward: 175, minLevel: 1,
  },
  {
    id: 'c5_f1_x1',
    tier: 1,
    title: 'Sucht-Protokoll',
    description: 'Fange eine Diagnose aus dem F1-Bereich (Substanzstörungen).',
    condition: { type: 'count_in_category', target: 1, param: 'F1' },
    reward: 175, minLevel: 1,
  },
  {
    id: 'c6_cats2',
    tier: 1,
    title: 'Diagnostische Breite',
    description: 'Fange Diagnosen aus 2 verschiedenen Kategorien.',
    condition: { type: 'count_different_categories', target: 2 },
    reward: 200, minLevel: 1,
  },
  {
    id: 'c7_rare5',
    tier: 1,
    title: 'Ungewöhnlicher Fall',
    description: 'Fange eine Diagnose mit Seltenheit ≥ ★5.',
    condition: { type: 'count_rarity_min', target: 1, param: 5 },
    reward: 200, minLevel: 1,
  },
  {
    id: 'c8_catch5',
    tier: 1,
    title: 'Auf dem Weg',
    description: 'Fange 5 Diagnosen.',
    condition: { type: 'count_catches', target: 5 },
    reward: 200, minLevel: 1,
  },
  // ─── Tier 2 – Rare ────────────────────────────────────────────────────────
  {
    id: 'r1_f3_x3',
    tier: 2,
    title: 'Depressiver Schwerpunkt',
    description: 'Fange 3 Diagnosen aus dem F3-Bereich.',
    condition: { type: 'count_in_category', target: 3, param: 'F3' },
    reward: 400, minLevel: 4,
  },
  {
    id: 'r2_comorbid1',
    tier: 2,
    title: 'Komorbide Entdeckung',
    description: 'Fange eine Diagnose mit Komorbidität (Patient hatte bereits eine Diagnose).',
    condition: { type: 'count_with_comorbidity', target: 1 },
    reward: 350, minLevel: 2,
  },
  {
    id: 'r3_rare7',
    tier: 2,
    title: 'Seltener Fund',
    description: 'Fange eine Diagnose mit Seltenheit ≥ ★7.',
    condition: { type: 'count_rarity_min', target: 1, param: 7 },
    reward: 500, minLevel: 4,
  },
  {
    id: 'r4_cats4',
    tier: 2,
    title: 'Breites Spektrum',
    description: 'Fange Diagnosen aus 4 verschiedenen Kategorien.',
    condition: { type: 'count_different_categories', target: 4 },
    reward: 450, minLevel: 4,
  },
  {
    id: 'r5_shifts5',
    tier: 2,
    title: 'Fünf Dienste',
    description: 'Logge 5 Dienste.',
    condition: { type: 'count_shifts_logged', target: 5 },
    reward: 400, minLevel: 2,
  },
  {
    id: 'r6_comorbid2',
    tier: 2,
    title: 'Komorbiditätsmuster',
    description: 'Fange 2 Diagnosen mit Komorbidität.',
    condition: { type: 'count_with_comorbidity', target: 2 },
    reward: 500, minLevel: 4,
  },
  {
    id: 'r7_f4_x3',
    tier: 2,
    title: 'Angstexpert*in',
    description: 'Fange 3 Diagnosen aus dem F4-Bereich.',
    condition: { type: 'count_in_category', target: 3, param: 'F4' },
    reward: 400, minLevel: 4,
  },
  {
    id: 'r8_catch10',
    tier: 2,
    title: 'Zweistellig',
    description: 'Fange 10 Diagnosen gesamt.',
    condition: { type: 'count_catches', target: 10 },
    reward: 450, minLevel: 4,
  },
  {
    id: 'r9_per_shift2',
    tier: 2,
    title: 'Doppel-Diagnose',
    description: 'Fange 2 Diagnosen in einem einzigen Dienst.',
    condition: { type: 'per_shift_catches', target: 2 },
    reward: 500, minLevel: 4,
  },
  {
    id: 'r10_f5_x1',
    tier: 2,
    title: 'Verhaltensmuster',
    description: 'Fange eine Diagnose aus dem F5-Bereich (Essstörungen & Verhaltenssyndrome).',
    condition: { type: 'count_in_category', target: 1, param: 'F5' },
    reward: 350, minLevel: 3,
  },
  {
    id: 'r11_f6_x1',
    tier: 2,
    title: 'Persönlichkeit',
    description: 'Fange eine Diagnose aus dem F6-Bereich (Persönlichkeitsstörungen).',
    condition: { type: 'count_in_category', target: 1, param: 'F6' },
    reward: 400, minLevel: 4,
  },

  // ─── Tier 3 – Mastery ─────────────────────────────────────────────────────
  {
    id: 'm1_rare9',
    tier: 3,
    title: 'Ultraseltener Fund',
    description: 'Fange eine Diagnose mit Seltenheit ≥ ★9.',
    condition: { type: 'count_rarity_min', target: 1, param: 9 },
    reward: 800, minLevel: 7,
    badge: '🏆 Ultraseltene Entdeckung',
  },
  {
    id: 'm2_f0_comorbid',
    tier: 3,
    title: 'Neuropsychiatrische Tiefe',
    description: 'Fange eine Diagnose aus dem F0-Bereich (Demenz & Organisch) mit Komorbidität.',
    condition: { type: 'count_in_category_comorbid', target: 1, param: 'F0' },
    reward: 800, minLevel: 7,
    badge: '🧠 Neuropsychiatrischer Experte',
  },
  {
    id: 'm3_cats6',
    tier: 3,
    title: 'Taxonomischer Meister',
    description: 'Fange Diagnosen aus 6 verschiedenen Kategorien.',
    condition: { type: 'count_different_categories', target: 6 },
    reward: 750, minLevel: 7,
  },
  {
    id: 'm4_per_shift3',
    tier: 3,
    title: 'Dreifach-Diagnostiker',
    description: 'Fange 3 Diagnosen in einem einzigen Dienst.',
    condition: { type: 'per_shift_catches', target: 3 },
    reward: 900, minLevel: 7,
    badge: '⚡ Dreifach-Diagnostiker',
  },
  {
    id: 'm5_shifts10',
    tier: 3,
    title: 'Zehn Dienste',
    description: 'Logge 10 Dienste.',
    condition: { type: 'count_shifts_logged', target: 10 },
    reward: 750, minLevel: 7,
  },
  {
    id: 'm6_rare7_x2',
    tier: 3,
    title: 'Doppelte Seltenheit',
    description: 'Fange 2 Diagnosen mit Seltenheit ≥ ★7.',
    condition: { type: 'count_rarity_min', target: 2, param: 7 },
    reward: 800, minLevel: 7,
  },
  {
    id: 'm7_f2_x2',
    tier: 3,
    title: 'Psychotische Welt',
    description: 'Fange 2 Diagnosen aus dem F2-Bereich (Schizophrenie & Psychosen).',
    condition: { type: 'count_in_category', target: 2, param: 'F2' },
    reward: 850, minLevel: 7,
  },
  {
    id: 'm8_per_shift_cats2',
    tier: 3,
    title: 'Kategorien-Kombination',
    description: 'Fange in einem Dienst Diagnosen aus 2 verschiedenen Kategorien.',
    condition: { type: 'per_shift_diff_categories', target: 2 },
    reward: 900, minLevel: 7,
  },
  {
    id: 'm9_f6_x2',
    tier: 3,
    title: 'Persönlichkeitsprofi',
    description: 'Fange 2 Diagnosen aus dem F6-Bereich (Persönlichkeitsstörungen).',
    condition: { type: 'count_in_category', target: 2, param: 'F6' },
    reward: 800, minLevel: 10,
  },
  {
    id: 'm10_comorbid3',
    tier: 3,
    title: 'Komorbide Meisterschaft',
    description: 'Fange 3 Diagnosen mit Komorbidität.',
    condition: { type: 'count_with_comorbidity', target: 3 },
    reward: 950, minLevel: 10,
    badge: '🔗 Komorbide Meisterschaft',
  },
];

export const TIER_LABELS = { 1: 'Common', 2: 'Rare', 3: 'Mastery' };

// ─── Progress Calculation ─────────────────────────────────────────────────────
// catchesSince / shiftsSince = DB records filtered to after mission.activatedAt
// icdFlat = full flattened ICD array for rarity lookups
export function calcMissionProgress(missionDef, catchesSince, shiftsSince, icdFlat) {
  const { type, target, param } = missionDef.condition;
  let current = 0;

  switch (type) {
    case 'count_catches':
      current = catchesSince.length;
      break;

    case 'count_shifts_logged':
      current = shiftsSince.length;
      break;

    case 'count_in_category':
      current = catchesSince.filter(c => (c.kategorie || '').startsWith(param)).length;
      break;

    case 'count_rarity_min':
      current = catchesSince.filter(c => {
        const d = icdFlat.find(x => x.code === c.code);
        return d && d.seltenheit_score >= param;
      }).length;
      break;

    case 'count_with_comorbidity':
      current = catchesSince.filter(c => c.hasComorbidity).length;
      break;

    case 'count_different_categories':
      current = new Set(catchesSince.map(c => c.kategorie).filter(Boolean)).size;
      break;

    case 'count_in_category_comorbid':
      current = catchesSince.filter(c =>
        (c.kategorie || '').startsWith(param) && c.hasComorbidity
      ).length;
      break;

    case 'per_shift_catches': {
      const byShift = {};
      catchesSince.filter(c => c.shiftId != null).forEach(c => {
        byShift[c.shiftId] = (byShift[c.shiftId] || 0) + 1;
      });
      const vals = Object.values(byShift);
      current = vals.length > 0 ? Math.max(...vals) : 0;
      break;
    }

    case 'per_shift_diff_categories': {
      const byCats = {};
      catchesSince.filter(c => c.shiftId != null && c.kategorie).forEach(c => {
        if (!byCats[c.shiftId]) byCats[c.shiftId] = new Set();
        byCats[c.shiftId].add(c.kategorie);
      });
      const sizes = Object.values(byCats).map(s => s.size);
      current = sizes.length > 0 ? Math.max(...sizes) : 0;
      break;
    }
  }

  return { current, target, done: current >= target };
}

// ─── Mission Selection ────────────────────────────────────────────────────────
export function pickNewMission(currentLevel, existingMissionIds) {
  const available = MISSION_POOL.filter(m =>
    m.minLevel <= currentLevel && !existingMissionIds.includes(m.id)
  );

  if (!available.length) {
    // All unlocked missions already active – allow repeats (just not duplicates in same slot)
    const fallback = MISSION_POOL.filter(m => m.minLevel <= currentLevel);
    if (!fallback.length) return null;
    return fallback[Math.floor(Math.random() * fallback.length)].id;
  }

  // Tier weights: lean Common early, lean Mastery late
  const t1w = currentLevel <= 6 ? 5 : currentLevel <= 12 ? 2 : 1;
  const t2w = 2;
  const t3w = currentLevel <= 6 ? 0 : currentLevel <= 12 ? 1 : 3;
  const weights = { 1: t1w, 2: t2w, 3: t3w };

  const pool = [];
  available.forEach(m => {
    const w = weights[m.tier] || 1;
    for (let i = 0; i < w; i++) pool.push(m.id);
  });

  return pool[Math.floor(Math.random() * pool.length)];
}
