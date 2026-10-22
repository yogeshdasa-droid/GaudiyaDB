import { useEffect, useRef } from "react";
import { CalendarRange, FileText, Folder, SearchX, X } from "lucide-react";
import { Hit, hueOf, SearchResult } from "../api";
import { highlightParts, Term } from "../fold";
import { formatDate, Lang, T } from "../i18n";
import { AnimatedNumber, CollectionChip } from "./ui";

export interface Filters {
  collections: string[];
  yearFrom: number | null;
  yearTo: number | null;
  scope: { libraryId: number; dir: string | null; label: string } | null;
  doc: { id: number; title: string } | null;
}

export const EMPTY_FILTERS: Filters = { collections: [], yearFrom: null, yearTo: null, scope: null, doc: null };

interface Props {
  t: T;
  lang: Lang;
  result: SearchResult | null;
  hits: Hit[];
  loading: boolean;
  selected: number;
  onSelect: (i: number) => void;
  onLoadMore: () => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  hasQuery: boolean;
  generation: number;
}

function Highlighted({ text, terms }: { text: string; terms: Term[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </>
  );
}

function Skeleton() {
  return (
    <div className="hit skeleton">
      <div className="sk sk-title" />
      <div className="sk sk-meta" />
      <div className="sk sk-line" />
      <div className="sk sk-line short" />
    </div>
  );
}

export function Results(p: Props) {
  const { t, lang, result, hits, loading, selected, onSelect, filters, onFilters, hasQuery } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const terms = result?.terms ?? [];

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [p.generation]);

  const toggleCollection = (name: string) => {
    const has = filters.collections.includes(name);
    onFilters({ ...filters, collections: has ? filters.collections.filter((c) => c !== name) : [...filters.collections, name] });
  };
  const anyFilter = filters.collections.length > 0 || filters.yearFrom !== null || filters.yearTo !== null || !!filters.scope || !!filters.doc;
  const year = (v: string) => (/^\d{4}$/.test(v) ? parseInt(v, 10) : null);

  return (
    <div className="results">
      <div className="filters">
        <div className="facets">
          <button className={`facet ${filters.collections.length === 0 ? "on" : ""}`} onClick={() => onFilters({ ...filters, collections: [] })}>
            {t.allCollections}
          </button>
          {result?.facets.map((f) => (
            <button
              key={f.name}
              className={`facet ${filters.collections.includes(f.name) ? "on" : ""}`}
              style={{ "--h": hueOf(f.name) } as React.CSSProperties}
              onClick={() => toggleCollection(f.name)}
            >
              <i className="dot" />
              {f.name}
              <span className="n">{f.count.toLocaleString(lang)}</span>
            </button>
          ))}
        </div>
        <div className="filter-row">
          <div className="years">
            <CalendarRange size={14} />
            <input
              key={`f${filters.yearFrom}`}
              inputMode="numeric"
              maxLength={4}
              placeholder={t.yearFrom}
              defaultValue={filters.yearFrom ?? ""}
              onChange={(e) => {
                const y = year(e.target.value);
                if (y !== null || e.target.value === "") onFilters({ ...filters, yearFrom: y });
              }}
            />
            <span>–</span>
            <input
              key={`t${filters.yearTo}`}
              inputMode="numeric"
              maxLength={4}
              placeholder={t.yearTo}
              defaultValue={filters.yearTo ?? ""}
              onChange={(e) => {
                const y = year(e.target.value);
                if (y !== null || e.target.value === "") onFilters({ ...filters, yearTo: y });
              }}
            />
          </div>
          {filters.scope && (
            <span className="scope" title={filters.scope.label}>
              <Folder size={13} /> <span>{filters.scope.label}</span>
              <button onClick={() => onFilters({ ...filters, scope: null })}>
                <X size={12} />
              </button>
            </span>
          )}
          {filters.doc && (
            <span className="scope" title={filters.doc.title}>
              <FileText size={13} /> <span>{filters.doc.title}</span>
              <button onClick={() => onFilters({ ...filters, doc: null })}>
                <X size={12} />
              </button>
            </span>
          )}
          {anyFilter && (
            <button className="link-btn" onClick={() => onFilters(EMPTY_FILTERS)}>
              {t.clearFilters}
            </button>
          )}
        </div>
        <div className="result-count">
          {result && !result.error && (
            <>
              <strong>
                <AnimatedNumber value={result.total} format={(n) => (hasQuery ? t.results(Math.round(n)) : t.documents(Math.round(n)))} />
              </strong>
              <span className="pill">{t.inMs(result.millis)}</span>
            </>
          )}
          <span className={`loading-bar ${loading ? "on" : ""}`} />
        </div>
      </div>

      <div className="result-list" ref={listRef}>
        {result?.error && <div className="error-box">{result.error}</div>}
        {!result && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}
        {result && !result.error && hits.length === 0 && !loading && (
          <div className="empty-state small">
            <SearchX size={34} />
            <p>{t.noResults}</p>
            <p className="muted small">{t.noResultsHint}</p>
          </div>
        )}
        {hits.map((h, i) => (
          <article
            key={`${p.generation}:${h.sectionId}:${i}`}
            data-i={i}
            data-ctx="hit"
            className={`hit ${i === selected ? "selected" : ""}`}
            style={{ "--h": hueOf(h.collection), animationDelay: `${Math.min(i % 50, 12) * 22}ms` } as React.CSSProperties}
            onClick={() => onSelect(i)}
          >
            <div className="hit-title">
              <Highlighted text={h.title} terms={terms} />
            </div>
            {h.sections > 1 && h.heading && h.heading.toLowerCase() !== h.title.toLowerCase() && (
              <div className="hit-heading">
                § <Highlighted text={h.heading} terms={terms} />
              </div>
            )}
            <div className="hit-meta">
              <CollectionChip name={h.collection} />
              {h.date && <span className="date">{formatDate(h.date, lang)}</span>}
              <span className="path">{h.dir.split("/").slice(1).join(" › ")}</span>
              {hasQuery && h.hits > 0 && <span className="badge">{t.hitsInSection(h.hits)}</span>}
            </div>
            {h.snippet && <p className="snippet" dangerouslySetInnerHTML={{ __html: h.snippet }} />}
          </article>
        ))}
        {result && hits.length < result.total && (
          <button className="load-more" onClick={p.onLoadMore} disabled={loading}>
            {t.loadMore} · {hits.length.toLocaleString(lang)} / {result.total.toLocaleString(lang)}
          </button>
        )}
      </div>
    </div>
  );
}
