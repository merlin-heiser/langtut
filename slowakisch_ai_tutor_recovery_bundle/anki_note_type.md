# ANKI_NOTE_TYPE

## Notetyp

`SlovakTutorCard`

## Felder

1. `Front` – Pflichtfeld
2. `Back` – Pflichtfeld
3. `Example` – optionaler slowakischer Beispielsatz
4. `Notes` – kurze Grammatik- oder Gebrauchserklärung
5. `Source` – z. B. `chatgpt:<session_id>`

## Kartenvorlage

```html
<!-- Front -->
<div class="prompt">{{Front}}</div>
{{#Example}}<div class="example">{{Example}}</div>{{/Example}}
```

```html
<!-- Back -->
<div class="prompt">{{Front}}</div>
<hr>
<div class="answer">{{Back}}</div>
{{#Example}}<div class="example">{{Example}}</div>{{/Example}}
{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}
```

## Importregeln

- Slowakischer Text wird in NFC und mit korrekter Diakritik gespeichert.
- Eine Karte enthält genau eine primäre Information.
- Maximal drei fachliche Tags: bevorzugt Topic + Grammar + Function.
- Fehler-Tags gehören standardmäßig in Session-Reports, nicht dauerhaft auf Karten.
- Exakte Dublette: normalisierte `Front` bereits vorhanden → verwerfen.
- Near-Dublette: gleiche diakritikfreie Form oder sehr ähnliche Front → manuell prüfen.
- Kein automatischer Import ohne Schema- und Budgetprüfung.

## Beispiel

```yaml
Front: "Idem do obchodu."
Back: "Ich gehe in den Laden."
Example: "Po práci idem do obchodu."
Notes: "do + Genitiv"
Source: "chatgpt:session_2026_03_04"
Tags: [topic_city, case_genitive, func_narrate]
```
