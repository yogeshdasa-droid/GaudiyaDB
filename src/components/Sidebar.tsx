import { memo, useMemo, useState } from "react";
import { BookMarked, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, History, Library as LibIcon, Search, Star, Trash2, Upload } from "lucide-react";
import { Bookmark, DocListItem, hueOf, Library } from "../api";
import { formatDate, Lang, T } from "../i18n";

interface Node {
  key: string;
  name: string;
  libraryId: number;
  dir: string;
  folders: Node[];
  docs: DocListItem[];
  count: number;
  isLibrary?: boolean;
}

function buildTree(docs: DocListItem[], libraries: Library[], general: string): Node[] {
  const libs: Node[] = [];
  for (const lib of libraries) {
    const root: Node = { key: `L${lib.id}`, name: lib.name, libraryId: lib.id, dir: "", folders: [], docs: [], count: 0, isLibrary: true };
    const index = new Map<string, Node>([["", root]]);
    const get = (dir: string): Node => {
      let n = index.get(dir);
      if (n) return n;
      const cut = dir.lastIndexOf("/");
      const parent = get(cut < 0 ? "" : dir.slice(0, cut));
      n = { key: `L${lib.id}/${dir}`, name: dir.slice(cut + 1), libraryId: lib.id, dir, folders: [], docs: [], count: 0 };
      parent.folders.push(n);
      index.set(dir, n);
      return n;
    };
    for (const d of docs) if (d.libraryId === lib.id) get(d.dir).docs.push(d);
    const finish = (n: Node): number => {
      n.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      n.count = n.docs.length + n.folders.reduce((s, c) => s + finish(c), 0);
      return n.count;
    };
    finish(root);
    if (root.docs.length && root.folders.length) {
      root.folders.unshift({ key: `L${lib.id}/~`, name: general, libraryId: lib.id, dir: "", folders: [], docs: root.docs, count: root.docs.length });
      root.docs = [];
    }
    libs.push(root);
  }
  return libs;
}

interface TreeProps {
  nodes: Node[];
  docs?: DocListItem[];
  depth: number;
  open: Set<string>;
  toggle: (k: string) => void;
  active: { libraryId: number | null; dir: string | null };
  activeDocId: number | null;
  onFolder: (libraryId: number, dir: string | null) => void;
  onDoc: (id: number) => void;
  lang: Lang;
}

const Tree = memo(function Tree(p: TreeProps) {
  const { nodes, docs, depth, open, toggle, active, activeDocId, onFolder, onDoc, lang } = p;
  return (
    <>
      {nodes.map((n) => {
        const isOpen = open.has(n.key);
        const isActive = active.libraryId === n.libraryId && (n.isLibrary ? active.dir === null : active.dir === n.dir && !!n.dir);
        const hue = depth === 1 ? hueOf(n.name) : null;
        return (
          <div key={n.key}>
            <div
              data-ctx="folder"
              data-lib={n.libraryId}
              data-dir={n.dir}
              className={`tree-row ${n.isLibrary ? "lib" : "folder"} ${isActive ? "active" : ""}`}
              style={{ paddingLeft: 6 + depth * 14, ...(hue !== null ? ({ "--h": hue } as React.CSSProperties) : {}) }}
              onClick={() => {
                toggle(n.key);
                if (n.isLibrary) onFolder(n.libraryId, null);
                else if (n.dir) onFolder(n.libraryId, n.dir);
              }}
            >
              <ChevronRight size={14} className={`caret ${isOpen ? "open" : ""}`} />
              {n.isLibrary ? <LibIcon size={16} /> : isOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span className="name">{n.name}</span>
              <span className="count">{n.count.toLocaleString(lang)}</span>
            </div>
            <div className={`tree-children ${isOpen ? "open" : ""}`}>
              {isOpen && <Tree {...p} nodes={n.folders} docs={n.docs} depth={depth + 1} />}
            </div>
          </div>
        );
      })}
      {docs?.map((d) => (
        <div
          key={d.id}
          data-ctx="doc"
          data-id={d.id}
          className={`tree-row doc ${activeDocId === d.id ? "active" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 + 14 }}
          onClick={() => onDoc(d.id)}
          title={d.title}
        >
          <FileText size={14} />
          <span className="name">{d.title}</span>
          {d.date && <span className="count">{formatDate(d.date, lang)}</span>}
        </div>
      ))}
    </>
  );
});

type Tab = "library" | "bookmarks" | "history";

interface Props {
  t: T;
  lang: Lang;
  tab: Tab;
  onTab: (t: Tab) => void;
  docs: DocListItem[];
  libraries: Library[];
  active: { libraryId: number | null; dir: string | null };
  activeDocId: number | null;
  onFolder: (libraryId: number, dir: string | null) => void;
  onDoc: (id: number, ordinal?: number) => void;
  onAddLibrary: () => void;
  onImport: () => void;
  bookmarks: Bookmark[];
  onBookmarkNote: (id: number, note: string) => void;
  onBookmarkDelete: (id: number) => void;
  history: string[];
  onHistory: (q: string) => void;
  onClearHistory: () => void;
}

export function Sidebar(p: Props) {
  const { t } = p;
  const tree = useMemo(() => buildTree(p.docs, p.libraries, t.general), [p.docs, p.libraries, t.general]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(p.libraries.length === 1 ? [`L${p.libraries[0].id}`] : []));
  const [editing, setEditing] = useState<number | null>(null);
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  // A single library is always shown expanded.
  const openSet = useMemo(() => {
    if (tree.length !== 1 || open.has(`!${tree[0].key}`)) return open;
    const n = new Set(open);
    n.add(tree[0].key);
    return n;
  }, [open, tree]);
  const toggleWithSingle = (k: string) => {
    if (tree.length === 1 && k === tree[0].key) {
      setOpen((s) => {
        const n = new Set(s);
        if (n.has(`!${k}`)) n.delete(`!${k}`);
        else n.add(`!${k}`);
        return n;
      });
    } else toggle(k);
  };

  const tabs: [Tab, typeof LibIcon, string][] = [
    ["library", LibIcon, t.library],
    ["bookmarks", Star, t.bookmarks],
    ["history", History, t.history],
  ];

  return (
    <aside className="sidebar">
      <nav className="tabs">
        {tabs.map(([k, I, label]) => (
          <button key={k} className={p.tab === k ? "active" : ""} onClick={() => p.onTab(k)} title={label}>
            <I size={15} />
            <span>{label}</span>
          </button>
        ))}
        <span className="tab-ink" style={{ transform: `translateX(${tabs.findIndex((x) => x[0] === p.tab) * 100}%)` }} />
      </nav>

      <div className="side-scroll" key={p.tab}>
        {p.tab === "library" && (
          <div className="fade-in">
            <Tree
              nodes={tree}
              depth={0}
              open={openSet}
              toggle={toggleWithSingle}
              active={p.active}
              activeDocId={p.activeDocId}
              onFolder={p.onFolder}
              onDoc={(id) => p.onDoc(id)}
              lang={p.lang}
            />
          </div>
        )}

        {p.tab === "bookmarks" &&
          (p.bookmarks.length === 0 ? (
            <div className="side-empty">
              <BookMarked size={28} />
              <p>{t.noBookmarks}</p>
            </div>
          ) : (
            <div className="fade-in">
              {p.bookmarks.map((b) => (
                <div key={b.id} data-ctx="bookmark" data-id={b.id} className={`bookmark ${b.docId ? "" : "stale"}`}>
                  <div className="bm-head" onClick={() => b.docId && p.onDoc(b.docId, b.ordinal)}>
                    <div className="bm-title">{b.title}</div>
                    {b.heading && b.heading.toLowerCase() !== b.title.toLowerCase() && <div className="bm-sub">§ {b.heading}</div>}
                  </div>
                  {editing === b.id ? (
                    <textarea
                      autoFocus
                      defaultValue={b.note}
                      placeholder={t.notePlaceholder}
                      onBlur={(e) => {
                        setEditing(null);
                        if (e.target.value !== b.note) p.onBookmarkNote(b.id, e.target.value);
                      }}
                    />
                  ) : (
                    <div className={`bm-note ${b.note ? "" : "placeholder"}`} onClick={() => setEditing(b.id)}>
                      {b.note || t.notePlaceholder}
                    </div>
                  )}
                  <div className="bm-date">{b.created}</div>
                  <button className="icon-btn bm-del" title={t.delete} onClick={() => p.onBookmarkDelete(b.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}

        {p.tab === "history" &&
          (p.history.length === 0 ? (
            <div className="side-empty">
              <History size={28} />
              <p>{t.noHistory}</p>
            </div>
          ) : (
            <div className="fade-in">
              {p.history.map((q) => (
                <div key={q} className="tree-row" onClick={() => p.onHistory(q)}>
                  <Search size={14} />
                  <span className="name">{q}</span>
                </div>
              ))}
              <button className="link-btn" onClick={p.onClearHistory}>
                {t.clearHistory}
              </button>
            </div>
          ))}
      </div>

      {p.tab === "library" && (
        <div className="side-actions">
          <button onClick={p.onAddLibrary} title={t.addLibraryHint}>
            <FolderPlus size={15} /> {t.addLibrary}
          </button>
          <button onClick={p.onImport} title={t.importHint}>
            <Upload size={15} /> {t.importFiles}
          </button>
        </div>
      )}
    </aside>
  );
}
