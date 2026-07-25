# États du pipeline

## Deux axes au lieu d’un état ambigu

Le projet conserve séparément :

1. `pipeline_stage` : dernière étape métier durable atteinte.
2. `run_status` : capacité actuelle à avancer.

Ainsi, une pause à `ANALYZED` ne détruit pas l’information que l’analyse est terminée. Les états complémentaires du plan (`PAUSED`, `FAILED_RETRYABLE`, `WAITING_FOR_USER`, etc.) sont des statuts d’exécution, pas des étapes métier.

## Étapes métier

```text
CREATED -> SOURCE_SELECTED -> BRIEF_CAPTURED -> BRIEF_STRUCTURED
-> INGESTED -> PROXIED -> ANALYZED -> SEGMENTED
-> NARRATIVE_MAPPED -> COVERAGE_CHECKED -> CONTENT_PLANNED
-> FACTS_VERIFIED -> SCRIPTED -> VOICED -> TIMELINE_BUILT
-> DRAFT_RENDERED -> QC_ANALYZED -> CORRECTED -> FINAL_RENDERED
-> READY_TO_PUBLISH -> PUBLISHED -> ANALYTICS_COLLECTED
-> LEARNING_UPDATED
```

Transitions alternatives autorisées :

- `SOURCE_SELECTED -> INGESTED` dans le mode fondation Phase 1, qui ne collecte pas encore de brief.
- `QC_ANALYZED -> FINAL_RENDERED` si tous les gates requis passent.
- `QC_ANALYZED -> CORRECTED` si une correction automatique est possible.
- `CORRECTED -> DRAFT_RENDERED` pour un nouveau cycle borné de rendu/QC.
- Certaines étapes futures peuvent être explicitement sautées par une transition versionnée, jamais implicitement.

## Statuts d’exécution

| Statut | Sens | Reprise |
| --- | --- | --- |
| `ACTIVE` | Le projet peut planifier le prochain job | automatique |
| `PAUSED` | Pause demandée | action utilisateur |
| `WAITING_FOR_USER` | Choix ou fichier nécessaire | réponse utilisateur |
| `WAITING_FOR_PROVIDER` | Capacité externe indisponible | retry/healthcheck |
| `MISSING_FOOTAGE` | Plan obligatoire absent | rush ou adaptation |
| `FAILED_RETRYABLE` | Erreur transitoire | backoff borné |
| `FAILED_FINAL` | Échec non récupérable | correction explicite |
| `CANCELLED` | Exécution annulée, artefacts conservés | nouvelle commande |
| `COMPLETED` | Objectif configuré atteint | aucune |

## Invariants

- Un changement de stage et son événement d’audit sont atomiques.
- Seul `ACTIVE` peut planifier de nouveaux jobs.
- `COMPLETED` n’est valide que lorsque le stage cible du mode courant est atteint.
- Une transition vers l’arrière est interdite hors boucle `CORRECTED -> DRAFT_RENDERED`.
- La réexécution d’une étape réussie avec la même clé retourne l’artefact existant.
- Une annulation coopérative n’efface pas les résultats déjà validés.
- `FAILED_RETRYABLE` exige `next_retry_at`; `FAILED_FINAL` exige un code et un diagnostic expurgé.

## Machine des jobs

```text
QUEUED -> BLOCKED (dépendance)
QUEUED/BLOCKED -> LEASED -> RUNNING -> SUCCEEDED
                           |          -> RETRY_WAIT -> QUEUED
                           |          -> FAILED
                           -> CANCELLED
```

Un job dépassant `max_attempts` devient `FAILED` (dead-letter logique). Un lease expiré retourne à `QUEUED` si le heartbeat et le processus propriétaire sont absents.

La table complète des transitions est codée dans `packages/domain/src/pipeline.ts` et couverte par les tests unitaires.

## Frontière factuelle Phase 5

`CONTENT_PLANNED -> FACTS_VERIFIED` est réalisée par le job persistant `VERIFY_FACTS`. Le stage avance seulement après écriture atomique du `verification_run`, des claims, de leur historique et de leurs preuves. `GENERATE_SCRIPT` reçoit ensuite le rapport exact produit par ce job. Un claim `unknown`, `contradicted` ou `outdated` ne peut pas alimenter une formulation factuelle ; sa présence reste néanmoins visible dans le ledger et le rapport.

## Frontière de montage Phase 6

Après `VOICED`, le job persistant `PLAN_ADVANCED_EDIT` écrit le plan JSON, les points de suivi et les cues d’overlay avant d’autoriser `BUILD_TIMELINE`. Il ne crée pas un stage métier supplémentaire : `VOICED -> TIMELINE_BUILT` reste la transition canonique. Un échec de tracking visuel n’est pas masqué ; le plan passe à `READY_WITH_FALLBACKS` et encode un cadrage immersif stable. Un rendu relancé réutilise le plan et la voix déjà persistés.

## Frontière créative Phase 7

`FINAL_RENDERED -> READY_TO_PUBLISH` est réalisé par `GENERATE_CREATIVE_PACKAGE`. Le job dépend du rendu final et écrit atomiquement miniatures, candidats de métadonnées et pack JSON avant la transition. Un échec de composition conserve le MP4 final et ne relance pas les jobs antérieurs. Les anciens projets arrêtés à `FINAL_RENDERED` peuvent planifier uniquement ce job. `READY_TO_PUBLISH` signifie que les fichiers et textes sont prêts localement ; il ne signifie jamais qu’une publication distante a eu lieu.
