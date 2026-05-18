export const RANKS = [
  { level: 1,  title: 'Novus',    subtitle: 'des Zuhörens',      xpRequired: 0 },
  { level: 2,  title: 'Novus',    subtitle: 'der Wahrnehmung',   xpRequired: 500 },
  { level: 3,  title: 'Novus',    subtitle: 'der Resonanz',      xpRequired: 1100 },
  { level: 4,  title: 'Lector',   subtitle: 'der Worte',         xpRequired: 1900 },
  { level: 5,  title: 'Lector',   subtitle: 'der Zeichen',       xpRequired: 2900 },
  { level: 6,  title: 'Lector',   subtitle: 'der Fragmente',     xpRequired: 4100 },
  { level: 7,  title: 'Scholar',  subtitle: 'der Phänomene',     xpRequired: 5600 },
  { level: 8,  title: 'Scholar',  subtitle: 'der Muster',        xpRequired: 7400 },
  { level: 9,  title: 'Scholar',  subtitle: 'der Struktur',      xpRequired: 9500 },
  { level: 10, title: 'Initiatus',subtitle: 'der Schwelle',      xpRequired: 12000 },
  { level: 11, title: 'Initiatus',subtitle: 'des Verborgenen',   xpRequired: 14800 },
  { level: 12, title: 'Initiatus',subtitle: 'der Tiefe',         xpRequired: 18000 },
  { level: 13, title: 'Adeptus',  subtitle: 'des Logos',         xpRequired: 21500 },
  { level: 14, title: 'Adeptus',  subtitle: 'des Geistes',       xpRequired: 25500 },
  { level: 15, title: 'Adeptus',  subtitle: 'der Erkenntnis',    xpRequired: 30000 },
  { level: 16, title: 'Magister', subtitle: 'der Synthese',      xpRequired: 35000 },
  { level: 17, title: 'Magister', subtitle: 'der Klarheit',      xpRequired: 40500 },
  { level: 18, title: 'Magister', subtitle: 'der Seele',         xpRequired: 46500 },
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
