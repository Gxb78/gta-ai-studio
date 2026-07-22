# Rapport Phase 7 — Miniatures et métadonnées

## Résultat

Le flux local se termine désormais à `READY_TO_PUBLISH`. Après le rendu, `GENERATE_CREATIVE_PACKAGE` sélectionne les meilleures images observées, compose trois miniatures 1280×720 et crée 18 variantes éditoriales scorées pour YouTube Shorts, TikTok et Instagram Reels. Le Creative Studio permet de comparer les visuels et titres, copier les champs de publication et télécharger chaque JPEG ou le pack JSON complet.

## Livrables

- moteur CPU-first `creative_intelligence.py` pour classement, composition et metadata ;
- templates visuels `impact`, `clean` et `duo` rendus avec OpenCV ;
- catégories de titres direct, curiosité, question, comparaison, résultat et conseil ;
- descriptions, mots-clés, hashtags, texte miniature et commentaire épinglé ;
- score global et sous-scores inspectables pour chaque proposition ;
- provenance des frames et claims, avec exclusion explicite des sujets non vérifiés ;
- job persistant automatique et endpoint de rattrapage pour un ancien rendu Phase 6 ;
- migration `0008_phase7_creative_package.sql` et artefacts immuables ;
- API JPEG/JSON, types stricts et interface Creative Studio ;
- version produit 0.7.0.

## Décisions techniques

Les miniatures sont fabriquées uniquement depuis les frames du projet. Ce choix fournit immédiatement un flux fidèle, hors ligne et reproductible ; un futur `ImageProvider` pourra enrichir la composition sans devenir une dépendance du domaine. Le sujet libre du brief n’est utilisé dans un titre ou une miniature que s’il possède un ancrage OCR ou factuel admis. À défaut, les textes restent génériques et exacts.

Le score historique n’est pas simulé. Chaque variante conserve `history_score: null` et une raison `unavailable`, afin que la Phase 9 puisse alimenter le signal réel. Le schéma réutilise les tables `thumbnail_candidates` et `metadata_candidates` créées dès la fondation, enrichies et regroupées par `creative_packages`.

## Vérifications attendues pour la livraison

La livraison finale doit exécuter le typecheck, les tests TypeScript/Python/API, le test média Phase 7, la migration sur base vide et base existante, le build desktop, le smoke test du sidecar et l’installateur Windows. Les résultats réellement obtenus sont consignés dans le rapport final de la mission, sans être présumés ici.

## Limites

- aucune publication distante ni OAuth : périmètre Phase 8 ;
- aucun score de performance historique : périmètre Phase 9 ;
- aucune suppression générative du HUD ou segmentation spécialisée d’un véhicule ; les compositions utilisent les images observées et pénalisent les interfaces gênantes ;
- les hashtags sont des variantes éditoriales déterministes, pas des tendances temps réel.

## Étape suivante

Phase 8 — Publication : connexions OAuth, brouillons, envoi contrôlé, récupération des identifiants distants, gestion des erreurs et export de secours.
