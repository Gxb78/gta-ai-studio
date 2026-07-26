# GTA Studio — Instructions permanentes

Ce fichier est la constitution du dépôt depuis la refonte du 25 juillet 2026. L'ancienne application et son ancienne constitution sont archivées dans `legacy/` (lecture seule).

## Mission

Éditeur de montage vidéo **local, ultra-fluide et sans latence** pour transformer des rushs GTA en contenus verticaux prêts pour TikTok (1080×1920). L'utilisateur importe un rush, coupe, ajuste, exporte. Les options de montage s'ajoutent par couches successives ; plus tard, une IA d'aide au montage viendra se brancher sur cet éditeur.

La fluidité d'édition prime sur tout le reste. Une fonctionnalité qui dégrade la réactivité de la timeline ou de la lecture est refusée ou repensée.

## Principe cardinal : zéro serveur dans la boucle d'interaction

- Lecture, scrubbing, cuts, trims, réorganisation : **100 % côté client**, sur un proxy 720p à GOP courtes, via une balise vidéo et une EDL (liste de segments virtuels).
- FFmpeg n'intervient que pour : l'import (proxy, vignettes, waveform) et l'export final. Jamais pendant l'édition.
- Interdits tant qu'un besoin n'est pas démontré et mesuré : serveur HTTP local, SQLite, file de jobs, workers, sidecar Python, microservices. C'est cette machinerie qui a tué la v0.x (voir `legacy/`).

## Architecture

- Application plate à la racine : Tauri 2 (Rust) + React 19 + TypeScript strict + Vite.
- `src/` : interface et logique d'édition (état, EDL, timeline). `src-tauri/src/` : commandes média et persistance.
- Projets = fichiers JSON écrits de façon atomique (temporaire puis renommage) dans le dossier de données de l'app (`%APPDATA%/studio.gta.editor`) : `proxies/`, `thumbs/`, `waveforms/`, `projects/`, `exports/`.
- Les rushs d'origine ne sont **jamais** modifiés ni déplacés ; on les référence par chemin + empreinte.
- **Pistes vidéo empilées, opaques** (décidé le 25 juillet 2026) : chaque clip porte une piste (`Clip.track`, 0 = principale, en bas). À un instant donné, l'image visible est celle du clip de la piste la plus haute qui couvre cet instant ; à sa fin, on retombe automatiquement sur la piste active en dessous, qui a continué de défiler sous la surcouche. Le non-chevauchement ne s'applique qu'**à l'intérieur** d'une piste. Lecture et export ne connaissent pas les pistes : ils consomment le montage **aplati** par `flattenTracks`, ce qui garde un moteur unique.
  - Ce n'est PAS un compositeur. L'aplatissement résout des pistes vidéo **opaques** en sélectionnant le clip prioritaire ; ajouter une piste est donc gratuit tant qu'elle reste opaque. Une véritable étape de composition sera nécessaire pour tout ce qui laisse voir plusieurs pistes à la fois : opacité partielle, incrustation, écran partagé, masque, fond vert, modes de fusion.
- **Vitesse constante par clip** (décidé le 25 juillet 2026) : `Clip.playbackRate`, borné de 0,25× à 4×. `srcInMs`/`srcOutMs` restent exprimés dans le temps du RUSH ; seule la durée occupée sur la timeline change (`clipDurationMs = durée source / vitesse`).
  - **Une seule conversion, partout** : `timelineTimeToSourceTime(clip, t)`. Lecture, aplatissement, découpe, trim, vignettes, forme d'onde et export passent par elle. La dupliquer garantit une divergence entre l'aperçu et le rendu — c'est déjà arrivé une fois sur la découpe, un test l'a rattrapé.
  - À l'export : `setpts=(PTS-STARTPTS)/rate` pour l'image, chaîne d'`atempo` pour le son. Pas encore de vitesse variable ni de courbe.
- **Deux plans dérivés, jamais confondus** (décidé le 25 juillet 2026) : `resolveVideoPlan` donne ce qui se **voit**, `resolveAudioPlan` ce qui s'**entend**. Un clip porte `audioEnabled`, vrai par défaut sur la piste principale et faux sur les surcouches : poser un plan de coupe ne doit pas couper le son de ce qui se joue dessous. À la lecture, les balises vidéo sont **muettes** et une paire de balises audio suit le plan sonore, recalée sur le playhead dès qu'elle dérive. À l'export, les deux plans sont concaténés séparément puis mappés ensemble.
  - Palier suivant, non fait : l'audio est encore résolu **par priorité de piste** parmi les clips sonores, donc une seule source à la fois. Le vrai mixage (`AUDIO = mixage`), le volume par clip, les fondus et le ducking ne toucheront QUE `resolveAudioPlan` et la branche audio de l'export.
- **Multi-rush et lecteur à deux balises** (décidé le 25 juillet 2026) : un projet contient plusieurs rushs (`Project.sources`, indexés par empreinte) et chaque clip référence le sien (`Clip.sourceId`). L'aperçu utilise **deux balises vidéo en alternance** : pendant que l'une joue, l'autre charge et pré-positionne le clip suivant ; à la jonction on échange par opacité. Changer le `src` d'une balise unique coûte des centaines de millisecondes — inacceptable au regard du principe cardinal. Ne pas revenir à une balise unique ; c'est aussi ce mécanisme qui portera les fondus enchaînés de la v0.3.
- **Positionnement libre** (décidé le 25 juillet 2026) : chaque clip porte sa position sur la timeline (`timelineStartMs`). Deux clips ne se chevauchent jamais, mais ils peuvent être disjoints ; un intervalle vide est un « trou », rendu noir silencieux à la lecture comme à l'export. C'est ce qui permet à un bord tiré à la souris de rester sous le curseur. Ne pas revenir à un enchaînement implicite par cumul des durées.
- **L'aperçu EST la sortie** (décidé le 26 juillet 2026) : l'écran principal est un canvas **9:16 réel**, pas un cadre 16:9 avec un guide dessiné dessus. Conséquences, à tenir ensemble :
  - Le cadrage vertical (`Project.framing` : `crop` ou `blur`) appartient au **projet**, plus à la fenêtre d'export. Deux valeurs distinctes rendraient l'aperçu menteur ; la fenêtre d'export modifie donc le projet, elle n'a pas son réglage à elle.
  - Chaque clip porte son **décalage de cadrage** (`Clip.cropX`, de −1 à +1, 0 = centré), sans effet en fond flou. Le cadrage est donc appliqué **par segment** dans le graphe FFmpeg, avant la concaténation, et plus en une passe globale après : c'est la seule façon d'avoir un cadrage par clip.
  - Le format de sortie est **imposé** (1080×1920, `OUTPUT_WIDTH`/`OUTPUT_HEIGHT` côté TS, `OUT_WIDTH`/`OUT_HEIGHT` côté Rust : les deux paires doivent rester alignées). C'est aussi ce qui homogénéise les flux pour `concat`.
  - Correspondance exacte aperçu / export : `crop` = `object-fit: cover` + `object-position` piloté par `cropX` ; `blur` = image entière (`contain`) sur une copie élargie et floutée, dessinée dans un canvas 90×160 puis étirée. Flouter 90×160 ne coûte rien ; flouter 1080×1920 à chaque image coûterait le budget de la lecture.
  - Mode secondaire « rush entier » : on sort du cadre de sortie et le viseur 9:16 se place là où `cropX` regarde. C'est un mode de travail, jamais la référence.
- **Layout à trois zones** (décidé le 26 juillet 2026) : barre supérieure (projet, sauvegarde, historique, export) — barre d'outils verticale + Médias + aperçu + Inspecteur — timeline à hauteur ajustable. Rien de la lecture ni du montage ne remonte dans la barre supérieure : le transport vit sous l'aperçu, les réglages de clip dans l'inspecteur. Les panneaux latéraux se replient pour rendre la hauteur à l'aperçu.
  - **En-têtes de pistes** hors du défilement horizontal, recalés sur le défilement vertical par une écriture directe de `transform` : nom (V1, V2…), œil, verrou, son.
  - Un œil fermé retire la piste des **deux** plans (image et son) : l'aperçu doit montrer ce que l'export écrira. Masquage et verrouillage sont de l'**état de session**, pas du montage : ils ne sont pas enregistrés dans le projet.
- **Le backend transporte le montage, il ne l'interprète pas** (décidé le 26 juillet 2026, renforcé le même jour) : `save_project`/`load_project`/`load_last_project` manipulent un `serde_json::Value` brut, jamais une structure Rust typée du montage. Un `#[serde(flatten)]` sur `Clip`/`Project` avait d'abord semblé suffisant, mais ne protège que ces deux niveaux : un champ ajouté à `SourceInfo`, `ProbeInfo` ou tout objet imbriqué futur aurait pu redisparaître au premier passage par une structure qui ne le connaît pas. Le passe-plat rend la question sans objet — ce qui entre est exactement ce qui ressort. Ce fichier ne lit dans le document que le strict nécessaire à son propre travail (identifiant, chemins de proxy pour vérifier leur présence, quelques champs d'affichage pour la liste des projets récents), jamais pour le réécrire.
- Commandes FFmpeg construites uniquement depuis des valeurs typées et validées. Jamais de shell libre, jamais de chaîne produite par un LLM exécutée telle quelle.
- Durées en millisecondes, JSON UTF-8, messages d'erreur en français et actionnables.

## Budgets de performance

- Interaction timeline (trim, drag, scrub) : < 16 ms par frame, aucune requête réseau.
- Seek sur le proxy : quasi instantané (GOP 15).
- Import d'un rush : proportionnel à sa durée, avec progression visible et cache réutilisé (empreinte).

## Périmètre par couches (une seule couche à la fois)

1. **v0.1 (actuelle)** : import d'un rush → cuts/trim/split/réorganisation/undo → export 1080×1920 (recadrage centré ou fond flou). Rien d'autre.
2. **v0.2 (en cours)** : confort — faits : multi-rushs, vitesse par clip, son par clip et par piste, glisser-déposer (fichiers sur la fenêtre, médias sur la timeline), projets récents, relocalisation d'un rush déplacé, panneau Médias, inspecteur, en-têtes de pistes. Restent : volume par clip et fondus audio.
3. v0.3 : habillage — texte, musique, transitions simples, sous-titres automatiques (tâche de fond, jamais dans la boucle d'interaction).
4. v0.4+ : IA d'aide au montage — détection de moments forts, suggestions de cuts, brief → premier jet. S'inspirer des idées de `legacy/` sans réimporter son architecture.

Ne pas implémenter une couche future sans instruction explicite de l'utilisateur.

## Legacy et données

- `legacy/` : archive consultable de l'ancienne app (source d'idées : patterns FFmpeg dans `legacy/services/api/src/gta_studio_api/media.py` et `render.py`). Ne pas builder, ne pas modifier, ne pas réintroduire.
- `data/` à la racine : résidu de l'ancien pipeline, contient des copies de rushs. Ne pas supprimer sans accord explicite de l'utilisateur.

## Vérifications avant de déclarer terminé

```powershell
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri dev   # vérification manuelle du flux réel
```

Ne jamais annoncer une vérification non exécutée. Si une vérification est impossible dans l'environnement courant, le dire explicitement.

## Règles de travail

- `git status` avant de modifier ; préserver les changements non liés ; commit uniquement si demandé.
- Petites fonctions, types explicites, pas de `any`, pas de code mort, pas de secrets.
- Toute nouvelle dépendance doit être justifiée ; en cas de doute, s'en passer.
- Une erreur visible vaut mieux qu'un faux succès ; une capacité absente produit un diagnostic clair.
- Rapport final court : résultat réel, fichiers modifiés, vérifications exécutées, limites, étape suivante.
