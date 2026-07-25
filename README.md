# GTA Studio

Éditeur de montage local, ultra-fluide, pour transformer des rushs GTA en vidéos verticales prêtes pour TikTok (1080×1920).

Le principe : à l'import, l'app prépare un proxy 720p à GOP courtes. Ensuite, toute l'édition (lecture, scrubbing, cuts, trims, réorganisation, undo) se passe côté client sur ce proxy — zéro serveur, zéro réencodage, zéro latence. FFmpeg ne travaille qu'à deux moments : l'import et l'export final, qui repart du rush original en pleine qualité.

## Prérequis

- Windows, Node ≥ 22, Rust (toolchain MSVC), FFmpeg + FFprobe dans le PATH

## Démarrer

```powershell
npm install
npm run tauri dev
```

## Raccourcis

Espace : lecture/pause · S : couper au playhead · Suppr : supprimer le clip · Ctrl+Z / Ctrl+Y : annuler/rétablir · ← / → : image par image (Maj : ±1 s) · Ctrl+molette : zoom timeline · Glisser les bords d'un clip : trim (aimanté au playhead) · Glisser un clip : réorganiser

## Structure

- `src/` — interface React : état d'édition (EDL + undo), moteur de lecture, timeline virtualisée
- `src-tauri/src/` — commandes Rust : probe/proxy/vignettes/waveform, export FFmpeg, projets JSON
- `docs/PLAN.md` — feuille de route par couches
- `legacy/` — ancienne application archivée (consultation uniquement)

Les données de l'app (proxies, projets, exports) vivent dans `%APPDATA%/studio.gta.editor`.
