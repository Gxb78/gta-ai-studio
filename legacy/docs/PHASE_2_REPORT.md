# Rapport Phase 2 — Premier vertical slice

## Résultat

La Phase 2 transforme désormais un MP4 local et un brief libre en vidéo verticale prête à exporter, sans timecode ni voix enregistrée. La chaîne reste CPU-first, hors ligne et sans fournisseur payant.

```text
MP4 + brief
  -> détection de scènes
  -> sélection temporelle
  -> script prudent
  -> voix Windows SAPI
  -> SRT + ASS
  -> timeline JSON validée
  -> cadrage 9:16 + mix/ducking
  -> MP4 H.264/AAC
  -> quality gate
```

## Capacités livrées

- Brief : durée de 3 à 180 s, presets, styles impact/cinématique/guide, hook et conclusion.
- Voix : sélection des voix Windows installées, débit réglable, génération WAV atomique.
- Audio : passe-haut/passe-bas, compression, normalisation, limitation, mix du rush et ducking par la voix.
- Montage : changements de scène FFmpeg, sélection de plusieurs plans et compilation depuis une timeline typée.
- Vertical : `smart_blur` pour préserver tout le rush ou `center_crop` plein écran.
- Sous-titres : SRT exportable et ASS incrusté, styles impact/minimal et safe area verticale.
- Persistance : briefs révisionnés, segments, scripts/blocs, voix, pistes/clips, rendus, checks et artefacts.
- Variantes : nouvelle intention sur le même projet, chemins versionnés, ancien export conservé.
- UX : suivi temps réel, reprise, aperçu vertical, téléchargement MP4/SRT, lecture voix, statistiques de timeline et quality gate.

## Validation exécutée

- 17 tests verts : 7 TypeScript, 3 Python contrats/migration et 7 intégration API.
- Le test Phase 2 exécute deux variantes complètes avec rendu média réel et vérifie aussi l’UTF-8 français.
- Rendu de référence contrôlé en 1080×1920, 30 fps, H.264/AAC, durée 3 s et cinq checks au vert.
- Frame du rendu inspectée : rush centré, fond vertical, sous-titre visible dans la safe area.
- Interface inspectée à 1440×1000, 1440×1200 et 1000×1100 : compositeur et dashboard sans débordement horizontal.
- Build frontend production validé.
- Sidecar PyInstaller validé après empaquetage avec FFmpeg, FFprobe, ressource TTS et voix `fr-FR`.
- Exécutable Tauri final lancé : API 0.2.0, base, worker, média et voix en état `ok`.
- Installateur NSIS : `apps/desktop/src-tauri/target/release/bundle/nsis/GTA AI Studio_0.2.0_x64-setup.exe`.

## Limites explicites

- Le découpage Phase 2 détecte des changements visuels ; il ne comprend pas encore la sémantique GTA.
- Le script traite le brief comme une intention et n’ajoute aucun fait. La preuve image/claim et l’identification de véhicules ou missions arrivent en Phase 3+.
- L’alignement des sous-titres est distribué sur la durée réelle de la voix, mais n’est pas encore un alignement phonème/mot forcé.
- Le QA média utilise le fixture local synthétique. Une campagne PS5 4K/HDR reste nécessaire pour mesurer performance, colorimétrie et compatibilité sur de longs rushs réels.
- Analytics, publication, Trend Radar, miniatures et apprentissage personnalisé restent hors périmètre.

## Étape suivante

Phase 3 : extraction d’images, OCR, taxonomie de scènes, événements et premier `GameAdapter` GTA V, en conservant la règle absolue de ne jamais présenter comme vérifiée une information seulement supposée.
