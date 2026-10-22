// Same folding rules as src-tauri/src/fold.rs (used to highlight matches in
// the reader). Keep both files in sync.

/** A word, or a quoted phrase whose words must be consecutive. */
export interface Term {
  words: string[];
  prefix: boolean;
}

const MARKS = /\p{M}/gu;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

const isConsonant = (c: string | undefined) => !!c && c >= "a" && c <= "z" && !"aeiou".includes(c);

function phonetic(word: string): string {
  const c = Array.from(word);
  let out = "";
  let i = 0;
  while (i < c.length) {
    const ch = c[i];
    const next = c[i + 1];
    if ((ch === "s" || ch === "c") && next === "h") {
      out += ch;
      i += 2;
      while (c[i] === "h") i++;
      continue;
    }
    if ((ch === "a" || ch === "i" || ch === "u") && next === ch) {
      out += ch;
      i += 2;
      continue;
    }
    if (ch === "r" && next === "i" && (i === 0 || isConsonant(c[i - 1])) && isConsonant(c[i + 2])) {
      out += "r";
      i += 2;
      continue;
    }
    if (ch === "w") out += "v";
    else if (ch === "x") out += "ks";
    else out += ch;
    i++;
  }
  return out;
}

export function foldWord(word: string): string {
  return phonetic(word.normalize("NFD").replace(MARKS, "").toLowerCase());
}

/**
 * Non-overlapping matches over folded words as [first index, word count].
 * Same algorithm as `find_matches` in text.rs (longer phrases win).
 */
export function findMatches(folded: string[], terms: Term[]): [number, number][] {
  const sorted = terms.filter((t) => t.words.length).sort((a, b) => b.words.length - a.words.length);
  const out: [number, number][] = [];
  let i = 0;
  outer: while (i < folded.length) {
    for (const t of sorted) {
      const n = t.words.length;
      if (i + n > folded.length) continue;
      const ok = t.words.every((w, k) => (t.prefix && k === n - 1 ? folded[i + k].startsWith(w) : folded[i + k] === w));
      if (ok) {
        out.push([i, n]);
        i += n;
        continue outer;
      }
    }
    i++;
  }
  return out;
}

let matchSeq = 0;

/**
 * Wraps matches under `root` in <mark class="hl">. A phrase may span several
 * text nodes (line breaks, bold…): each piece gets its own <mark>, all with
 * the same data-m, and the first one also has the class "start".
 */
export function highlightDom(root: HTMLElement, terms: Term[]): void {
  if (!terms.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const words: { node: Text; s: number; e: number; f: string }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    for (const m of node.data.matchAll(WORD)) words.push({ node, s: m.index!, e: m.index! + m[0].length, f: foldWord(m[0]) });
  }
  const matches = findMatches(
    words.map((w) => w.f),
    terms,
  );
  if (!matches.length) return;

  // Ranges per text node: a phrase is one contiguous range inside each node it touches.
  const perNode = new Map<Text, { s: number; e: number; id: number; start: boolean }[]>();
  for (const [i, n] of matches) {
    const id = ++matchSeq;
    let k = i;
    while (k < i + n) {
      const node = words[k].node;
      let j = k;
      while (j + 1 < i + n && words[j + 1].node === node) j++;
      const list = perNode.get(node) ?? [];
      list.push({ s: words[k].s, e: words[j].e, id, start: k === i });
      perNode.set(node, list);
      k = j + 1;
    }
  }
  for (const [node, ranges] of perNode) {
    const text = node.data;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const r of ranges) {
      frag.append(text.slice(pos, r.s));
      const mark = document.createElement("mark");
      mark.className = r.start ? "hl start" : "hl";
      mark.dataset.m = String(r.id);
      mark.textContent = text.slice(r.s, r.e);
      frag.append(mark);
      pos = r.e;
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
}

/** Plain string → React-safe parts for highlighting titles in result lists. */
export function highlightParts(text: string, terms: Term[]): { s: string; hit: boolean }[] {
  if (!terms.length) return [{ s: text, hit: false }];
  const words = Array.from(text.matchAll(WORD), (m) => ({ s: m.index!, e: m.index! + m[0].length, f: foldWord(m[0]) }));
  const parts: { s: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [i, n] of findMatches(
    words.map((w) => w.f),
    terms,
  )) {
    const s = words[i].s;
    const e = words[i + n - 1].e;
    if (s > pos) parts.push({ s: text.slice(pos, s), hit: false });
    parts.push({ s: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) parts.push({ s: text.slice(pos), hit: false });
  return parts;
}
