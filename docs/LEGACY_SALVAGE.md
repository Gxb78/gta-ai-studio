# Carte de récupération de l'ancienne application

La base active est l'application Tauri 2 + React à la racine. L'ancienne
application a été auditée puis retirée de la branche active le 26 juillet 2026.
Son dernier état complet est conservé par le tag Git
`legacy-v0.7.2-archive`.

## Règles

- Réécrire les capacités retenues derrière des commandes et types Rust.
- Garder l'édition, le scrubbing et la lecture côté client.
- Utiliser FFmpeg uniquement pour l'import, l'analyse asynchrone et l'export.
- Ne pas réintroduire FastAPI, HTTP local, SQLite, workers ou queue de jobs.
- Une analyse produit des preuves, marqueurs ou suggestions ; elle ne modifie
  jamais directement la timeline.

## Carte

| Brique legacy | Décision | Destination active | État |
| --- | --- | --- | --- |
| Diagnostic FFmpeg/NVENC | Porter en Rust | `src-tauri/src/hardware.rs` | Porté |
| Repli NVENC vers CPU | Porter en Rust | `src-tauri/src/media.rs` | Porté |
| Distribution FFmpeg | Embarquer comme ressource | `src-tauri/binaries/` | Porté |
| Détection de scènes | Réécrire | `src-tauri/src/analysis/scenes.rs` | Futur |
| Attention visuelle | Conserver l'algorithme | `analysis/visual_attention/` | Futur |
| Cadrage dynamique | Réécrire | `src-tauri/src/render/crop.rs` | Futur |
| Recettes vidéo FFmpeg | Extraire et typer | `src-tauri/src/render/` | Partiel |
| Recettes audio FFmpeg | Extraire et typer | `src-tauri/src/render/audio.rs` | Futur |
| Templates de montage | Simplifier | `templates/editing/` | Futur |
| Game Adapters | Extraire les données | `game-adapters/` | Futur |
| Preuves et confiance | Simplifier | `src/analysis/` | Futur |
| Miniatures de publication | Réécrire | futur onglet Pack publication | Futur |
| FastAPI/SQLite/jobs | Abandonner | aucune | Définitif |
| Ancienne interface | Abandonner | aucune | Définitif |
| Voix automatique | Abandonner pour ce produit | aucune | Définitif |

## État de l'archive

- Les capacités déjà portées sont identifiées dans la carte ci-dessus.
- Les composants abandonnés ne font plus partie du checkout ni des builds.
- Toute consultation future doit se faire depuis le tag, dans un checkout
  séparé, sans réintroduire FastAPI, SQLite ou les files de jobs.
