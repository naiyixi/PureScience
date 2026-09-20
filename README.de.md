# PureScience · Deutsch

> [中文](README.md) · [English](README.en.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [繁體中文](README.zh-Hant.md)

![Wirkstärke-Diagramm aus einem echten Lauf — EGFR-T790M-Inhibitoren, sortiert](docs/demo-verification/egfr_t790m_ic50.png)

*Aus einem echten Lauf, kein Mock-up: Code, Parameter und Umgebungs-Fingerabdruck hinter diesem Diagramm liegen Schritt für Schritt unter [`docs/demo-verification/`](docs/demo-verification/).*

PureScience ist eine quelloffene Arbeitsumgebung für wissenschaftliches Arbeiten: Sie läuft lokal auf Ihrem Rechner (macOS, Windows, Linux), nutzt den Modellanbieter, den Sie ohnehin haben, und macht aus einer Aufgabe in normaler Sprache eine Agentensitzung, die Dateien liest, Python und R ausführt, im Web sucht und wissenschaftliche Datenquellen abfragt. Was zurückkommt, ist nachvollziehbar: Berichte, Tabellen und Abbildungen sind mit der Aktivitätshistorie verknüpft, die sie erzeugt hat.

Die vollständige Dokumentation — Fähigkeiten, Modelleinstellungen, Datenschutz und der ehrliche Reifegrad-Abschnitt mit bekannten Grenzen — steht auf Englisch in [README.en.md](README.en.md) und auf Chinesisch in [README.md](README.md). Diese Seite ist der kurze Weg hinein.

## In drei Schritten starten

1. **Herunterladen** — [aktuelles Release](https://github.com/naiyixi/PureScience/releases/latest): macOS (Apple Silicon, 268 MB · Intel, 284 MB), Windows (Setup, 220 MB), Linux (AppImage, 288 MB · `.deb`, 216 MB). Alle Pakete liegen mit Prüfsummen unter `SHA256SUMS.txt` im selben Release.
2. **Erster Start** — beim ersten Öffnen werden Sprache und ein Modellanbieter eingerichtet; ohne Schlüssel läuft nichts, es wird auch nichts hochgeladen.
3. **Erste Aufgabe** — Projekt anlegen, Aufgabe in Alltagssprache beschreiben, laufen lassen. Das Ergebnis erscheint als Artefakt mit Version, Herkunft und Aktivitätsverlauf.

## Was hier anders ist

Jeder Lauf ist prüfbar, nicht nur plausibel: Notebook-Ausführungen werden auditiert, Abbildungen gegen publikationsnahe Regeln geprüft, Erinnerungen tragen ihre Quelle, und nichts verlässt den Rechner ohne Ihre Zustimmung. Heute am stärksten in Bioinformatik, computergestützter Biologie, Genomik, Strukturbiologie und Wirkstoffforschung — mit erweiterbarer Architektur für weitere Disziplinen.
