# Éditeur de timeline non destructif 0.7.2

## Résultat

La timeline Phase 6 est désormais un éditeur persistant : réorganisation par glisser-déposer ou boutons, resize à la poignée, découpe au playhead, duplication, suppression, réglages source/durée/zoom, keyframes de focus, overlays activables et textes éditables.

## Historique et révisions

Les actions de montage alimentent un historique local de 80 états avec `Ctrl+Z`, `Ctrl+Y` et boutons dédiés. La sauvegarde vérifie la révision de base puis crée un nouvel `edit_project`; elle ne met jamais à jour une timeline existante. Une note libre documente la révision.

## Preview ciblée

Le bouton « Régénérer uniquement ce plan » sauvegarde d’abord les changements éventuels puis enfile `RENDER_CLIP_PREVIEW`. FFmpeg ne lit que l’intervalle source sélectionné et génère un MP4 540×960 avec recadrage, interpolation du focus, zoom, vitesse, audio et fallback CPU/GPU. Le résultat reste attaché à la révision et au plan.

## Frontière factuelle

Une modification manuelle de texte est visible comme `MANUEL · NON VÉRIFIÉ`. Les claims précédemment liés sont retirés afin que le contenu utilisateur ne soit pas présenté comme une affirmation validée par le système.

## Hors périmètre

Cette passe ne démarre pas la Phase 8 et n’ajoute ni OAuth, publication, analytics ni transmission externe.
