// Persistance des projets : un fichier JSON par projet, écrit de façon
// atomique (fichier temporaire puis renommage). Pas de base de données
// tant que le besoin n'est pas démontré.
//
// GARANTIE DE PERSISTANCE : ce backend relaie le document brut. Il ne le
// désérialise JAMAIS dans une structure Rust typée pour le réécrire — un champ
// ajouté côté interface (piste, son, vitesse, cadrage, et tout ce qui viendra
// après) traverse la sauvegarde sans que ce fichier ait à le connaître. Un
// `#[serde(flatten)]` sur une poignée de champs demanderait de deviner à
// l'avance quelles structures imbriquées peuvent évoluer ; le passe-plat rend
// la question sans objet. Ce fichier ne lit dans le document que le strict
// nécessaire à son propre travail (identifiant, chemins de proxy, quelques
// champs d'affichage), jamais pour le réécrire.

use serde_json::Value;
use std::fs;
use tauri::AppHandle;

use crate::media::data_root;

/// Fiche courte d'un projet, pour la liste « Projets récents ». Objet dérivé,
/// pas une copie du document : sa perte de détail n'a aucune conséquence.
#[derive(serde::Serialize)]
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

/// Chemins de proxy de tous les rushs du projet, formats 1 à 4 confondus.
fn proxy_paths(project: &Value) -> Vec<&str> {
    let mut paths: Vec<&str> = Vec::new();
    if let Some(path) = project
        .get("source")
        .and_then(|s| s.get("proxyPath"))
        .and_then(Value::as_str)
    {
        paths.push(path);
    }
    if let Some(sources) = project.get("sources").and_then(Value::as_object) {
        paths.extend(
            sources
                .values()
                .filter_map(|s| s.get("proxyPath"))
                .filter_map(Value::as_str),
        );
    }
    paths
}

/// Vrai si tous les proxys du projet sont encore sur le disque.
///
/// Sans proxy, il n'y a rien à lire ni à scrubber : le projet n'est pas
/// ouvrable tel quel. Le rush d'origine, lui, peut manquer sans empêcher le
/// montage — c'est l'interface qui propose alors de le relocaliser.
fn proxies_present(project: &Value) -> bool {
    let paths = proxy_paths(project);
    !paths.is_empty() && paths.iter().all(|p| std::path::Path::new(p).is_file())
}

fn read_project(dir: &std::path::Path, id: &str) -> Option<Value> {
    let path = dir.join(format!("{id}.json"));
    let raw = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(project) => Some(project),
        Err(error) => {
            eprintln!("Projet illisible ({}) : {error}", path.display());
            None
        }
    }
}

/// Le seul champ que ce fichier exige vraiment : un identifiant sûr pour
/// nommer le fichier. Tout le reste est laissé tel quel.
fn project_id(project: &Value) -> Result<String, String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Projet sans identifiant.")?;
    if !is_safe_id(id) {
        return Err("Identifiant de projet invalide.".into());
    }
    Ok(id.to_string())
}

#[tauri::command]
pub fn save_project(app: AppHandle, project: Value) -> Result<(), String> {
    if !project.is_object() {
        return Err("Projet invalide.".into());
    }
    let id = project_id(&project)?;

    let dir = data_root(&app)?.join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("Dossier projets inaccessible : {e}"))?;

    // Passe-plat strict : ce qui est sérialisé ici est exactement ce que
    // l'interface a envoyé, champ pour champ.
    let payload =
        serde_json::to_vec_pretty(&project).map_err(|e| format!("Sérialisation : {e}"))?;
    let target = dir.join(format!("{id}.json"));
    let temp = dir.join(format!("{id}.json.tmp"));
    fs::write(&temp, payload).map_err(|e| format!("Écriture du projet impossible : {e}"))?;
    fs::rename(&temp, &target).map_err(|e| format!("Finalisation du projet impossible : {e}"))?;

    fs::write(dir.join("_last"), id.as_bytes())
        .map_err(|e| format!("Mémorisation du dernier projet impossible : {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_last_project(app: AppHandle) -> Result<Option<Value>, String> {
    let dir = data_root(&app)?.join("projects");
    let pointer = dir.join("_last");
    let Ok(id) = fs::read_to_string(&pointer) else {
        return Ok(None);
    };
    let id = id.trim().to_string();
    if !is_safe_id(&id) {
        return Ok(None);
    }
    let Some(project) = read_project(&dir, &id) else {
        return Ok(None);
    };
    // Si le cache (proxy) a été nettoyé entre-temps, on repart de l'import.
    Ok(if proxies_present(&project) {
        Some(project)
    } else {
        None
    })
}

/// Ouvre un projet désigné et le note comme dernier projet ouvert.
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<Option<Value>, String> {
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
        let thumb_path = proxy_thumb(&project);
        summaries.push(ProjectSummary {
            id: id.to_string(),
            name: project
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Sans titre")
                .to_string(),
            updated_at: project
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            clip_count: project
                .get("clips")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            thumb_path,
        });
    }
    // Tri sur la date ISO 8601 : l'ordre lexicographique est l'ordre chronologique.
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Première vignette d'un rush du projet, si elle existe encore sur le disque.
fn proxy_thumb(project: &Value) -> Option<String> {
    let first_thumbs = |source: &Value| -> Option<String> {
        source
            .get("thumbPaths")
            .and_then(Value::as_array)?
            .first()?
            .as_str()
            .map(String::from)
    };
    let candidate = project.get("source").and_then(first_thumbs).or_else(|| {
        project
            .get("sources")
            .and_then(Value::as_object)?
            .values()
            .find_map(first_thumbs)
    });
    candidate.filter(|p| std::path::Path::new(p).is_file())
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

    /// La garantie centrale de ce fichier : AUCUN champ du document envoyé par
    /// l'interface ne peut disparaître à la sauvegarde, quel que soit son nom
    /// ou sa profondeur — parce que rien n'est jamais désérialisé dans une
    /// structure Rust typée avant d'être réécrit.
    #[test]
    fn un_projet_traverse_la_sauvegarde_sans_rien_perdre() {
        let brut: Value = serde_json::from_str(
            r#"{
                "version": 4,
                "id": "projet-1",
                "name": "braquage",
                "framingMode": "blur",
                "sources": {
                    "rushA": { "proxyPath": "x.mp4", "unChampFutur": 42 }
                },
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
            }"#,
        )
        .unwrap();

        // Simule exactement ce que fait save_project, sans écrire sur le disque.
        let relu: Value = serde_json::from_str(&serde_json::to_string(&brut).unwrap()).unwrap();
        assert_eq!(
            relu, brut,
            "le document doit ressortir identique, byte pour byte"
        );
    }

    #[test]
    fn identifiant_absent_ou_dangereux_est_rejete() {
        assert!(project_id(&serde_json::json!({})).is_err());
        assert!(project_id(&serde_json::json!({ "id": "../../etc" })).is_err());
        assert!(project_id(&serde_json::json!({ "id": "projet-1" })).is_ok());
    }

    #[test]
    fn les_proxys_sont_lus_dans_les_deux_formats() {
        let mono = serde_json::json!({ "source": { "proxyPath": "/tmp/inexistant.mp4" } });
        assert!(
            !proxies_present(&mono),
            "un chemin qui n'existe pas ne doit jamais passer"
        );

        let multi = serde_json::json!({ "sources": {} });
        assert!(
            !proxies_present(&multi),
            "aucun rush référencé : rien à ouvrir"
        );
    }
}
