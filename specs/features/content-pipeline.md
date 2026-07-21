# Feature: qualitätsgesicherte Inhaltsvorbereitung

## Szenario: explizite Autorisierung

Providerkosten und Anki-Schreibvorgänge beginnen erst nach „Modul vorbereiten“.
Gemeinsam genutzte JSON-Schema-Definitionen werden vor dem Provideraufruf vollständig
aufgelöst, da strukturierte Provider-Ausgaben keine repository-lokalen `$ref`-Ziele
auflösen können.
Vokabeln werden in Batches von höchstens 20 erzeugt.

## Szenario: zweistufiges Gate

Jedes Objekt muss Schema, Identität, NFC, Feldlängen, bekannte Fokustags und
Dublettenprüfung bestehen. Anschließend prüft ein unabhängiges Modell Übersetzung,
Natürlichkeit und Niveau. Nur doppelt bestandene Notes werden importiert.

## Szenario: Quarantäne

Abgelehnte Objekte werden mit Gründen gespeichert. Ersatzbatches versuchen das
Vokabelziel zu schließen; ein unerfülltes Ziel lässt den Job fehlschlagen und das
Modul bleibt `preparing`.
