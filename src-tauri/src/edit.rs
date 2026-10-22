//! Write-side operations: libraries, importing files, editing documents and
//! removing them from the index or the disk.

use crate::indexer::{abs_path, delete_doc, refresh_paths, set_doc_title_fts};
use crate::{db, text};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

type Res<T> = Result<T, String>;

fn e(x: impl std::fmt::Display) -> String {
    x.to_string()
}

fn doc_location(conn: &Connection, doc_id: i64) -> Res<(i64, String, String)> {
    let (lib, rel): (i64, String) = conn
        .query_row("SELECT library_id, path FROM docs WHERE id = ?1", [doc_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?;
    let root = db::library_path(conn, lib).map_err(e)?;
    Ok((lib, rel, root))
}

// ---------------------------------------------------------------- libraries

pub fn add_library(conn: &Connection, path: &str, name: Option<&str>) -> Res<i64> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("No existe la carpeta: {path}"));
    }
    let canon = path.trim_end_matches(['\\', '/']).to_string();
    let name = name.map(str::trim).filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| db::default_name(&canon));
    conn.execute("INSERT INTO libraries(path, name) VALUES(?1, ?2)", params![canon, name])
        .map_err(|err| if err.to_string().contains("UNIQUE") { "Esa carpeta ya estÃ¡ en la biblioteca".to_string() } else { e(err) })?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_library(conn: &Connection, id: i64, name: &str) -> Res<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("El nombre no puede estar vacÃ­o".into());
    }
    conn.execute("UPDATE libraries SET name = ?1 WHERE id = ?2", params![name, id]).map_err(e)?;
    Ok(())
}

/// Removes a library and its documents from the index. Files are untouched.
pub fn remove_library(conn: &mut Connection, id: i64) -> Res<()> {
    let tx = conn.transaction().map_err(e)?;
    let ids: Vec<i64> = {
        let mut st = tx.prepare("SELECT id FROM docs WHERE library_id = ?1").map_err(e)?;
        let rows = st.query_map([id], |r| r.get(0)).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)?
    };
    for d in ids {
        delete_doc(&tx, d).map_err(e)?;
    }
    for t in ["excluded", "overrides"] {
        tx.execute(&format!("DELETE FROM {t} WHERE library_id = ?1"), [id]).map_err(e)?;
    }
    tx.execute("DELETE FROM libraries WHERE id = ?1", [id]).map_err(e)?;
    tx.commit().map_err(e)
}

// ---------------------------------------------------------------- import

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub files: usize,
    pub texts: usize,
    pub dest: String,
}

fn unique_target(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let parent = dest.parent().unwrap_or(Path::new("."));
    (2..)
        .map(|n| parent.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn copy_into(src: &Path, dest_dir: &Path, out: &mut ImportResult) -> std::io::Result<()> {
    let name = src.file_name().unwrap_or_default();
    if src.is_dir() {
        let target = unique_target(&dest_dir.join(name));
        std::fs::create_dir_all(&target)?;
        for entry in std::fs::read_dir(src)? {
            copy_into(&entry?.path(), &target, out)?;
        }
    } else if src.is_file() {
        let target = unique_target(&dest_dir.join(name));
        std::fs::copy(src, &target)?;
        out.files += 1;
        if crate::extract::is_indexable(&target) {
            out.texts += 1;
        }
    }
    Ok(())
}

/// Copies files / folders into `library/subdir`. Indexing is done afterwards
/// by the regular incremental pass.
pub fn import(conn: &Connection, sources: &[String], library_id: i64, subdir: &str) -> Res<ImportResult> {
    let root = db::library_path(conn, library_id).map_err(e)?;
    let sub = subdir.trim().trim_matches(['\\', '/']);
    if sub.split(['\\', '/']).any(|p| p == "..") {
        return Err("Subcarpeta no vÃ¡lida".into());
    }
    let dest = if sub.is_empty() { PathBuf::from(&root) } else { Path::new(&root).join(sub) };
    std::fs::create_dir_all(&dest).map_err(e)?;
    let mut out = ImportResult { files: 0, texts: 0, dest: dest.to_string_lossy().to_string() };
    for s in sources {
        let src = Path::new(s);
        if dest.starts_with(src) {
            return Err(format!("No se puede copiar una carpeta dentro de sÃ­ misma: {s}"));
        }
        copy_into(src, &dest, &mut out).map_err(|err| format!("{s}: {err}"))?;
    }
    Ok(out)
}

// ---------------------------------------------------------------- editing

fn valid_date(d: &str) -> bool {
    let parts: Vec<&str> = d.split('-').collect();
    let num = |s: &str, len: usize| s.len() == len && s.chars().all(|c| c.is_ascii_digit());
    match parts.as_slice() {
        [y] => num(y, 4),
        [y, m] => num(y, 4) && num(m, 2),
        [y, m, dd] => num(y, 4) && num(m, 2) && num(dd, 2),
        _ => false,
    }
}

/// Title / date shown in the app. Empty values go back to the automatic ones.
pub fn update_meta(conn: &mut Connection, doc_id: i64, title: &str, date: &str) -> Res<i64> {
    let (lib, rel, _) = doc_location(conn, doc_id)?;
    let title = title.trim();
    let date = date.trim();
    if !date.is_empty() && !valid_date(date) {
        return Err("Fecha no vÃ¡lida: usa AAAA, AAAA-MM o AAAA-MM-DD".into());
    }
    let t = (!title.is_empty()).then_some(title);
    let d = (!date.is_empty()).then_some(date);
    if t.is_none() && d.is_none() {
        conn.execute("DELETE FROM overrides WHERE library_id = ?1 AND path = ?2", params![lib, rel]).map_err(e)?;
    } else {
        conn.execute(
            "INSERT INTO overrides(library_id, path, title, date) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(library_id, path) DO UPDATE SET title = excluded.title, date = excluded.date",
            params![lib, rel, t, d],
        )
        .map_err(e)?;
    }
    if t.is_some() && d.is_some() {
        // Fast path: no need to parse the file again.
        let tx = conn.transaction().map_err(e)?;
        let dir: String = tx.query_row("SELECT dir FROM docs WHERE id = ?1", [doc_id], |r| r.get(0)).map_err(e)?;
        tx.execute(
            "UPDATE docs SET title = ?1, date = ?2, year = ?3 WHERE id = ?4",
            params![title, date, date[..4].parse::<i32>().ok(), doc_id],
        )
        .map_err(e)?;
        set_doc_title_fts(&tx, doc_id, title, &dir).map_err(e)?;
        tx.commit().map_err(e)?;
        return Ok(doc_id);
    }
    refresh_paths(conn, lib, &[rel]).map_err(e)?[0].ok_or_else(|| "Documento no encontrado".into())
}

/// Replaces the text of one section in the original file and re-indexes it.
/// Returns the document's new id.
pub fn save_section(conn: &mut Connection, doc_id: i64, ordinal: i64, new_text: &str) -> Res<i64> {
    let (lib, rel, root) = doc_location(conn, doc_id)?;
    let old: String = conn
        .query_row("SELECT text FROM sections WHERE doc_id = ?1 AND ordinal = ?2", params![doc_id, ordinal], |r| r.get(0))
        .map_err(e)?;
    let abs = abs_path(&root, &rel);
    if !crate::extract::is_editable(&abs) {
        return Err("Solo se puede editar el texto de archivos .md y .txt (los PDF y Word no).".into());
    }
    let bytes = std::fs::read(&abs).map_err(e)?;
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let crlf = bytes.windows(2).any(|w| w == b"\r\n");
    let content = text::decode(&bytes);

    let old_t = old.trim_end();
    let new_t = new_text.replace("\r\n", "\n");
    let new_t = new_t.trim_end();
    let updated = if old_t.trim().is_empty() {
        new_t.to_string()
    } else {
        match content.matches(old_t).count() {
            1 => content.replacen(old_t, new_t, 1),
            0 => return Err("El archivo cambiÃ³ fuera del programa. Actualiza el Ã­ndice y vuelve a intentarlo.".into()),
            _ => return Err("Esta secciÃ³n aparece repetida en el archivo; edÃ­tala en Obsidian.".into()),
        }
    };
    let mut out = if crlf { updated.replace('\n', "\r\n") } else { updated };
    if bom {
        out.insert(0, '\u{FEFF}');
    }
    let tmp = abs.with_extension("wdb-tmp");
    std::fs::write(&tmp, out.as_bytes()).map_err(e)?;
    std::fs::rename(&tmp, &abs).map_err(e)?;
    refresh_paths(conn, lib, &[rel]).map_err(e)?[0].ok_or_else(|| "Documento no encontrado".into())
}

// ---------------------------------------------------------------- removing

pub fn exclude_doc(conn: &mut Connection, doc_id: i64) -> Res<()> {
    let (lib, rel, _) = doc_location(conn, doc_id)?;
    let title: String = conn.query_row("SELECT title FROM docs WHERE id = ?1", [doc_id], |r| r.get(0)).map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    tx.execute("INSERT OR REPLACE INTO excluded(library_id, path, title) VALUES(?1, ?2, ?3)", params![lib, rel, title])
        .map_err(e)?;
    delete_doc(&tx, doc_id).map_err(e)?;
    tx.commit().map_err(e)
}

/// Moves the file to the Windows recycle bin and removes it from the index.
pub fn trash_doc(conn: &mut Connection, doc_id: i64) -> Res<()> {
    let (lib, rel, root) = doc_location(conn, doc_id)?;
    let abs = abs_path(&root, &rel);
    if abs.exists() {
        trash::delete(&abs).map_err(e)?;
    }
    let tx = conn.transaction().map_err(e)?;
    tx.execute("DELETE FROM overrides WHERE library_id = ?1 AND path = ?2", params![lib, rel]).map_err(e)?;
    delete_doc(&tx, doc_id).map_err(e)?;
    tx.commit().map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub library_id: i64,
    pub library: String,
    pub path: String,
    pub title: String,
    pub added: String,
}

pub fn list_excluded(conn: &Connection) -> Res<Vec<Excluded>> {
    let mut st = conn
        .prepare(
            "SELECT x.library_id, l.name, x.path, x.title, x.added FROM excluded x
             JOIN libraries l ON l.id = x.library_id ORDER BY x.added DESC",
        )
        .map_err(e)?;
    let rows = st
        .query_map([], |r| {
            Ok(Excluded { library_id: r.get(0)?, library: r.get(1)?, path: r.get(2)?, title: r.get(3)?, added: r.get(4)? })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn restore_excluded(conn: &mut Connection, library_id: i64, path: &str) -> Res<Option<i64>> {
    conn.execute("DELETE FROM excluded WHERE library_id = ?1 AND path = ?2", params![library_id, path]).map_err(e)?;
    Ok(refresh_paths(conn, library_id, &[path.to_string()]).map_err(e)?[0])
}

#[cfg(test)]
pub fn doc_exists(conn: &Connection, doc_id: i64) -> bool {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT 1 FROM docs WHERE id = ?1", [doc_id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_roundtrip() {
        let dir = std::env::temp_dir().join(format!("wdb-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lib/Col")).unwrap();
        std::fs::write(dir.join("lib/Col/Note.md"), "# TÃ­tulo\r\n\r\nÅšrÄ« Ká¹›á¹£á¹‡a uvÄca.\r\n").unwrap();
        let mut conn = db::open(&dir.join("t.db")).unwrap();
        db::init(&conn).unwrap();
        let lib = add_library(&conn, dir.join("lib").to_str().unwrap(), None).unwrap();
        drop(conn);
        crate::indexer::run(&dir.join("t.db"), false, |_| {}).unwrap();
        conn = db::open(&dir.join("t.db")).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM docs", [], |r| r.get(0)).unwrap();

        let id = save_section(&mut conn, id, 0, "# TÃ­tulo\n\nÅšrÄ« Ká¹›á¹£á¹‡a uvÄca, nuevo.").unwrap();
        let raw = std::fs::read_to_string(dir.join("lib/Col/Note.md")).unwrap();
        assert_eq!(raw, "# TÃ­tulo\r\n\r\nÅšrÄ« Ká¹›á¹£á¹‡a uvÄca, nuevo.\r\n");

        let id = update_meta(&mut conn, id, "Mi nota", "2001-12-15").unwrap();
        let (t, d): (String, String) =
            conn.query_row("SELECT title, date FROM docs WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((t.as_str(), d.as_str()), ("Mi nota", "2001-12-15"));

        exclude_doc(&mut conn, id).unwrap();
        assert!(!doc_exists(&conn, id));
        crate::indexer::run(&dir.join("t.db"), false, |_| {}).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "excluded docs stay out after re-index");
        let back = restore_excluded(&mut conn, lib, "Col/Note.md").unwrap().unwrap();
        let t: String = conn.query_row("SELECT title FROM docs WHERE id = ?1", [back], |r| r.get(0)).unwrap();
        assert_eq!(t, "Mi nota", "overrides survive exclusion");

        let r = import(&conn, &[dir.join("lib/Col").to_string_lossy().to_string()], lib, "Importados").unwrap();
        assert_eq!((r.files, r.texts), (1, 1));
        assert!(dir.join("lib/Importados/Col/Note.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
