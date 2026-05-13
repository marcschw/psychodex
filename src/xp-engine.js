export function calculateCatchXP(diagnosis, hasComorbidity, caughtCodes, caughtKategorien) {
  const baseXP = 20 * diagnosis.seltenheit_score;
  let total = baseXP;
  const bonuses = [];

  if (!caughtKategorien.has(diagnosis.kategorie)) {
    total += 300;
    bonuses.push({ label: `Erste Kategorie ${diagnosis.kategorie}!`, xp: 300 });
  }

  if (!caughtCodes.has(diagnosis.code)) {
    total += 150;
    bonuses.push({ label: 'Erste Diagnose!', xp: 150 });
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
