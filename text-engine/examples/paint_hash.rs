//! The native build paints the jobs `parity/paint-hash.mjs --native` wrote
//! and prints the hash of each raster, one a line, to set beside the wasm's.
//!
//!   node text-engine/parity/paint-hash.mjs --native
//!
//! runs this itself. The hash is `rasterHash` of `js/paint.mjs`: 32-bit
//! FNV-1a and Jenkins's one-at-a-time side by side, over the origin, the
//! size and the bytes.
use mt_text::paint::{decode, paint_job};
use mt_text::{BoldAdvance, Engine, Synth};

#[derive(Clone, Copy)]
struct Hash(u32, u32);

impl Hash {
    fn eat(&mut self, bytes: &[u8]) {
        for &v in bytes {
            self.0 = (self.0 ^ u32::from(v)).wrapping_mul(0x0100_0193);
            self.1 = self.1.wrapping_add(u32::from(v));
            self.1 = self.1.wrapping_add(self.1 << 10);
            self.1 ^= self.1 >> 6;
        }
    }

    fn finish(mut self) -> String {
        self.1 = self.1.wrapping_add(self.1 << 3);
        self.1 ^= self.1 >> 11;
        self.1 = self.1.wrapping_add(self.1 << 15);
        format!("{:08x}{:08x}", self.0, self.1)
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("path of the dumped jobs");
    let data = std::fs::read(path).expect("readable dump");
    let mut engine = Engine::new();
    // The same fonts in the same order as parity/common.mjs, so the ids match.
    let mut ids = Vec::new();
    for name in [
        "ComicNeue-Regular.ttf",
        "Bangers-Regular.ttf",
        "DejaVuSans.ttf",
        "DejaVuSans-Oblique.ttf",
    ] {
        let font = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(font).expect("fixture font");
        ids.push(
            engine
                .add_font_bytes(bytes, 0)
                .expect("a font the engine reads"),
        );
    }
    // The chain `hashFixedJobs` makes: the first one, falling back to DejaVu Sans.
    let chain = engine.chain_new();
    engine
        .chain_push(chain, ids[2], Synth::NONE)
        .expect("a chain");
    let u32_at = |at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    let mut at = 4;
    for _ in 0..u32_at(0) {
        engine.rules.bold_advance = match u32_at(at) {
            0 => BoldAdvance::Unchanged,
            _ => BoldAdvance::WebKit,
        };
        let len = u32_at(at + 4);
        let request = decode(&data[at + 8..at + 8 + len]).expect("a job the engine reads");
        at += 8 + len;
        let mut h = Hash(0x811c_9dc5, 0);
        if let Some(r) = paint_job(&mut engine, &request).expect("a job the engine paints") {
            for v in [r.x, r.y, r.width as i32, r.height as i32] {
                h.eat(&v.to_le_bytes());
            }
            h.eat(&r.data);
        }
        println!("{}", h.finish());
    }
}
