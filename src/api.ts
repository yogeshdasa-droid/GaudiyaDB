import { invoke } from "@tauri-apps/api/core";
import type { Term } from "./fold";

export type Sort = "relevance" | "date_desc" | "date_asc" | "title";

export interface SearchParams {
  query: string;
  titlesOnly: boolean;
  prefix: boolean;
  sort: Sort;
  collections: string[];
  yearFrom: number | null;
  yearTo: number | null;
  libraryId: number | null;
  dir: string | null;
  docId: number | null;
  offset: number;
  limit: number;
}

export interface Hit {
  sectionId: number;
  docId: number;
  ordinal: number;
  sections: number;
  heading: string | null;
  title: string;
  collection: string;
  dir: string;
  date: string | null;
  snippet: string;
  hits: number;
}

export interface SearchResult {
  total: number;
  hits: Hit[];
  facets: { name: string; count: number }[];
  terms: Term[];
  millis: number;
  error: string | null;
}

export interface Library {
  id: number;
  path: string;
  name: string;
  docs: number;
}

export interface Status {
  libraries: Library[];
  docs: number;
  sections: number;
  lastIndexed: number | null;
  indexing: boolean;
  dbPath: string;
  dbSize: number;
}

export interface DocListItem {
  id: number;
  libraryId: number;
  dir: string;
  title: string;
  date: string | null;
}

export interface DocInfo {
  id: number;
  libraryId: number;
  library: string;
  path: string;
  absPath: string;
  dir: string;
  collection: string;
  title: string;
  date: string | null;
  tags: string[];
  size: number;
  sections: number;
  ext: string;
  editable: boolean;
}

export interface TocEntry {
  ordinal: number;
  heading: string | null;
}

export interface SectionText {
  id: number;
  ordinal: number;
  heading: string | null;
  text: string;
}

export type LinkTarget = { kind: "doc"; id: number } | { kind: "file"; path: string } | { kind: "none" };

export interface Bookmark {
  id: number;
  docPath: string;
  docId: number | null;
  ordinal: number;
  title: string;
  heading: string | null;
  note: string;
  created: string;
}

export interface Excluded {
  libraryId: number;
  library: string;
  path: string;
  title: string;
  added: string;
}

export interface ImportResult {
  files: number;
  texts: number;
  dest: string;
}

export interface IndexProgress {
  phase: "scan" | "index" | "done";
  done: number;
  total: number;
}

export interface IndexSummary {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  millis: number;
}

export const api = {
  status: () => invoke<Status>("get_status"),
  reindex: (full: boolean) => invoke<void>("reindex", { full }),

  addLibrary: (path: string, name?: string) => invoke<number>("add_library", { path, name: name ?? null }),
  renameLibrary: (id: number, name: string) => invoke<void>("rename_library", { id, name }),
  removeLibrary: (id: number) => invoke<void>("remove_library", { id }),
  importFiles: (sources: string[], libraryId: number, subdir: string) =>
    invoke<ImportResult>("import_files", { sources, libraryId, subdir }),
  pathKinds: (paths: string[]) => invoke<("dir" | "text" | "other")[]>("path_kinds", { paths }),

  search: (params: SearchParams) => invoke<SearchResult>("search", { params }),
  listDocs: () => invoke<DocListItem[]>("list_docs"),
  getDoc: (id: number) => invoke<{ doc: DocInfo; toc: TocEntry[] }>("get_doc", { id }),
  findDoc: (libraryId: number, path: string) => invoke<number | null>("find_doc", { libraryId, path }),
  getSections: (docId: number, from: number, to: number) => invoke<SectionText[]>("get_sections", { docId, from, to }),
  resolveLink: (target: string) => invoke<LinkTarget>("resolve_link", { target }),
  resolveAttachments: (names: string[]) => invoke<(string | null)[]>("resolve_attachments", { names }),

  saveSection: (docId: number, ordinal: number, text: string) => invoke<number>("save_section", { docId, ordinal, text }),
  updateMeta: (docId: number, title: string, date: string) => invoke<number>("update_meta", { docId, title, date }),
  excludeDoc: (docId: number) => invoke<void>("exclude_doc", { docId }),
  trashDoc: (docId: number) => invoke<void>("trash_doc", { docId }),
  listExcluded: () => invoke<Excluded[]>("list_excluded"),
  restoreExcluded: (libraryId: number, path: string) => invoke<number | null>("restore_excluded", { libraryId, path }),

  listBookmarks: () => invoke<Bookmark[]>("list_bookmarks"),
  addBookmark: (docId: number, ordinal: number, note: string) => invoke<number>("add_bookmark", { docId, ordinal, note }),
  updateBookmark: (id: number, note: string) => invoke<void>("update_bookmark", { id, note }),
  deleteBookmark: (id: number) => invoke<void>("delete_bookmark", { id }),

  openExternal: (target: string) => invoke<void>("open_external", { target }),
  revealFile: (path: string) => invoke<void>("reveal_file", { path }),
};

/** Stable pastel hue per collection name. */
export function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h * 137) % 360;
}
