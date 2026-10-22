import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, EyeOff, FolderPlus, HelpCircle, Library as LibIcon, Pencil, RefreshCw, Settings as Gear, Trash2, Undo2 } from "lucide-react";
import { api, Excluded, Status } from "../api";
import { Lang, T, timeAgo } from "../i18n";
import { Kbd, Modal } from "./ui";

export type Theme = "system" | "light" | "dark";
export type SettingsTab = "general" | "libraries" | "excluded" | "help";

interface Props {
  t: T;
  lang: Lang;
  status: Status | null;
  theme: Theme;
  serif: boolean;
  initialTab: SettingsTab;
  onLang: (l: Lang) => void;
  onTheme: (t: Theme) => void;
  onSerif: (s: boolean) => void;
  onClose: () => void;
  onToast: (msg: string) => void;
  onChanged: () => void;
}

export function Settings(p: Props) {
  const { t, lang, status } = p;
  const [tab, setTab] = useState<SettingsTab>(p.initialTab);
  const [excluded, setExcluded] = useState<Excluded[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    if (tab === "excluded") api.listExcluded().then(setExcluded).catch((e) => p.onToast(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const guard = (f: () => Promise<unknown>) => () => f().catch((e) => p.onToast(String(e)));

  const addFolder = guard(async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      await api.addLibrary(dir);
      p.onToast(t.libraryAdded);
      p.onChanged();
    }
  });

  const tabs: [SettingsTab, typeof Gear, string][] = [
    ["general", Gear, t.general],
    ["libraries", LibIcon, t.libraries],
    ["excluded", EyeOff, t.excluded],
    ["help", HelpCircle, t.help],
  ];

  return (
    <Modal wide title={t.settings} icon={<Gear size={18} />} onClose={p.onClose}>
      <div className="settings">
        <nav className="settings-nav">
          {tabs.map(([k, I, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              <I size={16} /> {label}
            </button>
          ))}
        </nav>

        <div className="settings-pane fade-in" key={tab}>
          {tab === "general" && (
            <>
              <h3>{t.language}</h3>
              <div className="seg">
                <button className={lang === "es" ? "on" : ""} onClick={() => p.onLang("es")}>
                  Español
                </button>
                <button className={lang === "en" ? "on" : ""} onClick={() => p.onLang("en")}>
                  English
                </button>
              </div>
              <h3>{t.theme}</h3>
              <div className="seg">
                {(["system", "light", "dark"] as Theme[]).map((th) => (
                  <button key={th} className={p.theme === th ? "on" : ""} onClick={() => p.onTheme(th)}>
                    {th === "system" ? t.themeSystem : th === "light" ? t.themeLight : t.themeDark}
                  </button>
                ))}
              </div>
              <h3>{t.readerFont}</h3>
              <div className="seg">
                <button className={p.serif ? "on font-serif" : "font-serif"} onClick={() => p.onSerif(true)}>
                  {t.serif} · Kṛṣṇa uvāca
                </button>
                <button className={!p.serif ? "on" : ""} onClick={() => p.onSerif(false)}>
                  {t.sans} · Kṛṣṇa uvāca
                </button>
              </div>
              <h3>{t.database}</h3>
              {status && (
                <p className="muted small">
                  {t.documents(status.docs)} · {t.sections(status.sections)} · {t.indexedAgo(timeAgo(status.lastIndexed, lang))}
                  <br />
                  <code>{status.dbPath}</code> · {(status.dbSize / 1048576).toFixed(0)} MB
                </p>
              )}
              <div className="btn-row">
                <button className="btn" disabled={status?.indexing} onClick={guard(() => api.reindex(false))}>
                  <RefreshCw size={15} /> {t.reindex}
                </button>
                <button className="btn ghost" disabled={status?.indexing} onClick={guard(() => api.reindex(true))}>
                  {t.rebuild}
                </button>
              </div>
            </>
          )}

          {tab === "libraries" && (
            <>
              <div className="lib-list">
                {status?.libraries.map((l) => (
                  <div key={l.id} className="lib-item">
                    <LibIcon size={20} />
                    <div className="lib-info">
                      {renaming?.id === l.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            guard(async () => {
                              await api.renameLibrary(l.id, renaming.name);
                              setRenaming(null);
                              p.onChanged();
                            })();
                          }}
                        >
                          <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: l.id, name: e.target.value })} />
                          <button className="icon-btn" type="submit">
                            <Check size={16} />
                          </button>
                        </form>
                      ) : (
                        <strong>{l.name}</strong>
                      )}
                      <code title={l.path}>{l.path}</code>
                      <span className="muted small">{t.documents(l.docs)}</span>
                    </div>
                    <button className="icon-btn" title={t.rename} onClick={() => setRenaming({ id: l.id, name: l.name })}>
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title={t.removeLibrary}
                      onClick={guard(async () => {
                        if (!window.confirm(t.removeLibraryConfirm(l.name))) return;
                        await api.removeLibrary(l.id);
                        p.onChanged();
                      })}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn" onClick={addFolder}>
                <FolderPlus size={15} /> {t.addLibrary}
              </button>
              <p className="muted small">{t.addLibraryHint}</p>
            </>
          )}

          {tab === "excluded" &&
            (excluded.length === 0 ? (
              <p className="muted">{t.noExcluded}</p>
            ) : (
              <div className="lib-list">
                {excluded.map((x) => (
                  <div key={`${x.libraryId}:${x.path}`} className="lib-item">
                    <EyeOff size={18} />
                    <div className="lib-info">
                      <strong>{x.title}</strong>
                      <code title={x.path}>
                        {x.library} / {x.path}
                      </code>
                      <span className="muted small">{x.added}</span>
                    </div>
                    <button
                      className="btn ghost"
                      onClick={guard(async () => {
                        await api.restoreExcluded(x.libraryId, x.path);
                        setExcluded((list) => list.filter((y) => y !== x));
                        p.onToast(t.restored);
                        p.onChanged();
                      })}
                    >
                      <Undo2 size={15} /> {t.restore}
                    </button>
                  </div>
                ))}
              </div>
            ))}

          {tab === "help" && (
            <>
              <h3>{t.syntax}</h3>
              <table className="syntax">
                <tbody>
                  {t.syntaxRows.map(([q, d]) => (
                    <tr key={q}>
                      <td>
                        <code>{q}</code>
                      </td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>{t.shortcutsTitle}</h3>
              <table className="syntax">
                <tbody>
                  {t.shortcuts.map(([k, d]) => (
                    <tr key={k}>
                      <td>
                        <Kbd>{k}</Kbd>
                      </td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
