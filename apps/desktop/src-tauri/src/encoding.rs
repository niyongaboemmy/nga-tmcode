//! Text file encodings, as VS Code names them: files are decoded with the
//! encoding they were written in and saved back the same way (BOM included),
//! so a French Windows file keeps its accents.

/// VS Code's ids: "utf8", "utf8bom", "utf16le", "utf16be", "windows1252", "iso88591".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Windows1252,
    Latin1,
}

/// Windows-1252 0x80..=0x9F. The five unassigned bytes map to the C1 control
/// with the same value (as browsers do), so every byte round-trips.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

impl Encoding {
    pub fn id(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf8",
            Encoding::Utf8Bom => "utf8bom",
            Encoding::Utf16Le => "utf16le",
            Encoding::Utf16Be => "utf16be",
            Encoding::Windows1252 => "windows1252",
            Encoding::Latin1 => "iso88591",
        }
    }

    pub fn from_id(id: &str) -> Result<Encoding, String> {
        Ok(match id {
            "utf8" => Encoding::Utf8,
            "utf8bom" => Encoding::Utf8Bom,
            "utf16le" => Encoding::Utf16Le,
            "utf16be" => Encoding::Utf16Be,
            "windows1252" => Encoding::Windows1252,
            "iso88591" => Encoding::Latin1,
            other => return Err(format!("Unknown encoding '{other}'.")),
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 with BOM",
            Encoding::Utf16Le => "UTF-16 LE",
            Encoding::Utf16Be => "UTF-16 BE",
            Encoding::Windows1252 => "Windows 1252",
            Encoding::Latin1 => "ISO 8859-1",
        }
    }
}

/// BOM first, then valid UTF-8, else a Western single-byte encoding:
/// Windows-1252 unless a byte it leaves unassigned appears (then ISO 8859-1).
pub fn detect(bytes: &[u8]) -> Encoding {
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return Encoding::Utf8Bom;
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return Encoding::Utf16Le;
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return Encoding::Utf16Be;
    }
    if std::str::from_utf8(bytes).is_ok() {
        return Encoding::Utf8;
    }
    if bytes.iter().any(|b| matches!(b, 0x81 | 0x8D | 0x8F | 0x90 | 0x9D)) {
        Encoding::Latin1
    } else {
        Encoding::Windows1252
    }
}

/// Whether the bytes look like a binary file (a NUL in the first 8000 bytes; UTF-16 has its BOM).
pub fn looks_binary(bytes: &[u8], enc: Encoding) -> bool {
    !matches!(enc, Encoding::Utf16Le | Encoding::Utf16Be) && bytes.iter().take(8000).any(|b| *b == 0)
}

pub fn decode(bytes: &[u8], enc: Encoding) -> String {
    match enc {
        Encoding::Utf8 | Encoding::Utf8Bom => {
            let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
            String::from_utf8_lossy(body).into_owned()
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let le = enc == Encoding::Utf16Le;
            let bom: &[u8] = if le { b"\xFF\xFE" } else { b"\xFE\xFF" };
            let body = bytes.strip_prefix(bom).unwrap_or(bytes);
            let units: Vec<u16> = body
                .chunks(2)
                .map(|c| {
                    let pair = [c[0], *c.get(1).unwrap_or(&0)];
                    if le { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) }
                })
                .collect();
            String::from_utf16_lossy(&units)
        }
        Encoding::Windows1252 => bytes
            .iter()
            .map(|&b| if (0x80..=0x9F).contains(&b) { CP1252_HIGH[(b - 0x80) as usize] } else { b as char })
            .collect(),
        Encoding::Latin1 => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Encodes for saving; a character the encoding can't hold is an error (never a silent '?').
pub fn encode(text: &str, enc: Encoding) -> Result<Vec<u8>, String> {
    let refuse = |c: char| Err(format!("'{c}' can't be saved in {}. Use Save with Encoding and pick UTF-8.", enc.label()));
    match enc {
        Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
        Encoding::Utf8Bom => {
            let mut out = b"\xEF\xBB\xBF".to_vec();
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let le = enc == Encoding::Utf16Le;
            let mut out: Vec<u8> = if le { b"\xFF\xFE".to_vec() } else { b"\xFE\xFF".to_vec() };
            for u in text.encode_utf16() {
                out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            Ok(out)
        }
        Encoding::Windows1252 => {
            let mut out = Vec::with_capacity(text.len());
            for c in text.chars() {
                let code = c as u32;
                if code < 0x80 || (0xA0..=0xFF).contains(&code) {
                    out.push(code as u8);
                } else if let Some(i) = CP1252_HIGH.iter().position(|&h| h == c) {
                    out.push(0x80 + i as u8);
                } else {
                    return refuse(c);
                }
            }
            Ok(out)
        }
        Encoding::Latin1 => {
            let mut out = Vec::with_capacity(text.len());
            for c in text.chars() {
                if (c as u32) <= 0xFF {
                    out.push(c as u32 as u8);
                } else {
                    return refuse(c);
                }
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_boms_utf8_and_western_files() {
        assert_eq!(detect(b"\xEF\xBB\xBFhi"), Encoding::Utf8Bom);
        assert_eq!(detect(b"\xFF\xFEh\0"), Encoding::Utf16Le);
        assert_eq!(detect(b"\xFE\xFF\0h"), Encoding::Utf16Be);
        assert_eq!(detect("caf\u{e9}".as_bytes()), Encoding::Utf8);
        assert_eq!(detect(b"caf\xE9 \x80"), Encoding::Windows1252);
        assert_eq!(detect(b"caf\xE9 \x81"), Encoding::Latin1);
        assert_eq!(detect(b""), Encoding::Utf8);
    }

    #[test]
    fn windows_1252_accents_round_trip() {
        // "Élève: «déjà» coûte 5 €" as a French Windows file.
        let bytes = b"\xC9l\xE8ve: \xABd\xE9j\xE0\xBB co\xFBte 5 \x80\r\n";
        let enc = detect(bytes);
        assert_eq!(enc, Encoding::Windows1252);
        let text = decode(bytes, enc);
        assert_eq!(text, "\u{c9}l\u{e8}ve: \u{ab}d\u{e9}j\u{e0}\u{bb} co\u{fb}te 5 \u{20ac}\r\n");
        assert_eq!(encode(&text, enc).unwrap(), bytes.to_vec());
        // Every byte value survives (unassigned ones included).
        let all: Vec<u8> = (1u8..=255).collect();
        assert_eq!(encode(&decode(&all, Encoding::Windows1252), Encoding::Windows1252).unwrap(), all);
        assert_eq!(encode(&decode(&all, Encoding::Latin1), Encoding::Latin1).unwrap(), all);
    }

    #[test]
    fn boms_are_kept_on_save() {
        for (bytes, enc) in [
            (b"\xEF\xBB\xBFx = 1\n".to_vec(), Encoding::Utf8Bom),
            (b"\xFF\xFEx\0\xE9\0".to_vec(), Encoding::Utf16Le),
            (b"\xFE\xFF\0x\0\xE9".to_vec(), Encoding::Utf16Be),
        ] {
            assert_eq!(detect(&bytes), enc);
            let text = decode(&bytes, enc);
            assert!(!text.starts_with('\u{feff}'), "BOM is not part of the text");
            assert_eq!(encode(&text, enc).unwrap(), bytes);
        }
    }

    #[test]
    fn refuses_characters_the_encoding_cannot_hold() {
        assert!(encode("ok \u{2713}", Encoding::Windows1252).unwrap_err().contains("UTF-8"));
        assert!(encode("\u{20ac}", Encoding::Latin1).is_err());
        assert_eq!(encode("\u{2713}", Encoding::Utf8).unwrap(), "\u{2713}".as_bytes());
    }

    #[test]
    fn ids_round_trip() {
        for e in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le, Encoding::Utf16Be, Encoding::Windows1252, Encoding::Latin1] {
            assert_eq!(Encoding::from_id(e.id()).unwrap(), e);
        }
        assert!(Encoding::from_id("klingon").is_err());
    }
}
