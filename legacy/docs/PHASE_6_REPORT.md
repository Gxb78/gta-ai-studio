# Rapport Phase 6 — Automatic Editing Engine

## Résultat

Le flux local complet comporte désormais une étape de montage avancé entre la voix et la timeline. Le studio analyse les images clés, combine attention visuelle et régions de preuves, lisse le focus, choisit un recadrage 9:16 par plan et produit un fallback stable lorsque la confiance est insuffisante. Le renderer FFmpeg applique réellement ces choix, ainsi que les zooms, accélérations, transitions, comparaisons avant/après, overlays ASS et le mix audio avancé.

## Livrables

- moteur `editing_intelligence.py` et job persistant `PLAN_ADVANCED_EDIT` ;
- migration SQLite `0007` pour plans, points de suivi et cues ;
- templates versionnés `dynamic`, `cinematic` et `tutorial` ;
- timeline multi-pistes enrichie et allowlist d’effets Phase 6 ;
- renderer avec crop animé, blur fallback, split-screen, `setpts`/`atempo`, double ASS, sidechain et loudness ;
- garde factuelle des overlays sur les claims admis en Phase 5 ;
- Editing Studio React inspectable ;
- contrats TypeScript/Python et ressources templates incluses dans le sidecar ;
- version produit 0.6.0.

## Décisions techniques

Le suivi reste CPU-first : aucune dépendance à un GPU ou à un service distant. Les régions OCR/entités ont priorité lorsqu’elles existent ; la carte d’attention OpenCV complète le signal. Les mouvements sont lissés et bornés pour éviter les sauts de crop. Une confiance faible déclenche un blur background ou un crop central stable selon la composition demandée, considéré comme une stratégie valide et visible, pas comme un faux tracking.

Les effets sont ajoutés uniquement pour une raison structurée : lisibilité d’un menu ou d’une preuve, compression d’une attente de faible mouvement, frontière narrative ou comparaison réellement couverte. Le nombre d’overlays, leur intervalle, le zoom maximal, la vitesse maximale, les zones sûres et le mix dépendent d’un template versionné.

## Vérifications

Les vérifications à exécuter pour la livraison finale sont : typecheck TypeScript, tests TypeScript/Python/API, test ciblé Phase 6, rendu FFmpeg réel, build desktop, sidecar autonome et installateur Windows. Les résultats exacts sont consignés dans le rapport de mission Codex ; ils ne sont pas présumés dans ce document versionné.

## Limites

Le suivi est une estimation d’attention et de régions observées, pas encore une segmentation d’instance ou un tracker neuronal spécialisé. Il privilégie la robustesse CPU et le fallback. Le mix utilise une normalisation FFmpeg en une passe ; une mesure EBU R128 en deux passes pourra être évaluée sur un corpus plus large.

## Étape suivante

Phase 7 — Miniatures et métadonnées : générer des propositions cohérentes avec le contenu vérifié et le style de montage, sans démarrer la publication autonome.
