# Gaudiya Database

Aplicación de escritorio para Windows que busca **al instante** en una biblioteca de
textos (bóvedas de Obsidian `.md` / `.txt`, y también `.pdf`, `.docx` y `.html`).
Inspirada en VedaBase, pero moderna.

## Qué hace
- **Búsqueda sin diacríticos**: `uvaca` encuentra *uvāca*; `krishna` encuentra *Kṛṣṇa*, *Krsna*.
- **Frase exacta** entre comillas (`"jaiva dharma"`), prefijos (`vrinda*`), exclusión (`-maya`), `OR`.
- Resultados en milisegundos (SQLite FTS5), con fragmentos resaltados, filtros por colección
  y año, y orden por relevancia, fecha o título.
- Lector con navegación entre coincidencias, índice de secciones, marcadores con notas,
  enlaces e imágenes de Obsidian.
- Varias bibliotecas (carpetas), importar archivos arrastrándolos, editar texto y metadatos,
  quitar del índice o mandar a la papelera.
- Interfaz en **español e inglés**, tema claro y oscuro.

## Desarrollo
Requisitos: Node.js 20+, Rust (stable, MSVC) y las herramientas de C++ de Visual Studio.

```powershell
npm install
npm run app:dev     # ejecutar en modo desarrollo
npm run app:build   # generar el instalador (.exe)
```
