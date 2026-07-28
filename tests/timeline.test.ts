// Contrôle du modèle multipiste : priorité vidéo opaque par hauteur de piste,
// aplatissement déterministe, et parité entre ce que consomment le lecteur et
// l'export.
import {
  ASSET_VERSION,
  audioFadeGainAt,
  clampAudioFadeMs,
  clampCropX,
  clampRate,
  clampVolume,
  clampVideoFadeMs,
  clampTextFadeMs,
  clipDurationMs,
  compactTrackIndices,
  normalizeZoomRegion,
  zoomAt,
  zoomOffset,
  zoomScaleAt,
  cropXPercent,
  CURRENT_PROJECT_VERSION,
  isProjectVersionSupported,
  isUnwantedKeyRepeat,
  migrateProject,
  sourcesNeedingRegeneration,
  UnsupportedProjectVersionError,
  clipEndMs,
  clipSourceDurationMs,
  firstFreeTrack,
  flattenTracks,
  MAX_TRANSITION_MS,
  resolveAudioPlan,
  resolveVideoPlan,
  timelineGaps,
  timelineTimeToSourceTime,
  textFadeGainAt,
  videoFadeGainAt,
  type Clip,
  type SourceInfo,
} from "../src/types";
import {
  editorReducer,
  effectiveTextOverlays,
  initialEditorState,
  type EditorState,
} from "../src/state/editor";
import {
  compileTimeline,
  findSegmentIndex,
  rawTransitionCapacityMs,
} from "../src/timeline/compileTimeline";
import {
  audioTransitionGains,
  createPlaybackClock,
  decideMediaPrime,
  mediaIsPrimed,
} from "../src/playback/usePlayback";

const clip = (
  id: string,
  track: number,
  start: number,
  srcIn: number,
  dur: number,
  sourceId = `S${track}`,
): Clip => ({
  id,
  sourceId,
  track,
  timelineStartMs: start,
  srcInMs: srcIn,
  srcOutMs: srcIn + dur,
  audioEnabled: track === 0,
  volume: 1,
  audioFadeInMs: 0,
  audioFadeOutMs: 0,
  videoFadeInMs: 0,
  videoFadeOutMs: 0,
  transitionInMs: 0,
  playbackRate: 1,
  cropX: 0,
});

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  ÉCHEC ${label}\n        attendu ${e}\n        obtenu  ${a}`);
  }
}

/** Vérifie qu'un appel lève, et laisse examiner l'erreur obtenue. */
function checkThrows(label: string, fn: () => unknown, verify: (error: unknown) => boolean): void {
  try {
    fn();
    failures += 1;
    console.log(`  ÉCHEC ${label}\n        attendu une levée, rien n'a été levé`);
  } catch (error) {
    if (verify(error)) {
      console.log(`  ok    ${label}`);
    } else {
      failures += 1;
      console.log(`  ÉCHEC ${label}\n        levée inattendue : ${String(error)}`);
    }
  }
}

const sortClipsById = (clips: Clip[]) =>
  [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);

const summary = (clips: Clip[]) =>
  clips.map((c) => `${c.sourceId}:${c.timelineStartMs}-${clipEndMs(c)}@${c.srcInMs}`);

const compiledSummary = (clips: readonly { clip: Clip }[]) =>
  summary(clips.map((segment) => segment.clip));

// --- Noyau d'aplatissement ---------------------------------------------------

console.log("Surcouche au milieu de la piste principale");
check(
  "découpe en trois, la principale continue dessous",
  summary(flattenTracks([clip("a", 0, 0, 1000, 26000), clip("b", 1, 10000, 0, 8000)])),
  ["S0:0-10000@1000", "S1:10000-18000@0", "S0:18000-26000@19000"],
);

console.log("Surcouche débordant la fin de la principale");
check(
  "la surcouche continue seule",
  summary(flattenTracks([clip("a", 0, 0, 0, 10000), clip("b", 1, 8000, 0, 6000)])),
  ["S0:0-8000@0", "S1:8000-14000@0"],
);

console.log("Surcouche couvrant tout");
check(
  "la principale disparaît",
  summary(flattenTracks([clip("a", 0, 0, 0, 5000), clip("b", 1, 0, 2000, 5000)])),
  ["S1:0-5000@2000"],
);

console.log("Deux clips contigus du même rush");
check(
  "fusionnés en un seul segment",
  summary(flattenTracks([clip("a", 0, 0, 0, 5000), clip("a2", 0, 5000, 5000, 5000, "S0")])),
  ["S0:0-10000@0"],
);

console.log("Piste masquée");
check(
  "la surcouche masquée ne compte pas",
  summary(flattenTracks([clip("a", 0, 0, 0, 10000), clip("b", 1, 2000, 0, 3000)], new Set([1]))),
  ["S0:0-10000@0"],
);
check(
  "réactivée, elle reprend la main",
  summary(flattenTracks([clip("a", 0, 0, 0, 10000), clip("b", 1, 2000, 0, 3000)])),
  ["S0:0-2000@0", "S1:2000-5000@0", "S0:5000-10000@5000"],
);

// --- Cas ajoutés à la demande ------------------------------------------------

console.log("Trois pistes actives au même instant");
check(
  "la plus haute gagne partout où elle existe",
  summary(
    flattenTracks([
      clip("a", 0, 0, 0, 30000),
      clip("b", 1, 5000, 0, 15000),
      clip("c", 2, 10000, 0, 5000),
    ]),
  ),
  [
    "S0:0-5000@0",
    "S1:5000-10000@0",
    "S2:10000-15000@0",
    "S1:15000-20000@10000",
    "S0:20000-30000@20000",
  ],
);

console.log("Deux surcouches aux frontières exactement identiques");
check(
  "la plus haute l'emporte, sans segment parasite",
  summary(
    flattenTracks([
      clip("a", 0, 0, 0, 20000),
      clip("b", 1, 5000, 0, 5000),
      clip("c", 2, 5000, 3000, 5000),
    ]),
  ),
  ["S0:0-5000@0", "S2:5000-10000@3000", "S0:10000-20000@10000"],
);

console.log("Surcouche commençant exactement à la fin d'une autre");
check(
  "aucun trou, aucun segment de durée nulle",
  summary(
    flattenTracks([
      clip("a", 0, 0, 0, 20000),
      clip("b", 1, 5000, 0, 5000),
      clip("c", 1, 10000, 0, 5000, "S1b"),
    ]),
  ),
  ["S0:0-5000@0", "S1:5000-10000@0", "S1b:10000-15000@0", "S0:15000-20000@15000"],
);

console.log("Trous successifs");
check(
  "deux trous distincts détectés",
  timelineGaps(
    flattenTracks([
      clip("a", 0, 0, 0, 3000),
      clip("b", 0, 6000, 0, 3000, "S0b"),
      clip("c", 0, 12000, 0, 3000, "S0c"),
    ]),
  ),
  [
    { startMs: 3000, endMs: 6000 },
    { startMs: 9000, endMs: 12000 },
  ],
);

console.log("Trou comblé par une surcouche");
check(
  "aucun trou visible",
  timelineGaps(
    flattenTracks([
      clip("a", 0, 0, 0, 4000),
      clip("a2", 0, 8000, 0, 4000, "S0b"),
      clip("b", 1, 4000, 0, 4000),
    ]),
  ),
  [],
);

console.log("Déterminisme");
const base = [
  clip("a", 0, 0, 0, 30000),
  clip("b", 1, 5000, 0, 15000),
  clip("c", 2, 10000, 0, 5000),
];
check(
  "l'ordre du tableau en mémoire n'influe pas",
  summary(flattenTracks([base[2], base[0], base[1]])),
  summary(flattenTracks(base)),
);

console.log("Suppression de la piste supérieure");
check(
  "la principale redevient intégralement visible",
  summary(flattenTracks([clip("a", 0, 0, 0, 30000)])),
  ["S0:0-30000@0"],
);

// --- Placement automatique d'un rush ----------------------------------------

console.log("Choix de piste à l'ajout d'un rush");
check("piste principale si la place est libre", firstFreeTrack([clip("a", 0, 0, 0, 5000)], 6000, 10000, 0), 0);
check("monte d'une piste en cas de collision", firstFreeTrack([clip("a", 0, 0, 0, 10000)], 2000, 5000, 0), 1);
check(
  "crée une piste seulement en dernier recours",
  firstFreeTrack([clip("a", 0, 0, 0, 10000), clip("b", 1, 0, 0, 10000)], 2000, 5000, 0),
  2,
);

// --- Réducteur : découpe d'un clip recouvert ---------------------------------

const source = (id: string): SourceInfo => ({
  id,
  originalPath: `${id}.mp4`,
  proxyPath: `${id}-proxy.mp4`,
  thumbPaths: [],
  thumbIntervalMs: 1000,
  waveformPath: null,
  assetVersion: 4,
  probe: { durationMs: 600000, width: 1920, height: 1080, fps: 30, hasAudio: true, videoCodec: "h264" },
});

const stateWith = (clips: Clip[], selectedClipId: string | null): EditorState => ({
  ...initialEditorState,
  project: {
    version: 9,
    id: "p",
    name: "p",
    sources: { S0: source("S0"), S1: source("S1") },
    clips,
    textOverlays: [],
    zooms: [],
    framing: "crop",
    createdAt: "",
    updatedAt: "",
  },
  clips,
  selectedClipId,
});

console.log("Titres superposés");
const titleBase = stateWith([clip("base-titre", 0, 0, 0, 5000)], null);
const titleAdded = editorReducer(titleBase, { type: "ADD_TEXT", atMs: 1000 });
check("un titre est ajouté au playhead", titleAdded.textOverlays[0]?.timelineStartMs, 1000);
check("sa durée par défaut est de trois secondes", titleAdded.textOverlays[0]?.timelineEndMs, 4000);
check("le titre ajouté est sélectionné", titleAdded.selectedTextOverlayId, titleAdded.textOverlays[0]?.id);
const titleUpdated = editorReducer(titleAdded, {
  type: "UPDATE_TEXT",
  textOverlayId: titleAdded.textOverlays[0].id,
  patch: { text: "Mission réussie", x: 2, fontSizePx: 999 },
});
check("le texte est modifiable", titleUpdated.textOverlays[0]?.text, "Mission réussie");
check("la position est bornée par le réducteur", titleUpdated.textOverlays[0]?.x, 1);
check("la taille est bornée par le réducteur", titleUpdated.textOverlays[0]?.fontSizePx, 180);
const titleFaded = editorReducer(titleUpdated, {
  type: "UPDATE_TEXT",
  textOverlayId: titleUpdated.textOverlays[0].id,
  patch: { fadeInMs: 9000, fadeOutMs: 500 },
});
check(
  "les fondus du titre sont bornés à sa demi-durée",
  [titleFaded.textOverlays[0].fadeInMs, titleFaded.textOverlays[0].fadeOutMs],
  [1500, 500],
);
check("titre transparent au début", textFadeGainAt(titleFaded.textOverlays[0], 1000), 0);
check("titre à demi visible pendant l'entrée", textFadeGainAt(titleFaded.textOverlays[0], 1750), 0.5);
check("titre transparent à la fin", textFadeGainAt(titleFaded.textOverlays[0], 4000), 0);
check("fondu de titre limité à deux secondes", clampTextFadeMs(9000, 10_000), 2000);
const titleUndo = editorReducer(titleUpdated, { type: "UNDO" });
check("l'édition du titre est annulable", titleUndo.textOverlays[0]?.text, "Nouveau titre");
const titleUndoAdd = editorReducer(titleUndo, { type: "UNDO" });
check("l'ajout du titre est annulable", titleUndoAdd.textOverlays.length, 0);
const titleRedoAdd = editorReducer(titleUndoAdd, { type: "REDO" });
check("l'ajout du titre est rétablissable", titleRedoAdd.textOverlays.length, 1);
const titleTransient = editorReducer(titleAdded, {
  type: "TEXT_TRANSIENT",
  textOverlayId: titleAdded.textOverlays[0].id,
  timelineStartMs: 2000,
  timelineEndMs: 4500,
});
check(
  "le geste déplace immédiatement le titre visible",
  effectiveTextOverlays(titleTransient)[0]?.timelineStartMs,
  2000,
);
check(
  "le geste ne modifie pas encore le titre committé",
  titleTransient.textOverlays[0]?.timelineStartMs,
  1000,
);
check("le geste ne remplit pas l'historique", titleTransient.past.length, titleAdded.past.length);
const titleCommitted = editorReducer(titleTransient, { type: "TEXT_GESTURE_COMMIT" });
check("le relâchement committe le titre", titleCommitted.textOverlays[0]?.timelineStartMs, 2000);
check("un geste entier crée une seule entrée d'historique", titleCommitted.past.length, 2);
const titleCancelled = editorReducer(
  editorReducer(titleAdded, {
    type: "TEXT_TRANSIENT",
    textOverlayId: titleAdded.textOverlays[0].id,
    timelineStartMs: 2500,
    timelineEndMs: 5000,
  }),
  { type: "TEXT_GESTURE_CANCEL" },
);
check("Échap restaure le titre committé", effectiveTextOverlays(titleCancelled)[0]?.timelineStartMs, 1000);
const titleAtEnd = editorReducer(titleBase, { type: "ADD_TEXT", atMs: 4500 });
const shortenedUnderTitle = editorReducer(titleAtEnd, {
  type: "SET_CLIP_RATE",
  clipId: "base-titre",
  rate: 4,
});
check(
  "un titre devenu entièrement hors montage est retiré",
  shortenedUnderTitle.textOverlays.length,
  0,
);

const covered = [clip("bas", 0, 0, 0, 20000), clip("haut", 1, 5000, 0, 10000)];

console.log("Découpe au playhead");
const cutNoSelection = editorReducer(stateWith(covered, null), { type: "SPLIT_AT", timelineMs: 8000 });
check(
  "sans sélection, coupe le clip visible (celui du dessus)",
  cutNoSelection.clips.filter((c) => c.track === 1).length,
  2,
);
check(
  "sans sélection, le clip du dessous reste entier",
  cutNoSelection.clips.filter((c) => c.track === 0).length,
  1,
);

const cutSelected = editorReducer(stateWith(covered, "bas"), { type: "SPLIT_AT", timelineMs: 8000 });
check(
  "avec sélection, coupe le clip recouvert malgré tout",
  cutSelected.clips.filter((c) => c.track === 0).length,
  2,
);
check("avec sélection, la surcouche reste entière", cutSelected.clips.filter((c) => c.track === 1).length, 1);

console.log("Une découpe fraîche : refusion voulue, mais identité et transition récupérables");
// Bug réel : juste après une découpe (SPLIT_AT), les deux moitiés sont
// réglées à l'identique, donc `flattenTracks` les refusionne en UN segment —
// c'est un choix voulu (voir le commentaire sur `videoEnvelopeCanMerge`, et
// les tests d'indépendance des plans plus haut). Le vrai bug était en aval :
// `sourceClipFor` exigeait qu'UN SEUL clip committé couvre le segment fusionné
// EN ENTIER, ce que ni la gauche ni la droite ne fait seule — `match` valait
// `undefined`, et le repli sur un id synthétique cassait `visibleClip` côté
// App.tsx (cadrage réinitialisé à 0) et la frontière de la découpe devenait
// introuvable pour l'inspecteur de transition.
const unSeulClip = [clip("unique", 0, 0, 0, 10000)];
const decoupe = editorReducer(stateWith(unSeulClip, "unique"), { type: "SPLIT_AT", timelineMs: 4000 });
const [gauche, droite] = decoupe.clips.slice().sort((a, b) => a.timelineStartMs - b.timelineStartMs);
const compileApresDecoupe = compileTimeline(decoupe.clips, new Set(), {
  S0: source("S0"),
});
check(
  "les deux moitiés restent fusionnées en un seul segment (comportement voulu)",
  compileApresDecoupe.video.segments.length,
  1,
);
check(
  // sourceClipFor ne couvre plus que le DÉBUT du segment, donc c'est la
  // moitié GAUCHE (celle qui commence avec le segment) qui est retrouvée.
  "le segment fusionné retrouve un clip COMMITTÉ réel, pas un id synthétique",
  compileApresDecoupe.video.segments[0]?.sourceClipId,
  gauche.id,
);
check(
  "ce clip réel existe bel et bien dans le montage",
  decoupe.clips.some((c) => c.id === compileApresDecoupe.video.segments[0]?.sourceClipId),
  true,
);
check(
  // La frontière n'est plus visible dans les segments, mais elle reste
  // calculable directement depuis les deux clips committés bruts — c'est ce
  // secours que l'inspecteur utilise désormais quand la recherche par segment
  // échoue (voir App.tsx, `precedingClip`).
  "la capacité de transition reste calculable depuis les clips bruts",
  rawTransitionCapacityMs(gauche, droite, { S0: source("S0") }),
  MAX_TRANSITION_MS,
);

console.log("Enveloppe d'un zoom");
const zoomTest = {
  id: "z1",
  timelineStartMs: 1000,
  timelineEndMs: 3000,
  scale: 2,
  x: 0.75,
  y: 0.25,
  rampInMs: 500,
  rampOutMs: 500,
  direction: "in" as const,
  easing: "linear" as const,
};
// Hors des bornes, la valeur est EXACTEMENT 1 : c'est ce qui garantit qu'on
// retrouve la vue d'avant, au pixel près, et pas « à peu près ».
check("avant le zoom, aucun agrandissement", zoomScaleAt(zoomTest, 999), 1);
check("après le zoom, la vue d'avant est retrouvée", zoomScaleAt(zoomTest, 3001), 1);
check("à mi-rampe d'entrée, la moitié du chemin", zoomScaleAt(zoomTest, 1250), 1.5);
check("au palier, l'agrandissement plein", zoomScaleAt(zoomTest, 2000), 2);
check("à mi-rampe de sortie, la moitié du chemin", zoomScaleAt(zoomTest, 2750), 1.5);
// Rampes nulles : le zoom est plein dès la première image, sans division par
// zéro ni NaN qui se propagerait jusqu'au transform de l'aperçu.
check(
  "sans rampe, l'agrandissement est immédiat",
  zoomScaleAt({ ...zoomTest, rampInMs: 0, rampOutMs: 0 }, 1000.001),
  2,
);
// Deux rampes qui se chevaucheraient : la borne de normalisation les ramène à
// la moitié de la durée, donc le zoom atteint tout juste son maximum au milieu.
const zoomSerré = normalizeZoomRegion({ ...zoomTest, rampInMs: 5000, rampOutMs: 5000 }, 10000);
check("les rampes sont bornées à la moitié de la durée", zoomSerré.rampInMs, 1000);
check("le maximum est atteint au milieu", zoomScaleAt(zoomSerré, 2000), 2);

console.log("Décalage du zoom : aucun bord noir");
// À 2×, la fenêtre visible fait la moitié du cadre : son centre ne peut pas
// s'écarter de plus d'un quart du centre sans laisser entrer du vide.
check("un point visé au bord est ramené à la limite", zoomOffset(1, 2), 0.25);
check("l'autre bord aussi, symétriquement", zoomOffset(0, 2), -0.25);
check("le centre ne bouge pas", zoomOffset(0.5, 2), 0);
check("sans agrandissement, aucun décalage possible", zoomOffset(1, 1), 0);
// Plus on zoome, plus on peut s'écarter — la limite tend vers un demi-cadre.
check("à 4×, la marge est plus grande", zoomOffset(1, 4), 0.375);

console.log("Deux zooms ne se chevauchent jamais");
// C'est cette garantie qui permet à la lecture et à l'export de n'en retenir
// qu'un seul, donc de tenir en UNE expression FFmpeg.
const chevauchants = editorReducer(
  {
    ...stateWith([clip("bas", 0, 0, 0, 20000)], null),
    zooms: [
      { ...zoomTest, id: "a", timelineStartMs: 1000, timelineEndMs: 5000 },
      { ...zoomTest, id: "b", timelineStartMs: 3000, timelineEndMs: 7000 },
    ],
  },
  { type: "UPDATE_ZOOM", zoomId: "a", patch: {} },
);
check("le second est repoussé derrière le premier", chevauchants.zooms[1]?.timelineStartMs, 5000);
check("aucun instant n'est couvert deux fois", zoomAt(chevauchants.zooms, 4999)?.id, "a");
check("et le suivant prend le relais", zoomAt(chevauchants.zooms, 5000)?.id, "b");
// Repoussé, mais avec SA PROPRE durée conservée (4000ms, sa demande d'origine)
// — pas tronqué à ce qu'il reste avant la fin du montage.
check("le second garde sa durée demandée, juste décalé", chevauchants.zooms[1]?.timelineEndMs, 9000);

console.log("Geste sur un zoom : deplacement et rognage");
const baseZooms = stateWith([clip("bas", 0, 0, 0, 20000)], null);
const deuxZooms = {
  ...baseZooms,
  zooms: [
    { ...zoomTest, id: "a", timelineStartMs: 2000, timelineEndMs: 4000 },
    { ...zoomTest, id: "b", timelineStartMs: 8000, timelineEndMs: 10000 },
  ],
};

// Pendant le geste, rien n'entre dans l'historique : c'est la meme regle que
// pour les clips et les titres.
const zoomDeplace = editorReducer(deuxZooms, {
  type: "ZOOM_TRANSIENT",
  zoomId: "a",
  timelineStartMs: 5000,
  timelineEndMs: 7000,
});
check("le geste ne touche pas au montage committe", zoomDeplace.zooms[0].timelineStartMs, 2000);
check("aucune entree d'historique pendant le geste", zoomDeplace.past.length, 0);
check(
  "mais l'etat transitoire suit le pointeur",
  zoomDeplace.transientZooms?.[0].timelineStartMs,
  5000,
);

// La difference avec un titre : deux zooms ne peuvent pas se chevaucher, donc
// le geste BUTE sur le voisin au lieu de le repousser ou de le faire
// disparaitre sous le pointeur.
const contreVoisin = editorReducer(deuxZooms, {
  type: "ZOOM_TRANSIENT",
  zoomId: "a",
  timelineStartMs: 7000,
  timelineEndMs: 9000,
});
check(
  "le zoom bute sur son voisin de droite",
  contreVoisin.transientZooms?.[0].timelineEndMs,
  8000,
);
check("le voisin, lui, n'a pas bouge", contreVoisin.transientZooms?.[1].timelineStartMs, 8000);

// Le commit passe par pushHistory : une seule entree pour tout le geste.
const zoomCommit = editorReducer(zoomDeplace, { type: "ZOOM_GESTURE_COMMIT" });
check("le commit applique le geste", zoomCommit.zooms[0].timelineStartMs, 5000);
check("une seule entree d'historique pour tout le geste", zoomCommit.past.length, 1);
check("l'etat transitoire est rendu", zoomCommit.transientZooms, null);

// Echap : on revient exactement a l'etat d'avant, sans entree d'historique.
const zoomAnnule = editorReducer(zoomDeplace, { type: "ZOOM_GESTURE_CANCEL" });
check("annuler le geste rend l'etat committe", zoomAnnule.zooms[0].timelineStartMs, 2000);
check("et ne laisse rien dans l'historique", zoomAnnule.past.length, 0);

// Rognage sous la duree minimale : refuse, plutot que de produire un zoom
// invisible que `resolveZoomOverlaps` supprimerait au commit.
const tropCourt = editorReducer(deuxZooms, {
  type: "ZOOM_TRANSIENT",
  zoomId: "a",
  timelineStartMs: 2000,
  timelineEndMs: 2050,
});
check("un rognage sous la duree minimale est refuse", tropCourt.transientZooms, null);

console.log("Le moteur de collision des zooms ne détruit plus le montage");
// Quatre bugs réels, reproduits en exécutant le réducteur directement, comme
// demandé. L'ancien `resolveZoomOverlaps` triait TOUS les zooms par position
// et cascadait aveuglément de gauche à droite, sans savoir lequel venait
// d'être touché : celui qui commençait le plus tôt gagnait toujours, entier,
// quel qu'il soit. Le nouveau protège explicitement le zoom qu'une action
// vient de manipuler (`priorityId`, voir `resolveZoomOverlaps`) ; c'est lui
// qui garde exactement ce qui a été demandé, jamais un autre.

// 1) Ajouter (ou ici, étendre) un zoom AVANT un zoom existant ne le supprime
// plus : l'ancien est repoussé derrière, pas effacé.
const avantExistant = editorReducer(
  {
    ...stateWith([clip("bas", 0, 0, 0, 20000)], null),
    zooms: [
      { ...zoomTest, id: "new", timelineStartMs: 0, timelineEndMs: 500 },
      { ...zoomTest, id: "old", timelineStartMs: 1000, timelineEndMs: 1500 },
    ],
  },
  { type: "UPDATE_ZOOM", zoomId: "new", patch: { timelineEndMs: 2000 } },
);
check(
  "le zoom qui vient d'être étendu garde exactement sa nouvelle étendue",
  [avantExistant.zooms.find((z) => z.id === "new")?.timelineStartMs, avantExistant.zooms.find((z) => z.id === "new")?.timelineEndMs],
  [0, 2000],
);
check(
  "l'ancien zoom SURVIT, repoussé juste après — plus jamais supprimé en silence",
  avantExistant.zooms.some((z) => z.id === "old"),
  true,
);
check(
  "et garde sa propre durée (500ms), simplement décalé",
  [avantExistant.zooms.find((z) => z.id === "old")?.timelineStartMs, avantExistant.zooms.find((z) => z.id === "old")?.timelineEndMs],
  [2000, 2500],
);

// 2) Modifier un zoom contre son voisin ne le raccourcit plus : le voisin
// garde sa durée, juste repoussé.
const contreVoisinUpdate = editorReducer(
  {
    ...stateWith([clip("bas", 0, 0, 0, 20000)], null),
    zooms: [
      { ...zoomTest, id: "a", timelineStartMs: 0, timelineEndMs: 2000 },
      { ...zoomTest, id: "b", timelineStartMs: 3000, timelineEndMs: 5000 },
    ],
  },
  { type: "UPDATE_ZOOM", zoomId: "a", patch: { timelineEndMs: 4000 } },
);
check(
  "le zoom modifié garde exactement l'étendue demandée",
  contreVoisinUpdate.zooms.find((z) => z.id === "a")?.timelineEndMs,
  4000,
);
check(
  "le voisin n'est plus raccourci : il garde ses 2000ms, juste décalé",
  [contreVoisinUpdate.zooms.find((z) => z.id === "b")?.timelineStartMs, contreVoisinUpdate.zooms.find((z) => z.id === "b")?.timelineEndMs],
  [4000, 6000],
);

// 3) Déplacer un zoom en arrière, par-dessus ce qui le précédait, ne le
// tronque plus à son bord de tête : c'est ce qui précédait qui cède la place.
const deplacementEnArriere = editorReducer(
  {
    ...stateWith([clip("bas", 0, 0, 0, 20000)], null),
    zooms: [
      { ...zoomTest, id: "z", timelineStartMs: 0, timelineEndMs: 1000 },
      { ...zoomTest, id: "a", timelineStartMs: 3000, timelineEndMs: 5000 },
    ],
  },
  // "a" (2000ms) déplacé de [3000,5000] à [500,2500] : même durée, juste plus tôt.
  { type: "UPDATE_ZOOM", zoomId: "a", patch: { timelineStartMs: 500, timelineEndMs: 2500 } },
);
check(
  "le déplacement est honoré en entier — plus jamais transformé en rognage",
  [deplacementEnArriere.zooms.find((z) => z.id === "a")?.timelineStartMs, deplacementEnArriere.zooms.find((z) => z.id === "a")?.timelineEndMs],
  [500, 2500],
);
check(
  "ce qui le précédait cède la place à son tour, sans perdre sa durée",
  [deplacementEnArriere.zooms.find((z) => z.id === "z")?.timelineStartMs, deplacementEnArriere.zooms.find((z) => z.id === "z")?.timelineEndMs],
  [2500, 3500],
);

// 4) Un zoom qui disparaît FAUTE DE PLACE (cas légitime, pas un bug) ne laisse
// plus la sélection pointer sur un id fantôme.
const dureeSerree = editorReducer(
  {
    ...stateWith([clip("bas", 0, 0, 0, 2100)], null),
    zooms: [
      { ...zoomTest, id: "new", timelineStartMs: 0, timelineEndMs: 2000 },
      { ...zoomTest, id: "old", timelineStartMs: 1000, timelineEndMs: 1950 },
    ],
    selectedZoomId: "old",
  },
  { type: "UPDATE_ZOOM", zoomId: "new", patch: {} },
);
check(
  "faute de place, l'ancien zoom disparaît bel et bien",
  dureeSerree.zooms.some((z) => z.id === "old"),
  false,
);
check(
  "mais la sélection ne reste plus accrochée à son id disparu",
  dureeSerree.selectedZoomId,
  null,
);

console.log("La sélection ne survit pas à la disparition de sa cible");
// Bug réel : annuler une duplication laissait `selectedClipId` sur le clip
// disparu. L'inspecteur affichait « aucun clip sélectionné », la timeline ne
// surlignait rien, et Suppr comme M ne faisaient plus rien — sans explication.
const dupPuisAnnule = editorReducer(
  editorReducer(stateWith([clip("bas", 0, 0, 0, 20000)], "bas"), {
    type: "DUPLICATE_CLIP",
    clipId: "bas",
  }),
  { type: "UNDO" },
);
check(
  "annuler une duplication libère la sélection devenue fantôme",
  dupPuisAnnule.selectedClipId,
  null,
);
check("le montage est bien revenu à un seul clip", dupPuisAnnule.clips.length, 1);
// Une sélection toujours valide, elle, doit être conservée.
const supprPuisAnnule = editorReducer(
  editorReducer(stateWith(covered, "haut"), { type: "DELETE_CLIP", clipId: "bas" }),
  { type: "UNDO" },
);
check("une sélection encore présente est conservée", supprPuisAnnule.selectedClipId, "haut");

console.log("Les trois sélections (clip, titre, zoom) sont mutuellement exclusives");
// Bug réel : SELECT_ZOOM ne vidait pas selectedClipId. Sélectionner un zoom
// laissait donc le clip précédemment sélectionné « actif » en silence :
// l'inspecteur affichait le zoom, mais Suppr (et M, Ctrl+D, les curseurs de
// cadrage/vitesse/volume…) continuaient d'agir sur le clip caché derrière —
// exécuté directement contre le réducteur, comme demandé.
const zoomPourSelection = {
  id: "zA",
  timelineStartMs: 0,
  timelineEndMs: 2000,
  scale: 1.6,
  x: 0.5,
  y: 0.5,
  rampInMs: 0,
  rampOutMs: 0,
  direction: "in" as const,
  easing: "linear" as const,
};
const baseSelection = {
  ...stateWith([clip("bas", 0, 0, 0, 20000)], "bas"),
  zooms: [zoomPourSelection],
  textOverlays: [
    { id: "t1", text: "x", timelineStartMs: 0, timelineEndMs: 1000, x: 0.5, y: 0.5, fontSizePx: 80, style: "impact" as const, fadeInMs: 0, fadeOutMs: 0 },
  ],
};
const clipPuisZoom = editorReducer(baseSelection, { type: "SELECT_ZOOM", zoomId: "zA" });
check("sélectionner un zoom vide la sélection de clip", clipPuisZoom.selectedClipId, null);
check("sélectionner un zoom vide la sélection de titre", clipPuisZoom.selectedTextOverlayId, null);
check("le zoom devient la sélection", clipPuisZoom.selectedZoomId, "zA");

const zoomPuisClip = editorReducer(clipPuisZoom, { type: "SELECT", clipId: "bas" });
check("sélectionner un clip vide la sélection de zoom", zoomPuisClip.selectedZoomId, null);
check("sélectionner un clip vide la sélection de titre", zoomPuisClip.selectedTextOverlayId, null);
check("le clip redevient la sélection", zoomPuisClip.selectedClipId, "bas");

const clipPuisTitre = editorReducer(baseSelection, { type: "SELECT_TEXT", textOverlayId: "t1" });
check("sélectionner un titre vide la sélection de clip", clipPuisTitre.selectedClipId, null);
check("sélectionner un titre vide la sélection de zoom", clipPuisTitre.selectedZoomId, null);
check("le titre devient la sélection", clipPuisTitre.selectedTextOverlayId, "t1");

console.log("Duplication, copie et collage");
// Une copie doit être un AUTRE clip : deux clips de même identifiant se
// sélectionneraient et se déplaceraient ensemble.
const reglé = {
  ...clip("bas", 0, 0, 0, 20000),
  playbackRate: 2,
  volume: 0.4,
  cropX: 0.5,
  videoFadeInMs: 500,
  transitionInMs: 400,
};
const duplique = editorReducer(stateWith([reglé], "bas"), {
  type: "DUPLICATE_CLIP",
  clipId: "bas",
});
const copieFaite = duplique.clips.find((c) => c.id !== "bas");
check("la duplication ajoute un clip", duplique.clips.length, 2);
check("la copie a un identifiant neuf", copieFaite?.id !== "bas", true);
check("la copie se pose juste après l'original", copieFaite?.timelineStartMs, 10000);
check("la copie garde la vitesse", copieFaite?.playbackRate, 2);
check("la copie garde le volume", copieFaite?.volume, 0.4);
check("la copie garde le cadrage", copieFaite?.cropX, 0.5);
check("la copie garde les fondus", copieFaite?.videoFadeInMs, 500);
// La transition décrit une jonction précise avec le clip précédent : elle n'a
// aucun sens sur une copie posée ailleurs.
check("la copie abandonne la transition d'entrée", copieFaite?.transitionInMs, 0);
check("la copie reste sur la piste de l'original si la place existe", copieFaite?.track, 0);
check("la copie devient la sélection", duplique.selectedClipId, copieFaite?.id);

// Copier ne touche pas au montage : rien ne change, aucune entrée d'historique.
const copie = editorReducer(stateWith(covered, "haut"), { type: "COPY_CLIP", clipId: "haut" });
check("copier ne modifie pas le montage", copie.clips.length, 2);
check("copier n'ouvre pas d'entrée d'historique", copie.past.length, 0);
check("copier remplit le presse-papiers", copie.clipboard?.id, "haut");

const colle = editorReducer(copie, { type: "PASTE_CLIP", atMs: 30000 });
check("coller ajoute un clip", colle.clips.length, 3);
check(
  "coller le pose à l'endroit demandé",
  colle.clips.find((c) => c.id === colle.selectedClipId)?.timelineStartMs,
  30000,
);
check(
  "coller sans presse-papiers ne fait rien",
  editorReducer(stateWith(covered, "haut"), { type: "PASTE_CLIP", atMs: 1000 }).clips.length,
  2,
);

console.log("Montée explicite sur une piste neuve");
// Remplaçant de la rangée fantôme qui s'affichait pendant les déplacements.
const monte = editorReducer(stateWith(covered, "bas"), {
  type: "CLIP_TO_NEW_TRACK",
  clipId: "bas",
});
// L'invariant est « au-dessus des autres », pas « piste numéro N » : en vidant
// sa piste d'origine, le clip déclenche le recompactage des indices, qui fait
// redescendre tout le monde d'un cran. C'est le rang relatif qui compte.
const basMonte = monte.clips.find((c) => c.id === "bas");
const hautReste = monte.clips.find((c) => c.id === "haut");
check("le clip passe au-dessus de l'autre", (basMonte?.track ?? 0) > (hautReste?.track ?? 0), true);
check("aucune piste vide n'est laissée derrière", compactTrackIndices(monte.clips), monte.clips);
check("une surcouche arrive muette", monte.clips.find((c) => c.id === "bas")?.audioEnabled, false);
// pushHistory recompacte les indices : un clip déjà seul tout en haut ne peut
// pas monter plus, sinon chaque appel laisserait une piste vide derrière lui.
const dejaEnHaut = editorReducer(stateWith(covered, "haut"), {
  type: "CLIP_TO_NEW_TRACK",
  clipId: "haut",
});
check("un clip déjà seul tout en haut ne bouge pas", dejaEnHaut, stateWith(covered, "haut"));

console.log("Déplacement d'un clip entre deux pistes");
const moved = editorReducer(stateWith(covered, "haut"), {
  type: "MOVE_TRANSIENT",
  clipId: "haut",
  timelineStartMs: 5000,
  track: 2,
});
check(
  "la piste change sans toucher aux bornes",
  (moved.transientClips ?? []).find((c) => c.id === "haut")?.track,
  2,
);
check(
  "le clip du dessous n'a pas bougé",
  (moved.transientClips ?? []).find((c) => c.id === "bas")?.timelineStartMs,
  0,
);

console.log("Piste visée bornée à une piste neuve au-dessus des pistes committées");
// Bug réel trouvé à l'usage : un pointeur qui reste au-dessus de la rangée
// fantôme pendant un déplacement fait grimper le nombre de pistes de un à
// chaque image (la rangée fantôme remonte d'autant, le pointeur se retrouve
// dessus l'image suivante) — un montage s'est retrouvé avec 76 pistes en
// moins de deux secondes. Le réducteur doit refuser toute piste au-delà
// d'UNE nouvelle piste au-dessus du maximum committé, quelle que soit la
// valeur envoyée par l'interface.
const versUnePisteAbsurde = editorReducer(stateWith(covered, "haut"), {
  type: "MOVE_TRANSIENT",
  clipId: "haut",
  timelineStartMs: 5000,
  track: 99,
});
check(
  "la piste est ramenée au plus à une piste neuve (trackCount des clips committés)",
  (versUnePisteAbsurde.transientClips ?? []).find((c) => c.id === "haut")?.track,
  2,
);

// --- Compaction des indices de piste -----------------------------------------

// `Clip.track` n'a de sens que par sa position RELATIVE aux autres pistes.
// Rien n'empêche un indice de dériver loin au-dessus des pistes réellement
// occupées (voir l'incident des 76 pistes, ci-dessus) : cette fonction
// referme l'écart sans rien changer d'autre.
console.log("Compaction des indices de piste");
const withTracks = (tracks: number[]): Clip[] =>
  tracks.map((track, i) => clip(`c${i}`, track, i * 1000, 0, 500, `S${track}-${i}`));

check(
  "un trou isolé loin au-dessus est refermé",
  compactTrackIndices(withTracks([0, 1, 75])).map((c) => c.track),
  [0, 1, 2],
);
check(
  "les doublons de piste comptent pour un seul cran",
  compactTrackIndices(withTracks([4, 4, 12])).map((c) => c.track),
  [0, 0, 1],
);
check(
  "l'ordre relatif est préservé, y compris avec des doublons multiples",
  compactTrackIndices(withTracks([0, 2, 2, 8])).map((c) => c.track),
  [0, 1, 1, 2],
);
check(
  "un montage déjà compact ressort inchangé",
  compactTrackIndices(withTracks([0, 1, 2])).map((c) => c.track),
  [0, 1, 2],
);
check("un montage vide ressort vide", compactTrackIndices([]), []);

check(
  "rien d'autre qu'un numéro de piste ne bouge",
  (() => {
    const troue = { ...clip("solo", 75, 3000, 1200, 900), audioEnabled: false, cropX: -0.4 };
    const [compacte] = compactTrackIndices([troue]);
    return {
      timelineStartMs: compacte.timelineStartMs,
      srcInMs: compacte.srcInMs,
      srcOutMs: compacte.srcOutMs,
      audioEnabled: compacte.audioEnabled,
      cropX: compacte.cropX,
      playbackRate: compacte.playbackRate,
    };
  })(),
  { timelineStartMs: 3000, srcInMs: 1200, srcOutMs: 2100, audioEnabled: false, cropX: -0.4, playbackRate: 1 },
);

console.log("Compaction au chargement d'un projet corrompu (round-trip complet)");
const projetCorrompu = {
  version: 4 as const,
  id: "p-corrompu",
  name: "corrompu",
  sources: { S75: source("S75") },
  clips: [{ id: "c1", sourceId: "S75", track: 75, timelineStartMs: 0, srcInMs: 0, srcOutMs: 1000 }],
  createdAt: "",
  updatedAt: "",
};
const apresChargement = migrateProject(projetCorrompu);
check("la première ouverture referme déjà le trou", apresChargement.clips[0]?.track, 0);
check("une seule piste subsiste", Math.max(...apresChargement.clips.map((c) => c.track)) + 1, 1);

// La sauvegarde est un passe-plat strict (voir project.rs) : « sauvegarder
// puis recharger » revient donc à repasser le même document par
// migrateProject. Le résultat doit rester stable — la compaction est
// idempotente, un second passage ne doit plus rien changer.
const resauvegarde = JSON.parse(JSON.stringify(apresChargement));
const apresRechargement = migrateProject(resauvegarde);
check(
  "un second chargement ne change plus rien (idempotence)",
  apresRechargement.clips.map((c) => c.track),
  apresChargement.clips.map((c) => c.track),
);

// --- Parité lecteur / export -------------------------------------------------

// --- Vitesse par clip --------------------------------------------------------

const withRate = (c: Clip, rate: number): Clip => ({ ...c, playbackRate: rate });

console.log("Durée occupée sur la timeline");
check("1x : la durée source", clipDurationMs(clip("a", 0, 0, 0, 10000)), 10000);
check("2x : deux fois moins", clipDurationMs(withRate(clip("a", 0, 0, 0, 10000), 2)), 5000);
check("0,5x : deux fois plus", clipDurationMs(withRate(clip("a", 0, 0, 0, 10000), 0.5)), 20000);

console.log("Conversion timeline vers source");
const rapide = withRate(clip("a", 0, 4000, 1000, 10000), 2);
check("au début du clip", timelineTimeToSourceTime(rapide, 4000), 1000);
check("au milieu, la source avance deux fois plus vite", timelineTimeToSourceTime(rapide, 5000), 3000);
check("à la fin", timelineTimeToSourceTime(rapide, clipEndMs(rapide)), 11000);

console.log("Bornes de vitesse");
check("écrêtée en haut", clampRate(12), 4);
check("écrêtée en bas", clampRate(0.01), 0.25);
check("valeur aberrante ramenée à 1", clampRate(Number.NaN), 1);

console.log("Principale accélérée sous une surcouche");
// Principale à 2x : 20 s de rush occupent 10 s de timeline.
// Surcouche à 1x de 3 s à 6 s.
const socleRapide = withRate(clip("bas", 0, 0, 0, 20000), 2);
const planRapide = flattenTracks([socleRapide, clip("haut", 1, 3000, 0, 3000)]);
check(
  "la principale reprend au temps source qu'elle aurait atteint",
  summary(planRapide),
  ["S0:0-3000@0", "S1:3000-6000@0", "S0:6000-10000@12000"],
);
check("les vitesses sont conservées segment par segment", planRapide.map((s) => s.playbackRate), [2, 1, 2]);

console.log("Surcouche accélérée");
const surcoucheRapide = flattenTracks([
  clip("bas", 0, 0, 0, 20000),
  withRate(clip("haut", 1, 5000, 0, 8000), 4),
]);
check(
  "elle n'occupe que 2 s de montage",
  summary(surcoucheRapide),
  ["S0:0-5000@0", "S1:5000-7000@0", "S0:7000-20000@7000"],
);

console.log("Découpe d'un clip accéléré");
const coupeRapide = editorReducer(stateWith([socleRapide], "bas"), {
  type: "SPLIT_AT",
  timelineMs: 4000,
});
const morceaux = sortClipsById(coupeRapide.clips);
check("deux morceaux", morceaux.length, 2);
check("le second démarre au bon temps source", morceaux[1].srcInMs, 8000);
check("la vitesse est héritée", morceaux[1].playbackRate, 2);
check(
  "la durée totale de montage est conservée",
  morceaux.reduce((sum, c) => sum + clipDurationMs(c), 0),
  10000,
);

console.log("Changement de vitesse d'un clip qui a la place de s'étendre");
// Cas trouvé en manipulant l'interface, pas par les tests : un clip SEUL
// (ou avec un large trou à droite) qui change de vitesse ne touche ni ses
// bornes timeline ni ses bornes source — seul playbackRate change. Le
// comparateur de « geste sans effet » doit donc lui aussi regarder la
// vitesse, sinon l'action est prise pour un geste nul et purement ignorée.
const seul = [clip("a", 0, 0, 0, 10000)];
const accelere = editorReducer(stateWith(seul, "a"), { type: "SET_CLIP_RATE", clipId: "a", rate: 2 });
check(
  "la vitesse est bien appliquée quand rien ne la contraint",
  accelere.clips.find((c) => c.id === "a")?.playbackRate,
  2,
);
check(
  "un second changement de vitesse est lui aussi pris en compte",
  editorReducer(accelere, { type: "SET_CLIP_RATE", clipId: "a", rate: 0.5 }).clips.find((c) => c.id === "a")
    ?.playbackRate,
  0.5,
);

console.log("Changement de vitesse borné par le voisin");
const serre = [clip("a", 0, 0, 0, 5000), clip("b", 0, 5000, 0, 5000)];
const ralenti = editorReducer(stateWith(serre, "a"), { type: "SET_CLIP_RATE", clipId: "a", rate: 0.5 });
const aRalenti = ralenti.clips.find((c) => c.id === "a")!;
check("le clip ne déborde pas sur le suivant", clipDurationMs(aRalenti), 5000);
check("la portion de rush utilisée est raccourcie", aRalenti.srcOutMs, 2500);

console.log("Parité lecture / export avec vitesse");
// L'export reçoit exactement les segments du plan : mêmes bornes source, même
// vitesse. On vérifie que la durée de montage reconstituée correspond.
const dureeMontage = planRapide.reduce((sum, s) => sum + clipDurationMs(s), 0);
check("durée totale identique au montage", dureeMontage, 10000);
check(
  "chaque segment a une durée source cohérente avec sa vitesse",
  planRapide.every((s) => Math.abs(clipSourceDurationMs(s) / s.playbackRate - clipDurationMs(s)) < 0.001),
  true,
);

// --- Plans vidéo et audio ----------------------------------------------------

// La règle du palier : la surcouche remplace l'IMAGE, mais son son est coupé
// par défaut, donc c'est le son de la piste principale qui continue.
console.log("Plans vidéo et audio séparés");
const avecSurcouche = [clip("bas", 0, 0, 0, 20000), clip("haut", 1, 5000, 0, 10000)];
check(
  "l'image passe à la surcouche",
  summary(resolveVideoPlan(avecSurcouche)),
  ["S0:0-5000@0", "S1:5000-15000@0", "S0:15000-20000@15000"],
);
check(
  "le son de la principale continue, sans coupure",
  summary(resolveAudioPlan(avecSurcouche)),
  ["S0:0-20000@0"],
);

const surcoucheSonore = [
  clip("bas", 0, 0, 0, 20000),
  { ...clip("haut", 1, 5000, 0, 10000), audioEnabled: true },
];
check(
  "une surcouche rendue sonore reprend la main sur le son",
  summary(resolveAudioPlan(surcoucheSonore)),
  ["S0:0-5000@0", "S1:5000-15000@0", "S0:15000-20000@15000"],
);

const toutMuet = [{ ...clip("bas", 0, 0, 0, 20000), audioEnabled: false }];
check("un montage entièrement muet donne un plan audio vide", resolveAudioPlan(toutMuet).length, 0);

console.log("Bascule du son par le réducteur");
const coupe = editorReducer(stateWith(avecSurcouche, "bas"), {
  type: "TOGGLE_CLIP_AUDIO",
  clipId: "bas",
});
check(
  "couper le son du clip principal vide le plan audio",
  resolveAudioPlan(coupe.clips).length,
  0,
);
check("l'image, elle, ne change pas", summary(resolveVideoPlan(coupe.clips)).length, 3);

// Le lecteur et l'export consomment la MÊME liste (flattenTracks). On vérifie
// ici que cette liste est un montage continu, sans trou ni recouvrement, donc
// directement concaténable par FFmpeg.
console.log("Parité lecteur / export");
const flat = flattenTracks(covered);
let cursor = 0;
let contiguous = true;
for (const segment of flat) {
  if (segment.timelineStartMs !== cursor) contiguous = false;
  cursor = clipEndMs(segment);
}
check("les segments s'enchaînent sans discontinuité", contiguous, true);
check("la durée totale est conservée", cursor, 20000);

// --- Cadrage vertical --------------------------------------------------------
// Le cadrage vit dans le modèle, pas dans la fenêtre d'export : c'est ce qui
// permet à l'aperçu de montrer exactement la sortie.

console.log("Décalage de cadrage");
check("écrêté à droite", clampCropX(3), 1);
check("écrêté à gauche", clampCropX(-7), -1);
check("valeur aberrante recentrée", clampCropX(Number.NaN), 0);
check("centré = 50 %", cropXPercent(0), 50);
check("collé à droite = 100 %", cropXPercent(1), 100);
check("collé à gauche = 0 %", cropXPercent(-1), 0);

const cadre = editorReducer(stateWith(covered, "haut"), {
  type: "SET_CLIP_CROP_X",
  clipId: "haut",
  cropX: 0.5,
});
check("le réducteur écrit le cadrage du clip", cadre.clips.find((c) => c.id === "haut")?.cropX, 0.5);
check("et crée une entrée d'historique", cadre.past.length, 1);
check(
  "le cadrage traverse l'aplatissement",
  resolveVideoPlan(cadre.clips)
    .filter((segment) => segment.track === 1)
    .every((segment) => segment.cropX === 0.5),
  true,
);

// Deux morceaux du même rush, jointifs dans le temps source mais cadrés
// différemment, ne doivent PAS fusionner : ils ne produisent pas la même image.
const cadragesDifferents = [
  { ...clip("a", 0, 0, 0, 5000), cropX: 0 },
  { ...clip("b", 0, 5000, 5000, 5000, "S0"), cropX: 1 },
];
check(
  "deux cadrages différents restent deux segments",
  resolveVideoPlan(cadragesDifferents).length,
  2,
);
check(
  "le cadrage ne découpe pas le plan audio",
  resolveAudioPlan(cadragesDifferents).length,
  1,
);

console.log("Migration d'un projet antérieur au cadrage");
const migre = migrateProject({
  version: 3,
  id: "p",
  name: "p",
  sources: { S0: source("S0") },
  clips: [{ id: "a", sourceId: "S0", srcInMs: 0, srcOutMs: 1000, playbackRate: 1 }],
  createdAt: "",
  updatedAt: "",
});
check("le projet est ramené au format courant", migre.version, CURRENT_PROJECT_VERSION);
// Un projet d'avant les zooms n'en gagne aucun : on n'ajoute pas de mouvement
// à un montage que l'utilisateur avait validé sans.
check("aucun zoom n'est inventé", migre.zooms, []);
check("le cadrage par défaut est le recadrage", migre.framing, "crop");
check("les clips sont recentrés", migre.clips[0].cropX, 0);
check("les clips sans volume restent au niveau original", migre.clips[0].volume, 1);
check("les anciens clips n'ont aucun fondu", [migre.clips[0].audioFadeInMs, migre.clips[0].audioFadeOutMs], [0, 0]);
check(
  "les anciens clips n'ont aucun fondu vidéo inventé",
  [migre.clips[0].videoFadeInMs, migre.clips[0].videoFadeOutMs],
  [0, 0],
);
check("les anciens clips n'ont aucune transition inventée", migre.clips[0].transitionInMs, 0);
check("les anciens projets n'ont aucun titre inventé", migre.textOverlays.length, 0);
const ancienTitre = migrateProject({
  version: 6,
  id: "p-titre",
  name: "p-titre",
  sources: { S0: source("S0") },
  clips: [{ id: "a", sourceId: "S0", srcInMs: 0, srcOutMs: 5000, playbackRate: 1 }],
  textOverlays: [{
    id: "ancien-titre",
    text: "Avant les animations",
    timelineStartMs: 500,
    timelineEndMs: 2500,
    x: 0.5,
    y: 0.72,
    fontSizePx: 88,
    style: "impact",
  }],
  framing: "crop",
  createdAt: "",
  updatedAt: "",
});
check(
  "un ancien titre migre sans fondu inventé",
  [ancienTitre.textOverlays[0].fadeInMs, ancienTitre.textOverlays[0].fadeOutMs],
  [0, 0],
);

console.log("Un projet d'une version future est refusé, jamais rétrogradé");
// P0 : sans ce refus, un format inconnu (10, 11…) était migré en aveugle vers
// CURRENT_PROJECT_VERSION, perdant tout champ que cette version ne connaît
// pas, puis l'autosave réécrivait aussitôt le fichier appauvri sur le disque
// — une perte de données irréversible et silencieuse.
check(
  "le format courant est accepté",
  isProjectVersionSupported(CURRENT_PROJECT_VERSION),
  true,
);
check(
  "un format antérieur est accepté (les vieux formats s'infèrent par leurs champs)",
  isProjectVersionSupported(1),
  true,
);
check(
  "un format futur est refusé",
  isProjectVersionSupported(CURRENT_PROJECT_VERSION + 1),
  false,
);
check(
  "une version absente ou non numérique ne bloque rien (formats 1-8 sans plancher fiable)",
  [isProjectVersionSupported(undefined), isProjectVersionSupported("9")],
  [true, true],
);

const projetFutur = {
  version: CURRENT_PROJECT_VERSION + 1,
  id: "p-futur",
  name: "p-futur",
  sources: { S0: source("S0") },
  clips: [{ id: "a", sourceId: "S0", srcInMs: 0, srcOutMs: 1000, playbackRate: 1 }],
  createdAt: "",
  updatedAt: "",
};
checkThrows(
  "migrateProject refuse un format plus récent que ce qu'il connaît",
  () => migrateProject(projetFutur),
  (error) =>
    error instanceof UnsupportedProjectVersionError &&
    error.version === CURRENT_PROJECT_VERSION + 1,
);
// Le format courant, lui, continue de migrer sans encombre : le refus vise
// STRICTEMENT ce qui dépasse CURRENT_PROJECT_VERSION, rien de plus.
check(
  "le format courant ne déclenche jamais ce refus",
  migrateProject({ ...projetFutur, version: CURRENT_PROJECT_VERSION }).version,
  CURRENT_PROJECT_VERSION,
);

console.log("Un proxy manquant se répare, il n'efface plus le projet");
// Bug réel : le backend refusait d'ouvrir le moindre projet dont UN SEUL
// proxy manquait — y compris celui d'une source jamais posée sur la timeline
// — et rendait `null`, indiscernable de « aucun projet n'a jamais existé ».
// Le backend ouvre désormais tout document lisible ; c'est cette fonction,
// exécutée après coup, qui décide quelles sources régénérer.
const utiliseeEtAJour = source("utilisee");
const inutiliseeEtAJour = { ...source("inutilisee"), id: "inutilisee" };
const perimee = { ...source("perimee"), assetVersion: ASSET_VERSION - 1 };
check(
  "une source à jour avec son proxy présent n'a rien à régénérer",
  sourcesNeedingRegeneration([utiliseeEtAJour], new Set(["utilisee"])),
  [],
);
check(
  // Le cas précis du bug : une source jamais posée sur la timeline (le champ
  // "utilisée" n'existe même pas dans cette fonction, purement côté données —
  // c'est le proxy manquant, pas l'usage, qui doit déclencher la régénération).
  "un proxy absent déclenche la régénération, à jour ou non",
  sourcesNeedingRegeneration([inutiliseeEtAJour], new Set()),
  [inutiliseeEtAJour],
);
check(
  "une source périmée se régénère même si son proxy est présent",
  sourcesNeedingRegeneration([perimee], new Set(["perimee"])),
  [perimee],
);
check(
  "à jour et proxy présent : aucune des deux causes ne s'applique",
  sourcesNeedingRegeneration(
    [utiliseeEtAJour, inutiliseeEtAJour, perimee],
    new Set(["utilisee"]),
  ),
  [inutiliseeEtAJour, perimee],
);

console.log("Une touche maintenue ne répète pas les raccourcis, sauf les flèches");
// Bug réel : le gestionnaire clavier global ne filtrait `event.repeat` nulle
// part. Maintenir Suppr supprimait clip après clip sans borne, et Ctrl+V
// empilait des copies à la cadence de répétition du clavier — le temps de
// relâcher, bien plus qu'un seul clip pouvait disparaître ou s'empiler.
check("une première frappe (repeat=false) n'est jamais ignorée", isUnwantedKeyRepeat(false, "Delete"), false);
check("Suppr maintenu (repeat=true) est ignoré", isUnwantedKeyRepeat(true, "Delete"), true);
check("Ctrl+V maintenu (repeat=true) est ignoré", isUnwantedKeyRepeat(true, "v"), true);
check("Ctrl+D maintenu (repeat=true) est ignoré", isUnwantedKeyRepeat(true, "d"), true);
check(
  // Seule exemption : défiler ou ajuster un bord EN MAINTENANT la flèche est
  // le comportement voulu, comme dans n'importe quel éditeur.
  "flèche gauche maintenue reste autorisée",
  isUnwantedKeyRepeat(true, "ArrowLeft"),
  false,
);
check("flèche droite maintenue reste autorisée", isUnwantedKeyRepeat(true, "ArrowRight"), false);
check(
  "une flèche non répétée n'est de toute façon jamais ignorée",
  isUnwantedKeyRepeat(false, "ArrowLeft"),
  false,
);

console.log("Le verrou de piste protège un clip déjà sélectionné, pas seulement à la souris");
// Bug réel : le verrou n'était vérifié qu'à la souris, dans Timeline.tsx,
// avant même de dispatcher un geste. Suppr, Split, M, I/O, le changement de
// vitesse et chaque curseur de l'inspecteur ciblaient un clip par id sans
// jamais consulter `lockedTracks` — donc continuaient d'agir sur un clip déjà
// sélectionné avant que sa piste soit verrouillée. Exécuté directement contre
// le réducteur : "haut" vit sur la piste 1, verrouillée ; "bas" sur la piste
// 0, libre — même appel, deux issues différentes, ce qui prouve que le verrou
// cible précisément la piste concernée, pas tout le montage.
const verrouille = { ...stateWith(covered, "haut"), lockedTracks: [1] };

check(
  "SET_CLIP_CROP_X refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "SET_CLIP_CROP_X", clipId: "haut", cropX: 0.5 }).clips.find(
    (c) => c.id === "haut",
  )?.cropX,
  0,
);
check(
  "SET_CLIP_VOLUME refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "SET_CLIP_VOLUME", clipId: "haut", volume: 0.2 }).clips.find(
    (c) => c.id === "haut",
  )?.volume,
  1,
);
check(
  "SET_CLIP_AUDIO_FADE refusé sur un clip verrouillé",
  editorReducer(verrouille, {
    type: "SET_CLIP_AUDIO_FADE",
    clipId: "haut",
    side: "in",
    fadeMs: 1000,
  }).clips.find((c) => c.id === "haut")?.audioFadeInMs,
  0,
);
check(
  "SET_CLIP_VIDEO_FADE refusé sur un clip verrouillé",
  editorReducer(verrouille, {
    type: "SET_CLIP_VIDEO_FADE",
    clipId: "haut",
    side: "in",
    fadeMs: 1000,
  }).clips.find((c) => c.id === "haut")?.videoFadeInMs,
  0,
);
check(
  "SET_CLIP_TRANSITION_IN refusé sur un clip verrouillé",
  editorReducer(verrouille, {
    type: "SET_CLIP_TRANSITION_IN",
    clipId: "haut",
    durationMs: 500,
  }).clips.find((c) => c.id === "haut")?.transitionInMs,
  0,
);
check(
  "TOGGLE_CLIP_AUDIO (M) refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "TOGGLE_CLIP_AUDIO", clipId: "haut" }).clips.find(
    (c) => c.id === "haut",
  )?.audioEnabled,
  covered.find((c) => c.id === "haut")?.audioEnabled,
);
check(
  "SET_CLIP_RATE refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "SET_CLIP_RATE", clipId: "haut", rate: 2 }).clips.find(
    (c) => c.id === "haut",
  )?.playbackRate,
  1,
);
check(
  "TRIM_EDGE (I/O) refusé sur un clip verrouillé",
  editorReducer(verrouille, {
    type: "TRIM_EDGE",
    clipId: "haut",
    side: "left",
    edgeSrcMs: 2000,
  }).clips.find((c) => c.id === "haut")?.srcInMs,
  0,
);
check(
  "DELETE_CLIP (Suppr) refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "DELETE_CLIP", clipId: "haut" }).clips.length,
  2,
);
check(
  "SPLIT_AT refusé quand le clip visé au playhead est verrouillé",
  editorReducer(verrouille, { type: "SPLIT_AT", timelineMs: 8000 }).clips.length,
  2,
);
check(
  "CLIP_TO_NEW_TRACK refusé sur un clip verrouillé",
  editorReducer(verrouille, { type: "CLIP_TO_NEW_TRACK", clipId: "haut" }).clips.find(
    (c) => c.id === "haut",
  )?.track,
  1,
);
check(
  "MOVE_TRANSIENT refusé : le clip verrouillé reste sur place",
  editorReducer(verrouille, {
    type: "MOVE_TRANSIENT",
    clipId: "haut",
    timelineStartMs: 9000,
    track: 1,
  }).transientClips,
  null,
);
check(
  "TRIM_TRANSIENT refusé sur un clip verrouillé",
  editorReducer(verrouille, {
    type: "TRIM_TRANSIENT",
    clipId: "haut",
    side: "left",
    edgeSrcMs: 2000,
  }).transientClips,
  null,
);

// Le même appel, sur le clip NON verrouillé du même montage, doit réussir :
// preuve que le verrou cible la piste concernée, pas tout le réducteur.
check(
  "le même appel réussit sur un clip d'une piste NON verrouillée",
  editorReducer(verrouille, { type: "SET_CLIP_VOLUME", clipId: "bas", volume: 0.2 }).clips.find(
    (c) => c.id === "bas",
  )?.volume,
  0.2,
);

// Déverrouiller rend la main : ce n'est pas le clip qui est marqué, seulement
// la piste — TOGGLE_TRACK_LOCKED suffit à tout débloquer.
const deverrouille = editorReducer(verrouille, { type: "TOGGLE_TRACK_LOCKED", track: 1 });
check(
  "déverrouiller la piste rend le clip à nouveau modifiable",
  editorReducer(deverrouille, {
    type: "SET_CLIP_VOLUME",
    clipId: "haut",
    volume: 0.2,
  }).clips.find((c) => c.id === "haut")?.volume,
  0.2,
);

// Copier et dupliquer restent permis : ils ne modifient jamais le clip visé,
// seulement une copie indépendante ou le presse-papiers — rien à protéger.
check(
  "copier un clip verrouillé reste permis (lecture seule)",
  editorReducer(verrouille, { type: "COPY_CLIP", clipId: "haut" }).clipboard?.id,
  "haut",
);
check(
  "dupliquer un clip verrouillé reste permis (l'original n'est pas modifié)",
  editorReducer(verrouille, { type: "DUPLICATE_CLIP", clipId: "haut" }).clips.length,
  3,
);

console.log("Volume par clip");
check("volume négatif écrêté", clampVolume(-0.5), 0);
check("volume supérieur à l'original écrêté", clampVolume(3), 1);
check("volume non numérique ramené à l'original", clampVolume(Number.NaN), 1);
const volumeModifie = editorReducer(stateWith(covered, "haut"), {
  type: "SET_CLIP_VOLUME",
  clipId: "haut",
  volume: 0.35,
});
check(
  "le réducteur applique le volume",
  volumeModifie.clips.find((clip) => clip.id === "haut")?.volume,
  0.35,
);
check("le réglage de volume est annulable", volumeModifie.past.length, 1);
const volumesDifferents = [
  { ...clip("a", 0, 0, 0, 5000), volume: 1 },
  { ...clip("b", 0, 5000, 5000, 5000, "S0"), volume: 0.5 },
];
check(
  "deux volumes différents restent deux segments audio",
  resolveAudioPlan(volumesDifferents).map((segment) => segment.volume),
  [1, 0.5],
);
check(
  "le volume ne découpe pas le plan vidéo",
  resolveVideoPlan(volumesDifferents).length,
  1,
);

console.log("Fondus audio par clip");
const avecFondus = {
  ...clip("fade", 0, 0, 0, 10_000),
  audioFadeInMs: 1_000,
  audioFadeOutMs: 2_000,
};
check("début silencieux", audioFadeGainAt(avecFondus, 0), 0);
check("milieu du fondu d'entrée", audioFadeGainAt(avecFondus, 500), 0.5);
check("plateau au niveau nominal", audioFadeGainAt(avecFondus, 5_000), 1);
check("milieu du fondu de sortie", audioFadeGainAt(avecFondus, 9_000), 0.5);
check("fin silencieuse", audioFadeGainAt(avecFondus, 10_000), 0);
check("fondu borné à la moitié du clip", clampAudioFadeMs(9_000, 10_000), 5_000);
const fadeModifie = editorReducer(stateWith([clip("a", 0, 0, 0, 4_000)], "a"), {
  type: "SET_CLIP_AUDIO_FADE",
  clipId: "a",
  side: "in",
  fadeMs: 3_000,
});
check("le réducteur borne le fondu", fadeModifie.clips[0].audioFadeInMs, 2_000);
check("le fondu est annulable", fadeModifie.past.length, 1);
const fondusRetires = editorReducer(stateWith([avecFondus], "fade"), {
  type: "SET_CLIP_AUDIO_FADE",
  clipId: "fade",
  side: "both",
  fadeMs: 0,
});
check(
  "retirer les deux fondus est une seule action",
  {
    fades: [fondusRetires.clips[0].audioFadeInMs, fondusRetires.clips[0].audioFadeOutMs],
    history: fondusRetires.past.length,
  },
  { fades: [0, 0], history: 1 },
);
const clipsFondusContigus = [
  { ...clip("a", 0, 0, 0, 5_000), audioFadeOutMs: 1_000 },
  { ...clip("b", 0, 5_000, 5_000, 5_000, "S0"), audioFadeInMs: 1_000 },
];
check(
  "les enveloppes de deux clips contigus restent distinctes",
  resolveAudioPlan(clipsFondusContigus).length,
  2,
);
check(
  "les fondus ne découpent toujours pas le plan vidéo",
  resolveVideoPlan(clipsFondusContigus).length,
  1,
);
const fadeCoupe = editorReducer(stateWith([avecFondus], "fade"), {
  type: "SPLIT_AT",
  timelineMs: 5_000,
});
const fadeCoupeTrie = sortClipsById(fadeCoupe.clips);
check(
  "une coupe ne crée pas de fondu sur ses nouveaux bords",
  fadeCoupeTrie.map((segment) => [segment.audioFadeInMs, segment.audioFadeOutMs]),
  [[1_000, 0], [0, 2_000]],
);

console.log("Fondus vidéo par clip");
const avecFondusVideo = {
  ...clip("fade-video", 0, 0, 0, 10_000),
  videoFadeInMs: 1_000,
  videoFadeOutMs: 2_000,
};
check("image noire au début", videoFadeGainAt(avecFondusVideo, 0), 0);
check("demi-opacité à l'entrée", videoFadeGainAt(avecFondusVideo, 500), 0.5);
check("image opaque au plateau", videoFadeGainAt(avecFondusVideo, 5_000), 1);
check("demi-opacité à la sortie", videoFadeGainAt(avecFondusVideo, 9_000), 0.5);
check("image noire à la fin", videoFadeGainAt(avecFondusVideo, 10_000), 0);
check("fondu vidéo limité à trois secondes", clampVideoFadeMs(9_000, 10_000), 3_000);
const fadeVideoModifie = editorReducer(
  stateWith([clip("video", 0, 0, 0, 4_000)], "video"),
  {
    type: "SET_CLIP_VIDEO_FADE",
    clipId: "video",
    side: "in",
    fadeMs: 3_000,
  },
);
check("le réducteur borne le fondu vidéo", fadeVideoModifie.clips[0].videoFadeInMs, 2_000);
const fondusVideoContigus = [
  { ...clip("va", 0, 0, 0, 5_000), videoFadeOutMs: 1_000 },
  { ...clip("vb", 0, 5_000, 5_000, 5_000, "S0"), videoFadeInMs: 1_000 },
];
check(
  "deux enveloppes vidéo contiguës restent distinctes",
  resolveVideoPlan(fondusVideoContigus).length,
  2,
);
check(
  "les fondus vidéo ne découpent pas le plan audio",
  resolveAudioPlan(fondusVideoContigus).length,
  1,
);
const fadeVideoCoupe = editorReducer(stateWith([avecFondusVideo], "fade-video"), {
  type: "SPLIT_AT",
  timelineMs: 5_000,
});
check(
  "une coupe ne crée pas de fondu vidéo sur ses nouveaux bords",
  sortClipsById(fadeVideoCoupe.clips).map((segment) => [
    segment.videoFadeInMs,
    segment.videoFadeOutMs,
  ]),
  [[1_000, 0], [0, 2_000]],
);

// --- Pistes : désactivation et son -------------------------------------------

console.log("En-têtes de pistes");
const masque = editorReducer(stateWith(covered, null), { type: "TOGGLE_TRACK_HIDDEN", track: 1 });
check("la piste est notée masquée", masque.hiddenTracks, [1]);
check(
  "une piste masquée disparaît de l'image",
  summary(resolveVideoPlan(masque.clips, new Set(masque.hiddenTracks))),
  ["S0:0-20000@0"],
);
check(
  "et du son : l'aperçu et l'export voient la même chose",
  resolveAudioPlan(masque.clips, new Set(masque.hiddenTracks)).length,
  1,
);
check("aucune entrée d'historique pour un masquage", masque.past.length, 0);

const verrou = editorReducer(stateWith(covered, "haut"), { type: "TOGGLE_TRACK_LOCKED", track: 0 });
const versVerrou = editorReducer(verrou, {
  type: "MOVE_TRANSIENT",
  clipId: "haut",
  timelineStartMs: 7000,
  track: 0,
});
const deplace = (versVerrou.transientClips ?? []).find((c) => c.id === "haut");
check("un clip ne tombe pas sur une piste verrouillée", deplace?.track, 1);
check("mais son déplacement horizontal, lui, s'applique", deplace?.timelineStartMs, 7000);

const pisteMuette = editorReducer(stateWith(covered, null), {
  type: "SET_TRACK_AUDIO",
  track: 0,
  audioEnabled: false,
});
check(
  "couper le son d'une piste coupe tous ses clips",
  pisteMuette.clips.filter((c) => c.track === 0 && c.audioEnabled).length,
  0,
);

// --- Rush retrouvé après déplacement ----------------------------------------

console.log("Relocalisation d'un rush");
const court: SourceInfo = {
  ...source("S2"),
  probe: { ...source("S2").probe, durationMs: 8000 },
};
const relie = editorReducer(stateWith(covered, null), {
  type: "RELINK_SOURCE",
  missingId: "S0",
  source: court,
});
check(
  "les clips pointent vers le rush retrouvé",
  relie.clips.filter((c) => c.sourceId === "S2").length,
  1,
);
check(
  "les bornes sont ramenées dans la durée du nouveau fichier",
  relie.clips.find((c) => c.sourceId === "S2")?.srcOutMs,
  8000,
);
check("l'ancien rush est retiré du projet", relie.project?.sources.S0, undefined);

// Une exception suffit à faire sortir Node en erreur : pas besoin de `process`,
// donc pas besoin des types Node juste pour ce fichier.
if (failures > 0) throw new Error(`${failures} échec(s) — voir ci-dessus`);
console.log("Compilation centrale de la timeline");
const compileClips = [
  { ...withRate(clip("base", 0, 0, 0, 20000), 2), cropX: -0.25 },
  { ...clip("overlay", 1, 3000, 0, 4000), audioEnabled: false, cropX: 0.75 },
  clip("tail", 0, 12000, 0, 2000, "S2"),
];
const compiled = compileTimeline(compileClips, new Set());
check(
  "plan video compile identique",
  compiledSummary(compiled.video.segments),
  summary(resolveVideoPlan(compileClips)),
);
check(
  "plan audio compile identique",
  compiledSummary(compiled.audio.segments),
  summary(resolveAudioPlan(compileClips)),
);
check(
  "le volume est conservé dans le plan audio compilé",
  compiled.audio.segments.map((segment) => segment.clip.volume),
  resolveAudioPlan(compileClips).map((segment) => segment.volume),
);
check("trous compiles", compiled.gaps, timelineGaps(resolveVideoPlan(compileClips)));
check("pistes indexees", [...compiled.clipsByTrack.keys()], [0, 1]);
check("nombre de pistes", compiled.trackCount, 2);
check("nombre de sources", compiled.sourceCount, 3);

const compiledFadeInterrupted = compileTimeline(
  [
    avecFondus,
    { ...clip("voice", 1, 3_000, 0, 3_000, "S1"), audioEnabled: true },
  ],
  new Set(),
);
check(
  "le clip source survit à une interruption par une surcouche sonore",
  compiledFadeInterrupted.audio.segments.map((segment) => segment.sourceClip.id),
  ["fade", "voice", "fade"],
);
check(
  "la reprise du clip inférieur ne redémarre pas son fondu",
  audioFadeGainAt(compiledFadeInterrupted.audio.segments[2].sourceClip, 6_000),
  1,
);

const compiledVideoFadeInterrupted = compileTimeline(
  [
    avecFondusVideo,
    { ...clip("cover", 1, 300, 0, 400, "S1"), audioEnabled: false },
  ],
  new Set(),
);
check(
  "le clip vidéo source survit à une interruption pendant son fondu",
  compiledVideoFadeInterrupted.video.segments.map((segment) => segment.sourceClip.id),
  ["fade-video", "cover", "fade-video"],
);
check(
  "la reprise vidéo conserve l'avancement du fondu",
  videoFadeGainAt(compiledVideoFadeInterrupted.video.segments[2].sourceClip, 700),
  0.7,
);

const compiledHidden = compileTimeline(compileClips, new Set([1]));
check(
  "piste masquee absente des deux plans",
  {
    video: compiledHidden.video.segments.some((segment) => segment.clip.track === 1),
    audio: compiledHidden.audio.segments.some((segment) => segment.clip.track === 1),
  },
  { video: false, audio: false },
);

const emptyCompiled = compileTimeline([], new Set());
check(
  "montage vide",
  {
    video: emptyCompiled.video.segments.length,
    audio: emptyCompiled.audio.segments.length,
    durationMs: emptyCompiled.video.durationMs,
    gaps: emptyCompiled.gaps,
  },
  { video: 0, audio: 0, durationMs: 0, gaps: [] },
);

console.log("Fondus enchaînés centrés sur les coupes");
const transitionClips = [
  clip("transition-out", 0, 0, 1_000, 4_000, "S0"),
  {
    ...clip("transition-in", 0, 4_000, 2_000, 4_000, "S1"),
    transitionInMs: 1_000,
  },
];
const compiledTransition = compileTimeline(
  transitionClips,
  new Set(),
  { S0: source("S0"), S1: source("S1") },
);
check(
  "la transition est centrée sans déplacer la coupe",
  compiledTransition.video.transitions,
  [
    {
      fromIndex: 0,
      toIndex: 1,
      boundaryMs: 4_000,
      startMs: 3_500,
      endMs: 4_500,
      durationMs: 1_000,
    },
  ],
);
check(
  "le son reprend la même transition quand les deux plans coïncident",
  compiledTransition.audio.transitions,
  compiledTransition.video.transitions,
);
const transitionSurCoucheMuette = compileTimeline(
  [
    clip("son-continu", 0, 0, 0, 8_000, "S2"),
    { ...transitionClips[0], id: "overlay-out", track: 1, audioEnabled: false },
    {
      ...transitionClips[1],
      id: "overlay-in",
      track: 1,
      audioEnabled: false,
    },
  ],
  new Set(),
  { S0: source("S0"), S1: source("S1"), S2: source("S2") },
);
check(
  "une transition de surcouche muette ne coupe pas le son continu du dessous",
  {
    audioSegments: transitionSurCoucheMuette.audio.segments.length,
    audioTransitions: transitionSurCoucheMuette.audio.transitions.length,
  },
  { audioSegments: 1, audioTransitions: 0 },
);
const transitionAvecFonduAudio = compileTimeline(
  [transitionClips[0], { ...transitionClips[1], audioFadeInMs: 500 }],
  new Set(),
  { S0: source("S0"), S1: source("S1") },
);
check(
  "un fondu audio explicite reste prioritaire sur le fondu enchaîné sonore",
  transitionAvecFonduAudio.audio.transitions,
  [],
);
check("gains audio au début", audioTransitionGains(0), [1, 0]);
check("gains audio au centre", audioTransitionGains(0.5), [0.5, 0.5]);
check("gains audio à la fin", audioTransitionGains(1), [0, 1]);
const sansPoigneeEntrante = compileTimeline(
  [transitionClips[0], { ...transitionClips[1], srcInMs: 0, srcOutMs: 4_000 }],
  new Set(),
  { S0: source("S0"), S1: source("S1") },
);
check(
  "aucune transition n'est inventée sans poignée avant le plan entrant",
  sansPoigneeEntrante.video.transitions,
  [],
);
const transitionApresTrou = compileTimeline(
  [transitionClips[0], { ...transitionClips[1], timelineStartMs: 4_500 }],
  new Set(),
  { S0: source("S0"), S1: source("S1") },
);
check(
  "une transition ne traverse jamais un trou",
  transitionApresTrou.video.transitions,
  [],
);

console.log("Recherche binaire");
const indexedSegments = compileTimeline(
  [clip("first", 0, 1000, 0, 1000), clip("second", 0, 2500, 0, 1000)],
  new Set(),
).video.segments;
check("avant le premier", findSegmentIndex(indexedSegments, 999), -1);
check("debut exact", findSegmentIndex(indexedSegments, 1000), 0);
check("juste avant la fin", findSegmentIndex(indexedSegments, 1999.999), 0);
check("fin exclusive", findSegmentIndex(indexedSegments, 2000), -1);
check("dans un trou", findSegmentIndex(indexedSegments, 2250), -1);
check("frontiere suivante", findSegmentIndex(indexedSegments, 2500), 1);
check("apres le dernier", findSegmentIndex(indexedSegments, 3500), -1);

console.log("Regression audio partiel");
const image20Sound10 = compileTimeline(
  [
    { ...clip("image", 0, 0, 0, 20000), audioEnabled: false },
    { ...clip("sound", 1, 0, 0, 10000, "S1"), audioEnabled: true },
  ],
  new Set(),
);
check("image continue 20 s", image20Sound10.video.durationMs, 20000);
check(
  "son actif 10 s puis silence 10 s",
  {
    audioEnd: image20Sound10.audio.segments.at(-1)?.endMs,
    at9999: findSegmentIndex(image20Sound10.audio.segments, 9999),
    at10000: findSegmentIndex(image20Sound10.audio.segments, 10000),
  },
  { audioEnd: 10000, at9999: 0, at10000: -1 },
);

console.log("Horloge imperative");
const clockController = createPlaybackClock(125);
const clockNotifications: number[] = [];
const unsubscribeClock = clockController.clock.subscribe((playheadMs) => {
  clockNotifications.push(playheadMs);
});
clockController.publish(456.789);
check("temps exact lisible", clockController.clock.getPlayheadMs(), 456.789);
check("seek publie immediatement", clockNotifications, [125, 456.789]);
unsubscribeClock();
clockController.publish(900);
check("aucune notification apres desabonnement", clockNotifications, [125, 456.789]);

console.log("Préchargement vérifié des cuts");
check("une simple demande de chargement ne suffit pas", mediaIsPrimed(1, false, 5, 5), false);
check("un média encore en seek n'est pas prêt", mediaIsPrimed(4, true, 5, 5), false);
check("une image décodée sur la bonne cible est prête", mediaIsPrimed(2, false, 5.03, 5), true);
check("une image décodée trop loin de la cible est refusée", mediaIsPrimed(4, false, 5.2, 5), false);
check("un média prêt bascule immédiatement", decideMediaPrime(true, 0), "swap");
check("la dernière image est tenue pendant le préchargement", decideMediaPrime(false, 499), "hold");
check("le secours prend le relais à la borne", decideMediaPrime(false, 500), "fallback");

if (failures > 0) throw new Error(`${failures} echec(s) dans la compilation`);
console.log("\nTOUT PASSE");
