# API locale

Backend FastAPI local des Phases 1 à 3. Il gère projets, import/proxy, queue SQLite, scènes, images clés OpenCV, OCR RapidOCR/ONNX, adaptateur GTA V, recherche guidée, brief/script, voix Windows, sous-titres, timeline, rendu FFmpeg, variantes et contrôles qualité.

```powershell
uv run --project services/api uvicorn gta_studio_api.main:app --app-dir services/api/src --host 127.0.0.1 --port 8765
```

L’API écoute sur la boucle locale. La documentation OpenAPI de développement est disponible sous `/docs`.

Les routes se trouvent sous `/api/v1` : santé, voix, liste/détail/import/production des projets, retry, annulation, flux SSE et streaming proxy/frames/rendu/voix/sous-titres. Le même processus héberge le worker local ; il récupère au démarrage les leases expirés et reprend chaque étape depuis ses artefacts persistés.
