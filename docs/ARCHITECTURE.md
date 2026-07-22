# Architecture

## Style retenu

Le produit commence comme un **modular monolith local** composé d’une application desktop, d’une API locale et de workers spécialisés exécutés sur la même machine. Les frontières sont des contrats de données versionnés, pas des microservices réseau imposés. Ce choix conserve l’isolation des traitements lourds sans introduire Redis, Kubernetes ou une infrastructure distribuée prématurée.

## Composants

```text
Tauri + React
      |
      | HTTP local versionné + événements de progression
      v
FastAPI (composition root, auth locale, validation)
      |
      +--> Domain services (aucun fournisseur ni jeu concret)
      +--> SQLite WAL (état, queue, audit, metadata)
      +--> Local artifact store (vidéos, images, audio, JSON)
      +--> Persistent job engine
                 |
                 +--> media worker (FFmpeg/FFprobe/OpenCV)
                 +--> intelligence worker (brief, vision, OCR, script)
                 +--> render worker (timeline -> plan média sûr)
                 +--> publisher worker (futur)

Domain ports <---- provider adapters (local/API/GPU futur)
Game port   <---- GTA V adapter / GTA VI adapter
```

## Règle de dépendance

Les dépendances pointent vers l’intérieur :

1. `contracts` ne dépend d’aucun framework applicatif.
2. `domain`, `timeline-engine`, `quality-engine` dépendent seulement des contrats et utilitaires purs.
3. `provider-interfaces` et le contrat `GameAdapter` sont des ports ; leurs implémentations vivent à l’extérieur.
4. `database`, `job-engine` et `observability` implémentent des capacités techniques sans introduire de règles éditoriales.
5. L’API et les workers assemblent les implémentations ; React n’héberge aucune règle critique.

Un import direct d’un SDK OpenAI, Google, AWS ou d’un modèle GTA dans `domain` est interdit.

## Contrats inter-processus

- JSON UTF-8 avec `schemaVersion` explicite.
- Horodatages UTC RFC 3339.
- Durées en millisecondes pour les médias ; timebase rationnelle pour la timeline.
- Identifiants UUID v7 générés côté application.
- Champs inconnus rejetés aux frontières critiques, tolérés uniquement lors d’une migration documentée.
- Événements et artefacts immuables ; les agrégats mutables utilisent `row_version` pour le contrôle optimiste.

## Stockage

- **SQLite WAL** : métadonnées, états, jobs, index et audit.
- **Filesystem** : médias lourds et artefacts dérivés, référencés par URI locale et empreinte SHA-256.
- **Artifact cache** : clé composée de l’étape, version d’algorithme, version de modèle, paramètres normalisés et empreintes d’entrée.
- **Outbox** : les événements durables sont validés dans la même transaction que l’état qui les produit.

Les BLOB vidéo/audio ne sont pas stockés dans SQLite.

## Processus et reprise

Chaque worker acquiert un job par lease borné. Un heartbeat prolonge le lease ; un job orphelin redevient éligible après expiration. Les étapes écrivent d’abord un artefact temporaire, vérifient son empreinte, puis effectuent un renommage atomique et enregistrent le résultat. Un rendu échoué ne réexécute ni l’analyse ni la voix si leurs clés de cache restent valides.

Le flux Phase 7 prolonge les frontières persistantes jusqu’au pack prêt à publier :

```text
ANALYZE_GAMEPLAY
  -> BUILD_NARRATIVE_MAP (beats + couverture + demandes de rush)
  -> PLAN_CONTENT (direct + storytelling + très dynamique)
  -> VERIFY_FACTS (claims + preuves + connaissances du namespace du jeu)
  -> GENERATE_SCRIPT (plan sélectionné, formulations factuelles admises uniquement)
  -> SYNTHESIZE_VOICE
  -> PLAN_ADVANCED_EDIT (tracking + reframing + overlays + mix)
  -> BUILD_TIMELINE
  -> RENDER_VERTICAL
  -> GENERATE_CREATIVE_PACKAGE (sélection + miniatures + metadata)
  -> READY_TO_PUBLISH
```

Les règles de correspondance sont CPU-first et indépendantes du fournisseur. Les termes GTA spécifiques restent produits par le `GameAdapter`; le moteur narratif ne fait que consommer des observations normalisées. Le gate factuel n’exécute aucune commande et n’invente aucune connaissance : il relie une observation qualifiante, une connaissance vérifiée du bon namespace ou exclut le claim.

`GENERATE_CREATIVE_PACKAGE` réutilise uniquement les `analysis_frames` du projet. OpenCV classe puis compose localement trois JPEG ; aucun visuel de concurrent et aucune image générée ne sont introduits. Le metadata engine produit des variantes déterministes par plateforme, conserve les sous-scores et marque le signal historique comme indisponible jusqu’à la Phase 9. Un projet Phase 6 déjà rendu peut lancer ce job seul, sans recalculer analyse, voix, timeline ou rendu.

`PLAN_ADVANCED_EDIT` combine les régions de preuves visibles et une estimation locale de l’attention visuelle. Sa sortie est un artefact JSON déterministe : points de suivi, focus par clip, fallback, zoom, vitesse, comparaison, transitions, overlays, mix et raisons. Le renderer ne reçoit jamais une commande libre ; il compile ces valeurs bornées en graphe FFmpeg. Les overlays factuels sont limités aux claims déjà admis par `VERIFY_FACTS`.

## API locale

Implémentée sous `http://127.0.0.1:8765/api/v1`. Elle écoute uniquement sur la boucle locale. L’application Tauri démarre et arrête le sidecar FastAPI, vérifie sa version et reçoit la progression projet via Server-Sent Events. Le worker Phase 1 partage le processus du sidecar mais garde une frontière de service et une queue SQLite persistante ; une séparation en processus reste possible sans changer les contrats.

## CPU-first

- FFmpeg/FFprobe et traitements déterministes locaux par défaut.
- Au démarrage, le backend inventorie `nvidia-smi`, les encodeurs FFmpeg, OpenCV CUDA et les providers ONNX Runtime.
- `h264_nvenc` n’est activé qu’après un mini-encodage réussi ; toute absence ou erreur de capacité sélectionne `libx264` sans rendre le GPU obligatoire.
- Le diagnostic structuré est exposé par `GET /api/v1/system/hardware` et résumé dans `/health`.
- OCR local lorsque le coût/latence reste acceptable.
- Prévisualisations et proxies avant toute analyse lourde.
- Concurrence bornée par type de ressource (CPU, RAM, disque, réseau).
- Modèles lourds accessibles par provider facultatif ; aucun GPU haut de gamme n’est requis.

## Évolution

Une séparation en services réseau ne devient justifiée qu’avec plusieurs machines, plusieurs utilisateurs ou une charge distante. PostgreSQL, Redis et un ordonnanceur distribué restent hors périmètre tant que ces besoins ne sont pas mesurés.
