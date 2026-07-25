// Aperçu vidéo : DEUX balises superposées, une seule visible à la fois.
// Celle qui est masquée précharge et pré-positionne le clip suivant, ce qui
// rend la jonction instantanée même entre deux rushs différents.
// Le guide 9:16 montre la zone conservée par l'export « recadrage centré ».

interface Props {
  videoA: React.RefObject<HTMLVideoElement | null>;
  videoB: React.RefObject<HTMLVideoElement | null>;
  /** Balises sonores : le son est découplé de l'image (voir usePlayback). */
  audioA: React.RefObject<HTMLAudioElement | null>;
  audioB: React.RefObject<HTMLAudioElement | null>;
  /** Balise actuellement visible. */
  activeIsA: boolean;
  showGuide: boolean;
  /** Playhead dans un trou de la timeline : on masque l'image, comme à l'export. */
  inGap: boolean;
  onTogglePlay: () => void;
}

export function PreviewPlayer({
  videoA,
  videoB,
  audioA,
  audioB,
  activeIsA,
  showGuide,
  inGap,
  onTogglePlay,
}: Props) {
  return (
    <div className="preview-area">
      <div
        className="preview-frame"
        onClick={onTogglePlay}
        role="button"
        tabIndex={-1}
        title="Cliquer pour lire ou mettre en pause"
      >
        {/* Les balises vidéo sont MUETTES : tout le son passe par les balises
            audio, seules à connaître le plan sonore. */}
        <video
          ref={videoA}
          className={"preview-video" + (activeIsA ? " visible" : "")}
          preload="auto"
          playsInline
          muted
        />
        <video
          ref={videoB}
          className={"preview-video" + (activeIsA ? "" : " visible")}
          preload="auto"
          playsInline
          muted
        />
        <audio ref={audioA} preload="auto" />
        <audio ref={audioB} preload="auto" />
        {inGap && (
          <div className="preview-gap">
            <span>Trou — écran noir</span>
          </div>
        )}
        {showGuide && (
          <div className="guide-916" title="Zone conservée par l'export recadré 9:16">
            <span>9:16</span>
          </div>
        )}
      </div>
    </div>
  );
}
