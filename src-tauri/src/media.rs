// Préparation des médias et export final.
// Règles : commandes FFmpeg construites uniquement depuis des valeurs typées
// et validées (jamais de shell libre), écritures via fichier temporaire puis
// renommage, sources d'origine jamais modifiées.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::hardware::{self, VideoEncoder};
use crate::media_tools::{self, MediaTool};

const ALLOWED_EXTENSIONS: [&str; 4] = ["mp4", "mov", "mkv", "m4v"];
const PROXY_HEIGHT: u32 = 720;
const PROXY_GOP: u32 = 15; // GOP courtes = scrubbing quasi instantané
/// Hauteur de la bande de vignettes côté interface. Miroir de THUMB_STRIP_PX
/// dans src/components/Timeline.tsx : les deux doivent bouger ensemble.
const THUMB_STRIP_PX: f64 = 122.0;
/// Zoom maximal de la timeline. Miroir de MAX_PX_PER_SEC dans Timeline.tsx.
const MAX_PX_PER_SEC: f64 = 240.0;
/// Vignettes générées au double de la hauteur d'affichage : sur un écran à
/// 125 ou 150 %, une vignette à l'échelle 1 serait agrandie, donc floue.
const THUMB_SCALE: f64 = 2.0;
/// Plafond du nombre de vignettes, pour qu'un rush de deux heures reste raisonnable.
const MAX_THUMBS: f64 = 1800.0;
/// Version globale des fichiers dérivés, vue par l'interface : elle déclenche
/// le rafraîchissement au chargement d'un projet. À incrémenter dès qu'un
/// paramètre de génération change, sinon le cache resservirait les anciens
/// fichiers indéfiniment.
const ASSET_VERSION: u32 = 4;
/// Versions par famille de fichiers : seules celles qui changent réellement
/// provoquent un recalcul, les autres restent en cache.
const THUMB_VERSION: u32 = 3;
const WAVEFORM_VERSION: u32 = 1;
const MAX_SEGMENTS: usize = 500;
const MAX_TEXT_OVERLAYS: usize = 64;
const MAX_TEXT_LENGTH: usize = 200;
/// Un rush = une entrée FFmpeg ouverte simultanément. Au-delà, on sature les
/// descripteurs de fichiers et la mémoire du décodeur.
const MAX_SOURCES: usize = 32;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub video_codec: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub original_path: String,
    pub proxy_path: String,
    pub thumb_paths: Vec<String>,
    pub thumb_interval_ms: f64,
    pub waveform_path: Option<String>,
    /// Version des fichiers dérivés présents sur disque. Absente des projets
    /// enregistrés avant l'introduction du champ : ils valent alors la version 1.
    #[serde(default = "legacy_asset_version")]
    pub asset_version: u32,
    pub probe: ProbeInfo,
}

fn legacy_asset_version() -> u32 {
    1
}

fn default_rate() -> f64 {
    1.0
}

fn default_volume() -> f64 {
    1.0
}

/// Contrôle d'un plan avant construction du graphe. Les deux plans y passent :
/// tout ce qui finit dans une commande FFmpeg doit être validé.
fn validate_segments(segments: &[ExportSegment], source_count: usize) -> Result<(), String> {
    if segments.len() > MAX_SEGMENTS {
        return Err(format!("Trop de segments ({MAX_SEGMENTS} maximum)."));
    }
    for segment in segments {
        if !segment.src_in_ms.is_finite() || !segment.src_out_ms.is_finite() {
            return Err("Un segment a des bornes non numériques.".into());
        }
        if segment.src_in_ms < 0.0 || segment.src_out_ms <= segment.src_in_ms {
            return Err("Un segment a des bornes invalides.".into());
        }
        if !segment.gap_before_ms.is_finite() || segment.gap_before_ms < 0.0 {
            return Err("Un trou a une durée invalide.".into());
        }
        if !segment.playback_rate.is_finite() || !(0.25..=4.0).contains(&segment.playback_rate) {
            return Err("Vitesse de segment hors bornes (0,25x à 4x).".into());
        }
        if !segment.volume.is_finite() || !(0.0..=1.0).contains(&segment.volume) {
            return Err("Volume de segment hors bornes (0 % à 100 %).".into());
        }
        let fades = [
            segment.audio_fade_in_ms,
            segment.audio_fade_out_ms,
            segment.audio_fade_offset_ms,
            segment.audio_clip_duration_ms,
        ];
        if fades.iter().any(|value| !value.is_finite() || *value < 0.0) {
            return Err("Enveloppe audio de segment invalide.".into());
        }
        if segment.audio_fade_in_ms > 0.0 || segment.audio_fade_out_ms > 0.0 {
            let timeline_duration =
                (segment.src_out_ms - segment.src_in_ms) / segment.playback_rate;
            if segment.audio_clip_duration_ms <= 0.0
                || segment.audio_fade_in_ms > segment.audio_clip_duration_ms / 2.0 + 0.001
                || segment.audio_fade_out_ms > segment.audio_clip_duration_ms / 2.0 + 0.001
                || segment.audio_fade_offset_ms + timeline_duration
                    > segment.audio_clip_duration_ms + 0.001
            {
                return Err("Fondus audio hors des bornes du clip.".into());
            }
        }
        let video_fades = [
            segment.video_fade_in_ms,
            segment.video_fade_out_ms,
            segment.video_fade_offset_ms,
            segment.video_clip_duration_ms,
        ];
        if video_fades.iter().any(|value| !value.is_finite() || *value < 0.0) {
            return Err("Enveloppe vidéo de segment invalide.".into());
        }
        if segment.video_fade_in_ms > 0.0 || segment.video_fade_out_ms > 0.0 {
            let timeline_duration =
                (segment.src_out_ms - segment.src_in_ms) / segment.playback_rate;
            if segment.video_clip_duration_ms <= 0.0
                || segment.video_fade_in_ms > 3000.0 + 0.001
                || segment.video_fade_out_ms > 3000.0 + 0.001
                || segment.video_fade_in_ms > segment.video_clip_duration_ms / 2.0 + 0.001
                || segment.video_fade_out_ms > segment.video_clip_duration_ms / 2.0 + 0.001
                || segment.video_fade_offset_ms + timeline_duration
                    > segment.video_clip_duration_ms + 0.001
                || segment.src_in_ms < segment.video_fade_offset_ms * segment.playback_rate - 0.001
            {
                return Err("Fondus vidéo hors des bornes du clip.".into());
            }
        }
        if segment.source_index >= source_count {
            return Err("Un segment référence un rush inconnu.".into());
        }
    }
    Ok(())
}

fn validate_text_overlays(overlays: &[ExportTextOverlay], duration_ms: f64) -> Result<(), String> {
    if overlays.len() > MAX_TEXT_OVERLAYS {
        return Err(format!("Trop de titres ({MAX_TEXT_OVERLAYS} maximum)."));
    }
    for overlay in overlays {
        let text_length = overlay.text.chars().count();
        if overlay.text.trim().is_empty() || text_length > MAX_TEXT_LENGTH {
            return Err(format!(
                "Texte de titre invalide (1 à {MAX_TEXT_LENGTH} caractères)."
            ));
        }
        if overlay
            .text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
        {
            return Err("Un titre contient un caractère de contrôle interdit.".into());
        }
        let numbers = [
            overlay.timeline_start_ms,
            overlay.timeline_end_ms,
            overlay.x,
            overlay.y,
            overlay.font_size_px,
        ];
        if numbers.iter().any(|value| !value.is_finite()) {
            return Err("Un titre contient une valeur non numérique.".into());
        }
        if overlay.timeline_start_ms < 0.0
            || overlay.timeline_end_ms <= overlay.timeline_start_ms
            || overlay.timeline_end_ms > duration_ms + 0.001
        {
            return Err("Timing de titre hors des bornes du montage.".into());
        }
        if !(0.0..=1.0).contains(&overlay.x)
            || !(0.0..=1.0).contains(&overlay.y)
            || !(36.0..=180.0).contains(&overlay.font_size_px)
        {
            return Err("Position ou taille de titre hors bornes.".into());
        }
        let title_duration = overlay.timeline_end_ms - overlay.timeline_start_ms;
        if !overlay.fade_in_ms.is_finite()
            || !overlay.fade_out_ms.is_finite()
            || overlay.fade_in_ms < 0.0
            || overlay.fade_out_ms < 0.0
            || overlay.fade_in_ms > 2000.0 + 0.001
            || overlay.fade_out_ms > 2000.0 + 0.001
            || overlay.fade_in_ms > title_duration / 2.0 + 0.001
            || overlay.fade_out_ms > title_duration / 2.0 + 0.001
        {
            return Err("Fondus de titre hors bornes.".into());
        }
        if !matches!(overlay.style.as_str(), "impact" | "caption" | "minimal") {
            return Err("Style de titre inconnu.".into());
        }
    }
    Ok(())
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn drawtext_filter(
    overlay: &ExportTextOverlay,
    text_path: &Path,
    font_path: &Path,
) -> String {
    let style = match overlay.style.as_str() {
        "impact" => "borderw=8:bordercolor=black",
        "caption" => "box=1:boxcolor=black@0.72:boxborderw=20",
        _ => "shadowx=3:shadowy=3:shadowcolor=black@0.90",
    };
    let start = overlay.timeline_start_ms / 1000.0;
    let end = overlay.timeline_end_ms / 1000.0;
    let mut alpha_factors: Vec<String> = Vec::new();
    if overlay.fade_in_ms > 0.0 {
        let duration = overlay.fade_in_ms / 1000.0;
        alpha_factors.push(format!(
            "min(1,max(0,(t-{start:.6})/{duration:.6}))"
        ));
    }
    if overlay.fade_out_ms > 0.0 {
        let duration = overlay.fade_out_ms / 1000.0;
        alpha_factors.push(format!(
            "min(1,max(0,({end:.6}-t)/{duration:.6}))"
        ));
    }
    let alpha = if alpha_factors.is_empty() {
        "1".into()
    } else {
        alpha_factors.join("*")
    };
    format!(
        "drawtext=fontfile='{font}':textfile='{text}':expansion=none:fontcolor=white:fontsize={size:.3}:text_align=C:{style}:x='w*{x:.6}-text_w/2':y='h*{y:.6}-text_h/2':alpha='{alpha}':enable='between(t,{start:.6},{end:.6})':fix_bounds=1",
        font = escape_filter_path(font_path),
        text = escape_filter_path(text_path),
        size = overlay.font_size_px,
        x = overlay.x,
        y = overlay.y,
    )
}

struct TemporaryTextFiles(Vec<PathBuf>);

impl Drop for TemporaryTextFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

/// Le montage a-t-il besoin d'une source de silence ?
///
/// Extrait pour être testable : c'est la décision qui, mal prise, produisait un
/// graphe FFmpeg référençant une entrée inexistante.
fn needs_silence_input(
    has_audio: bool,
    audio_segments: &[ExportSegment],
    audio_tail_ms: f64,
    sources: &[ExportSource],
) -> bool {
    has_audio
        && (audio_segments.iter().any(|s| s.gap_before_ms > 0.0)
            || audio_tail_ms > 1.0
            || sources.iter().any(|s| !s.has_audio))
}

/// Format de sortie, imposé : c'est le format TikTok/Reels/Shorts.
/// Doit rester aligné sur OUTPUT_WIDTH / OUTPUT_HEIGHT dans src/types.ts.
const OUT_WIDTH: u32 = 1080;
const OUT_HEIGHT: u32 = 1920;

/// Bruite le décalage de cadrage : hors de [−1, 1] il n'a aucun sens, et il
/// finit dans une expression de filtre — il est validé avant, pas espéré.
fn sane_crop_x(crop_x: f64) -> f64 {
    if crop_x.is_finite() {
        crop_x.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Passage d'un segment au format vertical, du brut `[raw{i}]` vers `[v{i}]`.
///
/// C'est ici que se joue la promesse « l'aperçu montre exactement l'export » :
///   - `crop` : la fenêtre 9:16 la plus large possible, glissée horizontalement
///     par `cropX` (−1 = collée à gauche, +1 = collée à droite) ;
///   - `blur` : l'image entière, posée sur une copie élargie et floutée.
fn framing_chain(mode: &str, crop_x: f64, i: usize, vtail: &str) -> String {
    if mode == "crop" {
        // x = centre + cropX × marge disponible. Avec cropX = 0 on retrouve
        // exactement le recadrage centré d'avant le cadrage par clip.
        let offset = sane_crop_x(crop_x);
        format!(
            "[raw{i}]crop='min(iw,ih*9/16)':'min(ih,iw*16/9)':\
             '(iw-out_w)/2+({offset:.4})*(iw-out_w)/2':'(ih-out_h)/2',\
             scale={OUT_WIDTH}:{OUT_HEIGHT}:flags=lanczos,{vtail}[v{i}];"
        )
    } else {
        format!(
            "[raw{i}]split=2[bga{i}][fga{i}];\
             [bga{i}]scale={OUT_WIDTH}:{OUT_HEIGHT}:force_original_aspect_ratio=increase,\
             crop={OUT_WIDTH}:{OUT_HEIGHT},gblur=sigma=24[bg{i}];\
             [fga{i}]scale={OUT_WIDTH}:{OUT_HEIGHT}:force_original_aspect_ratio=decrease[fg{i}];\
             [bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2,{vtail}[v{i}];"
        )
    }
}

/// Chaîne de filtres `atempo` couvrant un facteur quelconque : chaque instance
/// n'accepte que 0,5 à 2 sans dégradation, on décompose donc les valeurs
/// extrêmes en plusieurs étages.
fn atempo_chain(rate: f64) -> String {
    let stage = |value: f64| format!("atempo={value:.6}");
    let mut remaining = rate;
    let mut parts: Vec<String> = Vec::new();
    while remaining < 0.5 {
        parts.push(stage(0.5));
        remaining /= 0.5;
    }
    while remaining > 2.0 {
        parts.push(stage(2.0));
        remaining /= 2.0;
    }
    if (remaining - 1.0).abs() > 1e-6 {
        parts.push(stage(remaining));
    }
    if parts.is_empty() {
        "anull".into()
    } else {
        parts.join(",")
    }
}

fn audio_volume_filter(segment: &ExportSegment) -> String {
    if segment.audio_fade_in_ms <= 0.0 && segment.audio_fade_out_ms <= 0.0 {
        return format!("volume={:.6}", segment.volume);
    }

    let offset = segment.audio_fade_offset_ms / 1000.0;
    let clip_duration = segment.audio_clip_duration_ms / 1000.0;
    let mut factors = vec![format!("{:.6}", segment.volume)];
    if segment.audio_fade_in_ms > 0.0 {
        let duration = segment.audio_fade_in_ms / 1000.0;
        factors.push(format!("min(1,max(0,(t+{offset:.6})/{duration:.6}))"));
    }
    if segment.audio_fade_out_ms > 0.0 {
        let duration = segment.audio_fade_out_ms / 1000.0;
        factors.push(format!(
            "min(1,max(0,({clip_duration:.6}-{offset:.6}-t)/{duration:.6}))"
        ));
    }
    format!("volume='{}':eval=frame", factors.join("*"))
}

/// Enveloppe appliquée au clip source complet, avant d'en extraire le tronçon
/// visible. Les temps restent ainsi positifs, y compris lorsqu'une piste
/// supérieure a masqué le début du clip.
fn video_fade_filter(segment: &ExportSegment) -> String {
    let clip_duration = segment.video_clip_duration_ms / 1000.0;
    let mut filters: Vec<String> = Vec::new();
    if segment.video_fade_in_ms > 0.0 {
        let duration = segment.video_fade_in_ms / 1000.0;
        filters.push(format!("fade=t=in:st=0:d={duration:.6}:color=black"));
    }
    if segment.video_fade_out_ms > 0.0 {
        let duration = segment.video_fade_out_ms / 1000.0;
        let start = clip_duration - duration;
        filters.push(format!(
            "fade=t=out:st={start:.6}:d={duration:.6}:color=black"
        ));
    }
    filters.join(",")
}

#[derive(Serialize, Clone)]
struct ImportProgress {
    stage: &'static str,
    percent: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    percent: f64,
    done: bool,
    output_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSegment {
    /// Index du rush dans `ExportRequest.sources`.
    #[serde(default)]
    pub source_index: usize,
    pub src_in_ms: f64,
    pub src_out_ms: f64,
    /// Vitesse constante du segment (1 = temps réel).
    #[serde(default = "default_rate")]
    pub playback_rate: f64,
    /// Gain sonore (1 = niveau original, 0 = silence).
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default)]
    pub audio_fade_in_ms: f64,
    #[serde(default)]
    pub audio_fade_out_ms: f64,
    #[serde(default)]
    pub audio_fade_offset_ms: f64,
    #[serde(default)]
    pub audio_clip_duration_ms: f64,
    #[serde(default)]
    pub video_fade_in_ms: f64,
    #[serde(default)]
    pub video_fade_out_ms: f64,
    #[serde(default)]
    pub video_fade_offset_ms: f64,
    #[serde(default)]
    pub video_clip_duration_ms: f64,
    /// Durée de noir silencieux à insérer AVANT ce segment (trou de la timeline).
    #[serde(default)]
    pub gap_before_ms: f64,
    /// Décalage horizontal du cadrage 9:16, de −1 à +1 (0 = centré).
    #[serde(default)]
    pub crop_x: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSource {
    pub path: String,
    pub has_audio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTextOverlay {
    pub text: String,
    pub timeline_start_ms: f64,
    pub timeline_end_ms: f64,
    pub x: f64,
    pub y: f64,
    pub font_size_px: f64,
    pub style: String,
    #[serde(default)]
    pub fade_in_ms: f64,
    #[serde(default)]
    pub fade_out_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub sources: Vec<ExportSource>,
    /// Plan vidéo : ce qui se voit.
    pub segments: Vec<ExportSegment>,
    /// Plan audio : ce qui s'entend. Indépendant du plan vidéo, pour qu'une
    /// surcouche muette laisse passer le son de la piste du dessous.
    #[serde(default)]
    pub audio_segments: Vec<ExportSegment>,
    #[serde(default)]
    pub text_overlays: Vec<ExportTextOverlay>,
    pub mode: String,
    pub file_name: String,
    /// Vrai si au moins un rush a du son : les autres reçoivent du silence.
    pub has_audio: bool,
    /// Cadence de sortie. La définition, elle, est imposée : c'est le format
    /// vertical `OUT_WIDTH`×`OUT_HEIGHT`, auquel chaque segment est ramené
    /// individuellement — c'est ce qui rend les flux homogènes pour `concat`.
    pub frame_fps: f64,
}

// --- Chemins -----------------------------------------------------------------

pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Dossier de données introuvable : {e}"))?;
    fs::create_dir_all(&root).map_err(|e| format!("Création du dossier de données impossible : {e}"))?;
    Ok(root)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Création de dossier impossible ({}) : {e}", path.display()))
}

// --- Utilitaires process -------------------------------------------------------

fn base_command(tool: MediaTool) -> Command {
    let command = Command::new(media_tools::path(tool));
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut c = command;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    command
}

fn missing_tool_error(tool: &str) -> String {
    format!("{tool} est introuvable. Installe FFmpeg et vérifie qu'il est dans le PATH.")
}

fn str_args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

fn video_encoder_args(encoder: VideoEncoder, cpu_preset: &str, quality: u8) -> Vec<String> {
    match encoder {
        VideoEncoder::H264Nvenc => vec![
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p4".into(),
            "-tune".into(),
            "hq".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            quality.to_string(),
            "-b:v".into(),
            "0".into(),
        ],
        VideoEncoder::Libx264 => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            cpu_preset.into(),
            "-crf".into(),
            quality.to_string(),
        ],
    }
}

/// Parse "HH:MM:SS.micro" en millisecondes.
fn parse_ffmpeg_time(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let minutes: f64 = parts[1].parse().ok()?;
    let seconds: f64 = parts[2].parse().ok()?;
    Some(((hours * 60.0 + minutes) * 60.0 + seconds) * 1000.0)
}

/// Lance ffmpeg avec `-progress pipe:1` et remonte l'avancement via `on_progress`.
fn run_ffmpeg_with_progress(
    args: &[String],
    total_ms: f64,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    let mut child = base_command(MediaTool::Ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| missing_tool_error("FFmpeg"))?;

    let stdout = child.stdout.take().ok_or("Sortie FFmpeg indisponible")?;
    let stderr = child.stderr.take();

    // Capture de la fin de stderr pour un diagnostic utile en cas d'échec.
    let stderr_handle = std::thread::spawn(move || {
        let mut tail = String::new();
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > 4000 {
                    tail = tail[tail.len() - 2000..].to_string();
                }
            }
        }
        tail
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(value) = line.strip_prefix("out_time=") {
            if let Some(out_ms) = parse_ffmpeg_time(value) {
                if total_ms > 0.0 {
                    on_progress((out_ms / total_ms * 100.0).clamp(0.0, 99.9));
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("FFmpeg : {e}"))?;
    let tail = stderr_handle.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("FFmpeg a échoué :\n{}", tail.trim()));
    }
    Ok(())
}

// --- Empreinte -----------------------------------------------------------------

/// Empreinte rapide : taille + premier et dernier blocs de 4 Mo.
/// Suffisant comme clé de cache locale (la source est immuable), et
/// instantané même sur un rush de plusieurs Go.
fn quick_fingerprint(path: &Path) -> Result<String, String> {
    const BLOCK: usize = 4 * 1024 * 1024;
    let mut file = fs::File::open(path).map_err(|e| format!("Lecture du fichier impossible : {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Métadonnées illisibles : {e}"))?
        .len();

    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    let mut buffer = vec![0u8; BLOCK];
    let read = file.read(&mut buffer).map_err(|e| format!("Lecture : {e}"))?;
    hasher.update(&buffer[..read]);

    if size > (BLOCK as u64) * 2 {
        file.seek(SeekFrom::End(-(BLOCK as i64)))
            .map_err(|e| format!("Lecture : {e}"))?;
        let read = file.read(&mut buffer).map_err(|e| format!("Lecture : {e}"))?;
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(hex[..16].to_string())
}

// --- Probe -----------------------------------------------------------------------

fn probe_file(path: &Path) -> Result<ProbeInfo, String> {
    let output = base_command(MediaTool::Ffprobe)
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|_| missing_tool_error("FFprobe"))?;

    if !output.status.success() {
        return Err(format!(
            "FFprobe n'a pas pu lire ce fichier : {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Réponse FFprobe illisible : {e}"))?;

    let duration_s: f64 = parsed["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .ok_or("Durée introuvable dans le fichier.")?;

    let streams = parsed["streams"].as_array().ok_or("Aucun flux détecté.")?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("Aucune piste vidéo détectée dans ce fichier.")?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    let fps = video["avg_frame_rate"]
        .as_str()
        .or_else(|| video["r_frame_rate"].as_str())
        .and_then(parse_frame_rate)
        .unwrap_or(30.0);

    Ok(ProbeInfo {
        duration_ms: duration_s * 1000.0,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
        has_audio,
        video_codec: video["codec_name"].as_str().unwrap_or("inconnu").to_string(),
    })
}

fn parse_frame_rate(value: &str) -> Option<f64> {
    let mut parts = value.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = parts.next().unwrap_or("1").parse().ok()?;
    if den == 0.0 || num <= 0.0 {
        None
    } else {
        Some(num / den)
    }
}

// --- Import ------------------------------------------------------------------------

#[tauri::command]
pub async fn import_source(app: AppHandle, path: String) -> Result<SourceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || import_source_blocking(&app, &path))
        .await
        .map_err(|e| format!("Tâche interrompue : {e}"))?
}

fn emit_import(app: &AppHandle, stage: &'static str, percent: f64) {
    let _ = app.emit("import://progress", ImportProgress { stage, percent });
}

fn import_source_blocking(app: &AppHandle, path: &str) -> Result<SourceInfo, String> {
    let source = PathBuf::from(path);
    if !source.is_file() {
        return Err("Ce fichier n'existe pas ou n'est pas accessible.".into());
    }
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Format non pris en charge (.{extension}). Formats acceptés : mp4, mov, mkv, m4v."
        ));
    }

    let root = data_root(app)?;

    emit_import(app, "hash", 5.0);
    let id = quick_fingerprint(&source)?;

    emit_import(app, "probe", 10.0);
    let probe = probe_file(&source)?;

    // 1) Proxy de montage (réutilisé s'il existe déjà pour cette source).
    let proxies_dir = root.join("proxies");
    ensure_dir(&proxies_dir)?;
    let proxy_path = proxies_dir.join(format!("{id}.mp4"));
    if !proxy_path.is_file() {
        let partial = proxies_dir.join(format!("{id}.partial.mp4"));
        let _ = fs::remove_file(&partial);
        let mut args: Vec<String> = str_args(&[
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        ]);
        args.push("-i".into());
        args.push(source.to_str().ok_or("Chemin source invalide.")?.into());
        args.extend(str_args(&["-map", "0:v:0", "-map", "0:a:0?", "-vf"]));
        args.push(format!("scale=-2:{PROXY_HEIGHT}"));
        let encoder = hardware::selected_encoder();
        let encoder_start = args.len();
        args.extend(video_encoder_args(encoder, "veryfast", 23));
        let encoder_end = args.len();
        args.push("-g".into());
        args.push(PROXY_GOP.to_string());
        args.push("-keyint_min".into());
        args.push(PROXY_GOP.to_string());
        args.extend(str_args(&[
            "-sc_threshold", "0",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
        ]));
        args.push(partial.to_str().ok_or("Chemin proxy invalide.")?.into());

        let first_result = run_ffmpeg_with_progress(&args, probe.duration_ms, |p| {
            emit_import(app, "proxy", 10.0 + p * 0.6);
        });
        if let Err(nvenc_error) = first_result {
            if encoder != VideoEncoder::H264Nvenc {
                return Err(nvenc_error);
            }
            let _ = fs::remove_file(&partial);
            hardware::disable_nvenc(
                "NVENC a échoué pendant la création d'un proxy ; repli CPU pour cette session.",
            );
            let mut cpu_args = args.clone();
            cpu_args.splice(
                encoder_start..encoder_end,
                video_encoder_args(VideoEncoder::Libx264, "veryfast", 23),
            );
            run_ffmpeg_with_progress(&cpu_args, probe.duration_ms, |p| {
                emit_import(app, "proxy", 10.0 + p * 0.6);
            })
            .map_err(|cpu_error| {
                format!(
                    "NVENC puis l'encodage CPU ont échoué.\nNVENC : {nvenc_error}\nCPU : {cpu_error}"
                )
            })?;
        }
        fs::rename(&partial, &proxy_path).map_err(|e| format!("Finalisation du proxy impossible : {e}"))?;
    }
    emit_import(app, "thumbs", 72.0);

    // 2) Vignettes, générées depuis le proxy.
    // La largeur d'un créneau de pellicule vaut hauteur_de_bande × ratio du rush ;
    // en échantillonnant à ce rythme au zoom maximal, deux créneaux voisins ne
    // peuvent jamais afficher la même image.
    let aspect = (probe.width as f64 / probe.height.max(1) as f64).clamp(0.5, 3.0);
    let slot_px = (THUMB_STRIP_PX * aspect).round();
    let thumb_interval_s = (slot_px / MAX_PX_PER_SEC)
        .max(probe.duration_ms / 1000.0 / MAX_THUMBS)
        .clamp(0.25, 8.0);
    let thumb_height = (THUMB_STRIP_PX * THUMB_SCALE).round() as u32;

    let thumbs_dir = root.join("thumbs").join(format!("{id}-v{THUMB_VERSION}"));
    let thumb_paths = if thumbs_dir.is_dir() && count_jpgs(&thumbs_dir) > 0 {
        list_jpgs(&thumbs_dir)
    } else {
        ensure_dir(&thumbs_dir)?;
        let pattern = thumbs_dir.join("%05d.jpg");
        let mut args: Vec<String> = str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
        args.push("-i".into());
        args.push(proxy_path.to_str().ok_or("Chemin proxy invalide.")?.into());
        args.extend(str_args(&["-an", "-sn"]));
        args.push("-vf".into());
        // fps en débit décimal (et non 1/x) pour ne pas dépendre de l'évaluateur
        // de fractions. -2 : largeur déduite du ratio, arrondie au pair.
        // lanczos : la réduction 720 → 244 en bicubique est molle.
        args.push(format!(
            "fps={:.6},scale=-2:{thumb_height}:flags=lanczos",
            1.0 / thumb_interval_s
        ));
        args.extend(str_args(&["-q:v", "4", "-progress", "pipe:1", "-nostats"]));
        args.push(pattern.to_str().ok_or("Chemin vignettes invalide.")?.into());
        run_ffmpeg_with_progress(&args, probe.duration_ms, |p| {
            emit_import(app, "thumbs", 72.0 + p * 0.18);
        })?;
        list_jpgs(&thumbs_dir)
    };

    // 3) Waveform du rush complet (image unique, si piste audio).
    emit_import(app, "waveform", 92.0);
    let waveform_path = if probe.has_audio {
        let waveforms_dir = root.join("waveforms");
        ensure_dir(&waveforms_dir)?;
        let waveform = waveforms_dir.join(format!("{id}-w{WAVEFORM_VERSION}.png"));
        if !waveform.is_file() {
            let width = ((probe.duration_ms / 1000.0 * 30.0) as u32).clamp(900, 24000);
            let mut args: Vec<String> = str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
            args.push("-i".into());
            args.push(proxy_path.to_str().ok_or("Chemin proxy invalide.")?.into());
            args.push("-filter_complex".into());
            // scale=sqrt : sans ça, un gameplay à niveau moyen donne un trait plat
            // et illisible une fois la waveform écrasée dans 28 px de haut.
            args.push(format!(
                "aformat=channel_layouts=mono,showwavespic=s={width}x120:colors=#7aa4ff:scale=sqrt"
            ));
            args.extend(str_args(&["-frames:v", "1"]));
            args.push(waveform.to_str().ok_or("Chemin waveform invalide.")?.into());
            // Pas de suivi de progression nécessaire : c'est très rapide.
            run_ffmpeg_with_progress(&args, 0.0, |_| {})?;
        }
        Some(waveform.to_string_lossy().to_string())
    } else {
        None
    };

    emit_import(app, "done", 100.0);
    Ok(SourceInfo {
        id,
        original_path: source.to_string_lossy().to_string(),
        proxy_path: proxy_path.to_string_lossy().to_string(),
        thumb_paths,
        thumb_interval_ms: thumb_interval_s * 1000.0,
        waveform_path,
        asset_version: ASSET_VERSION,
        probe,
    })
}

fn count_jpgs(dir: &Path) -> usize {
    list_jpgs(dir).len()
}

fn list_jpgs(dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jpg"))
                .map(|p| p.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

// --- Export ---------------------------------------------------------------------------

#[tauri::command]
pub async fn export_timeline(app: AppHandle, request: ExportRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_timeline_blocking(&app, &request))
        .await
        .map_err(|e| format!("Tâche interrompue : {e}"))?
}

fn export_timeline_blocking(app: &AppHandle, request: &ExportRequest) -> Result<String, String> {
    // Validation stricte des entrées avant toute construction de commande.
    if request.segments.is_empty() {
        return Err("Aucun clip à exporter.".into());
    }
    if request.segments.len() > MAX_SEGMENTS {
        return Err(format!("Trop de clips ({MAX_SEGMENTS} maximum)."));
    }
    if request.sources.is_empty() {
        return Err("Aucun rush à exporter.".into());
    }
    if request.sources.len() > MAX_SOURCES {
        return Err(format!("Trop de rushs ({MAX_SOURCES} maximum)."));
    }
    // Les DEUX plans sont validés : le plan audio finit lui aussi dans le graphe
    // FFmpeg, le laisser passer sans contrôle reviendrait à faire confiance à
    // l'appelant pour construire une commande.
    validate_segments(&request.segments, request.sources.len())?;
    validate_segments(&request.audio_segments, request.sources.len())?;
    if !request.frame_fps.is_finite() || request.frame_fps <= 0.0 || request.frame_fps > 480.0 {
        return Err("Cadence de sortie invalide.".into());
    }
    if request.mode != "crop" && request.mode != "blur" {
        return Err("Mode d'export inconnu.".into());
    }
    let name_ok = !request.file_name.is_empty()
        && request.file_name.len() <= 60
        && request
            .file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-');
    if !name_ok {
        return Err("Nom de fichier invalide (lettres, chiffres, espaces, - et _ uniquement).".into());
    }
    for source in &request.sources {
        if !PathBuf::from(&source.path).is_file() {
            return Err(format!(
                "Rush introuvable, a-t-il été déplacé ? {}",
                source.path
            ));
        }
    }

    let exports_dir = data_root(app)?.join("exports");
    ensure_dir(&exports_dir)?;
    let mut output = exports_dir.join(format!("{}.mp4", request.file_name.trim()));
    let mut counter = 2;
    while output.exists() {
        output = exports_dir.join(format!("{} ({counter}).mp4", request.file_name.trim()));
        counter += 1;
    }

    // Graphe de filtres : chaque trou devient du noir silencieux, chaque clip un
    // trim du rush ; on concatène le tout, puis on passe en 9:16.
    // Les entrées lavfi (noir, silence) ne sont ajoutées que si un trou existe.
    // Les deux plans sont assemblés séparément puis mappés ensemble : l'image
    // vient du plan vidéo, le son du plan audio.
    let timeline_ms = |s: &ExportSegment| (s.src_out_ms - s.src_in_ms) / s.playback_rate + s.gap_before_ms;
    let total_video_ms: f64 = request.segments.iter().map(timeline_ms).sum();
    let total_audio_ms: f64 = request.audio_segments.iter().map(timeline_ms).sum();
    validate_text_overlays(&request.text_overlays, total_video_ms)?;

    let (regular_font, bold_font) = if request.text_overlays.is_empty() {
        (PathBuf::new(), PathBuf::new())
    } else {
        let windows_dir = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .ok_or_else(|| "Dossier des polices Windows introuvable.".to_string())?;
        let regular = windows_dir.join("Fonts").join("segoeui.ttf");
        let bold = windows_dir.join("Fonts").join("segoeuib.ttf");
        if !regular.is_file() || !bold.is_file() {
            return Err("Police Segoe UI introuvable : impossible de rendre les titres.".into());
        }
        (regular, bold)
    };

    let mut temporary_text_files = TemporaryTextFiles(Vec::new());
    for (index, overlay) in request.text_overlays.iter().enumerate() {
        let path = exports_dir.join(format!(
            ".title-{}-{index}.txt",
            std::process::id()
        ));
        fs::write(&path, overlay.text.as_bytes())
            .map_err(|e| format!("Écriture du titre temporaire impossible : {e}"))?;
        temporary_text_files.0.push(path);
    }
    // Le son doit couvrir toute la durée de l'image : on complète au silence.
    let audio_tail_ms = (total_video_ms - total_audio_ms).max(0.0);

    // Le noir dépend du plan VIDÉO, le silence du plan AUDIO. Les confondre
    // faisait référencer une entrée `anullsrc` jamais ajoutée à la commande dès
    // qu'on coupait le son d'un clip au milieu d'une image continue : FFmpeg
    // échouait alors sur « Invalid file index ».
    let has_gap = request.segments.iter().any(|s| s.gap_before_ms > 0.0);
    let needs_silence = needs_silence_input(
        request.has_audio,
        &request.audio_segments,
        audio_tail_ms,
        &request.sources,
    );

    // Les rushs occupent les entrées 0..n ; les sources synthétiques (noir,
    // silence) viennent juste après, dans cet ordre.
    let n_sources = request.sources.len();
    let black_input = n_sources;
    let silence_input = n_sources + if has_gap { 1 } else { 0 };

    // `concat` exige des flux homogènes : même définition, même format de pixel,
    // même SAR, même format audio. Chaque segment est donc amené AU FORMAT DE
    // SORTIE avant d'être concaténé, cadrage compris : le décalage de cadrage
    // appartient au clip, il ne peut pas s'appliquer après l'assemblage.
    // `fps` en fin de chaîne : indispensable dès qu'un segment est accéléré ou
    // qu'un rush a une autre cadence. Sans lui, chaque branche sort avec sa
    // propre cadence et la durée d'un segment accéléré dérive de quelques
    // images ; avec lui, elle vaut exactement durée_timeline × cadence.
    let ffps = request.frame_fps;
    let vtail = format!("setsar=1,format=yuv420p,fps={ffps:.6}");
    const AFMT: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
    let mut graph = String::new();

    // --- Branche vidéo : uniquement le plan vidéo -------------------------------
    let mut parts: Vec<usize> = Vec::new();
    let mut next_label = 0usize;
    for segment in &request.segments {
        if segment.gap_before_ms > 0.0 {
            let duration = segment.gap_before_ms / 1000.0;
            let i = next_label;
            // Le noir est déjà produit au format de sortie : rien à cadrer.
            graph += &format!(
                "[{black_input}:v]trim=duration={duration:.3},setpts=PTS-STARTPTS,{vtail}[v{i}];"
            );
            parts.push(i);
            next_label += 1;
        }
        let start = segment.src_in_ms / 1000.0;
        let end = segment.src_out_ms / 1000.0;
        let input = segment.source_index;
        let rate = segment.playback_rate;
        let i = next_label;
        // setpts=PTS/rate : accélérer revient à rapprocher les horodatages.
        let fade_filter = video_fade_filter(segment);
        if fade_filter.is_empty() {
            graph += &format!(
                "[{input}:v]trim=start={start:.3}:end={end:.3},\
                 setpts=(PTS-STARTPTS)/{rate:.6}[raw{i}];"
            );
        } else {
            let offset = segment.video_fade_offset_ms / 1000.0;
            let duration = (segment.src_out_ms - segment.src_in_ms) / rate / 1000.0;
            let clip_start =
                (segment.src_in_ms - segment.video_fade_offset_ms * rate) / 1000.0;
            let clip_end = clip_start + segment.video_clip_duration_ms * rate / 1000.0;
            let extract_end = offset + duration;
            graph += &format!(
                "[{input}:v]trim=start={clip_start:.6}:end={clip_end:.6},\
                 setpts=(PTS-STARTPTS)/{rate:.6},{fade_filter},\
                 trim=start={offset:.6}:end={extract_end:.6},\
                 setpts=PTS-STARTPTS[raw{i}];"
            );
        }
        graph += &framing_chain(&request.mode, segment.crop_x, i, &vtail);
        parts.push(i);
        next_label += 1;
    }

    // --- Branche audio : uniquement le plan audio -------------------------------
    let mut audio_parts: Vec<usize> = Vec::new();
    let mut next_audio = 0usize;
    if request.has_audio {
        let push_silence = |graph: &mut String, duration: f64, index: &mut usize| {
            let i = *index;
            graph.push_str(&format!(
                "[{silence_input}:a]atrim=duration={duration:.3},asetpts=PTS-STARTPTS,{AFMT}[a{i}];"
            ));
            *index += 1;
            i
        };
        for segment in &request.audio_segments {
            if segment.gap_before_ms > 0.0 {
                audio_parts.push(push_silence(&mut graph, segment.gap_before_ms / 1000.0, &mut next_audio));
            }
            let start = segment.src_in_ms / 1000.0;
            let end = segment.src_out_ms / 1000.0;
            let input = segment.source_index;
            if request.sources[input].has_audio {
                let i = next_audio;
                let tempo = atempo_chain(segment.playback_rate);
                let volume = audio_volume_filter(segment);
                graph += &format!(
                    "[{input}:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo},{volume},{AFMT}[a{i}];"
                );
                audio_parts.push(i);
                next_audio += 1;
            } else {
                // Rush muet : le silence est déjà à la bonne durée de timeline.
                let duration = (segment.src_out_ms - segment.src_in_ms) / segment.playback_rate / 1000.0;
                audio_parts.push(push_silence(&mut graph, duration, &mut next_audio));
            }
        }
        // Le plan audio peut s'arrêter avant l'image : on complète au silence.
        if audio_tail_ms > 1.0 {
            audio_parts.push(push_silence(&mut graph, audio_tail_ms / 1000.0, &mut next_audio));
        }
    }

    let n = parts.len();
    if n > MAX_SEGMENTS {
        return Err(format!("Trop de segments à assembler ({MAX_SEGMENTS} maximum)."));
    }
    for i in &parts {
        graph += &format!("[v{i}]");
    }
    // Les segments sont déjà cadrés et normalisés : la concaténation produit
    // directement l'image finale.
    graph += &format!("concat=n={n}:v=1:a=0[vbase];");

    let mut video_output_label = "vbase".to_string();
    for (index, overlay) in request.text_overlays.iter().enumerate() {
        let next_label = format!("vtext{index}");
        let font = if overlay.style == "impact" {
            &bold_font
        } else {
            &regular_font
        };
        graph += &format!(
            "[{video_output_label}]{}[{next_label}];",
            drawtext_filter(overlay, &temporary_text_files.0[index], font),
        );
        video_output_label = next_label;
    }

    if request.has_audio {
        let m = audio_parts.len();
        if m > MAX_SEGMENTS {
            return Err(format!("Trop de segments sonores ({MAX_SEGMENTS} maximum)."));
        }
        for i in &audio_parts {
            graph += &format!("[a{i}]");
        }
        graph += &format!("concat=n={m}:v=0:a=1[ac];");
    }
    // Un point-virgule final ferait échouer FFmpeg sur une chaîne de filtres vide.
    while graph.ends_with(';') {
        graph.pop();
    }

    let total_ms = total_video_ms;

    let partial = exports_dir.join(format!(".partial-{}.mp4", std::process::id()));
    let _ = fs::remove_file(&partial);

    let mut args: Vec<String> = str_args(&[
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ]);
    // Les rushs d'abord, dans l'ordre exact référencé par les segments.
    for source in &request.sources {
        args.extend(["-i".into(), source.path.clone()]);
    }
    if has_gap {
        let fps = request.frame_fps;
        args.extend([
            "-f".into(), "lavfi".into(),
            "-i".into(),
            format!("color=c=black:s={OUT_WIDTH}x{OUT_HEIGHT}:r={fps:.3}"),
        ]);
    }
    if needs_silence {
        args.extend([
            "-f".into(), "lavfi".into(),
            "-i".into(), "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        ]);
    }
    args.extend([
        "-filter_complex".into(), graph,
        "-map".into(), format!("[{video_output_label}]"),
    ]);
    if request.has_audio {
        args.extend(["-map".into(), "[ac]".into()]);
    }
    let encoder = hardware::selected_encoder();
    let encoder_start = args.len();
    args.extend(video_encoder_args(encoder, "fast", 19));
    let encoder_end = args.len();
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    if request.has_audio {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend([
        "-movflags".into(), "+faststart".into(),
        "-f".into(), "mp4".into(),
        "-progress".into(), "pipe:1".into(), "-nostats".into(),
        partial.to_string_lossy().to_string(),
    ]);

    let emit = |percent: f64, done: bool, output_path: Option<String>| {
        let _ = app.emit("export://progress", ExportProgress { percent, done, output_path });
    };

    emit(0.0, false, None);
    let first_result = run_ffmpeg_with_progress(&args, total_ms, |p| emit(p, false, None));
    if let Err(nvenc_error) = first_result {
        let _ = fs::remove_file(&partial);
        if encoder != VideoEncoder::H264Nvenc {
            return Err(nvenc_error);
        }
        hardware::disable_nvenc("NVENC a échoué pendant un export ; repli CPU pour cette session.");
        let mut cpu_args = args.clone();
        cpu_args.splice(
            encoder_start..encoder_end,
            video_encoder_args(VideoEncoder::Libx264, "fast", 19),
        );
        emit(0.0, false, None);
        run_ffmpeg_with_progress(&cpu_args, total_ms, |p| emit(p, false, None)).map_err(
            |cpu_error| {
                let _ = fs::remove_file(&partial);
                format!(
                    "NVENC puis l'encodage CPU ont échoué.\nNVENC : {nvenc_error}\nCPU : {cpu_error}"
                )
            },
        )?;
    }

    fs::rename(&partial, &output).map_err(|e| format!("Finalisation de l'export impossible : {e}"))?;
    let output_str = output.to_string_lossy().to_string();
    emit(100.0, true, Some(output_str.clone()));
    Ok(output_str)
}

// --- Divers -------------------------------------------------------------------------------

#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = if target.is_dir() {
        target
    } else {
        target.parent().map(Path::to_path_buf).ok_or("Chemin invalide.")?
    };
    app.shell()
        .open(dir.to_string_lossy().to_string(), None)
        .map_err(|e| format!("Ouverture du dossier impossible : {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(gap_before_ms: f64) -> ExportSegment {
        ExportSegment {
            source_index: 0,
            src_in_ms: 0.0,
            src_out_ms: 1000.0,
            playback_rate: 1.0,
            volume: 1.0,
            audio_fade_in_ms: 0.0,
            audio_fade_out_ms: 0.0,
            audio_fade_offset_ms: 0.0,
            audio_clip_duration_ms: 1000.0,
            video_fade_in_ms: 0.0,
            video_fade_out_ms: 0.0,
            video_fade_offset_ms: 0.0,
            video_clip_duration_ms: 1000.0,
            crop_x: 0.0,
            gap_before_ms,
        }
    }

    fn sonore() -> Vec<ExportSource> {
        vec![ExportSource { path: "a.mp4".into(), has_audio: true }]
    }

    fn titre() -> ExportTextOverlay {
        ExportTextOverlay {
            text: "Titre éà\nDeuxième ligne".into(),
            timeline_start_ms: 500.0,
            timeline_end_ms: 2500.0,
            x: 0.5,
            y: 0.72,
            font_size_px: 88.0,
            style: "impact".into(),
            fade_in_ms: 0.0,
            fade_out_ms: 0.0,
        }
    }

    /// Le cas qui cassait l'export : image continue, son coupé au milieu, tous
    /// les rushs sonores. Le plan audio a besoin de silence alors que le plan
    /// vidéo n'a aucun trou — décider d'après la vidéo faisait référencer une
    /// entrée FFmpeg jamais ajoutée.
    #[test]
    fn le_silence_est_decide_par_le_plan_audio() {
        assert!(
            needs_silence_input(true, &[segment(0.0)], 10_000.0, &sonore()),
            "un plan audio plus court que l'image réclame du silence"
        );
        assert!(
            needs_silence_input(true, &[segment(2_000.0)], 0.0, &sonore()),
            "un trou au milieu du plan audio réclame du silence"
        );
    }

    #[test]
    fn un_rush_muet_reclame_du_silence() {
        let muet = vec![ExportSource { path: "b.mp4".into(), has_audio: false }];
        assert!(needs_silence_input(true, &[segment(0.0)], 0.0, &muet));
    }

    #[test]
    fn un_montage_plein_et_sonore_ne_reclame_rien() {
        assert!(!needs_silence_input(true, &[segment(0.0)], 0.0, &sonore()));
        assert!(
            !needs_silence_input(false, &[segment(5_000.0)], 9_000.0, &sonore()),
            "un montage muet n'a pas de branche audio du tout"
        );
    }

    #[test]
    fn les_deux_plans_sont_validés() {
        assert!(validate_segments(&[segment(0.0)], 1).is_ok());

        let hors_bornes = ExportSegment { playback_rate: 12.0, ..segment(0.0) };
        assert!(validate_segments(&[hors_bornes], 1).is_err(), "vitesse aberrante refusée");

        let volume_hors_bornes = ExportSegment { volume: 1.01, ..segment(0.0) };
        assert!(
            validate_segments(&[volume_hors_bornes], 1).is_err(),
            "volume supérieur au niveau original refusé"
        );

        let fondu_hors_bornes = ExportSegment {
            audio_fade_in_ms: 600.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[fondu_hors_bornes], 1).is_err(),
            "un fondu supérieur à la moitié du clip est refusé"
        );
        let fondu_video_hors_bornes = ExportSegment {
            video_fade_out_ms: 600.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[fondu_video_hors_bornes], 1).is_err(),
            "un fondu vidéo supérieur à la moitié du clip est refusé"
        );

        let rush_inconnu = ExportSegment { source_index: 7, ..segment(0.0) };
        assert!(validate_segments(&[rush_inconnu], 1).is_err(), "rush inexistant refusé");

        let bornes_folles = ExportSegment { src_out_ms: 0.0, ..segment(0.0) };
        assert!(validate_segments(&[bornes_folles], 1).is_err(), "durée nulle refusée");
    }

    #[test]
    fn un_fondu_video_reprend_apres_une_interruption() {
        let interrupted = ExportSegment {
            src_in_ms: 700.0,
            src_out_ms: 1000.0,
            video_fade_in_ms: 1000.0,
            video_fade_offset_ms: 700.0,
            video_clip_duration_ms: 10_000.0,
            ..segment(0.0)
        };
        assert_eq!(
            video_fade_filter(&interrupted),
            "fade=t=in:st=0:d=1.000000:color=black"
        );

        let exit = ExportSegment {
            src_in_ms: 8500.0,
            src_out_ms: 10_000.0,
            video_fade_out_ms: 2000.0,
            video_fade_offset_ms: 8500.0,
            video_clip_duration_ms: 10_000.0,
            ..segment(0.0)
        };
        assert_eq!(
            video_fade_filter(&exit),
            "fade=t=out:st=8.000000:d=2.000000:color=black"
        );
    }

    #[test]
    fn les_titres_sont_valides_et_bornes() {
        assert!(validate_text_overlays(&[titre()], 3000.0).is_ok());
        let trop_tard = ExportTextOverlay {
            timeline_end_ms: 3001.0,
            ..titre()
        };
        assert!(validate_text_overlays(&[trop_tard], 3000.0).is_err());
        let style_inconnu = ExportTextOverlay {
            style: "arc-en-ciel".into(),
            ..titre()
        };
        assert!(validate_text_overlays(&[style_inconnu], 3000.0).is_err());
        let fondu_trop_long = ExportTextOverlay {
            fade_in_ms: 1100.0,
            ..titre()
        };
        assert!(validate_text_overlays(&[fondu_trop_long], 3000.0).is_err());
    }

    #[test]
    fn le_filtre_titre_echappe_les_chemins_windows() {
        let filter = drawtext_filter(
            &titre(),
            Path::new(r"C:\Temp\mon titre.txt"),
            Path::new(r"C:\Windows\Fonts\segoeuib.ttf"),
        );
        assert!(filter.contains("textfile='C\\:/Temp/mon titre.txt'"));
        assert!(filter.contains("fontfile='C\\:/Windows/Fonts/segoeuib.ttf'"));
        assert!(filter.contains("text_align=C"));
        assert!(filter.contains("alpha='1'"));
        assert!(filter.contains("enable='between(t,0.500000,2.500000)'"));
    }

    #[test]
    fn le_filtre_titre_conserve_ses_fondus_absolus() {
        let overlay = ExportTextOverlay {
            fade_in_ms: 500.0,
            fade_out_ms: 250.0,
            ..titre()
        };
        let filter = drawtext_filter(
            &overlay,
            Path::new(r"C:\Temp\titre.txt"),
            Path::new(r"C:\Windows\Fonts\segoeuib.ttf"),
        );
        assert!(filter.contains(
            "alpha='min(1,max(0,(t-0.500000)/0.500000))*min(1,max(0,(2.500000-t)/0.250000))'"
        ));
    }

    #[test]
    fn la_chaine_atempo_couvre_les_bornes() {
        assert_eq!(atempo_chain(1.0), "anull");
        assert_eq!(atempo_chain(2.0), "atempo=2.000000");
        assert_eq!(atempo_chain(4.0), "atempo=2.000000,atempo=2.000000");
        assert_eq!(atempo_chain(0.25), "atempo=0.500000,atempo=0.500000");
    }

    #[test]
    fn le_filtre_volume_conserve_lenveloppe_du_clip_source() {
        let segment = ExportSegment {
            volume: 0.8,
            audio_fade_in_ms: 1000.0,
            audio_fade_out_ms: 2000.0,
            audio_fade_offset_ms: 500.0,
            audio_clip_duration_ms: 5000.0,
            ..segment(0.0)
        };
        assert_eq!(
            audio_volume_filter(&segment),
            "volume='0.800000*min(1,max(0,(t+0.500000)/1.000000))*min(1,max(0,(5.000000-0.500000-t)/2.000000))':eval=frame"
        );
    }
}
