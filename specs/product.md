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
`learning` bedeutet vollständige Erstaktivierung aller vorbereiteten Vokabel-, Funktions-
und Grammatikziele, nicht Beherrschung. Eine Karte wird erst durch ihre zielbezogene
Lernlektion von ausgesetzt auf neu gesetzt. Spätere Schwächen
führen zu Recovery, niemals zu einer Rückstufung.

Langtut darf Funktions- und Grammatik-Karten nur nach zielgebundener Übungsevidenz
automatisch mit Good oder Again bewerten. Vokabelkarten dürfen nach ihrer Lektion
eingesetzt, aber ausschließlich durch eine Nutzerhandlung in Anki bewertet werden.

## Plattform

Windows und Android sind gleichrangige lokale Laufzeiten. Beide verwenden denselben
plattformneutralen Anwendungskern für Pakete, Placement, Planung, Progression,
Inhaltserzeugung, Tutor-Sessions, Lexikon und Drive-Synchronisation. Fastify ist nur
der lokale HTTP-Adapter der Windows-Web-App; Android führt den Anwendungskern direkt
im gebündelten Capacitor-Artefakt aus und benötigt keine Langtut-API.

Plattformspezifisch bleiben ausschließlich Persistenz, Dateiauswahl, OAuth und Tokens,
Provider-Transport sowie die Anki-Anbindung. Windows verwendet SQLite und AnkiConnect,
Android IndexedDB und die AnkiDroid-API. Funktionale Regeln dürfen nicht in einem
dieser Adapter dupliziert werden.

Android darf für den Lernbetrieb direkt von AnkiDroid, Google Drive und den bewusst
konfigurierten LLM-Diensten abhängen. Eine lokale maschinelle Übersetzung ist eine
optionale Runtime-Fähigkeit und keine Voraussetzung für einen autonomen Client.

Google-OAuth-JSON-Dateien dürfen auf Windows und Android importiert werden. Die
Oberfläche extrahiert die Client-ID und, falls für den Desktop-Token-Tausch nötig, das
Client-Secret. Das Secret bleibt ausschließlich in der lokalen API-Konfiguration und
wird weder in Android-Artefakte noch in Drive-Ereignisse oder Logs übernommen.

Abgeschlossene oder aktive Placements werden nach einem Neuladen aus SQLite
wiederhergestellt. „Modul vorbereiten“ autorisiert zugleich die sichere Einrichtung
fehlender app-eigener Anki-Modelle. Fremde gleichnamige Modelle bleiben geschützt.

## Nicht-Ziele

- kein automatischer Modulstatus durch ein LLM
- kein stiller Provider-Fallback
- keine Änderung fremder Anki-Modelle
- kein Android-Zugriff auf eine Windows-, Fastify- oder sonstige Langtut-Serverlaufzeit
