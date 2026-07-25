import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "./api";
import type { AdvancedEditingClip, AudioWaveform, EditableOverlay, Project, TimelineRevisionRequest, PreviewRenderProfile, PreviewViewMode } from "./types";
import { InteractivePreview } from "./preview/InteractivePreview";
import { PreviewCoordinator } from "./preview/PreviewCoordinator";
import type { PreviewState } from "./preview/PreviewCoordinator";

const REFRAME_LABELS = {
  dynamic_crop: "Suivi dynamique",
  fixed_crop: "Crop stable",
  blur_background: "Cadre immersif",
  split_screen: "Avant / après",
} as const;

interface EditorSnapshot { clips: AdvancedEditingClip[]; overlays: EditableOverlay[] }
interface EditorHistory { past: EditorSnapshot[]; present: EditorSnapshot; future: EditorSnapshot[] }

function cloneSnapshot(value: EditorSnapshot): EditorSnapshot {
  return structuredClone(value);
}

function signature(value: EditorSnapshot): string {
  return JSON.stringify(value);
}

function normalizeClips(clips: AdvancedEditingClip[]): AdvancedEditingClip[] {
  return clips.map((clip, index) => ({ ...clip, index }));
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${(totalSeconds % 60).toFixed(2).padStart(5, "0")}`;
}

function clipStart(clips: AdvancedEditingClip[], index: number): number {
  return clips.slice(0, index).reduce((sum, clip) => sum + clip.duration_ms, 0);
}

function Waveform({ waveform }: { waveform: AudioWaveform | null }) {
  if (!waveform?.peaks.length) return <div className="waveform-empty">FORME D’ONDE EN COURS…</div>;
  const path = waveform.peaks.map((peak, index) => {
    const height = Math.max(1, peak * 34);
    return `M${index} ${22 - height / 2}V${22 + height / 2}`;
  }).join(" ");
  return <svg className="waveform-svg" viewBox={`0 0 ${waveform.peaks.length} 44`} preserveAspectRatio="none"><path d={path} /></svg>;
}

export function EditingStudio({ project, onProject }: { project: Project; onProject: (project: Project) => void }) {
  const edit = project.production.advanced_edit;
  const editor = project.production.timeline_editor;
  const videoRef = useRef<HTMLVideoElement>(null);
  const initial = useMemo<EditorSnapshot>(() => ({
    clips: structuredClone(edit?.clips ?? []),
    overlays: structuredClone(edit?.overlays ?? []),
  }), [edit?.id, editor?.edit_project_id]);
  const [history, setHistory] = useState<EditorHistory>({ past: [], present: initial, future: [] });
  const [savedSignature, setSavedSignature] = useState(signature(initial));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveform, setWaveform] = useState<AudioWaveform | null>(null);
  const [zoom, setZoom] = useState(1);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Boucle A : État transitoire pour interactions immédiates
  const [transientClip, setTransientClip] = useState<AdvancedEditingClip | null>(null);
  const [transientClipIndex, setTransientClipIndex] = useState<number | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>({
    status: "interactive",
    clientRequestId: null,
    jobRunId: null,
    cacheKey: null,
    cacheHit: false,
    artifactUrl: null,
    error: null,
    lastInteractionMs: 0,
    generation: 0,
  });
  const [viewMode, setViewMode] = useState<PreviewViewMode>("cropped");
  const [renderProfile, setRenderProfile] = useState<PreviewRenderProfile>("draft");
  const coordinatorRef = useRef<PreviewCoordinator | null>(null);

  const clips = history.present.clips;
  const overlays = history.present.overlays;
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration_ms, 0) || 1;
  const dirty = signature(history.present) !== savedSignature;

  // Utiliser transientClip si disponible, sinon le clip commité
  const selected = (transientClipIndex === selectedIndex && transientClip)
    ? transientClip
    : clips[selectedIndex] ?? null;

  const selectedStart = clipStart(clips, selectedIndex);
  const localPosition = Math.max(0, positionMs - selectedStart);
  const selectedProgress = selected ? Math.min(1, localPosition / Math.max(1, selected.duration_ms)) : 0;
  const focusX = selected ? selected.focus_start_x + (selected.focus_end_x - selected.focus_start_x) * selectedProgress : 0.5;
  const focusY = selected?.focus_y ?? 0.5;
  const preview = editor?.previews.find((item) => item.clip_index === selectedIndex);

  // Source proxy pour Niveau A (toujours proxy/original, jamais le rendu final)
  const sourceProxyUrl = project.proxy ? `${api.proxyUrl(project.id)}?v=${project.proxy.sha256}` : null;

  // Rendu final pour comparaison/lecture
  const finalRenderUrl = project.production.render_url
    ? `${api.renderUrl(project.id)}?v=${project.production.render?.artifact_id ?? "final"}`
    : null;

  // Ref pour suivre le clip sélectionné dans le callback subscribe
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected?.id]);

  useEffect(() => {
    const coordinator = new PreviewCoordinator();
    coordinatorRef.current = coordinator;
    const unsubscribe = coordinator.subscribe((clipId, state) => {
      // Utiliser selectedIdRef pour avoir toujours la valeur à jour
      if (clipId === selectedIdRef.current) {
        setPreviewState(state);
      }
    });
    return () => {
      coordinator.clearAll();
      unsubscribe();
      coordinatorRef.current = null;
    };
  }, []);

  // Mettre à jour l'état preview quand le clip sélectionné change
  useEffect(() => {
    if (selected && coordinatorRef.current) {
      const state = coordinatorRef.current.getState(selected.id);
      setPreviewState(state);
    }
  }, [selected?.id]);

  useEffect(() => {
    const next = cloneSnapshot(initial);
    setHistory({ past: [], present: next, future: [] });
    setSavedSignature(signature(next));
    setSelectedIndex((value) => Math.min(value, Math.max(0, next.clips.length - 1)));
    setNote("");
  }, [initial]);

  useEffect(() => {
    if (!edit) return;
    let disposed = false;
    void api.waveform(project.id, project.production.voice ? "voice" : "source")
      .then((value) => !disposed && setWaveform(value)).catch(() => !disposed && setWaveform(null));
    return () => { disposed = true; };
  }, [edit, project.id, project.production.voice]);

  useEffect(() => { if (positionMs > totalDuration) setPositionMs(totalDuration); }, [positionMs, totalDuration]);

  const commit = useCallback((update: (snapshot: EditorSnapshot) => EditorSnapshot) => {
    setHistory((current) => ({
      past: [...current.past.slice(-79), cloneSnapshot(current.present)],
      present: update(cloneSnapshot(current.present)),
      future: [],
    }));
  }, []);

  const undo = useCallback(() => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    return { past: current.past.slice(0, -1), present: cloneSnapshot(previous), future: [cloneSnapshot(current.present), ...current.future] };
  }), []);
  const redo = useCallback(() => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    return { past: [...current.past, cloneSnapshot(current.present)], present: cloneSnapshot(next), future: current.future.slice(1) };
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      if (event.code === "Space") { event.preventDefault(); void togglePlayback(); }
      if (event.code === "ArrowLeft") seek(positionMs - (event.shiftKey ? 5000 : 1000));
      if (event.code === "ArrowRight") seek(positionMs + (event.shiftKey ? 5000 : 1000));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!edit || !editor) return null;

  function seek(nextMs: number) {
    const bounded = Math.max(0, Math.min(totalDuration, nextMs));
    setPositionMs(bounded);
    if (videoRef.current) videoRef.current.currentTime = bounded / 1000;
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play(); else video.pause();
  }

  function updateClip(index: number, values: Partial<AdvancedEditingClip>) {
    commit((snapshot) => ({ ...snapshot, clips: normalizeClips(snapshot.clips.map((clip, clipIndex) => clipIndex === index ? { ...clip, ...values } : clip)) }));

    // Déclencher automatiquement la preview après modification (Boucle B)
    const clip = clips[index];
    if (clip && coordinatorRef.current && edit && editor) {
      const updatedClip = { ...clip, ...values };
      coordinatorRef.current.requestPreview(
        project.id,
        editor.edit_project_id,
        updatedClip,
        editor.revision,
        'draft',
        null,
      );
    }
  }

  function updateClipTransient(index: number, values: Partial<AdvancedEditingClip>) {
    // Boucle A : mise à jour transitoire sans commit
    const baseClip = clips[index];
    if (!baseClip) return;
    const updated = { ...baseClip, ...values };
    setTransientClip(updated);
    setTransientClipIndex(index);
  }

  function commitTransientClip() {
    // Fin de Boucle A : commit de l'état transitoire
    if (transientClip !== null && transientClipIndex !== null) {
      const baseClip = clips[transientClipIndex];
      if (!baseClip) {
        setTransientClip(null);
        setTransientClipIndex(null);
        return;
      }

      // Créer un objet avec les différences
      const changes: Partial<AdvancedEditingClip> = {};
      let hasChanges = false;

      // Comparer et copier les différences
      if (transientClip.focus_start_x !== baseClip.focus_start_x) {
        changes.focus_start_x = transientClip.focus_start_x;
        hasChanges = true;
      }
      if (transientClip.focus_end_x !== baseClip.focus_end_x) {
        changes.focus_end_x = transientClip.focus_end_x;
        hasChanges = true;
      }
      if (transientClip.focus_y !== baseClip.focus_y) {
        changes.focus_y = transientClip.focus_y;
        hasChanges = true;
      }
      if (transientClip.duration_ms !== baseClip.duration_ms) {
        changes.duration_ms = transientClip.duration_ms;
        hasChanges = true;
      }
      if (transientClip.speed !== baseClip.speed) {
        changes.speed = transientClip.speed;
        hasChanges = true;
      }
      if (transientClip.tracking_method !== baseClip.tracking_method) {
        changes.tracking_method = transientClip.tracking_method;
        hasChanges = true;
      }

      if (hasChanges) {
        commit((snapshot) => ({
          ...snapshot,
          clips: normalizeClips(snapshot.clips.map((clip, clipIndex) =>
            clipIndex === transientClipIndex ? { ...clip, ...changes } : clip
          ))
        }));

        // Déclencher preview après commit (Boucle B avec debounce)
        if (coordinatorRef.current && edit && editor) {
          coordinatorRef.current.requestPreview(
            project.id,
            editor.edit_project_id,
            transientClip,
            editor.revision,
            'draft',
            null,
          );
        }
      }

      setTransientClip(null);
      setTransientClipIndex(null);
    }
  }

  function moveClip(from: number, to: number) {
    if (from === to || to < 0 || to >= clips.length) return;
    commit((snapshot) => {
      const next = [...snapshot.clips];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return { ...snapshot, clips: normalizeClips(next) };
    });
    setSelectedIndex(to);
  }

  function duplicateClip() {
    if (!selected) return;
    commit((snapshot) => {
      const next = [...snapshot.clips];
      next.splice(selectedIndex + 1, 0, structuredClone(selected));
      return { ...snapshot, clips: normalizeClips(next) };
    });
    setSelectedIndex(selectedIndex + 1);
  }

  function deleteClip() {
    if (clips.length <= 1) return;
    commit((snapshot) => ({ ...snapshot, clips: normalizeClips(snapshot.clips.filter((_, index) => index !== selectedIndex)) }));
    setSelectedIndex(Math.max(0, Math.min(selectedIndex, clips.length - 2)));
  }

  function splitClip() {
    if (!selected) return;
    const outputOffset = Math.max(250, Math.min(selected.duration_ms - 250, positionMs - selectedStart));
    if (selected.duration_ms < 500 || outputOffset <= 0 || outputOffset >= selected.duration_ms) return;
    const ratio = outputOffset / selected.duration_ms;
    const sourceSplit = Math.round(selected.start_ms + selected.source_duration_ms * ratio);
    const firstDuration = Math.round(outputOffset);
    const secondDuration = selected.duration_ms - firstDuration;
    const firstSourceDuration = sourceSplit - selected.start_ms;
    const secondSourceDuration = selected.end_ms - sourceSplit;
    const first = { ...selected, end_ms: sourceSplit, source_duration_ms: firstSourceDuration, duration_ms: firstDuration, speed: Math.max(0.5, Math.min(2, firstSourceDuration / firstDuration)) };
    const second = { ...selected, start_ms: sourceSplit, source_duration_ms: secondSourceDuration, duration_ms: secondDuration, speed: Math.max(0.5, Math.min(2, secondSourceDuration / secondDuration)) };
    commit((snapshot) => ({ ...snapshot, clips: normalizeClips([...snapshot.clips.slice(0, selectedIndex), first, second, ...snapshot.clips.slice(selectedIndex + 1)]) }));
    setSelectedIndex(selectedIndex + 1);
  }

  function startResize(event: React.PointerEvent<HTMLSpanElement>, index: number) {
    event.preventDefault(); event.stopPropagation();
    const originX = event.clientX;
    const originClip = clips[index];
    if (!originClip) return;
    const originDuration = originClip.duration_ms;
    const pixelsPerSecond = 55 * zoom;

    const onMove = (moveEvent: PointerEvent) => {
      // Boucle A : mise à jour transitoire pendant le drag
      const duration = Math.max(250, Math.round((originDuration + (moveEvent.clientX - originX) / pixelsPerSecond * 1000) / 50) * 50);
      const speed = Math.max(0.5, Math.min(2, originClip.source_duration_ms / duration));
      updateClipTransient(index, { duration_ms: duration, speed });
    };

    const onUp = () => {
      // Fin de Boucle A : commit l'état transitoire
      commitTransientClip();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function updateOverlay(index: number, values: Partial<EditableOverlay>) {
    commit((snapshot) => ({ ...snapshot, overlays: snapshot.overlays.map((cue, cueIndex) => cueIndex === index ? { ...cue, ...values } : cue) }));
  }

  async function saveRevision(): Promise<Project | null> {
    if (!dirty) return project;
    setSaving(true); setError(null);
    const payload: TimelineRevisionRequest = {
      base_edit_project_id: editor!.edit_project_id,
      expected_revision: editor!.revision,
      clips,
      overlays,
      note: note.trim(),
    };
    try {
      const next = await api.saveTimelineRevision(project.id, payload);
      setSavedSignature(signature(history.present));
      // Marquer tous les clips comme stale après sauvegarde de révision
      if (coordinatorRef.current) {
        coordinatorRef.current.markAllStale();
      }
      onProject(next);
      return next;
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code} — ${caught.message}` : "La révision n’a pas pu être sauvegardée.");
      return null;
    } finally { setSaving(false); }
  }

  async function regenerateSelected() {
    // DEPRECATED: Cette fonction utilisait l’ancienne API de preview
    // Le nouveau systeme utilise PreviewCoordinator avec requestPreview()
    // TODO: Supprimer cette fonction apres migration complete
    console.warn("regenerateSelected is deprecated, use PreviewCoordinator.requestPreview instead");
  }

  return (
    <section className="editing-studio timeline-editor">
      <div className="editing-heading">
        <div><span>ÉDITEUR NON DESTRUCTIF · RÉVISION {editor.revision}</span><h3>Le montage reste modifiable jusqu’au dernier plan.</h3><p>Chaque sauvegarde crée une révision autonome ; la source et les rendus précédents restent intacts.</p></div>
        <div className={`edit-status ${dirty ? "dirty" : "ready"}`}><strong>{dirty ? "MODIFICATIONS LOCALES" : "RÉVISION SAUVEGARDÉE"}</strong><small>{history.past.length} action(s) annulable(s) · {clips.length} plans</small></div>
      </div>

      <div className="editor-commandbar">
        <button disabled={!history.past.length} onClick={undo}>↶ Annuler</button><button disabled={!history.future.length} onClick={redo}>↷ Rétablir</button>
        <i /><button onClick={() => moveClip(selectedIndex, selectedIndex - 1)} disabled={selectedIndex === 0}>← Déplacer</button><button onClick={() => moveClip(selectedIndex, selectedIndex + 1)} disabled={selectedIndex >= clips.length - 1}>Déplacer →</button>
        <button onClick={splitClip}>✂ Découper</button><button onClick={duplicateClip}>⧉ Dupliquer</button><button className="danger" onClick={deleteClip} disabled={clips.length <= 1}>Supprimer</button>
        <label>NOTE <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Raison de cette révision" /></label>
        <button className="save-revision" disabled={!dirty || saving} onClick={() => void saveRevision()}>{saving ? "SAUVEGARDE…" : `SAUVEGARDER R${editor.revision + 1}`}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="studio-workbench">
        <div className="studio-preview">
          <div className="preview-toolbar">
            <label>Vue</label>
            <select value={viewMode} onChange={(e) => setViewMode(e.target.value as PreviewViewMode)}>
              <option value="cropped">Cadré</option>
              <option value="before_after">Avant / Après</option>
            </select>
            <label>Qualité</label>
            <select value={renderProfile} onChange={(e) => setRenderProfile(e.target.value as PreviewRenderProfile)}>
              <option value="draft">Brouillon (Rapide)</option>
              <option value="fidelity">Fidélité (Lent)</option>
            </select>
            <button
              onClick={() => {
                if (selected && coordinatorRef.current && edit) {
                  coordinatorRef.current.requestPreview(
                    project.id,
                    editor.edit_project_id,
                    selected,
                    editor.revision,
                    renderProfile,
                    null, // preview_window
                  );
                }
              }}
              disabled={previewState.status === "rendering" || previewState.status === "queued"}
              className="preview-render-button"
            >
              {previewState.status === "rendering" ? "RENDU EN COURS..." :
               previewState.status === "queued" ? "EN ATTENTE..." :
               "RENDRE L'APERÇU"}
            </button>
          </div>
          {sourceProxyUrl && selected ? (
            <InteractivePreview
              clip={selected}
              sourceVideoUrl={sourceProxyUrl}
              sourceWidth={project.media[0]?.width || 1920}
              sourceHeight={project.media[0]?.height || 1080}
              outputWidth={1080}
              outputHeight={1920}
              status={previewState.status}
              artifactUrl={previewState.artifactUrl}
              cacheHit={previewState.cacheHit}
              mode={viewMode}
              playheadMs={localPosition}
              onTimeUpdate={(ms) => seek(selectedStart + ms)}
            />
          ) : (
            <div className="studio-preview-empty">Vidéo en attente</div>
          )}
          <div className="preview-timecode">{formatTime(positionMs)}</div>
        </div>
        <aside className="clip-inspector">
          <div className="inspector-heading"><span>PLAN {selectedIndex + 1}</span><strong>{selected ? REFRAME_LABELS[selected.reframe_mode] : "—"}</strong></div>
          {selected && <>
            <label>Mode<select value={selected.reframe_mode} onChange={(event) => updateClip(selectedIndex, { reframe_mode: event.target.value as AdvancedEditingClip["reframe_mode"] })}><option value="dynamic_crop">Suivi dynamique</option><option value="fixed_crop">Crop stable</option><option value="blur_background">Cadre immersif</option><option value="split_screen">Avant / après</option></select></label>
            <div className="inspector-grid"><label>Entrée source<input type="number" min="0" step="100" value={selected.start_ms} onChange={(event) => { const start = Number(event.target.value); const source = selected.end_ms - start; updateClip(selectedIndex, { start_ms: start, source_duration_ms: source, speed: Math.max(0.5, Math.min(2, source / selected.duration_ms)) }); }} /></label><label>Sortie source<input type="number" min={selected.start_ms + 1} step="100" value={selected.end_ms} onChange={(event) => { const end = Number(event.target.value); const source = end - selected.start_ms; updateClip(selectedIndex, { end_ms: end, source_duration_ms: source, speed: Math.max(0.5, Math.min(2, source / selected.duration_ms)) }); }} /></label><label>Durée montage<input type="number" min="250" step="50" value={selected.duration_ms} onChange={(event) => { const duration = Number(event.target.value); updateClip(selectedIndex, { duration_ms: duration, speed: Math.max(0.5, Math.min(2, selected.source_duration_ms / duration)) }); }} /></label><label>Zoom<input type="number" min="1" max="1.2" step="0.01" value={selected.zoom} onChange={(event) => updateClip(selectedIndex, { zoom: Number(event.target.value), zoom_reason: "manual" })} /></label></div>
            <label>Focus début <b>{Math.round(selected.focus_start_x * 100)}%</b><input type="range" min="0" max="1" step="0.01" value={selected.focus_start_x} onInput={(event) => updateClipTransient(selectedIndex, { focus_start_x: Number(event.currentTarget.value), tracking_method: "manual_keyframe" })} onChange={() => commitTransientClip()} /></label>
            <label>Focus fin <b>{Math.round(selected.focus_end_x * 100)}%</b><input type="range" min="0" max="1" step="0.01" value={selected.focus_end_x} onInput={(event) => updateClipTransient(selectedIndex, { focus_end_x: Number(event.currentTarget.value), tracking_method: "manual_keyframe" })} onChange={() => commitTransientClip()} /></label>
            <label>Hauteur <b>{Math.round(selected.focus_y * 100)}%</b><input type="range" min="0" max="1" step="0.01" value={selected.focus_y} onInput={(event) => updateClipTransient(selectedIndex, { focus_y: Number(event.currentTarget.value), tracking_method: "manual_keyframe" })} onChange={() => commitTransientClip()} /></label>
            <button className="regenerate-clip" disabled={previewing} onClick={() => void regenerateSelected()}>{previewing ? "PRÉPARATION…" : "↻ RÉGÉNÉRER UNIQUEMENT CE PLAN"}</button>
            {preview && <video className="clip-preview-player" controls src={`${api.clipPreviewUrl(project.id, editor.edit_project_id, selectedIndex)}?v=${preview.sha256}`} />}
          </>}
        </aside>
      </div>

      <div className="edit-timeline-card">
        <div className="timeline-toolbar"><button onClick={() => void togglePlayback()}>{playing ? "Ⅱ" : "▶"}</button><strong>{formatTime(positionMs)}</strong><span>/ {formatTime(totalDuration)}</span><label>ZOOM <input type="range" min="1" max="4" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label></div>
        <div className="timeline-scroll"><div className="timeline-stage" style={{ width: `${zoom * 100}%` }}>
          <div className="playhead" style={{ left: `calc(38px + (100% - 38px) * ${positionMs / totalDuration})` }}><i /></div>
          <button className="waveform-track" onClick={(event) => seek(event.nativeEvent.offsetX / event.currentTarget.clientWidth * totalDuration)}><span>VOIX</span><Waveform waveform={waveform} /></button>
          <div className="edit-rail">{clips.map((clip, index) => {
            const hasPreview = editor?.previews.find(p => p.clip_index === index);
            return <button key={`${index}-${clip.start_ms}`} draggable onDragStart={(event) => event.dataTransfer.setData("text/clip-index", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveClip(Number(event.dataTransfer.getData("text/clip-index")), index)} className={`edit-clip ${clip.reframe_mode} ${selectedIndex === index ? "active" : ""}`} style={{ width: `${clip.duration_ms / totalDuration * 100}%` }} onClick={() => { setSelectedIndex(index); seek(clipStart(clips, index)); }}><span>{index + 1} {hasPreview && <span className="preview-badge preview-badge--ready" title="Aperçu rendu disponible">●</span>}</span><small>{REFRAME_LABELS[clip.reframe_mode]}</small><i className="resize-handle" onPointerDown={(event) => startResize(event, index)} /></button>;
          })}</div>
          <div className="overlay-track"><span>FX</span>{overlays.map((cue, index) => <button key={cue.id} className={cue.enabled === false ? "disabled" : ""} style={{ left: `${cue.start_ms / totalDuration * 100}%`, width: `${(cue.end_ms - cue.start_ms) / totalDuration * 100}%` }} onClick={() => seek(cue.start_ms)}>{cue.cue_type}</button>)}</div>
          <input className="scrubber" type="range" min="0" max={totalDuration} step="10" value={Math.min(positionMs, totalDuration)} onChange={(event) => seek(Number(event.target.value))} />
        </div></div>
      </div>

      <div className="overlay-editor">
        <div className="edit-card-title"><span>TEXTES & OVERLAYS</span><small>Une modification manuelle retire la provenance factuelle précédente</small></div>
        {overlays.map((cue, index) => <div className={`overlay-edit-row ${cue.enabled === false ? "disabled" : ""}`} key={cue.id}><button onClick={() => updateOverlay(index, { enabled: cue.enabled === false })}>{cue.enabled === false ? "○" : "●"}</button><b>{cue.cue_type.replaceAll("_", " ")}</b><input value={cue.text} onChange={(event) => updateOverlay(index, { text: event.target.value, manual_override: true, supporting_claim_ids: [] })} /><input type="number" value={cue.start_ms} min="0" step="100" onChange={(event) => updateOverlay(index, { start_ms: Number(event.target.value) })} /><span>→</span><input type="number" value={cue.end_ms} min={cue.start_ms + 1} max={totalDuration} step="100" onChange={(event) => updateOverlay(index, { end_ms: Number(event.target.value) })} /><small>{cue.manual_override ? "MANUEL · NON VÉRIFIÉ" : cue.supporting_claim_ids.length ? "PREUVE LIÉE" : "DÉCORATIF"}</small></div>)}
      </div>
    </section>
  );
}
