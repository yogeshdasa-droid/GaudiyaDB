//! Document parsing helpers: metadata (title, date, tags), splitting large
//! files into sections, plain-text extraction and result snippets.

use crate::fold::{fold_word, word_spans};
use regex::Regex;
use std::sync::LazyLock;

// ---------------------------------------------------------------- decoding

pub fn decode(bytes: &[u8]) -> String {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        encoding_rs::UTF_16LE.decode(bytes).0.into_owned()
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        encoding_rs::UTF_16BE.decode(bytes).0.into_owned()
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_owned(),
            Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
        }
    };
    text.replace("\r\n", "\n").replace('\r', "\n")
}

// ---------------------------------------------------------------- metadata

const MONTHS: &[(&str, u32)] = &[
    ("january", 1), ("february", 2), ("march", 3), ("april", 4), ("may", 5), ("june", 6),
    ("july", 7), ("august", 8), ("september", 9), ("october", 10), ("november", 11), ("december", 12),
    ("enero", 1), ("febrero", 2), ("marzo", 3), ("abril", 4), ("mayo", 5), ("junio", 6),
    ("julio", 7), ("agosto", 8), ("septiembre", 9), ("setiembre", 9), ("octubre", 10),
    ("noviembre", 11), ("diciembre", 12),
    ("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4), ("jun", 6), ("jul", 7), ("aug", 8),
    ("sep", 9), ("sept", 9), ("oct", 10), ("nov", 11), ("dec", 12),
];

fn month_num(name: &str) -> Option<u32> {
    let n = name.to_lowercase();
    MONTHS.iter().find(|(m, _)| *m == n).map(|(_, v)| *v)
}

const MONTH_ALT: &str = "january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

static RE_STEM_MONTH_DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s._]?(\d{1,2})\b[-\s._]*").unwrap()
});
static RE_ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b((?:19|20)\d{2})[-_.](\d{1,2})[-_.](\d{1,2})\b").unwrap()
});
static RE_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b((?:19|20)\d{2})\b").unwrap());
static RE_DAY_MONTH_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:de\s+|of\s+)?({MONTH_ALT})\.?,?\s+(?:de\s+|del\s+)?((?:19|20)\d{{2}})\b"
    ))
    .unwrap()
});
static RE_MONTH_DAY_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b({MONTH_ALT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{{2}})\b"
    ))
    .unwrap()
});
static RE_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[\s(,])#(\p{L}[\p{L}\p{N}_/\-]*)").unwrap()
});

#[derive(Default, Clone, Copy, PartialEq, Debug)]
pub struct DateParts {
    pub year: Option<i32>,
    pub month: Option<u32>,
    pub day: Option<u32>,
}

impl DateParts {
    pub fn to_string(self) -> Option<String> {
        let y = self.year?;
        Some(match (self.month, self.day) {
            (Some(m), Some(d)) => format!("{y:04}-{m:02}-{d:02}"),
            (Some(m), None) => format!("{y:04}-{m:02}"),
            _ => format!("{y:04}"),
        })
    }
}

fn valid(y: i32, m: u32, d: u32) -> bool {
    (1900..=2099).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)
}

fn date_from_path(dirs: &[&str], stem: &str) -> DateParts {
    let mut dp = DateParts::default();
    for d in dirs {
        if d.len() == 4 && d.chars().all(|c| c.is_ascii_digit()) {
            let y: i32 = d.parse().unwrap();
            if (1900..=2099).contains(&y) {
                dp.year = Some(y);
            }
        }
    }
    if let Some(c) = RE_ISO.captures(stem) {
        let (y, m, d) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
        if valid(y, m, d) {
            return DateParts { year: Some(y), month: Some(m), day: Some(d) };
        }
    }
    if dp.year.is_none() {
        if let Some(c) = RE_YEAR.captures(stem) {
            dp.year = c[1].parse().ok();
        }
    }
    if let Some(c) = RE_STEM_MONTH_DAY.captures(stem) {
        dp.month = month_num(&c[1]);
        dp.day = c[2].parse().ok().filter(|d| (1..=31).contains(d));
    }
    dp
}

fn date_from_content(text: &str) -> Option<DateParts> {
    let head: String = text.chars().take(3000).collect();
    let mut best: Option<(usize, DateParts)> = None;
    for c in RE_DAY_MONTH_YEAR.captures_iter(&head) {
        let (d, m, y) = (c[1].parse().unwrap_or(0), month_num(&c[2]).unwrap_or(0), c[3].parse().unwrap_or(0));
        if valid(y, m, d) {
            best = Some((c.get(0).unwrap().start(), DateParts { year: Some(y), month: Some(m), day: Some(d) }));
            break;
        }
    }
    for c in RE_MONTH_DAY_YEAR.captures_iter(&head) {
        let (m, d, y) = (month_num(&c[1]).unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
        if valid(y, m, d) {
            let pos = c.get(0).unwrap().start();
            if best.map_or(true, |(p, _)| pos < p) {
                best = Some((pos, DateParts { year: Some(y), month: Some(m), day: Some(d) }));
            }
            break;
        }
    }
    best.map(|(_, d)| d)
}

/// Best date for a document: the path wins when it is complete; otherwise a
/// date written near the top of the text (only for normal-sized documents,
/// big compilations would just report their first entry).
pub fn extract_date(dirs: &[&str], stem: &str, text: &str) -> DateParts {
    let path = date_from_path(dirs, stem);
    if path.year.is_some() && path.month.is_some() && path.day.is_some() {
        return path;
    }
    if text.len() < 200_000 {
        if let Some(c) = date_from_content(text) {
            if path.year.is_none() || path.year == c.year {
                return c;
            }
        }
    }
    if path.month.is_some() && path.day.is_none() {
        return DateParts { day: None, ..path };
    }
    path
}

pub fn clean_title(stem: &str) -> String {
    let t = RE_STEM_MONTH_DAY.replace(stem, "");
    let t = t.replace('_', " ");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        stem.trim().to_string()
    } else {
        t
    }
}

pub fn extract_tags(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for c in RE_TAG.captures_iter(text) {
        let t = c[1].trim_end_matches(['-', '/']).to_string();
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
            if tags.len() >= 25 {
                break;
            }
        }
    }
    tags
}

// ---------------------------------------------------------------- plain text

static RE_EMBED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)").unwrap());
static RE_WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]").unwrap());
static RE_MDLINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static RE_CALLOUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[![A-Za-z-]+\][+-]?").unwrap());
static RE_SYNTAX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)|[*_`~]{1,3}|<[^>]+>").unwrap());
static RE_BLOCK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)[ \t]\^[A-Za-z0-9-]{3,}[ \t]*$").unwrap());
static RE_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// Markdown/Obsidian markup removed, whitespace collapsed.
pub fn plain(text: &str) -> String {
    let t = RE_BLOCK_ID.replace_all(text, "");
    let t = RE_EMBED.replace_all(&t, " ");
    let t = RE_WIKILINK.replace_all(&t, "$1");
    let t = RE_MDLINK.replace_all(&t, "$1");
    let t = RE_CALLOUT.replace_all(&t, "");
    let t = RE_SYNTAX.replace_all(&t, " ");
    RE_WS.replace_all(&t, " ").trim().to_string()
}

// ---------------------------------------------------------------- sections

pub struct Section {
    pub heading: Option<String>,
    pub text: String,
}

const SINGLE_MAX: usize = 24_000;
const TARGET: usize = 6_000;
const HARD: usize = 16_000;

fn is_heading_like(line: &str, prev_blank: bool) -> bool {
    let t = line.trim();
    if t.starts_with('#') && t.trim_start_matches('#').starts_with(' ') {
        return true;
    }
    if !prev_blank {
        return false;
    }
    let n = t.chars().count();
    (2..=70).contains(&n)
        && t.chars().next().is_some_and(|c| c.is_alphanumeric())
        && !t.ends_with(['.', ',', ';', ':', '?', '!', '"', '”', ')', '-'])
}

fn heading_of(text: &str) -> Option<String> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let p = plain(line);
    if p.is_empty() {
        return None;
    }
    let mut h: String = p.chars().take(90).collect();
    if p.chars().count() > 90 {
        h.push('…');
    }
    Some(h)
}

/// Small files are one section. Large ones (whole books exported from
/// VedaBase, letters, lectures...) are cut every few KB at a heading-like line
/// so search results and the reader point at the right place.
pub fn split_sections(text: &str) -> Vec<Section> {
    if text.len() <= SINGLE_MAX {
        return vec![Section { heading: None, text: text.trim().to_string() }];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_blank = true;
    for line in text.split('\n') {
        let blank = line.trim().is_empty();
        if !cur.is_empty()
            && ((cur.len() >= TARGET && is_heading_like(line, prev_blank)) || (cur.len() >= HARD && blank))
        {
            out.push(Section { heading: heading_of(&cur), text: std::mem::take(&mut cur) });
        }
        prev_blank = blank;
        if cur.is_empty() && blank {
            continue;
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        out.push(Section { heading: heading_of(&cur), text: cur });
    }
    out
}

// ---------------------------------------------------------------- snippets

/// What to highlight: a single word, or a quoted phrase whose words must
/// appear one after another. `prefix` applies to the last word.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Term {
    pub words: Vec<String>,
    pub prefix: bool,
}

/// Non-overlapping matches over a list of folded words, as
/// (index of first word, number of words). Longer phrases win.
pub fn find_matches(folded: &[String], terms: &[Term]) -> Vec<(usize, usize)> {
    let mut sorted: Vec<&Term> = terms.iter().filter(|t| !t.words.is_empty()).collect();
    sorted.sort_by(|a, b| b.words.len().cmp(&a.words.len()));
    let mut out = Vec::new();
    let mut i = 0;
    'outer: while i < folded.len() {
        for t in &sorted {
            let n = t.words.len();
            if i + n > folded.len() {
                continue;
            }
            let ok = t.words.iter().enumerate().all(|(k, w)| {
                let f = &folded[i + k];
                if t.prefix && k == n - 1 {
                    f.starts_with(w.as_str())
                } else {
                    f == w
                }
            });
            if ok {
                out.push((i, n));
                i += n;
                continue 'outer;
            }
        }
        i += 1;
    }
    out
}

fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

/// HTML snippet (escaped, matches wrapped in `<mark>`) around the densest
/// cluster of matches, plus the number of matches (a phrase counts once).
pub fn snippet(text: &str, terms: &[Term], max_words: usize) -> (String, usize) {
    let p = plain(text);
    let spans = word_spans(&p);
    if spans.is_empty() {
        return (String::new(), 0);
    }
    let hits: Vec<(usize, usize)> = if terms.is_empty() {
        Vec::new()
    } else {
        let folded: Vec<String> = spans.iter().map(|(s, e)| fold_word(&p[*s..*e])).collect();
        find_matches(&folded, terms)
    };

    // Window of `max_words` words containing the most hits.
    let mut start = 0usize;
    if !hits.is_empty() {
        let mut best = (0usize, hits[0].0);
        let mut j = 0;
        for i in 0..hits.len() {
            while j < hits.len() && hits[j].0 < hits[i].0 + max_words {
                j += 1;
            }
            if j - i > best.0 {
                best = (j - i, hits[i].0);
            }
        }
        start = best.1.saturating_sub(max_words / 4);
    }
    let mut end = (start + max_words).min(spans.len());
    // never cut a phrase in half
    if let Some(&(h, n)) = hits.iter().find(|(h, n)| *h < end && h + n > end) {
        end = (h + n).min(spans.len());
    }
    let from = if start == 0 { 0 } else { spans[start].0 };
    let to = if end == spans.len() { p.len() } else { spans[end - 1].1 };

    let mut html = String::new();
    if start > 0 {
        html.push_str("… ");
    }
    let mut pos = from;
    for &(h, n) in hits.iter().filter(|(h, _)| *h >= start && *h < end) {
        let (s, e) = (spans[h].0, spans[h + n - 1].1);
        escape(&p[pos..s], &mut html);
        html.push_str("<mark>");
        escape(&p[s..e], &mut html);
        html.push_str("</mark>");
        pos = e;
    }
    escape(&p[pos..to], &mut html);
    if end < spans.len() {
        html.push_str(" …");
    }
    (html, hits.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        let d = extract_date(&["Gurudeva", "ES LECTURES", "2001"], "Dec-15 The One Real Entity", "");
        assert_eq!(d.to_string().as_deref(), Some("2001-12-15"));
        let d = extract_date(&["X"], "Notes", "Lecture given on 15 December 2001 in Germany");
        assert_eq!(d.to_string().as_deref(), Some("2001-12-15"));
        let d = extract_date(&["X"], "Carta", "Vrindavan, 3 de marzo de 1996");
        assert_eq!(d.to_string().as_deref(), Some("1996-03-03"));
        let d = extract_date(&["X"], "Letter", "Los Angeles, December 13, 1968");
        assert_eq!(d.to_string().as_deref(), Some("1968-12-13"));
        assert_eq!(clean_title("Oct-05-The Real Reason"), "The Real Reason");
        assert_eq!(clean_title("Madhu Bisvas"), "Madhu Bisvas");
    }

    #[test]
    fn snippets() {
        let terms = vec![Term { words: vec!["uvaca".into()], prefix: false }];
        let (s, n) = snippet("śrī-bhagavān uvāca — the Lord said", &terms, 20);
        assert_eq!(n, 1);
        assert!(s.contains("<mark>uvāca</mark>"));

        // a quoted phrase is highlighted as a whole, and only where the words are together
        let phrase = vec![Term { words: vec!["jaiva".into(), "dharma".into()], prefix: false }];
        let (s, n) = snippet("Jaiva-dharma is a book. Jaiva alone, dharma alone.", &phrase, 20);
        assert_eq!(n, 1);
        assert_eq!(s, "<mark>Jaiva-dharma</mark> is a book. Jaiva alone, dharma alone.");
    }
}
