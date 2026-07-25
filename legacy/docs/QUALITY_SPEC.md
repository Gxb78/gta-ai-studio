# Spécification qualité

## Philosophie

Le contrôle qualité sépare les mesures objectives, les évaluations éditoriales et les décisions de publication. Un score élevé ne peut pas compenser un blocker factuel ou technique.

## Dimensions

- `technical` : décodage, durée, résolution, FPS, écrans noirs, silence, saturation.
- `editorial` : respect du brief, sujet, hook, structure, rythme, répétitions.
- `factual` : claims sourcés, fraîcheur, contradictions voix/image, identité des entités.
- `audio` : intelligibilité, loudness, coupures, ducking, prononciation.
- `subtitle` : présence, synchronisation, densité, zones sûres, fidélité à la narration.
- `visual` : netteté, cadrage, sujet visible, overlays et transitions.
- `platform` : ratio, durée, codecs et zones d’interface.

## Résultat d’un check

Chaque check contient `checkId`, version, dimension, statut (`pass`, `warn`, `fail`, `skipped`), sévérité, mesure, seuil, preuve, message et proposition de correction. Un check `skipped` doit expliquer pourquoi ; il n’est jamais assimilé à `pass`.

## Gates

Blockers par défaut :

- fichier illisible ou sortie absente ;
- affirmation importante contredite ou sans niveau de certitude admissible ;
- média obligatoire manquant lorsque le script l’affirme ;
- écran noir/silence prolongé au-delà du seuil ;
- sous-titres absents lorsque requis ;
- contenu hors des limites de rendu ou chemin non autorisé.

Le score global est une moyenne pondérée seulement après validation des blockers. Les seuils sont versionnés par template et plateforme.

## Boucle de correction

Un échec corrigible génère une action précise et un nouveau cycle `CORRECTED -> DRAFT_RENDERED -> QC_ANALYZED`. Le nombre de cycles est borné. Au-delà, le projet passe en révision ou en échec final ; il ne boucle jamais indéfiniment.

## Traçabilité

Tout check référence le rendu, la version du moteur, les paramètres et les preuves. Les décisions utilisateur d’accepter un warning restent auditées et ne transforment pas l’observation historique en succès.

En Phase 5, le check `factual_safety` compare les `supporting_claim_ids` factuels réellement ajoutés par le script aux claims admis par le `verification_run`. Tout identifiant hors gate produit un blocker. Le message final indique séparément le nombre d’affirmations sourcées et le nombre de claims exclus.

En Phase 6, `overlay_factual_safety` applique la même frontière aux graphismes. `subject_tracking` réussit soit avec un focus dynamique qualifié, soit avec un fallback de cadrage explicite ; une confiance faible ne produit jamais un crop erratique. `purposeful_effects` expose les nombres de recadrages, zooms, accélérations et comparaisons. `advanced_audio_mix` atteste le profil voix prioritaire et sa cible de loudness.

En Phase 7, `thumbnail_valid` vérifie la présence de trois JPEG 1280×720 issus uniquement des frames observées. Le score miniature sépare qualité de source, lisibilité mobile, composition, fidélité et sécurité clickbait. `metadata_factual_safety` atteste qu’un sujet du brief non confirmé est exclu des affirmations ; précision, pertinence, longueur, originalité, cohérence vidéo et sécurité clickbait restent visibles séparément. L’historique du compte n’est ni simulé ni remplacé par une constante : il porte le statut `unavailable` jusqu’à la Phase 9.
