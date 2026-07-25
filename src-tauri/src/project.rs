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
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
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
            // Il suffit qu'un rush ait perdu son proxy pour que le projet ne
            // soit plus lisible tel quel.
            let mut proxies: Vec<&str> = Vec::new();
            if let Some(source) = &project.source {
                proxies.push(&source.proxy_path);
            }
            if let Some(sources) = &project.sources {
                proxies.extend(sources.values().map(|s| s.proxy_path.as_str()));
            }
            if !proxies.is_empty() && proxies.iter().all(|p| std::path::Path::new(p).is_file()) {
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
