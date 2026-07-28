use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[derive(Clone, Copy)]
pub enum MediaTool {
    Ffmpeg,
    Ffprobe,
}

impl MediaTool {
    fn path_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }
}

#[derive(Clone)]
struct MediaTools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    bundled: bool,
}

static TOOLS: OnceLock<MediaTools> = OnceLock::new();

fn both_exist(directory: &Path) -> bool {
    directory.join("ffmpeg.exe").is_file() && directory.join("ffprobe.exe").is_file()
}

fn resolve(app: &AppHandle) -> MediaTools {
    if let Ok(ffmpeg) = app
        .path()
        .resolve("binaries/ffmpeg.exe", BaseDirectory::Resource)
    {
        if let Some(directory) = ffmpeg.parent().filter(|directory| both_exist(directory)) {
            let ffprobe = directory.join("ffprobe.exe");
            return MediaTools {
                ffmpeg,
                ffprobe,
                bundled: true,
            };
        }
    }

    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if both_exist(&development) {
        return MediaTools {
            ffmpeg: development.join("ffmpeg.exe"),
            ffprobe: development.join("ffprobe.exe"),
            bundled: true,
        };
    }

    MediaTools {
        ffmpeg: PathBuf::from("ffmpeg"),
        ffprobe: PathBuf::from("ffprobe"),
        bundled: false,
    }
}

pub fn initialize(app: &AppHandle) {
    let _ = TOOLS.set(resolve(app));
}

pub fn path(tool: MediaTool) -> PathBuf {
    let Some(tools) = TOOLS.get() else {
        return PathBuf::from(tool.path_name());
    };
    match tool {
        MediaTool::Ffmpeg => tools.ffmpeg.clone(),
        MediaTool::Ffprobe => tools.ffprobe.clone(),
    }
}

pub fn bundled() -> bool {
    TOOLS.get().is_some_and(|tools| tools.bundled)
}
