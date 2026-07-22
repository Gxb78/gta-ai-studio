/**
 * InteractivePreview - Composant de prévisualisation avec Niveau A (CSS)
 *
 * Responsabilités :
 * - Afficher preview interactive avec transforms CSS (<16.7ms)
 * - Appliquer crop, zoom, focus dynamiquement
 * - Gérer le scrubbing timeline (preview window)
 * - Afficher badges d'état (debouncing, rendering, cache hit, etc.)
 * - Mode cropped vs before/after
 * - Fallback vers draft/fidelity quand CSS ne suffit pas
 */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { AdvancedEditingClip, PreviewStatus } from '../types';
import { computePreviewTransform } from '../reframe';

export interface InteractivePreviewProps {
  clip: AdvancedEditingClip;
  sourceVideoUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  status: PreviewStatus;
  artifactUrl: string | null;
  cacheHit?: boolean;
  mode: 'cropped' | 'before_after';
  playheadMs?: number;
  onTimeUpdate?: (timeMs: number) => void;
  className?: string;
}

export const InteractivePreview: React.FC<InteractivePreviewProps> = ({
  clip,
  sourceVideoUrl,
  sourceWidth,
  sourceHeight,
  outputWidth,
  outputHeight,
  status,
  artifactUrl,
  cacheHit = false,
  mode,
  playheadMs,
  onTimeUpdate,
  className = '',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

  // Calculer le transform CSS pour Niveau A
  const cssTransform = useMemo(() => {
    if (mode === 'before_after' || status !== 'interactive') {
      return null;
    }

    // Calculer le focusX interpolé en fonction du playhead
    const progress = playheadMs !== undefined ? Math.min(1, playheadMs / clip.duration_ms) : 0;
    const focusX = clip.focus_start_x + (clip.focus_end_x - clip.focus_start_x) * progress;

    return computePreviewTransform(
      sourceWidth,
      sourceHeight,
      outputWidth,
      outputHeight,
      focusX,
      clip.focus_y,
      clip.zoom,
    );
  }, [clip, sourceWidth, sourceHeight, outputWidth, outputHeight, mode, status, playheadMs]);

  // Synchroniser playhead externe avec video
  useEffect(() => {
    if (videoRef.current && playheadMs !== undefined) {
      const targetSec = playheadMs / 1000;
      if (Math.abs(videoRef.current.currentTime - targetSec) > 0.1) {
        videoRef.current.currentTime = targetSec;
      }
    }
  }, [playheadMs]);

  // Mettre à jour currentTime
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const timeMs = Math.floor(videoRef.current.currentTime * 1000);
      setCurrentTimeMs(timeMs);
      onTimeUpdate?.(timeMs);
    }
  };

  // Toggle play/pause
  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  // Rendu du badge d'état
  const renderStatusBadge = () => {
    const badges: Record<PreviewStatus, { label: string; color: string }> = {
      interactive: { label: 'Interactive', color: 'bg-blue-500' },
      dirty: { label: 'Dirty', color: 'bg-yellow-500' },
      debouncing: { label: 'Debouncing...', color: 'bg-yellow-600' },
      queued: { label: 'Queued', color: 'bg-orange-500' },
      rendering: { label: 'Rendering...', color: 'bg-orange-600' },
      ready: { label: cacheHit ? 'Cache Hit' : 'Ready', color: cacheHit ? 'bg-green-600' : 'bg-green-500' },
      stale: { label: 'Stale', color: 'bg-gray-500' },
      failed: { label: 'Failed', color: 'bg-red-500' },
    };

    const badge = badges[status];
    return (
      <div className={`absolute top-2 right-2 px-2 py-1 rounded text-xs text-white ${badge.color} z-10`}>
        {badge.label}
      </div>
    );
  };

  // Déterminer quelle source vidéo afficher
  const activeVideoUrl = useMemo(() => {
    // Si on a un artifact ready/stale et qu'on n'est pas en mode interactive, utiliser l'artifact
    if (artifactUrl && (status === 'ready' || status === 'stale')) {
      return artifactUrl;
    }
    // Sinon, utiliser la source pour Niveau A
    return sourceVideoUrl;
  }, [artifactUrl, status, sourceVideoUrl]);

  const isInteractiveMode = status === 'interactive' && cssTransform && mode === 'cropped';

  return (
    <div ref={containerRef} className={`relative bg-black ${className}`} style={{ aspectRatio: `${outputWidth}/${outputHeight}` }}>
      {renderStatusBadge()}

      <div className="relative w-full h-full overflow-hidden">
        {mode === 'cropped' && isInteractiveMode ? (
          // Niveau A: CSS transform pour preview interactive
          <video
            ref={videoRef}
            src={activeVideoUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'none',
              transformOrigin: cssTransform.transformOrigin,
              transform: cssTransform.transform,
            }}
            onTimeUpdate={handleTimeUpdate}
            onClick={togglePlay}
          />
        ) : mode === 'before_after' ? (
          // Mode before/after: split screen
          <div className="flex w-full h-full">
            <div className="flex-1 relative overflow-hidden border-r-2 border-white">
              <video
                src={sourceVideoUrl}
                className="w-full h-full object-cover"
                onTimeUpdate={handleTimeUpdate}
              />
              <div className="absolute bottom-2 left-2 px-2 py-1 bg-black bg-opacity-60 text-white text-xs rounded">
                Before
              </div>
            </div>
            <div className="flex-1 relative overflow-hidden">
              <video
                ref={videoRef}
                src={activeVideoUrl}
                className="w-full h-full object-cover"
                onClick={togglePlay}
              />
              <div className="absolute bottom-2 right-2 px-2 py-1 bg-black bg-opacity-60 text-white text-xs rounded">
                After
              </div>
            </div>
          </div>
        ) : (
          // Artifact encodé (draft/fidelity)
          <video
            ref={videoRef}
            src={activeVideoUrl}
            className="w-full h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onClick={togglePlay}
          />
        )}
      </div>

      {/* Contrôles simples */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black to-transparent p-2">
        <div className="flex items-center gap-2 text-white text-sm">
          <button
            onClick={togglePlay}
            className="px-3 py-1 bg-white bg-opacity-20 rounded hover:bg-opacity-30 transition"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <div className="flex-1 text-center">
            {Math.floor(currentTimeMs / 1000)}s / {Math.floor(clip.duration_ms / 1000)}s
          </div>
          <div className="text-xs opacity-70">
            {clip.speed !== 1 ? `${clip.speed}x` : ''}
            {clip.zoom !== 1 ? ` zoom ${clip.zoom.toFixed(1)}x` : ''}
          </div>
        </div>
      </div>
    </div>
  );
};
