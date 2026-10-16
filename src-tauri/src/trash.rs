//! Whole projects and chapters go to the OS trash so deletion can be undone.
//! Unlike plugin-fs, our command has no path scope supplied by the webview.
//! Validate here, before calling the OS: only an existing absolute directory
//! with its own library marker is eligible, never a file or an arbitrary tree.

use std::path::Path;

fn move_to_trash(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Trash needs an absolute path".into());
    }
    let dir = path.canonicalize().map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err("Only a project or chapter directory can be trashed".into());
    }
    if !dir.join("project.json").is_file() && !dir.join("chapter.json").is_file() {
        return Err("Directory has no project.json or chapter.json marker".into());
    }
    trash::delete(dir).map_err(|e| e.to_string())
}

/// The OS operation can block; keep it off the async runtime, like fsync_path.
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_to_trash(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::move_to_trash;
    use std::path::Path;

    #[test]
    fn refuses_relative_paths() {
        assert!(move_to_trash(Path::new("relative/chapter")).is_err());
    }

    #[test]
    fn refuses_files() {
        let file = std::env::temp_dir().join(format!("mt-trash-file-{}", std::process::id()));
        std::fs::write(&file, b"{}").unwrap();
        assert!(move_to_trash(&file).is_err());
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn refuses_directories_without_markers() {
        let dir = std::env::temp_dir().join(format!("mt-trash-unmarked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(move_to_trash(&dir).is_err());
        std::fs::remove_dir(dir).unwrap();
    }
}
