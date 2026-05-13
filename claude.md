# Projekt: "PsychoDex" (Arbeitstitel) – Gamifizierte Diagnostik & Dienst-Logbuch

## 1. Projektübersicht
Entwicklung einer lokalen Web-App (Mobile First, Dark Mode) für psychotherapeutische Assistenten (Propädeutikum & Fachspezifikum) an der SFU Ambulanz Wien. 
Die App kombiniert ein klinisches Logbuch für Dienste (Früh/Spät/Ganztags) mit einem Gamification-System nach dem "Pokémon-Prinzip" (Sammeln von ICD-10 Diagnosen aus Erstgesprächen). 
Design-Vorbild: "THRIVE" (Dark Mode, elegante Typografie, Heatmaps, Rank-Path, Background-Images).

## 2. Die Realität des Praktikums & Das WoW-XP-System
Die App ist auf die reellen Praktikumszeiten der SFU zugeschnitten (480h Propädeutikum, 400h Fachspezifikum). Ein Dienst hat 6,5h oder 12h, mit max. 2-3 Patienten.
Um den "World of Warcraft"-Sucht-Effekt zu erzeugen, steigt die benötigte XP exponentiell an (Level-Kurve), während die verdiente XP im Lategame sinkt (weil First-Catch-Boni wegfallen).

### A. XP-Generierung (Erfahrungspunkte)
- **Time-Base-XP:** Früh/Spät (6,5h) = 65 XP | Ganztags (12h) = 120 XP.
- **Diagnose-XP (Pokémon-Prinzip):** 
  - Base-Catch: 20 XP * `seltenheit_score` aus dem JSON (1-10).
  - *First Catch Kategorie Bonus:* Erstes Mal eine bestimmte ICD-Kategorie (z.B. F3) = +300 XP (massiver Dopamin-Hit am Anfang!).
  - *First Catch Diagnose Bonus:* Erstes Mal eine spezifische Diagnose (z.B. F32.1) = +150 XP.
  - *Redundanz:* Bereits "gefangene" Diagnosen geben nur noch Base * Seltenheit.
  - *Demografie/Komorbidität:* +20% Bonus auf den Catch für korrekte Komorbiditäts-Verlinkung.

### B. Streaks (Verzeihend, Wochenbasiert)
- Da Dienste nicht täglich stattfinden, nutzen wir **Weekly Streaks**:
  - Streak steigt, wenn in einer Kalenderwoche mind. 1 Dienst geloggt wird.
  - *Flame-Bonus:* Log innerhalb von 24h nach Dienstende = +25 XP.
  - *Forgiving Rule:* Eine Woche ohne Dienst = Streak friert ein (Ice-Icon), statt ihn zu resetten (Motivation bleibt erhalten).

## 3. Die Aufstiegsachse (18 Ränge)
Der Rangtitel ändert sich alle 3 Level, das Fokus-Wort ändert sich bei *jedem* Level-Up. Die Kurve basiert auf der Praktikums-Realität.

**Phase 1: Die Begegnung (Sehr schneller Aufstieg, Hook-Phase)**
- Rang 1: Novus des Zuhörens (0 XP)
- Rang 2: Novus der Wahrnehmung (250 XP / ~1 Dienst)
- Rang 3: Novus der Resonanz (650 XP / ~3 Dienste)

**Phase 2: Die Entschlüsselung (Schneller Aufstieg)**
- Rang 4: Lector der Worte (1.200 XP / ~6 Dienste)
- Rang 5: Lector der Zeichen (1.900 XP)
- Rang 6: Lector der Fragmente (2.800 XP)

**Phase 3: Die Diagnostik (Der Mid-Game Grind beginnt)**
- Rang 7: Scholar der Phänomene (4.000 XP / ~25 Dienste / ~160h)
- Rang 8: Scholar der Muster (5.500 XP)
- Rang 9: Scholar der Struktur (7.200 XP)

**Phase 4: Die Tiefenpsychologie (Ende Propädeutikum ~400-480h)**
- Rang 10: Initiatus der Schwelle (9.200 XP)
- Rang 11: Initiatus des Verborgenen (11.500 XP)
- Rang 12: Initiatus der Tiefe (14.000 XP / ~65 Dienste)

**Phase 5: Die analytische Schärfe (Fachspezifikum-Territorium)**
- Rang 13: Adeptus des Logos (17.000 XP)
- Rang 14: Adeptus des Geistes (20.500 XP)
- Rang 15: Adeptus der Erkenntnis (24.500 XP / ~100 Dienste)

**Phase 6: Die Vollendung (Die Legenden mit >800h)**
- Rang 16: Magister der Synthese (29.000 XP)
- Rang 17: Magister der Klarheit (34.000 XP)
- Rang 18: Magister der Seele (40.000 XP / The Ultimate Goal)

## 4. Datenarchitektur & File Structure
- **Frontend:** HTML/JS/CSS (oder React/Vite)
- **Datenbank:** `IndexedDB` (via Dexie.js) für alle User-Logs, XP und gecatchte Diagnosen (Lokal & DSGVO-konform, keine Patientennamen!).
- **Ordnerstruktur:**
  - `/data/icd/` -> Hier liegen die statischen JSON-Dateien (z.B. `F30.json`, modular zum parallelen Laden).
  - `/assets/images/ranks/` -> Icons für die lateinischen Haupt-Titel.
  - `/assets/images/categories/` -> Atmosphärische Hintergrundbilder für die F-Kategorien (für UI-Cards im Thrive-Style).

## 5. MVP Entwicklungs-Schritte für die KI

**REGEL FÜR CLAUDE:** Wir arbeiten iterativ. Beginne NUR mit Step 1, gib mir den Code und warte auf mein Feedback/Freigabe, bevor du zu Step 2 übergehst.

### Step 1: Datenbasis & IndexedDB Setup
- Implementiere Dexie.js für die User-Datenbank (`profile`, `shiftLogs`, `caughtDiagnoses`).
- Erstelle die Lade-Logik für die `/data/icd/` JSON-Dateien (asynchrones Laden ins RAM für schnelle Live-Suche).

### Step 2: Dienst-Logbuch & Catch-Mechanik (Core Loop)
- Baue die UI: "Neuen Dienst loggen" (Datum, Art des Dienstes).
- Baue die "Patienten-Begegnung": Auswahl Alter/Geschlecht.
- Baue die Live-Suche: Suche in geladenen Diagnosen, Abgleich der Pflicht/Optional-Symptome und Button zum "Catchen".

### Step 3: Gamification Engine (XP & Ranks Math)
- Codiere die `calculateXP()` Funktion, die genau auf der in Abschnitt 2 definierten Logik basiert (Time-XP + Pokémon Catch-Boni).
- Codiere das Mapping der Ränge zu den XP-Schwellen.

### Step 4: UI/UX "Thrive Polish" & Heatmap
- Implementiere das dunkle, elegante CSS (Dark Mode).
- Erstelle das Heatmap-Grid für "Geloggte Dienste" und "Gefundene Kategorien" (wie in GitHub/Thrive).
- Integriere Platzhalter für die Rank-Icons und Backgrounds.

### Step 5: Pokedex & Statistiken
- Übersichtsscreen: "Mein PsychoDex" (Welche Diagnosen fehlen mir? Wie ist meine Verteilung?).
- Implementierung der Wochen-Streak-Logik.

### ⚠️ Wichtige Regel zu Bildern & Assets (Placeholder)
Die finalen Bilder (Rank-Icons und Kategorie-Hintergründe) werden parallel generiert. 
- Verwende im Code **immer relative Pfade** für Bilder (z. B. `assets/images/ranks/novus.png` oder `assets/images/categories/f30.jpg`).
- Programmiere das CSS so, dass es einen eleganten Fallback gibt (z. B. einen dunkelgrauen/schwarzen Gradienten mit einem leichten Border), falls das Bild im Ordner noch nicht existiert (`object-fit: cover`, `background-color: #1c1c1e`). 
- Baue die UI nicht auf echten Bildern auf, sondern nutze CSS-Platzhalter, bis ich die echten Dateien in die Ordner lege. Die App darf nicht crashen, wenn ein Bild fehlt!