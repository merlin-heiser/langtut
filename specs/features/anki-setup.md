# Feature: verwaltetes Anki-Setup

## Szenario: sichtbarer Diff

Vor jeder Änderung liefert die API Deck, Felder, Templates, CSS und die betroffenen
Bereiche. Ohne `confirm: true` wird keine Änderung ausgeführt.

## Szenario: Eigentumsschutz

Nur Modelle mit Langtut-Sentinel und Schemahash dürfen migriert werden. Ein
gleichnamiges Modell ohne Sentinel ist ein Konflikt und bleibt unverändert.

## Szenario: Idempotenz und Kartenrichtungen

Ein zweites Setup erzeugt keinen Diff. Vokabel- und Chunk-Modelle enthalten zwei
Templates, damit beide Richtungen als getrennte Anki-Karten terminiert werden.

## Szenario: systemgesteuerte Kartenfreigabe

Neue Langtut-Karten werden standardmäßig ausgesetzt. Eine Karte darf nur dann
sichtbar bzw. lernbar sein, wenn ihr Modul den Domain-Status `learning` besitzt;
Karten aus `locked`, `available`, `preparing` und `credited`-Modulen bleiben
ausgesetzt. Diese Regel gilt für Vokabel-, Chunk- und Regelkarten gleichermaßen
und wird bei jedem Curriculum-Abgleich auch auf bereits importierte Langtut-
Karten angewendet. Fremde Karten und Modelle werden nicht verändert.

## Szenario: automatische Einrichtung bei Modulvorbereitung

„Modul vorbereiten“ ist die explizite Autorisierung für Providerkosten und
Anki-Schreibvorgänge dieses Moduls. Vor dem ersten Import richtet die Pipeline fehlende
app-eigene Modelle und das Deck anhand desselben Diffs automatisch ein. Ein Konflikt mit
einem nicht verwalteten Modell stoppt den Job mit einer verständlichen Meldung.

Ein eingegebener AnkiConnect-Key wird vor dem Speichern validiert. Falls ein alter
gespeicherter Key abgelehnt wird, AnkiConnect aber ohne Key erreichbar ist, entfernt
Langtut die veraltete lokale Konfiguration und verbindet sich ohne Key.
