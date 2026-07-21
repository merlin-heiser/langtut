# IMPLEMENTIERUNGS_ROADMAP

## Stack

- Node.js + TypeScript
- Fastify
- Zod oder AJV/JSON Schema
- OpenAI SDK
- nativer `fetch` für AnkiConnect
- YAML-Parser
- Vitest für Tests

## Phase 1 – Fundament

1. Repository und TypeScript-Konfiguration anlegen.
2. YAML-Dateien laden und beim Start validieren.
3. Domänentypen für Curriculum, SessionPlan, TutorReport und CandidateCard definieren.
4. Append-only Logging und atomisches Schreiben von `state.json` implementieren.

## Phase 2 – Vertikaler MVP

1. AnkiConnect-Healthcheck und Reader.
2. einfacher Planner mit vier Sessionmodi.
3. Prompt Builder aus Curriculum und Tagesplan.
4. OpenAI-Aufruf mit strukturiertem Report.
5. Validator, Dublettenprüfung und Dry-Run-Import.
6. explizite Bestätigung vor echtem Kartenimport.

## Phase 3 – Lernlogik

- Tag-Health und Problem-Score.
- Recovery-Modus.
- Modulvoraussetzungen und Soft Introduction.
- wöchentlicher Planner-Tick.
- orthographische Near-Match-Prüfung mit NFC/NFD.

## Phase 4 – Oberfläche

Lokale Webapp als dünne Steuer- und Darstellungsschicht. Sie zeigt Tagesplan, Tutor-Chat, Korrekturen, Import-Queue und Logs. Sie enthält keine Lernstands- oder Schedulinglogik. Fastify stellt die API bereit; das Frontend kann später mit Vite/React ergänzt werden.

## Empfohlene Ordnerstruktur

```text
src/
  app.ts
  domain/
  config/
  anki/
  planner/
  tutor/
  validation/
  persistence/
  routes/
curriculum/
data/
tests/
```

## Abnahmekriterium MVP

Anki öffnen, CLI-Session starten, Tagesplan erzeugen, Tutor-Interaktion durchführen, Report validieren, Karten in einer Import-Queue prüfen und bestätigte Karten nach Anki schreiben.
