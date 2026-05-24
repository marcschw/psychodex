export const RANKS = [
  { level: 1,  title: 'Novus',    subtitle: 'des Zuhörens',      xpRequired: 0 },
  { level: 2,  title: 'Novus',    subtitle: 'der Wahrnehmung',   xpRequired: 1200 },
  { level: 3,  title: 'Novus',    subtitle: 'der Resonanz',      xpRequired: 4500 },
  { level: 4,  title: 'Lector',   subtitle: 'der Worte',         xpRequired: 9000 },
  { level: 5,  title: 'Lector',   subtitle: 'der Zeichen',       xpRequired: 14000 },
  { level: 6,  title: 'Lector',   subtitle: 'der Fragmente',     xpRequired: 19500 },
  { level: 7,  title: 'Scholar',  subtitle: 'der Phänomene',     xpRequired: 25500 },
  { level: 8,  title: 'Scholar',  subtitle: 'der Muster',        xpRequired: 32000 },
  { level: 9,  title: 'Scholar',  subtitle: 'der Struktur',      xpRequired: 38500 },
  { level: 10, title: 'Initiatus',subtitle: 'der Schwelle',      xpRequired: 45500 },
  { level: 11, title: 'Initiatus',subtitle: 'des Verborgenen',   xpRequired: 52500 },
  { level: 12, title: 'Initiatus',subtitle: 'der Tiefe',         xpRequired: 58500 },
  { level: 13, title: 'Adeptus',  subtitle: 'des Logos',         xpRequired: 63000 },
  { level: 14, title: 'Adeptus',  subtitle: 'des Geistes',       xpRequired: 68000 },
  { level: 15, title: 'Adeptus',  subtitle: 'der Erkenntnis',    xpRequired: 75000 },
  { level: 16, title: 'Magister', subtitle: 'der Synthese',      xpRequired: 83000 },
  { level: 17, title: 'Magister', subtitle: 'der Klarheit',      xpRequired: 91000 },
  { level: 18, title: 'Magister', subtitle: 'der Seele',         xpRequired: 99000 },
];

export function getRankForXP(xp) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (xp >= r.xpRequired) rank = r;
    else break;
  }
  return rank;
}

export function getNextRank(currentLevel) {
  return RANKS.find(r => r.level === currentLevel + 1) || null;
}
