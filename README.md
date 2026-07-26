# GTA Studio

Éditeur de montage local, ultra-fluide, pour transformer des rushs GTA en vidéos verticales prêtes pour TikTok (1080×1920).

Le principe : à l'import, l'app prépare un proxy 720p à GOP courtes. Ensuite, toute l'édition (lecture, scrubbing, cuts, trims, réorganisation, undo) se passe côté client sur ce proxy — zéro serveur, zéro réencodage, zéro latence. FFmpeg ne travaille qu'à deux moments : l'import et l'export final, qui repart du rush original en pleine qualité.

## Prérequis

- Windows, Node ≥ 22 et Rust (toolchain MSVC)
- Pour le développement : FFmpeg + FFprobe dans le `PATH`

## Démarrer

```powershell
npm install
npm run tauri dev
```

## Construire l'installateur

```powershell
npm run tauri build
```

Le build copie automatiquement FFmpeg et FFprobe depuis
`GTA_STUDIO_FFMPEG_DIR` ou depuis le `PATH`, puis les embarque dans
l'installateur. Les exécutables provisionnés sous `src-tauri/binaries/` sont
générés localement et ne sont pas versionnés.

## Raccourcis

Espace : lecture/pause · S : couper au playhead · Suppr : supprimer le clip · Ctrl+Z / Ctrl+Y : annuler/rétablir · ← / → : image par image (Maj : ±1 s) · Ctrl+molette : zoom timeline · Glisser les bords d'un clip : trim (aimanté au playhead) · Glisser un clip : réorganiser

## Structure

- `src/` — interface React : état d'édition (EDL + undo), moteur de lecture, timeline virtualisée
- `src-tauri/src/` — commandes Rust : probe/proxy/vignettes/waveform, export FFmpeg, projets JSON
- `docs/PLAN.md` — feuille de route par couches
- `docs/LEGACY_SALVAGE.md` — décisions récupérées de l'ancienne application

Les données de l'app (proxies, projets, exports) vivent dans `%APPDATA%/studio.gta.editor`.
