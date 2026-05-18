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
