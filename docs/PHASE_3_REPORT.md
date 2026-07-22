# Rapport Phase 3 — Vision & Gameplay Intelligence

## Résultat

La production locale passe désormais par `scènes → images clés → OCR → analyse gameplay → sélection sémantique` avant le script. Les résultats restent inspectables et rattachés à des frames horodatées ; le brief influence le classement, jamais les observations.

## Vision locale CPU

- Extraction adaptative depuis le proxy avec OpenCV, plafonnée par durée et nombre d’images.
- Métriques par frame : luminosité, ratio noir, netteté, densité de contours, saturation, mouvement et qualité.
- OCR RapidOCR avec modèles PP-OCRv6 embarqués et ONNX Runtime CPU.
- Deux passes : image native, puis CLAHE et agrandissement lorsque la première lecture est faible.
- Artefacts JPEG, manifest de frames, rapport OCR et rapport gameplay écrits atomiquement.

## Adaptateurs et vérité

L’adaptateur GTA V 1.0 détecte des candidats menus pause/atelier/interaction, écrans noir/chargement/statique/gameplay, transitions, mouvement élevé et événements textuels. Les montants monétaires sont conservés seulement lorsqu’ils sont visibles par OCR.

Les résultats distinguent :

- `observed_text` pour une sortie OCR avec confiance ;
- `inferred_candidate` pour une interprétation de règle ;
- zéro fait GTA vérifié à ce stade.

Il n’existe pas encore de modèle d’identification de véhicule. GTA VI et les jeux inconnus utilisent un adaptateur générique qui n’applique aucune taxonomie GTA V.

## Recherche guidée et montage

Le brief est normalisé en termes/intents. Chaque segment combine recouvrement OCR, détections attendues, qualité visuelle et signaux de mouvement. Les meilleurs segments sont exposés dans `guided_search` puis alimentent une sélection de clips sémantique avec repli déterministe sur la sélection temporelle de Phase 2.

## Persistance et interface

La migration `0004_phase3_visual_analysis.sql` ajoute les runs et frames d’analyse, puis relie textes, entités et événements à leur run/frame. L’API expose les frames JPEG sans chemin arbitraire. Le cockpit React affiche distribution des écrans, meilleurs plans, galerie horodatée, OCR, événements, confiance, limites de l’adaptateur et légende observé/inféré/non vérifié.

## Validation

- OCR réel sur image synthétique de menu.
- Adaptateur GTA V vérifié avec règles atelier et absence d’entité véhicule inventée.
- Pipeline complet MP4 → analyse → script → voix → timeline → MP4.
- Showcase local : 3 frames, 11 textes OCR, 2 événements candidats et 3 écrans menu candidats.
- TypeScript, contrats, migrations, API, rendu desktop et compilation Rust validés.
- Sidecar PyInstaller avec modèles OCR embarqués et installateur NSIS 0.3.0 validés lors du packaging final.

## Limites reportées

- Narrative Map, couverture et plans manquants : Phase 4.
- Claims, preuves factuelles et base GTA versionnée : Phase 5.
- Modèles visuels spécialisés véhicules/HUD : futures itérations de l’adaptateur, avec dataset et provenance explicites.
