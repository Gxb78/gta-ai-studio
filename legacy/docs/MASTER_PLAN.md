# Plan maître

## Vision

GTA AI Studio doit rendre la production d’un contenu GTA aussi simple que : enregistrer un rush cohérent sur PS5, copier le fichier sur le PC, expliquer le résultat souhaité en français et lancer la création. Le studio doit retrouver les plans, construire une narration, vérifier les affirmations, synthétiser la voix, monter, sous-titrer, contrôler puis exporter le contenu.

L’utilisateur reste le directeur créatif. Le logiciel devient l’équipe de production.

## Gouvernance opérationnelle

Le plan maître décrit la destination du produit. Le fichier racine [`AGENTS.md`](../AGENTS.md) décrit comment Codex doit travailler pour l’atteindre : architecture à préserver, portée des phases, commandes de validation, règles factuelles, sécurité et définition de terminé. Les instructions spécialisées futures doivent rester proches de leur sous-arbre et ne contenir que les contraintes locales qui diffèrent réellement.

## Parcours cible

1. Un rush de 5 à 20 minutes porte généralement sur un sujet principal.
2. Un brief libre décrit le sujet, l’objectif, les éléments à montrer/éviter, le format, le rythme et la durée.
3. Le studio reformule son interprétation en `EditorialBrief` structuré.
4. L’analyse cherche les événements demandés et produit des segments avec niveaux de confiance.
5. Une Narrative Map classe chaque intention comme trouvée, partielle, ambiguë, absente, contredite ou inutilisable.
6. Le script ne s’appuie que sur les plans et faits disponibles.
7. La voix, les sous-titres et la timeline restent des artefacts versionnés et traçables.
8. Le rendu passe des contrôles techniques, éditoriaux, factuels, audio et plateforme.
9. Les métriques futures améliorent le classement sans dégrader la vérité ni la lisibilité.

## Ordre de décision

1. Contraintes explicites de l’utilisateur.
2. Contenu réellement visible dans le rush.
3. Informations vérifiées dans la base GTA appropriée.
4. Préférences apprises du créateur.
5. Bonnes pratiques éditoriales.
6. Tendances de plateforme.

Le niveau 1 ne remplace jamais les niveaux 2 et 3 comme preuve : une demande peut être absente du rush ou factuellement incorrecte.

## Domaines métier

- **Projects** : agrégat racine, configuration, progression et historique.
- **Editorial Intent** : brief libre, contraintes, ambiguïtés et objectifs.
- **Media Library** : sources, empreintes, dérivés, métadonnées et provenance.
- **Analysis** : segments, OCR, entités, événements, scores et résumés.
- **Narrative** : couverture du brief, beats, plans de contenu et scripts.
- **Evidence & Knowledge** : claims, preuves, statut de certitude et namespaces par jeu.
- **Voice** : synthèse, lexique, alignement, normalisation et provenance.
- **Timeline & Render** : montage déclaratif, validation et compilation média.
- **Quality** : checks, scores, gates, corrections et rapports.
- **Creative Package** : sélection d’images, miniatures, titres, descriptions, hashtags, variantes plateforme, scores et provenance.
- **Providers** : capacités externes interchangeables, coûts, limites et santé.
- **Jobs & Orchestration** : dépendances, leases, reprise, retry et cache.
- **Game Adapters** : taxonomie, détecteurs et lexiques propres à un jeu.
- **Observability** : logs, audit, traces, coûts et diagnostics.
- **Publishing & Analytics** : futurs exports, publications, métriques et apprentissage.

## Premier vertical slice visé

```text
MP4 GTA V + brief libre
  -> brief structuré
  -> analyse guidée
  -> sélection des plans
  -> script sourcé
  -> voix française
  -> sous-titres
  -> timeline verticale
  -> rendu local
  -> rapport qualité
  -> miniatures et métadonnées scorées
  -> prêt à publier
```

Le résultat attendu est un Short vertical autour de la durée demandée, sans invention, sans temps morts importants, avec résultat final visible et voix/sous-titres synchronisés.

## Limite actuelle

La Phase 7 prolonge le Short local jusqu’à `READY_TO_PUBLISH`. Un moteur CPU-first classe les frames observées, fabrique trois miniatures 1280×720, puis génère et score six catégories de titres ainsi que descriptions, mots-clés, hashtags et commentaire épinglé pour trois plateformes. La provenance relie chaque visuel à ses frames et chaque proposition à la frontière factuelle. L’historique de compte reste explicitement indisponible avant les analytics de Phase 9. Aucun OAuth, envoi réseau ou fournisseur payant n’est intégré.

## Mesures finales

- Taux de projets terminés et repris avec succès.
- Respect du brief et couverture des éléments obligatoires.
- Zéro affirmation importante sans preuve ou niveau d’incertitude explicite.
- Qualité audio/vidéo, durée, synchronisation et compatibilité plateforme.
- Réduction du temps et des interventions manuelles.
- Rétention, complétion, clics et performance par format lorsque la publication existera.
