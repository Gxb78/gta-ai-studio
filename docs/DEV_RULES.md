# Règles de développement

## Lancement local

- `npm run dev` démarre l’API, attend son healthcheck puis lance Tauri ; Ctrl+C nettoie uniquement les processus créés par le script.
- `npm run dev:web` conserve le même backend mais lance Vite sans la coque native.
- Une API saine déjà présente sur `127.0.0.1:8765` est réutilisée.
- Le mode matériel se règle avec `GTA_STUDIO_HARDWARE_ACCELERATION=auto|cpu|nvidia`; le mode `auto` est la valeur normale.

## Langages et frontières

- TypeScript strict ; aucun `any` dans un contrat public.
- Python 3.12+ typé ; Pydantic v2 pour toutes les frontières.
- `snake_case` sur le fil et en SQLite ; les modèles TypeScript internes peuvent utiliser `camelCase` avec sérialisation explicite.
- Les contrats ont `schemaVersion`; toute incompatibilité est une erreur visible.
- Les DTO ne contiennent pas de client SDK, handle de fichier ou exception native.

## Architecture

- Aucune logique critique dans React/Tauri.
- Aucun SDK de fournisseur dans `domain`.
- Aucune connaissance GTA V/GTA VI dans le noyau générique.
- Aucune commande shell construite depuis une chaîne libre.
- Les fonctionnalités incomplètes portent `NOT_IMPLEMENTED_PHASE_X` dans leur documentation ou renvoient une erreur explicite ; aucun mock silencieux en production.

## Identifiants et temps

- UUID v7 généré à l’entrée de l’agrégat.
- UTC exclusivement pour les horodatages métier.
- Temps média entiers ; FPS/timebase rationnels.
- Empreinte SHA-256 pour sources et artefacts.

## Idempotence

Clé canonique :

```text
<job_kind>:<algorithm_version>:<canonical_parameters_hash>:<ordered_input_hashes>
```

- Une contrainte unique protège chaque projet contre les doublons actifs/réussis.
- Les paramètres JSON sont triés et normalisés avant hashing.
- L’artefact est validé avant de marquer le job `SUCCEEDED`.
- Un changement d’algorithme ou de modèle change la clé.
- Un retry conserve la clé, le `request_id` et incrémente seulement `attempt`.

## Queue et erreurs

- Lease + heartbeat ; aucune confiance dans le PID seul.
- Backoff exponentiel avec jitter et plafond.
- Retry : réseau transitoire, rate-limit, provider temporairement indisponible, verrou SQLite bref.
- Pas de retry automatique : validation, média invalide, capacité absente, permission, invariant métier.
- Codes d’erreur stables : `DOMAIN_*`, `MEDIA_*`, `PROVIDER_*`, `STORAGE_*`, `JOB_*`, `SECURITY_*`, `INTERNAL_*`.
- Une exception inconnue devient `INTERNAL_UNEXPECTED`, conserve sa stack localement et expose un message expurgé.

## Logs structurés

Une ligne JSON par événement :

```json
{
  "schema_version": "1.0",
  "timestamp": "2026-07-21T12:00:00.000Z",
  "level": "INFO",
  "event": "job.completed",
  "service": "media-worker",
  "message": "Proxy generated",
  "trace_id": "...",
  "project_id": "...",
  "job_id": "...",
  "duration_ms": 8421
}
```

Pas de secret, prompt complet, frame, transcript ou chemin absolu non nécessaire. Les champs inconnus vont dans `attributes`, après redaction.

## Base de données

- Migrations SQL append-only et numérotées.
- `foreign_keys=ON`, WAL et `busy_timeout` à chaque connexion.
- Transactions courtes ; aucun encodage média dans une transaction.
- Contrôle optimiste via `row_version`.
- Requêtes paramétrées exclusivement.

## Tests

Phase 0 couvre les contrats, validateurs de timeline/qualité et transitions d’état. Phase 1 couvre par intégration `import -> FFprobe -> proxy -> reprise`, la déduplication, l’annulation et les frontières de commandes. Les golden projects et media regressions arrivent avec le vertical slice. Aucun test ne doit faire semblant d’appeler un provider réel.

## Définition de terminé

- Code compilé/typé.
- Contrat et migration cohérents.
- Erreurs et logs explicites.
- Documentation mise à jour.
- Limites et fonctionnalités futures marquées.
- Aucune phase suivante commencée par effet de bord.
