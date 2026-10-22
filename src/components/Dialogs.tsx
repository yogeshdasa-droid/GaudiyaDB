import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, EyeOff, FilePen, FolderInput, FolderPlus, Trash2, Upload } from "lucide-react";
import { api, DocInfo, Library, SectionText } from "../api";
import { T } from "../i18n";
import { Modal } from "./ui";

// ---------------------------------------------------------------- edit

export function EditDialog({
  t,
  doc,
  section,
  onClose,
  onSaved,
}: {
  t: T;
  doc: DocInfo;
  section: SectionText;
  onClose: () => void;
  onSaved: (docId: number, ordinal: number) => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [date, setDate] = useState(doc.date ?? "");
  const [text, setText] = useState(section.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== doc.title || date !== (doc.date ?? "") || text !== section.text;

  const close = () => {
    if (!dirty || window.confirm(t.unsaved)) onClose();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let id = doc.id;
      if (text !== section.text) id = await api.saveSection(id, section.ordinal, text);
      if (title !== doc.title || date !== (doc.date ?? "")) id = await api.updateMeta(id, title, date);
      onSaved(id, section.ordinal);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (dirty && !busy) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Modal
      wide
      title={t.editTitle}
      icon={<FilePen size={18} />}
      onClose={close}
      footer={
        <>
          <span className="muted small grow">
            <AlertTriangle size={13} /> {t.editWarning}
          </span>
          <button className="btn ghost" onClick={close}>
            {t.cancel}
          </button>
          <button className="btn" disabled={!dirty || busy} onClick={save}>
            {busy ? <span className="spinner light" /> : null} {t.save} <kbd className="kbd on-accent">Ctrl S</kbd>
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          <span>{t.titleLabel}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>{t.dateLabel}</span>
          <input value={date} placeholder={t.datePlaceholder} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <p className="muted small">{t.autoHint}</p>
      <label className="text-label">
        <span>
          {t.text}
          {doc.sections > 1 && <em> · {t.editSection(section.ordinal + 1, doc.sections)}</em>}
        </span>
        <textarea
          className="editor"
          value={text}
          spellCheck={false}
          readOnly={!doc.editable}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!doc.editable && <p className="muted small">{t.readOnlyText}</p>}
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- delete

export function DeleteDialog({
  t,
  doc,
  onClose,
  onDone,
}: {
  t: T;
  doc: DocInfo;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (mode: "exclude" | "trash") => {
    setBusy(true);
    try {
      if (mode === "exclude") await api.excludeDoc(doc.id);
      else await api.trashDoc(doc.id);
      onDone(mode === "exclude" ? t.excludedDone : t.trashedDone);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={t.deleteDoc} icon={<Trash2 size={18} />} onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>{t.cancel}</button>}>
      <p>{t.deleteQuestion(doc.title)}</p>
      <div className="choice-list">
        <button className="choice" disabled={busy} onClick={() => run("exclude")}>
          <EyeOff size={20} />
          <div>
            <strong>{t.excludeOption}</strong>
            <span>{t.excludeDesc}</span>
          </div>
        </button>
        <button className="choice danger" disabled={busy} onClick={() => run("trash")}>
          <Trash2 size={20} />
          <div>
            <strong>{t.trashOption}</strong>
            <span>{t.trashDesc}</span>
          </div>
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- import

export function ImportDialog({
  t,
  paths,
  libraries,
  initialLibraryId,
  initialSubdir,
  onClose,
  onDone,
}: {
  t: T;
  paths: string[];
  libraries: Library[];
  initialLibraryId?: number;
  initialSubdir?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [kinds, setKinds] = useState<("dir" | "text" | "other")[] | null>(null);
  const [libraryId, setLibraryId] = useState(initialLibraryId ?? libraries[0]?.id ?? 0);
  const [subdir, setSubdir] = useState(initialSubdir ?? "Importados");
  const [asLibrary, setAsLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pathKinds(paths).then(setKinds).catch((e) => setError(String(e)));
  }, [paths]);

  const counts = useMemo(() => {
    const k = kinds ?? [];
    return { files: k.filter((x) => x === "text").length, dirs: k.filter((x) => x === "dir").length };
  }, [kinds]);
  // Images and PDFs dropped together with notes are copied too (they are attachments).
  const usable = counts.files + counts.dirs > 0 ? paths : [];
  const dirs = paths.filter((_, i) => kinds && kinds[i] === "dir");

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (asLibrary) {
        for (const d of dirs) await api.addLibrary(d);
        onDone(t.libraryAdded);
      } else {
        const r = await api.importFiles(usable, libraryId, subdir);
        onDone(t.imported(r.files, r.dest));
      }
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const nothing = kinds !== null && usable.length === 0;
  return (
    <Modal
      title={t.importTitle}
      icon={<Upload size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t.cancel}
          </button>
          <button className="btn" disabled={busy || nothing || kinds === null || (asLibrary && dirs.length === 0)} onClick={run}>
            {busy && <span className="spinner light" />} {t.importButton}
          </button>
        </>
      }
    >
      <div className="import-summary">
        <FolderInput size={28} />
        <div>
          <strong>{t.importSummary(counts.files, counts.dirs) || "…"}</strong>
          <div className="paths">
            {paths.slice(0, 6).map((p) => (
              <div key={p} title={p}>
                {p}
              </div>
            ))}
            {paths.length > 6 && <div>… +{paths.length - 6}</div>}
          </div>
        </div>
      </div>
      {nothing ? (
        <div className="error-box">{t.nothingToImport}</div>
      ) : (
        <>
          {dirs.length > 0 && (
            <label className="check block">
              <input type="checkbox" checked={asLibrary} onChange={(e) => setAsLibrary(e.target.checked)} />
              <span>
                <FolderPlus size={14} /> {t.importAsLibrary}
                <em className="muted small">{t.importAsLibraryHint}</em>
              </span>
            </label>
          )}
          {!asLibrary && (
            <div className="form-grid">
              <label>
                <span>{t.importInto}</span>
                <select value={libraryId} onChange={(e) => setLibraryId(Number(e.target.value))}>
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t.subfolder}</span>
                <input value={subdir} onChange={(e) => setSubdir(e.target.value)} />
              </label>
            </div>
          )}
        </>
      )}
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}
