use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BackendProcess(Mutex<Option<CommandChild>>);

fn backend_is_available() -> bool {
    let address: SocketAddr = "127.0.0.1:8765".parse().expect("valid API address");
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if !backend_is_available() {
                let data_dir = app.path().app_local_data_dir()?;
                std::fs::create_dir_all(&data_dir)?;
                let data_dir_text = data_dir.to_string_lossy().into_owned();
                let sidecar = app
                    .shell()
                    .sidecar("gta-studio-api")?
                    .args([
                        "--host",
                        "127.0.0.1",
                        "--port",
                        "8765",
                        "--data-dir",
                        &data_dir_text,
                    ]);
                let (mut events, child) = sidecar.spawn()?;
                *app.state::<BackendProcess>().0.lock().expect("backend state lock") = Some(child);
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                println!("[gta-studio-api] {}", String::from_utf8_lossy(&bytes));
                            }
                            CommandEvent::Stderr(bytes) => {
                                eprintln!("[gta-studio-api] {}", String::from_utf8_lossy(&bytes));
                            }
                            _ => {}
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(child) = window
                    .state::<BackendProcess>()
                    .0
                    .lock()
                    .expect("backend state lock")
                    .take()
                {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running GTA AI Studio");
}
