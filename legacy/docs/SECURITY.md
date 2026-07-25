# Sécurité

## Modèle de confiance

Le rush, le brief, les sous-titres OCR, les réponses de modèles, les métadonnées et les noms de fichiers sont non fiables. Le backend local et les workers appliquent validation, quotas et allowlists même lorsqu’un seul utilisateur emploie le produit.

## Secrets

- Gestionnaire d’identifiants Windows en production ; variables d’environnement uniquement en développement.
- Aucune clé dans Git, SQLite, artefact, prompt exporté ou log.
- Rotation sans changement de contrat métier.
- OAuth à privilèges minimaux pour les futures plateformes.

## Fichiers et chemins

- Résoudre et normaliser tout chemin avant accès.
- Restreindre les écritures aux racines de données configurées.
- Interdire traversal, liens/raccourcis sortant de la racine et noms réservés Windows.
- Vérifier extension, signature, taille et métadonnées via FFprobe avant traitement.
- Écrire en temporaire, `fsync` lorsque critique, puis renommer atomiquement.

## Exécution média

- Appel direct du processus avec tableau d’arguments ; aucun `shell=true`.
- Codecs, formats, filtres et protocoles FFmpeg sur allowlist.
- Protocoles réseau désactivés pour les jobs locaux.
- Limites CPU, mémoire, temps, taille de sortie et nombre de frames.
- Répertoire temporaire isolé par job et nettoyage reprenable.

## IA et fournisseurs

- Un LLM ne décide jamais d’une commande, d’un chemin ou d’une autorisation brute.
- Chaque projet porte une politique `local_only`, `metadata_only` ou `media_allowed`.
- Journal de transmission : provider, but, catégories de données, empreintes, heure et résultat.
- Les réponses sont validées comme données non fiables.
- Aucun fallback distant si `local_only` est actif.

## API locale

- Écoute sur loopback uniquement par défaut.
- Secret de session éphémère négocié entre Tauri et l’API.
- CORS limité à l’origine de l’application.
- Endpoints mutatifs protégés contre rejeu et requêtes cross-origin.
- Version et état de santé vérifiés avant chaque session desktop.

## Données et suppression

Les projets sont locaux. Une suppression passe par inventaire, tombstone, annulation des jobs, purge des artefacts/cache puis audit final. Les sauvegardes configurées sont signalées séparément afin de ne jamais promettre une purge inexistante.

## Menaces prioritaires Phase 1

1. Traversal via nom de média importé.
2. Injection d’arguments FFmpeg/FFprobe.
3. Fuite de brief ou frames vers un provider non autorisé.
4. Exposition de l’API locale au réseau.
5. Double exécution ou corruption après crash.
6. Secret ou chemin sensible dans les logs.

