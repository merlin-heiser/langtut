# Langtut – inhaltliches Recovery-Manifest

Stand: 21. Juli 2026

Dieses Dokument ist **nicht** das ursprüngliche Projekt-README. Es rekonstruiert Aufbau,
Zweck und Funktionsumfang aus verbliebenen VS-Code-Metadaten, einer alten Codex-Sitzung,
Git-Commit-Titeln und Konfigurationsspuren. Es soll als fachliche Grundlage für einen
Neuaufbau dienen.

## Kurzfassung

**Langtut** war sehr wahrscheinlich ein lokal betriebener, KI-gestützter
Slowakisch-Tutor. Das System verband einen strukturierten Lernpfad von **A0 bis B1** mit
LLM-generierten Übungen, Dialogen und Vokabelmaterial. Ergebnisse konnten bewertet,
korrigiert und über **Anki/AnkiConnect** in ein Wiederholungssystem überführt werden.

Die Anwendung bestand aus:

- einer umfangreichen TypeScript/Node-Serveranwendung,
- einer browserbasierten Oberfläche aus HTML, CSS und Vanilla JavaScript,
- YAML-gesteuerten Prompts, Tags und Lernplänen,
- einer Anki-Integration einschließlich Scheduling,
- einer primären OpenAI- und einer optionalen Gemini-Anbindung,
- einem älteren oder parallelen Python-Backend,
- Beispieldaten, Tests und ausführlicher Implementierungsdokumentation.

## Produktzweck

Das Projekt sollte Sprachlernen nicht nur als Sammlung isolierter Karteikarten
abbilden, sondern als zusammenhängenden Tutor-Prozess:

1. Lernsprache, Muttersprache, CEFR-Niveau und Lernziel festlegen.
2. Passende Inhalte aus einem kuratierten Lernplan und einem Tag-System auswählen.
3. Übungen oder Dialoge mittels LLM erzeugen.
4. Antworten bzw. Gespräche beurteilen und Fehler sichtbar korrigieren.
5. neue Vokabeln und Lernkarten aus dem Lernkontext ableiten.
6. Inhalte und Wiederholungsplanung mit Anki synchronisieren.
7. Fortschritt, Aufgaben und nächste Lernziele in einer Weboberfläche steuern.

Der konkret belegte Lernplan hieß `complete_slovak_a0_b1_plan.yaml`; das Projekt war
daher mindestens in dieser Version auf **Slowakisch** spezialisiert. Hinweise auf
`native_language`, CEFR-Platzhalter und konfigurierbare Prompts sprechen zugleich für
eine teilweise sprachunabhängige Architektur.

## Funktionsumfang

### Sicher oder sehr stark belegt

- **Strukturierter Slowakisch-Lehrplan A0–B1:** Ein 667-zeiliger vollständiger
  Lernplan lag unter `content/roadmap/complete_slovak_a0_b1_plan.yaml`.
- **LLM-gestützte Inhaltsgenerierung:** Das Backend erzeugte einen OpenAI-Client und
  unterstützte zusätzlich einen separaten „light“-Provider über Gemini.
- **Prompt-Katalog:** Mindestens zwei umfangreiche YAML-Promptdateien existierten;
  `content/prompts.yaml` hatte 651 und `prompts/prompts.yaml` 450 Zeilen.
- **Vokabel-Workflow:** Die Beispieldateien `vocab-item_a0_no1.json` und
  `vocab-generated_a0_no1.json` belegen Eingabe- und Generierungsergebnisse für
  A0-Vokabelmaterial.
- **Dialog-/Konversationsmodus:** Mehrere `conversation_*.json`-Beispiele mit bis zu
  1.224 Zeilen belegen längere, strukturierte Gesprächsabläufe.
- **Dialogbewertung:** `conversation_judge_61.json` belegt einen separaten
  Bewertungs- oder Judge-Schritt.
- **Korrektur-Darstellung:** `DIFF_MARKUP_SPEC_V1.md` definierte ein eigenes Markup
  für Unterschiede bzw. Korrekturen.
- **Tag- und Inhaltsmodell:** `content/tag_schema.yaml` umfasste 191 Zeilen und diente
  wahrscheinlich der Klassifikation und Auswahl von Lerninhalten.
- **AnkiConnect-Integration:** Standard-URL `http://localhost:8765`, konfigurierbares
  Deck, konfigurierbarer Server und Note-Type `SlovakTutorCard` sind direkt belegt.
- **Anki-Scheduling:** Die letzten benannten Commits lauteten `pre scheduling by anki`
  und `scheduling by anki implemented`.
- **Browser-Oberfläche:** `webapp/index.html`, `webapp/styles.css` und eine 2.536-zeilige
  `webapp/app.js` bildeten eine substanzielle clientseitige Anwendung.
- **Automatisierte Tests:** `server-node/src/__tests__/api.test.ts` ist direkt belegt;
  ein Commit erwähnt zusätzlich „tests, fixes“.
- **Konfigurierbarer Betrieb:** YAML-Konfiguration plus lokale `.env`-Datei;
  Geheimnisse wurden ausschließlich über Umgebungsvariablen referenziert.

### Wahrscheinlich vorhanden

Die folgenden Funktionen sind durch VS-Codes projektspezifische Suchhistorie und
Commit-Texte belegt, ihre genaue Umsetzung ist jedoch verloren:

- Ausspracheübungen (`pronunciation_drills`)
- Minimalpaar-Übungen (`minimal_pairs`)
- leichte Diktate (`dictation_light`)
- Übersetzungs-Karteikarten (`flashcards_translation`)
- Lückentexte (`gap_fill`)
- Verständnisstexte bzw. Leseverstehen (`verstaendnistexte`)
- Grammatik-Meilensteine (`grammar_miles...`)
- Auswahl des nächsten Lernziels (`pickGoalMethod`)
- Hausaufgaben oder Hausaufgabenplanung (`homework`)
- domänen- und tagbasierte Inhaltsauswahl (`domain`, `tags`)
- muttersprachabhängige Erklärungen (`native_language`)
- CEFR-abhängige Prompt-Templates (`{{cefr}}`)
- schnelle oder verkürzte Lernpfade (`quick`)

## Vermuteter Nutzerfluss

### 1. Konfiguration und Profil

Die Anwendung lädt eine YAML-Konfiguration und Secrets aus der Umgebung. Darin werden
LLM-Provider, Anki-Verbindung, Deck, Note-Type und vermutlich Spracheinstellungen
festgelegt.

### 2. Lernziel bestimmen

Aus aktuellem Niveau, Lernplan, Tags und eventuell bisherigen Ergebnissen wird ein
nächstes Ziel ausgewählt. Die Spuren `goal`, `plan`, `pickGoalMethod`, `tags` und CEFR
passen zu einem regel- oder LLM-gestützten Goal Picker.

### 3. Lernmethode wählen

Zu einem Ziel konnten offenbar unterschiedliche Methoden eingesetzt werden:
Vokabelkarten, Dialoge, Verständnisstexte, Lückentexte, Diktat,
Aussprache-/Minimalpaarübungen und Grammatikaufgaben.

### 4. Inhalt erzeugen und bearbeiten

Der Node-Server kombiniert den Lernplan mit YAML-Prompts und ruft OpenAI oder ein
leichteres Gemini-Modell auf. Die Web-App zeigt den generierten Inhalt und nimmt
Antworten bzw. Gesprächsbeiträge entgegen.

### 5. Bewerten und korrigieren

Ein separater Judge bewertet mindestens Konversationen. Ein definiertes Diff-Markup
stellt Änderungen oder sprachliche Korrekturen strukturiert in der Oberfläche dar.

### 6. Persistieren und wiederholen

Neue Lerninhalte werden lokal gespeichert und/oder als `SlovakTutorCard` nach Anki
übertragen. Die zuletzt implementierte Entwicklungsstufe überließ auch das Scheduling
Anki oder synchronisierte Ankis Wiederholungszustand zurück in die Anwendung.

## Technische Architektur

```text
webapp/                         Browser-Client
    index.html                  UI-Struktur
    styles.css                  Darstellung
    app.js                      umfangreiche Clientlogik

server-node/                    primäres Backend (TypeScript/Node)
    src/app.ts                  zentrale Server- und Fachlogik
    src/config.ts               validierte Konfiguration
    src/prompts.ts              Prompt-Laden/-Aufbereitung
    src/__tests__/              API- und vermutlich Fachtests

content/                        fachliche Inhalte
    prompts.yaml                Prompt-/Methodendefinitionen
    tag_schema.yaml             Inhalts- und Klassifikationsschema
    roadmap/                    CEFR-/Sprachlernplan

prompts/                        weiterer oder älterer Prompt-Katalog
config/                         YAML-Konfiguration und .env-Vorlagen
data/                           Laufzeit-, Lernstands- oder Inhaltsdaten
example/                        Vokabel-, Dialog- und Judge-Beispiele
interface/                      Schnittstellenverträge oder UI/API-Spezifikation
server/                         älteres/paralleles Python-Backend
requirements/                   Python-Abhängigkeiten
docs/                           Produkt- und Implementierungsdokumentation
```

### Backend

`server-node/src/app.ts` hatte zuletzt etwa **7.629 Zeilen**. Das deutet auf einen
modular nur teilweise aufgeteilten Server hin, in dem API-Routen, LLM-Orchestrierung,
Anki-Zugriff und Fachlogik weitgehend zentral zusammenliefen.

`server-node/src/config.ts` nutzte Zod oder eine vergleichbare `z.*`-Validierung. Direkt
belegt sind folgende Konfigurationsfelder bzw. Defaults:

- `anki.url`: standardmäßig `http://localhost:8765`
- `anki.server_url`: optional
- `anki.deck`: optional
- `anki.note_type`: standardmäßig `SlovakTutorCard`
- `anki.api_key_env`: standardmäßig `ANKI_CONNECT_KEY`
- `llm.api_key_env`: standardmäßig `OPENAI_API_KEY`
- `llm.light_api_key_env`: standardmäßig `GEMINI_API_KEY`

### Frontend

Die Web-App war offenbar frameworkfrei oder zumindest überwiegend als statische
HTML/CSS/JavaScript-Anwendung organisiert. Umfang und Commit-Hinweis auf „ux“ sprechen
für eine interaktive Einseitenoberfläche, nicht nur für eine API-Demo.

### Legacy-/Parallelimplementierung

Die Verzeichnisse `server/`, `requirements/`, `interface/` und ein konfigurierter
Python-3.12-Interpreter belegen Python-Code neben dem Node-Backend. Wahrscheinlich wurde
eine frühe Python-Version nach TypeScript/Node migriert oder als Referenz beibehalten.
Welche Variante zuletzt produktiv war, ist nicht sicher; die VS-Code-Tasks starteten
explizit `server-node`.

## Daten- und Inhaltsmodell

Die folgenden fachlichen Entitäten lassen sich aus den Spuren ableiten:

- **Learner/Profile:** Zielsprache, Muttersprache, CEFR-Niveau, Ziele
- **Roadmap item:** Lernstufe, Grammatik-/Vokabelziel, erlaubte Methoden
- **Tag:** Sprachebene, Thema/Domain, Funktion, Grammatik und möglicherweise Methode
- **Prompt definition:** Rolle/Systemtext, Variablen wie CEFR, Ausgabetyp
- **Vocab item:** Ausgangsvokabel oder Lerngegenstand
- **Generated vocab:** angereichertes Material, Beispiele und Karteninhalt
- **Conversation:** strukturierte Nachrichten bzw. Dialogzüge
- **Conversation judgment:** Bewertung, Fehler und Verbesserungsvorschläge
- **Correction diff:** maschinenlesbare Markierung zwischen Eingabe und Korrektur
- **Homework/task:** zugewiesene oder geplante Lerneinheit
- **Anki card/schedule:** exportierte Karte und Wiederholungszustand

Die genauen JSON-/YAML-Schemas sind nicht mehr vorhanden und dürfen beim Neuaufbau
nicht als gesichert betrachtet werden.

## Wiedergefundene Dateispuren

| Datei | letzter bekannter Umfang | Bedeutung |
|---|---:|---|
| `server-node/src/app.ts` | 7.629 Zeilen | zentrale Server-/Fachlogik |
| `webapp/app.js` | 2.536 Zeilen | Clientlogik |
| `example/conversation_130_llm.json` | 1.224 Zeilen | umfangreiches LLM-Dialogbeispiel |
| `content/roadmap/complete_slovak_a0_b1_plan.yaml` | 667 Zeilen | vollständiger Slowakisch-Lernplan |
| `content/prompts.yaml` | 651 Zeilen | Prompt-/Methodenkatalog |
| `prompts/prompts.yaml` | 450 Zeilen | zusätzlicher/älterer Promptkatalog |
| `webapp/styles.css` | 422 Zeilen | UI-Stile |
| `docs/implementation/IMPLEMENTIERUNGS_ROADMAP.md` | 357 Zeilen | technische Roadmap |
| `example/conversation_94.json` | 295 Zeilen | Dialogbeispiel |
| `webapp/index.html` | 289 Zeilen | UI-Struktur |
| `docs/implementation/GESAMTMETHODE_IST_SOLL.md` | 260 Zeilen | Ist-/Soll-Gesamtkonzept |
| `docs/implementation/INTERFACE_ARCHITEKTUR.md` | 195 Zeilen | Schnittstellenarchitektur |
| `content/tag_schema.yaml` | 191 Zeilen | Tag-/Inhaltsschema |
| `example/vocab-generated_a0_no1.json` | 190 Zeilen | generiertes Vokabelmaterial |
| `docs/README.md` | 168 Zeilen | Bedienung und Konfiguration |
| `example/conversation_61.json` | 150 Zeilen | Dialogbeispiel |
| `anki_note_type.md` | 122 Zeilen | Anki-Notiztyp und vermutlich Templates |
| `server-node/src/prompts.ts` | 103 Zeilen | Prompt-Integration |
| `example/vocab-item_a0_no1.json` | 78 Zeilen | Vokabel-Eingabemodell |
| `docs/implementation/DIFF_MARKUP_SPEC_V1.md` | 46 Zeilen | Korrektur-Markup |
| `docs/implementation/POLICY.md` | 41 Zeilen | Verhaltens-/Generierungsregeln |
| `example/conversation_judge_61.json` | 36 Zeilen | Dialogbewertung |

Zusätzlich sicher belegt, aber ohne bekannte Zeilenzahl:

- `.vscode/launch.json`
- `.vscode/tasks.json`
- `config/.env`
- `config/.env.example`
- `config/config.yaml`
- `config/config.example.yaml`
- `server-node/src/config.ts`
- `server-node/src/__tests__/api.test.ts`
- `.gitignore`

## Entwicklungsverlauf

Die erhaltene Git-Historie nennt in Reihenfolge:

1. `initial commit`
2. `second commit`
3. `third commit (it's a lot)`
4. `4`
5. `5`
6. `mehr methods (zb verstaendnistexte), ux, tests, fixes, schärfungen etc`
7. `pre scheduling by anki`
8. `scheduling by anki implemented`
9. ein Commit ohne erhaltenen Titel

Die Historie spricht für einen zunächst schnellen Prototyp, anschließend eine breite
fachliche/UX-Erweiterung und zuletzt die Vertiefung der Anki-Integration.

## Entwicklungs- und Startbefehle

Die erhaltenen VS-Code-Tasks waren:

```sh
npm -C server-node run dev
npm -C server-node run build
npm -C server-node start
```

Der zuletzt aktive Entwicklungsstack war damit klar das Node-Backend.

## Sicherheits- und Betriebsmodell

- API-Schlüssel lagen in `config/.env` oder Betriebssystem-Umgebungsvariablen.
- Erwartete Variablen waren `OPENAI_API_KEY`, `GEMINI_API_KEY` und
  `ANKI_CONNECT_KEY`.
- `.env.example` dokumentierte OpenAI und Gemini.
- Das echte `.env` war vorhanden, sein Inhalt wurde bei der Untersuchung nicht
  offengelegt und ist nicht Bestandteil dieses Manifests.
- AnkiConnect lief standardmäßig lokal auf Port 8765.

## Nicht mehr belegbar

Folgende Details fehlen vollständig oder sind nur zu unsicher für eine Rekonstruktion:

- konkrete HTTP-Endpunkte und Request-/Response-Schemas
- verwendetes Node-Webframework und genaue npm-Abhängigkeiten
- Datenbanktyp und Persistenzformat unter `data/`
- Authentifizierung, Mehrbenutzerfähigkeit und Deploymentmodell
- vollständiges Tag-, Prompt-, Roadmap- und Diff-Schema
- genaue Kartenfelder und Templates von `SlovakTutorCard`
- exakte Bewertungslogik und Scoring-Skalen
- Verhältnis zwischen Python- und Node-Implementierung
- genaue Semantik des Anki-Scheduling-Abgleichs
- ursprüngliche Tests und erwartete Outputs

## Empfohlener Wiederaufbaukern

Ein fachlich treuer erster Neuaufbau sollte in dieser Reihenfolge erfolgen:

1. Datenverträge für Profil, Lernziel, Vokabel, Dialog, Judge-Ergebnis und Anki-Karte.
2. YAML-Schema für Tags, Methoden, Prompts und den A0–B1-Lernplan.
3. Node-API für Zielauswahl, Inhaltsgenerierung, Bewertung und Persistenz.
4. Weboberfläche für Lernziel, Methode, Übung, Korrektur und Verlauf.
5. AnkiConnect-Export mit `SlovakTutorCard`.
6. Synchronisation des Wiederholungszustands mit Anki.
7. Tests mit rekonstruierten Vokabel- und Konversationsbeispielen.

Dieses Manifest ist die derzeit vollständigste inhaltliche Rekonstruktion, ersetzt
aber weder den verlorenen Quellcode noch die ursprünglichen fachlichen Schemas.
