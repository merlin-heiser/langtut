# Feature: lokale, lazy übersetzte Vokabelbibliothek

Der Katalog speichert zielsprachige Sinne, Formen, Kategorien und Frequenzen unabhängig
von Übersetzungen. Kategorien und ihre Curriculum-Mappings werden vorab lokalisiert;
Übersetzungen, Beispiele und Notizen werden erst für gezogene oder nachgeschlagene Sinne
aufgelöst und pro Sinn/Erklärungssprache gecacht.

`npm run lexicon:import -- <db> <catalog.jsonl>` importiert die Record-Typen `source`,
`category`, `localization`, `mapping`, `sense`, `form`, `senseCategory` und `translation`.
Jeder Record enthält `type` sowie die gleichnamigen CamelCase-Felder der Datenbank.
Nicht weiterverteilbare Quellen werden nur mit `--allow-local-restricted` in eine private
lokale Datenbank aufgenommen; ein solches Artefakt darf nicht ausgeliefert werden.

Die Modulvorbereitung zieht zuerst aus Paketvokabeln, danach gewichtet und mit stabilem
Seed aus der Bibliothek. Nur das verbleibende Delta wird frei generiert. Ein gezogener
Sinn ohne vollständiges Kartenmaterial wird gesammelt materialisiert und anschließend
durch dasselbe deterministische und semantische Gate wie generierter Inhalt geprüft.

Gesprächs-Lookups verwenden Lemma, Formenindex und Cache. Nur ohne eindeutigen lokalen
Treffer darf ein kontextgebundener Modellaufruf folgen. KI-Ergebnisse werden markiert;
erst „Merken“ legt sie im Staging ab.

## Lokaler MT-Fallback

Lokale maschinelle Übersetzung ist optional und liegt zwischen geprüftem Cache und
Cloud-Auflösung. Der revisionsgepinnte Katalog steht in `config/local_mt.yaml`: Ein
installiertes direktes Marian-Modell gewinnt nach Priorität, danach folgt M2M100-418M.
NLLB und MADLAD werden wegen Produktionslizenz beziehungsweise Desktop-Größe nicht als
Standard angeboten.

Gewichte werden erst nach ausdrücklicher Installation in den Einstellungen unterhalb
des lokalen Datenverzeichnisses geladen. Der separate Python-JSONL-Worker benötigt
`transformers`, `torch`, `sentencepiece` und `huggingface_hub`; ein anderer Interpreter
kann über `LANGTUT_PYTHON` gewählt werden. Der `probe`-Befehl prüft diese Abhängigkeiten
ohne die schweren ML-Module zu importieren und muss als schneller, nebenwirkungsfreier
Start-Check innerhalb des API-Timeouts antworten.

Lokale MT legt niemals selbst einen Wortsinn fest. Sie wird nur bei einem eindeutigen
Katalogsinn verwendet und mit Status `pending_verification`, Provider, Modellrevision,
Sprachrichtung, Kontext-Hash, Confidence und Direkt-/Pivotmodus gespeichert. Mehrdeutige
Sinne gehen bei aktiviertem Cloud-Fallback weiterhin an die kontextuelle Auflösung.
