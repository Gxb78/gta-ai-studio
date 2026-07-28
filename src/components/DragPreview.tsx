// Repère qui suit le pointeur pendant qu'un rush est tiré depuis le panneau
// Médias vers la timeline.
//
// Sans lui, le geste ne donnait aucun retour tant que le pointeur n'était pas
// au-dessus d'une piste : entre la carte qu'on vient de lâcher et la timeline,
// on ne voyait plus ce qu'on était en train de déplacer. Un vrai glisser-poser
// montre toujours ce qu'il transporte.
//
// Position posée directement en DOM depuis la boucle pointermove, jamais en
// état React : un `setState` par mouvement de souris coûterait un rendu
// complet de l'application à chaque image, pour un simple repère visuel qui
// suit le pointeur — la même règle que le reste de la timeline (voir
// Timeline.tsx).

import { useEffect, useRef } from "react";
import { mediaUrl } from "../ipc";
import { sourceName } from "./MediaPanel";
import type { SourceInfo } from "../types";
import { formatTime } from "../types";

interface Props {
  /** Rush en cours de dépôt, ou null hors d'un geste de glisser. */
  source: SourceInfo | null;
}

export function DragPreview({ source }: Props) {
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!source) return;
    const node = nodeRef.current;
    if (!node) return;
    // Écrit directement à chaque événement, sans `requestAnimationFrame` : un
    // rAF retarderait délibérément la position d'au plus une image (voir
    // Timeline.tsx pour la même correction sur le réticule) — inutile ici,
    // l'écriture ne touche qu'un `transform`, et le glissé CSS de la carte
    // (voir `.drag-preview` dans styles.css) lisse déjà le tracé.
    let lastX = NaN;
    let lastY = NaN;
    const paint = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      // Le nœud suit le pointeur EXACTEMENT : c'est le repère (voir CSS) qui
      // marque ce point précis, la carte elle-même est décalée par sa propre
      // marge, pour qu'on voie toujours à quoi elle est accrochée.
      if (pointerEvent.clientX === lastX && pointerEvent.clientY === lastY) return;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      node.style.transform = `translate(${lastX}px, ${lastY}px)`;
    };
    // `pointermove` reste branché comme garantie universelle ; `pointerrawupdate`
    // (Chromium/WebView2, donc cette appli Tauri) s'ajoute par-dessus pour
    // livrer chaque échantillon matériel plutôt que le rythme d'affichage.
    // `passive: true` : `paint` n'appelle jamais `preventDefault`, ce qui
    // autorise le moteur à traiter ces événements à haute fréquence sans
    // attendre, à chaque fois, la confirmation qu'ils ne seront pas annulés.
    const options = { passive: true } as const;
    window.addEventListener("pointermove", paint, options);
    if ("onpointerrawupdate" in window) window.addEventListener("pointerrawupdate", paint, options);
    return () => {
      window.removeEventListener("pointermove", paint);
      window.removeEventListener("pointerrawupdate", paint);
    };
  }, [source]);

  if (!source) return null;
  const thumb = source.thumbPaths[0];
  return (
    // Le décalage (position) et l'apparence (carte, animation d'entrée)
    // vivent sur deux nœuds distincts : le premier est réécrit à chaque image
    // par la boucle pointermove ci-dessus, le second porte une transition CSS
    // (légère bascule + zoom à la prise) qui ne doit jamais être interrompue
    // par ces écritures.
    <div className="drag-preview" ref={nodeRef} aria-hidden="true">
      <span className="drag-preview-dot" />
      <div className="drag-preview-card">
        {thumb ? (
          <img className="drag-preview-thumb" src={mediaUrl(thumb)} alt="" draggable={false} />
        ) : (
          <span className="drag-preview-thumb drag-preview-empty" />
        )}
        <span className="drag-preview-text">
          <span className="drag-preview-name">{sourceName(source)}</span>
          <span className="drag-preview-duration">{formatTime(source.probe.durationMs)}</span>
        </span>
      </div>
    </div>
  );
}
