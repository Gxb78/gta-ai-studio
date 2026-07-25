# Desktop

Application Tauri 2 + React de la Phase 5. Elle conserve les ateliers Vision et Narrative Map, puis ajoute Evidence & Knowledge : verdict factuel, claims, statuts de certitude, preuves horodatées, faits admis ou exclus, usages et révisions de connaissance, et contrôle d’isolation GTA V/GTA VI. Un rendu terminé peut être décliné sans écraser les révisions précédentes.

```powershell
npm run build --workspace @gta-ai-studio/desktop
npm run tauri --workspace @gta-ai-studio/desktop -- build --no-bundle
npm run tauri --workspace @gta-ai-studio/desktop -- dev
```

Le binaire backend doit d’abord être construit avec `scripts/build-sidecar.ps1` ; ce script exécute aussi un smoke test FFmpeg/FFprobe/SAPI/OpenCV/ONNX/RapidOCR sur le binaire empaqueté. Un build sans bundle produit `src-tauri/target/release/gta-ai-studio.exe` ; le build normal produit l’installateur NSIS sous `src-tauri/target/release/bundle/nsis/`.
