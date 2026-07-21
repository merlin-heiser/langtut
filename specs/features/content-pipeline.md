# Feature: qualitätsgesicherte Inhaltsvorbereitung

## Szenario: explizite Autorisierung

Providerkosten und Anki-Schreibvorgänge beginnen erst nach „Modul vorbereiten“.
Gemeinsam genutzte JSON-Schema-Definitionen werden vor dem Provideraufruf vollständig
aufgelöst, da strukturierte Provider-Ausgaben keine repository-lokalen `$ref`-Ziele
auflösen können.
Vokabeln werden in Batches von höchstens 20 erzeugt.
Jeder Ersatzbatch erhält die curriculumweit bereits importierten sowie die im Modul
quarantänisierten slowakischen Vorderseiten als Ausschlussliste. Der erste Bedarf plus
höchstens zwei Ersatzbatches begrenzt unnötige Provideraufrufe. Dubletten innerhalb
desselben Batches werden ebenfalls deterministisch erkannt.

## Szenario: zweistufiges Gate

Jedes Objekt muss Schema, Identität, NFC, Feldlängen, bekannte Fokustags,
Dublettenprüfung und die pädagogische Rolle seines Note-Typs bestehen. `vocab` zählt
ausschließlich lexikalische Kompetenz: keine Bezeichnungen für Grammatik oder
Phonologie, keine einzelnen Buchstaben/Zeichen und keine isolierten Zellen eines
Flexionsparadigmas. Vokabelaufrufe erhalten ausschließlich Niveau und Vokabeldomänen;
grammatiklastige Modultitel, Funktionen und Milestones werden nicht in ihren Prompt
aufgenommen. Chunk-Aufrufe erhalten kommunikative Funktionen, Rule-Aufrufe erhalten
Grammatik-Milestones. Metasprache gehört in
`rule`; kommunikativ unmittelbar verwendbare feste Wendungen gehören in `chunk`.
Anschließend prüft ein unabhängiges Modell Übersetzung, Natürlichkeit, Niveau und
dieselbe Rollentrennung. Nur doppelt bestandene Notes werden importiert.

Bereits importierte Vokabeln werden beim erneuten Vorbereiten gegen dieselbe
Rollentrennung auditiert. Falsch klassifizierte, ausschließlich von Langtut verwaltete
Notes werden aus Anki entfernt, append-only als zurückgezogen protokolliert und durch
neue lexikalische Einträge ersetzt.

## Szenario: Quarantäne

Abgelehnte Objekte werden mit Gründen gespeichert. Ersatzbatches versuchen das
Vokabelziel zu schließen; ein unerfülltes Ziel lässt den Job fehlschlagen und das
Modul bleibt `preparing`.

## Szenario: lokale Diagnose

Jeder Batch protokolliert angeforderte, erzeugte, deterministisch abgelehnte,
semantisch abgelehnte und importierte Mengen ohne vollständige Prompts oder Schlüssel in
`data/diagnostics/content-pipeline.jsonl`. Das Diagnoseverzeichnis wird nicht versioniert.
