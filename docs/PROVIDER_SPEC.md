# Spécification des fournisseurs

## Objectif

Les fournisseurs de LLM, vision, OCR, transcription, TTS, image, embeddings, publication et analytics sont des ports interchangeables. Le domaine exprime une capacité et des contraintes ; la composition root choisit l’implémentation locale ou distante.

## Contrat commun

Chaque provider expose :

- un descripteur stable (`providerId`, version, modèle, capacités) ;
- disponibilité, latence observée, limites et santé ;
- estimation coût/temps avant exécution lorsque possible ;
- exécution avec `requestId`, `traceId`, deadline, politique de données et jeton d’annulation ;
- résultat typé avec usage, coût, modèle exact et provenance ;
- erreurs classées (`transient`, `rate_limit`, `invalid_request`, `unavailable`, `policy`, `cancelled`, `internal`).

## Sélection

Le routeur filtre d’abord les providers incompatibles avec :

- capacité et langue ;
- budget et délai ;
- politique locale uniquement / transmission autorisée ;
- taille et type de média ;
- état du circuit breaker.

Il classe ensuite les candidats par préférence utilisateur, coût estimé, latence et qualité historique. Aucun fallback ne peut élargir silencieusement la politique de transmission.

## CPU-first

Les opérations déterministes, FFmpeg, hashing et validation restent locales. OCR et modèles légers peuvent être locaux. Les modèles lourds passent par une API ou un futur serveur GPU seulement si la politique du projet l’autorise.

## Résilience et audit

- `requestId` et `idempotencyKey` stables sur les retries compatibles.
- Retry uniquement pour les erreurs transitoires/rate-limit, avec `Retry-After` si disponible.
- Circuit breaker par provider + capacité.
- Chaque appel enregistre modèle exact, durée, unités, coût estimé/réel et empreinte des entrées, mais jamais secret ni média brut.
- Une réponse de provider reste une proposition ; les contrats de domaine la valident avant persistance.

## Secrets

Les clés seront chargées depuis le gestionnaire d’identifiants Windows ou une variable d’environnement de développement. Elles n’apparaissent ni dans un DTO, ni dans SQLite, ni dans les logs.

