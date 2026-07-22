# Passe d’amélioration 0.7.1 — avant Phase 8

## Périmètre

Cette passe améliore les Phases 1 à 7 sans démarrer OAuth, publication ou analytics.

## Expérience développeur

`scripts/start-dev.ps1` orchestre l’API FastAPI puis Tauri depuis `npm run dev`. Il attend un healthcheck réel, réutilise un backend existant et conserve la propriété exacte des processus à fermer.

## Accélération matérielle

Le backend détecte la carte NVIDIA et son pilote, inventorie les encodeurs matériels FFmpeg, vérifie OpenCV CUDA et les providers ONNX Runtime. NVENC est sélectionné seulement après un encode test réussi. Le profil `libx264` reste le fallback déterministe. Le diagnostic est consultable par API et visible dans la barre supérieure du desktop.

## Timeline Studio

Le panneau de montage dispose maintenant d’un lecteur synchronisé, d’un scrubber à 10 ms, d’un zoom horizontal, d’une waveform audio réelle, de pistes clips/overlays cliquables, de raccourcis clavier et d’un viseur de focus interpolé. Les timecodes source et sortie, le mode de recadrage, le zoom, la vitesse et la méthode de tracking sont visibles sans altérer les artefacts.

## Frontière de phase

La Phase 8 demeure explicitement non commencée. Aucun OAuth, upload ou brouillon distant n’est ajouté.
