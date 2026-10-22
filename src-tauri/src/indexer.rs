//! Walks the library folders and keeps the SQLite index in sync.
//! Only new or modified files are parsed again, so re-indexing is cheap.

use crate::extract::{is_editable, is_indexable};
use crate::{db, extract, fold::fold_text, text};
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Clone, Serialize)]
pub struct Progress {
    pub phase: &'static str, // "scan" | "index" | "done"
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, Serialize, Default)]
pub struct Summary {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub millis: u128,
}

struct FileEntry {
    library_id: i64,
    abs: PathBuf,
    rel: String,
    mtime: i64,
    size: i64,
}

struct ParsedDoc {
    entry: FileEntry,
    dir: String,
    collection: String,
    stem: String,
    title: String,
    date: Option<String>,
    year: Option<i32>,
    tags: String,
    sections: Vec<ParsedSection>,
}

struct ParsedSection {
    heading: Option<String>,
    text: String,
    heading_fold: String,
    body_fold: String,
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn abs_path(root: &str, rel: &str) -> PathBuf {
    Path::new(root).join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn parse(entry: FileEntry) -> Option<ParsedDoc> {
    let bytes = std::fs::read(&entry.abs).ok()?;
    let content = extract::read_document(&entry.abs, &bytes)?;

    let parts: Vec<&str> = entry.rel.split('/').collect();
    let (dirs, file) = parts.split_at(parts.len() - 1);
    let file = file[0];
    let stem_orig = file.rsplit_once('.').map_or(file, |(s, _)| s);
    let dir = dirs.join("/");
    let collection = dirs.first().map(|s| s.to_string()).unwrap_or_else(|| "General".into());
    let title = text::clean_title(stem_orig);
    let date = text::extract_date(dirs, stem_orig, &content);
    let tags = text::extract_tags(&content).join(",");

    let title_fold = fold_text(&title);
    let sections = text::split_sections(&content)
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let mut heading_fold = s.heading.as_deref().map(fold_text).unwrap_or_default();
            if i == 0 {
                heading_fold = format!("{title_fold} {heading_fold}");
            }
            ParsedSection { body_fold: fold_text(&s.text), heading_fold, heading: s.heading, text: s.text }
        })
        .collect();

    Some(ParsedDoc {
        dir,
        collection,
        stem: stem_orig.to_lowercase(),
        title,
        year: date.year,
        date: date.to_string(),
        tags,
        sections,
        entry,
    })
}

pub fn delete_doc(tx: &Connection, id: i64) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached("SELECT id FROM sections WHERE doc_id = ?1")?;
    let ids: Vec<i64> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut del = tx.prepare_cached("DELETE FROM sections_fts WHERE rowid = ?1")?;
    for sid in ids {
        del.execute([sid])?;
    }
    tx.execute("DELETE FROM sections WHERE doc_id = ?1", [id])?;
    tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [id])?;
    tx.execute("DELETE FROM docs WHERE id = ?1", [id])?;
    Ok(())
}

pub fn set_doc_title_fts(tx: &Connection, id: i64, title: &str, dir: &str) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [id])?;
    tx.prepare_cached("INSERT INTO docs_fts(rowid, title) VALUES(?1, ?2)")?
        .execute(params![id, fold_text(&format!("{title} {}", dir.replace('/', " ")))])?;
    Ok(())
}

fn insert_doc(tx: &Connection, d: &ParsedDoc) -> rusqlite::Result<i64> {
    // Title / date edited by the user win over what was parsed.
    let ov: Option<(Option<String>, Option<String>)> = tx
        .prepare_cached("SELECT title, date FROM overrides WHERE library_id = ?1 AND path = ?2")?
        .query_row(params![d.entry.library_id, d.entry.rel], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let (title, date) = match ov {
        Some((t, dt)) => (t.unwrap_or_else(|| d.title.clone()), dt.or_else(|| d.date.clone())),
        None => (d.title.clone(), d.date.clone()),
    };
    let year: Option<i32> = date.as_deref().and_then(|s| s.get(..4)).and_then(|y| y.parse().ok()).or(d.year);

    tx.prepare_cached(
        "INSERT INTO docs(library_id, path, dir, collection, stem, title, date, year, tags, mtime, size, sections)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )?
    .execute(params![
        d.entry.library_id, d.entry.rel, d.dir, d.collection, d.stem, title, date, year, d.tags,
        d.entry.mtime, d.entry.size, d.sections.len() as i64
    ])?;
    let doc_id = tx.last_insert_rowid();
    set_doc_title_fts(tx, doc_id, &title, &d.dir)?;

    let mut ins_sec =
        tx.prepare_cached("INSERT INTO sections(doc_id, ordinal, heading, text) VALUES(?1, ?2, ?3, ?4)")?;
    let mut ins_fts = tx.prepare_cached("INSERT INTO sections_fts(rowid, heading, body) VALUES(?1, ?2, ?3)")?;
    for (i, s) in d.sections.iter().enumerate() {
        ins_sec.execute(params![doc_id, i as i64, s.heading, s.text])?;
        let sid = tx.last_insert_rowid();
        ins_fts.execute(params![sid, s.heading_fold, s.body_fold])?;
    }
    Ok(doc_id)
}

fn mtime_of(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64)
}

fn entry_for(library_id: i64, root: &Path, abs: &Path) -> Option<FileEntry> {
    let md = std::fs::metadata(abs).ok()?;
    if !md.is_file() {
        return None;
    }
    Some(FileEntry {
        library_id,
        abs: abs.to_path_buf(),
        rel: rel_path(root, abs),
        mtime: mtime_of(&md),
        size: md.len() as i64,
    })
}

/// Re-indexes a few files right away (after an edit, import or restore).
/// Returns the new document id of each path that is (still) indexed.
pub fn refresh_paths(conn: &mut Connection, library_id: i64, rels: &[String]) -> rusqlite::Result<Vec<Option<i64>>> {
    let root = db::library_path(conn, library_id)?;
    let tx = conn.transaction()?;
    let mut out = Vec::new();
    for rel in rels {
        if let Some(id) = tx
            .query_row("SELECT id FROM docs WHERE library_id = ?1 AND path = ?2", params![library_id, rel], |r| r.get(0))
            .optional()?
        {
            delete_doc(&tx, id)?;
        }
        let excluded: bool = tx
            .query_row("SELECT 1 FROM excluded WHERE library_id = ?1 AND path = ?2", params![library_id, rel], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        let abs = abs_path(&root, rel);
        let parsed = if excluded { None } else { entry_for(library_id, Path::new(&root), &abs).and_then(parse) };
        out.push(match parsed {
            Some(d) => Some(insert_doc(&tx, &d)?),
            None => None,
        });
    }
    tx.commit()?;
    Ok(out)
}

pub fn run(db_path: &Path, full: bool, progress: impl Fn(Progress)) -> Result<Summary, String> {
    let started = std::time::Instant::now();
    let mut conn = db::open(db_path).map_err(|e| e.to_string())?;
    db::init(&conn)?;
    if full {
        db::clear_index(&conn).map_err(|e| e.to_string())?;
    }
    let libraries = db::libraries(&conn).map_err(|e| e.to_string())?;

    // ---- scan every library
    progress(Progress { phase: "scan", done: 0, total: 0 });
    let excluded: HashSet<(i64, String)> = {
        let mut st = conn.prepare("SELECT library_id, path FROM excluded").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let mut files: Vec<FileEntry> = Vec::new();
    let mut attachments: Vec<(String, String)> = Vec::new();
    for lib in &libraries {
        let root = Path::new(&lib.path);
        if !root.is_dir() {
            continue; // unplugged drive: keep its documents
        }
        let walker = WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
        for e in walker.flatten() {
            if !e.file_type().is_file() {
                continue;
            }
            let p = e.path();
            if is_indexable(p) {
                let rel = rel_path(root, p);
                if !excluded.contains(&(lib.id, rel.clone())) {
                    if let Ok(md) = e.metadata() {
                        files.push(FileEntry { library_id: lib.id, abs: p.to_path_buf(), rel, mtime: mtime_of(&md), size: md.len() as i64 });
                    }
                }
            }
            // PDFs etc. are documents *and* attachments (for ![[file.pdf]] embeds).
            if !is_editable(p) {
                attachments.push((e.file_name().to_string_lossy().to_lowercase(), p.to_string_lossy().to_string()));
            }
        }
    }
    let live_libs: HashSet<i64> = libraries.iter().filter(|l| Path::new(&l.path).is_dir()).map(|l| l.id).collect();
    let known_libs: HashSet<i64> = libraries.iter().map(|l| l.id).collect();

    let existing: HashMap<(i64, String), (i64, i64, i64)> = {
        let mut stmt = conn.prepare("SELECT library_id, path, id, mtime, size FROM docs").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?, r.get(4)?))))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    let mut summary = Summary::default();
    let mut seen = HashSet::new();
    let mut stale: Vec<i64> = Vec::new();
    let mut todo: Vec<FileEntry> = Vec::new();
    for f in files {
        let key = (f.library_id, f.rel.clone());
        match existing.get(&key) {
            Some(&(_, m, s)) if m == f.mtime && s == f.size => summary.unchanged += 1,
            Some(&(id, _, _)) => {
                stale.push(id);
                summary.updated += 1;
                todo.push(f);
            }
            None => {
                summary.added += 1;
                todo.push(f);
            }
        }
        seen.insert(key);
    }
    for (key, &(id, _, _)) in &existing {
        let lib_gone = !known_libs.contains(&key.0);
        if !seen.contains(key) && (lib_gone || live_libs.contains(&key.0)) {
            stale.push(id);
            summary.removed += 1;
        }
    }

    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in &stale {
            delete_doc(&tx, *id).map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM attachments", []).map_err(|e| e.to_string())?;
        {
            let mut ins = tx
                .prepare("INSERT OR IGNORE INTO attachments(name, path) VALUES(?1, ?2)")
                .map_err(|e| e.to_string())?;
            for (n, p) in &attachments {
                ins.execute([n, p]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // ---- parse in parallel, insert in batches (results appear progressively)
    // Big files first so the slowest work starts early.
    todo.sort_by(|a, b| b.size.cmp(&a.size));
    let total = todo.len();
    progress(Progress { phase: "index", done: 0, total });
    let mut done = 0;
    let mut iter = todo.into_iter().peekable();
    while iter.peek().is_some() {
        let mut batch = Vec::new();
        let mut bytes = 0i64;
        for f in iter.by_ref() {
            bytes += f.size;
            batch.push(f);
            if batch.len() >= 128 || bytes > 48 * 1024 * 1024 {
                break;
            }
        }
        let n = batch.len();
        let parsed: Vec<ParsedDoc> = batch.into_par_iter().filter_map(parse).collect();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for d in &parsed {
            insert_doc(&tx, d).map_err(|e| format!("{}: {e}", d.entry.rel))?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        done += n;
        progress(Progress { phase: "index", done, total });
    }

    if summary.added + summary.updated + summary.removed > 0 {
        let _ = conn.execute_batch(
            "INSERT INTO sections_fts(sections_fts) VALUES('optimize');
             INSERT INTO docs_fts(docs_fts) VALUES('optimize');",
        );
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    db::set_meta(&conn, "last_indexed", &now.to_string()).map_err(|e| e.to_string())?;

    summary.millis = started.elapsed().as_millis();
    progress(Progress { phase: "done", done: total, total });
    Ok(summary)
}

/// Runs WDB_Q against an existing database (read-only check):
/// `WDB_DB=... WDB_Q=... cargo test query_real -- --ignored --nocapture`
#[cfg(test)]
mod query_real {
    #[test]
    #[ignore]
    fn query_real() {
        let db_path = std::env::var("WDB_DB").expect("WDB_DB");
        let conn = rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        for q in std::env::var("WDB_Q").expect("WDB_Q").split(" || ") {
            let parsed = crate::search::parse_query(q, false);
            let p = crate::search::SearchParams {
                query: q.into(), titles_only: false, prefix: false, sort: "relevance".into(),
                collections: vec![], year_from: None, year_to: None, library_id: None, dir: None, doc_id: None,
                offset: 0, limit: Some(5),
            };
            let r = crate::search::search(&conn, &p).unwrap();
            println!("\nQUERY {q:?}\n  fts = {:?}\n  total = {}  error = {:?}", parsed.fts, r.total, r.error);
            for h in &r.hits {
                println!("  - {} | hits={} | {}", h.title, h.hits, h.snippet.chars().take(220).collect::<String>());
            }
        }
    }
}

/// Benchmark against the real library:
/// `WDB_LIBRARY=... WDB_DB=... cargo test --release real_library -- --ignored --nocapture`
#[cfg(test)]
mod tests {
    use crate::search::{search, SearchParams};

    #[test]
    #[ignore]
    fn real_library() {
        let root = std::env::var("WDB_LIBRARY").expect("WDB_LIBRARY");
        let db_path = std::path::PathBuf::from(std::env::var("WDB_DB").expect("WDB_DB"));
        {
            let conn = crate::db::open(&db_path).unwrap();
            crate::db::init(&conn).unwrap();
            conn.execute("INSERT OR IGNORE INTO libraries(path, name) VALUES(?1, 'Test')", [&root]).unwrap();
        }
        let s = super::run(&db_path, false, |_| {}).unwrap();
        println!("index: +{} ~{} -{} ={} in {} ms", s.added, s.updated, s.removed, s.unchanged, s.millis);
        let conn = crate::db::open(&db_path).unwrap();
        for q in ["uvaca", "krishna", "\"jaiva dharma\"", "chaitanya"] {
            let p = SearchParams {
                query: q.into(), titles_only: false, prefix: false, sort: "relevance".into(),
                collections: vec![], year_from: None, year_to: None, library_id: None, dir: None, doc_id: None,
                offset: 0, limit: Some(50),
            };
            let t = std::time::Instant::now();
            let r = search(&conn, &p).unwrap();
            println!("{q:>18} total={:<7} {:>4} ms", r.total, t.elapsed().as_millis());
        }
    }
}
