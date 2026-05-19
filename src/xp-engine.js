export function calculateCatchXP(diagnosis, hasComorbidity, caughtCodes, caughtKategorien) {
  const baseXP = 15 * diagnosis.seltenheit_score;
  let total = baseXP;
  const bonuses = [];

  if (!caughtCodes.has(diagnosis.code)) {
    total += 50;
    bonuses.push({ label: 'Erste Diagnose!', xp: 50 });
  }

  if (hasComorbidity) {
    const comorbidBonus = Math.round(total * 0.2);
    total += comorbidBonus;
    bonuses.push({ label: 'Komorbidität +20%', xp: comorbidBonus });
  }

  return { total, base: baseXP, bonuses };
}

export function calculateShiftXP(shiftType) {
  return shiftType === 'full' ? 120 : 65;
}

export function calculateFlameBonus(shiftDateStr) {
  const shiftDate = new Date(shiftDateStr);
  const now = new Date();
  const hoursSince = (now - shiftDate) / (1000 * 60 * 60);
  return hoursSince <= 24 ? 25 : 0;
}

export function calculateNoteXP(shiftDate, noteAddedAt) {
  const hoursAfterShift = Math.max(0, (new Date(noteAddedAt) - new Date(shiftDate)) / 3_600_000);
  return Math.max(10, Math.round(60 * Math.exp(-hoursAfterShift / 24)));
}

// ─── Planner Constants ────────────────────────────────────────────────────────

export const SLOT_TYPES = {
  anmeldung:     { label:'Anmeldung',    icon:'📋', colorVar:'--slot-anmeldung', xp:35, durationH:1, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  interview:     { label:'Interview',    icon:'🎙️',  colorVar:'--slot-interview', xp:20, durationH:2, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  erstgespraech: { label:'Erstgespräch', icon:'💬',  colorVar:'--slot-erst',     xp:25, durationH:1, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  kassa:         { label:'Kassa',        icon:'💰',  colorVar:'--slot-kassa',    xp:15, durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:true  },
  backoffice:    { label:'Backoffice',   icon:'🖥️',  colorVar:'--slot-back',     xp:8,  durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:false },
  fuenfter:      { label:'5. Stock',     icon:'🏢',  colorVar:'--slot-fuenfter', xp:4,  durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:false },
};

export const SHIFT_HOURS = {
  früh:    { start:[8,0],   end:[14,30] },
  spät:    { start:[13,30], end:[20,0]  },
  samstag: { start:[9,0],   end:[16,0]  },
  full:    { start:[8,0],   end:[20,0]  },
};

export const MEAL_HINTS = {
  früh:    [{ h:10, m:0,  icon:'🥤', label:'Proteinshake' }, { h:12, m:30, icon:'🍽️', label:'Mittagessen' }],
  spät:    [{ h:16, m:0,  icon:'🥤', label:'Proteinshake' }, { h:17, m:0,  icon:'🍽️', label:'Abendessen'  }],
  samstag: [{ h:12, m:30, icon:'🍽️', label:'Mittagessen' }],
  full:    [{ h:10, m:0,  icon:'🥤', label:'Proteinshake' }, { h:12, m:30, icon:'🍽️', label:'Mittagessen' },
            { h:16, m:0,  icon:'🥤', label:'Proteinshake' }, { h:17, m:0,  icon:'🍽️', label:'Abendessen'  }],
};

export const SLOT_TIPS = {
  anmeldung: {
    tips: [
      '📅 Freie Interview-Slots prüfen und dem Patienten anbieten',
      '🪪 Ausweis scannen / kopieren (nicht digital speichern!)',
      '📋 Substanzen-Fragebogen und ggf. Suizid-Fragebogen',
      '🤝 Ggf. Koordination / Einschluss mit Kolleg:innen',
    ],
    docHint: '~45 min Doku danach einplanen (Backoffice oder 5. Stock)',
  },
  interview: {
    tips: [
      '💡 Demo-Möglichkeit ansprechen → schnellerer Termin für Patient',
      '💶 80 € einsammeln BEVOR Erstgespräch-Termin vereinbart wird',
      '📝 Diagnosen nicht vergessen einzutragen!',
    ],
    docHint: null,
  },
  erstgespraech: {
    tips: [
      '🎓 Bei DEMO: Studierende 15 min vorher im EG abholen!',
      '📖 Studierende über Regeln aufklären (Beobachterrolle, kein Handeln)',
      '📝 Diagnosen unbedingt eintragen!',
    ],
    docHint: '~45 min Doku danach einplanen (Backoffice oder 5. Stock)',
  },
  kassa: {
    tips: ['✅ Offene Zahlungen prüfen', '📄 Kurz-Doku möglich bei wenig Unterbrechungen'],
    docHint: null,
  },
  backoffice: {
    tips: ['📑 Ideal für 45 min Dokumentation nach Anmeldung / Erstgespräch', '🔇 Ruhige Zone für Berichte'],
    docHint: null,
  },
  fuenfter: {
    tips: ['☕ Freizeit / Pause – entspann dich!', '📚 Kann für Selbststudium genutzt werden'],
    docHint: null,
  },
};
