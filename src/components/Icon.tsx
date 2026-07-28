// Jeu d'icônes minimal, en SVG inline : aucune police externe, aucune requête,
// et la couleur suit `currentColor` pour rester cohérente avec les états.

interface Props {
  name: IconName;
  /** Taille en pixels (carré). */
  size?: number;
}

const PATHS = {
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  undo: (
    <>
      <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
      <path d="M8 4.5 3.5 9 8 13.5" />
    </>
  ),
  redo: (
    <>
      <path d="M20 9H9a5 5 0 0 0 0 10h6" />
      <path d="M16 4.5 20.5 9 16 13.5" />
    </>
  ),
  split: (
    <>
      <path d="M12 3v18" strokeDasharray="3 3" />
      <circle cx="6.5" cy="17.5" r="2.6" />
      <circle cx="17.5" cy="17.5" r="2.6" />
      <path d="M8.6 15.6 17 4.5M15.4 15.6 7 4.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 7V4.8h4V7M6.5 7l1 12.2h9L17.5 7" />
      <path d="M10.5 10.5v6M13.5 10.5v6" />
    </>
  ),
  magnet: (
    <>
      <path d="M6 4v8a6 6 0 0 0 12 0V4" />
      <path d="M6 10h4M14 10h4" />
    </>
  ),
  frame: (
    <>
      <rect x="8.5" y="3.5" width="7" height="17" rx="1.6" />
      <path d="M3.5 6.5v11M20.5 6.5v11" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8 10.5 12 14.5l4-4" />
      <path d="M4.5 16v3.5h15V16" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 6.5h6l2 2.5h9v10h-17z" />
      <path d="M12 12v5M9.5 14.5h5" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20.5 20.5" />
      <path d="M8 10.5h5M10.5 8v5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20.5 20.5" />
      <path d="M8 10.5h5" />
    </>
  ),
  fit: (
    <>
      <path d="M3.5 8V4.5H8M16 4.5h4.5V8M20.5 16v3.5H16M8 19.5H3.5V16" />
      <path d="M7.5 12h9" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9 13h6" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
      <path d="M18 6.7a7.5 7.5 0 0 1 0 10.6" />
    </>
  ),
  soundOff: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  eye: (
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12S18 17.5 12 17.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 5l16 14" />
      <path d="M9.2 7.1A9.4 9.4 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-3 3.6" />
      <path d="M6.3 8.6A16.6 16.6 0 0 0 2.5 12S6 17.5 12 17.5c1 0 1.9-.15 2.8-.4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.4M12 18.6V21M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2" />
    </>
  ),
  cursor: <path d="M6 3.5 18.5 13H12l-2.2 7.5z" />,
  blade: (
    <>
      <path d="M7 3.5v10.8l4.5 3V6.5z" />
      <path d="M11.5 17.3 20 20.5" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
    </>
  ),
  fullscreen: <path d="M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15" />,
  stepBack: (
    <>
      <path d="M17.5 5v14L7 12z" fill="currentColor" stroke="none" />
      <path d="M5.5 4.5v15" />
    </>
  ),
  stepForward: (
    <>
      <path d="M6.5 5v14L17 12z" fill="currentColor" stroke="none" />
      <path d="M18.5 4.5v15" />
    </>
  ),
  crop: (
    <>
      <path d="M6.5 3v14.5H21" />
      <path d="M3 6.5h14.5V21" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  text: (
    <>
      <path d="M4 5.5h16M12 5.5v13M8 18.5h8" />
      <path d="M4 9V5.5M20 9V5.5" />
    </>
  ),
  projects: (
    <>
      <rect x="3" y="5" width="18" height="14.5" rx="2" />
      <path d="M3 9.5h18M8.5 5v4.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 21 19.5H3z" />
      <path d="M12 9.5v4.5M12 16.6h.01" />
    </>
  ),
  saved: <path d="M5 12.5 10 17.5 19.5 7" />,
  safe: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M4 8h16M4 16h16" strokeDasharray="3 3" />
    </>
  ),
  /** Chevron vers le bas : replier/déplier une section. Une rotation CSS suffit
   *  pour l'état inverse, plutôt qu'une seconde icône à maintenir. */
  chevron: <path d="M6.5 9.5 12 15l5.5-5.5" />,
  /** Curseurs de réglage. Distinct de l'engrenage, qui désigne les paramètres
   *  de l'application : régler un clip et régler le logiciel sont deux choses. */
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.3" />
      <circle cx="9" cy="17" r="2.3" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5 20.5 8 12 12.5 3.5 8z" />
      <path d="M4.5 12 12 16l7.5-4M4.5 16 12 20l7.5-4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="3.5" y="3.5" width="12" height="12" rx="2" />
      <path d="M18.5 8.5h2v12h-12v-2" />
      <path d="M9.5 6.5v6M6.5 9.5h6" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="3.5" width="12" height="12" rx="2" />
      <path d="M15.5 18.5v2h-12v-12h2" />
    </>
  ),
  paste: (
    <>
      <path d="M9 4.5H6.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2H15" />
      <rect x="9" y="2.5" width="6" height="4" rx="1.2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </>
  ),
  rows: (
    <>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 17 }: Props) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
