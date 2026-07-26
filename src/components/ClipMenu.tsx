// Menu contextuel d'un clip de la timeline, ouvert au clic droit.
//
// Il ne contient que des actions qui existent déjà ailleurs (inspecteur,
// raccourcis) : c'est un raccourci vers ce qu'on fait le plus souvent sur un
// clip, jamais le seul endroit où une action est disponible. Une entrée qui
// n'aurait rien à faire — remettre un cadrage déjà centré, retirer des fondus
// absents — n'est pas grisée, elle n'est pas affichée : un menu court se lit
// plus vite qu'un menu majoritairement inerte.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  onClose: () => void;
  dispatch: (action: EditorAction) => void;
}

interface Entry {
  icon: IconName;
  label: string;
  action: EditorAction;
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
  onClose,
  dispatch,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  /** Position corrigée : le menu se retourne plutôt que de sortir de l'écran. */
  const [placement, setPlacement] = useState({ left: target.x, top: target.y });

  // En layout : la correction doit être appliquée AVANT la peinture, sinon le
  // menu s'affiche une image au mauvais endroit puis saute.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left =
      target.x + width + margin > window.innerWidth
        ? Math.max(margin, target.x - width)
        : target.x;
    const top =
      target.y + height + margin > window.innerHeight
        ? Math.max(margin, target.y - height)
        : target.y;
    setPlacement({ left, top });
  }, [target.x, target.y]);

  // Fermeture au clic extérieur, à Échap et au défilement : un menu contextuel
  // qui reste accroché pendant que la timeline défile pointe le vide.
  useEffect(() => {
    const abort = new AbortController();
    // EN CAPTURE, impérativement. Les gestes de la timeline appellent
    // `stopPropagation()` sur leur événement React, ce qui arrête aussi
    // l'événement natif au conteneur racine : en phase de bulle, la fenêtre ne
    // voyait jamais le clic et le menu restait ouvert. La capture passe avant
    // tout gestionnaire, donc avant toute possibilité d'être interrompue.
    const options = { signal: abort.signal, capture: true } as const;
    window.addEventListener(
      "pointerdown",
      (event: PointerEvent) => {
        if (!ref.current?.contains(event.target as Node)) onClose();
      },
      options,
    );
    window.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key === "Escape") onClose();
      },
      options,
    );
    window.addEventListener("wheel", () => onClose(), options);
    // Redimensionner la fenêtre laisserait le menu accroché dans le vide.
    window.addEventListener("resize", () => onClose(), options);
    return () => abort.abort();
  }, [onClose]);

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
  if (canSplit) {
    entries.push({
      icon: "split",
      label: "Couper ici",
      action: { type: "SPLIT_AT", timelineMs: target.timelineMs },
    });
  }
  if (canDelete) {
    entries.push({
      icon: "trash",
      label: "Supprimer",
      shortcut: "Suppr",
      action: { type: "DELETE_CLIP", clipId: clip.id },
      danger: true,
    });
  }

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
  if (clip.playbackRate !== 1) {
    entries.push({
      icon: "frame",
      label: "Vitesse 1×",
      action: { type: "SET_CLIP_RATE", clipId: clip.id, rate: 1 },
    });
  }
  if (clip.cropX !== 0) {
    entries.push({
      icon: "crop",
      label: "Recentrer",
      action: { type: "SET_CLIP_CROP_X", clipId: clip.id, cropX: 0 },
    });
  }
  if (clip.videoFadeInMs > 0 || clip.videoFadeOutMs > 0) {
    entries.push({
      icon: "frame",
      label: "Sans fondu vidéo",
      action: { type: "SET_CLIP_VIDEO_FADE", clipId: clip.id, side: "both", fadeMs: 0 },
    });
  }
  if (clip.audioFadeInMs > 0 || clip.audioFadeOutMs > 0) {
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
            dispatch(entry.action);
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
