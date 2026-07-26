// Poignée horizontale entre les deux moitiés de la colonne de gauche.
//
// Même principe que celle de la timeline : elle travaille sur un ÉCART depuis
// le début du geste, jamais sur une distance à un bord de la fenêtre. C'est ce
// qui la rend insensible à l'endroit où la colonne se trouve dans la page.

import { useCallback, useEffect, useRef } from "react";

interface Props {
  /** Hauteur courante du volet du bas, en pixels. */
  height: number;
  onHeightChange: (height: number) => void;
}

export function SideGrip({ height, onHeightChange }: Props) {
  const abortRef = useRef<AbortController | null>(null);

  // Démontage en plein glisser : sans ça, le curseur « ns-resize » reste posé
  // sur toute l'application.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      document.body.classList.remove("resizing-v");
    },
    [],
  );

  const begin = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      const abort = new AbortController();
      abortRef.current = abort;
      const options = { signal: abort.signal } as const;
      document.body.classList.add("resizing-v");
      window.addEventListener(
        "pointermove",
        // Tirer vers le haut agrandit le volet du bas.
        (move: PointerEvent) => onHeightChange(startHeight + (startY - move.clientY)),
        options,
      );
      const stop = () => {
        document.body.classList.remove("resizing-v");
        abort.abort();
      };
      window.addEventListener("pointerup", stop, options);
      window.addEventListener("pointercancel", stop, options);
    },
    [height, onHeightChange],
  );

  return (
    <div
      className="side-grip"
      onPointerDown={begin}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Répartir la hauteur entre les deux volets"
    />
  );
}
