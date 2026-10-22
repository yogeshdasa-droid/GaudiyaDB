#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod edit;
mod extract;
mod fold;
mod indexer;
mod search;
mod text;

use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_LIBRARY: &str = r"G:\Whispers\Data Bases\Obsidian";

struct AppState {
    db_path: PathBuf,
    conn: Mutex<Connection>,
    indexing: Arc<AtomicBool>,
    /// set when a re-index was requested while another one was running
    rerun: Arc<AtomicBool>,
    /// the database could not be opened (e.g. it belongs to a newer version)
    startup_error: Option<String>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    libraries: Vec<db::Library>,
    docs: i64,
    sections: i64,
    last_indexed: Option<i64>,
    indexing: bool,
    db_path: String,
    db_size: u64,
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> CmdResult<Status> {
    if let Some(e) = &state.startup_error {
        return Err(e.clone());
    }
    let conn = state.conn.lock().unwrap();
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    Ok(Status {
        libraries: db::libraries(&conn).map_err(err)?,
        docs: count("SELECT COUNT(*) FROM docs"),
        sections: count("SELECT COUNT(*) FROM sections"),
        last_indexed: db::get_meta(&conn, "last_indexed").ok().flatten().and_then(|v| v.parse().ok()),
        indexing: state.indexing.load(Ordering::SeqCst),
        db_path: state.db_path.to_string_lossy().to_string(),
        db_size: std::fs::metadata(&state.db_path).map(|m| m.len()).unwrap_or(0)
            + std::fs::metadata(state.db_path.with_extension("db-wal")).map(|m| m.len()).unwrap_or(0),
    })
}

fn allow_assets(app: &AppHandle, conn: &Connection) {
    for lib in db::libraries(conn).unwrap_or_default() {
        let _ = app.asset_protocol_scope().allow_directory(&lib.path, true);
    }
}

fn start_indexing(app: &AppHandle, full: bool) {
    let state = app.state::<AppState>();
    if state.startup_error.is_some() {
        return;
    }
    if state.indexing.swap(true, Ordering::SeqCst) {
        state.rerun.store(true, Ordering::SeqCst);
        return;
    }
    allow_assets(app, &state.conn.lock().unwrap());
    let flag = state.indexing.clone();
    let rerun = state.rerun.clone();
    let db_path = state.db_path.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut full = full;
        loop {
            let emitter = app.clone();
            let result = indexer::run(&db_path, full, |p| {
                let _ = emitter.emit("index-progress", p);
            });
            let _ = match result {
                Ok(summary) => app.emit("index-done", summary),
                Err(e) => app.emit("index-error", e),
            };
            if !rerun.swap(false, Ordering::SeqCst) {
                break;
            }
            full = false;
        }
        flag.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
async fn reindex(app: AppHandle, full: bool) -> CmdResult<()> {
    start_indexing(&app, full);
    Ok(())
}

// ---------------------------------------------------------------- libraries

#[tauri::command]
async fn add_library(app: AppHandle, state: State<'_, AppState>, path: String, name: Option<String>) -> CmdResult<i64> {
    let id = edit::add_library(&state.conn.lock().unwrap(), &path, name.as_deref())?;
    start_indexing(&app, false);
    Ok(id)
}

#[tauri::command]
async fn rename_library(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<()> {
    edit::rename_library(&state.conn.lock().unwrap(), id, &name)
}

#[tauri::command]
async fn remove_library(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    edit::remove_library(&mut state.conn.lock().unwrap(), id)
}

#[tauri::command]
async fn import_files(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    library_id: i64,
    subdir: String,
) -> CmdResult<edit::ImportResult> {
    let r = edit::import(&state.conn.lock().unwrap(), &sources, library_id, &subdir)?;
    start_indexing(&app, false);
    Ok(r)
}

// ---------------------------------------------------------------- reading

#[tauri::command]
async fn search(state: State<'_, AppState>, params: search::SearchParams) -> CmdResult<search::SearchResult> {
    let conn = state.conn.lock().unwrap();
    search::search(&conn, &params).map_err(err)
}

#[tauri::command]
async fn list_docs(state: State<'_, AppState>) -> CmdResult<Vec<search::DocListItem>> {
    search::list_docs(&state.conn.lock().unwrap()).map_err(err)
}

#[derive(Serialize)]
struct DocWithToc {
    doc: search::DocInfo,
    toc: Vec<search::TocEntry>,
}

#[tauri::command]
async fn get_doc(state: State<'_, AppState>, id: i64) -> CmdResult<DocWithToc> {
    let conn = state.conn.lock().unwrap();
    Ok(DocWithToc {
        doc: search::get_doc(&conn, id).map_err(err)?,
        toc: search::get_toc(&conn, id).map_err(err)?,
    })
}

#[tauri::command]
async fn find_doc(state: State<'_, AppState>, library_id: i64, path: String) -> CmdResult<Option<i64>> {
    search::find_doc(&state.conn.lock().unwrap(), library_id, &path).map_err(err)
}

#[tauri::command]
async fn get_sections(state: State<'_, AppState>, doc_id: i64, from: i64, to: i64) -> CmdResult<Vec<search::SectionText>> {
    search::get_sections(&state.conn.lock().unwrap(), doc_id, from, to).map_err(err)
}

#[tauri::command]
async fn resolve_link(state: State<'_, AppState>, target: String) -> CmdResult<search::LinkTarget> {
    search::resolve_link(&state.conn.lock().unwrap(), &target).map_err(err)
}

#[tauri::command]
async fn resolve_attachments(state: State<'_, AppState>, names: Vec<String>) -> CmdResult<Vec<Option<String>>> {
    let conn = state.conn.lock().unwrap();
    names.iter().map(|n| search::resolve_attachment(&conn, n).map_err(err)).collect()
}

// ---------------------------------------------------------------- editing

#[tauri::command]
async fn save_section(state: State<'_, AppState>, doc_id: i64, ordinal: i64, text: String) -> CmdResult<i64> {
    edit::save_section(&mut state.conn.lock().unwrap(), doc_id, ordinal, &text)
}

#[tauri::command]
async fn update_meta(state: State<'_, AppState>, doc_id: i64, title: String, date: String) -> CmdResult<i64> {
    edit::update_meta(&mut state.conn.lock().unwrap(), doc_id, &title, &date)
}

#[tauri::command]
async fn exclude_doc(state: State<'_, AppState>, doc_id: i64) -> CmdResult<()> {
    edit::exclude_doc(&mut state.conn.lock().unwrap(), doc_id)
}

#[tauri::command]
async fn trash_doc(state: State<'_, AppState>, doc_id: i64) -> CmdResult<()> {
    edit::trash_doc(&mut state.conn.lock().unwrap(), doc_id)
}

#[tauri::command]
async fn list_excluded(state: State<'_, AppState>) -> CmdResult<Vec<edit::Excluded>> {
    edit::list_excluded(&state.conn.lock().unwrap())
}

#[tauri::command]
async fn restore_excluded(state: State<'_, AppState>, library_id: i64, path: String) -> CmdResult<Option<i64>> {
    edit::restore_excluded(&mut state.conn.lock().unwrap(), library_id, &path)
}

// ---------------------------------------------------------------- bookmarks

#[tauri::command]
async fn list_bookmarks(state: State<'_, AppState>) -> CmdResult<Vec<search::Bookmark>> {
    search::list_bookmarks(&state.conn.lock().unwrap()).map_err(err)
}

#[tauri::command]
async fn add_bookmark(state: State<'_, AppState>, doc_id: i64, ordinal: i64, note: String) -> CmdResult<i64> {
    search::add_bookmark(&state.conn.lock().unwrap(), doc_id, ordinal, &note).map_err(err)
}

#[tauri::command]
async fn update_bookmark(state: State<'_, AppState>, id: i64, note: String) -> CmdResult<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("UPDATE bookmarks SET note = ?1 WHERE id = ?2", rusqlite::params![note, id])
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
async fn delete_bookmark(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", [id]).map(|_| ()).map_err(err)
}

// ---------------------------------------------------------------- shell

#[tauri::command]
async fn open_external(app: AppHandle, target: String) -> CmdResult<()> {
    if ["http://", "https://", "obsidian://", "mailto:"].iter().any(|p| target.starts_with(p)) {
        app.opener().open_url(target, None::<&str>).map_err(err)
    } else {
        app.opener().open_path(target, None::<&str>).map_err(err)
    }
}

#[tauri::command]
async fn reveal_file(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
async fn path_kinds(paths: Vec<String>) -> CmdResult<Vec<&'static str>> {
    Ok(paths
        .iter()
        .map(|p| {
            let p = Path::new(p);
            if p.is_dir() {
                "dir"
            } else if extract::is_indexable(p) {
                "text"
            } else {
                "other"
            }
        })
        .collect())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("library.db");
            let conn = db::open(&db_path)?;
            // A database problem is shown in the window instead of closing silently.
            let startup_error = db::init(&conn).err();
            if startup_error.is_none() && db::libraries(&conn)?.is_empty() && Path::new(DEFAULT_LIBRARY).is_dir() {
                let _ = edit::add_library(&conn, DEFAULT_LIBRARY, None);
            }
            let ok = startup_error.is_none();
            app.manage(AppState {
                db_path,
                conn: Mutex::new(conn),
                indexing: Arc::new(AtomicBool::new(false)),
                rerun: Arc::new(AtomicBool::new(false)),
                startup_error,
            });
            // Pick up changes made in Obsidian since the last run.
            if ok {
                start_indexing(app.handle(), false);
            }
            // The window starts hidden and the page shows it once the splash
            // is painted; this is only a safety net if that never happens.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            reindex,
            add_library,
            rename_library,
            remove_library,
            import_files,
            search,
            list_docs,
            get_doc,
            find_doc,
            get_sections,
            resolve_link,
            resolve_attachments,
            save_section,
            update_meta,
            exclude_doc,
            trash_doc,
            list_excluded,
            restore_excluded,
            list_bookmarks,
            add_bookmark,
            update_bookmark,
            delete_bookmark,
            open_external,
            reveal_file,
            path_kinds
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gaudiya Database");
}
