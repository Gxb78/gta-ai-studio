// Menu contextuel d'un clip de la timeline, ouvert au clic droit.
//
// Il ne contient que des actions qui existent déjà ailleurs (inspecteur,
// raccourcis) : c'est un raccourci vers ce qu'on fait le plus souvent sur un
// clip, jamais le seul endroit où une action est disponible. Une entrée qui
// n'aurait rien à faire — remettre un cadrage déjà centré, retirer des fondus
// absents — n'est pas grisée, elle n'est pas affichée : un menu court se lit
// plus vite qu'un menu majoritairement inerte.

import { useFloatingMenu } from "../hooks/useFloatingMenu";
import { Icon, type IconName } from "./Icon";
import type { EditorAction } from "../state/editor";
import type { Clip } from "../types";

export interface ClipMenuTarget {
  clipId: string;
  /** Position du pointeur, en coordonnées fenêtre. */
  x: number;
  y: number;
  /** Instant de la timeline sous le pointeur : c'est là que « Diviser » coupe. */
  timelineMs: number;
}

interface Props {
  target: ClipMenuTarget;
  clip: Clip;
  /** Vrai si le playhead permet une découpe utile à cet endroit. */
  canSplit: boolean;
  /** Un clip est dans le presse-papiers : « Coller » a quelque chose à poser. */
  canPaste: boolean;
  /** Faux sur le dernier clip du montage : le réducteur en garde toujours un. */
  canDelete: boolean;
  /**
   * Piste du clip verrouillée : le réducteur refuse silencieusement toute
   * action qui le modifierait (voir `clipIsLocked` dans editor.ts). Une entrée
   * qui ne ferait rien ne doit pas apparaître, au même titre qu'un fondu déjà
   * absent — sans ce garde, le menu affichait « Supprimer », « Couper ici »
   * et consorts sur un clip verrouillé, actifs en apparence mais inertes au clic.
   */
  locked: boolean;
  onClose: () => void;
  dispatch: (action: EditorAction) => void;
  /**
   * Ouvre le menu de coupe étendue (SplitMenu) à la même position, avec ce
   * clip précoché. Distinct d'une simple `action` : ce n'est pas un dispatch
   * direct, mais une seconde étape où choisir quels titres/zooms/autres rushs
   * couper avec lui, en une seule entrée d'historique.
   */
  onExtendSplit: () => void;
}

interface Entry {
  icon: IconName;
  label: string;
  /** Dispatché directement au clic. Absent quand `onSelect` ouvre autre chose. */
  action?: EditorAction;
  /** Remplace `action` : une étape supplémentaire plutôt qu'un dispatch direct. */
  onSelect?: () => void;
  /** Raccourci équivalent, affiché à droite. Uniquement s'il fait EXACTEMENT
   *  la même chose : annoncer « S » sur une découpe au pointeur alors que la
   *  touche coupe au playhead serait un mensonge. */
  shortcut?: string;
  danger?: boolean;
  /** Ouvre un nouveau groupe : un filet est tracé au-dessus. */
  group?: boolean;
}

export function ClipMenu({
  target,
  clip,
  canSplit,
  canPaste,
  canDelete,
  locked,
  onClose,
  dispatch,
  onExtendSplit,
}: Props) {
  const { ref, placement } = useFloatingMenu<HTMLDivElement>(target.x, target.y, onClose);

  const entries: Entry[] = [];
  entries.push({
    icon: "duplicate",
    label: "Dupliquer",
    shortcut: "Ctrl+D",
    action: { type: "DUPLICATE_CLIP", clipId: clip.id },
  });
  entries.push({
    icon: "copy",
    label: "Copier",
    shortcut: "Ctrl+C",
    action: { type: "COPY_CLIP", clipId: clip.id },
  });
  if (canPaste) {
    entries.push({
      icon: "paste",
      label: "Coller ici",
      shortcut: "Ctrl+V",
      action: { type: "PASTE_CLIP", atMs: target.timelineMs },
    });
  }
  if (canSplit && !locked) {
    entries.push({
      icon: "split",
      label: "Couper ici",
      action: { type: "SPLIT_AT", timelineMs: target.timelineMs },
    });
    entries.push({
      icon: "layers",
      label: "Couper ici et étendre…",
      onSelect: onExtendSplit,
    });
  }
  if (canDelete && !locked) {
    entries.push({
      icon: "trash",
      label: "Supprimer",
      shortcut: "Suppr",
      action: { type: "DELETE_CLIP", clipId: clip.id },
      danger: true,
    });
  }

  if (!locked) {
    entries.push({
      icon: clip.audioEnabled ? "soundOff" : "sound",
      label: clip.audioEnabled ? "Couper le son" : "Rendre le son",
      shortcut: "M",
      action: { type: "TOGGLE_CLIP_AUDIO", clipId: clip.id },
      group: true,
    });
    entries.push({
      icon: "layers",
      label: "Nouvelle piste au-dessus",
      action: { type: "CLIP_TO_NEW_TRACK", clipId: clip.id },
    });
  }
  if (clip.playbackRate !== 1 && !locked) {
    entries.push({
      icon: "frame",
      label: "Vitesse 1×",
      action: { type: "SET_CLIP_RATE", clipId: clip.id, rate: 1 },
    });
  }
  if (clip.cropX !== 0 && !locked) {
    entries.push({
      icon: "crop",
      label: "Recentrer",
      action: { type: "SET_CLIP_CROP_X", clipId: clip.id, cropX: 0 },
    });
  }
  if ((clip.videoFadeInMs > 0 || clip.videoFadeOutMs > 0) && !locked) {
    entries.push({
      icon: "frame",
      label: "Sans fondu vidéo",
      action: { type: "SET_CLIP_VIDEO_FADE", clipId: clip.id, side: "both", fadeMs: 0 },
    });
  }
  if ((clip.audioFadeInMs > 0 || clip.audioFadeOutMs > 0) && !locked) {
    entries.push({
      icon: "volume",
      label: "Sans fondu audio",
      action: { type: "SET_CLIP_AUDIO_FADE", clipId: clip.id, side: "both", fadeMs: 0 },
    });
  }

  return (
    <div
      ref={ref}
      className="menu clip-menu"
      role="menu"
      style={placement}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry) => (
        <button
          key={entry.label}
          type="button"
          className={
            "menu-item" + (entry.danger ? " warn" : "") + (entry.group ? " group" : "")
          }
          onClick={() => {
            if (entry.onSelect) entry.onSelect();
            else if (entry.action) dispatch(entry.action);
            onClose();
          }}
        >
          <Icon name={entry.icon} size={14} />
          {entry.label}
          {entry.shortcut && <span className="menu-key">{entry.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
