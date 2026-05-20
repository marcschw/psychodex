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
  if (shiftType === 'schulung') return 40;
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

export const CATEGORY_XP_MODIFIER = {
  training: 0.7,
  regulär:  1.0,
  senior:   1.35,
};

export const CATEGORY_META = {
  training: { label:'Training',  icon:'🎓', color:'#64748b' },
  regulär:  { label:'Regulär',   icon:'💼', color:'#3b82f6' },
  senior:   { label:'Senior',    icon:'⭐', color:'#f59e0b' },
};

export const SLOT_TYPES = {
  anmeldung:     { label:'Anmeldung',    icon:'📋', colorVar:'--slot-anmeldung', xp:35, durationH:1, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  interview:     { label:'Interview',    icon:'🎙️',  colorVar:'--slot-interview', xp:20, durationH:2, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  erstgespraech: { label:'Erstgespräch', icon:'💬',  colorVar:'--slot-erst',     xp:25, durationH:1, durationM:0, fixed:true,  patientContact:true,  halfHour:false },
  kassa:         { label:'Kassa',        icon:'💰',  colorVar:'--slot-kassa',    xp:15, durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:true  },
  backoffice:    { label:'Backoffice',   icon:'🖥️',  colorVar:'--slot-back',     xp:8,  durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:false },
  fuenfter:      { label:'5. Stock',     icon:'🏢',  colorVar:'--slot-fuenfter', xp:4,  durationH:1, durationM:0, fixed:false, patientContact:false, halfHour:false },
};

export const SHIFT_HOURS = {
  früh:     { start:[8,0],   end:[14,30] },
  spät:     { start:[13,30], end:[20,0]  },
  samstag:  { start:[9,0],   end:[16,0]  },
  full:     { start:[8,0],   end:[20,0]  },
  schulung: { start:[10,0],  end:[16,0]  },
};

export const MEAL_HINTS = {
  früh:    [{ h:10, m:0,  icon:'🥤', label:'Proteinshake' }, { h:12, m:30, icon:'🍽️', label:'Mittagessen' }],
  spät:    [{ h:16, m:0,  icon:'🥤', label:'Proteinshake' }, { h:17, m:30, icon:'🍽️', label:'Abendessen'  }],
  samstag: [{ h:12, m:30, icon:'🍽️', label:'Mittagessen' }],
  full:    [{ h:10, m:0,  icon:'🥤', label:'Proteinshake' }, { h:12, m:30, icon:'🍽️', label:'Mittagessen' },
            { h:16, m:0,  icon:'🥤', label:'Proteinshake' }, { h:17, m:30, icon:'🍽️', label:'Abendessen'  }],
};

export const SLOT_TIPS = {
  anmeldung: {
    sections: [
      {
        label: '💬 Gespräch',
        items: [
          'Informationsbroschüre 2× mitgeben (1× zum Behalten, 1× unterschreiben lassen)',
          'Anmeldebogen von Patientin ausfüllen lassen',
          'Einwilligungserklärung unterschreiben + Terminzettel mitgeben',
          '📅 Freie Testungs-Slots prüfen und anbieten',
          '🪪 Ausweis scannen / kopieren (Original für PA – nicht digital speichern!)',
          'Substanzen-Fragebogen + ggf. Suizid-Fragebogen (bei JA-Antworten)',
          'Krisenintervention? → Absprache mit Koordination / Führungskräfte',
        ],
      },
      {
        label: '🖥️ System',
        items: [
          'CORE-OM eingeben + Anamnese im System eingetragen',
          'Anmeldebogen scannen und unter „Anmeldebogen" hochladen',
          'Testungstermin im System einstellen',
        ],
      },
      {
        label: '📁 Akte',
        items: [
          'Akte beschriften (Name, Geburtsdatum, Anmeldedatum)',
          'Post-It mit Testungsdatum und Uhrzeit aufkleben',
          'Akte in Testungslade einsortieren',
        ],
      },
    ],
    docHint: '~45 min Doku danach einplanen (Backoffice oder 5. Stock)',
  },
  interview: {
    sections: [
      {
        label: '💬 Gespräch',
        items: [
          'Mini-DIPS als Interview ausfüllen',
          'BDI kassieren und in Kuvert geben',
          '2× Kopieren (Original für PA, 1× ins Kuvert) + SFU-Stempel',
          'Letzte Seite in Mini-DIPS ausfüllen',
          '💡 Demo-Möglichkeit ansprechen → schnellerer Termin für Patient',
          '💶 80 € einsammeln BEVOR Erstgespräch-Termin vereinbart wird',
        ],
      },
      {
        label: '🖥️ System',
        items: [
          'Therapeutin im System suchen + EG-Termin einstellen (4 Augenpaare)',
          'E-Mail an Therapeutin mit EG-Termin und Uhrzeit (Vorlage verwenden)',
          '📝 Diagnosen eintragen!',
        ],
      },
      {
        label: '📁 Akte',
        items: [
          'Akte beschriften (Testungsinfo)',
          'Post-It mit EG-Termin und Uhrzeit aufkleben',
          'Akte in Erstgesprächslade einsortieren',
        ],
      },
    ],
    docHint: null,
  },
  erstgespraech: {
    sections: [
      {
        label: '💬 Gespräch',
        items: [
          'EG protokollieren (Vorlage oder eigenes Papier mit Clipboard)',
          'Letzte Seite des EG-Protokolls ausfüllen (mit Therapeutin besprechen)',
          '🎓 Bei DEMO: Studierende 15 min vorher im EG abholen!',
          '📖 Studierende über Regeln aufklären (Beobachterrolle, kein Handeln)',
        ],
      },
      {
        label: '🖥️ System',
        items: [
          'Protokoll in System eingeben',
          '📝 Diagnose in System eingeben',
          'Dokument scannen und unter „Erstgesprächsprotokoll" hochladen',
        ],
      },
      {
        label: '📁 Akte',
        items: [
          'Akte beschriften (EG-Infos)',
          'Akt in Therapielade ODER in Kriseninterventionslade (wenn Krisenfall)',
        ],
      },
    ],
    docHint: '~45 min Doku danach einplanen (Backoffice oder 5. Stock)',
  },
  kassa: {
    sections: [
      {
        label: '💡 Tipps',
        items: [
          '✅ Offene Zahlungen prüfen',
          '📄 Kurz-Doku möglich bei wenig Unterbrechungen',
        ],
      },
    ],
    docHint: null,
  },
  backoffice: {
    sections: [
      {
        label: '📑 Doku & Büro',
        items: [
          'Ideal für 45 min Dokumentation nach Anmeldung / Erstgespräch',
          '🔇 Ruhige Zone für Berichte und Schreibarbeit',
        ],
      },
      {
        label: '📦 Archivieren (wenn nötig)',
        items: [
          'OGK-Bogen, Abmeldeformular und Entlassbrief vollständig?',
          'E-Mail an Therapeutin mit Info was fehlt / wo sich Akt befindet',
          'Kontozustand auf 0 € setzen; CORE-OM & WHO5 für Abmeldung eintragen',
          'Akt aus Folien nehmen + alle Klammern entfernen',
          'Alle Dokumente 2× kopieren → Stapel → scannen → unter „ganzer Akt" hochladen → Stapel retour in Akt',
          'Im System archivieren: Reiter „Therapie" → „Patientin archivieren" (Grund + Datum)',
          'Akt in Lade „Archivierte Akten" geben',
        ],
      },
    ],
    docHint: null,
  },
  fuenfter: {
    sections: [
      {
        label: '💡 Tipps',
        items: [
          '☕ Freizeit / Pause – entspann dich!',
          '📚 Kann für Selbststudium oder Vor-/Nachbereitung genutzt werden',
        ],
      },
    ],
    docHint: null,
  },
};
