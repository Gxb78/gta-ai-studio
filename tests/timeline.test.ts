// Contrôle du modèle multipiste : priorité vidéo opaque par hauteur de piste,
// aplatissement déterministe, et parité entre ce que consomment le lecteur et
// l'export.
import {
  clipEndMs,
  firstFreeTrack,
  flattenTracks,
  resolveAudioPlan,
  resolveVideoPlan,
  timelineGaps,
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
    version: 3,
    id: "p",
    name: "p",
    sources: { S0: source("S0"), S1: source("S1") },
    clips,
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

// Une exception suffit à faire sortir Node en erreur : pas besoin de `process`,
// donc pas besoin des types Node juste pour ce fichier.
if (failures > 0) throw new Error(`${failures} échec(s) — voir ci-dessus`);
console.log("\nTOUT PASSE");
