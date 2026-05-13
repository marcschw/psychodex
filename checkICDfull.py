import json
import os

# 1. Definierte Liste der ICD-Codes, die für eine Erwachsenenambulanz wichtig sind
# (Dies ist eine beispielhafte Master-Liste. Du kannst sie nach Bedarf erweitern.)
MASTER_LIST = {
    "F00": "Demenz bei Alzheimer", "F01": "Vaskuläre Demenz", "F04": "Amnestisches Syndrom",
    "F06.3": "Organische affektive Störung", "F07.0": "Organische PS",
    "F10.1": "Schädlicher Alkoholgebrauch", "F10.2": "Alkoholabhängigkeit", 
    "F11.2": "Opioidabhängigkeit", "F12.2": "Cannabisabhängigkeit", 
    "F20.0": "Paranoide Schizophrenie", "F25.0": "Schizoaffektiv",
    "F32.0": "Leichte Depression", "F32.1": "Mittelgradige Depression", "F32.2": "Schwere Depression",
    "F40.0": "Agoraphobie", "F41.0": "Panikstörung", "F41.1": "GAD", "F43.1": "PTBS",
    "F60.3": "Borderline", "F60.6": "Ängstlich-vermeidende PS"
}

def check_missing_codes():
    found_codes = set()
    json_dir = './data/icd/' # Pfad zu deinen JSONs

    # Alle vorhandenen JSONs scannen
    for filename in os.listdir(json_dir):
        if filename.endswith(".json"):
            with open(os.path.join(json_dir, filename), 'r', encoding='utf-8') as f:
                try:
                    data = json.load(f)
                    for entry in data:
                        found_codes.add(entry['code'])
                except Exception as e:
                    print(f"Fehler beim Lesen von {filename}: {e}")

    # Abgleich
    missing = {code: name for code, name in MASTER_LIST.items() if code not in found_codes}
    
    print(f"--- Check abgeschlossen ---")
    print(f"Gefundene Diagnosen: {len(found_codes)}")
    if missing:
        print(f"\nEs fehlen noch folgende Diagnosen aus der Master-Liste:")
        for code, name in missing.items():
            print(f"- {code}: {name}")
    else:
        print("\nAlle Diagnosen aus der Master-Liste sind vorhanden!")

if __name__ == "__main__":
    check_missing_codes()