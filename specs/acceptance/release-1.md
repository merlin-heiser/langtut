# Release-1-Abnahme

1. Anki-Modelle können nach einem vollständigen Diff sicher und idempotent eingerichtet werden.
2. Placement empfiehlt ein Modul, endet adaptiv und erlaubt einen bewussten Override.
3. Das vollständige Vokabelziel eines Moduls wird in Batches erzeugt, doppelt validiert und automatisch importiert.
4. Für alle kommunikativen Funktionen und Grammatik-Milestones existieren importierte Chunk- beziehungsweise Rule-Notes.
5. Jedes Vokabel-, Funktions- und Grammatikziel wird erst nach seiner Lernlektion eingesetzt; ein Klick allein verändert keinen Fortschritt.
6. Eine Session übt fällige Funktions- und Grammatik-Karten bis Langtut sie nach Evidenz mit Good oder Again bewertet hat; Vokabelbewertungen bleiben Nutzerhandlungen in Anki.
7. Das Modul wechselt nach vollständiger Zielaktivierung zu `learning`, ohne Mastery oder Fehlerfreiheit vorauszusetzen.
8. Nachfolgemodule werden aus stabilen Voraussetzungen deterministisch freigeschaltet.
9. Spätere Schwächen erzeugen `RECOVERY`-Aktivitäten, ohne bestehende Modulzustände zurückzustufen.
10. Das Android-Artefakt führt alle Lernrouten lokal aus und enthält keine Abhängigkeit von einer Langtut-Backend-URL.
11. Windows-HTTP-Client und Android-In-Process-Client erfüllen denselben beobachtbaren Runtime-Vertrag.
