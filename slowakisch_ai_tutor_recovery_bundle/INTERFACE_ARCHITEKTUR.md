# INTERFACE_ARCHITEKTUR

## Rollen

- **Anki:** Karten, Intervalle, Ease, Lapses, Fälligkeit.
- **Interface:** Curriculum, Tagesplanung, Budgets, Status, Validierung, Logs.
- **LLM:** Übungen, Dialoge, Korrekturen, qualitative Fehler- und Kartenvorschläge.

## Datenfluss

```text
Anki → Interface/Planner → Tutor API → Report Validator → Import Queue → Anki
```

## Eingaben

Das Interface liest aus Anki mindestens fällige Reviews, neue Karten, Lapses, Leech-Status und Tags. Aus `roadmap_a0_b1.yaml` liest es Module, Voraussetzungen, Grammatikziele, Vokabularbudgets und Übungsarten. Eigene Zustände werden in `state.json`, `session_log.jsonl` und `import_log.jsonl` gespeichert.

## Tagesmodi

- `OVERLOAD`: keine neuen Karten; kurze Stabilisierung.
- `NORMAL`: Wiederholung plus begrenzte neue Inhalte.
- `EXPANSION`: neues Modul oder Soft Introduction.
- `RECOVERY`: gezielte Reaktivierung schwacher Tags oder Grammatikziele.

Schwellenwerte gehören in Konfiguration, nicht in den Prompt.

## Fokuswahl

Das Interface wählt genau ein Primärmodul, optional ein Sekundärmodul und wenige Fokus-Tags. Voraussetzungen müssen erfüllt sein. Innerhalb eines Moduls werden schwache Tags, lange nicht trainierte Inhalte und frühe Verstärkung neuer Inhalte bevorzugt.

## Report und Gatekeeping

Der Tutor liefert einen strukturierten Report mit beobachteten Fehlern, Review-Vorschlägen und Kandidatenkarten. Das Interface prüft Schema, erlaubte Tags, Länge, eine Idee pro Karte, Budgets und Dubletten. Nur das Interface schreibt nach Anki.

## Diakritik

Slowakischer Inhalt wird kanonisch mit korrekter Diakritik und Unicode-Normalisierung `NFC` gespeichert. Lernereingaben dürfen zusätzlich diakritikfrei verglichen werden. Ein Treffer nur nach Entfernen der Diakritik ist `near_correct`, zeigt die korrekte Form und kann `error_orthography` erzeugen. Das LLM muss Orthographie nicht zuverlässig klassifizieren; das Interface darf sie deterministisch ergänzen.

## Persistenz

```text
data/state.json
data/session_log.jsonl
data/import_log.jsonl
data/error_clusters.json
curriculum/roadmap_a0_b1.yaml
curriculum/tag_schema.yaml
```

## Nicht-Ziele des MVP

Kein Dashboard, keine komplexen ML-Modelle, keine autonome Curriculumplanung durch das LLM und keine automatische Massenanlage ungeprüfter Karten.
