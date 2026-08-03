import os
import json

# ==========================================
# MASTER LISTE DER ICD-10 F-DIAGNOSEN
# (Fokus auf Erwachsenenpsychiatrie / Ambulanz)
# ==========================================
MASTER_ICD = {
    # F0: Organisch
    "F00", "F00.0", "F00.1", "F00.2", "F00.9",
    "F01", "F01.0", "F01.1", "F01.2", "F01.3", "F01.8", "F01.9",
    "F02", "F02.0", "F02.1", "F02.2", "F02.3", "F02.4", "F02.8",
    "F03", "F04", "F05", "F05.0", "F05.1", "F05.8", "F05.9",
    "F06", "F06.0", "F06.1", "F06.2", "F06.3", "F06.4", "F06.5", "F06.6", "F06.7", "F06.8", "F06.9",
    "F07", "F07.0", "F07.1", "F07.2", "F07.8", "F07.9", "F09",

    # F1: Substanz (Hier prüfen wir stellvertretend F10, F11, F12, F13, F14, F15, F16, F19)
    # Die KI hat das bei dir super gemacht, wir checken die Hauptkodes:
    "F10.0", "F10.1", "F10.2", "F10.3", "F10.4", "F10.5", "F10.6", "F10.7",
    "F11.0", "F11.1", "F11.2", "F11.3", "F11.4", "F11.5", "F11.6", "F11.7",
    "F12.0", "F12.1", "F12.2", "F12.3", "F12.4", "F12.5", "F12.6", "F12.7",
    "F13.0", "F13.1", "F13.2", "F13.3", "F13.4", "F13.5", "F13.6", "F13.7",
    "F14.0", "F14.1", "F14.2", "F14.3", "F14.4", "F14.5", "F14.6", "F14.7",
    "F15.0", "F15.1", "F15.2", "F15.3", "F15.4", "F15.5", "F15.6", "F15.7",
    "F16.0", "F16.1", "F16.2", "F16.3", "F16.4", "F16.5", "F16.6", "F16.7",
    "F19.0", "F19.1", "F19.2", "F19.3", "F19.4", "F19.5", "F19.6", "F19.7",

    # F2: Schizophrenie & Psychosen
    "F20.0", "F20.1", "F20.2", "F20.3", "F20.4", "F20.5", "F20.6", "F20.8", "F20.9",
    "F21", "F22.0", "F22.8", "F22.9", "F23.0", "F23.1", "F23.2", "F23.3", "F23.8", "F23.9",
    "F24", "F25.0", "F25.1", "F25.2", "F25.8", "F25.9", "F28", "F29",

    # F3: Affektive Störungen (Extrem wichtig!)
    "F30.0", "F30.1", "F30.2", "F30.8", "F30.9",
    "F31.0", "F31.1", "F31.2", "F31.3", "F31.4", "F31.5", "F31.6", "F31.7", "F31.8", "F31.9",
    "F32.0", "F32.1", "F32.2", "F32.3", "F32.8", "F32.9",
    "F33.0", "F33.1", "F33.2", "F33.3", "F33.4", "F33.8", "F33.9",
    "F34.0", "F34.1", "F34.8", "F34.9", "F38.0", "F38.1", "F38.8", "F39",

    # F4: Neurotisch, Belastung, Somatoform
    "F40.0", "F40.1", "F40.2", "F40.8", "F40.9",
    "F41.0", "F41.1", "F41.2", "F41.3", "F41.8", "F41.9",
    "F42.0", "F42.1", "F42.2", "F42.8", "F42.9",
    "F43.0", "F43.1", "F43.2", "F43.8", "F43.9",
    "F44.0", "F44.1", "F44.2", "F44.3", "F44.4", "F44.5", "F44.6", "F44.7", "F44.8", "F44.9",
    "F45.0", "F45.1", "F45.2", "F45.3", "F45.4", "F45.8", "F45.9",
    "F48.0", "F48.1", "F48.8", "F48.9",

    # F5: Verhaltensauffälligkeiten (Essen, Schlaf, Sex)
    "F50.0", "F50.1", "F50.2", "F50.3", "F50.4", "F50.5", "F50.8", "F50.9",
    "F51.0", "F51.1", "F51.2", "F51.3", "F51.4", "F51.5", "F51.8", "F51.9",
    "F52.0", "F52.1", "F52.2", "F52.3", "F52.4", "F52.5", "F52.6", "F52.7", "F52.8", "F52.9",
    "F53.0", "F53.1", "F53.8", "F53.9",
    "F54", "F55", "F59",

    # F6: Persönlichkeitsstörungen
    "F60.0", "F60.1", "F60.2", "F60.3", "F60.4", "F60.5", "F60.6", "F60.7", "F60.8", "F60.9",
    "F61", "F62.0", "F62.1", "F62.8", "F62.9",
    "F63.0", "F63.1", "F63.2", "F63.3", "F63.8", "F63.9",
    "F64.0", "F64.1", "F64.2", "F64.8", "F64.9",
    "F65.0", "F65.1", "F65.2", "F65.3", "F65.4", "F65.5", "F65.6", "F65.8", "F65.9",
    "F66.0", "F66.1", "F66.2", "F66.8", "F66.9",
    "F68.0", "F68.1", "F68.8", "F69",

    # F9: Kinder/Jugend (Nur die wichtigsten, da Erwachsenenambulanz)
    "F90.0", "F90.1", "F90.8", "F90.9",
    "F93.0", "F93.1", "F93.2", "F93.3", "F93.8", "F93.9"
}

def run_check():
    data_dir = "./data/icd/"
    my_codes = set()
    
    # 1. Alle vorhandenen JSON-Dateien einlesen
    print("Scanne JSON Dateien...")
    if not os.path.exists(data_dir):
        print(f"Ordner {data_dir} nicht gefunden!")
        return

    for filename in os.listdir(data_dir):
        if filename.endswith(".json") and filename != "index.json":
            filepath = os.path.join(data_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = json.load(f)
                    for diag in content:
                        if "code" in diag:
                            # Schneidet eventuelle extra Ziffern ab (z.B. F10.240 -> F10.2), 
                            # damit der Abgleich mit der Master-Liste klappt
                            base_code = diag["code"]
                            my_codes.add(base_code)
            except Exception as e:
                print(f"⚠️ Fehler beim Lesen von {filename}: {e}")

    # 2. Vergleichen
    print(f"\n✅ Du hast aktuell {len(my_codes)} Diagnose-Codes in deiner Datenbank.")
    
    missing_codes = sorted(list(MASTER_ICD - my_codes))
    
    # 3. Auswertung drucken
    if len(missing_codes) == 0:
        print("\n🎉 GLÜCKWUNSCH! Du hast alle wichtigen ICD-10 F-Codes in deiner App!")
    else:
        print(f"\n❌ Dir fehlen noch {len(missing_codes)} Diagnosen aus der Master-Liste:")
        
        # Fehlende Codes nach Kategorien gruppieren, damit man sie Claude leichter geben kann
        missing_grouped = {}
        for code in missing_codes:
            cat = code[:3] # z.B. F32
            if cat not in missing_grouped:
                missing_grouped[cat] = []
            missing_grouped[cat].append(code)
            
        for cat, codes in missing_grouped.items():
            print(f"  {cat}: {', '.join(codes)}")
            
    print("\nTIPP: Kopiere die fehlenden Blöcke einfach in Claude und sag: 'Bitte generiere mir noch JSONs für diese fehlenden Codes: ...'")

if __name__ == "__main__":
    run_check()