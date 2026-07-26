// Contrôle du modèle multipiste : priorité vidéo opaque par hauteur de piste,
// aplatissement déterministe, et parité entre ce que consomment le lecteur et
// l'export.
import {
  audioFadeGainAt,
  clampAudioFadeMs,
  clampCropX,
  clampRate,
  clampVolume,
  clampVideoFadeMs,
  clampTextFadeMs,
  clipDurationMs,
  compactTrackIndices,
  cropXPercent,
  migrateProject,
  clipEndMs,
  clipSourceDurationMs,
  firstFreeTrack,
  flattenTracks,
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
} from "../src/timeline/compileTimeline";
import {
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
    version: 7,
    id: "p",
    name: "p",
    sources: { S0: source("S0"), S1: source("S1") },
    clips,
    textOverlays: [],
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
check("le projet est ramené au format 7", migre.version, 7);
check("le cadrage par défaut est le recadrage", migre.framing, "crop");
check("les clips sont recentrés", migre.clips[0].cropX, 0);
check("les clips sans volume restent au niveau original", migre.clips[0].volume, 1);
check("les anciens clips n'ont aucun fondu", [migre.clips[0].audioFadeInMs, migre.clips[0].audioFadeOutMs], [0, 0]);
check(
  "les anciens clips n'ont aucun fondu vidéo inventé",
  [migre.clips[0].videoFadeInMs, migre.clips[0].videoFadeOutMs],
  [0, 0],
);
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
