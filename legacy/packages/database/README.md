# Database

Migrations SQLite append-only. La Phase 0 fournit le schéma initial ; le runner, les repositories et les sauvegardes seront implémentés en Phase 1.

À chaque connexion, la future couche database devra appliquer `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000` et des transactions courtes.

