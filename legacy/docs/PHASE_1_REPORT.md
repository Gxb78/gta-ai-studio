# Rapport de clôture — Phase 1

## Résultat

La fondation locale est fonctionnelle de bout en bout : l’utilisateur choisit un MP4 dans l’application Windows, un projet persistant est créé, le fichier est copié dans le stockage géré, FFprobe extrait les métadonnées, la queue SQLite génère un proxy H.264/AAC et l’interface affiche la progression puis lit le résultat.

Aucun fournisseur d’IA payant ni livrable de Phase 2 n’a été ajouté.

## Livrables

- application Tauri 2 + React 19 + Vite 8 avec sélection native de fichier ;
- sidecar FastAPI lié exclusivement à `127.0.0.1:8765` et démarré par Tauri ;
- SQLite en mode WAL, migrations vérifiées par checksum et repositories projets/médias/jobs/artefacts ;
- queue persistante avec dépendances, leases, heartbeat, annulation, retry et récupération des jobs abandonnés ;
- hashing SHA-256 streaming, stockage source géré, déduplication et réutilisation du proxy ;
- commandes FFprobe/FFmpeg sous forme de tableaux d’arguments, sans shell libre ;
- proxy écrit atomiquement puis vérifié avec FFprobe ;
- progression en Server-Sent Events, rapport d’import et lecture du proxy ;
- logs JSON corrélés et erreurs API structurées ;
- sidecar Python autonome produit avec PyInstaller ;
- icône originale et installateur Windows NSIS x64.

## Décisions d’architecture

Le worker média Phase 1 est embarqué dans le sidecar FastAPI. La queue, les contrats et les responsabilités restent séparés dans le code, mais un processus distinct n’apporterait aucun bénéfice mesuré pour ce produit local monomachine à ce stade.

Les médias lourds restent sur le filesystem et SQLite conserve les métadonnées, états et références. Un import est copié dans `data/projects/<project_id>/source/`; les artefacts dérivés sont adressés par empreinte et peuvent être partagés par plusieurs projets.

La source sélectionnée doit être un fichier MP4 existant et résolu. Les chemins servant les artefacts sont reconstruits depuis les identifiants persistés et vérifiés dans la racine gérée.

## Validation exécutée

| Contrôle | Résultat |
| --- | --- |
| Typecheck TypeScript global | réussi |
| Tests unitaires TypeScript | 7 réussis |
| Tests unitaires Python | 3 réussis |
| Tests d’intégration API | 6 réussis |
| Compilation Python | réussie |
| `cargo check` Tauri/Rust | réussi |
| Build frontend de production | réussi |
| Build Tauri release x64 | réussi |
| Build installateur NSIS x64 | réussi |
| Smoke test du sidecar PyInstaller | réussi, FFmpeg et FFprobe détectés |
| Démarrage réel de l’exécutable | réussi, sidecar enfant et santé API vérifiés |
| Capture Edge headless 1440 × 900 | réussie, écran d’import inspecté |

Les intégrations couvrent le flux MP4 réel `import -> métadonnées -> proxy -> terminé`, la réutilisation du même artefact pour un doublon, la récupération au redémarrage d’un job `RUNNING` abandonné, le rejet de traversée de chemin et l’absence de commande shell libre.

Le fichier `tests/fixtures/demo-gameplay.mp4` est un MP4 H.264/AAC valide de quatre secondes généré par FFmpeg pour rendre les tests reproductibles. Il ne prétend pas contenir des images GTA.

## Artefacts de livraison

- exécutable : `apps/desktop/src-tauri/target/release/gta-ai-studio.exe` ;
- installateur : `apps/desktop/src-tauri/target/release/bundle/nsis/GTA AI Studio_0.1.0_x64-setup.exe` ;
- source de l’icône : `apps/desktop/src-tauri/icons/icon-source.png` ;
- sidecar de build : `apps/desktop/src-tauri/binaries/gta-studio-api-x86_64-pc-windows-msvc.exe`.

Les sorties `target/` et le sidecar binaire sont régénérables et ignorés par Git.

## Limites restantes

- FFmpeg et FFprobe sont détectés dans le `PATH` de la machine ; ils ne sont pas encore distribués dans l’installateur.
- La compatibilité avec les variantes réelles de captures PS5 4K/HDR doit être vérifiée dès qu’un échantillon utilisateur est disponible.
- La validation couvre le moteur, les contrats, le démarrage natif et l’écran d’import à 1440 × 900 ; une passe manuelle reste utile sur plusieurs tailles de fenêtre et avec une vidéo longue.
- Le brief, l’analyse du contenu, la voix, les sous-titres, la timeline et le rendu final commencent uniquement en Phase 2.

## Commandes de reproduction

```powershell
npm install
npm test
& .\apps\desktop\scripts\build-sidecar.ps1
npm run tauri --workspace @gta-ai-studio/desktop -- build
```
