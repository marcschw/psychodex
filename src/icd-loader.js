const ICD_FILES = {
  F0: 'f00.json', F1: 'f10.json', F2: 'f20.json', F3: 'f30.json', F4: 'f40.json',
  F5: 'f50.json', F6: 'f60.json', F7: 'f70.json', F8: 'f80.json', F9: 'f90.json'
};

export async function loadAllICD(state) {
  const entries = await Promise.all(
    Object.entries(ICD_FILES).map(async ([cat, file]) => {
      try {
        const res = await fetch(`data/icd/${file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        data.forEach(d => { d.kategorie = cat; });
        return [cat, data];
      } catch (e) {
        console.warn(`Could not load ICD ${cat}:`, e.message);
        return [cat, []];
      }
    })
  );

  state.icdData = Object.fromEntries(entries);
  state.icdFlat = entries.flatMap(([, data]) => data);
}

export function searchDiagnoses(icdFlat, query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const scored = icdFlat.map(d => {
    const codeMatch = d.code.toLowerCase().startsWith(q) ? 3
      : d.code.toLowerCase().includes(q) ? 2 : 0;
    const nameMatch = d.name.toLowerCase().includes(q) ? 1 : 0;
    const symptomMatch = [
      ...(d.diagnose_kriterien?.pflicht_symptome || []),
      ...(d.diagnose_kriterien?.optionale_symptome || [])
    ].some(s => s.toLowerCase().includes(q)) ? 0.5 : 0;

    return { d, score: codeMatch + nameMatch + symptomMatch };
  });

  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.d)
    .slice(0, 20);
}
