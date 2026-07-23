# Feature: vertikale Tutor-Session

## Szenario: deterministische Textübungen

Textübungen verwenden ausschließlich paketierte oder vorbereitete Modulaufgaben. Ihre
Lösungen werden server- und plattformunabhängig normalisiert und bewertet; eine nur
ohne Diakritik abweichende Antwort ist `near_correct` und erhält keinen Volltreffer.

## Szenario: erstes Modul

Gegeben ist ein leerer Lernstand und ein erreichbares, eingerichtetes Anki. Wenn der
Nutzer das erste Modul vorbereitet, erzeugt Langtut alle erforderlichen Vokabeln,
Chunks und Regeln, prüft sie deterministisch und semantisch und importiert nur
bestandene Notes. Das Modul bleibt `preparing`, bis die Sollzahlen erreicht sind.

## Szenario: Aktivierung und Anki-gesteuerte Praxis

Zu Beginn einer Session liest Langtut die fälligen Funktions- und Grammatik-Karten
des Moduls und schwierige, bereits eingesetzte Vokabelkarten aus Anki. Es erstellt
zielgebundene Übungen für die fälligen Funktions- und Grammatik-Karten. Nur deren
ausgewertete Übungsantworten dürfen Good oder Again an Anki senden. Schwierige
Vokabeln dürfen unterstützend geübt, aber nicht automatisch bewertet werden.

## Szenario: Freischaltung ohne Mastery

Wenn alle Notes importiert und jedes Vokabel-, Funktions- und Grammatikziel durch
seine Lernlektion aktiviert wurde, wechselt das Modul zu `learning`. Nachfolgemodule
werden freigeschaltet, unabhängig von Fehlerzahl oder Anki-Retention.

## Szenario: Recovery

Wenn Anki Leeches oder wiederholte Lapses meldet, wählt der Planner `RECOVERY`, ohne
einen bestehenden `learning`- oder `credited`-Status zurückzunehmen.

## Szenario: Anki-Setup

Die App zeigt vor jeder Modellanlage einen Diff. Nur nach expliziter Bestätigung darf
sie Modelle mit Langtut-Sentinel anlegen oder aktualisieren. Gleichnamige fremde
Modelle werden als Konflikt behandelt.
