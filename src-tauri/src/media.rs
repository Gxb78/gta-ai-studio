// Préparation des médias et export final.
// Règles : commandes FFmpeg construites uniquement depuis des valeurs typées
// et validées (jamais de shell libre), écritures via fichier temporaire puis
// renommage, sources d'origine jamais modifiées.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
///
/// Le proxy en a besoin comme les deux autres : sans elle, changer
/// `PROXY_HEIGHT`/`PROXY_GOP`/l'encodeur ne régénérait JAMAIS le proxy déjà en
/// cache (clé purement par empreinte de contenu) — seuls thumbs/waveform se
/// refaisaient, et l'import réécrivait quand même `asset_version:
/// ASSET_VERSION` dans le projet, faisant croire à l'interface que le proxy
/// était à jour alors qu'il datait des anciens paramètres.
const PROXY_VERSION: u32 = 1;
const THUMB_VERSION: u32 = 3;
const WAVEFORM_VERSION: u32 = 1;
const MAX_SEGMENTS: usize = 500;
const MAX_TEXT_OVERLAYS: usize = 64;
const MAX_TEXT_LENGTH: usize = 200;
/// Contrairement aux segments et aux titres, `zoompan_filter` imbrique un
/// `if(...)` de plus par zoom dans la MÊME expression `z`/`x`/`y` — la taille
/// et la profondeur d'imbrication croissent avec le nombre de zooms, sans
/// borne jusqu'ici. Un montage à plusieurs milliers de zooms produirait une
/// expression pathologique, coûteuse à parser et à évaluer image par image.
const MAX_ZOOMS: usize = 300;
/// Un rush = une entrée FFmpeg ouverte simultanément. Au-delà, on sature les
/// descripteurs de fichiers et la mémoire du décodeur.
const MAX_SOURCES: usize = 32;

/// Message d'erreur distinct de tout message FFmpeg réel : l'interface le
/// reconnaît pour ne jamais l'afficher comme un échec, juste comme une
/// annulation demandée par l'utilisateur.
pub const CANCELLED: &str = "__cancelled__";

/// Un seul import, et un seul export, actifs à la fois depuis l'interface :
/// un drapeau global par nature de tâche suffit, pas besoin d'identifiant de
/// tâche. Remis à zéro au début de chaque nouvel import/export (voir
/// `import_source_blocking`/`export_timeline_blocking`), pour qu'une
/// annulation ne reste pas collée à la tâche suivante.
fn import_cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

fn export_cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

/// Vrai le temps qu'un export tourne.
///
/// Le commentaire au-dessus de `import_cancel_flag` suppose qu'un seul export
/// est actif à la fois côté interface, mais rien côté backend ne l'imposait :
/// deux appels qui se chevauchent (double clic avant que le bouton se
/// désactive, appel direct de la commande) partageraient le même drapeau
/// d'annulation — l'un remettrait à zéro l'annulation demandée pour l'autre —
/// et les mêmes fichiers temporaires (`.partial-{pid}.mp4`,
/// `.filtergraph-{pid}.txt`), qui ne distinguent pas deux exports du MÊME
/// processus. Ce verrou fait échouer proprement le second appel au lieu de
/// laisser les deux se marcher dessus.
fn export_in_progress() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

/// Libère `export_in_progress` quel que soit le chemin de sortie de
/// `export_timeline_blocking` (succès, erreur via `?`, panique).
struct ExportInProgressGuard;

impl Drop for ExportInProgressGuard {
    fn drop(&mut self) {
        export_in_progress().store(false, Ordering::SeqCst);
    }
}

/// Demande l'arrêt de l'import en cours : FFmpeg est tué au prochain point de
/// contrôle, pas seulement abandonné pendant qu'il continue en arrière-plan.
#[tauri::command]
pub fn cancel_import() {
    import_cancel_flag().store(true, Ordering::SeqCst);
}

/// Même chose pour l'export en cours.
#[tauri::command]
pub fn cancel_export() {
    export_cancel_flag().store(true, Ordering::SeqCst);
}

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
fn validate_segments(segments: &[ExportSegment], sources: &[ExportSource]) -> Result<(), String> {
    if segments.len() > MAX_SEGMENTS {
        return Err(format!("Trop de segments ({MAX_SEGMENTS} maximum)."));
    }
    if sources
        .iter()
        .any(|source| !source.duration_ms.is_finite() || source.duration_ms <= 0.0)
    {
        return Err("Un rush a une durée invalide.".into());
    }
    for (segment_index, segment) in segments.iter().enumerate() {
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
        if video_fades
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
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
        if segment.source_index >= sources.len() {
            return Err("Un segment référence un rush inconnu.".into());
        }
        if segment.src_out_ms > sources[segment.source_index].duration_ms + 0.001 {
            return Err("Un segment dépasse la durée de son rush.".into());
        }
        if !segment.transition_in_ms.is_finite()
            || !(0.0..=3000.0).contains(&segment.transition_in_ms)
        {
            return Err("Durée de transition hors bornes.".into());
        }
        if segment.transition_in_ms > 0.0 {
            if segment_index == 0 || segment.gap_before_ms > 0.001 {
                return Err("Une transition doit relier deux segments contigus.".into());
            }
            let previous = &segments[segment_index - 1];
            let half = segment.transition_in_ms / 2.0;
            let previous_duration =
                (previous.src_out_ms - previous.src_in_ms) / previous.playback_rate;
            let current_duration = (segment.src_out_ms - segment.src_in_ms) / segment.playback_rate;
            if segment.transition_in_ms > previous_duration + 0.001
                || segment.transition_in_ms > current_duration + 0.001
            {
                return Err("Transition plus longue que l'un des plans adjacents.".into());
            }
            if previous.audio_fade_out_ms > 0.0 || segment.audio_fade_in_ms > 0.0 {
                return Err("Transition audio incompatible avec un fondu de clip.".into());
            }
            if segment.src_in_ms + 0.001 < half * segment.playback_rate
                || sources[previous.source_index].duration_ms - previous.src_out_ms + 0.001
                    < half * previous.playback_rate
            {
                return Err("Poignées source insuffisantes pour la transition.".into());
            }
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

/// Contrôle du même ordre que `validate_segments`/`validate_text_overlays` :
/// `request.zooms` alimente directement `zoompan_filter`, qui n'imposait
/// jusqu'ici aucune limite de son côté (voir `MAX_ZOOMS`).
fn validate_zooms(zooms: &[ExportZoom]) -> Result<(), String> {
    if zooms.len() > MAX_ZOOMS {
        return Err(format!("Trop de zooms ({MAX_ZOOMS} maximum)."));
    }
    Ok(())
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

/// Expression `zoompan` d'un zoom animé.
///
/// Elle DOIT décrire exactement la même courbe que `zoomScaleAt` côté
/// TypeScript : deux rampes linéaires, un palier, et la valeur 1 hors des
/// bornes. Si les deux divergent, l'utilisateur valide un mouvement à l'écran
/// et en obtient un autre dans le fichier — c'est précisément ce que la règle
/// « l'aperçu EST la sortie » interdit.
///
/// `zoompan` ne sait pas revenir en arrière dans le temps : il évalue `z` image
/// par image à partir de `it`, l'horodatage d'entrée. On lui donne donc une
/// expression fermée du temps, sans récurrence sur la valeur précédente.
///
/// Le décalage reprend `zoomOffset` : le point visé vient au centre, borné pour
/// qu'aucun bord noir n'entre dans le cadre. `zoompan` exprime cette borne
/// naturellement, puisque `x` est la position du COIN de la fenêtre et qu'on la
/// contraint entre 0 et `iw - iw/zoom`.
fn zoompan_filter(zooms: &[ExportZoom], fps: f64) -> String {
    // Chaque zoom s'exprime en `if(condition,valeur,`, laissé OUVERT : la
    // fermeture (une parenthèse par zoom) n'est ajoutée qu'une fois, à la fin,
    // sur le résultat déjà assemblé. La version précédente enveloppait
    // `format!("if(...,{z_expr})")` à chaque tour, ce qui recopiait
    // l'intégralité de l'expression déjà construite à chaque zoom — un coût
    // en O(n²) sur des exports à plusieurs centaines de zooms (MAX_ZOOMS).
    let mut z_open = String::new();
    let mut x_open = String::new();
    let mut y_open = String::new();
    let mut count: usize = 0;

    for zoom in zooms {
        let start = zoom.timeline_start_ms / 1000.0;
        let end = zoom.timeline_end_ms / 1000.0;
        if end <= start {
            continue;
        }
        let peak = zoom.scale.clamp(1.0, 4.0);
        let duration = end - start;
        // Mêmes bornes que `clampZoomRampMs` : jamais plus de la moitié de la
        // durée, sinon l'aller et le retour se chevaucheraient.
        let half = duration / 2.0;
        let ramp_in = zoom.ramp_in_ms.max(0.0).min(3000.0).min(half * 1000.0) / 1000.0;
        let ramp_out = zoom.ramp_out_ms.max(0.0).min(3000.0).min(half * 1000.0) / 1000.0;

        // Gain d'enveloppe : min(rampe d'entrée, rampe de sortie), borné à 1.
        let gain_in = if ramp_in > 0.0 {
            format!("min(1,(it-{start:.6})/{ramp_in:.6})")
        } else {
            "1".to_string()
        };
        let gain_out = if ramp_out > 0.0 {
            format!("min(1,({end:.6}-it)/{ramp_out:.6})")
        } else {
            "1".to_string()
        };
        let raw_gain = format!("max(0,min({gain_in},{gain_out}))");
        // "ease" : même smoothstep que `easeGain` côté TypeScript. Inlinée
        // trois fois plutôt que via une variable — `zoompan` n'en offre pas.
        let gain = if zoom.easing == "ease" {
            format!("(({raw_gain})*({raw_gain})*(3-2*({raw_gain})))")
        } else {
            raw_gain
        };
        // Bornes ouvertes des deux côtés, comme `zoomScaleAt` : à `it == start`
        // ou `it == end` exactement, le zoom vaut 1. `between` est inclusif aux
        // deux bornes ; sans rampe (gain constant à 1), ça collait le pic de
        // zoom pile sur l'image de bord au lieu de l'image suivante, un
        // décalage d'une frame invisible avec une rampe mais flagrant sans.
        let inside = format!("gt(it,{start:.6})*lt(it,{end:.6})");
        // "in" : part du cadre normal (1), gagne vers le pic. "out" : symétrique,
        // part du pic, revient vers le cadre normal — même formule `base + delta*gain`.
        let (base, delta) = if zoom.direction == "out" {
            (peak, 1.0 - peak)
        } else {
            (1.0, peak - 1.0)
        };
        count += 1;
        z_open.push_str(&format!("if({inside},{base:.6}+{delta:.6}*{gain},"));

        // Le point visé, en fraction du cadre, ramené au coin de la fenêtre.
        // `zoom` est la valeur courante calculée par le filtre lui-même.
        x_open.push_str(&format!(
            "if({inside},max(0,min(iw-iw/zoom,iw*{x:.6}-(iw/zoom)/2)),",
            x = zoom.x.clamp(0.0, 1.0)
        ));
        y_open.push_str(&format!(
            "if({inside},max(0,min(ih-ih/zoom,ih*{y:.6}-(ih/zoom)/2)),",
            y = zoom.y.clamp(0.0, 1.0)
        ));
    }

    // Les zooms ne se chevauchent jamais (invariant posé côté TypeScript) :
    // au plus une condition est vraie à la fois, donc l'ordre d'imbrication
    // n'affecte pas le résultat, seulement lequel des `if` équivalents et
    // mutuellement exclusifs est évalué en premier.
    let closing: String = std::iter::repeat(')').take(count).collect();
    let z_expr = format!("{z_open}1{closing}");
    let x_expr = format!("{x_open}0{closing}");
    let y_expr = format!("{y_open}0{closing}");

    format!(
        "zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={OUT_WIDTH}x{OUT_HEIGHT}:fps={fps:.3}"
    )
}

fn drawtext_filter(overlay: &ExportTextOverlay, text_path: &Path, font_path: &Path) -> String {
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
        alpha_factors.push(format!("min(1,max(0,(t-{start:.6})/{duration:.6}))"));
    }
    if overlay.fade_out_ms > 0.0 {
        let duration = overlay.fade_out_ms / 1000.0;
        alpha_factors.push(format!("min(1,max(0,({end:.6}-t)/{duration:.6}))"));
    }
    let alpha = if alpha_factors.is_empty() {
        "1".into()
    } else {
        alpha_factors.join("*")
    };
    // Fenêtre visible demi-ouverte [start, end), comme la condition `hidden`
    // côté aperçu : `between` inclut `t == end`, ce qui affichait le titre une
    // frame de trop à la coupure quand il n'a pas de fondu pour masquer l'écart.
    let enable = format!("gte(t,{start:.6})*lt(t,{end:.6})");
    format!(
        "drawtext=fontfile='{font}':textfile='{text}':expansion=none:fontcolor=white:fontsize={size:.3}:text_align=C:{style}:x='w*{x:.6}-text_w/2':y='h*{y:.6}-text_h/2':alpha='{alpha}':enable='{enable}':fix_bounds=1",
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

fn audio_volume_filter(segment: &ExportSegment, prefix_ms: f64) -> String {
    if segment.audio_fade_in_ms <= 0.0 && segment.audio_fade_out_ms <= 0.0 {
        return format!("volume={:.6}", segment.volume);
    }

    let offset = (segment.audio_fade_offset_ms - prefix_ms) / 1000.0;
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
fn video_fade_filter(segment: &ExportSegment, prefix_ms: f64) -> String {
    let clip_duration = segment.video_clip_duration_ms / 1000.0;
    let prefix = prefix_ms / 1000.0;
    let mut filters: Vec<String> = Vec::new();
    if segment.video_fade_in_ms > 0.0 {
        let duration = segment.video_fade_in_ms / 1000.0;
        filters.push(format!(
            "fade=t=in:st={prefix:.6}:d={duration:.6}:color=black"
        ));
    }
    if segment.video_fade_out_ms > 0.0 {
        let duration = segment.video_fade_out_ms / 1000.0;
        let start = prefix + clip_duration - duration;
        filters.push(format!(
            "fade=t=out:st={start:.6}:d={duration:.6}:color=black"
        ));
    }
    filters.join(",")
}

fn assemble_video_parts(graph: &mut String, parts: &[(usize, f64, f64)]) -> Result<String, String> {
    let Some(&(first_label, first_duration, _)) = parts.first() else {
        return Err("Aucune partie vidéo à assembler.".into());
    };
    let mut assembled_label = format!("v{first_label}");
    let mut assembled_duration = first_duration;
    for (chain_index, (label, duration, transition)) in parts.iter().enumerate().skip(1) {
        let next_label = format!("vmix{chain_index}");
        if *transition > 0.0 {
            let offset = assembled_duration - transition;
            graph.push_str(&format!(
                "[{assembled_label}][v{label}]xfade=transition=fade:duration={transition:.6}:offset={offset:.6}[{next_label}];"
            ));
        } else {
            graph.push_str(&format!(
                "[{assembled_label}][v{label}]concat=n=2:v=1:a=0[{next_label}];"
            ));
        }
        assembled_duration += duration - transition;
        assembled_label = next_label;
    }
    graph.push_str(&format!("[{assembled_label}]null[vbase];"));
    Ok("vbase".into())
}

fn assemble_audio_parts(graph: &mut String, parts: &[(usize, f64, f64)]) -> Result<String, String> {
    let Some(&(first_label, _, _)) = parts.first() else {
        return Err("Aucune partie audio à assembler.".into());
    };
    let mut assembled_label = format!("a{first_label}");
    for (chain_index, (label, _, transition)) in parts.iter().enumerate().skip(1) {
        let next_label = format!("amix{chain_index}");
        if *transition > 0.0 {
            graph.push_str(&format!(
                "[{assembled_label}][a{label}]acrossfade=d={transition:.6}:c1=tri:c2=tri[{next_label}];"
            ));
        } else {
            graph.push_str(&format!(
                "[{assembled_label}][a{label}]concat=n=2:v=0:a=1[{next_label}];"
            ));
        }
        assembled_label = next_label;
    }
    graph.push_str(&format!("[{assembled_label}]anull[ac];"));
    Ok("ac".into())
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
    #[serde(default)]
    pub transition_in_ms: f64,
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
    pub duration_ms: f64,
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

/// Zoom animé sur l'image de sortie.
///
/// Les bornes et les rampes sont exprimées dans le temps de la TIMELINE, comme
/// côté TypeScript : le filtre s'applique après l'assemblage, sur le flux
/// final, donc son horloge est celle du montage.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportZoom {
    pub timeline_start_ms: f64,
    pub timeline_end_ms: f64,
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub ramp_in_ms: f64,
    #[serde(default)]
    pub ramp_out_ms: f64,
    /// "out" si présent ; toute autre valeur (y compris absente) vaut "in".
    #[serde(default)]
    pub direction: String,
    /// "ease" si présent ; toute autre valeur (y compris absente) vaut "linear".
    #[serde(default)]
    pub easing: String,
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
    /// Zooms animés. Absents des projets antérieurs au format 9.
    #[serde(default)]
    pub zooms: Vec<ExportZoom>,
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
    fs::create_dir_all(&root)
        .map_err(|e| format!("Création du dossier de données impossible : {e}"))?;
    Ok(root)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|e| format!("Création de dossier impossible ({}) : {e}", path.display()))
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

/// Message d'erreur pour l'échec du LANCEMENT d'un outil (`spawn`).
///
/// Seule une erreur `NotFound` signifie vraiment que le binaire est absent.
/// Bug réel corrigé : `spawn()` rapportait TOUJOURS « introuvable, vérifie le
/// PATH », quelle que soit la cause réelle — y compris une ligne de commande
/// trop longue pour `CreateProcess` sur Windows (limite ~32 767 caractères,
/// atteinte par un montage chargé en zooms bien avant tout autre plafond du
/// fichier). L'utilisateur allait alors réinstaller un binaire parfaitement
/// présent au lieu d'apprendre la vraie cause. Toute erreur autre que
/// `NotFound` remonte désormais le message réel de l'OS.
fn spawn_error(tool: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        missing_tool_error(tool)
    } else {
        format!("Lancement de {tool} impossible : {error}")
    }
}

fn str_args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

/// Un échec de disque plein (ou d'écriture en général) frappe l'encodage,
/// pas l'encodeur : blâmer NVENC, le désactiver pour la session et relancer
/// tout l'encodage en CPU ne ferait qu'échouer une seconde fois, plus
/// lentement, pour la même raison.
fn is_encoder_agnostic_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no space left on device")
        || lower.contains("disk full")
        || lower.contains("espace disque")
        || lower.contains("i/o error")
        || lower.contains("permission denied")
        || lower.contains("read-only file system")
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
///
/// `cancel` est vérifié à chaque ligne de progression (FFmpeg en écrit
/// plusieurs par seconde) : dès qu'il passe à vrai, le process est tué
/// (`kill`) plutôt qu'abandonné à tourner en arrière-plan jusqu'à sa fin
/// naturelle — sans ça, « annuler » ne faisait que cesser d'écouter un FFmpeg
/// qui continuait, seul, à consommer CPU/GPU pour un résultat qu'on jetait.
fn run_ffmpeg_with_progress(
    args: &[String],
    total_ms: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    let mut child = base_command(MediaTool::Ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error("FFmpeg", &e))?;

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

    let mut cancelled = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if let Some(value) = line.strip_prefix("out_time=") {
            if let Some(out_ms) = parse_ffmpeg_time(value) {
                if total_ms > 0.0 {
                    on_progress((out_ms / total_ms * 100.0).clamp(0.0, 99.9));
                }
            }
        }
    }
    if !cancelled && cancel.load(Ordering::SeqCst) {
        cancelled = true;
    }
    if cancelled {
        let _ = child.kill();
        let _ = child.wait();
        let _ = stderr_handle.join();
        return Err(CANCELLED.into());
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
    let mut file =
        fs::File::open(path).map_err(|e| format!("Lecture du fichier impossible : {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Métadonnées illisibles : {e}"))?
        .len();

    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    let mut buffer = vec![0u8; BLOCK];
    let read = file
        .read(&mut buffer)
        .map_err(|e| format!("Lecture : {e}"))?;
    hasher.update(&buffer[..read]);

    if size > (BLOCK as u64) * 2 {
        file.seek(SeekFrom::End(-(BLOCK as i64)))
            .map_err(|e| format!("Lecture : {e}"))?;
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Lecture : {e}"))?;
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
            "-v",
            "error",
            "-print_format",
            "json",
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

    let streams = parsed["streams"].as_array().ok_or("Aucun flux détecté.")?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("Aucune piste vidéo détectée dans ce fichier.")?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    // `format.duration` couvre TOUT le conteneur (piste audio comprise, marge
    // du muxer) : elle peut dépasser la durée réelle du flux vidéo de plus
    // d'une image. Un montage coupé jusque-là fabrique un clip valide sans
    // aucune image à exporter (FFmpeg finit par "Output file is empty").
    // La durée du flux vidéo lui-même est la seule fiable ; `format.duration`
    // ne sert que de repli quand le flux ne la fournit pas.
    let duration_s: f64 = video["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .or_else(|| {
            parsed["format"]["duration"]
                .as_str()
                .and_then(|d| d.parse().ok())
        })
        .ok_or("Durée introuvable dans le fichier.")?;

    let fps = video["avg_frame_rate"]
        .as_str()
        .and_then(parse_frame_rate)
        .or_else(|| video["r_frame_rate"].as_str().and_then(parse_frame_rate))
        .unwrap_or(30.0);

    Ok(ProbeInfo {
        duration_ms: duration_s * 1000.0,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
        has_audio,
        video_codec: video["codec_name"]
            .as_str()
            .unwrap_or("inconnu")
            .to_string(),
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

/// Un seul import à la fois par empreinte de fichier : sans ce verrou, deux
/// dépôts concurrents du même rush (glisser-déposer + sélection manuelle, par
/// exemple) écriraient tous les deux dans le même `.partial.mp4` et le même
/// dossier de vignettes, corrompant l'un des deux proxys.
fn import_lock_for(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let registry = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry.lock().unwrap_or_else(|e| e.into_inner());
    registry
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn import_source_blocking(app: &AppHandle, path: &str) -> Result<SourceInfo, String> {
    // Remis à zéro : une annulation d'un import précédent ne doit pas tuer
    // celui-ci avant même qu'il commence.
    import_cancel_flag().store(false, Ordering::SeqCst);
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

    let lock = import_lock_for(&id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    emit_import(app, "probe", 10.0);
    let probe = probe_file(&source)?;

    // 1) Proxy de montage (réutilisé s'il existe déjà pour cette source).
    let proxies_dir = root.join("proxies");
    ensure_dir(&proxies_dir)?;
    let proxy_path = proxies_dir.join(format!("{id}-v{PROXY_VERSION}.mp4"));
    if !proxy_path.is_file() {
        let partial = proxies_dir.join(format!("{id}-v{PROXY_VERSION}.partial.mp4"));
        let _ = fs::remove_file(&partial);
        let mut args: Vec<String> =
            str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
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
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
        ]));
        args.push(partial.to_str().ok_or("Chemin proxy invalide.")?.into());

        let first_result = run_ffmpeg_with_progress(
            &args,
            probe.duration_ms,
            import_cancel_flag(),
            |p| {
                emit_import(app, "proxy", 10.0 + p * 0.6);
            },
        );
        if let Err(nvenc_error) = first_result {
            let _ = fs::remove_file(&partial);
            // Une annulation ne se rattrape jamais par un repli CPU : elle doit
            // arrêter l'import net, pas relancer un second encodage. Pareil pour
            // une panne qui ne vient pas de l'encodeur (disque plein, permissions…) :
            // le CPU échouerait pour la même raison, après avoir tout refait.
            if nvenc_error == CANCELLED
                || encoder != VideoEncoder::H264Nvenc
                || is_encoder_agnostic_failure(&nvenc_error)
            {
                return Err(nvenc_error);
            }
            hardware::disable_nvenc(
                "NVENC a échoué pendant la création d'un proxy ; repli CPU pour cette session.",
            );
            let mut cpu_args = args.clone();
            cpu_args.splice(
                encoder_start..encoder_end,
                video_encoder_args(VideoEncoder::Libx264, "veryfast", 23),
            );
            run_ffmpeg_with_progress(
                &cpu_args,
                probe.duration_ms,
                import_cancel_flag(),
                |p| {
                    emit_import(app, "proxy", 10.0 + p * 0.6);
                },
            )
            .map_err(|cpu_error| {
                let _ = fs::remove_file(&partial);
                if cpu_error == CANCELLED {
                    cpu_error
                } else {
                    format!(
                        "NVENC puis l'encodage CPU ont échoué.\nNVENC : {nvenc_error}\nCPU : {cpu_error}"
                    )
                }
            })?;
        }
        fs::rename(&partial, &proxy_path)
            .map_err(|e| format!("Finalisation du proxy impossible : {e}"))?;
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
        // Comme le proxy : générées dans un dossier temporaire puis renommées
        // d'un coup. Écrire directement dans `thumbs_dir` laissait un import
        // annulé en cours de route (`cancel_import`) derrière un lot de
        // vignettes partiel, que le check de cache ci-dessus prenait ensuite
        // pour un import complet — sans jamais le régénérer.
        let partial_thumbs_dir = root.join("thumbs").join(format!("{id}-v{THUMB_VERSION}.partial"));
        let _ = fs::remove_dir_all(&partial_thumbs_dir);
        ensure_dir(&partial_thumbs_dir)?;
        let pattern = partial_thumbs_dir.join("%05d.jpg");
        let mut args: Vec<String> =
            str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
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
        if let Err(e) = run_ffmpeg_with_progress(&args, probe.duration_ms, import_cancel_flag(), |p| {
            emit_import(app, "thumbs", 72.0 + p * 0.18);
        }) {
            let _ = fs::remove_dir_all(&partial_thumbs_dir);
            return Err(e);
        }
        let _ = fs::remove_dir_all(&thumbs_dir);
        fs::rename(&partial_thumbs_dir, &thumbs_dir)
            .map_err(|e| format!("Finalisation des vignettes impossible : {e}"))?;
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
            // Comme le proxy et les vignettes : écrite à part puis renommée.
            // `showwavespic` n'émet son unique image qu'à la toute fin du
            // décodage — un import annulé en cours de route pouvait laisser un
            // PNG tronqué que `is_file()` prenait pour une waveform complète.
            let partial_waveform = waveforms_dir.join(format!("{id}-w{WAVEFORM_VERSION}.partial.png"));
            let _ = fs::remove_file(&partial_waveform);
            let mut args: Vec<String> =
                str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
            args.push("-i".into());
            args.push(proxy_path.to_str().ok_or("Chemin proxy invalide.")?.into());
            args.push("-filter_complex".into());
            // scale=sqrt : sans ça, un gameplay à niveau moyen donne un trait plat
            // et illisible une fois la waveform écrasée dans 28 px de haut.
            args.push(format!(
                "aformat=channel_layouts=mono,showwavespic=s={width}x120:colors=#7aa4ff:scale=sqrt"
            ));
            args.extend(str_args(&["-frames:v", "1"]));
            args.push(partial_waveform.to_str().ok_or("Chemin waveform invalide.")?.into());
            // Pas de suivi de progression nécessaire : c'est très rapide.
            if let Err(e) = run_ffmpeg_with_progress(&args, 0.0, import_cancel_flag(), |_| {}) {
                let _ = fs::remove_file(&partial_waveform);
                return Err(e);
            }
            fs::rename(&partial_waveform, &waveform)
                .map_err(|e| format!("Finalisation de la waveform impossible : {e}"))?;
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
    if export_in_progress().swap(true, Ordering::SeqCst) {
        return Err("Un export est déjà en cours.".into());
    }
    let _guard = ExportInProgressGuard;
    // Remis à zéro : une annulation d'un export précédent ne doit pas tuer
    // celui-ci avant même qu'il commence.
    export_cancel_flag().store(false, Ordering::SeqCst);
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
    validate_segments(&request.segments, &request.sources)?;
    validate_segments(&request.audio_segments, &request.sources)?;
    if !request.frame_fps.is_finite() || request.frame_fps <= 0.0 || request.frame_fps > 480.0 {
        return Err("Cadence de sortie invalide.".into());
    }
    if request.mode != "crop" && request.mode != "blur" {
        return Err("Mode d'export inconnu.".into());
    }
    // Validé sur la forme TRIM.EE : c'est elle qui finit dans le nom de
    // fichier plus bas, sinon un nom fait uniquement d'espaces passait la
    // validation puis produisait un fichier littéralement nommé « .mp4 ».
    let trimmed_name = request.file_name.trim();
    let name_ok = !trimmed_name.is_empty()
        && trimmed_name.len() <= 60
        && trimmed_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-');
    if !name_ok {
        return Err(
            "Nom de fichier invalide (lettres, chiffres, espaces, - et _ uniquement).".into(),
        );
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
    let mut output = exports_dir.join(format!("{trimmed_name}.mp4"));
    let mut counter = 2;
    while output.exists() {
        output = exports_dir.join(format!("{trimmed_name} ({counter}).mp4"));
        counter += 1;
    }

    // Graphe de filtres : chaque trou devient du noir silencieux, chaque clip un
    // trim du rush ; on concatène le tout, puis on passe en 9:16.
    // Les entrées lavfi (noir, silence) ne sont ajoutées que si un trou existe.
    // Les deux plans sont assemblés séparément puis mappés ensemble : l'image
    // vient du plan vidéo, le son du plan audio.
    let timeline_ms =
        |s: &ExportSegment| (s.src_out_ms - s.src_in_ms) / s.playback_rate + s.gap_before_ms;
    let total_video_ms: f64 = request.segments.iter().map(timeline_ms).sum();
    let total_audio_ms: f64 = request.audio_segments.iter().map(timeline_ms).sum();
    validate_text_overlays(&request.text_overlays, total_video_ms)?;
    validate_zooms(&request.zooms)?;

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
        let path = exports_dir.join(format!(".title-{}-{index}.txt", std::process::id()));
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

    // Sans seek d'entrée, FFmpeg décoderait chaque rush depuis l'image 0 avant
    // de jeter tout ce qui précède le `trim` du filtre — sur un rush de
    // plusieurs heures, un extrait de fin décoderait des heures pour rien.
    // On avance donc chaque `-i` juste avant le point le plus tôt réellement
    // lu sur cette source (vidéo ET son confondus), puis on décale d'autant
    // les bornes passées aux filtres `trim`/`atrim`, qui lisent le flux déjà
    // décalé et non plus le fichier depuis son origine.
    let mut seek_offsets = vec![f64::INFINITY; n_sources];
    for segment in &request.segments {
        let prefix_ms = segment.transition_in_ms / 2.0;
        let rate = segment.playback_rate;
        let raw_start = if video_fade_filter(segment, prefix_ms).is_empty() {
            (segment.src_in_ms - prefix_ms * rate) / 1000.0
        } else {
            (segment.src_in_ms - segment.video_fade_offset_ms * rate - prefix_ms * rate) / 1000.0
        };
        let slot = &mut seek_offsets[segment.source_index];
        *slot = slot.min(raw_start);
    }
    for segment in &request.audio_segments {
        let prefix_ms = segment.transition_in_ms / 2.0;
        let raw_start = (segment.src_in_ms - prefix_ms * segment.playback_rate) / 1000.0;
        let slot = &mut seek_offsets[segment.source_index];
        *slot = slot.min(raw_start);
    }
    // Petite marge de sécurité contre un arrondi qui ferait tomber un `trim`
    // juste sous zéro une fois décalé.
    let seek_offsets: Vec<f64> = seek_offsets
        .into_iter()
        .map(|start| if start.is_finite() { (start - 0.05).max(0.0) } else { 0.0 })
        .collect();

    // `concat` exige des flux homogènes : même définition, même format de pixel,
    // même SAR, même format audio. Chaque segment est donc amené AU FORMAT DE
    // SORTIE avant d'être concaténé, cadrage compris : le décalage de cadrage
    // appartient au clip, il ne peut pas s'appliquer après l'assemblage.
    // `fps` en fin de chaîne : indispensable dès qu'un segment est accéléré ou
    // qu'un rush a une autre cadence. Sans lui, chaque branche sort avec sa
    // propre cadence et la durée d'un segment accéléré dérive de quelques
    // images ; avec lui, elle vaut exactement durée_timeline × cadence.
    // `xfade` exige aussi la même base de temps sur ses deux entrées : `settb`
    // évite un échec d'export lorsque deux proxys n'ont pas le même timebase.
    let ffps = request.frame_fps;
    let vtail = format!("setsar=1,format=yuv420p,fps={ffps:.6},settb=AVTB");
    const AFMT: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
    let mut graph = String::new();

    // --- Branche vidéo : uniquement le plan vidéo -------------------------------
    // label, duration in seconds, overlap with the previous part.
    let mut parts: Vec<(usize, f64, f64)> = Vec::new();
    let mut next_label = 0usize;
    for (segment_index, segment) in request.segments.iter().enumerate() {
        if segment.gap_before_ms > 0.0 {
            let duration = segment.gap_before_ms / 1000.0;
            let i = next_label;
            // Le noir est déjà produit au format de sortie : rien à cadrer.
            graph += &format!(
                "[{black_input}:v]trim=duration={duration:.3},setpts=PTS-STARTPTS,{vtail}[v{i}];"
            );
            parts.push((i, duration, 0.0));
            next_label += 1;
        }
        let prefix_ms = segment.transition_in_ms / 2.0;
        let suffix_ms = request
            .segments
            .get(segment_index + 1)
            .map(|next| next.transition_in_ms / 2.0)
            .unwrap_or(0.0);
        let input = segment.source_index;
        let seek = seek_offsets[input];
        let start = (segment.src_in_ms - prefix_ms * segment.playback_rate) / 1000.0 - seek;
        let end = (segment.src_out_ms + suffix_ms * segment.playback_rate) / 1000.0 - seek;
        let rate = segment.playback_rate;
        let i = next_label;
        // setpts=PTS/rate : accélérer revient à rapprocher les horodatages.
        let fade_filter = video_fade_filter(segment, prefix_ms);
        if fade_filter.is_empty() {
            graph += &format!(
                "[{input}:v]trim=start={start:.3}:end={end:.3},\
                 setpts=(PTS-STARTPTS)/{rate:.6}[raw{i}];"
            );
        } else {
            let offset = segment.video_fade_offset_ms / 1000.0;
            let duration = (segment.src_out_ms - segment.src_in_ms) / rate / 1000.0
                + (prefix_ms + suffix_ms) / 1000.0;
            let clip_start = (segment.src_in_ms - segment.video_fade_offset_ms * rate
                - prefix_ms * rate)
                / 1000.0
                - seek;
            let clip_end = clip_start
                + (segment.video_clip_duration_ms + prefix_ms + suffix_ms) * rate / 1000.0;
            let extract_end = offset + duration;
            graph += &format!(
                "[{input}:v]trim=start={clip_start:.6}:end={clip_end:.6},\
                 setpts=(PTS-STARTPTS)/{rate:.6},{fade_filter},\
                 trim=start={offset:.6}:end={extract_end:.6},\
                 setpts=PTS-STARTPTS[raw{i}];"
            );
        }
        graph += &framing_chain(&request.mode, segment.crop_x, i, &vtail);
        let part_duration = (segment.src_out_ms - segment.src_in_ms) / rate / 1000.0
            + (prefix_ms + suffix_ms) / 1000.0;
        parts.push((i, part_duration, segment.transition_in_ms / 1000.0));
        next_label += 1;
    }

    // --- Branche audio : uniquement le plan audio -------------------------------
    // label, durée en secondes, chevauchement avec la partie précédente.
    let mut audio_parts: Vec<(usize, f64, f64)> = Vec::new();
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
        for (request_index, segment) in request.audio_segments.iter().enumerate() {
            if segment.gap_before_ms > 0.0 {
                let duration = segment.gap_before_ms / 1000.0;
                let label = push_silence(&mut graph, duration, &mut next_audio);
                audio_parts.push((label, duration, 0.0));
            }
            let prefix_ms = segment.transition_in_ms / 2.0;
            let suffix_ms = request
                .audio_segments
                .get(request_index + 1)
                .map(|next| next.transition_in_ms / 2.0)
                .unwrap_or(0.0);
            let input = segment.source_index;
            let seek = seek_offsets[input];
            let start = (segment.src_in_ms - prefix_ms * segment.playback_rate) / 1000.0 - seek;
            let end = (segment.src_out_ms + suffix_ms * segment.playback_rate) / 1000.0 - seek;
            let duration =
                (segment.src_out_ms - segment.src_in_ms) / segment.playback_rate / 1000.0
                    + (prefix_ms + suffix_ms) / 1000.0;
            let transition = segment.transition_in_ms / 1000.0;
            if request.sources[input].has_audio {
                let i = next_audio;
                let tempo = atempo_chain(segment.playback_rate);
                let volume = audio_volume_filter(segment, prefix_ms);
                graph += &format!(
                    "[{input}:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo},{volume},{AFMT}[a{i}];"
                );
                audio_parts.push((i, duration, transition));
                next_audio += 1;
            } else {
                // Rush muet : le silence est déjà à la bonne durée de timeline.
                let label = push_silence(&mut graph, duration, &mut next_audio);
                audio_parts.push((label, duration, transition));
            }
        }
        // Le plan audio peut s'arrêter avant l'image : on complète au silence.
        if audio_tail_ms > 1.0 {
            let duration = audio_tail_ms / 1000.0;
            let label = push_silence(&mut graph, duration, &mut next_audio);
            audio_parts.push((label, duration, 0.0));
        }
    }

    let n = parts.len();
    if n > MAX_SEGMENTS {
        return Err(format!(
            "Trop de segments à assembler ({MAX_SEGMENTS} maximum)."
        ));
    }
    assemble_video_parts(&mut graph, &parts)?;

    let mut video_output_label = "vbase".to_string();

    // Le zoom s'applique sur l'image assemblée et AVANT les titres : un titre
    // est une incrustation de l'interface, il ne grossit pas avec l'image.
    // L'aperçu place sa couche zoomée au même endroit de la pile.
    if !request.zooms.is_empty() {
        graph += &format!(
            "[{video_output_label}]{}[vzoom];",
            zoompan_filter(&request.zooms, request.frame_fps)
        );
        video_output_label = "vzoom".to_string();
    }

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
            return Err(format!(
                "Trop de segments sonores ({MAX_SEGMENTS} maximum)."
            ));
        }
        assemble_audio_parts(&mut graph, &audio_parts)?;
    }
    // Un point-virgule final ferait échouer FFmpeg sur une chaîne de filtres vide.
    while graph.ends_with(';') {
        graph.pop();
    }

    let total_ms = total_video_ms;

    let partial = exports_dir.join(format!(".partial-{}.mp4", std::process::id()));
    let _ = fs::remove_file(&partial);

    // Le graphe passe par un FICHIER (`-filter_complex_script`), jamais en
    // ligne de commande (`-filter_complex <graphe>`).
    //
    // `Command::args` sur Windows assemble tous les arguments en UNE seule
    // chaîne pour `CreateProcess`, plafonnée à 32 767 caractères par l'OS — en
    // pratique un peu moins une fois l'exécutable et les guillemets comptés.
    // Un montage chargé en zooms (l'expression `zoompan` s'allonge à chaque
    // zoom, elle n'est jamais bornée comme `MAX_SEGMENTS`) dépassait cette
    // limite dès 100 à 110 zooms, bien avant tout autre plafond du fichier.
    // `-filter_complex_script` lit exactement le même graphe, à la même
    // syntaxe, mais depuis le disque : la ligne de commande reste minuscule
    // quelle que soit la taille du montage.
    let filter_script_path =
        exports_dir.join(format!(".filtergraph-{}.txt", std::process::id()));
    fs::write(&filter_script_path, &graph)
        .map_err(|e| format!("Écriture du graphe de filtres impossible : {e}"))?;
    temporary_text_files.0.push(filter_script_path.clone());

    let mut args: Vec<String> = str_args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    // Les rushs d'abord, dans l'ordre exact référencé par les segments. Le
    // `-ss` place avant `-i` est un seek d'ENTRÉE : FFmpeg saute au mot-clé le
    // plus proche puis décode en avant jusqu'au point exact, au lieu de
    // décoder tout le fichier depuis l'image 0 avant que le filtre `trim` n'en
    // jette le début.
    for (index, source) in request.sources.iter().enumerate() {
        let seek = seek_offsets[index];
        if seek > 0.0 {
            args.extend(["-ss".into(), format!("{seek:.6}")]);
        }
        args.extend(["-i".into(), source.path.clone()]);
    }
    if has_gap {
        let fps = request.frame_fps;
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("color=c=black:s={OUT_WIDTH}x{OUT_HEIGHT}:r={fps:.3}"),
        ]);
    }
    if needs_silence {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        ]);
    }
    args.extend([
        "-filter_complex_script".into(),
        filter_script_path.to_string_lossy().to_string(),
        "-map".into(),
        format!("[{video_output_label}]"),
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
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        partial.to_string_lossy().to_string(),
    ]);

    let emit = |percent: f64, done: bool, output_path: Option<String>| {
        let _ = app.emit(
            "export://progress",
            ExportProgress {
                percent,
                done,
                output_path,
            },
        );
    };

    emit(0.0, false, None);
    let first_result =
        run_ffmpeg_with_progress(&args, total_ms, export_cancel_flag(), |p| emit(p, false, None));
    if let Err(nvenc_error) = first_result {
        let _ = fs::remove_file(&partial);
        // Une annulation ne se rattrape jamais par un repli CPU : elle doit
        // arrêter l'export net, pas relancer un second encodage. Pareil pour
        // une panne qui ne vient pas de l'encodeur (disque plein, permissions…) :
        // le CPU échouerait pour la même raison, après avoir tout refait.
        if nvenc_error == CANCELLED
            || encoder != VideoEncoder::H264Nvenc
            || is_encoder_agnostic_failure(&nvenc_error)
        {
            return Err(nvenc_error);
        }
        hardware::disable_nvenc("NVENC a échoué pendant un export ; repli CPU pour cette session.");
        let mut cpu_args = args.clone();
        cpu_args.splice(
            encoder_start..encoder_end,
            video_encoder_args(VideoEncoder::Libx264, "fast", 19),
        );
        emit(0.0, false, None);
        run_ffmpeg_with_progress(&cpu_args, total_ms, export_cancel_flag(), |p| {
            emit(p, false, None)
        })
        .map_err(|cpu_error| {
            let _ = fs::remove_file(&partial);
            if cpu_error == CANCELLED {
                cpu_error
            } else {
                format!(
                    "NVENC puis l'encodage CPU ont échoué.\nNVENC : {nvenc_error}\nCPU : {cpu_error}"
                )
            }
        })?;
    }

    fs::rename(&partial, &output)
        .map_err(|e| format!("Finalisation de l'export impossible : {e}"))?;
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
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or("Chemin invalide.")?
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
            transition_in_ms: 0.0,
            crop_x: 0.0,
            gap_before_ms,
        }
    }

    fn sonore() -> Vec<ExportSource> {
        vec![ExportSource {
            path: "a.mp4".into(),
            has_audio: true,
            duration_ms: 10_000.0,
        }]
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
        let muet = vec![ExportSource {
            path: "b.mp4".into(),
            has_audio: false,
            duration_ms: 10_000.0,
        }];
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
        assert!(validate_segments(&[segment(0.0)], &sonore()).is_ok());

        let hors_bornes = ExportSegment {
            playback_rate: 12.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[hors_bornes], &sonore()).is_err(),
            "vitesse aberrante refusée"
        );

        let volume_hors_bornes = ExportSegment {
            volume: 1.01,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[volume_hors_bornes], &sonore()).is_err(),
            "volume supérieur au niveau original refusé"
        );

        let fondu_hors_bornes = ExportSegment {
            audio_fade_in_ms: 600.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[fondu_hors_bornes], &sonore()).is_err(),
            "un fondu supérieur à la moitié du clip est refusé"
        );
        let fondu_video_hors_bornes = ExportSegment {
            video_fade_out_ms: 600.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[fondu_video_hors_bornes], &sonore()).is_err(),
            "un fondu vidéo supérieur à la moitié du clip est refusé"
        );

        let rush_inconnu = ExportSegment {
            source_index: 7,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[rush_inconnu], &sonore()).is_err(),
            "rush inexistant refusé"
        );

        let bornes_folles = ExportSegment {
            src_out_ms: 0.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[bornes_folles], &sonore()).is_err(),
            "durée nulle refusée"
        );

        let outgoing = ExportSegment {
            src_in_ms: 1000.0,
            src_out_ms: 5000.0,
            ..segment(0.0)
        };
        let incoming = ExportSegment {
            src_in_ms: 2000.0,
            src_out_ms: 6000.0,
            transition_in_ms: 1000.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[outgoing, incoming], &sonore()).is_ok(),
            "des poignées suffisantes autorisent le fondu enchaîné"
        );
        let incoming_sans_poignee = ExportSegment {
            src_in_ms: 0.0,
            src_out_ms: 4000.0,
            transition_in_ms: 1000.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[segment(0.0), incoming_sans_poignee], &sonore()).is_err(),
            "une transition sans poignée entrante est refusée"
        );

        let transition_trop_longue = ExportSegment {
            src_in_ms: 2000.0,
            src_out_ms: 2500.0,
            transition_in_ms: 1000.0,
            ..segment(0.0)
        };
        let plan_precedent = ExportSegment {
            src_in_ms: 1000.0,
            src_out_ms: 5000.0,
            ..segment(0.0)
        };
        assert!(
            validate_segments(&[plan_precedent, transition_trop_longue], &sonore()).is_err(),
            "une transition plus longue que le plan entrant est refusée"
        );

        let duree_source_invalide = vec![ExportSource {
            path: "a.mp4".into(),
            has_audio: true,
            duration_ms: f64::NAN,
        }];
        assert!(
            validate_segments(&[segment(0.0)], &duree_source_invalide).is_err(),
            "une durée source non numérique est refusée"
        );
    }

    #[test]
    fn le_graphe_enchaine_concat_et_xfade_sans_decaler_la_suite() {
        let mut graph = String::new();
        let label =
            assemble_video_parts(&mut graph, &[(0, 4.5, 0.0), (1, 5.0, 1.0), (2, 2.0, 0.0)])
                .expect("assemblage vidéo");
        assert_eq!(label, "vbase");
        assert_eq!(
            graph,
            "[v0][v1]xfade=transition=fade:duration=1.000000:offset=3.500000[vmix1];\
[vmix1][v2]concat=n=2:v=1:a=0[vmix2];[vmix2]null[vbase];"
        );
    }

    #[test]
    fn le_graphe_audio_enchaine_concat_et_acrossfade() {
        let mut graph = String::new();
        let label =
            assemble_audio_parts(&mut graph, &[(0, 4.5, 0.0), (1, 5.0, 1.0), (2, 2.0, 0.0)])
                .expect("assemblage audio");
        assert_eq!(label, "ac");
        assert_eq!(
            graph,
            "[a0][a1]acrossfade=d=1.000000:c1=tri:c2=tri[amix1];\
[amix1][a2]concat=n=2:v=0:a=1[amix2];[amix2]anull[ac];"
        );
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
            video_fade_filter(&interrupted, 0.0),
            "fade=t=in:st=0.000000:d=1.000000:color=black"
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
            video_fade_filter(&exit, 0.0),
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
    fn le_filtre_zoom_reprend_la_courbe_validee_au_rendu() {
        // Ces valeurs sont exactement celles dont le rendu a ete mesure image
        // par image sur une grille de pas connu : 1,204 mesure a t=1,100 pour
        // 1,200 attendu ; 1,463 a t=1,233 pour 1,466 ; ecart nul au palier et
        // au retour. Le test fige l'expression qui a produit ces mesures : si
        // la formule change, la divergence avec `zoomScaleAt` cote TypeScript
        // se voit ici, pas dans un fichier exporte.
        let filter = zoompan_filter(
            &[ExportZoom {
                timeline_start_ms: 1000.0,
                timeline_end_ms: 3000.0,
                scale: 2.0,
                x: 0.75,
                y: 0.25,
                ramp_in_ms: 500.0,
                ramp_out_ms: 500.0,
                direction: String::new(),
                easing: String::new(),
            }],
            30.0,
        );
        assert!(filter.contains("gt(it,1.000000)*lt(it,3.000000)"));
        assert!(filter.contains("min(1,(it-1.000000)/0.500000)"));
        assert!(filter.contains("min(1,(3.000000-it)/0.500000)"));
        // Hors des bornes, la valeur de repli est 1 : la vue d'avant est
        // retrouvee a l'identique, pas approchee.
        assert!(filter.ends_with(":d=1:s=1080x1920:fps=30.000"));
        assert!(filter.contains("1.000000+1.000000*"));
        // Le coin de la fenetre est borne : viser un bord ne fait jamais
        // entrer de noir dans le cadre.
        assert!(filter.contains("max(0,min(iw-iw/zoom,iw*0.750000-(iw/zoom)/2))"));
        assert!(filter.contains("max(0,min(ih-ih/zoom,ih*0.250000-(ih/zoom)/2))"));
    }

    #[test]
    fn un_zoom_sans_rampe_ne_divise_jamais_par_zero() {
        // Rampes nulles : les gains valent 1 en dur plutot que de produire une
        // division par zero qui donnerait NaN a chaque image du rendu.
        let filter = zoompan_filter(
            &[ExportZoom {
                timeline_start_ms: 0.0,
                timeline_end_ms: 1000.0,
                scale: 3.0,
                x: 0.5,
                y: 0.5,
                ramp_in_ms: 0.0,
                ramp_out_ms: 0.0,
                direction: String::new(),
                easing: String::new(),
            }],
            30.0,
        );
        assert!(!filter.contains("/0.000000"));
        assert!(filter.contains("max(0,min(1,1))"));
    }

    #[test]
    fn le_zoom_out_part_du_pic_et_revient_au_cadre_normal() {
        // Symetrique du zoom "in" : base = pic, delta = 1 - pic, au lieu de
        // base = 1, delta = pic - 1.
        let filter = zoompan_filter(
            &[ExportZoom {
                timeline_start_ms: 0.0,
                timeline_end_ms: 1000.0,
                scale: 2.0,
                x: 0.5,
                y: 0.5,
                ramp_in_ms: 200.0,
                ramp_out_ms: 200.0,
                direction: "out".to_string(),
                easing: String::new(),
            }],
            30.0,
        );
        assert!(filter.contains("2.000000+-1.000000*"));
    }

    #[test]
    fn le_zoom_ease_adoucit_le_gain_par_un_smoothstep() {
        let filter = zoompan_filter(
            &[ExportZoom {
                timeline_start_ms: 0.0,
                timeline_end_ms: 1000.0,
                scale: 2.0,
                x: 0.5,
                y: 0.5,
                ramp_in_ms: 200.0,
                ramp_out_ms: 200.0,
                direction: String::new(),
                easing: "ease".to_string(),
            }],
            30.0,
        );
        assert!(filter.contains("*(3-2*("));
    }

    #[test]
    fn les_rampes_sont_bornees_a_la_moitie_de_la_duree() {
        // Meme borne que `clampZoomRampMs` cote TypeScript : au-dela, l'aller
        // et le retour se chevaucheraient et le zoom n'atteindrait jamais sa
        // valeur. Sur un zoom d'une seconde, une rampe demandee a 5 s tombe a
        // 0,5 s de chaque cote.
        let filter = zoompan_filter(
            &[ExportZoom {
                timeline_start_ms: 0.0,
                timeline_end_ms: 1000.0,
                scale: 2.0,
                x: 0.5,
                y: 0.5,
                ramp_in_ms: 5000.0,
                ramp_out_ms: 5000.0,
                direction: String::new(),
                easing: String::new(),
            }],
            30.0,
        );
        assert!(filter.contains("/0.500000"));
        assert!(!filter.contains("/5.000000"));
    }

    #[test]
    fn sans_zoom_le_filtre_est_neutre() {
        let filter = zoompan_filter(&[], 30.0);
        assert!(filter.starts_with("zoompan=z='1':x='0':y='0'"));
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
        assert!(filter.contains("enable='gte(t,0.500000)*lt(t,2.500000)'"));
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
            audio_volume_filter(&segment, 0.0),
            "volume='0.800000*min(1,max(0,(t+0.500000)/1.000000))*min(1,max(0,(5.000000-0.500000-t)/2.000000))':eval=frame"
        );
        assert_eq!(
            audio_volume_filter(&segment, 250.0),
            "volume='0.800000*min(1,max(0,(t+0.250000)/1.000000))*min(1,max(0,(5.000000-0.250000-t)/2.000000))':eval=frame"
        );
    }

    #[test]
    fn cent_dix_zooms_depassent_a_eux_seuls_la_limite_windows() {
        // Chiffres du bug réel : la ligne de commande que Windows passe à
        // `CreateProcess` est plafonnée à 32 767 caractères, et en pratique
        // l'échec constaté survenait entre 30 004 et 32 754 une fois le reste
        // de la commande compté (chemins des rushs, chaîne de concaténation,
        // etc.). Ce test mesure que ~110 zooms SEULS — bien avant MAX_SEGMENTS
        // (500) — suffisent, à eux seuls, à franchir le bas de cette fenêtre
        // d'échec : le reste de la commande n'a besoin d'ajouter presque rien
        // pour basculer. C'est justement pour ça que le graphe passe désormais
        // par un fichier (`-filter_complex_script`) : sa taille ne dépend plus
        // de rien ici, quel que soit le nombre de zooms.
        let zooms: Vec<ExportZoom> = (0..110)
            .map(|i| {
                let start = i as f64 * 1000.0;
                ExportZoom {
                    timeline_start_ms: start,
                    timeline_end_ms: start + 900.0,
                    scale: 1.6,
                    x: 0.5,
                    y: 0.5,
                    ramp_in_ms: 400.0,
                    ramp_out_ms: 400.0,
                    direction: String::new(),
                    easing: String::new(),
                }
            })
            .collect();
        let filter = zoompan_filter(&zooms, 30.0);
        const OBSERVED_FAILURE_FLOOR: usize = 30_004;
        assert!(
            filter.len() > OBSERVED_FAILURE_FLOOR,
            "attendu > {OBSERVED_FAILURE_FLOOR} caractères (bas de la fenêtre d'échec \
             observée), obtenu {} — ajuster le nombre de zooms si `zoompan_filter` \
             change de forme",
            filter.len()
        );
    }

    #[test]
    fn spawn_error_ne_blame_ffmpeg_que_si_le_binaire_manque_vraiment() {
        // Bug réel corrigé : `spawn()` rapportait TOUJOURS « FFmpeg
        // introuvable, vérifie le PATH », quelle que soit la cause — y compris
        // une ligne de commande trop longue pour `CreateProcess`, dont l'erreur
        // OS réelle sur Windows est « le nom de fichier ou l'extension est trop
        // long » (ERROR_FILENAME_EXCED_RANGE), pas « fichier introuvable ».
        let vraiment_absent =
            std::io::Error::new(std::io::ErrorKind::NotFound, "no such file or directory");
        assert_eq!(
            spawn_error("FFmpeg", &vraiment_absent),
            "FFmpeg est introuvable. Installe FFmpeg et vérifie qu'il est dans le PATH."
        );

        // N'importe quelle autre cause doit remonter le message réel de l'OS,
        // pas la fausse piste « introuvable ».
        let ligne_trop_longue = std::io::Error::new(
            std::io::ErrorKind::Other,
            "The filename or extension is too long. (os error 206)",
        );
        let message = spawn_error("FFmpeg", &ligne_trop_longue);
        assert!(!message.contains("introuvable"));
        assert!(message.contains("too long"));
    }
}
