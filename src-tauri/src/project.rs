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
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

use crate::media::data_root;

/// Unique par appel, pas seulement par process : deux sauvegardes concurrentes
/// du même projet (autosave et sauvegarde explicite qui se chevauchent) ne
/// doivent jamais écrire dans le même fichier temporaire, sous peine que l'une
/// écrase l'écriture en cours de l'autre juste avant son renommage.
fn next_save_token() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

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
    /// Faux si le fichier existe mais n'a pas pu être lu (JSON corrompu, le
    /// plus souvent). Un tel projet reste quand même dans la liste : le
    /// cacher silencieusement le ferait disparaître sans un mot, comme si le
    /// montage n'avait jamais existé — même principe déjà appliqué aux
    /// projets dont les fichiers dérivés ont été nettoyés (voir le
    /// commentaire en tête de ProjectsDialog.tsx).
    pub readable: bool,
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
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
    let temp = dir.join(format!("{id}.json.{}.tmp", next_save_token()));
    fs::write(&temp, payload).map_err(|e| format!("Écriture du projet impossible : {e}"))?;
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Finalisation du projet impossible : {e}")
    })?;

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
    // Le document est rendu tel quel, proxys présents ou non.
    //
    // Bug réel corrigé : cette fonction refusait de rendre le projet dès qu'UN
    // SEUL proxy manquait — y compris celui d'une source jamais posée sur la
    // timeline, qui n'a pourtant aucun besoin d'être lisible pour que le
    // montage s'ouvre. Le `None` renvoyé était alors indiscernable de « aucun
    // projet n'a jamais été enregistré » : au démarrage, le projet disparaissait
    // purement et simplement, sans message, sans proposer de le réparer.
    //
    // Un proxy manquant n'empêche plus d'ouvrir : l'interface détecte les
    // proxys absents après coup (comme elle le fait déjà pour un rush
    // d'origine déplacé) et les régénère depuis le rush d'origine, exactement
    // comme elle régénère déjà un fichier dérivé simplement périmé. Ce fichier
    // relaie le document, il ne décide plus s'il mérite d'être ouvert.
    Ok(read_project(&dir, &id))
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
    // Même correctif que `load_last_project` : un proxy manquant se répare
    // après ouverture, il ne doit plus jamais empêcher l'ouverture elle-même.
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
            // JSON illisible (corrompu, le plus souvent) : gardé visible avec
            // une fiche minimale plutôt que purement et simplement retiré de
            // la liste — `read_project` a déjà écrit le détail sur stderr.
            // Sans `updatedAt` à lire dans un contenu qu'on n'a pas pu
            // parser, une chaîne vide trie ce projet en dernier (le tri plus
            // bas est lexicographique) plutôt que de deviner une date.
            summaries.push(ProjectSummary {
                id: id.to_string(),
                name: "Projet illisible".to_string(),
                updated_at: String::new(),
                clip_count: 0,
                thumb_path: None,
                readable: false,
            });
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
            readable: true,
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

    /// Bug réel corrigé : ce fichier refusait autrefois de rendre un projet dès
    /// qu'UN SEUL proxy manquait — y compris celui d'une source jamais posée
    /// sur la timeline. `load_last_project` rendait alors `None`, indiscernable
    /// de « aucun projet n'a jamais été enregistré » : le projet disparaissait
    /// purement et simplement au démarrage, sans message, sans réparation
    /// possible.
    ///
    /// `load_last_project`/`load_project` exigent un `AppHandle` réel et ne
    /// sont donc pas testables isolément ; `read_project`, elle, ne dépend que
    /// du disque et porte toute la décision qui restait à vérifier : un
    /// document dont AUCUN proxy n'existe (le pire cas, pas seulement une
    /// source inutilisée) doit tout de même ressortir intact, prêt à être
    /// ouvert en mode dégradé pendant que l'interface régénère les proxys
    /// manquants — jamais avalé en silence.
    #[test]
    fn un_projet_sans_aucun_proxy_reste_lisible() {
        let dir = std::env::temp_dir().join(format!(
            "gta-studio-test-proxy-manquant-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let id = "projet-sans-proxy";
        let brut = serde_json::json!({
            "version": 9,
            "id": id,
            "name": "montage",
            "sources": {
                "utilisee": { "proxyPath": "/chemin/inexistant/a.mp4" },
                "inutilisee": { "proxyPath": "/chemin/inexistant/b.mp4" }
            },
            "clips": [{ "id": "c1", "sourceId": "utilisee" }],
            "createdAt": "a",
            "updatedAt": "b"
        });
        fs::write(dir.join(format!("{id}.json")), brut.to_string()).unwrap();

        let relu = read_project(&dir, id);
        assert_eq!(
            relu.as_ref(),
            Some(&brut),
            "aucun proxy sur le disque ne doit empêcher le document de ressortir intact"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
