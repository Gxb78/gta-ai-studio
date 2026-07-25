from __future__ import annotations

import argparse
import json

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="GTA AI Studio local API sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir")
    parser.add_argument("--smoke-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.data_dir:
        import os

        os.environ["GTA_STUDIO_DATA_DIR"] = arguments.data_dir
    if arguments.smoke_test:
        from gta_studio_api.config import Settings
        from gta_studio_api.editing_intelligence import load_edit_template
        from gta_studio_api.service import StudioService

        settings = Settings()
        service = StudioService(settings)
        service.initialize()
        print(json.dumps({
            "status": "ok",
            "tools": service.media.diagnostics(),
            "speech": service.speech.diagnostics(),
            "vision": service.vision.diagnostics(),
            "vision_inference": service.vision.verify_inference_runtime(),
            "gta5_adapter": service.gta5_adapter.diagnostics(),
            "editing_templates": {
                style: load_edit_template(settings.template_root, style)["id"]
                for style in ("dynamic", "cinematic", "tutorial")
            },
        }))
        return
    uvicorn.run(
        "gta_studio_api.main:app",
        host=arguments.host,
        port=arguments.port,
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
