export const RANKS = [
  { level: 1,  title: 'Novus',    subtitle: 'des Zuhörens',      xpRequired: 0 },
  { level: 2,  title: 'Novus',    subtitle: 'der Wahrnehmung',   xpRequired: 250 },
  { level: 3,  title: 'Novus',    subtitle: 'der Resonanz',      xpRequired: 650 },
  { level: 4,  title: 'Lector',   subtitle: 'der Worte',         xpRequired: 1200 },
  { level: 5,  title: 'Lector',   subtitle: 'der Zeichen',       xpRequired: 1900 },
  { level: 6,  title: 'Lector',   subtitle: 'der Fragmente',     xpRequired: 2800 },
  { level: 7,  title: 'Scholar',  subtitle: 'der Phänomene',     xpRequired: 4000 },
  { level: 8,  title: 'Scholar',  subtitle: 'der Muster',        xpRequired: 5500 },
  { level: 9,  title: 'Scholar',  subtitle: 'der Struktur',      xpRequired: 7200 },
  { level: 10, title: 'Initiatus',subtitle: 'der Schwelle',      xpRequired: 9200 },
  { level: 11, title: 'Initiatus',subtitle: 'des Verborgenen',   xpRequired: 11500 },
  { level: 12, title: 'Initiatus',subtitle: 'der Tiefe',         xpRequired: 14000 },
  { level: 13, title: 'Adeptus',  subtitle: 'des Logos',         xpRequired: 17000 },
  { level: 14, title: 'Adeptus',  subtitle: 'des Geistes',       xpRequired: 20500 },
  { level: 15, title: 'Adeptus',  subtitle: 'der Erkenntnis',    xpRequired: 24500 },
  { level: 16, title: 'Magister', subtitle: 'der Synthese',      xpRequired: 29000 },
  { level: 17, title: 'Magister', subtitle: 'der Klarheit',      xpRequired: 34000 },
  { level: 18, title: 'Magister', subtitle: 'der Seele',         xpRequired: 40000 },
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
