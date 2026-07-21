# Feature: lokale API-Kostenzähler

## Szenario: gemessene statt geschätzte Tokenmengen

Nach jedem erfolgreichen Provideraufruf speichert Langtut die vom Provider gemeldeten
Input-, Cache- und Output-Token append-only. OpenAI-Reasoning- und Gemini-Thinking-Token
werden als Output berechnet. Frühere, vor Einführung dieses Features erfolgte Aufrufe
werden nicht rückwirkend geschätzt.

## Szenario: versionierte Listenpreise

Die Kosten werden in USD anhand von `config/model_pricing.yaml` berechnet. Modell,
Gültigkeitsdatum und offizielle Preisquelle sind versioniert. Ein Modell ohne bekannten
Preis darf keinen Provideraufruf ausführen, damit der Zähler Kosten nicht still mit null
ausweist.

## Szenario: Woche und Gesamt

Die Kopfzeile zeigt die Summe seit Beginn der aktuellen lokalen ISO-Kalenderwoche
(Montag 00:00) und die Gesamtsumme aller erfassten Aufrufe. SQLite bleibt System of
Record; die Anzeige wird nach kostenpflichtigen Aktionen aktualisiert.
