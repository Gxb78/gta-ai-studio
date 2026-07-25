# Architecture de réactivité à trois boucles

**Date:** 2026-07-22  
**Statut:** Implémenté  
**Contexte:** Amélioration de la réactivité de l'éditeur timeline

## Problème

L'éditeur timeline présentait des problèmes de performance :

1. Chaque mouvement de slider appelait `commit()`, créant des centaines d'entrées undo
2. Le resize reconstruisait tous les clips à chaque `pointermove`
3. Les previews utilisaient un seul worker séquentiel, causant des attentes
4. Deux implémentations de prefetch coexistaient
5. Tous les jobs avaient la même priorité (0)
6. **Les jobs de preview polluaient l'état global du projet**

## Solution

Implémentation d'une architecture à trois boucles distinctes :

### Boucle A : Réactivité immédiate (< 16ms)

**Frontend (`EditingStudio.tsx`)**

- Ajout d'un état transitoire : `transientClip` et `transientClipIndex`
- Nouvelles fonctions :
  - `updateClipTransient(index, values)` : mise à jour sans commit
  - `commitTransientClip()` : commit des changements à la fin
- Les sliders utilisent `onInput` (transitoire) + `onChange` (commit)
- Le resize utilise l'état transitoire pendant le drag

**Avantages :**
- Aucune entrée undo pendant les interactions
- Moins de `structuredClone`
- Moins de rerenders React
- Interaction fluide < 16ms

### Boucle B : Validation encodée (250-350ms)

**Backend (`service.py`, `repository.py`)**

- Système de priorités pour les jobs :
  - User interactive : priorité 100
  - Manual : priorité 80
  - Pipeline : priorité 50 (défaut)
  - Prefetch : priorité 10
- **Worker preview dédié** : `_preview_worker_loop()` séparé du worker pipeline
  - Utilise `claim_preview_job()` qui ne réclame que les `RENDER_CLIP_PREVIEW`
  - Polling rapide (0.5s) pour réactivité immédiate
  - File séparée : le worker pipeline ignore les previews
- Annulation des jobs preview en cours pour le même clip (dernière requête gagne)
- Nouvelle méthode : `Repository.cancel_preview_jobs_for_clip(project_id, clip_id)`
- Nouvelle méthode : `Repository.claim_preview_job(worker_id, lease_seconds)`
- **Suppression de `set_project_status("ACTIVE")` lors de l'enqueue de preview**

**Avantages :**
- Les previews interactives passent devant
- **Les previews ne sont jamais bloquées par des jobs pipeline lourds**
- Annulation automatique des rendus obsolètes
- Pas d'attente derrière des jobs lourds
- **Les previews n'affectent plus l'état global du projet**

### Boucle C : Anticipation (priorité faible)

**Backend (`service.py`, `repository.py`)**

- Suppression du prefetch dupliqué dans `_render_clip_preview()`
- Conservation uniquement du prefetch dans `start_clip_preview()`
- Utilise le système de priorités (priorité 10)
- Annulable par les requêtes utilisateur
- **Contrôle de concurrence** :
  - `count_active_prefetch_jobs(project_id)` : compte les prefetch actifs
  - Respect de `preview_prefetch_max_concurrent` (défaut: 1)
  - Vérification avant chaque prefetch
  - Skip si limite atteinte, logs de diagnostic

**Avantages :**
- Un seul système de prefetch
- Ne bloque jamais les actions utilisateur
- **Contrôle de la charge système** (concurrence limitée)
- Meilleur contrôle de la concurrence

### Isolation de l'état des previews

**Frontend (`App.tsx`)**

- Les jobs `RENDER_CLIP_PREVIEW` sont exclus du calcul de `activeJob`
- La barre de progression globale ignore les previews
- Les previews sont des jobs auxiliaires qui n'affectent pas le workflow principal

**Backend (`service.py`, `storage.py`)**

- **Cache global partagé** : les previews ne sont plus stockées par projet
  - Avant : `project/renders/previews/{cache_key}.mp4`
  - Après : `data/cache/previews/ab/cd/{cache_key}.mp4` (sharding par préfixe)
- **Artifacts globaux** : `register_artifact()` appelé avec `project_id=None`
- Les projets conservent uniquement des **références** vers le cache global
- Suppression de `set_project_status("ACTIVE")` lors de l'enqueue

**Avantages :**
- Le statut du projet reste cohérent
- La progression n'est pas perturbée par les previews
- L'UI reste focalisée sur le pipeline principal
- **Cache partagé entre projets** : économie d'espace disque
- **Sharding** : meilleure distribution sur le filesystem

## Changements techniques

### Backend

**`repository.py`**
- `enqueue_job()` : ajout paramètre `priority: int = 50`
- `cancel_preview_jobs_for_clip(project_id, clip_id)` : nouvelle méthode
- **`claim_preview_job(worker_id, lease_seconds)` : nouvelle méthode pour worker dédié**
- **`claim_job()` : exclusion des `RENDER_CLIP_PREVIEW` (réservés au worker preview)**
- **`count_active_prefetch_jobs(project_id)` : compte les prefetch actifs pour contrôle concurrence**

**`service.py`**
- **Worker preview dédié** :
  - `preview_worker_id` : ID séparé du worker principal
  - `_preview_worker_task` : tâche asyncio dédiée
  - `_preview_worker_loop()` : boucle avec polling rapide (0.5s)
  - `start_worker()` : démarre les deux workers
  - `stop_worker()` : arrête les deux workers
- `start_clip_preview()` : assignation de priorités selon `origin`
- `start_clip_preview()` : annulation des jobs en cours avant enqueue
- `start_clip_preview()` : **suppression de `set_project_status("ACTIVE")`**
- `_render_clip_preview()` : **utilisation du cache global via `storage.preview_cache_path()`**
- `_render_clip_preview()` : **`register_artifact()` avec `project_id=None`**
- `_render_clip_preview()` : suppression du prefetch dupliqué
- `_prefetch_adjacent_clips()` : correction pour utiliser `ClipSnapshot`
- `_prefetch_adjacent_clips()` : **contrôle de concurrence avec `preview_prefetch_max_concurrent`**
- `_prefetch_adjacent_clips()` : **vérification de `preview_prefetch_enabled`**

**`storage.py`**
- **`preview_cache_path(cache_key)` : nouvelle méthode pour cache global**
  - Chemin : `data/cache/previews/{prefix}/{subdir}/{cache_key}.mp4`
  - Sharding par préfixe (ab/cd/abcdef...)
  - Création automatique des répertoires

### Frontend

**`EditingStudio.tsx`**
- État transitoire : `transientClip`, `transientClipIndex`
- `updateClipTransient(index, values)` : mise à jour sans historique
- `commitTransientClip()` : commit avec détection de changements
- `startResize()` : refonte pour utiliser état transitoire
- Sliders focus : `onInput` + `onChange` au lieu de `onChange` seul

**`App.tsx`**
- **Filtrage de `RENDER_CLIP_PREVIEW` dans le calcul de `activeJob`**
- Les jobs de preview n'affectent pas la barre de progression

## Migration

Aucune migration de schéma nécessaire. Les priorités utilisent la colonne `priority` existante.

## Risques atténués

1. **État transitoire non commité** : Si le commit échoue ou est oublié, l'état transitoire est perdu
   - Mitigation : `commitTransientClip()` est appelé systématiquement sur `onChange` et `onUp`

2. **Préemption de prefetch** : Les prefetch peuvent être annulés fréquemment
   - Mitigation : C'est le comportement souhaité (priorité faible)

3. **Pollution de l'état projet** : Les previews changeaient le statut du projet
   - ✅ **Résolu** : `set_project_status()` supprimé et jobs filtrés dans l'UI

4. **Compatibilité worker unique** : Le système suppose un worker qui respecte les priorités
   - Note : Le worker actuel (`_worker_loop`) respecte déjà `ORDER BY priority DESC`

## Tests

- ✅ TypeScript compilation
- ⚠️ Tests Python (échec réseau dans l'environnement isolé)
- ⚠️ Tests end-to-end à valider manuellement

## Validation manuelle recommandée

1. Tester le drag de sliders de focus → doit être fluide sans entrées undo intermédiaires
2. Tester le resize de clips → doit être fluide
3. Vérifier que les previews se génèrent rapidement après modification
4. Confirmer que le prefetch fonctionne en arrière-plan (clips adjacents)
5. **Vérifier que la barre de progression ignore les jobs de preview**
6. **Confirmer que le statut du projet reste cohérent pendant les previews**

## Prochaines étapes possibles

1. ~~Worker preview dédié~~ ✅ **Implémenté**
2. ~~Contrôle de concurrence pour `preview_prefetch_max_concurrent`~~ ✅ **Implémenté**
3. Métriques de performance pour mesurer l'amélioration réelle

## Références

- Problème initial : Document utilisateur décrivant l'architecture cible
- Issue #4 : État global et cache pollué par les previews

