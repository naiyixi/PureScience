# PureScience · Français

> [中文](README.md) · [English](README.en.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [繁體中文](README.zh-Hant.md)

![Courbe de puissance issue d'une exécution réelle — inhibiteurs d'EGFR T790M, classés](docs/demo-verification/egfr_t790m_ic50.png)

*D'une exécution réelle, pas d'une maquette : le code, les paramètres et l'empreinte de l'environnement derrière cette courbe sont archivés pas à pas dans [`docs/demo-verification/`](docs/demo-verification/).*

PureScience est un atelier scientifique open source : il tourne en local sur votre machine (macOS, Windows, Linux), fonctionne avec le fournisseur de modèles que vous utilisez déjà, et transforme une tâche décrite en langage courant en une session d'agents qui lit des fichiers, exécute du Python et du R, cherche sur le web et interroge des sources de données scientifiques. Ce qui en sort est reproductible : rapports, tableaux et figures reliés à l'historique d'activité qui les a produits.

La documentation complète — capacités, réglages des modèles, permissions et la section franche sur la maturité avec ses limites connues — est en anglais dans [README.en.md](README.en.md) et en chinois dans [README.md](README.md). Cette page est l'entrée courte.

## Démarrer en trois étapes

1. **Télécharger** — [dernière version](https://github.com/naiyixi/PureScience/releases/latest) : macOS (Apple Silicon, 268 Mo · Intel, 284 Mo), Windows (installateur, 220 Mo), Linux (AppImage, 288 Mo · `.deb`, 216 Mo). Les sommes de contrôle de tous les paquets sont dans `SHA256SUMS.txt`, dans la même version.
2. **Premier lancement** — au premier démarrage, on choisit la langue et un fournisseur de modèles ; sans clé, rien ne s'exécute et rien n'est envoyé ailleurs.
3. **Première tâche** — créez un projet, décrivez la tâche en langage courant, lancez-la. Le résultat arrive sous forme d'artefact avec version, provenance et historique d'activité.

## Ce qui change ici

Chaque exécution est vérifiable, pas seulement plausible : les exécutions du carnet sont auditées, les figures confrontées à des règles de publication, chaque souvenir porte sa source, et rien ne quitte votre machine sans votre accord. Aujourd'hui, c'est le plus abouti en bio-informatique, biologie computationnelle, génomique, biologie structurale et découverte de médicaments, avec une architecture extensible à d'autres disciplines.
