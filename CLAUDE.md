# Gaudiya Database — notas para Claude

App de escritorio para Windows (Tauri 2 + Rust + React) que indexa y busca al
instante en una biblioteca de textos vaisnavas (bóvedas de Obsidian `.md`/`.txt`,
además de `.pdf`, `.docx`, `.html`). Estilo VedaBase, pero moderna.
Repo: https://github.com/yogeshdasa-droid/W-Data-Base (rama `main`).

## El usuario
- Habla **español**: responde siempre en español.
- No es programador; explica los cambios en lenguaje claro y sin jerga.
- Su biblioteca principal está en `G:\Whispers\Data Bases\Obsidian`
  (≈4.200 documentos, 310 MB de texto, 129 PDF). Hay más bibliotecas añadidas desde la app.
- **No generar el `.exe` hasta que el proyecto esté terminado** (lo pidió así).
  Para probar se usa el modo desarrollo.
- Equipo lento: i5-7500 de 4 núcleos con **Kaspersky** (ralentiza compilar).
  Una compilación completa de dependencias tarda ~10 min; tras tocar solo nuestro
  código Rust ≈ 1–6 s. No cambiar `[profile.*]` en `Cargo.toml` sin motivo:
  obliga a recompilar todo.

## Comandos
```powershell
# PATH de Node/Rust si la terminal se abrió antes de instalarlos
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

npm run app:dev          # app en desarrollo (recarga la UI al instante; recompila Rust al guardar)
npx tsc --noEmit         # comprobar tipos del frontend
cd src-tauri; cargo test # tests de Rust (plegado, fechas, sintaxis, edición, formatos)
npm run app:build        # .exe + instalador NSIS en src-tauri/target/release/ (solo al final)

# Probar búsquedas contra la base de datos real (solo lectura):
$env:WDB_DB = "$env:APPDATA\com.whispers.wdatabase\library.db"; $env:WDB_Q = '"jaiva dharma" || uvaca'
cargo test query_real -- --ignored --nocapture
```

## Estructura
```
src-tauri/src/
  main.rs     comandos Tauri, estado (Mutex<Connection>), hilo de indexado, eventos index-*
  db.rs       esquema SQLite (SCHEMA_VERSION), migraciones, tablas de usuario vs. índice
  indexer.rs  recorre bibliotecas, indexado incremental (mtime+size), rayon, refresh_paths()
  extract.rs  tipos de archivo: md/txt (editables), pdf (pdf-extract, por páginas), docx, html
  text.rs     decodificación, metadatos (título, fecha, tags), división en secciones, snippets
  fold.rs     PLEGADO de texto: sin diacríticos + variantes (krishna=krsna=kṛṣṇa, ch→c, sh→s…)
  search.rs   parser de consultas, búsqueda FTS5, facetas, documentos, enlaces, marcadores
  edit.rs     bibliotecas, importar, editar sección/metadatos, excluir, papelera, restaurar
src/
  App.tsx     estado global, búsqueda con debounce, paneles, menú contextual, diálogos
  fold.ts     MISMAS reglas que fold.rs (para resaltar en el lector) — mantener sincronizados
  markdown.ts markdown de Obsidian → HTML (wikilinks, ![[imágenes]], callouts, #tags)
  i18n.ts     textos ES/EN (todo texto visible va aquí, en los dos idiomas)
  components/ Sidebar, Results, Reader, Home, Dialogs (editar/eliminar/importar),
              Settings (pestañas), ContextMenu, ui (Modal, Splitter, chips…)
index.html    splash (HTML puro) + muestra la ventana (empieza oculta: "visible": false)
```

## Cómo funciona la búsqueda
- Cada archivo se divide en **secciones** (los archivos > 24 KB se cortan cada ~6–16 KB
  en líneas tipo título; los PDF por páginas `## p. N`). La unidad de búsqueda es la sección.
- Texto original en `sections.text`; índice FTS5 **contentless** (`sections_fts`, `docs_fts`)
  sobre el texto **plegado** por `fold.rs`. La consulta se pliega igual.
- Sintaxis: palabras (AND), `"frase exacta"` (también “ ” « » „ “), `pal*`, `-excluir`, `OR`.
  Las palabras vacías (of, the, de, la…) cuentan pero no se resaltan.
- `Term { words, prefix }`: una frase entre comillas es UN término; se resalta y cuenta
  como una sola coincidencia (Rust `find_matches` y TS `findMatches` hacen lo mismo).

## Reglas importantes
- **Cambiar reglas de plegado o el esquema del índice** → subir `SCHEMA_VERSION` en `db.rs`
  (reindexa todo al arrancar; los datos de usuario se conservan) y actualizar `fold.ts` igual.
- Tablas de usuario (nunca se borran): `libraries`, `bookmarks`, `excluded`, `overrides`, `meta`.
- El `identifier` de Tauri (`com.whispers.wdatabase`) **no se cambia**: la base de datos
  (`%APPDATA%\com.whispers.wdatabase\library.db`) y las preferencias (localStorage) dependen de él.
- Solo `.md/.markdown/.txt` son editables (se reescribe el archivo conservando BOM y CRLF).
  PDF/Word/HTML: solo título y fecha (tabla `overrides`).
- El menú del botón derecho del navegador está desactivado; el propio se construye en
  `buildMenu()` de `App.tsx` según `data-ctx` (hit, doc, folder, bookmark, reader).
- Vite no debe vigilar `src-tauri/` (ver `vite.config.ts`), o se cae al compilar Rust.

## Ideas pendientes
- Fuentes antiguas **Balaram** en PDFs (`viñëupäda` = `viṣṇupāda`, `ä`=ā, `é`=ī, `ñ`=ṣ, `ë`=ṇ,
  `ö`=ṭ, `à`=ṁ…): convertir a IAST al indexar, con cuidado de no tocar el español (ñ).
- Hay documentos duplicados en la biblioteca (p. ej. conferencias en `ES LECTURES` e `IN LECTURES`):
  quizá agrupar resultados idénticos.
- Generar el `.exe` final y actualizar README cuando el usuario dé el proyecto por terminado.
