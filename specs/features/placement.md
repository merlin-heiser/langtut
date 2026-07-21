# Feature: adaptives Placement

## Szenario: frühes Ende

Gegeben sind konsistente starke oder schwache Antworten. Sobald die Einstufung stabil
ist, endet das Placement vor dem Itemlimit. Nach 15 Minuten oder 20 Items endet es in
jedem Fall.

## Szenario: gemischte Bewertung

Geschlossene Erkennungs- und Produktionsaufgaben werden deterministisch ausgewertet.
Eine freie Antwort wird anhand des strukturierten `PlacementEvaluation`-Vertrags
rubric-basiert bewertet.

## Szenario: bewusster Override

Nach der Empfehlung darf der Nutzer jedes vorhandene Startmodul wählen. Frühere
Module werden `credited`; für sie werden keine rückwirkenden Karten erzeugt.

## Szenario: Wiederaufnahme

Nach Neuladen oder Neustart liefert die API das zuletzt aktualisierte Placement mit
seinem Ergebnis beziehungsweise der nächsten noch offenen Aufgabe. Ein abgeschlossenes
Placement wird nicht erneut als „ausstehend“ dargestellt.
