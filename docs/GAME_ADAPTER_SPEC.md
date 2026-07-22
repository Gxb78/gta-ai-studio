# Spécification Game Adapter

## But

Le noyau ne connaît ni la position du HUD GTA V, ni ses véhicules, ni ses menus. Un `GameAdapter` versionné traduit des images/segments génériques vers une taxonomie propre au jeu et fournit des templates éditoriaux. GTA VI doit pouvoir être ajouté sans modifier le domaine.

## Descripteur

Un adaptateur déclare :

- `id`, `gameId`, version sémantique et version de contrat ;
- versions/plateformes du jeu supportées ;
- langues, capacités et modèles/datasets requis ;
- namespace de connaissances et lexique de prononciation ;
- niveaux de confiance et limites connues.

## Capacités

- `detectGame(frame)`
- `detectHud(frame)`
- `detectMenus(frame)`
- `detectEntities(frame)`
- `detectEvents(segment)`
- `normalizeText(text, locale)`
- `resolveEntity(text, context)`
- `getContentTemplates(contentType)`
- `getExpectedEvents(contentType)`
- `getKnowledgeNamespace()`
- `getPronunciationLexicon(locale)`

Toutes les sorties incluent une confiance, une provenance de modèle/règle et, lorsque pertinent, une région de frame ou un intervalle temporel.

## Isolation

- L’adaptateur ne crée ni projet, ni job, ni timeline.
- Il n’écrit pas directement dans SQLite.
- Il ne publie pas et n’appelle pas un fournisseur sans passer par un port déclaré.
- Il reçoit des références de frames/segments, pas des chemins arbitraires.
- Un échec de détection renvoie un résultat vide explicite ou une erreur typée ; jamais une valeur GTA V par défaut.

## Compatibilité

Le noyau vérifie la version majeure du contrat au chargement. Une version incompatible est désactivée avec un diagnostic lisible. Les données GTA V et GTA VI utilisent des namespaces séparés ; aucun fait n’est promu d’un jeu à l’autre automatiquement.

## Implémentation Phase 3

`game-adapters/gta5/adapter.manifest.json` et `taxonomy.json` pilotent l’adaptateur GTA V local. Celui-ci combine OCR et métriques visuelles pour produire des candidats menus, écrans, transitions, événements textuels et montants monétaires visibles. Chaque inférence porte confiance, version de règle, frame/segment/timecode et `fact_status=inferred_candidate`.

L’adaptateur ne contient pas de modèle d’identification de véhicule et ne convertit jamais le brief en détection. GTA VI utilise pour l’instant l’adaptateur visuel générique, sans taxonomie GTA V.

## Implémentation Knowledge Phase 5

Chaque adaptateur peut exposer `knowledge/manifest.json` et un fichier d’items versionné. Le chargeur refuse un manifest dont `game_id` et `namespace` ne correspondent pas au jeu demandé. Le pack GTA V initial ne contient que cinq correspondances de terminologie déjà issues de sa taxonomie locale (moteur, freins, peinture, roues, aileron) ; il ne contient ni prix, ni statistique, ni récompense. Le pack GTA VI est volontairement vide et aucune donnée GTA V n’y est copiée.
