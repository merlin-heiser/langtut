# Langtut Lernpaket-Player – Produktspezifikation

## Player und Lernpakete

- Genau ein installiertes Lernpaket ist aktiv; Fortschritt, Placement, Jobs, Sessions und Anki-Metriken sind nach Paket getrennt.
- Das vorinstallierte Standardpaket ist Slowakisch–Deutsch. Ordner und ZIP-Dateien dürfen weitere Sprachpaare bereitstellen.
- Pakete sind deklarativ und enthalten keinen Code. Curriculum ist verpflichtend; Placement, Startvokabeln, Prompt-Overrides und Aktivitäten sind optional.
- Aktivitäten beschreiben Rollen, Controller, Turn-Reihenfolge und Rundenzahl. Damit sind neue Kompositionen wie Dreierkonversationen ohne Player-Code möglich.
- Neue technische Fähigkeiten, etwa Audioanalyse, erfordern zuerst einen neuen sicheren Player-Baustein.
- Bei Paketupdates bleiben Fortschritt und importierte Inhalte über stabile Paket-, Modul- und Item-IDs erhalten.

## Verantwortlichkeiten

- Anki besitzt Karten, Reviews, Intervalle, Lapses und Leeches.
- Das aktive Lernpaket besitzt Curriculum und Lernziele; Langtut besitzt Exposition, Progression, Tutor-Sessions und Qualitätsgates.
- LLMs erzeugen und beurteilen Inhalte, verändern aber niemals Progressionsstatus oder Plannerregeln.
- Planner-Metriken berücksichtigen ausschließlich von Langtut erzeugte und mit `langtut`
  markierte Anki-Karten; fremde Decks beeinflussen den Tagesmodus nicht.

## Progression

Module durchlaufen `locked`, `available`, `preparing`, `learning` oder `credited`.
`learning` bedeutet vollständige Erstexposition, nicht Beherrschung. Spätere Schwächen
führen zu Recovery, niemals zu einer Rückstufung.

## Plattform

Phase 1 ist eine lokale Desktop-Web-App. Anki und Provider werden ausschließlich vom
Fastify-Backend angesprochen. Die React-Oberfläche enthält keine Lernlogik und bleibt
für eine spätere Capacitor-Verpackung geeignet.

Abgeschlossene oder aktive Placements werden nach einem Neuladen aus SQLite
wiederhergestellt. „Modul vorbereiten“ autorisiert zugleich die sichere Einrichtung
fehlender app-eigener Anki-Modelle. Fremde gleichnamige Modelle bleiben geschützt.

## Nicht-Ziele

- kein automatischer Modulstatus durch ein LLM
- kein stiller Provider-Fallback
- keine Änderung fremder Anki-Modelle
- kein Android-Artefakt im ersten Release
