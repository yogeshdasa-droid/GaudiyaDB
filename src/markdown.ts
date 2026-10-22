import { marked } from "marked";
import DOMPurify from "dompurify";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Obsidian-flavoured markdown → sanitized HTML.
 * Images and wikilinks become data-* placeholders the reader resolves later.
 */
export function renderMarkdown(src: string): string {
  let s = src
    // VedaBase exports indent lines with spaces: don't turn them into code blocks.
    .replace(/^[ \t]{4,}(?=\S)/gm, "")
    // Obsidian block ids "text ^0f7dd6"
    .replace(/[ \t]\^[A-Za-z0-9-]{3,}[ \t]*$/gm, "")
    // Callouts "> [!example] TITLE" → bold title inside the quote.
    .replace(/^(>\s*)\[![\w-]+\][+-]?\s*(.*)$/gm, (_m, p: string, title: string) => (title ? `${p}**${title}**` : p))
    // Embeds ![[file|300]]
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, name: string, opt?: string) => {
      const n = name.trim();
      if (IMAGE_EXT.test(n)) {
        const width = opt && /^\d+/.test(opt) ? ` width="${parseInt(opt, 10)}"` : "";
        return `<img data-attach="${esc(n)}" alt="${esc(n)}"${width}>`;
      }
      return `<a data-wikilink="${esc(n)}" class="embed">📎 ${esc(n)}</a>`;
    })
    // Wikilinks [[target|alias]]
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => {
      const label = (alias || target.replace(/#.*/, "")).trim();
      return `<a data-wikilink="${esc(target.trim())}">${esc(label)}</a>`;
    })
    // #tags
    .replace(/(^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gmu, (_m, pre: string, tag: string) => `${pre}<span class="tag">#${tag}</span>`);

  const html = marked.parse(s, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-attach", "data-wikilink", "target"] });
}

/** Resolves <img data-attach> placeholders to local files. */
export async function resolveImages(
  root: HTMLElement,
  resolve: (names: string[]) => Promise<(string | null)[]>,
  toUrl: (path: string) => string,
): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-attach]:not([src])"));
  if (!imgs.length) return;
  const paths = await resolve(imgs.map((i) => i.dataset.attach!));
  imgs.forEach((img, i) => {
    const p = paths[i];
    if (p) {
      img.src = toUrl(p);
      img.loading = "lazy";
    } else img.classList.add("missing");
  });
}
