// Contrôle du modèle multipiste : priorité vidéo opaque par hauteur de piste,
// aplatissement déterministe, et parité entre ce que consomment le lecteur et
// l'export.
import {
  clampCropX,
  clampRate,
  clipDurationMs,
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
  type Clip,
  type SourceInfo,
} from "../src/types";
import {
  editorReducer,
  initialEditorState,
  type EditorState,
} from "../src/state/editor";

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
    version: 4,
    id: "p",
    name: "p",
    sources: { S0: source("S0"), S1: source("S1") },
    clips,
    framing: "crop",
    createdAt: "",
    updatedAt: "",
  },
  clips,
  selectedClipId,
});

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
check("le projet est ramené au format 4", migre.version, 4);
check("le cadrage par défaut est le recadrage", migre.framing, "crop");
check("les clips sont recentrés", migre.clips[0].cropX, 0);

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
console.log("\nTOUT PASSE");
