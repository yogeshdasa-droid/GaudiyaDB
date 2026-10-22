//! Turns the supported file types into plain text / markdown for indexing.
//! md, markdown and txt are read as they are (and are the only editable ones);
//! pdf, docx and html are converted.

use std::path::Path;

/// PDFs larger than this are listed by title only (extraction would be too slow).
const MAX_PDF_BYTES: usize = 120 * 1024 * 1024;

fn ext(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_indexable(path: &Path) -> bool {
    matches!(ext(path).as_str(), "md" | "markdown" | "txt" | "pdf" | "docx" | "html" | "htm")
}

/// Only plain-text formats can be edited in place.
pub fn is_editable(path: &Path) -> bool {
    matches!(ext(path).as_str(), "md" | "markdown" | "txt")
}

/// Text of a document, or `None` when the file cannot be read at all.
pub fn read_document(path: &Path, bytes: &[u8]) -> Option<String> {
    match ext(path).as_str() {
        "pdf" => Some(pdf(bytes)),
        "docx" => docx(bytes),
        "html" | "htm" => Some(html(&crate::text::decode(bytes))),
        _ => Some(crate::text::decode(bytes)),
    }
}

fn pdf(bytes: &[u8]) -> String {
    if bytes.len() > MAX_PDF_BYTES {
        return String::new();
    }
    // pdf-extract can panic on unusual fonts: a broken PDF must not stop indexing.
    let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes));
    let Ok(Ok(pages)) = pages else { return String::new() };
    let mut out = String::new();
    for (i, page) in pages.iter().enumerate() {
        let body = tidy_pdf_page(page);
        if body.is_empty() {
            continue;
        }
        // A heading per page: the reader's contents list becomes a page index.
        out.push_str(&format!("## p. {}\n\n{}\n\n", i + 1, body));
    }
    out
}

/// Joins the hard-wrapped lines of a PDF page back into paragraphs.
fn tidy_pdf_page(page: &str) -> String {
    let mut paras: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in page.lines() {
        let l = line.trim();
        if l.is_empty() {
            if !cur.is_empty() {
                paras.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if cur.ends_with('-') && !cur.ends_with(" -") {
            cur.pop(); // hyphenated word split across lines
        } else if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(l);
    }
    if !cur.is_empty() {
        paras.push(cur);
    }
    paras.join("\n\n")
}

fn docx(bytes: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml").ok()?.read_to_string(&mut xml).ok()?;
    let xml = xml
        .replace("</w:p>", "\n\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:br/>", "\n");
    Some(decode_entities(&strip_tags(&xml)).trim().to_string())
}

fn html(src: &str) -> String {
    let re_drop = regex::Regex::new(r"(?is)<(script|style|head)\b.*?</(script|style|head)>").unwrap();
    let re_block = regex::Regex::new(r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6]|blockquote|section|article)>").unwrap();
    let re_heading = regex::Regex::new(r"(?i)<h([1-6])[^>]*>").unwrap();
    let s = re_drop.replace_all(src, "");
    let s = re_heading.replace_all(&s, |c: &regex::Captures| format!("\n\n{} ", "#".repeat(c[1].parse().unwrap_or(2))));
    let s = re_block.replace_all(&s, "\n\n");
    let s = decode_entities(&strip_tags(&s));
    let re_blank = regex::Regex::new(r"\n[ \t]*\n(\s*\n)+").unwrap();
    re_blank.replace_all(s.trim(), "\n\n").to_string()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    let re = regex::Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").unwrap();
    re.replace_all(s, |c: &regex::Captures| {
        let e = &c[1];
        let ch = if let Some(hex) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = e.strip_prefix('#') {
            dec.parse().ok().and_then(char::from_u32)
        } else {
            match e {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            }
        };
        ch.map(String::from).unwrap_or_else(|| c[0].to_string())
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert!(is_indexable(Path::new("a/B.PDF")) && is_indexable(Path::new("x.Md")));
        assert!(!is_editable(Path::new("a.pdf")) && is_editable(Path::new("a.txt")));
        let h = html("<html><head><title>x</title></head><body><h2>Śrī Kṛṣṇa</h2><p>uvāca &amp; more</p></body></html>");
        assert_eq!(h, "## Śrī Kṛṣṇa\n\nuvāca & more");
        assert_eq!(tidy_pdf_page("The Lord\nsaid to Ar-\njuna\n\nNext"), "The Lord said to Arjuna\n\nNext");
    }
}
