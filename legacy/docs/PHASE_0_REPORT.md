# Rapport de clôture — Phase 0

Date : 2026-07-21

Statut : **terminée ; aucune fonctionnalité Phase 1 implémentée**.

## Livrables

- `AGENTS.md` racine : constitution opérationnelle de Codex, ajoutée rétroactivement avant la Phase 4 pour corriger l’omission initiale de Phase 0.
- Documentation produit et architecture canonique.
- Monorepo local-first avec frontières apps/services/packages/adapters/templates/data/tests.
- Contrats TypeScript stricts et modèles Pydantic v2.
- Machine à états séparant stage métier et statut d’exécution.
- Queue : états, dépendances, leases, retry, annulation et idempotence.
- Timeline déclarative et validateur d’invariants/allowlist d’effets.
- Quality gates où un blocker ne peut pas être compensé par un score moyen.
- Interfaces de providers sans SDK concret.
- Contrat Game Adapter et manifests GTA V/GTA VI désactivés.
- Migration SQLite WAL initiale : 39 tables, index, contraintes et traçabilité.
- Schéma de logs JSON, redaction, taxonomie d’erreurs et politique de sécurité.

## Décisions structurantes

0. Les règles de travail durables vivent dans `AGENTS.md` ; les documents de `docs/` décrivent le produit et restent référencés plutôt que recopiés.
1. Modular monolith local avant toute distribution.
2. SQLite pour l’état ; filesystem pour les médias lourds.
3. `pipeline_stage` et `run_status` stockés séparément.
4. UUID v7, temps UTC, empreintes SHA-256 et timebase rationnelle.
5. Game Adapters et providers branchés uniquement à la composition root.
6. Timeline typée compilée en arguments FFmpeg sans shell.
7. Artifact cache adressé par contenu et version d’algorithme.
8. Outbox + audit dans la même transaction que les changements durables.

## Validations exécutées

```text
npm run typecheck                         OK
npm run test:ts                           7 passed
npm run test:py                           3 passed
python -m compileall contracts Python     OK
migration SQLite sur base vide            OK
PRAGMA foreign_key_check                  OK
parsing des manifests JSON                OK
git diff --check                          OK
```

Le test SQLite applique réellement `0001_initial.sql`; il ne se contente pas d’inspecter le texte.

## Risques identifiés

- Le packaging Windows Tauri + sidecar Python doit être prototypé tôt en Phase 1.
- Les performances CPU des proxies sur les rushs PS5 longs devront être mesurées sur la machine cible.
- Les variantes réelles de MP4/codec/HDR PS5 ne sont pas encore représentées par un échantillon vérifié.
- Le schéma initial est volontairement large ; les requêtes et index devront être validés sur des volumes réels.
- La parité TypeScript/Pydantic est aujourd’hui maintenue manuellement ; une génération de schéma commune pourra devenir utile.
- Aucun golden project média n’a été inventé en l’absence de rush fourni.

## Questions ouvertes avant Phase 1

1. À l’import, faut-il copier le rush dans `data/projects` par défaut ou conserver une référence vers son emplacement d’origine ? Recommandation : copie gérée, avec option de référence.
2. Le backend Python doit-il être distribué comme sidecar autonome ou dépendre d’un Python installé ? Recommandation : sidecar autonome pour l’utilisateur final.
3. Quels formats PS5 réels doivent constituer le corpus d’import initial (4K/HDR, 60 fps, langues, pistes audio) ?
4. Quelle politique de stockage maximale et de nettoyage du cache doit être la valeur par défaut ?
5. Pour le vertical slice futur, quelle voix française autorisée doit servir de référence locale ou distante ?

Ces choix n’empêchent pas le bootstrap technique de Phase 1, mais doivent être tranchés avant de figer l’expérience d’import et de distribution.

## Proposition Phase 1

Le plan détaillé est dans [ROADMAP.md](ROADMAP.md) : bootstrap desktop/API, SQLite/repositories, import sécurisé, FFprobe, queue persistante, proxy FFmpeg, reprise après crash, puis UI de progression. Le seul critère produit est un flux réel `MP4 -> projet -> métadonnées -> proxy validé`, hors ligne et sans GPU.
