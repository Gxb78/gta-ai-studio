// GTA Studio — backend local minimal.
// Rôle : préparer les médias (proxy, vignettes, waveform), sauvegarder les
// projets JSON et exporter la timeline. Aucune logique d'édition ici :
// la boucle d'interaction vit entièrement côté frontend.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hardware;
mod media;
mod media_tools;
mod project;

#[cfg(debug_assertions)]
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            media_tools::initialize(app.handle());
            // Écran noir au lancement sans le moindre indice dans le terminal
            // (les erreurs JS de la webview n'y remontent jamais) : ouvrir les
            // DevTools d'office en debug évite d'avoir à deviner le clic droit.
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media::import_source,
            media::cancel_import,
            media::export_timeline,
            media::cancel_export,
            media::reveal_path,
            hardware::hardware_capabilities,
            project::save_project,
            project::load_last_project,
            project::load_project,
            project::list_projects,
            project::paths_exist,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de GTA Studio");
}
