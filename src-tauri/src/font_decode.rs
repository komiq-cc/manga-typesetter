//! WOFF and WOFF2 to a plain font file.
//!
//! A user may drop a `.woff` or `.woff2` into the Font Library, and the app
//! stores the file as it came. The webview reads those natively. The Rust text
//! engine (text-engine/, wasm in the webview) reads sfnt only - TrueType,
//! OpenType, collections - so before a compressed face can be handed to it,
//! the frontend sends the bytes here and gets the font inside them back.
//!
//! Both directions are raw bytes, not JSON: the file is the body of the call
//! and the font is the body of the answer.

/// The sfnt tags a decoded font may start with: TrueType, `true`, OpenType
/// with CFF, and a collection.
const SFNT_TAGS: [&[u8; 4]; 4] = [&[0, 1, 0, 0], b"true", b"OTTO", b"ttcf"];

/// The font inside a WOFF or WOFF2 file. Anything else is an error that says
/// which: a plain font needs no decoding and must not be sent here.
pub fn to_sfnt(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let font = match bytes.get(..4) {
        Some(b"wOF2") => wuff::decompress_woff2(bytes).map_err(|_| "this WOFF2 file could not be decoded")?,
        Some(b"wOFF") => wuff::decompress_woff1(bytes).map_err(|_| "this WOFF file could not be decoded")?,
        _ => return Err("not a WOFF or WOFF2 file".to_string()),
    };
    // The decoder copies the flavor out of the file's header unread; a file
    // that claims to hold something else has not given us a font.
    let tag: Option<&[u8; 4]> = font.get(..4).and_then(|t| t.try_into().ok());
    if !tag.is_some_and(|t| SFNT_TAGS.contains(&t)) {
        return Err("this file does not hold a TrueType or OpenType font".to_string());
    }
    Ok(font)
}

#[tauri::command]
pub async fn font_to_sfnt(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("font_to_sfnt takes the font file as the raw body of the call".to_string());
    };
    let bytes = bytes.clone();
    // Off the main thread: a large WOFF2 is tens of milliseconds of Brotli.
    tauri::async_runtime::spawn_blocking(move || to_sfnt(&bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    // No font file is in the repository for these, and none is needed: the
    // decoders are given a WOFF and a WOFF2 written here, byte by byte, around
    // a tiny font that is three tables of known content. Neither format needs
    // a compressor to be written: a WOFF table may be stored as it is, and a
    // Brotli stream may be one uncompressed block.

    /// The tables of the test font, in tag order as an sfnt lists them.
    /// `head` is its real length (54) because both decoders treat it
    /// specially; its content is not a real header and nothing here reads it
    /// as one.
    fn tables() -> Vec<([u8; 4], Vec<u8>)> {
        vec![
            (*b"head", (0u8..54).collect()),
            (*b"name", b"a name table, seven words long, odd".to_vec()),
            (*b"zzzz", vec![0xAB; 9]),
        ]
    }

    /// A Brotli stream holding `data` uncompressed (RFC 7932, section 9.2):
    /// WBITS 16, one meta-block of MLEN bytes with ISUNCOMPRESSED set, then an
    /// empty last meta-block. Bits are written least significant first.
    fn brotli_stored(data: &[u8]) -> Vec<u8> {
        assert!(!data.is_empty() && data.len() <= 1 << 16);
        let mlen = (data.len() - 1) as u32;
        // WBITS (1 bit: 0) | ISLAST 0 | MNIBBLES 00 = 4 nibbles | MLEN-1 (16) | ISUNCOMPRESSED 1
        let bits: u32 = (mlen << 4) | (1 << 20);
        let mut out = bits.to_le_bytes()[..3].to_vec();
        out.extend_from_slice(data);
        // ISLAST 1, ISLASTEMPTY 1
        out.push(0b11);
        out
    }

    /// UIntBase128, the WOFF2 directory's variable-length number.
    fn base128(mut n: u32) -> Vec<u8> {
        let mut out = vec![(n & 0x7f) as u8];
        n >>= 7;
        while n > 0 {
            out.insert(0, 0x80 | (n & 0x7f) as u8);
            n >>= 7;
        }
        out
    }

    fn woff2(flavor: &[u8; 4]) -> Vec<u8> {
        let tables = tables();
        let mut directory = Vec::new();
        let mut data = Vec::new();
        for (tag, bytes) in &tables {
            // Flags 63: the tag follows in full, transform version 0, which
            // for every table but glyf and loca is "not transformed".
            directory.push(63);
            directory.extend_from_slice(tag);
            directory.extend(base128(bytes.len() as u32));
            data.extend_from_slice(bytes);
        }
        let compressed = brotli_stored(&data);
        let sfnt_size = 12 + 16 * tables.len() + tables.iter().map(|(_, b)| b.len().next_multiple_of(4)).sum::<usize>();
        let length = 48 + directory.len() + compressed.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"wOF2");
        out.extend_from_slice(flavor);
        out.extend_from_slice(&(length as u32).to_be_bytes());
        out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes()); // reserved
        out.extend_from_slice(&(sfnt_size as u32).to_be_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0; 4]); // major, minor version
        out.extend_from_slice(&[0; 20]); // no metadata, no private block
        out.extend(directory);
        out.extend(compressed);
        assert_eq!(out.len(), length);
        out
    }

    fn woff1(flavor: &[u8; 4]) -> Vec<u8> {
        let tables = tables();
        let mut offset = 44 + 20 * tables.len();
        let mut directory = Vec::new();
        let mut data = Vec::new();
        for (tag, bytes) in &tables {
            directory.extend_from_slice(tag);
            directory.extend_from_slice(&(offset as u32).to_be_bytes());
            // compLength equal to origLength: the table is stored as it is.
            directory.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            directory.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            directory.extend_from_slice(&0u32.to_be_bytes()); // checksum, unread
            data.extend_from_slice(bytes);
            data.resize(data.len().next_multiple_of(4), 0);
            offset += bytes.len().next_multiple_of(4);
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"wOFF");
        out.extend_from_slice(flavor);
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes()); // reserved
        out.extend_from_slice(&0u32.to_be_bytes()); // totalSfntSize, unread
        out.extend_from_slice(&[0; 4]); // major, minor version
        out.extend_from_slice(&[0; 20]); // no metadata, no private block
        out.extend(directory);
        out.extend(data);
        assert_eq!(out.len(), offset);
        out
    }

    /// The tables of a decoded font, read off its directory.
    fn read_tables(font: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let be = |at: usize| u32::from_be_bytes(font[at..at + 4].try_into().unwrap()) as usize;
        let count = u16::from_be_bytes([font[4], font[5]]) as usize;
        (0..count)
            .map(|i| {
                let entry = 12 + 16 * i;
                let (offset, length) = (be(entry + 8), be(entry + 12));
                (font[entry..entry + 4].try_into().unwrap(), font[offset..offset + length].to_vec())
            })
            .collect()
    }

    /// Equal, but for `head`'s checkSumAdjustment (bytes 8 to 12), which a
    /// decoder is allowed to write afresh for the file it has rebuilt.
    fn assert_same_tables(decoded: &[u8]) {
        let mut got = read_tables(decoded);
        let mut want = tables();
        for list in [&mut got, &mut want] {
            list[0].1[8..12].fill(0);
        }
        assert_eq!(got, want);
    }

    #[test]
    fn decodes_a_woff2_written_here_to_the_font_inside_it() {
        for flavor in [&[0u8, 1, 0, 0], b"OTTO"] {
            let font = to_sfnt(&woff2(flavor)).expect("the WOFF2 decodes");
            assert_eq!(&font[..4], flavor);
            assert_same_tables(&font);
        }
    }

    #[test]
    fn decodes_a_woff_written_here_to_the_font_inside_it() {
        let font = to_sfnt(&woff1(&[0, 1, 0, 0])).expect("the WOFF decodes");
        assert_eq!(&font[..4], &[0, 1, 0, 0]);
        assert_same_tables(&font);
    }

    #[test]
    fn refuses_what_is_not_a_woff_and_what_is_a_broken_one() {
        assert_eq!(to_sfnt(&[0, 1, 0, 0, 0, 3]).unwrap_err(), "not a WOFF or WOFF2 file");
        assert_eq!(to_sfnt(b"OTTO....").unwrap_err(), "not a WOFF or WOFF2 file");
        assert_eq!(to_sfnt(b"").unwrap_err(), "not a WOFF or WOFF2 file");
        assert_eq!(to_sfnt(b"wOF2 and then nothing a decoder can use").unwrap_err(), "this WOFF2 file could not be decoded");
        assert_eq!(to_sfnt(b"wOFF and then nothing a decoder can use").unwrap_err(), "this WOFF file could not be decoded");
        // Cut short: the length in the header no longer matches the file.
        let whole = woff2(&[0, 1, 0, 0]);
        assert_eq!(to_sfnt(&whole[..whole.len() - 5]).unwrap_err(), "this WOFF2 file could not be decoded");
        // A well-formed WOFF2 around something that is not a font.
        assert_eq!(to_sfnt(&woff2(b"nope")).unwrap_err(), "this file does not hold a TrueType or OpenType font");
    }
}
