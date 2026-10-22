import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  Eraser,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Image as ImageIcon,
  Library as LibIcon,
  Link as LinkIcon,
  List as ListIcon,
  FileSymlink,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Quote,
  Scissors,
  Search,
  Settings as Gear,
  Star,
  Sun,
  TextCursorInput,
  TextSearch,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import { ContextMenu, MenuItem, MenuState } from "./components/ContextMenu";
import { api, Bookmark, DocInfo, DocListItem, Hit, IndexProgress, IndexSummary, SearchResult, SectionText, Sort, Status } from "./api";
import { dicts, Lang } from "./i18n";
import { DeleteDialog, EditDialog, ImportDialog } from "./components/Dialogs";
import { Home, RecentDoc } from "./components/Home";
import { EMPTY_FILTERS, Filters, Results } from "./components/Results";
import { Reader, ReaderTarget } from "./components/Reader";
import { Settings, SettingsTab, Theme } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Kbd, Splitter } from "./components/ui";

const PAGE = 50;

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem("wdb." + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function usePersisted<T>(key: string, fallback: T) {
  const [v, setV] = useState<T>(() => stored(key, fallback));
  useEffect(() => {
    try {
      localStorage.setItem("wdb." + key, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  }, [key, v]);
  return [v, setV] as const;
}

type Dialog =
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "edit"; doc: DocInfo; section: SectionText }
  | { kind: "delete"; doc: DocInfo }
  | { kind: "import"; paths: string[]; libraryId?: number; subdir?: string }
  | null;

export default function App() {
  const [lang, setLang] = usePersisted<Lang>("language", "es");
  const [theme, setTheme] = usePersisted<Theme>("theme", "system");
  const [serif, setSerif] = usePersisted("serif", true);
  const [fontSize, setFontSize] = usePersisted("fontSize", 18);
  const [titlesOnly, setTitlesOnly] = usePersisted("titlesOnly", false);
  const [prefix, setPrefix] = usePersisted("prefix", false);
  const [sort, setSort] = usePersisted<Sort>("sort", "relevance");
  const [history, setHistory] = usePersisted<string[]>("history", []);
  const [recent, setRecent] = usePersisted<RecentDoc[]>("recent", []);
  const [sideTab, setSideTab] = usePersisted<"library" | "bookmarks" | "history">("sideTab", "library");
  const [sideW, setSideW] = usePersisted("sideW", 270);
  const [resW, setResW] = usePersisted("resW", 430);
  const [sideOpen, setSideOpen] = usePersisted("sideOpen", true);
  const t = dicts[lang];

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [target, setTarget] = useState<ReaderTarget | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [homeFacets, setHomeFacets] = useState<SearchResult["facets"]>([]);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [readerDoc, setReaderDoc] = useState<DocInfo | null>(null);
  const [dataTick, setDataTick] = useState(0);
  const [resultsOpen, setResultsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  // The results pane follows the search: it opens when there is a query or a
  // filter and closes when both are cleared. The toolbar button / Ctrl+J
  // override it at any time.
  const hasQuery = !!query.trim();
  const anyFilter = filters !== EMPTY_FILTERS && (filters.collections.length > 0 || filters.yearFrom !== null || filters.yearTo !== null || !!filters.scope || !!filters.doc);
  const wantResults = hasQuery || anyFilter;
  useEffect(() => setResultsOpen(wantResults), [wantResults]);

  const showToast = useCallback((msg: string) => {
    const id = Date.now();
    setToast({ msg, id });
    window.setTimeout(() => setToast((m) => (m?.id === id ? null : m)), 4200);
  }, []);

  // ---- theme
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    root.lang = lang;
  }, [theme, lang]);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const isDark = theme === "dark" || (theme === "system" && systemDark);

  // ---- splash (index.html): fade out once the first data is in, or after 3 s
  useEffect(() => {
    const hide = () => {
      const s = document.getElementById("splash");
      if (!s || s.classList.contains("hide")) return;
      s.classList.add("hide");
      window.setTimeout(() => s.remove(), 400);
    };
    if (status) hide();
    const h = window.setTimeout(hide, 3000);
    return () => window.clearTimeout(h);
  }, [status]);

  // ---- data refresh
  const refreshStatus = useCallback(() => api.status().then((s) => (setStatus(s), s)), []);
  const refreshAll = useCallback(() => {
    refreshStatus();
    api.listDocs().then(setDocs);
    api.listBookmarks().then(setBookmarks);
    api
      .search({ ...baseParams(), query: "", collections: [], yearFrom: null, yearTo: null, libraryId: null, dir: null, docId: null, offset: 0, limit: 1 })
      .then((r) => setHomeFacets(r.facets));
    setDataTick((n) => n + 1);
  }, [refreshStatus]);

  useEffect(() => {
    refreshAll();
    const unsubs = [
      listen<IndexProgress>("index-progress", (e) => {
        setProgress(e.payload);
        if (e.payload.phase === "index" && e.payload.done % 1024 < 128) setDataTick((n) => n + 1);
      }),
      listen<IndexSummary>("index-done", (e) => {
        setProgress(null);
        const s = e.payload;
        refreshStatus();
        if (s.added + s.updated + s.removed > 0) {
          refreshAll();
          showToast(dicts[stored<Lang>("language", "es")].done(s.added, s.updated, s.removed, s.millis));
        }
      }),
      listen<string>("index-error", (e) => {
        setProgress(null);
        refreshStatus();
        showToast(`Error: ${e.payload}`);
      }),
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          if (p.paths.length) setDialog({ kind: "import", paths: p.paths });
        }
      }),
    ];
    const poll = window.setInterval(refreshStatus, 20000);
    return () => {
      unsubs.forEach((u) => u.then((f) => f()));
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function baseParams() {
    return { titlesOnly, prefix, sort };
  }

  // ---- search (debounced, newest request wins)
  const runSearch = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const r = await api.search({
          query,
          titlesOnly,
          prefix,
          sort,
          collections: filters.collections,
          yearFrom: filters.yearFrom,
          yearTo: filters.yearTo,
          libraryId: filters.scope?.libraryId ?? null,
          dir: filters.scope?.dir ?? null,
          docId: filters.doc?.id ?? null,
          offset,
          limit: PAGE,
        });
        if (id !== reqId.current) return;
        setResult(r);
        if (offset === 0) {
          setHits(r.hits);
          setSelected(-1);
          setGeneration((g) => g + 1);
        } else setHits((h) => [...h, ...r.hits]);
      } catch (e) {
        if (id === reqId.current) showToast(String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [query, titlesOnly, prefix, sort, filters, showToast],
  );

  useEffect(() => {
    const h = window.setTimeout(() => runSearch(0), query ? 160 : 0);
    return () => window.clearTimeout(h);
  }, [runSearch, dataTick, query]);

  const remember = useCallback(() => {
    const q = query.trim();
    if (q) setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 40));
  }, [query, setHistory]);

  const openHit = useCallback(
    (i: number) => {
      const h = hits[i];
      if (!h) return;
      setSelected(i);
      remember();
      setTarget({ docId: h.docId, ordinal: h.ordinal, terms: query.trim() ? result?.terms ?? [] : [], nonce: Date.now() });
    },
    [hits, query, result, remember],
  );

  const openDoc = useCallback((docId: number, ordinal = 0) => {
    setTarget({ docId, ordinal, terms: [], nonce: Date.now() });
  }, []);

  const onDocLoaded = useCallback(
    (d: DocInfo) => {
      setReaderDoc(d);
      setRecent((r) => [{ libraryId: d.libraryId, path: d.path, title: d.title, collection: d.collection }, ...r.filter((x) => !(x.libraryId === d.libraryId && x.path === d.path))].slice(0, 20));
    },
    [setRecent],
  );

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "");
      if ((e.ctrlKey && (e.key === "k" || e.key === "f")) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        setSideOpen((o) => !o);
      } else if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        setResultsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSideOpen]);

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openHit(Math.min(hits.length - 1, selected + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openHit(Math.max(0, selected - 1));
    } else if (e.key === "Enter") openHit(selected < 0 ? 0 : selected);
    else if (e.key === "Escape") setQuery("");
  };

  // ---- actions
  const onBookmark = async (docId: number, ordinal: number) => {
    try {
      await api.addBookmark(docId, ordinal, "");
      setBookmarks(await api.listBookmarks());
      showToast(t.bookmarkAdded);
    } catch (e) {
      showToast(String(e));
    }
  };

  const pickImport = async (preset?: { libraryId: number; subdir: string }) => {
    const files = await open({
      multiple: true,
      filters: [{ name: "Documentos (md, txt, pdf, docx, html)", extensions: ["md", "markdown", "txt", "pdf", "docx", "html", "htm"] }],
    });
    const paths = Array.isArray(files) ? files : typeof files === "string" ? [files] : [];
    if (paths.length) setDialog({ kind: "import", paths, ...preset });
  };

  // ---- right-click menu (replaces the browser's own menu everywhere)
  const copyText = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      showToast(t.copied);
    } catch (e) {
      showToast(String(e));
    }
  };
  const fail = (e: unknown) => showToast(String(e));
  const withDoc = (docId: number, f: (d: DocInfo) => unknown) => () =>
    api
      .getDoc(docId)
      .then((r) => f(r.doc))
      .catch(fail);
  const editSectionOf = (docId: number, ordinal: number) =>
    withDoc(docId, async (doc) => {
      const [section] = await api.getSections(docId, ordinal, ordinal);
      if (section) setDialog({ kind: "edit", doc, section });
    })();
  const docItems = (docId: number, ordinal: number, here = false): MenuItem[] => [
    { label: here ? t.bookmarkHere : t.addBookmark, icon: Star, onClick: () => onBookmark(docId, ordinal) },
    { label: here ? t.editThisSection : t.editTitle, icon: Pencil, onClick: () => editSectionOf(docId, ordinal) },
    {
      label: t.searchInDoc,
      icon: TextSearch,
      onClick: withDoc(docId, (d) => {
        setFilters((f) => ({ ...f, doc: { id: d.id, title: d.title } }));
        searchRef.current?.focus();
      }),
    },
    "sep",
    { label: t.openFile, icon: FileSymlink, onClick: withDoc(docId, (d) => api.openExternal(d.absPath)) },
    { label: t.openObsidian, icon: ExternalLink, onClick: withDoc(docId, (d) => api.openExternal(`obsidian://open?path=${encodeURIComponent(d.absPath)}`)) },
    { label: t.showInFolder, icon: FolderSearch, onClick: withDoc(docId, (d) => api.revealFile(d.absPath)) },
    "sep",
    { label: `${t.deleteDoc}…`, icon: Trash2, danger: true, onClick: withDoc(docId, (doc) => setDialog({ kind: "delete", doc })) },
  ];

  const buildMenu = (e: MouseEvent): MenuState | null => {
    const el = e.target as HTMLElement;
    const at = { x: e.clientX, y: e.clientY };

    const input = el.closest<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]), textarea");
    if (input) {
      const hasSel = input.selectionStart !== input.selectionEnd;
      const ro = input.readOnly || input.disabled;
      return {
        ...at,
        items: [
          { label: t.cut, icon: Scissors, hint: "Ctrl X", disabled: !hasSel || ro, onClick: () => (input.focus(), document.execCommand("cut")) },
          { label: t.copy, icon: Copy, hint: "Ctrl C", disabled: !hasSel, onClick: () => (input.focus(), document.execCommand("copy")) },
          {
            label: t.paste,
            icon: ClipboardPaste,
            hint: "Ctrl V",
            disabled: ro,
            onClick: async () => {
              input.focus();
              try {
                document.execCommand("insertText", false, await navigator.clipboard.readText());
              } catch (err) {
                fail(err);
              }
            },
          },
          "sep",
          { label: t.selectAll, icon: TextCursorInput, hint: "Ctrl A", onClick: () => (input.focus(), input.select()) },
        ],
      };
    }

    const ctxEl = el.closest<HTMLElement>("[data-ctx]");
    const ctx = ctxEl?.dataset.ctx;
    const items: MenuItem[] = [];
    const sel = (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim();
    if (sel) {
      const short = sel.length > 30 ? sel.slice(0, 30) + "…" : sel;
      const q = /\s/.test(sel) ? `"${sel.replace(/"/g, "")}"` : sel;
      items.push({ label: t.copy, icon: Copy, hint: "Ctrl C", onClick: () => copyText(window.getSelection()?.toString() ?? sel) });
      if (ctx === "reader" && readerDoc) {
        const ref = `— ${readerDoc.title}${readerDoc.date ? ` (${readerDoc.date})` : ""}`;
        items.push({ label: t.copyWithRef, icon: Quote, onClick: () => copyText(`«${window.getSelection()?.toString().trim() ?? sel}»\n${ref}`) });
      }
      items.push({
        label: t.searchFor(short),
        icon: Search,
        onClick: () => {
          setFilters((f) => ({ ...f, doc: null }));
          setQuery(q);
        },
      });
      if (ctx === "reader" && readerDoc) {
        const d = readerDoc;
        items.push({
          label: t.searchForInDoc(short),
          icon: TextSearch,
          onClick: () => {
            setFilters((f) => ({ ...f, doc: { id: d.id, title: d.title } }));
            setQuery(q);
          },
        });
      }
      if (ctx !== "reader") return { ...at, items };
      items.push("sep");
    }

    if (ctx === "reader" && readerDoc) {
      const ord = Number(el.closest<HTMLElement>("section[data-ord]")?.dataset.ord ?? 0);
      const link = el.closest("a");
      const img = el.closest<HTMLImageElement>("img[data-attach]");
      if (link) items.push({ label: t.openLink, icon: LinkIcon, onClick: () => link.click() }, "sep");
      if (img)
        items.push(
          {
            label: t.openImage,
            icon: ImageIcon,
            onClick: () =>
              api
                .resolveAttachments([img.dataset.attach!])
                .then(([p]) => (p ? api.openExternal(p) : undefined))
                .catch(fail),
          },
          "sep",
        );
      return { ...at, title: readerDoc.title, items: [...items, ...docItems(readerDoc.id, ord, true)] };
    }
    if (ctx === "hit") {
      const i = Number(ctxEl!.dataset.i);
      const h = hits[i];
      if (h) return { ...at, title: h.title, items: [{ label: t.open, icon: FolderOpen, onClick: () => openHit(i) }, "sep", ...docItems(h.docId, h.ordinal)] };
    }
    if (ctx === "doc") {
      const id = Number(ctxEl!.dataset.id);
      const d = docs.find((x) => x.id === id);
      return { ...at, title: d?.title, items: [{ label: t.open, icon: FolderOpen, onClick: () => openDoc(id) }, "sep", ...docItems(id, 0)] };
    }
    if (ctx === "folder") {
      const libraryId = Number(ctxEl!.dataset.lib);
      const dir = ctxEl!.dataset.dir ?? "";
      const lib = status?.libraries.find((l) => l.id === libraryId);
      if (lib) {
        const abs = dir ? `${lib.path}\\${dir.replace(/\//g, "\\")}` : lib.path;
        return {
          ...at,
          title: dir ? dir.split("/").pop() : lib.name,
          items: [
            {
              label: t.searchInFolder,
              icon: Search,
              onClick: () => {
                setFilters((f) => ({ ...f, doc: null, scope: { libraryId, dir: dir || null, label: dir ? dir.split("/").pop()! : lib.name } }));
                searchRef.current?.focus();
              },
            },
            { label: t.openInExplorer, icon: FolderSearch, onClick: () => api.openExternal(abs).catch(fail) },
            { label: t.importHere, icon: Upload, onClick: () => pickImport({ libraryId, subdir: dir }) },
            "sep",
            { label: t.manageLibraries, icon: LibIcon, onClick: () => setDialog({ kind: "settings", tab: "libraries" }) },
          ],
        };
      }
    }
    if (ctx === "bookmark") {
      const b = bookmarks.find((x) => x.id === Number(ctxEl!.dataset.id));
      if (b)
        return {
          ...at,
          title: b.title,
          items: [
            { label: t.open, icon: FolderOpen, disabled: !b.docId, onClick: () => b.docId && openDoc(b.docId, b.ordinal) },
            "sep",
            { label: t.deleteBookmark, icon: Trash2, danger: true, onClick: () => api.deleteBookmark(b.id).then(() => api.listBookmarks().then(setBookmarks)) },
          ],
        };
    }
    return {
      ...at,
      items: [
        { label: t.focusSearch, icon: Search, hint: "Ctrl K", onClick: () => searchRef.current?.focus() },
        { label: t.clearSearch, icon: Eraser, disabled: !query && filters === EMPTY_FILTERS, onClick: () => (setQuery(""), setFilters(EMPTY_FILTERS)) },
        "sep",
        { label: t.importFiles, icon: Upload, onClick: () => pickImport() },
        { label: t.addLibrary, icon: FolderPlus, onClick: addFolder },
        "sep",
        { label: t.settings, icon: Gear, onClick: () => setDialog({ kind: "settings", tab: "general" }) },
      ],
    };
  };
  // The listener is attached once; it always calls the latest builder.
  const buildMenuRef = useRef(buildMenu);
  buildMenuRef.current = buildMenu;
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      setMenu(buildMenuRef.current(e));
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  const addFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      try {
        await api.addLibrary(dir);
        showToast(t.libraryAdded);
        refreshAll();
      } catch (e) {
        showToast(String(e));
      }
    }
  };

  const openRecent = async (r: RecentDoc) => {
    const id = await api.findDoc(r.libraryId, r.path);
    if (id) openDoc(id);
    else setRecent((list) => list.filter((x) => x !== r));
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  const panesStyle = {
    gridTemplateColumns: `${sideOpen ? `${sideW}px 5px ` : ""}${resultsOpen ? `${resW}px 5px ` : ""}minmax(360px, 1fr)`,
  } as React.CSSProperties;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="icon-btn" onClick={() => setSideOpen((o) => !o)} title={sideOpen ? t.collapse : t.expand}>
            {sideOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div className="logo">G</div>
          <span className="brand-name">Gaudiya Database</span>
          <button className={`icon-btn ${resultsOpen ? "on" : ""}`} onClick={() => setResultsOpen((o) => !o)} title={t.toggleResults}>
            <ListIcon size={18} />
          </button>
        </div>
        <div className="searchbox">
          <Search size={18} />
          <input
            ref={searchRef}
            autoFocus
            value={query}
            spellCheck={false}
            placeholder={t.searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query ? (
            <button className="icon-btn" onClick={() => setQuery("")} title={t.close}>
              <X size={16} />
            </button>
          ) : (
            <span className="search-hint">
              {t.searchHint} <Kbd>Ctrl K</Kbd>
            </span>
          )}
        </div>
        <div className="search-opts">
          <div className="seg small" data-on={titlesOnly ? 1 : 0}>
            <span className="seg-ink" />
            <button className={!titlesOnly ? "on" : ""} onClick={() => setTitlesOnly(false)}>
              {t.modeText}
            </button>
            <button className={titlesOnly ? "on" : ""} onClick={() => setTitlesOnly(true)}>
              {t.modeTitles}
            </button>
          </div>
          <label className={`toggle ${prefix ? "on" : ""}`} title={t.prefixHint}>
            <input type="checkbox" checked={prefix} onChange={(e) => setPrefix(e.target.checked)} />
            <span className="switch" />
            {t.prefix}
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="relevance">{t.sortRelevance}</option>
            <option value="date_desc">{t.sortDateDesc}</option>
            <option value="date_asc">{t.sortDateAsc}</option>
            <option value="title">{t.sortTitle}</option>
          </select>
        </div>
        <div className="top-actions">
          <button className="lang-btn" onClick={() => setLang(lang === "es" ? "en" : "es")} title={t.language}>
            {lang.toUpperCase()}
          </button>
          <button className="icon-btn" onClick={() => setTheme(isDark ? "light" : "dark")} title={t.theme}>
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-btn" onClick={() => setDialog({ kind: "settings", tab: "general" })} title={t.settings}>
            <Gear size={18} />
          </button>
        </div>
      </header>

      <main className="panes" style={panesStyle}>
        {sideOpen && (
          <>
            <Sidebar
              t={t}
              lang={lang}
              tab={sideTab}
              onTab={setSideTab}
              docs={docs}
              libraries={status?.libraries ?? []}
              active={{ libraryId: filters.scope?.libraryId ?? null, dir: filters.scope?.dir ?? null }}
              activeDocId={target?.docId ?? null}
              onFolder={(libraryId, dir) =>
                setFilters((f) => {
                  const same = f.scope?.libraryId === libraryId && f.scope?.dir === dir;
                  const lib = status?.libraries.find((l) => l.id === libraryId);
                  const label = dir ? dir.split("/").pop()! : lib?.name ?? "";
                  return { ...f, doc: null, scope: same ? null : { libraryId, dir, label } };
                })
              }
              onDoc={openDoc}
              onAddLibrary={addFolder}
              onImport={() => pickImport()}
              bookmarks={bookmarks}
              onBookmarkNote={(id, note) => api.updateBookmark(id, note).then(() => api.listBookmarks().then(setBookmarks))}
              onBookmarkDelete={(id) => api.deleteBookmark(id).then(() => api.listBookmarks().then(setBookmarks))}
              history={history}
              onHistory={(q) => {
                setQuery(q);
                searchRef.current?.focus();
              }}
              onClearHistory={() => setHistory([])}
            />
            <Splitter onDrag={(dx) => setSideW((w) => Math.min(480, Math.max(200, w + dx)))} onDoubleClick={() => setSideW(270)} />
          </>
        )}
        {resultsOpen && (
          <>
            <Results
              t={t}
              lang={lang}
              result={result}
              hits={hits}
              loading={loading}
              selected={selected}
              onSelect={openHit}
              onLoadMore={() => runSearch(hits.length)}
              filters={filters}
              onFilters={setFilters}
              hasQuery={hasQuery}
              generation={generation}
            />
            <Splitter onDrag={(dx) => setResW((w) => Math.min(760, Math.max(300, w + dx)))} onDoubleClick={() => setResW(430)} />
          </>
        )}
        {target ? (
          <Reader
            key={target.docId}
            target={target}
            t={t}
            lang={lang}
            fontSize={fontSize}
            serif={serif}
            onFontSize={setFontSize}
            onOpenDoc={openDoc}
            onLoaded={onDocLoaded}
            onSearchInDoc={(doc) => {
              setFilters((f) => ({ ...f, doc: { id: doc.id, title: doc.title } }));
              searchRef.current?.focus();
            }}
            onBookmark={onBookmark}
            onEdit={(doc, section) => setDialog({ kind: "edit", doc, section })}
            onDelete={(doc) => setDialog({ kind: "delete", doc })}
            onToast={showToast}
          />
        ) : (
          <Home
            t={t}
            lang={lang}
            status={status}
            facets={homeFacets}
            recent={recent}
            bookmarks={bookmarks}
            onCollection={(name) => setFilters({ ...EMPTY_FILTERS, collections: [name] })}
            onRecent={openRecent}
            onBookmark={(b) => b.docId && openDoc(b.docId, b.ordinal)}
          />
        )}
      </main>

      <footer className="statusbar">
        {status && (
          <span>
            {t.documents(status.docs)} · {t.sections(status.sections)}
          </span>
        )}
        {progress && (
          <span className="progress">
            <span className="spinner" />
            {progress.phase === "scan" ? t.scanning : `${t.indexing} ${progress.done.toLocaleString(lang)} / ${progress.total.toLocaleString(lang)}`}
            {pct !== null && (
              <span className="bar">
                <span style={{ width: `${pct}%` }} />
              </span>
            )}
          </span>
        )}
        <span className="spacer" />
        <span className="muted">{status?.libraries.map((l) => l.name).join(" · ")}</span>
      </footer>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <UploadCloud size={44} />
            <strong>{t.dropTitle}</strong>
            <span>{t.dropSub}</span>
          </div>
        </div>
      )}

      {dialog?.kind === "settings" && (
        <Settings
          t={t}
          lang={lang}
          status={status}
          theme={theme}
          serif={serif}
          initialTab={dialog.tab}
          onLang={setLang}
          onTheme={setTheme}
          onSerif={setSerif}
          onClose={() => setDialog(null)}
          onToast={showToast}
          onChanged={refreshAll}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditDialog
          t={t}
          doc={dialog.doc}
          section={dialog.section}
          onClose={() => setDialog(null)}
          onSaved={(docId, ordinal) => {
            setDialog(null);
            showToast(t.saved);
            setTarget({ docId, ordinal, terms: target?.terms ?? [], nonce: Date.now() });
            refreshAll();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          t={t}
          doc={dialog.doc}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setTarget(null);
            showToast(msg);
            refreshAll();
          }}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog
          t={t}
          paths={dialog.paths}
          libraries={status?.libraries ?? []}
          initialLibraryId={dialog.libraryId}
          initialSubdir={dialog.subdir}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            showToast(msg);
            refreshAll();
          }}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {toast && (
        <div className="toast" key={toast.id}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
