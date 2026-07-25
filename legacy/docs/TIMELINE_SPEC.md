# Spécification de timeline

## Rôle

La timeline est la représentation canonique du montage. Les moteurs éditoriaux la produisent ; le render worker la valide puis la compile vers un plan FFmpeg sûr. Aucun LLM ne produit une chaîne shell.

## Temps

- Timebase rationnelle `numerator/denominator` (par défaut `1/1000`).
- Positions et durées entières dans cette timebase.
- FPS rationnel (`30000/1001` accepté), jamais un flottant pour les calculs.
- `sourceIn + sourceDuration` ne dépasse pas le média source connu.
- La durée de sortie d’un clip tient compte d’une vitesse rationnelle positive.

## Structure

`TimelineProject` contient :

- version de contrat, canvas, fps, timebase et durée ;
- tracks typées `video`, `audio`, `text`, `overlay` ;
- clips avec source, placement, trim, volume/opacité et effets déclaratifs ;
- transitions et markers ;
- zones sûres par plateforme ;
- provenance vers segments, script blocks et claims.

## Invariants de validation

- IDs uniques et références résolues.
- Valeurs temporelles non négatives ; durée strictement positive.
- Pas de chevauchement sur une track exclusive, sauf transition explicite.
- Textes dans la zone sûre et durée minimale lisible.
- Effets et codecs issus d’une allowlist versionnée.
- URI locales normalisées et contenues dans le projet ou la bibliothèque autorisée.
- Aucune source réseau implicite.
- Limites de résolution, FPS, nombre de tracks, clips et filtres.

## Compilation

Le render worker construit un graphe média typé, puis passe les arguments à FFmpeg comme tableau de paramètres via une API de processus sans shell. Les fichiers intermédiaires sont écrits dans un répertoire de job dédié. Les arguments, versions et empreintes sont auditables ; les secrets et chemins privés peuvent être pseudonymisés dans les logs.

## Effets Phase 6

- `subject_reframe` : mode borné, focus initial/final normalisé, hauteur de focus, confiance et méthode ;
- `zoom` : facteur `1.0..1.2` et raison éditoriale ;
- `speed` : facteur positif borné et durée source ajustée sans modifier la durée de sortie ;
- `comparison_split` : timecodes avant/après observés et layout versionné ;
- `overlay_template` : type de cue, clé de template, zone sûre et provenance factuelle ;
- `artifact_source` et `volume` : voix/ambiance séparées et mix inspectable.

Le renderer compile les recadrages en expressions de crop, synchronise `setpts` et `atempo`, réalise le split-screen, applique sous-titres puis overlays ASS, et termine par le mix sidechain/loudness. Les paramètres sont validés et bornés avant interpolation dans le filtre.

## Versionnement

`schemaVersion` protège la compatibilité. Une migration de timeline est pure et produit un nouvel artefact ; elle ne modifie pas silencieusement une timeline déjà rendue.

## Inspection interactive 0.7.1

Le Studio React projette la timeline canonique et le plan de montage avancé dans un inspecteur interactif. Le scrubber pilote le média local, le playhead synchronise les pistes vidéo, voix et overlays, et la waveform provient du signal audio réellement décodé par FFmpeg. Le panneau de recadrage interpole `focus_start_x`/`focus_end_x`, affiche le timecode source, la vitesse, le zoom et la méthode de tracking. Cette interface inspecte les décisions persistées ; elle ne modifie pas silencieusement la timeline ni le média source.

## Édition non destructive 0.7.2

Une session d’édition travaille sur une copie locale avec historique undo/redo borné. Déplacement, resize, split, duplication, suppression, focus manuel, activation d’overlay et texte produisent des commandes réversibles. La sauvegarde exige l’identifiant et le numéro de la révision de base : un conflit renvoie `TIMELINE_REVISION_CONFLICT` au lieu d’écraser un changement plus récent.

Chaque sauvegarde produit un nouvel `edit_project`, un état éditorial, une timeline canonique et un ASS d’overlays. Un texte modifié manuellement porte `manual_override` et perd ses anciens `supporting_claim_ids`. `RENDER_CLIP_PREVIEW` génère uniquement le plan demandé en 540×960, reste persistant/annulable et utilise le même focus, la même vitesse et le même fallback matériel que le renderer principal.
