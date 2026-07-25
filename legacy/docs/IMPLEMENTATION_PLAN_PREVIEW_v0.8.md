# Plan d'implémentation incrémentale — Moteur de Prévisualisation v0.8.0

## État actuel (2026-07-22)

### ✅ Déjà implémenté
- **Migration SQL 0010** : Tables `preview_cache_entries` et `project_preview_cache_refs` avec trigger
- **Contrat canonique Python** : `reframe.py` avec `compute_crop_rect`
- **Contrat canonique TypeScript** : `reframe.ts` avec parité Python
- **Modèles API** : `ClipPreviewRequest`, `PreviewResponse`, `PreviewWindowRequest`
- **Structure base** : Repository, service, main.py, models.py

### 🔄 À implémenter (par ordre de priorité)

## Phase 0.8.1 : Vérification des fondations (GATE 1)
**Objectif** : Valider que les contrats existants sont corrects avant tout nouveau code.

### Tâches :
1. Tester la migration `0010_preview_cache.sql` sur une DB vierge
2. Vérifier que `compute_crop_rect` Python et TypeScript produisent les mêmes résultats
3. Valider les modèles API existants
4. Vérifier que `clip_id`, `clip_revision` et `timeline_revision` existent dans `EditableClip`

### Critères d'acceptation :
- Migration appliquée sans erreur
- Tables créées avec trigger fonctionnel
- Python et TypeScript retournent le même crop rect (à 0.001 près) pour :
  - Source 1920×1080 → Output 540×960
  - Focus (0.5, 0.5), zoom 1.0 et 1.2
  - Focus (0.0, 0.5) et (1.0, 0.5) (bords)
- Modèles API validés par Pydantic

**Règle d'arrêt** : Produire un rapport de validation, puis passer à Phase 0.8.2

---

## Phase 0.8.2 : Vertical slice complet minimal (GATE 2)
**Objectif** : Valider le parcours complet d'une preview encodée, de bout en bout, visible dans l'application.

### Flux complet :
```text
Bouton frontend "Générer preview"
    ↓
POST /api/v1/projects/{id}/timeline/preview
    ↓
start_clip_preview crée PreviewRenderSpec immuable
    ↓
Job persistant enfilé
    ↓
Worker _render_clip_preview
    ↓
build_clip_preview_command (FFmpeg)
    ↓
Fichier temporaire .partial.mp4
    ↓
Validation FFprobe (durée, résolution, codec)
    ↓
Renommage atomique → .mp4
    ↓
Artefact enregistré
    ↓
Frontend récupère statut + artifact_url
    ↓
Lecture dans <video> de l'application
```

### Périmètre INCLUS :
- ✅ Un seul clip à la fois
- ✅ Profil `draft` uniquement (540×960, 30fps, ultrafast, CRF 28)
- ✅ Fenêtre de 3 secondes autour du playhead
- ✅ Crop via `compute_crop_rect`
- ✅ Scale vers 540×960
- ✅ Vitesse (speed 0.5x à 2.0x avec `setpts` + `atempo`)
- ✅ Audio simple (codec aac, bitrate 96k)
- ✅ Validation FFprobe obligatoire
- ✅ Écriture atomique (temporaire → rename)
- ✅ Gestion d'erreur FFmpeg
- ✅ Bouton frontend minimal
- ✅ Lecteur <video> de la preview

### Périmètre EXCLU (phases suivantes) :
- ❌ Cache
- ❌ Déduplication
- ❌ Préchargement
- ❌ Profil `fidelity`
- ❌ Mode avant/après
- ❌ Transformations CSS interactives
- ❌ Fades vidéo/audio
- ❌ Comparaison avec paramètres originaux
- ❌ Badges d'état avancés
- ❌ LRU

### Fichiers à créer/modifier :

#### 1. `models.py` — Ajouter `PreviewRenderSpec`
```python
class PreviewRenderSpec(ApiModel):
    """Snapshot immuable des paramètres de rendu."""
    client_request_id: str
    project_id: str
    edit_project_id: str
    
    # Identité
    clip_id: str
    clip_revision: int
    timeline_revision: int
    
    # Source
    source_path: str
    source_sha256: str
    source_start_ms: int
    source_end_ms: int
    source_width: int
    source_height: int
    
    # Fenêtre de preview (temps de sortie)
    preview_start_ms: int
    preview_duration_ms: int
    
    # Transformation
    crop_x: float
    crop_y: float
    crop_width: float
    crop_height: float
    focus_x: float
    focus_y: float
    zoom: float
    speed: float
    
    # Output
    output_width: int
    output_height: int
    output_fps: int
    codec: str
    preset: str
    crf: int
    pixel_format: str
    audio_codec: str
    audio_bitrate: str
```

**Justification** : Le worker ne doit JAMAIS relire la timeline au moment de l'exécution. Le job contient un snapshot complet et immuable.

#### 2. `service.py` — Méthode `start_clip_preview`
```python
def start_clip_preview(
    self, project_id: str, request: ClipPreviewRequest
) -> PreviewResponse:
    """Démarre une preview en créant un job avec snapshot immuable."""
    
    # 1. Charger le projet
    project = self.repository.get_project(project_id)
    production = dict(project["production"])
    edit = production.get("edit")
    advanced_edit = production.get("advanced_edit")
    
    if not edit or not advanced_edit:
        raise StudioError("PROJECT_NOT_IN_ADVANCED_EDITING", ...)
    
    # 2. Valider révision timeline
    if int(edit["revision"]) != request.timeline_revision:
        raise StudioError("TIMELINE_PREVIEW_REVISION_STALE", ..., status_code=409)
    
    # 3. Résoudre le clip par clip_id
    clips = list(advanced_edit.get("clips", []))
    clip = next((c for c in clips if str(c.get("id")) == request.clip_id), None)
    
    if clip is None:
        raise StudioError("TIMELINE_CLIP_NOT_FOUND", ..., status_code=404)
    
    # 4. Résoudre la source média
    media_record = self.repository.get_primary_media(project_id)
    source_path = self.storage.resolve_uri(str(media_record["uri"]))
    probe = self.media.probe(source_path)
    
    # 5. Calculer la fenêtre de preview (temps de sortie)
    clip_duration_ms = int(clip["end_ms"]) - int(clip["start_ms"])
    
    if request.preview_window:
        window_start_ms = int(request.preview_window.playhead_ms) - 1500
        window_start_ms = max(0, min(clip_duration_ms - 3000, window_start_ms))
        window_duration_ms = 3000
    else:
        window_start_ms = 0
        window_duration_ms = min(clip_duration_ms, 3000)
    
    # 6. Calculer le crop rect
    from gta_studio_api.reframe import compute_crop_rect
    
    focus_x = float(clip.get("focus_start_x", 0.5))
    focus_y = float(clip.get("focus_y", 0.5))
    zoom = float(clip.get("zoom", 1.0))
    
    crop = compute_crop_rect(
        probe.width, probe.height,
        540, 960,
        focus_x, focus_y, zoom
    )
    
    # 7. Créer le PreviewRenderSpec immuable
    render_spec = {
        "client_request_id": request.client_request_id,
        "project_id": project_id,
        "edit_project_id": request.edit_project_id,
        "clip_id": request.clip_id,
        "clip_revision": request.clip_revision,
        "timeline_revision": request.timeline_revision,
        "source_path": str(source_path),
        "source_sha256": str(media_record["sha256"]),
        "source_start_ms": int(clip["start_ms"]),
        "source_end_ms": int(clip["end_ms"]),
        "source_width": probe.width,
        "source_height": probe.height,
        "preview_start_ms": window_start_ms,
        "preview_duration_ms": window_duration_ms,
        "crop_x": crop.crop_x,
        "crop_y": crop.crop_y,
        "crop_width": crop.crop_width,
        "crop_height": crop.crop_height,
        "focus_x": focus_x,
        "focus_y": focus_y,
        "zoom": zoom,
        "speed": float(clip.get("speed", 1.0)),
        "output_width": 540,
        "output_height": 960,
        "output_fps": 30,
        "codec": "libx264",
        "preset": "ultrafast",
        "crf": 28,
        "pixel_format": "yuv420p",
        "audio_codec": "aac",
        "audio_bitrate": "96k",
    }
    
    # 8. Enfiler le job
    job_run_id = self.repository.enqueue_job(
        project_id,
        "RENDER_CLIP_PREVIEW",
        render_spec,
        idempotency_key=None,  # Pas de cache pour l'instant
        version="0.8.2",
    )
    
    # 9. Retourner PreviewResponse
    return PreviewResponse(
        client_request_id=request.client_request_id,
        job_run_id=job_run_id,
        cache_key=None,
        cache_hit=False,
        status="pending",
        artifact_url=None,
        clip_id=request.clip_id,
        clip_revision=request.clip_revision,
        timeline_revision=request.timeline_revision,
        render_profile="draft",
    ).model_dump(mode="json")
```

#### 3. `service.py` — Worker `_render_clip_preview`
```python
def _render_clip_preview(self, job: dict[str, Any]) -> str:
    """Exécute le rendu FFmpeg d'une preview."""
    params = dict(job["parameters"])
    project_id = str(job["project_id"])
    
    # 1. Préparer les chemins
    output_filename = f"preview_{params['clip_id']}_{uuid7()}.mp4"
    output_path = self.storage.get_project_path(project_id) / "previews" / output_filename
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    partial_path = output_path.with_suffix(".partial.mp4")
    
    try:
        # 2. Construire la commande FFmpeg
        from gta_studio_api.render import build_clip_preview_command
        
        cmd = build_clip_preview_command(
            Path(params["source_path"]),
            partial_path,
            params,
        )
        
        # 3. Exécuter FFmpeg avec timeout
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=30,  # 3s de vidéo, timeout généreux
            check=False,
        )
        
        if result.returncode != 0:
            raise StudioError(
                "FFMPEG_PREVIEW_FAILED",
                f"FFmpeg failed: {result.stderr.decode('utf-8', errors='replace')[:500]}",
            )
        
        # 4. Valider avec FFprobe
        probe = self.media.probe(partial_path)
        
        if probe.duration_s < 0.5:
            raise StudioError("PREVIEW_TOO_SHORT", f"Duration {probe.duration_s}s < 0.5s")
        
        if probe.width != params["output_width"] or probe.height != params["output_height"]:
            raise StudioError(
                "PREVIEW_WRONG_DIMENSIONS",
                f"Expected {params['output_width']}×{params['output_height']}, "
                f"got {probe.width}×{probe.height}"
            )
        
        if partial_path.stat().st_size == 0:
            raise StudioError("PREVIEW_EMPTY_FILE", "Output file is empty")
        
        # 5. Renommage atomique
        partial_path.rename(output_path)
        
        # 6. Calculer SHA-256
        sha256 = self.media.compute_sha256(output_path)
        size_bytes = output_path.stat().st_size
        
        # 7. Enregistrer l'artefact
        artifact_uri = f"file://{output_path}"
        artifact_id = self.repository.register_artifact(
            project_id=project_id,
            artifact_type="CLIP_PREVIEW",
            uri=artifact_uri,
            sha256=sha256,
            size_bytes=size_bytes,
            metadata={
                "clip_id": params["clip_id"],
                "duration_s": probe.duration_s,
                "width": probe.width,
                "height": probe.height,
            }
        )
        
        return artifact_id
        
    except subprocess.TimeoutExpired:
        raise StudioError("PREVIEW_TIMEOUT", "FFmpeg timeout after 30s")
    
    except Exception as e:
        # Nettoyer le fichier partiel
        if partial_path.exists():
            partial_path.unlink()
        raise
```

#### 4. `render.py` — Fonction `build_clip_preview_command`
```python
def build_clip_preview_command(
    source_path: Path,
    output_path: Path,
    spec: dict[str, Any],
) -> list[str]:
    """
    Construit la commande FFmpeg pour rendre une preview de clip.
    
    Utilise le PreviewRenderSpec immuable, pas les paramètres mutables du clip.
    """
    from gta_studio_api.reframe import crop_rect_to_pixels
    from gta_studio_api.reframe import NormalizedTransform
    
    # Temps source (ajusté par speed)
    speed = float(spec["speed"])
    source_start_s = (spec["source_start_ms"] + round(spec["preview_start_ms"] * speed)) / 1000.0
    source_duration_s = round(spec["preview_duration_ms"] * speed) / 1000.0
    
    # Crop en pixels
    crop = NormalizedTransform(
        crop_x=spec["crop_x"],
        crop_y=spec["crop_y"],
        crop_width=spec["crop_width"],
        crop_height=spec["crop_height"],
    )
    
    pixel_x, pixel_y, pixel_w, pixel_h = crop_rect_to_pixels(
        crop,
        spec["source_width"],
        spec["source_height"],
    )
    
    # Filtres vidéo
    vfilters = []
    vfilters.append(f"crop={pixel_w}:{pixel_h}:{pixel_x}:{pixel_y}")
    vfilters.append(f"scale={spec['output_width']}:{spec['output_height']}")
    
    if abs(speed - 1.0) > 0.001:
        pts_factor = 1.0 / speed
        vfilters.append(f"setpts={pts_factor}*PTS")
    
    # Filtres audio
    afilters = []
    
    if abs(speed - 1.0) > 0.001:
        # atempo supporte 0.5 à 2.0, chaîner si nécessaire
        remaining = speed
        while remaining > 2.0:
            afilters.append("atempo=2.0")
            remaining /= 2.0
        while remaining < 0.5:
            afilters.append("atempo=0.5")
            remaining /= 0.5
        afilters.append(f"atempo={remaining:.4f}")
    
    # Commande FFmpeg
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", f"{source_start_s:.3f}",
        "-t", f"{source_duration_s:.3f}",
        "-i", str(source_path),
        "-vf", ",".join(vfilters),
    ]
    
    if afilters:
        cmd.extend(["-af", ",".join(afilters)])
    
    cmd.extend([
        "-c:v", spec["codec"],
        "-preset", spec["preset"],
        "-crf", str(spec["crf"]),
        "-pix_fmt", spec["pixel_format"],
        "-r", str(spec["output_fps"]),
        "-c:a", spec["audio_codec"],
        "-b:a", spec["audio_bitrate"],
        "-movflags", "+faststart",
        str(output_path),
    ])
    
    return cmd
```

#### 5. `main.py` — Routes API
```python
@app.post(
    "/api/v1/projects/{project_id}/timeline/preview",
    status_code=202,
    response_model=dict,  # PreviewResponse
)
async def start_clip_preview(
    project_id: str,
    request: ClipPreviewRequest,
) -> dict[str, Any]:
    """Démarre le rendu d'une preview de clip."""
    return service.start_clip_preview(project_id, request)


@app.get("/api/v1/preview-jobs/{job_run_id}")
async def get_preview_job_status(job_run_id: str) -> dict[str, Any]:
    """Récupère le statut d'un job de preview."""
    job = service.repository.get_job(job_run_id)
    
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Trouver l'artefact si le job est terminé
    artifact_url = None
    if job["status"] == "completed" and job.get("artifact_id"):
        artifact = service.repository.get_artifact(job["artifact_id"])
        if artifact:
            artifact_url = f"/api/v1/artifacts/{artifact['id']}/download"
    
    return {
        "job_run_id": job["id"],
        "status": job["status"],
        "artifact_url": artifact_url,
        "error": job.get("failure_message"),
        "created_at": job["created_at"],
        "completed_at": job.get("completed_at"),
    }
```

#### 6. Frontend minimal — Bouton et lecteur

**`apps/desktop/src/PreviewButton.tsx`** (nouveau) :
```typescript
export function PreviewButton({
  projectId,
  clipId,
  timelineRevision,
  clipRevision,
}: {
  projectId: string;
  clipId: string;
  timelineRevision: number;
  clipRevision: number;
}) {
  const [status, setStatus] = useState<string>("idle");
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const generatePreview = async () => {
    setStatus("requesting");
    setError(null);
    
    try {
      const response = await api.renderClipPreview(projectId, {
        clientRequestId: uuidv7(),
        editProjectId: projectId,
        clipId,
        timelineRevision,
        clipRevision,
        renderProfile: "draft",
        previewWindow: null,
      });
      
      const jobRunId = response.job_run_id;
      setStatus("rendering");
      
      // Poll le statut du job
      const interval = setInterval(async () => {
        const jobStatus = await api.getPreviewJobStatus(jobRunId);
        
        if (jobStatus.status === "completed") {
          clearInterval(interval);
          setStatus("ready");
          setArtifactUrl(jobStatus.artifact_url);
        } else if (jobStatus.status === "failed") {
          clearInterval(interval);
          setStatus("failed");
          setError(jobStatus.error || "Rendu échoué");
        }
      }, 1000);
      
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  };
  
  return (
    <div>
      <button onClick={generatePreview} disabled={status === "rendering"}>
        {status === "idle" && "Générer preview"}
        {status === "requesting" && "Envoi..."}
        {status === "rendering" && "Rendu en cours..."}
        {status === "ready" && "✓ Preview prête"}
        {status === "failed" && "✗ Échec"}
      </button>
      
      {error && <div style={{ color: "red" }}>{error}</div>}
      
      {artifactUrl && (
        <video
          src={`http://127.0.0.1:8765${artifactUrl}`}
          controls
          style={{ width: 270, height: 480 }}
        />
      )}
    </div>
  );
}
```

### Critères d'acceptation (tests obligatoires) :

1. ✅ Route POST retourne `202 Accepted` avec `PreviewResponse`
2. ✅ Job contient un `PreviewRenderSpec` immuable (snapshot complet)
3. ✅ Worker termine sans erreur
4. ✅ FFmpeg produit un fichier `.partial.mp4`
5. ✅ FFprobe valide : durée ~3s, résolution 540×960
6. ✅ Fichier renommé atomiquement en `.mp4`
7. ✅ Artefact enregistré dans la base
8. ✅ Route GET `/preview-jobs/{id}` retourne `artifact_url`
9. ✅ Frontend peut lire le MP4 dans `<video>`
10. ✅ Cadrage correspond au crop calculé (vérification visuelle)
11. ✅ Vitesse appliquée correctement (vérifier audio pitch)
12. ✅ Erreur FFmpeg place le job en `failed` avec message clair
13. ✅ Fichier `.partial.mp4` nettoyé en cas d'échec
14. ✅ Aucun fichier partiel accessible via l'API

### Tests spécifiques à exécuter :

```python
# test_preview_vertical_slice.py

def test_preview_full_flow(test_project_id, test_clip_id):
    """Test du flux complet de bout en bout."""
    # 1. Demander preview
    response = api.start_clip_preview(test_project_id, {
        "client_request_id": str(uuid7()),
        "edit_project_id": test_project_id,
        "clip_id": test_clip_id,
        "timeline_revision": 1,
        "clip_revision": 0,
        "render_profile": "draft",
        "preview_window": None,
    })
    
    assert response["status"] == "pending"
    assert response["job_run_id"] is not None
    job_run_id = response["job_run_id"]
    
    # 2. Attendre completion (max 30s)
    for _ in range(30):
        job_status = api.get_preview_job_status(job_run_id)
        if job_status["status"] in ["completed", "failed"]:
            break
        time.sleep(1)
    
    assert job_status["status"] == "completed"
    assert job_status["artifact_url"] is not None
    
    # 3. Télécharger et valider l'artefact
    artifact_path = download_artifact(job_status["artifact_url"])
    probe = ffprobe(artifact_path)
    
    assert 2.5 <= probe.duration_s <= 3.5  # ~3s
    assert probe.width == 540
    assert probe.height == 960
    assert probe.codec_name == "h264"
    assert artifact_path.stat().st_size > 10_000  # Non vide


def test_preview_ffmpeg_error():
    """Test que les erreurs FFmpeg sont correctement propagées."""
    # Source corrompue ou inexistante
    response = api.start_clip_preview(broken_project_id, {...})
    job_run_id = response["job_run_id"]
    
    wait_for_job(job_run_id, timeout=30)
    
    job_status = api.get_preview_job_status(job_run_id)
    assert job_status["status"] == "failed"
    assert job_status["error"] is not None
    assert "FFmpeg" in job_status["error"]


def test_preview_crop_correctness():
    """Vérifier que le crop produit correspond au calcul canonique."""
    # Créer un clip avec focus=0.25 (cadrage à gauche)
    response = api.start_clip_preview(project_id, {
        ...,
        # Clip avec focus_start_x = 0.25
    })
    
    wait_for_job(response["job_run_id"])
    artifact = download_artifact(...)
    
    # Extraire la première frame
    first_frame = extract_frame(artifact, time_s=0.1)
    
    # La frame doit montrer la partie gauche de la source
    # Vérification visuelle ou par analyse de pixels
    assert frame_shows_left_portion(first_frame)
```

### Commandes de vérification :

```bash
# 1. Appliquer la migration
cd packages/database
sqlite3 ../../data/studio.db < migrations/0010_preview_cache.sql

# 2. Lancer les tests Python
cd services/api
poetry run pytest tests/test_preview_vertical_slice.py -v

# 3. Lancer le backend
poetry run uvicorn gta_studio_api.main:app --reload

# 4. Lancer le frontend
cd apps/desktop
npm run dev

# 5. Test manuel
# - Ouvrir un projet en édition avancée
# - Cliquer sur "Générer preview"
# - Attendre ~5-10s
# - Vérifier que le lecteur affiche le MP4
```

**Règle d'arrêt** : Une fois tous les critères validés et les tests verts, produire un rapport détaillé (fichiers modifiés, commandes exécutées, résultats, limites rencontrées), puis **s'arrêter**. Ne pas continuer vers Phase 0.8.3 sans validation.

---

## Phase 0.8.3 : Preview interactive frontend (GATE 3)
**Objectif** : Ajouter les transformations CSS instantanées (Niveau A).

### Périmètre :
- Transformation CSS sur le proxy
- Déplacement du focus
- Zoom interactif
- Synchronisation playhead
- Debounce 300ms
- Conservation de la dernière preview encodée
- Comparaison visuelle CSS vs FFmpeg

**Pré-requis** : Phase 0.8.2 validée

---

## Phase 0.8.4 : Cache et déduplication (GATE 4)
**Objectif** : Optimiser avec le cache déterministe.

### Périmètre :
- Clé SHA-256 des paramètres normalisés
- Cache hit < 150ms
- Déduplication (même clé → un seul job)
- Cache partagé inter-projets
- Validation des artefacts
- Régénération si corrompu

**Pré-requis** : Phase 0.8.3 validée

---

## Phase 0.8.5 : Concurrence et révisions (GATE 5)
**Objectif** : Gérer les courses et les révisions multiples.

### Périmètre :
- `latest-request-wins` avec `clientRequestId`
- Annulation via `jobRunId`
- Révisions de clip
- Révisions de timeline
- Rejet des requêtes obsolètes

**Pré-requis** : Phase 0.8.4 validée

---

## Phase 0.8.6 : Fidelity, préchargement et finition (GATE 6)
**Objectif** : Compléter avec les fonctionnalités avancées.

### Périmètre :
- Profil `fidelity`
- Préchargement non récursif (`job_origin`)
- Priorité utilisateur vs prefetch
- LRU avec protection `ref_count`
- Badges d'état avancés
- Métriques P95

**Pré-requis** : Phase 0.8.5 validée

---

## Principes directeurs

### ✅ Faire :
- Travailler par gates avec arrêts explicites
- Créer des snapshots immuables dans les jobs
- Valider avec FFprobe avant de servir
- Écrire atomiquement (temporaire → rename)
- Tester chaque phase avant la suivante
- Mesurer les critères d'acceptation, pas les heures
- Nettoyer les fichiers partiels en cas d'échec

### ❌ Ne pas faire :
- Relire les paramètres mutables du clip dans le worker
- Servir un fichier `.partial.mp4`
- Retourner `dict[str, Any]` générique
- Continuer sans validation de la phase précédente
- Ajouter cache/préchargement avant le vertical slice
- Implémenter plusieurs phases en une fois

---

## Résumé des changements par rapport à la version précédente

### Corrections majeures :
1. **Option C remplacée par Phase 0.8.2** : Vertical slice complet, pas juste une route vide
2. **PreviewRenderSpec immuable** : Le worker ne relit pas la timeline
3. **Validation FFprobe obligatoire** : Pas de fichier servi sans vérification
4. **Écriture atomique** : `.partial.mp4` → `.mp4` seulement si valide
5. **Frontend inclus dans Phase 0.8.2** : Bouton + lecteur pour valider le flux
6. **Cache en Phase 0.8.4** : Après validation de l'UX, pas avant
7. **Critères d'acceptation précis** : 14 points de validation obligatoires
8. **Règles d'arrêt explicites** : S'arrêter après chaque gate

### Structure hiérarchique :
- **Phase 0.8.1** : Validation des fondations
- **Phase 0.8.2** : Vertical slice (GATE critique)
- **Phase 0.8.3** : Frontend interactif
- **Phase 0.8.4** : Cache
- **Phase 0.8.5** : Concurrence
- **Phase 0.8.6** : Finition

Chaque phase se termine par un rapport et une validation avant de continuer.

### Fichiers à modifier :

#### 1. `service.py` — Méthode `start_clip_preview`
```python
def start_clip_preview(
    self, project_id: str, request: ClipPreviewRequest
) -> dict[str, Any]:
    """Version MVP : rendu direct sans cache."""
    # 1. Valider révision timeline
    # 2. Résoudre clip par clip_id
    # 3. Enqueuer job RENDER_CLIP_PREVIEW
    # 4. Retourner PreviewResponse avec status='pending'
```

**Effort** : 2-3h  
**Risque** : Faible  
**Test** : Appeler l'endpoint, vérifier que le job est créé

#### 2. `service.py` — Worker `_render_clip_preview`
```python
def _render_clip_preview(self, job: dict[str, Any]) -> str:
    """Exécuter FFmpeg pour générer la preview."""
    # 1. Extraire paramètres du job
    # 2. Appeler render.build_clip_preview_command
    # 3. Exécuter FFmpeg
    # 4. Enregistrer artefact
    # 5. Retourner artifact_id
```

**Effort** : 3-4h  
**Risque** : Moyen (FFmpeg)  
**Test** : Job terminé, fichier MP4 créé

#### 3. `render.py` — Fonction `build_clip_preview_command`
```python
def build_clip_preview_command(
    source_path: Path,
    output_path: Path,
    clip: dict[str, Any],
    preview_window: dict[str, Any] | None,
    resolved_profile: dict[str, Any],
) -> list[str]:
    """Construire commande FFmpeg avec compute_crop_rect."""
    # 1. Calculer fenêtre source (ajustée par speed)
    # 2. Appeler compute_crop_rect pour le crop
    # 3. Construire filtres vidéo (crop, scale, speed, fades)
    # 4. Construire filtres audio (atempo, fades)
    # 5. Retourner commande FFmpeg complète
```

**Effort** : 4-5h  
**Risque** : Élevé (complexité FFmpeg)  
**Test** : Commande produit un MP4 valide

#### 4. `main.py` — Route API
```python
@app.post("/api/v1/projects/{project_id}/timeline/preview")
async def render_clip_preview(
    project_id: str, request: ClipPreviewRequest
) -> dict[str, Any]:
    return service.start_clip_preview(project_id, request)
```

**Effort** : 30min  
**Risque** : Faible  
**Test** : Appel HTTP retourne PreviewResponse

**Total Phase 1** : 10-13h de développement  
**Livrable** : Preview fonctionnelle (sans cache, lente, mais correcte)

---

## Phase 2 : Cache et optimisation
**Objectif** : Ajouter le cache déterministe et la déduplication.

### Modifications :

#### 1. `service.py` — Calcul clé de cache
```python
def _preview_cache_key(
    source_sha256: str,
    clip: dict[str, Any],
    preview_window: dict[str, Any] | None,
    resolved_profile: dict[str, Any],
    renderer_version: str,
    ffmpeg_build_id: str,
) -> str:
    """SHA-256 des paramètres normalisés."""
```

**Effort** : 2h

#### 2. `repository.py` — Méthodes cache
```python
def create_preview_cache_entry(...)
def find_preview_cache_entry(...)
def complete_preview_cache(...)
def touch_preview_cache(...)
def link_project_preview(...)
```

**Effort** : 3h

#### 3. `service.py` — Intégration cache dans `start_clip_preview`
**Effort** : 2h

**Total Phase 2** : 7h  
**Livrable** : Cache hit < 150ms, déduplication fonctionnelle

---

## Phase 3 : Frontend interactif
**Objectif** : Niveau A (preview CSS instantanée).

### Fichiers à créer/modifier :

#### 1. `types.ts` — Types preview
```typescript
export interface PreviewResponse { ... }
export type PreviewStatus = "interactive" | "dirty" | ...
```

**Effort** : 1h

#### 2. `PreviewCoordinator.ts`
```typescript
export class PreviewCoordinator {
  requestPreview(params) { ... }
  handleJobComplete(notification) { ... }
}
```

**Effort** : 5h

#### 3. `InteractivePreview.tsx`
```typescript
export function InteractivePreview({ proxyUrl, clip, ... }) {
  // Niveau A : transformations CSS instantanées
}
```

**Effort** : 6h

#### 4. Intégration dans `EditingStudio.tsx`
**Effort** : 3h

**Total Phase 3** : 15h  
**Livrable** : Preview interactive fluide, badges d'état

---

## Phase 4 : Préchargement et polish
**Objectif** : Préchargement non récursif, LRU, tests.

**Effort** : 10h  
**Livrable** : Système complet et optimisé

---

## Plan d'action recommandé

### Option A : Implémentation immédiate (risquée)
- Tout implémenter en une fois (~40h de dev)
- Risque élevé de bugs et régressions
- Difficile à déboguer

### Option B : Incrémentale (recommandée)
1. **Cette semaine** : Phase 1 MVP (10-13h)
   - Tester sur un vrai projet
   - Identifier les problèmes FFmpeg
   
2. **Semaine prochaine** : Phase 2 Cache (7h)
   - Mesurer les gains de performance
   - Ajuster les seuils LRU
   
3. **Semaine suivante** : Phase 3 Frontend (15h)
   - Tests utilisateur réels
   - Ajuster la réactivité
   
4. **Finalisation** : Phase 4 Polish (10h)
   - Tests E2E
   - Documentation

### Option C : Prototype minimal (la plus sûre)
Implémenter uniquement :
- `start_clip_preview` (version simplifiée sans cache)
- `_render_clip_preview` (rendu basique)
- Route API

**Effort** : 5-6h  
**Avantage** : Validation rapide du concept  
**Désavantage** : Pas de cache, pas d'optimisation

---

## Prochaine étape immédiate

Je recommande **Option C (Prototype)** pour valider l'architecture sans risquer votre app actuelle :

1. Créer une branche git `feature/preview-engine`
2. Implémenter le prototype minimal (5-6h)
3. Tester sur un projet réel
4. Si ça fonctionne, continuer avec Phase 1 complète

Voulez-vous que je commence par le prototype minimal ? Cela nous permettra de valider que tout fonctionne avant d'investir 40h dans l'implémentation complète.
