// ─── Regular Tiered Achievements ─────────────────────────────────────────────
export const ACHIEVEMENTS = [
  {
    id: 'nachtschwaermer',
    name: 'Nachtschwärmer',
    description: 'Für treue Spätdienste',
    icon: '🌃',
    tiers: [{ tier: 1, xp: 200 }, { tier: 2, xp: 500 }, { tier: 3, xp: 1000 }],
    _check: state => ({
      count: state.shifts.filter(s => s.type === 'spät').length,
      thresholds: [5, 15, 30],
    }),
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: 'Für Ganztagseinsätze (12h)',
    icon: '🏃',
    tiers: [{ tier: 1, xp: 300 }, { tier: 2, xp: 600 }, { tier: 3, xp: 1200 }],
    _check: state => ({
      count: state.shifts.filter(s => s.type === 'full').length,
      thresholds: [3, 10, 20],
    }),
  },
  {
    id: 'komorbid_detektiv',
    name: 'Komorbiditäts-Detektiv',
    description: 'Diagnosen mit Komorbidität',
    icon: '🔍',
    tiers: [{ tier: 1, xp: 200 }, { tier: 2, xp: 500 }, { tier: 3, xp: 1000 }],
    _check: state => ({
      count: state.catches.filter(c => c.hasComorbidity).length,
      thresholds: [5, 20, 50],
    }),
  },
  {
    id: 'das_einhorn',
    name: 'Das Einhorn',
    description: 'Extrem seltene Diagnosen',
    icon: '🦄',
    tiers: [{ tier: 1, xp: 300 }, { tier: 2, xp: 800 }, { tier: 3, xp: 1500 }],
    _check: state => {
      const rareCodes = new Set(
        state.icdFlat.filter(d => d.seltenheit_score >= 8).map(d => d.code)
      );
      return {
        count: new Set(state.catches.filter(c => rareCodes.has(c.code)).map(c => c.code)).size,
        thresholds: [1, 5, 10],
      };
    },
  },
  {
    id: 'der_puenktliche',
    name: 'Der Pünktliche',
    description: 'Dienste zeitnah geloggt',
    icon: '⚡',
    tiers: [{ tier: 1, xp: 150 }, { tier: 2, xp: 400 }, { tier: 3, xp: 800 }],
    _check: state => ({
      count: state.shifts.filter(s =>
        s.createdAt && (new Date(s.createdAt) - new Date(s.date)) <= 86_400_000
      ).length,
      thresholds: [5, 20, 50],
    }),
  },
  {
    id: 'meister_affekte',
    name: 'Meister der Affekte',
    description: 'F3-Diagnosen gesammelt',
    icon: '💙',
    tiers: [{ tier: 1, xp: 200 }, { tier: 2, xp: 500 }, { tier: 3, xp: 1000 }],
    _check: state => {
      const count = new Set(
        state.catches.filter(c => (c.kategorie || '').startsWith('F3')).map(c => c.code)
      ).size;
      const allF3 = (state.icdData?.['F3'] || []).length || 99;
      return { count, thresholds: [5, 15, allF3] };
    },
  },
  {
    id: 'meister_aengste',
    name: 'Meister der Ängste',
    description: 'F4-Diagnosen gesammelt',
    icon: '😰',
    tiers: [{ tier: 1, xp: 200 }, { tier: 2, xp: 500 }, { tier: 3, xp: 1000 }],
    _check: state => ({
      count: new Set(
        state.catches.filter(c => (c.kategorie || '').startsWith('F4')).map(c => c.code)
      ).size,
      thresholds: [5, 15, 30],
    }),
  },
  {
    id: 'der_profiler',
    name: 'Der Profiler',
    description: 'F6-Persönlichkeitsstörungen',
    icon: '🎭',
    tiers: [{ tier: 1, xp: 250 }, { tier: 2, xp: 600 }, { tier: 3, xp: 1200 }],
    _check: state => ({
      count: new Set(
        state.catches.filter(c => (c.kategorie || '').startsWith('F6')).map(c => c.code)
      ).size,
      thresholds: [3, 10, 20],
    }),
  },
  {
    id: 'der_chronist',
    name: 'Der Chronist',
    description: 'Dienste mit Log versehen',
    icon: '📝',
    tiers: [{ tier: 1, xp: 150 }, { tier: 2, xp: 400 }, { tier: 3, xp: 800 }],
    _check: state => ({
      count: state.shifts.filter(s => s.note && s.note.trim().length > 0).length,
      thresholds: [3, 10, 30],
    }),
  },
  {
    id: 'schnellschreiber',
    name: 'Schnellschreiber',
    description: 'Logs binnen 2h nach Dienst',
    icon: '✍️',
    tiers: [{ tier: 1, xp: 200 }, { tier: 2, xp: 500 }, { tier: 3, xp: 1000 }],
    _check: state => ({
      count: state.shifts.filter(s =>
        s.noteAddedAt && (new Date(s.noteAddedAt) - new Date(s.date)) <= 2 * 3_600_000
      ).length,
      thresholds: [3, 10, 25],
    }),
  },
];

// ─── Secret One-Off Achievements ──────────────────────────────────────────────
export const SECRET_ACHIEVEMENTS = [
  // ── Diagnosen ──
  {
    id: 'jackpot',
    name: 'Jackpot',
    description: 'Pathologisches Spielen diagnostiziert',
    icon: '🎰',
    xp: 500,
    _check: state => ({ triggered: state.catches.some(c => c.code === 'F63.0') }),
  },
  {
    id: 'spiegelkabinett',
    name: 'Spiegelkabinett',
    description: 'Dissoziative Identitätsstörung diagnostiziert',
    icon: '🪞',
    xp: 800,
    _check: state => ({ triggered: state.catches.some(c => c.code === 'F44.81') }),
  },
  {
    id: 'fifty_shades',
    name: 'Fifty Shades',
    description: 'Störung der Sexualpräferenz diagnostiziert',
    icon: '🎭',
    xp: 600,
    _check: state => ({ triggered: state.catches.some(c => c.code.startsWith('F65')) }),
  },
  {
    id: 'der_alchemist',
    name: 'Der Alchemist',
    description: 'Multipler Substanzgebrauch diagnostiziert',
    icon: '⚗️',
    xp: 700,
    _check: state => ({ triggered: state.catches.some(c => c.code.startsWith('F19')) }),
  },
  {
    id: 'teufelskreis',
    name: 'Teufelskreis',
    description: 'Schwere Depression + Sucht beim selben Patienten',
    icon: '🌀',
    xp: 800,
    _check: state => {
      const deprCodes = new Set(['F32.2', 'F32.3', 'F33.2', 'F33.3']);
      const byPatient = {};
      state.catches.forEach(c => {
        const key = `${c.shiftId ?? 'x'}:${c.patientIndex ?? 'x'}`;
        if (!byPatient[key]) byPatient[key] = [];
        byPatient[key].push(c.code);
      });
      const triggered = Object.values(byPatient).some(codes =>
        codes.some(c => deprCodes.has(c)) &&
        codes.some(c => /^F1\d/.test(c))
      );
      return { triggered };
    },
  },
  {
    id: 'schlaflos_in_wien',
    name: 'Schlaflos in Wien',
    description: 'Nichtorganische Schlafstörung diagnostiziert',
    icon: '🌙',
    xp: 400,
    _check: state => ({ triggered: state.catches.some(c => c.code.startsWith('F51')) }),
  },
  {
    id: 'das_chamäleon',
    name: 'Das Chamäleon',
    description: 'Artifizielle Störung / Münchhausen diagnostiziert',
    icon: '🦎',
    xp: 1000,
    _check: state => ({ triggered: state.catches.some(c => c.code === 'F68.1') }),
  },
  {
    id: 'hypochonder',
    name: 'Hypochonder',
    description: 'Hypochondrische Störung diagnostiziert',
    icon: '🩺',
    xp: 400,
    _check: state => ({ triggered: state.catches.some(c => c.code === 'F45.2') }),
  },
  // ── Schicht- & Patienten-Kombos ──
  {
    id: 'das_volle_spektrum',
    name: 'Das volle Spektrum',
    description: 'F3, F4 und F6 in einem einzigen Dienst',
    icon: '🌈',
    xp: 1000,
    _check: state => {
      const byShift = {};
      state.catches.forEach(c => {
        if (c.shiftId == null) return;
        if (!byShift[c.shiftId]) byShift[c.shiftId] = new Set();
        byShift[c.shiftId].add((c.kategorie || '').slice(0, 2));
      });
      return {
        triggered: Object.values(byShift).some(kats =>
          kats.has('F3') && kats.has('F4') && kats.has('F6')
        ),
      };
    },
  },
  {
    id: 'doppeltes_lottchen',
    name: 'Doppeltes Lottchen',
    description: 'Zwei verschiedene Patienten, gleicher ICD-Code, ein Dienst',
    icon: '👯',
    xp: 600,
    _check: state => {
      const byShiftCode = {};
      state.catches.forEach(c => {
        if (c.shiftId == null) return;
        const key = `${c.shiftId}:${c.code}`;
        if (!byShiftCode[key]) byShiftCode[key] = new Set();
        byShiftCode[key].add(String(c.patientIndex ?? '?'));
      });
      return { triggered: Object.values(byShiftCode).some(pts => pts.size >= 2) };
    },
  },
  {
    id: 'alte_schule',
    name: 'Alte Schule',
    description: 'Patient 51+ mit F0-Diagnose (Demenz / Organisch)',
    icon: '👴',
    xp: 500,
    _check: state => ({
      triggered: state.catches.some(c =>
        c.ageGroup === '51+' && (c.kategorie || '').startsWith('F0')
      ),
    }),
  },
  {
    id: 'der_knotenpunkt',
    name: 'Der Knotenpunkt',
    description: 'Ein Patient mit 3 oder mehr Komorbiditäten',
    icon: '🕸️',
    xp: 800,
    _check: state => {
      const counts = {};
      state.catches.forEach(c => {
        const key = `${c.shiftId ?? 'x'}:${c.patientIndex ?? 'x'}`;
        counts[key] = (counts[key] || 0) + 1;
      });
      return { triggered: Object.values(counts).some(n => n >= 3) };
    },
  },
  // ── User-Verhalten ──
  {
    id: 'geisterstunde',
    name: 'Geisterstunde',
    description: 'Dienst zwischen 23:00 und 04:00 Uhr gespeichert',
    icon: '👻',
    xp: 500,
    _check: state => ({
      triggered: state.shifts.some(s => {
        if (!s.createdAt) return false;
        const h = new Date(s.createdAt).getHours();
        return h >= 23 || h < 4;
      }),
    }),
  },
  {
    id: 'leere_hallen',
    name: 'Leere Hallen',
    description: 'Dienst ohne einen einzigen Patienten abgeschlossen',
    icon: '🏚️',
    xp: 300,
    _check: state => ({
      triggered: state.shifts.some(s => (s.patientCount || 0) === 0),
    }),
  },
  {
    id: 'workaholic',
    name: 'Workaholic',
    description: 'Vier oder mehr Patienten in einem Dienst',
    icon: '💼',
    xp: 800,
    _check: state => ({
      triggered: state.shifts.some(s => (s.patientCount || 0) >= 4),
    }),
  },
];

export const ACH_TIER_LABELS = { 1: 'Tier I', 2: 'Tier II', 3: 'Tier III' };

// ─── Check Runner ─────────────────────────────────────────────────────────────
// Returns array of newly unlocked { badgeId, tier, xp, name, icon, isSecret }
export async function checkAchievements(state, db) {
  if (!db.unlockedAchievements) return [];
  const earned = new Set(
    (state.unlockedAchievements || []).map(a => `${a.badgeId}:${a.tier}`)
  );
  const newUnlocks = [];

  // Regular tiered achievements
  for (const ach of ACHIEVEMENTS) {
    const { count, thresholds } = ach._check(state);
    for (let i = 0; i < thresholds.length; i++) {
      const tier = i + 1;
      const key  = `${ach.id}:${tier}`;
      if (!earned.has(key) && count >= thresholds[i]) {
        const entry = { badgeId: ach.id, tier, unlockedAt: new Date().toISOString() };
        entry.id = await db.unlockedAchievements.add(entry);
        state.unlockedAchievements.push(entry);
        earned.add(key);
        newUnlocks.push({ badgeId: ach.id, tier, xp: ach.tiers[i].xp, name: ach.name, icon: ach.icon, isSecret: false });
      }
    }
  }

  // Secret one-off achievements
  for (const ach of SECRET_ACHIEVEMENTS) {
    const key = `${ach.id}:1`;
    if (!earned.has(key)) {
      const { triggered } = ach._check(state);
      if (triggered) {
        const entry = { badgeId: ach.id, tier: 1, unlockedAt: new Date().toISOString() };
        entry.id = await db.unlockedAchievements.add(entry);
        state.unlockedAchievements.push(entry);
        earned.add(key);
        newUnlocks.push({ badgeId: ach.id, tier: 1, xp: ach.xp, name: ach.name, icon: ach.icon, isSecret: true });
      }
    }
  }

  return newUnlocks;
}
