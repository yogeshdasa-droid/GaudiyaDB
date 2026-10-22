use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Bump when the index schema or the folding rules change: the index tables
/// are rebuilt. User data (libraries, bookmarks, exclusions, edits) is kept.
pub const SCHEMA_VERSION: &str = "2";

/// User data: never dropped.
const USER_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS libraries(
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    added TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- documents the user removed from the index (the file stays on disk)
CREATE TABLE IF NOT EXISTS excluded(
    library_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    added TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY(library_id, path)
);

-- title / date edited in the app (applied on every re-index)
CREATE TABLE IF NOT EXISTS overrides(
    library_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    date TEXT,
    PRIMARY KEY(library_id, path)
);

CREATE TABLE IF NOT EXISTS bookmarks(
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL DEFAULT 1,
    doc_path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    heading TEXT,
    note TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL
);
"#;

const INDEX_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS docs(
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    path TEXT NOT NULL,             -- relative to the library root, '/' separated
    dir TEXT NOT NULL,              -- relative folder ('' for the root)
    collection TEXT NOT NULL,       -- first folder of the path
    stem TEXT NOT NULL,             -- lowercase file name without extension
    title TEXT NOT NULL,
    date TEXT,                      -- YYYY, YYYY-MM or YYYY-MM-DD
    year INTEGER,
    tags TEXT NOT NULL DEFAULT '',
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sections INTEGER NOT NULL,
    UNIQUE(library_id, path)
);
CREATE INDEX IF NOT EXISTS docs_dir ON docs(library_id, dir);
CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection);
CREATE INDEX IF NOT EXISTS docs_date ON docs(date);
CREATE INDEX IF NOT EXISTS docs_stem ON docs(stem);

CREATE TABLE IF NOT EXISTS sections(
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    heading TEXT,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sections_doc ON sections(doc_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
    heading, body,
    content='', contentless_delete=1,
    tokenize='unicode61 remove_diacritics 0', prefix='2 3'
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title,
    content='', contentless_delete=1,
    tokenize='unicode61 remove_diacritics 0', prefix='2 3'
);

CREATE TABLE IF NOT EXISTS attachments(name TEXT PRIMARY KEY, path TEXT NOT NULL);
"#;

const INDEX_TABLES: &[&str] = &["docs", "sections", "sections_fts", "docs_fts", "attachments"];

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", -64000)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, col: &str) -> rusqlite::Result<bool> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = st.query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
    Ok(names.iter().any(|n| n == col))
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(USER_SCHEMA)?;
    // v1 → v2: bookmarks gain library_id; the single library setting becomes a row.
    if !has_column(conn, "bookmarks", "library_id")? {
        conn.execute_batch("ALTER TABLE bookmarks ADD COLUMN library_id INTEGER NOT NULL DEFAULT 1")?;
    }
    if let Some(old) = get_meta(conn, "library")? {
        conn.execute(
            "INSERT OR IGNORE INTO libraries(id, path, name) VALUES(1, ?1, ?2)",
            [&old, &default_name(&old)],
        )?;
        conn.execute("DELETE FROM meta WHERE key IN ('library', 'root')", [])?;
    }
    if get_meta(conn, "schema")?.as_deref() != Some(SCHEMA_VERSION) {
        for t in INDEX_TABLES {
            conn.execute_batch(&format!("DROP TABLE IF EXISTS {t};"))?;
        }
        conn.execute("DELETE FROM meta WHERE key = 'last_indexed'", [])?;
    }
    conn.execute_batch(INDEX_SCHEMA)?;
    set_meta(conn, "schema", SCHEMA_VERSION)?;
    Ok(())
}

pub fn default_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string())
}

pub fn clear_index(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM docs; DELETE FROM sections; DELETE FROM attachments;
         INSERT INTO sections_fts(sections_fts) VALUES('delete-all');
         INSERT INTO docs_fts(docs_fts) VALUES('delete-all');",
    )
}

pub fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub docs: i64,
}

pub fn libraries(conn: &Connection) -> rusqlite::Result<Vec<Library>> {
    let mut st = conn.prepare(
        "SELECT l.id, l.path, l.name, (SELECT COUNT(*) FROM docs d WHERE d.library_id = l.id)
         FROM libraries l ORDER BY l.id",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Library { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, docs: r.get(3)? })
    })?;
    rows.collect()
}

pub fn library_path(conn: &Connection, id: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT path FROM libraries WHERE id = ?1", [id], |r| r.get(0))
}
