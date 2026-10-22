import { BookOpen, Clock, Database, FileText, FolderTree, Layers, Star } from "lucide-react";
import { Bookmark, hueOf, SearchResult, Status } from "../api";
import { Lang, T } from "../i18n";
import { AnimatedNumber } from "./ui";

export interface RecentDoc {
  libraryId: number;
  path: string;
  title: string;
  collection: string;
}

interface Props {
  t: T;
  lang: Lang;
  status: Status | null;
  facets: SearchResult["facets"];
  recent: RecentDoc[];
  bookmarks: Bookmark[];
  onCollection: (name: string) => void;
  onRecent: (r: RecentDoc) => void;
  onBookmark: (b: Bookmark) => void;
}

export function Home({ t, lang, status, facets, recent, bookmarks, onCollection, onRecent, onBookmark }: Props) {
  const max = Math.max(1, ...facets.map((f) => f.count));
  const stats = [
    { icon: FileText, value: status?.docs ?? 0, label: t.statDocs },
    { icon: Layers, value: status?.sections ?? 0, label: t.statSections },
    { icon: FolderTree, value: status?.libraries.length ?? 0, label: t.statLibraries },
    { icon: Database, value: (status?.dbSize ?? 0) / 1048576, label: t.statDb, fmt: (n: number) => `${Math.round(n).toLocaleString(lang)} MB` },
  ];
  return (
    <div className="home">
      <div className="home-inner">
        <header className="hero">
          <div className="hero-icon">
            <BookOpen size={26} />
          </div>
          <h1>{t.welcome}</h1>
        </header>

        <div className="stats">
          {stats.map((s, i) => (
            <div key={i} className="stat" style={{ animationDelay: `${i * 60}ms` }}>
              <s.icon size={18} />
              <strong>
                <AnimatedNumber value={s.value} format={s.fmt ?? ((n) => Math.round(n).toLocaleString(lang))} />
              </strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>

        {facets.length > 0 && (
          <section>
            <h2>{t.collections}</h2>
            <div className="collection-grid">
              {facets.map((f, i) => (
                <button
                  key={f.name}
                  className="collection-card"
                  style={{ "--h": hueOf(f.name), animationDelay: `${i * 40}ms` } as React.CSSProperties}
                  onClick={() => onCollection(f.name)}
                >
                  <span className="cc-name">{f.name}</span>
                  <span className="cc-count">{t.documents(f.count)}</span>
                  <span className="cc-bar">
                    <span style={{ width: `${Math.max(4, (f.count / max) * 100)}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="home-cols">
          {recent.length > 0 && (
            <section>
              <h2>
                <Clock size={14} /> {t.recent}
              </h2>
              <div className="mini-list">
                {recent.slice(0, 8).map((r) => (
                  <button key={`${r.libraryId}:${r.path}`} onClick={() => onRecent(r)} style={{ "--h": hueOf(r.collection) } as React.CSSProperties}>
                    <i className="dot" />
                    <span>{r.title}</span>
                    <em>{r.collection}</em>
                  </button>
                ))}
              </div>
            </section>
          )}
          {bookmarks.length > 0 && (
            <section>
              <h2>
                <Star size={14} /> {t.recentBookmarks}
              </h2>
              <div className="mini-list">
                {bookmarks.slice(0, 8).map((b) => (
                  <button key={b.id} onClick={() => onBookmark(b)} disabled={!b.docId}>
                    <Star size={12} />
                    <span>{b.title}</span>
                    {b.note && <em>{b.note}</em>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
