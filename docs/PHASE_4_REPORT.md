# Rapport Phase 4 — Narrative Intelligence

## Résultat

Le flux complet insère désormais une décision éditoriale traçable entre l’analyse visuelle et le script. Le brief est classé et enrichi, chaque intention est reliée à zéro ou plusieurs segments candidats, la couverture est mesurée, les séquences absentes produisent des demandes de tournage précises et trois plans narratifs sont comparés avant sélection.

Le script final consomme exclusivement le plan sélectionné. Lorsqu’un élément obligatoire manque, il ne répète pas le détail non observé et annonce une version limitée aux séquences disponibles. Les prix, statistiques, récompenses et classements demandés sont marqués `requires_phase5_verification` et restent exclus du script.

## Fichiers principaux

- `services/api/src/gta_studio_api/narrative_intelligence.py` : compréhension du brief, structures par contenu, matching, couverture, recommandations et variantes.
- `services/api/src/gta_studio_api/service.py` : jobs `BUILD_NARRATIVE_MAP` et `PLAN_CONTENT`.
- `services/api/src/gta_studio_api/repository.py` : persistance et snapshot narratif.
- `packages/database/migrations/0005_phase4_narrative_intelligence.sql` : rapport de couverture et métadonnées de beats.
- `packages/contracts/*/narrative.*` : contrats de couverture, recommandations et plans.
- `apps/desktop/src/NarrativeStudio.tsx` : atelier de lecture de la carte et des variantes.
- `tests/integration/api/test_phase4_narrative_intelligence.py` : scénarios éditoriaux et garde factuelle.

## Décisions techniques

1. **Matching déterministe CPU-first.** Les candidats utilisent l’OCR, les écrans, menus, événements et résumés Phase 3. Une séquence visuellement propre mais sans signal sémantique reste sous le seuil d’association.
2. **Couverture pondérée.** `found=1`, `partially_found=0.55`, `ambiguous=0.25`; les états manquant, contredit et inexploitable valent zéro.
3. **Continuation prudente.** Un manque n’arrête pas tout le rendu : le script s’adapte, l’interface avertit et le rapport fournit une capture complémentaire précise.
4. **Trois variantes réelles.** Les plans sont ordonnés différemment, scorés sur couverture, affinité de style, rythme, densité de preuves et durée. L’historique de performance et les préférences apprises sont explicitement indisponibles jusqu’aux phases concernées.
5. **Frontière Phase 5.** Le gate `FACTS_VERIFIED` est franchi uniquement parce que la Phase 4 n’admet aucun claim factuel. Il ne remplace pas la future vérification des claims.

## Vérifications

- `npm test` : 7 tests TypeScript, 3 tests contrats/migration et 12 tests API passés ;
- tests d’intégration API incluant migration `0005`, jobs persistants, TTS, timeline, rendu et variantes ;
- `npm run build:desktop` : typecheck strict et build Vite production passés ;
- pipeline local réel sur le fixture vidéo : 13 beats, 5 demandes complémentaires, 3 variantes, rendu final terminé ;
- `apps/desktop/scripts/build-sidecar.ps1` : sidecar PyInstaller et smoke FFmpeg/FFprobe/SAPI/OpenCV/ONNX/RapidOCR passés ;
- `tauri build` : exécutable natif et installateur NSIS `GTA AI Studio_0.4.0_x64-setup.exe` générés ;
- démarrage du sidecar empaqueté : `/api/v1/health` retourne `status=ok`, `version=0.4.0`, base OK et worker actif.

## Limites et risques

- Le moteur repose sur des règles lexicales et les signaux Phase 3 : une formulation très indirecte ou un menu non reconnu peut rester ambigu.
- Aucune identification de véhicule, prix, statistique ou récompense n’est vérifiée en Phase 4.
- L’historique de performance et les préférences créateur n’influencent pas encore la sélection.
- La bibliothèque de rushs réutilisables et les cartes graphiques de remplacement restent hors périmètre.
- La connexion d’automatisation au navigateur intégré n’a pas pu être initialisée dans l’environnement de build ; l’interface a néanmoins passé le typecheck et le build de production.

## Étape suivante

Phase 5 — Evidence & Knowledge : créer les claims, leurs preuves, niveaux de confiance, statuts de vérification et namespaces séparés GTA V/GTA VI, sans modifier le moteur de montage avancé de Phase 6.
