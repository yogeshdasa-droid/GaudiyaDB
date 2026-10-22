//! Text folding shared by indexing and querying.
//!
//! Every word is reduced to a canonical form so that searches ignore
//! diacritics and the usual transliteration variants:
//! `uvāca` = `uvaca`, `Kṛṣṇa` = `Krsna` = `Krishna`, `Caitanya` = `Chaitanya`.
//!
//! IMPORTANT: `src/fold.ts` implements the same rules for highlighting in the
//! reader. Keep both files in sync.

use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

fn is_consonant(c: char) -> bool {
    c.is_ascii_lowercase() && !matches!(c, 'a' | 'e' | 'i' | 'o' | 'u')
}

/// Phonetic rules applied to an already lowercased, mark-free word.
fn phonetic(word: &str) -> String {
    let c: Vec<char> = word.chars().collect();
    let mut out = String::with_capacity(word.len());
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        let next = c.get(i + 1).copied();
        match ch {
            // sh → s, ch → c (also chh → c)
            's' | 'c' if next == Some('h') => {
                out.push(ch);
                i += 2;
                while c.get(i) == Some(&'h') {
                    i += 1;
                }
                continue;
            }
            // Harvard-Kyoto long vowels: aa → a, ii → i, uu → u
            'a' | 'i' | 'u' if next == Some(ch) => {
                out.push(ch);
                i += 2;
                continue;
            }
            // ṛ written as "ri": krishna → krsna, rishi → rsi
            'r' if next == Some('i')
                && (i == 0 || is_consonant(c[i - 1]))
                && c.get(i + 2).is_some_and(|n| is_consonant(*n)) =>
            {
                out.push('r');
                i += 2;
                continue;
            }
            'w' => out.push('v'),
            'x' => out.push_str("ks"),
            _ => out.push(ch),
        }
        i += 1;
    }
    out
}

/// Canonical form of a single word.
pub fn fold_word(word: &str) -> String {
    let lower: String = if word.is_ascii() {
        word.to_ascii_lowercase()
    } else {
        word.nfd()
            .filter(|c| !is_combining_mark(*c))
            .flat_map(|c| c.to_lowercase())
            .collect()
    };
    phonetic(&lower)
}

pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

/// Byte ranges of the words in `text`.
pub fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if is_word_char(c) {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            spans.push((s, i));
        }
    }
    if let Some(s) = start {
        spans.push((s, text.len()));
    }
    spans
}

/// Folds a whole text into space-separated canonical tokens (what FTS indexes).
pub fn fold_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (s, e) in word_spans(text) {
        let w = fold_word(&text[s..e]);
        if w.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diacritics_and_variants() {
        assert_eq!(fold_word("uvāca"), fold_word("uvaca"));
        assert_eq!(fold_word("Kṛṣṇa"), "krsna");
        assert_eq!(fold_word("Krishna"), "krsna");
        assert_eq!(fold_word("Krsna"), "krsna");
        assert_eq!(fold_word("Chaitanya"), fold_word("Caitanya"));
        assert_eq!(fold_word("Hṛṣīkeśa"), fold_word("Hrishikesha"));
        assert_eq!(fold_word("ṛṣi"), fold_word("rishi"));
        assert_eq!(fold_word("Lakṣmī"), fold_word("Lakshmi"));
        assert_eq!(fold_word("Vṛndāvana"), fold_word("Vrindavana"));
        assert_eq!(fold_word("amṛta"), fold_word("amrita"));
        assert_eq!(fold_word("Viśvanātha"), fold_word("Vishwanatha"));
        assert_eq!(fold_word("saṁkīrtana"), fold_word("samkirtana"));
        assert_eq!(fold_word("canción"), "cancion");
    }

    #[test]
    fn text_folding() {
        assert_eq!(fold_text("Śrī Kṛṣṇa uvāca: jīva-dharma!"), "sri krsna uvaca jiva dharma");
    }
}
