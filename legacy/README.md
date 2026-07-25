# GTA AI Studio

GTA AI Studio est un studio Windows local-first qui transformera un rush GTA et un brief libre en vidéo montée, narrée, sous-titrée et prête à publier. Le produit est conçu CPU-first, sans voix humaine obligatoire, sans timecodes manuels et sans supposer qu’une information demandée existe réellement dans le rush.

## État du dépôt

**Phase 7 terminée, éditeur non destructif 0.7.2 livré.** La timeline permet maintenant de déplacer, redimensionner, découper, dupliquer et supprimer les plans, corriger le focus, modifier ou désactiver les overlays, annuler/rétablir les actions, sauvegarder une nouvelle révision et régénérer uniquement le plan sélectionné. La Phase 8 n’est pas commencée.

## Principes non négociables

- Le brief guide l’analyse, mais ne constitue jamais une preuve.
- Le cœur métier reste indépendant de GTA V, GTA VI et des fournisseurs d’IA.
- Les Game Adapters contiennent toute connaissance spécifique à un jeu.
- Les étapes sont persistantes, idempotentes, reprenables et traçables.
- Les fichiers restent locaux par défaut et les transmissions externes sont explicites.
- Les commandes média sont construites depuis une timeline validée, jamais depuis du shell libre produit par un LLM.
- Toute fonctionnalité absente ou future est marquée comme telle.

## Organisation

```text
AGENTS.md            Constitution opérationnelle permanente pour Codex
apps/                 Application desktop Tauri + React
services/             API locale et responsabilités des workers
packages/             Contrats et noyaux indépendants
game-adapters/        Extensions propres à GTA V et GTA VI
templates/            Modèles éditoriaux et graphiques versionnés
data/                 Données locales ignorées par Git
tests/                Tests de contrats et transitions
docs/                 Documentation canonique du produit
```

Tout agent commence par [`AGENTS.md`](AGENTS.md). Pour le produit, continuer avec [le rapport de Phase 7](docs/PHASE_7_REPORT.md), [l’architecture](docs/ARCHITECTURE.md) et [les règles de développement](docs/DEV_RULES.md).

## Validation locale

Prérequis : Windows 10/11, Node.js 22+, npm 10+, `uv` avec Python 3.12+, FFmpeg/FFprobe 8+ dans le `PATH` et au moins une voix Windows SAPI. Rust stable et Visual Studio Build Tools 2022 avec les outils C++ sont requis uniquement pour compiler l’application native.

Pour lancer l’API puis Tauri dans le même terminal :

```powershell
npm run dev
```

`npm run dev:web` lance la variante Vite seule. Le script attend que l’API soit prête, réutilise une API déjà active et arrête uniquement les processus qu’il a créés. `GTA_STUDIO_HARDWARE_ACCELERATION=auto|cpu|nvidia` contrôle la stratégie d’encodage ; `auto` valide NVENC par un mini-encodage avant de l’utiliser.

```powershell
npm install
npm test
& .\apps\desktop\scripts\build-sidecar.ps1
npm run tauri --workspace @gta-ai-studio/desktop -- build
```

Le build sans installateur est aussi disponible avec `npm run tauri --workspace @gta-ai-studio/desktop -- build --no-bundle`. L’exécutable est alors produit dans `apps/desktop/src-tauri/target/release/`.

L’installateur est produit sous `apps/desktop/src-tauri/target/release/bundle/nsis/GTA AI Studio_0.7.2_x64-setup.exe`. Le raccourci Bureau peut être recréé avec `powershell -ExecutionPolicy Bypass -File .\scripts\create-desktop-shortcut.ps1`.

## Prochaine étape

La Phase 8 ajoutera OAuth, brouillons, publication contrôlée et export de secours. Aucun contenu n’est encore envoyé à une plateforme. Voir [ROADMAP.md](docs/ROADMAP.md).
