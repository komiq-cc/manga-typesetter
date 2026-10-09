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

/// The largest font this will decode to, and the largest file it will take:
/// 128 MiB. The biggest font files there are, the CJK collections an OS
/// ships, are under 100 MB as plain collections, and a WOFF is one font or
/// one family, smaller still. It is also the WOFF2 decoder's own ceiling.
pub const MAX_FONT_BYTES: usize = 128 * 1024 * 1024;

/// zlib's deflate cannot expand its input by more than 1032 to 1 (a run of
/// matches of the longest length, two bits each), so a WOFF table that
/// declares more than that from its compressed bytes is declaring something
/// its data cannot hold.
const DEFLATE_MAX_RATIO: u64 = 1032;

const TOO_BIG: &str = "this font file declares a font larger than 128 MB";
const CUT_SHORT: &str = "this font file is cut short";
const LYING_TABLE: &str = "this font file declares a table larger than its data could hold";

fn be32(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?)))
}

/// What a WOFF says it will decode to, checked before a decoder sees it.
///
/// The decoder allocates each table's declared `origLength` before it has
/// inflated a byte, and copies a stored table whole, so everything here is a
/// number the file's author chose: a table directory that claims 4 GB from a
/// few hundred bytes would be asked of the allocator as it stands, and a
/// failed allocation is not an error a process comes back from. So, before
/// decoding: the directory and every table lie inside the file; no table is
/// declared smaller than its data (the format forbids it) or larger than
/// deflate could make of it; and the whole font, and the header's own
/// `totalSfntSize`, are within `MAX_FONT_BYTES`.
fn check_woff1(bytes: &[u8]) -> Result<(), &'static str> {
    let tables = u64::from(u16::from_be_bytes(bytes.get(12..14).ok_or(CUT_SHORT)?.try_into().map_err(|_| CUT_SHORT)?));
    if be32(bytes, 16).ok_or(CUT_SHORT)? > MAX_FONT_BYTES as u64 {
        return Err(TOO_BIG);
    }
    let file = bytes.len() as u64;
    let mut total = 12 + 16 * tables;
    for i in 0..tables as usize {
        let entry = 44 + 20 * i;
        let offset = be32(bytes, entry + 4).ok_or(CUT_SHORT)?;
        let stored = be32(bytes, entry + 8).ok_or(CUT_SHORT)?;
        let original = be32(bytes, entry + 12).ok_or(CUT_SHORT)?;
        if offset + stored > file {
            return Err(CUT_SHORT);
        }
        if stored > original || original > stored * DEFLATE_MAX_RATIO {
            return Err(LYING_TABLE);
        }
        total += original.next_multiple_of(4);
        if total > MAX_FONT_BYTES as u64 {
            return Err(TOO_BIG);
        }
    }
    Ok(())
}

/// The same for a WOFF2: the header's `totalSfntSize`, and the sum over the
/// table directory of every `origLength` and every `transformLength`, within
/// `MAX_FONT_BYTES`.
///
/// There is no ratio rule to state for Brotli as there is for deflate - a
/// stream of a few bytes can honestly stand for megabytes - so none is
/// invented here. The decoder refuses a directory that claims more than a
/// hundred times the file (the reference decoder's plausibility rule, from the
/// fonts it was measured on) and decompresses into a buffer of exactly the
/// directory's size, which this has just bounded.
fn check_woff2(bytes: &[u8]) -> Result<(), &'static str> {
    let tables = u16::from_be_bytes(bytes.get(12..14).ok_or(CUT_SHORT)?.try_into().map_err(|_| CUT_SHORT)?);
    if be32(bytes, 16).ok_or(CUT_SHORT)? > MAX_FONT_BYTES as u64 {
        return Err(TOO_BIG);
    }
    let mut at = 48;
    // UIntBase128: at most five bytes, seven bits each, the top bit set on all but the last.
    let number = |at: &mut usize| -> Result<u64, &'static str> {
        let mut n: u64 = 0;
        for _ in 0..5 {
            let byte = *bytes.get(*at).ok_or(CUT_SHORT)?;
            *at += 1;
            n = (n << 7) | u64::from(byte & 0x7f);
            if byte & 0x80 == 0 {
                return Ok(n);
            }
        }
        Err(CUT_SHORT)
    };
    let mut total = 12 + 16 * u64::from(tables);
    for _ in 0..tables {
        let flags = *bytes.get(at).ok_or(CUT_SHORT)?;
        at += 1;
        // The tag: one of the format's known ones by index (10 glyf, 11 loca),
        // or, at index 63, spelled out.
        let known = flags & 0x3f;
        let glyphs = if known == 63 {
            let tag = bytes.get(at..at + 4).ok_or(CUT_SHORT)?;
            at += 4;
            tag == b"glyf" || tag == b"loca"
        } else {
            known == 10 || known == 11
        };
        total += number(&mut at)?;
        // A transform length follows when the table is transformed: version 0
        // for glyf and loca, any other version for the rest.
        if glyphs == (flags >> 6 == 0) {
            total += number(&mut at)?;
        }
        if total > MAX_FONT_BYTES as u64 {
            return Err(TOO_BIG);
        }
    }
    Ok(())
}

/// The font inside a WOFF or WOFF2 file. Anything else is an error that says
/// which: a plain font needs no decoding and must not be sent here.
///
/// Never the end of the process, whatever the file says: its declared sizes
/// are bounded first (`check_woff1`, `check_woff2`), and a decoder that
/// panics on something neither it nor this foresaw is caught here.
pub fn to_sfnt(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_FONT_BYTES {
        return Err("this font file is larger than 128 MB".to_string());
    }
    let font = match bytes.get(..4) {
        Some(b"wOF2") => {
            check_woff2(bytes)?;
            no_panic(|| wuff::decompress_woff2(bytes).map_err(|_| "this WOFF2 file could not be decoded"))?
        }
        Some(b"wOFF") => {
            check_woff1(bytes)?;
            no_panic(|| wuff::decompress_woff1(bytes).map_err(|_| "this WOFF file could not be decoded"))?
        }
        _ => return Err("not a WOFF or WOFF2 file".to_string()),
    };
    if font.len() > MAX_FONT_BYTES {
        return Err(TOO_BIG.to_string());
    }
    // The decoder copies the flavor out of the file's header unread; a file
    // that claims to hold something else has not given us a font.
    let tag: Option<&[u8; 4]> = font.get(..4).and_then(|t| t.try_into().ok());
    if !tag.is_some_and(|t| SFNT_TAGS.contains(&t)) {
        return Err("this file does not hold a TrueType or OpenType font".to_string());
    }
    Ok(font)
}

/// `decode`, with a panic inside it turned into an error. The decoders index
/// and `expect` in places their own checks are meant to make safe; if one of
/// those is ever wrong for some file, that file is unreadable, not fatal.
fn no_panic<T>(decode: impl FnOnce() -> Result<T, &'static str>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(decode)) {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => Err("the decoder failed on this font file".to_string()),
    }
}

#[tauri::command]
pub async fn font_to_sfnt(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("font_to_sfnt takes the font file as the raw body of the call".to_string());
    };
    let bytes = bytes.clone();
    // Off the main thread: a large WOFF2 is tens of milliseconds of Brotli. A
    // panic on that thread, were one to get past `to_sfnt`, comes back as the
    // join's error rather than taking anything down.
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

    /// A WOFF of one table, with every number its directory declares given:
    /// where the table is, how many bytes of it are stored, and how many it
    /// says they decode to. `data` follows the directory.
    fn woff1_declaring(total_sfnt: u32, offset: u32, stored: u32, original: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"wOFF");
        out.extend_from_slice(&[0, 1, 0, 0]);
        out.extend_from_slice(&((44 + 20 + data.len()) as u32).to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&total_sfnt.to_be_bytes());
        out.extend_from_slice(&[0; 24]);
        out.extend_from_slice(b"name");
        for n in [offset, stored, original, 0] {
            out.extend_from_slice(&n.to_be_bytes());
        }
        out.extend_from_slice(data);
        out
    }

    /// A WOFF2 header and a directory of one table declaring `original`
    /// bytes, around a compressed block that is only `block`.
    fn woff2_declaring(total_sfnt: u32, original: u32, block: &[u8]) -> Vec<u8> {
        let mut directory = vec![63];
        directory.extend_from_slice(b"name");
        directory.extend(base128(original));
        let mut out = Vec::new();
        out.extend_from_slice(b"wOF2");
        out.extend_from_slice(&[0, 1, 0, 0]);
        out.extend_from_slice(&((48 + directory.len() + block.len()) as u32).to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&total_sfnt.to_be_bytes());
        out.extend_from_slice(&(block.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0; 24]);
        out.extend(directory);
        out.extend_from_slice(block);
        out
    }

    const GB4: u32 = 0xFFFF_FF00;

    #[test]
    fn refuses_a_header_that_declares_four_gigabytes_before_anything_is_decoded() {
        // Each of these reached the decoder's allocation as it stood: a few
        // dozen bytes asking for 4 GB. Refused here, by name, and at once -
        // the test finishing at all is the proof nothing was allocated.
        let zlib = [0x78u8, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01];
        // The table's origLength.
        assert_eq!(to_sfnt(&woff1_declaring(0, 64, zlib.len() as u32, GB4, &zlib)).unwrap_err(), LYING_TABLE);
        // The same with enough stored bytes that deflate could, in principle, make 4 GB of them.
        let big = vec![0u8; (u64::from(GB4) / DEFLATE_MAX_RATIO) as usize + 4];
        assert_eq!(to_sfnt(&woff1_declaring(0, 64, big.len() as u32, GB4, &big)).unwrap_err(), TOO_BIG);
        // The header's totalSfntSize alone.
        assert_eq!(to_sfnt(&woff1_declaring(GB4, 64, 4, 4, b"abcd")).unwrap_err(), TOO_BIG);
        // And in a WOFF2: the directory's origLength, and the header's total.
        assert_eq!(to_sfnt(&woff2_declaring(100, GB4, &[0x06])).unwrap_err(), TOO_BIG);
        assert_eq!(to_sfnt(&woff2_declaring(GB4, 4, &[0x06])).unwrap_err(), TOO_BIG);
        // A transform length counts as well: glyf, transform version 0.
        let mut transformed = woff2_declaring(100, 4, &[0x06]);
        let directory = [vec![10u8], base128(40), base128(GB4)].concat();
        transformed.splice(48..48 + 6, directory);
        assert_eq!(to_sfnt(&transformed).unwrap_err(), TOO_BIG);
    }

    #[test]
    fn refuses_a_file_that_is_cut_short() {
        let whole = woff1(&[0, 1, 0, 0]);
        // Inside the last table's data, inside the directory, inside the header.
        for keep in [whole.len() - 5, 44 + 30, 20, 13, 4] {
            let err = to_sfnt(&whole[..keep]).unwrap_err();
            assert_eq!(err, CUT_SHORT, "kept {keep} bytes");
        }
        // A table said to lie past the end of a file that is otherwise whole.
        assert_eq!(to_sfnt(&woff1_declaring(0, 64 + 100, 4, 4, b"abcd")).unwrap_err(), CUT_SHORT);
        let whole = woff2(&[0, 1, 0, 0]);
        for keep in [48 + 3, 30, 13] {
            assert_eq!(to_sfnt(&whole[..keep]).unwrap_err(), CUT_SHORT, "kept {keep} bytes");
        }
        // Past its directory a WOFF2 is one compressed block, and that is the decoder's to miss.
        assert_eq!(to_sfnt(&whole[..whole.len() - 5]).unwrap_err(), "this WOFF2 file could not be decoded");
    }

    #[test]
    fn refuses_a_table_whose_declared_length_is_a_lie() {
        let stored = b"twelve bytes";
        // More than deflate could make of what is stored.
        let over = stored.len() as u32 * DEFLATE_MAX_RATIO as u32 + 1;
        assert_eq!(to_sfnt(&woff1_declaring(0, 64, stored.len() as u32, over, stored)).unwrap_err(), LYING_TABLE);
        // Less than what is stored, which the format forbids: the decoder would copy all of it.
        assert_eq!(to_sfnt(&woff1_declaring(0, 64, stored.len() as u32, 4, stored)).unwrap_err(), LYING_TABLE);
        // One byte more than is there: within what deflate could do, so it is
        // the decoder that finds the bytes do not inflate to it. An error, and
        // the allocation it made on the way was of thirteen bytes.
        assert_eq!(
            to_sfnt(&woff1_declaring(0, 64, stored.len() as u32, stored.len() as u32 + 1, stored)).unwrap_err(),
            "this WOFF file could not be decoded"
        );
        // A real deflate stream of a declared length it does not have.
        let zlib = [0x78u8, 0x9c, 0x4b, 0x4c, 0x4a, 0x06, 0x00, 0x02, 0x4d, 0x01, 0x27];
        assert_eq!(to_sfnt(&woff1_declaring(0, 64, zlib.len() as u32, 4000, &zlib)).unwrap_err(), "this WOFF file could not be decoded");
        // In a WOFF2 the block must come to exactly what the directory adds up to.
        assert_eq!(to_sfnt(&woff2_declaring(100, 5000, &brotli_stored(b"only this"))).unwrap_err(), "this WOFF2 file could not be decoded");
    }

    #[test]
    fn a_decoder_that_panics_is_an_error_not_the_end_of_the_process() {
        let caught: Result<(), String> = no_panic(|| panic!("an index past the end, say"));
        assert_eq!(caught.unwrap_err(), "the decoder failed on this font file");
        assert_eq!(no_panic(|| Ok::<_, &'static str>(7)), Ok(7));
        assert_eq!(no_panic(|| Err::<(), _>("refused")), Err("refused".to_string()));
    }

    #[test]
    fn refuses_what_is_not_a_woff_and_what_is_a_broken_one() {
        assert_eq!(to_sfnt(&[0, 1, 0, 0, 0, 3]).unwrap_err(), "not a WOFF or WOFF2 file");
        assert_eq!(to_sfnt(b"OTTO....").unwrap_err(), "not a WOFF or WOFF2 file");
        assert_eq!(to_sfnt(b"").unwrap_err(), "not a WOFF or WOFF2 file");
        // Text after the tag: the sizes it happens to spell are over the limit,
        // which is found before any decoder is asked.
        assert_eq!(to_sfnt(b"wOF2 and then nothing a decoder can use").unwrap_err(), TOO_BIG);
        assert_eq!(to_sfnt(b"wOFF and then nothing a decoder can use").unwrap_err(), TOO_BIG);
        // Sizes that are in bounds around tables that are not there.
        assert_eq!(to_sfnt(&woff2_declaring(100, 9, b"not brotli")).unwrap_err(), "this WOFF2 file could not be decoded");
        // Cut short: the length in the header no longer matches the file.
        let whole = woff2(&[0, 1, 0, 0]);
        assert_eq!(to_sfnt(&whole[..whole.len() - 5]).unwrap_err(), "this WOFF2 file could not be decoded");
        // A well-formed WOFF2 around something that is not a font.
        assert_eq!(to_sfnt(&woff2(b"nope")).unwrap_err(), "this file does not hold a TrueType or OpenType font");
    }
}
