# GTA AI Studio — Instructions permanentes pour Codex

Ce fichier est la constitution opérationnelle du dépôt. Il s’applique à tous les fichiers, sauf lorsqu’un `AGENTS.md` ou `AGENTS.override.md` plus proche ajoute des règles propres à un sous-répertoire.

Maintenir ce fichier concis et applicable. Placer les détails produit dans `docs/` et les contraintes spécialisées dans un fichier d’instructions imbriqué uniquement lorsqu’une zone en a réellement besoin.

## 1. Mission

GTA AI Studio est une application Windows locale qui transforme un rush GTA et un brief écrit en contenu vidéo prêt à publier : import, analyse, sélection des plans, script, voix synthétique, montage, sous-titres, contrôles qualité et export. Les futures phases ajouteront publication et apprentissage mesuré.

L’utilisateur ne doit pas être obligé de fournir sa voix, des timecodes, un script complet, des sous-titres manuels ou de maîtriser un logiciel de montage.

Devise : **toujours s’améliorer, sans perdre en fiabilité**.

Une optimisation ne doit pas dégrader fortement la fidélité au brief, la fiabilité factuelle, la qualité technique, la traçabilité, la maintenabilité, la sécurité ou la reproductibilité.

## 2. Sources de vérité

Avant une tâche importante, lire ce fichier puis les documents pertinents :

1. instruction explicite de la tâche en cours et décisions utilisateur récentes ;
2. `docs/MASTER_PLAN.md` ;
3. `docs/ARCHITECTURE.md` ;
4. `docs/DATA_MODEL.md` ;
5. `docs/PIPELINE_STATES.md` ;
6. `docs/GAME_ADAPTER_SPEC.md` ;
7. `docs/PROVIDER_SPEC.md` ;
8. `docs/TIMELINE_SPEC.md` ;
9. `docs/QUALITY_SPEC.md` ;
10. `docs/SECURITY.md` ;
11. `docs/DEV_RULES.md` ;
12. `docs/ROADMAP.md` ;
13. décisions consignées dans `docs/decisions/`.

En cas de contradiction : ne pas choisir silencieusement, identifier les textes concernés, appliquer l’instruction explicite la plus récente, documenter la décision et corriger les documents devenus obsolètes.

## 3. Périmètre et phases

- Identifier la phase concernée et ses critères d’acceptation avant de coder.
- Ne pas implémenter plusieurs phases majeures dans une même tâche sans instruction explicite.
- Implémenter, vérifier, documenter, produire le rapport final, puis s’arrêter.
- Les contrats, points d’extension et migrations justifiés sont permis ; les grandes fonctionnalités futures inutilisées ne le sont pas.
- Ne pas introduire prématurément cloud complexe, microservices, Kubernetes, multi-utilisateur, clone de Premiere Pro, gros modèle personnalisé, bot console, moteur universel ou publication autonome.

État courant : Phases 0 à 7 terminées. Ne pas commencer la Phase 8 ou une phase ultérieure sans instruction explicite.

## 4. Architecture obligatoire

### Desktop

- Tauri, React, TypeScript strict et Vite.
- React gère affichage, saisie, prévisualisation, progression, réglages et résultats.
- Aucune logique métier critique dans l’interface.

### Backend local

- Python 3.12+, FastAPI, Pydantic et API locale versionnée.
- Le backend orchestre projets, analyses, providers, scripts, voix, timeline, rendu et qualité.
- Le modular monolith actuel peut héberger plusieurs frontières de workers dans un même sidecar ; ne pas imposer des processus réseau sans besoin mesuré.

### Données

- SQLite WAL pour l’état local ; médias lourds dans le filesystem.
- Toute évolution du schéma passe par une migration SQL append-only et versionnée.
- Ne jamais modifier manuellement un schéma de production.

### Média

- FFmpeg, FFprobe, OpenCV et traitements validés.
- Construire les commandes depuis des objets typés et des valeurs autorisées.
- Ne jamais exécuter une commande shell libre produite par un modèle génératif.

Les dépendances pointent vers l’intérieur : contrats et domaine ne dépendent ni de React, ni d’un jeu concret, ni d’un SDK fournisseur.

## 5. Séparation noyau, jeux et fournisseurs

Le noyau reste indépendant de GTA V et GTA VI. Toute connaissance de HUD, menu, véhicule, mission, catégorie, lexique ou règle propre au jeu vit sous :

```text
game-adapters/
  gta5/
  gta6/
```

Toute logique spécifique passe par le contrat `GameAdapter`. Ne jamais promouvoir automatiquement une donnée GTA V vers GTA VI.

Aucun fournisseur externe ne doit être couplé au domaine. Exposer les capacités derrière des ports comme `LlmProvider`, `VisionProvider`, `OcrProvider`, `TranscriptionProvider`, `TtsProvider`, `ImageProvider`, `EmbeddingProvider`, `PublishingProvider` et `AnalyticsProvider`.

Chaque provider déclare identifiant, capacités, configuration, limites, erreurs, délais, coût estimé, métriques et stratégie de remplacement. Aucun secret ni nom de fournisseur concret dans le domaine.

## 6. CPU-first et dégradation propre

- Le produit doit fonctionner sur un portable Windows sans GPU haut de gamme.
- Préférer média, OCR et opérations légères en local.
- Placer les tâches lourdes derrière des interfaces remplaçables.
- Prévoir API distante ou serveur GPU uniquement comme capacités optionnelles.
- Une capacité absente doit produire un diagnostic clair ou une dégradation explicite, jamais un faux résultat.

## 7. Conventions de code

### TypeScript

- Mode strict ; éviter `any`.
- Types explicites et validation des entrées externes.
- Séparer domaine, infrastructure et interface.
- Éviter fonctions excessivement longues, dépendances circulaires et objets non structurés aux frontières.

### Python

- Typer toutes les fonctions publiques.
- Utiliser Pydantic aux frontières ; préférer des modèles/DTO définis aux dictionnaires arbitraires entre couches.
- Utiliser des erreurs métier explicites.
- Ne pas masquer une exception sans journalisation.

### Général

- Fonctions petites, noms descriptifs et commentaires réservés aux décisions non évidentes.
- Aucun secret, code mort, pseudo-code présenté comme terminé ou valeur magique importante non configurée.
- Justifier toute dépendance nouvelle, surtout si elle est lourde.
- Conserver JSON UTF-8, durées média en millisecondes, horodatages UTC, UUID v7 et empreintes SHA-256.

## 8. Jobs, états, idempotence et reprise

Tout traitement long est un job persistant avec identifiant, type, projet, état, progression, dates, tentatives, erreur, paramètres, dépendances et clé d’idempotence.

Un job doit être observable, annulable, relançable et récupérable après redémarrage. Son unique état ne doit jamais vivre seulement en mémoire.

Respecter `docs/PIPELINE_STATES.md`. Toute transition doit être autorisée, atomique, auditée, horodatée et testée. Ne jamais modifier directement le stage d’un projet hors service de transition. Une nouvelle transition exige contrat, migration si nécessaire, tests et documentation.

Avant de recalculer, considérer empreinte d’entrée, version d’algorithme/modèle/provider, paramètres et artefact valide en cache. Un échec tardif ne doit pas forcer l’ingestion, l’analyse, le script ou la voix à recommencer lorsque leurs artefacts restent valides.

## 9. Fichiers et artefacts

- Les sources utilisateur sont immuables et ne sont jamais écrasées silencieusement.
- Valider tout chemin utilisateur et bloquer path traversal, collisions et sorties hors racine gérée.
- Utiliser écritures temporaires, synchronisation si nécessaire, puis renommage atomique.
- Les dérivés restent séparés sous `source/`, `proxy/`, `audio/`, `frames/`, `analysis/`, `scripts/`, `voice/`, `timelines/`, `renders/`, `thumbnails/`, `exports/` et `reports/`.
- Toute suppression est explicite, ciblée et signalée.
- Ne pas laisser de fichiers temporaires produits par la tâche.

## 10. Brief, observations et fiabilité factuelle

Le brief exprime l’intention ; il ne prouve jamais que le rush contient ce qui est demandé.

Priorité : contraintes utilisateur, contenu visible, connaissances vérifiées, préférences apprises, heuristiques éditoriales, tendances.

Ne jamais inventer une séquence absente. Lorsqu’un élément obligatoire manque : le marquer, adapter le script, proposer une alternative et demander un rush précis seulement si nécessaire.

Chaque affirmation importante doit pouvoir remonter à une séquence, un texte détecté, une donnée du jeu, une source validée, un fait versionné ou une preuve reproductible. Conserver des statuts explicites tels que `hypothesis`, `observed_once`, `reproduced`, `verified`, `contradicted`, `outdated` et `unknown`. Ne jamais transformer silencieusement une hypothèse en fait.

Les résultats OCR sont des observations probabilistes. Les menus, écrans, événements et entités inférés restent des candidats scorés tant qu’une preuve plus forte ne les vérifie pas.

## 11. Voix synthétique

- La voix est accessible via `TtsProvider` ; l’utilisateur n’enregistre pas obligatoirement la sienne.
- Ne pas cloner une célébrité ni imiter volontairement un créateur identifiable.
- Ne pas dépendre d’un seul fournisseur et ne jamais stocker de clé dans le dépôt.
- Gérer la prononciation GTA dans un lexique versionné propre au jeu.

## 12. Sécurité

- Aucun secret dans le dépôt ou les logs.
- Valider toute entrée externe et tout chemin.
- Requêtes SQL paramétrées ; commandes média allowlistées ; aucune exécution arbitraire.
- Timeouts, limites de ressources et journalisation expurgée pour les appels externes.
- Contrôler explicitement les données transmises à un provider.
- Ne pas désactiver un contrôle pour faire passer un test.
- Toute exception de sécurité doit être minimale, justifiée, documentée et testée.

## 13. Git et respect du travail existant

Avant de modifier : exécuter `git status` et inspecter les fichiers concernés. Le dépôt peut contenir des changements utilisateur non liés ; les préserver.

Ne jamais supprimer une modification inconnue, réinitialiser brutalement, réécrire l’historique ou mélanger des objectifs indépendants. Utiliser `apply_patch` pour les modifications ciblées. Créer un commit uniquement si demandé.

Après modification : inspecter les changements concernés et `git status`. Le rapport final mentionne les principaux fichiers modifiés.

## 14. Vérifications obligatoires

Choisir des tests proportionnés au changement, mais ne jamais annoncer une validation non exécutée.

Commandes canoniques actuelles :

```powershell
npm run typecheck
npm run test:ts
npm run test:py
npm run test:api
npm test
npm run build:desktop
& .\apps\desktop\scripts\build-sidecar.ps1
$env:Path = 'C:\Users\gb781\.cargo\bin;' + $env:Path
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run tauri --workspace @gta-ai-studio/desktop -- build
```

- Pour du code TS/Python ou une migration, exécuter au minimum les tests ciblés, typecheck et vérification de migration pertinents.
- Pour média/rendu, utiliser une fixture réelle ou synthétique reproductible et inspecter l’artefact produit.
- Pour l’interface, compiler puis effectuer une vérification navigateur proportionnée.
- Pour packaging, exécuter le smoke test du sidecar puis lancer l’exécutable natif et vérifier `/api/v1/health`.
- Ne pas supprimer, ignorer ou affaiblir un test pour obtenir du vert.
- Signaler toute vérification impossible et la raison exacte.

## 15. Définition de terminé

Une tâche est terminée seulement si : périmètre et critères d’acceptation couverts, erreurs gérées, tests pertinents passés, documentation cohérente, temporaires nettoyés, aucun secret ajouté, aucune régression connue ignorée et limites explicites.

Préférer un flux complet simple à dix modules incomplets, du code explicite à une abstraction prématurée, une erreur visible à un faux succès, une migration à une modification manuelle, une preuve à une supposition et une amélioration mesurée à une optimisation intuitive.

## 16. Rapport final

Le rapport final doit contenir, de façon proportionnée :

1. **Résultat** — ce qui fonctionne réellement.
2. **Fichiers modifiés** — principaux fichiers créés ou changés.
3. **Décisions techniques** — choix importants et justification.
4. **Vérifications exécutées** — commandes réellement lancées et résultats.
5. **Limites et risques** — incomplets, non testés ou incertains.
6. **Étape suivante** — prochaine tâche logique sans l’implémenter.

## 17. Interdictions absolues

Ne jamais inventer une fonctionnalité ou un test réussi, cacher une erreur, substituer silencieusement un mock, exécuter une commande produite librement par un LLM, modifier une vidéo source, mélanger les connaissances GTA V/GTA VI, coder GTA V dans le noyau, créer une affirmation sans provenance, publier sans contrôle prévu, récupérer puis republier le contenu d’un concurrent ou poursuivre une phase future sans instruction explicite.

En cas d’incertitude : inspecter le code, lire la documentation pertinente, rechercher une convention existante, choisir la solution la plus simple compatible, documenter l’hypothèse, éviter l’irréversible et signaler clairement ce qui reste incertain.
