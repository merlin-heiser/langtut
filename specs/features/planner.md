# Feature: deterministischer Tagesplanner

## Szenario: Prioritätsfolge

Der Planner wertet Regeln strikt als `OVERLOAD`, dann `RECOVERY`, dann `EXPANSION`,
sonst `NORMAL` aus. Er protokolliert Metriken, Schwellen und Begründungen im Plan.

## Szenario: keine Rückstufung

Recovery priorisiert schwache alte Ziele, verändert aber niemals einen bestehenden
Modulstatus `learning` oder `credited`.

## Szenario: isolierte Reviewlast

Fällige Reviews, neue Karten, Leeches und Lapses werden nur für Karten mit dem
Systemtag `langtut` gezählt. Andere Decks oder Karten verändern den Langtut-Modus nicht.

## Szenario: geführter Tagesablauf

`Heute` ist der primäre Einstiegspunkt. „Tag planen“ erzeugt eine für den lokalen
Kalendertag gespeicherte, geordnete Liste konkreter Vorbereitung-, Vokabel- und
Übungseinheiten. Die Oberfläche hebt immer genau die nächste offene Einheit hervor
und zeigt einen Tagesfortschritt. Die Übung selbst läuft im Fokusmodus; ihr Abschluss
aktualisiert anschließend Aufgabenliste, Modulfortschritt und die nächste Aktion.

## Szenario: Fortschritt bildet erledigte Lernarbeit ab

Eine bearbeitete Übung zählt als erledigte Arbeit, auch wenn das Ergebnis schwach ist.
Ein schwaches Ergebnis erzeugt zusätzlich eine explizite Wiederholungseinheit. Damit
wächst die erwartete Tagesarbeit sichtbar; der Tagesfortschritt wird nicht durch ein
manuelles Abhaken verfälscht. Vokabelkarten werden dabei nie automatisch bewertet.

## Szenario: deklarierte Evidenz

Jede vom Tagesplan vorgeschlagene Übung nennt die Funktions- oder Grammatikziele,
für die sie Evidenz erzeugt. Der Plan darf keine undeklarierte freie Übung als Ersatz
für Ziel-Evidenz ausgeben.
