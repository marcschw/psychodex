const db = new Dexie('PsychoDexDB');

db.version(1).stores({
  profile: '++id',
  shiftLogs: '++id, date, type',
  caughtDiagnoses: '++id, code, kategorie, shiftId, caughtAt'
});

db.version(2).stores({
  profile: '++id',
  shiftLogs: '++id, date, type',
  caughtDiagnoses: '++id, code, kategorie, shiftId, caughtAt',
  missions: '++id, slotIndex'
});

db.version(3).stores({
  profile: '++id',
  shiftLogs: '++id, date, type',
  caughtDiagnoses: '++id, code, kategorie, shiftId, caughtAt',
  missions: '++id, slotIndex',
  unlockedAchievements: '++id, badgeId, tier, unlockedAt'
});

db.version(4).stores({
  profile: '++id',
  shiftLogs: '++id, date, type',
  caughtDiagnoses: '++id, code, kategorie, shiftId, caughtAt',
  missions: '++id, slotIndex',
  unlockedAchievements: '++id, badgeId, tier, unlockedAt',
  scheduleSlots: '++id, shiftId, type, startHour'
});

db.version(5).stores({
  profile: '++id',
  shiftLogs: '++id, date, type, category',
  caughtDiagnoses: '++id, code, kategorie, shiftId, caughtAt',
  missions: '++id, slotIndex',
  unlockedAchievements: '++id, badgeId, tier, unlockedAt',
  scheduleSlots: '++id, shiftId, type, startHour'
}).upgrade(async tx => {
  // Default any shift without a category to 'training'
  await tx.table('shiftLogs').toCollection().modify(s => {
    if (!s.category) s.category = 'training';
  });
});

db.version(6).stores({
  profile: '++id',
  shiftLogs: '++id, date, type, category',
  caughtDiagnoses: '++id, code, kategorie, shiftId, slotId, caughtAt',
  missions: '++id, slotIndex',
  unlockedAchievements: '++id, badgeId, tier, unlockedAt',
  scheduleSlots: '++id, shiftId, type, startHour'
});

export default db;
