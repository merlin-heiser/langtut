# Slowakisch AI Tutor – Projektwiederherstellung

## Kernidee

- **Anki** ist die Memory Engine.
- **Das Interface** ist System of Record und Scheduler.
- **Das LLM** ist Tutor, Übungsgenerator und qualitative Fehleranalyse.
- Zahlen, Modulstatus, Budgets, Progress und Importentscheidungen entstehen ausschließlich im Interface.

## Dateien

- `INTERFACE_ARCHITEKTUR.md` – Datenfluss, Scheduler, Validierung und Persistenz.
- `PROMPT_ARCHITEKTUR.md` – Rolle und Ausgabeformat des Tutors.
- `IMPLEMENTIERUNGS_ROADMAP.md` – Reihenfolge für MVP und Ausbau.
- `tag_schema.yaml` – erlaubte Tags und Importregeln.
- `roadmap_a0_b1.yaml` – vollständiger A0→B1-Lehrplan mit Progression.
- `anki_note_type.md` – Anki-Felder, Templates und Dublettenregeln.

## Technischer Zielstack

- **TypeScript direkt**
- **Fastify** für die lokale API
- **Zod oder JSON Schema/AJV** für Laufzeitvalidierung
- **AnkiConnect** für Lesen und Schreiben
- **OpenAI API** für Tutor-Interaktionen
- zunächst CLI oder einfache lokale Weboberfläche; keine Abhängigkeit von chatgpt.com

## Auftrag an Codex

Implementiere zuerst einen vertikalen MVP-Pfad:

1. Konfiguration/YAML laden und validieren.
2. AnkiConnect anbinden und Tagesstatus lesen.
3. Sessionmodus und Fokus deterministisch berechnen.
4. Tutor-Prompt erzeugen und über die OpenAI API ausführen.
5. strukturierten Report validieren.
6. Karten als Vorschläge anzeigen und erst nach Gatekeeping nach Anki schreiben.
7. Session- und Import-Logs append-only speichern.

Keine Lernlogik im Frontend und keine Fortschrittsentscheidungen im LLM.
