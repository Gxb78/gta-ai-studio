// Position + fermeture partagées par tout menu contextuel posé en coordonnées
// FENÊTRE (ClipMenu, SplitMenu) : ancré au clic qui l'a ouvert, retourné plutôt
// que de sortir de l'écran, et fermé au clic extérieur, à Échap, au défilement
// ou au redimensionnement.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useFloatingMenu<T extends HTMLElement>(
  x: number,
  y: number,
  onClose: () => void,
) {
  const ref = useRef<T | null>(null);
  const [placement, setPlacement] = useState({ left: x, top: y });

  // En layout : la correction doit être appliquée AVANT la peinture, sinon le
  // menu s'affiche une image au mauvais endroit puis saute.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left = x + width + margin > window.innerWidth ? Math.max(margin, x - width) : x;
    const top = y + height + margin > window.innerHeight ? Math.max(margin, y - height) : y;
    setPlacement({ left, top });
  }, [x, y]);

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

  return { ref, placement };
}
