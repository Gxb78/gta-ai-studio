# Feuille de route

Une couche à la fois. Chaque couche doit laisser l'éditeur plus utile sans jamais dégrader la fluidité (voir les budgets de performance dans `CLAUDE.md`).

## v0.1 — Couper vite (en cours)

Import d'un rush → montage par cuts → export TikTok.

Critères d'acceptation :

- Import mp4/mov/mkv/m4v avec progression ; proxy, vignettes et waveform mis en cache par empreinte (réimporter le même rush est instantané).
- Lecture et scrubbing instantanés sur le proxy ; le montage (split, trim, suppression, réorganisation, undo/redo 100 niveaux) ne déclenche aucun réencodage.
- Trim avec retour visuel image par image et aimant au playhead.
- Export 1080×1920 depuis le rush original : recadrage centré ou fond flou, progression visible, fichier ouvert dans l'explorateur à la demande.
- Projet sauvegardé automatiquement, rouvert au lancement.

Reste à faire sur cette couche (petites finitions attendues après le premier `tauri dev`) : corrections de compilation éventuelles, réglage fin du feel (seuils d'aimantation, sensibilité du zoom), lecture sans à-coups aux frontières de clips si le GOP 15 ne suffit pas (option : double élément vidéo en ping-pong).

## v0.2 — Confort

- Drag & drop d'un fichier sur la fenêtre.
- Plusieurs rushs par projet ; bibliothèque des projets récents.
- Vitesse par clip (x0.25–x4), volume/mute et fondus audio par clip.
- Recadrage 9:16 ajustable (décalage horizontal du crop par clip, aperçu dans le guide).
- Miniatures de meilleure qualité, densité adaptative au zoom.

## v0.3 — Habillage

- Texte/titres avec styles TikTok, positionnés dans le guide 9:16.
- Piste musique avec ducking simple.
- Transitions simples (cut, fondu) — uniquement si mesurées sans impact sur la fluidité.
- Sous-titres automatiques : transcription en tâche de fond (jamais dans la boucle d'interaction), édition du texte, incrustation à l'export.

## v0.4+ — IA d'aide au montage

- Détection de moments forts (audio + mouvement) sur le proxy, en fond.
- Suggestions de cuts : « garde ces 3 passages », premier jet de montage à partir d'un brief court.
- Consulter la carte `docs/LEGACY_SALVAGE.md` et, seulement si nécessaire, le tag
  `legacy-v0.7.2-archive`, sans réintroduire le pipeline HTTP/SQLite/jobs.

## Dette assumée de la v0.1 (à traiter quand ça gêne)

- Un seul rush par projet ; un seul projet « dernier ouvert ».
- Pas de nettoyage automatique des caches (`proxies/`, `thumbs/`) — ajouter une commande « vider le cache » en v0.2.
- Empreinte rapide (taille + blocs de début/fin) et non hash complet : suffisant en local, à documenter si on synchronise un jour.
- `reveal_path` ouvre le dossier sans sélectionner le fichier.
