// Persistance des projets : un fichier JSON par projet, écrit de façon
// atomique (fichier temporaire puis renommage). Pas de base de données
// tant que le besoin n'est pas démontré.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use tauri::AppHandle;

use crate::media::{data_root, SourceInfo};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    /// Absent dans les projets écrits avant le positionnement libre : le front
    /// recalcule alors la position par cumul des durées.
    #[serde(default)]
    pub timeline_start_ms: Option<f64>,
    /// Absent dans les projets mono-rush : le front rattache alors le clip à
    /// l'unique rush du projet.
    #[serde(default)]
    pub source_id: Option<String>,
    pub src_in_ms: f64,
    pub src_out_ms: f64,
    /// TOUT le reste du clip, conservé tel quel.
    ///
    /// Ce backend ne fait que relayer le montage vers le disque : il n'a aucune
    /// raison de connaître la piste, le son ou la vitesse d'un clip. Énumérer
    /// ces champs ici reviendrait à devoir les tenir à jour à chaque évolution
    /// du modèle, et tout oubli SUPPRIMERAIT silencieusement la donnée à la
    /// sauvegarde. Le fourre-tout garantit que c'est structurellement impossible.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    /// Format mono-rush (versions 1 et 2). Conservé en lecture seule pour que
    /// les projets déjà enregistrés restent ouvrables ; le front les migre.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceInfo>,
    /// Format multi-rush (version 3), indexé par empreinte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<HashMap<String, SourceInfo>>,
    pub clips: Vec<Clip>,
    pub created_at: String,
    pub updated_at: String,
    /// Même principe qu'au niveau du clip : tout réglage de projet ajouté par
    /// l'interface traverse la sauvegarde sans que ce fichier ait à le connaître.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Fiche courte d'un projet, pour la liste « Projets récents ».
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub clip_count: usize,
    pub thumb_path: Option<String>,
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Rushs du projet, tous formats confondus.
fn project_sources(project: &Project) -> Vec<&SourceInfo> {
    let mut all: Vec<&SourceInfo> = Vec::new();
    if let Some(source) = &project.source {
        all.push(source);
    }
    if let Some(sources) = &project.sources {
        all.extend(sources.values());
    }
    all
}

/// Vrai si tous les proxys du projet sont encore sur le disque.
///
/// Sans proxy, il n'y a rien à lire ni à scrubber : le projet n'est pas
/// ouvrable tel quel. Le rush d'origine, lui, peut manquer sans empêcher le
/// montage — c'est l'interface qui propose alors de le relocaliser.
fn proxies_present(project: &Project) -> bool {
    let sources = project_sources(project);
    !sources.is_empty()
        && sources
            .iter()
            .all(|s| std::path::Path::new(&s.proxy_path).is_file())
}

fn read_project(dir: &std::path::Path, id: &str) -> Option<Project> {
    let path = dir.join(format!("{id}.json"));
    let raw = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Project>(&raw) {
        Ok(project) => Some(project),
        Err(error) => {
            eprintln!("Projet illisible ({}) : {error}", path.display());
            None
        }
    }
}

#[tauri::command]
pub fn save_project(app: AppHandle, project: Project) -> Result<(), String> {
    if !is_safe_id(&project.id) {
        return Err("Identifiant de projet invalide.".into());
    }
    let dir = data_root(&app)?.join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("Dossier projets inaccessible : {e}"))?;

    let payload = serde_json::to_vec_pretty(&project).map_err(|e| format!("Sérialisation : {e}"))?;
    let target = dir.join(format!("{}.json", project.id));
    let temp = dir.join(format!("{}.json.tmp", project.id));
    fs::write(&temp, payload).map_err(|e| format!("Écriture du projet impossible : {e}"))?;
    fs::rename(&temp, &target).map_err(|e| format!("Finalisation du projet impossible : {e}"))?;

    fs::write(dir.join("_last"), project.id.as_bytes())
        .map_err(|e| format!("Mémorisation du dernier projet impossible : {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_last_project(app: AppHandle) -> Result<Option<Project>, String> {
    let dir = data_root(&app)?.join("projects");
    let pointer = dir.join("_last");
    let Ok(id) = fs::read_to_string(&pointer) else {
        return Ok(None);
    };
    let id = id.trim().to_string();
    if !is_safe_id(&id) {
        return Ok(None);
    }
    let path = dir.join(format!("{id}.json"));
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    match serde_json::from_str::<Project>(&raw) {
        Ok(project) => {
            // Si le cache (proxy) a été nettoyé entre-temps, on repart de l'import.
            if proxies_present(&project) {
                Ok(Some(project))
            } else {
                Ok(None)
            }
        }
        Err(error) => {
            eprintln!("Projet illisible ({}) : {error}", path.display());
            Ok(None)
        }
    }
}

/// Ouvre un projet désigné et le note comme dernier projet ouvert.
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<Option<Project>, String> {
    if !is_safe_id(&id) {
        return Err("Identifiant de projet invalide.".into());
    }
    let dir = data_root(&app)?.join("projects");
    let Some(project) = read_project(&dir, &id) else {
        return Err("Projet illisible ou introuvable.".into());
    };
    if !proxies_present(&project) {
        return Err(
            "Les fichiers de montage de ce projet ont été nettoyés : réimporte le rush.".into(),
        );
    }
    let _ = fs::write(dir.join("_last"), id.as_bytes());
    Ok(Some(project))
}

/// Projets enregistrés, du plus récemment modifié au plus ancien.
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let dir = data_root(&app)?.join("projects");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut summaries: Vec<ProjectSummary> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_safe_id(id) {
            continue;
        }
        let Some(project) = read_project(&dir, id) else {
            continue;
        };
        // Vignette du premier rush : une liste de projets sans image ne dit rien.
        let thumb_path = project_sources(&project)
            .first()
            .and_then(|s| s.thumb_paths.first().cloned())
            .filter(|p| std::path::Path::new(p).is_file());
        summaries.push(ProjectSummary {
            id: project.id.clone(),
            name: project.name.clone(),
            updated_at: project.updated_at.clone(),
            clip_count: project.clips.len(),
            thumb_path,
        });
    }
    // Tri sur la date ISO 8601 : l'ordre lexicographique est l'ordre chronologique.
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Existence de chacun des chemins donnés, dans le même ordre.
///
/// Sert à repérer un rush d'origine déplacé ou supprimé : le montage reste
/// lisible sur le proxy, mais l'export échouerait.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un projet écrit par l'interface doit ressortir du disque à l'identique.
    ///
    /// Ce backend ne connaît ni les pistes, ni le son, ni la vitesse : le test
    /// vérifie qu'il n'a justement PAS besoin de les connaître pour les
    /// conserver. C'est la garantie qui manquait — un montage multipiste
    /// revenait à plat après un redémarrage.
    #[test]
    fn un_projet_traverse_la_sauvegarde_sans_rien_perdre() {
        let brut = r#"{
            "version": 3,
            "id": "projet-1",
            "name": "braquage",
            "framingMode": "blur",
            "sources": {},
            "clips": [
                {
                    "id": "c1",
                    "sourceId": "rushA",
                    "track": 2,
                    "timelineStartMs": 1500,
                    "srcInMs": 0,
                    "srcOutMs": 4000,
                    "audioEnabled": false,
                    "playbackRate": 2,
                    "cropX": -0.5
                }
            ],
            "createdAt": "a",
            "updatedAt": "b"
        }"#;

        let projet: Project = serde_json::from_str(brut).expect("lecture");
        let relu: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&projet).expect("écriture")).unwrap();

        let clip = &relu["clips"][0];
        assert_eq!(clip["track"], 2, "la piste doit survivre");
        assert_eq!(clip["audioEnabled"], false, "l'état muet doit survivre");
        assert_eq!(clip["playbackRate"], 2, "la vitesse doit survivre");
        assert_eq!(clip["cropX"], -0.5, "un champ futur doit survivre aussi");
        assert_eq!(clip["sourceId"], "rushA");
        assert_eq!(clip["timelineStartMs"], 1500.0, "champ typé f64 : revient en flottant");
        assert_eq!(
            relu["framingMode"], "blur",
            "un réglage de projet inconnu du backend doit survivre"
        );
    }

    /// Les projets d'avant le multipiste n'ont aucun de ces champs : ils
    /// doivent rester lisibles, la migration côté interface s'en charge.
    #[test]
    fn un_projet_ancien_reste_lisible() {
        let brut = r#"{
            "version": 1,
            "id": "vieux",
            "name": "v1",
            "clips": [{ "id": "c1", "srcInMs": 0, "srcOutMs": 1000 }],
            "createdAt": "a",
            "updatedAt": "b"
        }"#;
        let projet: Project = serde_json::from_str(brut).expect("lecture");
        assert_eq!(projet.clips.len(), 1);
        assert!(projet.clips[0].timeline_start_ms.is_none());
        assert!(projet.clips[0].extra.is_empty());
    }
}
