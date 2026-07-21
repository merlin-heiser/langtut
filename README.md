# Langtut

Langtut ist ein lokaler Lernpaket-Player: Der Player besitzt Progression, Sessions, Qualitätsgates und die Anschlüsse an LLMs und Anki. Austauschbare Lernpakete liefern Sprachen, Curriculum, Lernziele und optional Placement, geprüfte Startvokabeln, Prompt-Anpassungen und deklarative Lernmethoden.

Slowakisch–Deutsch ist als Standardpaket enthalten. Weitere Pakete können in der Oberfläche als ZIP installiert oder als Verzeichnis unter `data/packages/<paket-id>` abgelegt werden. Immer genau ein Paket ist aktiv; der Fortschritt bleibt je Paket erhalten.

## Start

Voraussetzungen: Node.js 24+, npm, PowerShell 7 und Anki Desktop mit AnkiConnect. API-Schlüssel bleiben ausschließlich in der lokalen API-Umgebung.

```powershell
npm install
npm run check
make webapp
```

Web-App: `http://localhost:5173`, API: `http://127.0.0.1:3210`.

## Minimales Lernpaket

Ein Paket besteht mindestens aus `package.yaml` und `curriculum.yaml`. Die Dateien `vocabulary.yaml`, `placement.yaml`, `prompts.yaml` und `activities.yaml` sind optional. Ein vollständiges kleines Beispiel liegt unter `examples/english-norwegian`.

```yaml
# package.yaml
schemaVersion: 1
id: english-norwegian-demo
version: 1.0.0
name: English – Norwegian
targetLanguage: { code: en, name: English }
sourceLanguage: { code: nb, name: Norsk bokmål }
targetLevel: A1
```

Pakete enthalten keinen ausführbaren Code. `activities.yaml` kombiniert sichere Player-Bausteine zu eigenen Methoden: beliebig viele Rollen können vom Lernenden, vom LLM oder durch festen Text gesteuert und in einer Turn-Reihenfolge angeordnet werden. Das Beispiel definiert eine Dreierkonversation.

```powershell
npm run package:validate -- examples/english-norwegian
```

Mitgelieferte Vokabeln werden zuerst importiert; das LLM ergänzt nur bis zum Ziel des Moduls. Prompts überschreiben einzelne bekannte Aufgaben, alle übrigen kommen aus der Standardbibliothek.

## Verbindliche Quellen

- Produktregeln: `specs/product.md`
- HTTP-Vertrag: `specs/api/openapi.yaml`
- Datenverträge: `specs/schemas/contracts.schema.json`
- Standardpaket-Metadaten: `learning-packages/slowakisch-deutsch/package.yaml`

Anki besitzt Karten und Spaced Repetition. Langtut verändert keine fremden Notiztypen und markiert eigene Karten mit Paket-, Modul- und Inhalts-Tags.
