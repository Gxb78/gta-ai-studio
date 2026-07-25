# Rapport Phase 5 — Evidence & Knowledge

## Résultat

Le flux complet possède désormais une frontière factuelle persistante entre le plan éditorial et le script. Le job `VERIFY_FACTS` transforme les observations du rush et les demandes du brief en claims inspectables, rattache leurs preuves et timecodes, applique un statut et une confiance, puis décide explicitement si une formulation factuelle limitée peut entrer dans le script.

Une demande absente reste `unknown` et visible dans le rapport, mais elle est exclue. Un montant réellement lu à l’écran peut produire « le jeu affiche… » sans être présenté automatiquement comme un prix ou une récompense. Une observation cohérente dans un projet antérieur devient `reproduced` et référence les claims antérieurs comme preuves. Le Quality Gate vérifie enfin que chaque claim référencé par le script appartient aux identifiants admis.

La base de connaissances est versionnée et strictement séparée par jeu. Le starter pack GTA V contient uniquement cinq correspondances de terminologie déjà présentes dans la taxonomie locale ; aucun prix, statistique, véhicule ou résultat de gameplay n’a été inventé. Le namespace GTA VI reste volontairement vide.

## Fichiers principaux

- `services/api/src/gta_studio_api/evidence_engine.py` : création, statut, reproduction et gate des claims.
- `services/api/src/gta_studio_api/service.py` : job `VERIFY_FACTS`, propagation vers le script et contrôle factuel du rendu.
- `services/api/src/gta_studio_api/repository.py` : synchronisation des packs, persistance des preuves, révisions, usages et snapshot API.
- `packages/database/migrations/0006_phase5_evidence_knowledge.sql` : exécutions de vérification, historique et versionnement.
- `game-adapters/gta5/knowledge/` et `game-adapters/gta6/knowledge/` : packs isolés.
- `packages/contracts/*/narrative.*` : contrats Evidence, Claim, Verification Report et Knowledge Item.
- `apps/desktop/src/EvidenceStudio.tsx` : ledger de claims, faits demandés, preuves et connaissances.
- `tests/integration/api/test_phase5_evidence_knowledge.py` : scénarios de vérification et isolation.

## Décisions techniques

1. **Preuve avant formulation.** Le moteur n’autorise une narration factuelle que pour un claim admis et possédant une formulation sûre. Une observation d’écran ne reçoit aucun sens supplémentaire non observé.
2. **Historique reproductible.** Un claim `reproduced` porte une preuve `repeated_test` vers les claims antérieurs, en plus de sa nouvelle observation.
3. **Connaissances append-only.** Les changements de pack créent une `knowledge_revision`; chaque usage conserve l’item et la révision consommée.
4. **Isolation par namespace.** `game_id`, `namespace` et pack chargé doivent coïncider. Le snapshot expose aussi le nombre de croisements inter-jeux, attendu à zéro.
5. **Gate vérifié au rendu.** Le check `factual_safety` compare les claims sourcés et tous les `supporting_claim_ids` aux claims admis par le rapport de vérification.

## Vérifications exécutées

- `npm test` : 7 tests TypeScript, 3 tests Python et 17 tests API passés ;
- pipeline réel sur `demo-gameplay.mp4` : `VERIFY_FACTS`, script, voix, timeline, MP4 vertical et Quality Gate terminés ;
- `npm run build:desktop` : typecheck strict et bundle Vite passés ;
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` : compilation native de développement passée ;
- `apps/desktop/scripts/build-sidecar.ps1` : sidecar PyInstaller et smoke FFmpeg/FFprobe/SAPI/OpenCV/ONNX/RapidOCR passés ;
- sidecar autonome exécuté sur un répertoire temporaire : santé `ok`, version `0.5.0`, migration `6`, cinq items GTA V, zéro item GTA VI et zéro violation de clé étrangère ;
- `tauri build` : exécutable natif et installateur NSIS `GTA AI Studio_0.5.0_x64-setup.exe` générés.

## Limites

- Le starter pack ne contient volontairement aucune connaissance factuelle GTA : les faits absents du rush restent exclus tant qu’une source validée n’est pas ajoutée.
- Les preuves actuellement exploitées viennent des segments, de l’OCR, des entités, des événements, de l’historique local et des packs ; l’ingestion de documentation officielle n’est pas encore automatisée.
- La connexion au navigateur intégré échoue dans cet environnement avec `Cannot redefine property: process`; le nouvel écran a passé le typecheck et le build, mais pas une inspection navigateur automatisée.

## Risques

- Une erreur OCR peut produire une observation faussement lisible ; la confiance, la formulation limitée et la provenance restent visibles, mais une future revue/correction utilisateur améliorera le contrôle.
- Une base factuelle future devra gérer précisément version du jeu, dates de validité, contradictions et obsolescence avant d’élargir les claims `verified`.

## Étape suivante

Phase 6 — Montage avancé : reframing intelligent, overlays, cartes, comparaisons avant/après, transitions et mix audio enrichi, sans modifier la frontière factuelle validée en Phase 5.
