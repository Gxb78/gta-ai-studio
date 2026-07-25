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
  close: <path d="M6 6l12 12M18 6 6 18" />,
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
