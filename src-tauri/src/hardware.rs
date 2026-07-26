use serde::Serialize;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use crate::media_tools::{self, MediaTool};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoEncoder {
    Libx264,
    H264Nvenc,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareCapabilities {
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
    pub gpu_name: Option<String>,
    pub nvenc_available: bool,
    pub selected_encoder: VideoEncoder,
    pub media_tools_bundled: bool,
    pub diagnostics: Vec<String>,
}

static CAPABILITIES: OnceLock<Mutex<HardwareCapabilities>> = OnceLock::new();

fn command(binary: &str) -> Command {
    let command = Command::new(binary);
    #[cfg(windows)]
    let command = {
        let mut command = command;
        command.creation_flags(0x0800_0000);
        command
    };
    command
}

fn media_command(tool: MediaTool) -> Command {
    let path = media_tools::path(tool);
    command(path.to_string_lossy().as_ref())
}

fn version(tool: MediaTool) -> Option<String> {
    let output = media_command(tool).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

fn gpu_name() -> Option<String> {
    let output = command("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

fn ffmpeg_exposes_nvenc() -> bool {
    media_command(MediaTool::Ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).contains("h264_nvenc"))
        .unwrap_or(false)
}

fn nvenc_self_test() -> bool {
    media_command(MediaTool::Ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=128x128:rate=1",
            "-frames:v",
            "1",
            "-c:v",
            "h264_nvenc",
            "-f",
            "null",
            "-",
        ])
        .output()
        .ok()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn detect() -> HardwareCapabilities {
    let ffmpeg = version(MediaTool::Ffmpeg);
    let ffprobe = version(MediaTool::Ffprobe);
    let gpu = gpu_name();
    let exposes_nvenc = ffmpeg.is_some() && ffmpeg_exposes_nvenc();
    // L'auto-test d'encodage est la preuve décisive. `nvidia-smi` ne sert qu'à
    // enrichir l'affichage : il peut manquer du PATH alors que NVENC fonctionne.
    let nvenc_available = exposes_nvenc && nvenc_self_test();
    let mut diagnostics = Vec::new();

    if ffmpeg.is_none() {
        diagnostics.push("FFmpeg est introuvable dans le PATH.".into());
    }
    if ffprobe.is_none() {
        diagnostics.push("FFprobe est introuvable dans le PATH.".into());
    }
    if gpu.is_none() && !nvenc_available {
        diagnostics.push("Aucun GPU NVIDIA détecté par nvidia-smi.".into());
    }
    if !exposes_nvenc {
        diagnostics.push("Cette installation de FFmpeg n'expose pas h264_nvenc.".into());
    } else if !nvenc_available {
        diagnostics.push("L'auto-test NVENC a échoué ; encodage CPU sélectionné.".into());
    }

    HardwareCapabilities {
        ffmpeg_version: ffmpeg.unwrap_or_else(|| "Indisponible".into()),
        ffprobe_version: ffprobe.unwrap_or_else(|| "Indisponible".into()),
        gpu_name: gpu,
        nvenc_available,
        selected_encoder: if nvenc_available {
            VideoEncoder::H264Nvenc
        } else {
            VideoEncoder::Libx264
        },
        media_tools_bundled: media_tools::bundled(),
        diagnostics,
    }
}

pub fn capabilities() -> HardwareCapabilities {
    CAPABILITIES
        .get_or_init(|| Mutex::new(detect()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn selected_encoder() -> VideoEncoder {
    capabilities().selected_encoder
}

pub fn disable_nvenc(reason: impl Into<String>) {
    let mut capabilities = CAPABILITIES
        .get_or_init(|| Mutex::new(detect()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    capabilities.nvenc_available = false;
    capabilities.selected_encoder = VideoEncoder::Libx264;
    capabilities.diagnostics.push(reason.into());
}

#[tauri::command]
pub async fn hardware_capabilities() -> HardwareCapabilities {
    tauri::async_runtime::spawn_blocking(capabilities)
        .await
        .unwrap_or_else(|error| HardwareCapabilities {
            ffmpeg_version: "Diagnostic interrompu".into(),
            ffprobe_version: "Diagnostic interrompu".into(),
            gpu_name: None,
            nvenc_available: false,
            selected_encoder: VideoEncoder::Libx264,
            media_tools_bundled: media_tools::bundled(),
            diagnostics: vec![format!("Diagnostic matériel interrompu : {error}")],
        })
}
