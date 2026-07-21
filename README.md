# Slowakisch AI Tutor

Spec-driven lokaler Slowakisch-Tutor, rekonstruiert aus dem unveränderten Recovery-Bundle. Anki verantwortet Karten und Spaced Repetition; Langtut verantwortet Curriculum, Placement, Progression, Tutor-Sessions und Inhaltsqualität.

## Start

Voraussetzungen: Node.js 24+, npm, GNU Make, PowerShell 7 (`pwsh`) und Anki Desktop mit AnkiConnect. API-Schlüssel bleiben ausschließlich in der lokalen API-Umgebung.

```powershell
Copy-Item config/.env.example .env
npm install
npm run check
make webapp
```

Web-App: `http://localhost:5173`, API: `http://127.0.0.1:3210`.

`make webapp` ersetzt eine vorhandene Langtut-Dev-Instanz nur dann sanft, wenn keine
aktiven Placements, Tutor-Sessions oder Generierungsjobs vorliegen. Andernfalls nennt
die CLI die Schutzgründe und lässt die laufende Instanz unverändert. `make force webapp`
führt bewusst einen harten Neustart durch. Beide Befehle sorgen dafür, dass nie zwei
Langtut-Instanzen parallel weiterlaufen.

Alternativ lässt sich der Entwicklungsserver über den Make-Shortcut starten:

```powershell
make webapp
```

## Verbindliche Quellen

- Produktregeln: `specs/product.md`
- Features und Akzeptanz: `specs/features/` und `specs/acceptance/`
- HTTP-Vertrag: `specs/api/openapi.yaml`
- Datenverträge: `specs/schemas/contracts.schema.json`
- Curriculum-Quelle: `slowakisch_ai_tutor_recovery_bundle/roadmap_a0_b1.yaml`
- Modernisierte Fokus-Tags: `curriculum/module_focus_tags.yaml`

`packages/contracts/src/generated.ts` wird aus dem JSON Schema erzeugt und nie manuell gepflegt. Das Recovery-Bundle bleibt archiviert und unverändert.

## Sichere Integrationen

Provideraufrufe erfolgen task-spezifisch gemäß `config/model_tasks.yaml`, ohne stillen Fallback. Modulvorbereitung autorisiert den jeweiligen Generierungsbatch und die Anki-Schreibvorgänge. Dabei richtet die Pipeline fehlende app-eigene Anki-Modelle automatisch ein; der Diff bleibt vorab in der Oberfläche einsehbar und gleichnamige fremde Modelle werden niemals verändert.
