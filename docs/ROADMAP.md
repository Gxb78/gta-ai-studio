# Roadmap

## Phase 0 — Constitution du produit (terminée)

Livrables : `AGENTS.md`, architecture, conventions, monorepo, contrats TS/Python, modèle SQLite, machine à états, queue, sécurité, qualité, providers, timeline et Game Adapter.

Critères de sortie :

- les documents canoniques existent et se recoupent sans contradiction majeure ;
- le `AGENTS.md` racine définit les conventions, commandes, interdictions et critères de fin applicables à tout le dépôt ;
- les contrats TypeScript passent le typecheck ;
- les modèles Pydantic se chargent et rejettent les invariants invalides ;
- les transitions et validations pures sont couvertes ;
- la migration SQLite s’applique sur une base vide et passe `foreign_key_check` ;
- tous les squelettes futurs sont marqués comme non implémentés ;
- aucun provider payant ou flux Phase 1 n’est intégré.

## Phase 1 — Fondation locale (terminée)

Objectif : flux entièrement fonctionnel `import -> projet -> métadonnées -> proxy -> terminé`, sans IA payante.

### Tranche 1 — Bootstrap

- Initialiser Tauri + React + Vite dans `apps/desktop`.
- Initialiser FastAPI dans `services/api` avec endpoint santé/version.
- Ajouter une composition root et un gestionnaire de processus local Windows.
- Vérifier Node, Python, FFmpeg et FFprobe avec diagnostics actionnables.

### Tranche 2 — Persistance

- Implémenter la couche SQLite, l’application des migrations et WAL.
- Repositories projets/médias/jobs avec contrôle optimiste.
- Artifact store local et disposition `data/projects/<project_id>/...`.
- Logs JSON corrélés et audit minimal.

### Tranche 3 — Import

- Glisser-déposer/sélecteur MP4.
- Validation du chemin et du conteneur.
- Hash SHA-256 streaming et déduplication.
- FFprobe avec timeout et mapping vers `MediaAsset`.
- Copie ou référence contrôlée selon choix utilisateur.

### Tranche 4 — Queue et proxy

- Scheduler SQLite, dependencies, lease, heartbeat, retry et annulation.
- Worker média local embarqué dans le sidecar pour cette fondation monomachine.
- Command builder FFmpeg typé pour proxy H.264/AAC léger.
- Écriture atomique, vérification FFprobe et cache par empreinte.
- Reprise après arrêt forcé du backend/worker.

### Tranche 5 — Interface et rapport

- Création/liste/détail projet.
- Progression temps réel, erreurs et relance.
- Aperçu du proxy.
- Rapport d’import : intégrité, durée, résolution, FPS, codecs et artefacts.

### Critères de sortie Phase 1

- Un MP4 réel devient un projet avec métadonnées et proxy lisible.
- Un doublon ne recalcule pas silencieusement le proxy.
- Un crash worker est récupéré sans corrompre le projet.
- Aucune commande shell libre et aucun accès hors racine autorisée.
- Le flux fonctionne hors ligne et sans GPU.

Statut : critères couverts par le flux démontrable et les tests d’intégration décrits dans [PHASE_1_REPORT.md](PHASE_1_REPORT.md). La validation sur un rush PS5 4K/HDR réel reste une campagne de compatibilité média, pas un blocage de la fondation.

## Phase 2 — Premier vertical slice (terminée)

Objectif atteint : flux `brief -> scènes -> script -> voix -> sous-titres -> timeline -> rendu vertical -> contrôles -> export` entièrement local et reprenable.

- brief libre avec durée, style, voix, cadrage, sous-titres, niveau du rush, hook et conclusion ;
- découpage basique par changements de scène et sélection de plans sans timecode manuel ;
- script prudent qui reformule l’intention sans inventer de faits GTA ;
- TTS Windows SAPI, traitement de voix, ducking automatique et mix AAC ;
- sous-titres SRT + ASS incrustés, styles impact et minimal ;
- timeline JSON validée avant compilation FFmpeg ;
- sorties verticales 1080×1920 en smart blur ou crop central ;
- quality gate technique, audio, sous-titre, plateforme et sécurité factuelle ;
- variantes versionnées, reprise de jobs, export MP4/SRT et dashboard desktop ;
- sidecar PyInstaller et installateur NSIS 0.2.0 validés.

Statut détaillé : [PHASE_2_REPORT.md](PHASE_2_REPORT.md).

## Phase 3 — Vision & Gameplay Intelligence (terminée)

Objectif atteint : transformer le proxy en observations visuelles persistées et exploitables avant l’écriture du script.

- échantillonnage adaptatif et images clés JPEG horodatées avec OpenCV ;
- métriques locales de luminosité, noir, netteté, contours, saturation, mouvement et qualité ;
- OCR local RapidOCR/PP-OCRv6 sur ONNX Runtime CPU, avec seconde passe CLAHE ;
- segmentation sémantique générique : noir, statique, mouvement élevé et visuel non classé ;
- adaptateur GTA V versionné : candidats menu pause, atelier et interaction, écrans noir/chargement/gameplay, transitions et événements textuels ;
- entités limitées aux montants monétaires réellement visibles par OCR ; aucune identification visuelle de véhicule inventée ;
- recherche guidée par le brief via recouvrement des textes observés, intentions GTA et scores visuels ;
- sélection des clips enrichie par pertinence sémantique et qualité ;
- persistance `analysis_runs`, `analysis_frames`, textes, entités, événements et rapports JSON ;
- dashboard de preuves avec galerie, confiance, distribution des écrans, OCR, événements et meilleurs segments ;
- bundle CPU autonome avec modèles OCR embarqués et version produit 0.3.0.

Statut détaillé : [PHASE_3_REPORT.md](PHASE_3_REPORT.md).

## Phase 4 — Narrative Intelligence (terminée)

Objectif atteint : transformer les observations Phase 3 et le brief structuré en plan éditorial mesuré avant l’écriture du script.

- détection déterministe du type de contenu : véhicule, customisation, mission, guide, astuce, comparaison, mythe et structure générique ;
- structures spécialisées par contenu avec éléments obligatoires, recommandés et explicitement demandés ;
- Narrative Map versionnée dont chaque beat est `found`, `partially_found`, `ambiguous`, `missing`, `contradicted` ou `unusable` ;
- candidats horodatés et raison de décision, sans promouvoir une simple qualité visuelle en preuve sémantique ;
- couverture pondérée obligatoire et globale, ambiguïtés, plans faibles et décision de montage ;
- gestion non bloquante des manquants : adaptation du script, version partielle avertie et demande de rush précise ;
- faits demandés isolés avec `requires_phase5_verification` et interdits dans le script Phase 4 ;
- trois plans persistés (`direct`, `storytelling`, `very_dynamic`) avec score et signaux de sélection inspectables ;
- sélection des clips et script pilotés par le plan retenu ;
- dashboard complet dans l’application desktop et migration SQLite `0005` ;
- version produit et installateur Windows 0.4.0.

Statut détaillé : [PHASE_4_REPORT.md](PHASE_4_REPORT.md).

## Phase 5 — Evidence & Knowledge (terminée)

Objectif atteint : empêcher qu’une intention ou une détection candidate soit promue silencieusement en vérité éditoriale.

- job persistant `VERIFY_FACTS` entre le plan de contenu et le script ;
- claims versionnés avec clé, type, confiance, statut, raison et langage de certitude ;
- preuves rattachées aux segments, OCR, entités, événements et connaissances avec timecodes et force ;
- statuts `hypothesis`, `observed_once`, `reproduced`, `verified`, `contradicted`, `outdated`, `unknown` ;
- faits demandés admis seulement lorsqu’une observation qualifiante ou une connaissance vérifiée du bon namespace existe ;
- formulations limitées à la preuve, sans extrapoler le rôle d’un montant ou d’un texte d’écran ;
- historique des statuts, reproduction inter-projets, révisions et usages de connaissance ;
- packs séparés `gta5/knowledge` et `gta6/knowledge`, avec pack GTA VI volontairement vide ;
- Evidence Studio inspectable et Quality Gate comparant claims cités et claims admis ;
- migration SQLite `0006`, contrats TypeScript/Python et version produit 0.5.0.

Statut détaillé : [PHASE_5_REPORT.md](PHASE_5_REPORT.md).

## Phase 6 — Automatic Editing Engine (terminée)

Objectif atteint : transformer le plan éditorial validé en décisions de montage avancées, reproductibles et réellement compilées par FFmpeg.

- job persistant `PLAN_ADVANCED_EDIT` entre la voix et la construction de timeline ;
- suivi du sujet CPU-first combinant régions OCR/entités et carte d’attention visuelle OpenCV, avec lissage temporel ;
- recadrage 9:16 dynamique selon le focus, fallback blur ou crop central stable lorsque la confiance est faible et split-screen avant/après lorsque les deux états existent ;
- zooms de preuve/menu et accélérations de faible mouvement limités par template, chacun associé à une raison ;
- transitions sobres aux frontières narratives, sans surcharge décorative ;
- overlays ASS template-driven pour titre, étape, preuve, comparaison et conclusion, avec densité et zone sûre bornées ;
- aucun claim factuel d’overlay hors du gate Phase 5 ;
- mix voix prioritaire avec filtrage de l’ambiance, accélération audio synchronisée, ducking sidechain, loudness cible et limiteur ;
- timeline enrichie de tracks vidéo, ambiance, voix, sous-titres et overlays, avec effets déclaratifs inspectables ;
- tables `advanced_edit_plans`, `subject_track_points` et `overlay_cues`, artefacts JSON/ASS et dashboard Editing Studio ;
- templates `dynamic`, `cinematic`, `tutorial`, contrats TypeScript/Python et version produit 0.6.0.

Statut détaillé : [PHASE_6_REPORT.md](PHASE_6_REPORT.md).

## Phase 7 — Miniatures et métadonnées (terminée)

Objectif atteint : transformer le rendu contrôlé en pack éditorial local, traçable et directement exploitable par la future publication.

- job persistant `GENERATE_CREATIVE_PACKAGE` après le rendu, relançable seul pour les projets Phase 6 ;
- classement des images sur netteté, lisibilité, sujet visible, contraste, cadrage, nouveauté, élément fort, absence d’interface et pertinence narrative ;
- trois miniatures OpenCV 1280×720 (`impact`, `clean`, `duo`) composées exclusivement depuis les frames observées ;
- six catégories de titres : direct, curiosité, question, comparaison, résultat et conseil ;
- descriptions longue/courte, mots-clés, hashtags, texte miniature et commentaire épinglé ;
- 18 variantes au total pour YouTube Shorts, TikTok et Instagram Reels ;
- sous-scores de précision, pertinence, longueur, originalité, cohérence et sécurité clickbait ;
- provenance frames/claims, exclusion du sujet non vérifié et signal historique explicitement indisponible ;
- migration SQLite `0008`, API de téléchargement, Creative Studio et version produit 0.7.0.

Statut détaillé : [PHASE_7_REPORT.md](PHASE_7_REPORT.md).

## Passe produit 0.7.2 — Éditeur de timeline non destructif (terminée)

Cette amélioration reste volontairement intercalée avant la Phase 8 et ne démarre aucune fonctionnalité de publication.

- déplacement, réorganisation par glisser-déposer et redimensionnement des plans ;
- découpe, duplication et suppression sans modifier le rush source ;
- réglage manuel des points de focus et du recadrage vertical ;
- activation, désactivation et édition directe des overlays ;
- historique local undo/redo et raccourcis clavier ;
- sauvegarde immuable en nouvelle révision avec contrôle de conflit ;
- rendu persistant du plan sélectionné uniquement, avec aperçu MP4 ;
- migration SQLite `0009`, contrats API/TypeScript et version produit 0.7.2.

Spécification et limites : [TIMELINE_EDITOR_0.7.2.md](TIMELINE_EDITOR_0.7.2.md).

## Phases suivantes

8. Publication OAuth et export de secours.
9. Analytics.
10. Improvement Engine contrôlé.
11. GTA VI Readiness.
12. Launch Mode.

Ne pas démarrer une phase avant que la précédente fournisse un petit flux démontrable et reprenable.
