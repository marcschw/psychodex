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

export default db;
