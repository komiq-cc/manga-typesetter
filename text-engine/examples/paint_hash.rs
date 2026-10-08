//! The native build paints the jobs `parity/paint-hash.mjs --dump` wrote,
//! and prints a hash of each raster, to set beside the wasm's.
//!
//!   node text-engine/parity/paint-hash.mjs --dump /tmp/jobs.bin
//!   cd text-engine && cargo run --release --example paint_hash -- /tmp/jobs.bin
//!
//! The hash here is 32-bit FNV-1a over the origin, the size and the bytes,
//! because the crate has no SHA-256; `paint-hash.mjs --dump` prints the same
//! in its second column.
use mt_text::paint::{decode, paint_job};
use mt_text::Engine;

fn fnv(h: &mut u32, bytes: &[u8]) {
    for &b in bytes {
        *h ^= u32::from(b);
        *h = h.wrapping_mul(0x0100_0193);
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("path of the dumped jobs");
    let data = std::fs::read(path).expect("readable dump");
    let mut engine = Engine::new();
    // The same fonts in the same order as parity/common.mjs, so the ids match.
    for name in [
        "ComicNeue-Regular.ttf",
        "Bangers-Regular.ttf",
        "DejaVuSans.ttf",
        "DejaVuSans-Oblique.ttf",
    ] {
        let font = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        engine
            .add_font_bytes(std::fs::read(font).expect("fixture font"), 0)
            .expect("a font the engine reads");
    }
    let u32_at = |at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    let mut at = 4;
    for _ in 0..u32_at(0) {
        let len = u32_at(at);
        let request = decode(&data[at + 4..at + 4 + len]).expect("a job the engine reads");
        at += 4 + len;
        let mut h = 0x811c_9dc5u32;
        match paint_job(&mut engine, &request).expect("a job the engine paints") {
            Some(r) => {
                for v in [
                    f64::from(r.x),
                    f64::from(r.y),
                    f64::from(r.width),
                    f64::from(r.height),
                ] {
                    fnv(&mut h, &v.to_le_bytes());
                }
                fnv(&mut h, &r.data);
                println!("{h:08x}  {} x {}", r.width, r.height);
            }
            None => println!("{h:08x}  nothing"),
        }
    }
}
