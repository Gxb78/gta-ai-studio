// GTA Studio — backend local minimal.
// Rôle : préparer les médias (proxy, vignettes, waveform), sauvegarder les
// projets JSON et exporter la timeline. Aucune logique d'édition ici :
// la boucle d'interaction vit entièrement côté frontend.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod media;
mod project;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            media::import_source,
            media::export_timeline,
            media::reveal_path,
            project::save_project,
            project::load_last_project,
            project::load_project,
            project::list_projects,
            project::paths_exist,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de GTA Studio");
}
