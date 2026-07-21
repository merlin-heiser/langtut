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
