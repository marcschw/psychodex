export const MAX_SHIFT_XP = 550;

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
