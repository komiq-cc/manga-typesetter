//! Groups detected DBNet text lines into YOLO text blocks and sorts them into reading order.

use image::GrayImage;

use super::textdetector::TextBlockOut;

/// Script assigned to a text block by the YOLO detector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Eng,
    Ja,
    Unknown,
}

impl Language {
    // No caller yet; kept as the stable string form for logs and future UI.
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Language::Eng => "eng",
            Language::Ja => "ja",
            Language::Unknown => "unknown",
        }
    }

    pub fn from_class(cls: usize) -> Language {
        match cls {
            0 => Language::Eng,
            1 => Language::Ja,
            _ => Language::Unknown,
        }
    }
}

/// A line quad in page coordinates, ordered [TL, TR, BR, BL] in the line's local frame.
pub type Quad = [[i32; 2]; 4];

/// Group of lines representing a speech bubble, caption, or sound effect.
#[derive(Debug, Clone)]
pub struct TextBlock {
    pub xyxy: [i32; 4],
    pub lines: Vec<Quad>,
    pub language: Language,
    pub vertical: bool,
    pub font_size: f64,
    pub angle: i32,
    /// Perpendicular distance from line center to reading origin (TR for vertical, TL otherwise).
    pub distance: Vec<f64>,
    /// Primary writing direction vector summed across lines.
    pub vec: (f64, f64),
    pub norm: f64,
    merged: bool,
    weight: f64,
}

impl TextBlock {
    fn new(xyxy: [i32; 4], language: Language) -> TextBlock {
        TextBlock {
            xyxy,
            lines: Vec::new(),
            language,
            vertical: false,
            font_size: -1.0,
            angle: 0,
            distance: Vec::new(),
            vec: (0.0, 0.0),
            norm: -1.0,
            merged: false,
            weight: -1.0,
        }
    }

    /// Fits `xyxy` to the block's lines, optionally unioning with original proposal.
    fn adjust_bbox(&mut self, with_bbox: bool) {
        if self.lines.is_empty() {
            return;
        }
        let mut x1 = i32::MAX;
        let mut y1 = i32::MAX;
        let mut x2 = i32::MIN;
        let mut y2 = i32::MIN;
        for l in &self.lines {
            for p in l {
                x1 = x1.min(p[0]);
                y1 = y1.min(p[1]);
                x2 = x2.max(p[0]);
                y2 = y2.max(p[1]);
            }
        }
        if with_bbox {
            self.xyxy = [
                x1.min(self.xyxy[0]),
                y1.min(self.xyxy[1]),
                x2.max(self.xyxy[2]),
                y2.max(self.xyxy[3]),
            ];
        } else {
            self.xyxy = [x1, y1, x2, y2];
        }
    }

    fn sort_lines(&mut self) {
        if self.distance.len() != self.lines.len() {
            return;
        }
        let mut idx: Vec<usize> = (0..self.lines.len()).collect();
        idx.sort_by(|&a, &b| self.distance[a].total_cmp(&self.distance[b]));
        self.distance = idx.iter().map(|&i| self.distance[i]).collect();
        self.lines = idx.iter().map(|&i| self.lines[i]).collect();
    }
}

/// Half-to-even rounding matching Python/NumPy.
pub fn round_half_even(v: f64) -> f64 {
    let r = v.round();
    if (v - v.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - v.signum()
    } else {
        r
    }
}

/// Axis-aligned intersection area between two boxes, or -1 when disjoint.
fn intersect_area(a: [i32; 4], b: [i32; 4]) -> f64 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = a[2].min(b[2]);
    let y2 = a[3].min(b[3]);
    if y2 < y1 || x2 < x1 {
        return -1.0;
    }
    ((y2 - y1) as i64 * (x2 - x1) as i64) as f64
}

fn quad_bbox(q: &Quad) -> [i32; 4] {
    let xs = q.iter().map(|p| p[0]);
    let ys = q.iter().map(|p| p[1]);
    [
        xs.clone().min().unwrap(),
        ys.clone().min().unwrap(),
        xs.max().unwrap(),
        ys.max().unwrap(),
    ]
}

/// Computes average intensity in a mask crop with clamped boundaries (returns NaN if empty).
fn crop_mean(mask: &GrayImage, y1: i32, y2: i32, x1: i32, x2: i32) -> f64 {
    let (w, h) = (mask.width() as i32, mask.height() as i32);
    let norm = |v: i32, len: i32| (if v < 0 { len + v } else { v }).clamp(0, len);
    let (xa, xb) = (norm(x1, w), norm(x2, w));
    let (ya, yb) = (norm(y1, h), norm(y2, h));
    if xb <= xa || yb <= ya {
        return f64::NAN;
    }
    let mut total = 0u64;
    for y in ya..yb {
        for x in xa..xb {
            total += mask.get_pixel(x as u32, y as u32).0[0] as u64;
        }
    }
    total as f64 / ((xb - xa) as f64 * (yb - ya) as f64)
}

/// Separating-axis intersection test for two convex quads.
fn quads_intersect(a: &Quad, b: &Quad) -> bool {
    let sep = |p: &Quad, q: &Quad| -> bool {
        for i in 0..4 {
            let j = (i + 1) % 4;
            let (ex, ey) = ((p[j][0] - p[i][0]) as f64, (p[j][1] - p[i][1]) as f64);
            let (nx, ny) = (-ey, ex);
            if nx == 0.0 && ny == 0.0 {
                continue;
            }
            let proj = |r: &Quad| {
                let mut lo = f64::INFINITY;
                let mut hi = f64::NEG_INFINITY;
                for v in r {
                    let d = v[0] as f64 * nx + v[1] as f64 * ny;
                    lo = lo.min(d);
                    hi = hi.max(d);
                }
                (lo, hi)
            };
            let (alo, ahi) = proj(p);
            let (blo, bhi) = proj(q);
            if ahi < blo || bhi < alo {
                return true;
            }
        }
        false
    };
    !sep(a, b) && !sep(b, a)
}

/// Computes block orientation, font size, angle, and line distances from line geometry.
fn examine_textblk(blk: &mut TextBlock, im_w: i32, sort: bool, lang: &str) {
    let n = blk.lines.len();
    if n == 0 {
        return;
    }
    let mut v = (0f64, 0f64);
    let mut h = (0f64, 0f64);
    let mut centers = Vec::with_capacity(n);
    for l in &blk.lines {
        let mid = |k: usize| {
            (
                (l[(k + 1) % 4][0] as f64 + l[k][0] as f64) / 2.0,
                (l[(k + 1) % 4][1] as f64 + l[k][1] as f64) / 2.0,
            )
        };
        let (m0, m1, m2, m3) = (mid(0), mid(1), mid(2), mid(3));
        v.0 += m2.0 - m0.0;
        v.1 += m2.1 - m0.1;
        h.0 += m1.0 - m3.0;
        h.1 += m1.1 - m3.1;
        centers.push((
            (l[0][0] as f64 + l[2][0] as f64) / 2.0,
            (l[0][1] as f64 + l[2][1] as f64) / 2.0,
        ));
    }
    let norm_v = v.0.hypot(v.1);
    let norm_h = h.0.hypot(h.1);
    let is_ko = lang == "ko";
    let vertical = if !is_ko && blk.language == Language::Ja {
        norm_v > norm_h
    } else {
        norm_v > norm_h * 2.0
    };

    // Vertical CJK text (Japanese and Korean alike) reads RTL from top-right;
    // horizontal text reads from top-left.
    let (primary, primary_norm, origin, font_size) = if vertical {
        (v, norm_v, (im_w as f64, 0.0), round_half_even(norm_h / n as f64))
    } else {
        (h, norm_h, (0.0, 0.0), round_half_even(norm_v / n as f64))
    };

    let rotation_angle = ((primary.1.atan2(primary.0)) / std::f64::consts::PI * 180.0).trunc() as i32;
    // Perpendicular distance clamped to [-1.0, 1.0] before acos to avoid NaN.
    let mut distance = Vec::with_capacity(n);
    for c in &centers {
        let d = (c.0 - origin.0, c.1 - origin.1);
        let len = d.0.hypot(d.1);
        let denom = len * primary_norm;
        let rad = if denom > 0.0 {
            ((d.0 * primary.0 + d.1 * primary.1) / denom).clamp(-1.0, 1.0).acos()
        } else {
            0.0
        };
        distance.push((rad.sin() * len).abs());
    }

    blk.distance = distance;
    blk.angle = rotation_angle;
    if vertical {
        blk.angle -= 90;
    }
    if blk.angle.abs() < 3 {
        blk.angle = 0;
    }
    blk.font_size = font_size;
    blk.vertical = vertical;
    blk.vec = primary;
    blk.norm = primary_norm;
    if sort {
        blk.sort_lines();
    }
}

/// Splits a block whose lines have excessive gaps or misalignment.
fn split_textblk(blk: &TextBlock) -> (bool, Vec<TextBlock>) {
    let font_size = blk.font_size;
    let distance = blk.distance.clone();
    let l0 = blk.lines[0];

    // Re-sorted by distance from the first line's first corner.
    let mut lines = blk.lines.clone();
    let key = |l: &Quad| {
        ((l[0][0] - l0[0][0]) as f64).hypot((l[0][1] - l0[0][1]) as f64)
    };
    lines.sort_by(|a, b| key(a).total_cmp(&key(b)));

    let distance_tol = font_size * 2.0;
    let mut sub: Vec<TextBlock> = vec![TextBlock { lines: vec![l0], ..blk.clone() }];

    for jj in 0..lines.len().saturating_sub(1) {
        let line = lines[jj + 1];
        let mut split = false;
        if !quads_intersect(&lines[jj], &line) {
            let line_distance = if jj + 1 < distance.len() {
                (distance[jj + 1] - distance[jj]).abs()
            } else {
                0.0
            };
            if line_distance > distance_tol {
                split = true;
            } else if blk.vertical && blk.angle.abs() < 15 {
                let cur = sub.last().unwrap().lines.len();
                if cur > 1 || line_distance > font_size {
                    split = (lines[jj][0][1] - line[0][1]).abs() as f64 > font_size;
                }
            }
        }
        if split {
            let mut nb = sub.last().unwrap().clone();
            nb.lines = vec![line];
            sub.push(nb);
        } else {
            sub.last_mut().unwrap().lines.push(line);
        }
    }

    if sub.len() > 1 {
        for b in sub.iter_mut() {
            b.adjust_bbox(false);
        }
        (true, sub)
    } else {
        (false, sub)
    }
}

/// Try to absorb `b` into `a` as another line of the same run.
fn try_merge_textline(a: &mut TextBlock, b: &TextBlock) -> bool {
    if b.merged || a.lines.is_empty() || b.lines.is_empty() {
        return false;
    }
    let fntsize_div = a.font_size / b.font_size;
    let (n1, n2) = (a.lines.len() as f64, b.lines.len() as f64);
    let fntsz_avg = (a.font_size * n1 + b.font_size * n2) / (n1 + n2);
    let vec_prod = a.vec.0 * b.vec.0 + a.vec.1 * b.vec.1;
    let vec_sum = (a.vec.0 + b.vec.0, a.vec.1 + b.vec.1);
    let cos_vec = vec_prod / a.norm / b.norm;
    let distance = b.distance[b.distance.len() - 1] - a.distance[a.distance.len() - 1];
    let la = a.lines[a.lines.len() - 1];
    let lb = b.lines[b.lines.len() - 1];
    let distance_p1 = ((lb[0][0] - la[0][0]) as f64).hypot((lb[0][1] - la[0][1]) as f64);

    if !quads_intersect(&la, &lb) {
        if fntsize_div > 1.3 || 1.0 / fntsize_div > 1.3 {
            return false;
        }
        if cos_vec.abs() < 0.866 {
            return false;
        }
        if distance > 2.0 * fntsz_avg || distance_p1 > fntsz_avg * 2.5 {
            return false;
        }
    }

    a.lines.push(b.lines[0]);
    a.vec = vec_sum;
    a.angle = round_half_even(vec_sum.1.atan2(vec_sum.0).to_degrees()) as i32;
    if a.vertical {
        a.angle -= 90;
    }
    a.norm = vec_sum.0.hypot(vec_sum.1);
    a.distance.push(b.distance[b.distance.len() - 1]);
    a.font_size = fntsz_avg;
    true
}

fn merge_textlines(mut blks: Vec<TextBlock>) -> Vec<TextBlock> {
    if blks.len() < 2 {
        return blks;
    }
    blks.sort_by(|a, b| a.distance[0].total_cmp(&b.distance[0]));
    let mut merged_list: Vec<TextBlock> = Vec::new();
    for i in 0..blks.len() {
        if blks[i].merged {
            continue;
        }
        let mut cur = blks[i].clone();
        let (_, rest) = blks.split_at_mut(i + 1);
        for other in rest.iter_mut() {
            if try_merge_textline(&mut cur, other) {
                other.merged = true;
            }
        }
        merged_list.push(cur);
    }
    for b in merged_list.iter_mut() {
        b.adjust_bbox(false);
    }
    merged_list
}

/// Orders blocks into natural reading sequence using a 4x3 grid.
fn sort_textblk_list(blks: &mut [TextBlock], im_w: i32, im_h: i32, lang: &str) {
    if blks.is_empty() {
        return;
    }
    let num_ja = blks.iter().filter(|b| b.language == Language::Ja).count();
    let flip_lr = lang == "ja" && (num_ja as f64 > blks.len() as f64 / 2.0);
    let im_oriw = im_w as f64;
    // For two-page spreads (landscape), halve width to compute per-page grid.
    let w = if im_w > im_h { im_w as f64 / 2.0 } else { im_w as f64 };
    let h = im_h as f64;
    let (ngy, ngx) = (4.0f64, 3.0f64);
    let img_area = h * w;

    for b in blks.iter_mut() {
        let mut cx = (b.xyxy[0] as f64 + b.xyxy[2] as f64) / 2.0;
        if flip_lr {
            cx = if w != im_oriw { im_oriw - cx } else { w - cx };
        }
        let cy = (b.xyxy[1] as f64 + b.xyxy[3] as f64) / 2.0;
        let gx = (cx / w * ngx).trunc();
        let gy = (cy / h * ngy).trunc();
        let mut weight = (gy * ngx + gx) * img_area + 1.2 * (cx - gx * w / ngx) + (cy - gy * h / ngy);
        if w != im_oriw && gx >= ngx {
            weight += img_area * ngy * ngx;
        }
        b.weight = weight;
    }
    blks.sort_by(|a, b| a.weight.total_cmp(&b.weight));
}

/// Reconciles YOLO block proposals with DBNet line quads and sorts them.
pub fn group_output(
    blks: &[([i32; 4], usize)],
    lines: &[Quad],
    im_w: i32,
    im_h: i32,
    mask: &GrayImage,
    lang: &str,
) -> Vec<TextBlock> {
    const BBOX_SCORE_THRESH: f64 = 0.4;
    const MASK_SCORE_THRESH: f64 = 0.1;

    if im_w <= 0 || im_h <= 0 {
        return Vec::new();
    }

    let mut blk_list: Vec<TextBlock> = blks
        .iter()
        .map(|&(bbox, cls)| TextBlock::new(bbox, Language::from_class(cls)))
        .collect();
    let mut scattered_ver: Vec<TextBlock> = Vec::new();
    let mut scattered_hor: Vec<TextBlock> = Vec::new();

    // Step 1: every line goes to whichever proposal covers most of it.
    for line in lines {
        let lb = quad_bbox(line);
        let line_area = ((lb[3] - lb[1]) as i64 * (lb[2] - lb[0]) as i64) as f64;
        let mut best = -1.0f64;
        let mut best_idx: isize = -1;
        for (j, blk) in blk_list.iter().enumerate() {
            let score = intersect_area(blk.xyxy, lb) / line_area;
            if best < score {
                best = score;
                best_idx = j as isize;
            }
        }
        if best > BBOX_SCORE_THRESH {
            blk_list[best_idx as usize].lines.push(*line);
        } else {
            if crop_mean(mask, lb[1], lb[3], lb[0], lb[2]) / 255.0 < MASK_SCORE_THRESH {
                continue;
            }
            let mut blk = TextBlock::new(lb, Language::Unknown);
            blk.lines.push(*line);
            examine_textblk(&mut blk, im_w, false, lang);
            if blk.vertical {
                scattered_ver.push(blk);
            } else {
                scattered_hor.push(blk);
            }
        }
    }

    // Step 2: fill in, measure and split.
    let mut final_list: Vec<TextBlock> = Vec::new();
    for mut blk in blk_list {
        if blk.lines.is_empty() {
            let [x1, y1, x2, y2] = blk.xyxy;
            if crop_mean(mask, y1, y2, x1, x2) / 255.0 < MASK_SCORE_THRESH {
                continue;
            }
            // No line landed here but there is text under the box, so treat the
            // whole proposal as a single line.
            blk.lines.push([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
        }
        examine_textblk(&mut blk, im_w, true, lang);

        let want_split =
            blk.lines.len() > 1 && (blk.language == Language::Ja || blk.vertical);
        let (splitted, mut sub) = if want_split { split_textblk(&blk) } else { (false, vec![blk]) };
        if !splitted {
            for b in sub.iter_mut() {
                b.adjust_bbox(true);
            }
        }
        final_list.extend(sub);
    }

    // Step 3: rescue the strays, then sort.
    final_list.extend(merge_textlines(scattered_hor));
    final_list.extend(merge_textlines(scattered_ver));
    sort_textblk_list(&mut final_list, im_w, im_h, lang);

    // Step 4: Latin glyphs have ascenders and descenders the shrink map clips,
    // so horizontal English lines get padded outward before they are cropped.
    for blk in final_list.iter_mut() {
        if blk.language == Language::Eng && !blk.vertical && !blk.lines.is_empty() {
            let expand = ((blk.font_size * 0.1).trunc() as i64).max(2) as f64;
            let rad = (blk.angle as f64).to_radians();
            let signs = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];
            for l in blk.lines.iter_mut() {
                for k in 0..4 {
                    let dx = signs[k][0] * rad.sin() * expand;
                    let dy = signs[k][1] * rad.cos() * expand;
                    l[k][0] = (l[k][0] as f64 + dx).clamp(0.0, (im_w - 1) as f64).trunc() as i32;
                    l[k][1] = (l[k][1] as f64 + dy).clamp(0.0, (im_h - 1) as f64).trunc() as i32;
                }
            }
            blk.font_size += expand;
        }
    }

    final_list
}

/// Minimum IoA with a text block for a text region to be considered contained.
pub const REGION_IN_BLOCK_IOA: f64 = 0.5;

/// Minimum IoA with a text line for a line-to-region match to be meaningful.
pub const LINE_MATCH_IOA: f64 = 0.2;

/// Ratio of second-best to best match IoA above which line assignment is considered ambiguous.
pub const AMBIGUOUS_MATCH_RATIO: f64 = 0.85;

fn box_area(b: [i32; 4]) -> f64 {
    let w = (b[2] - b[0]).max(0) as i64;
    let h = (b[3] - b[1]).max(0) as i64;
    (w * h) as f64
}

fn safe_intersect_area(a: [i32; 4], b: [i32; 4]) -> f64 {
    let inter = intersect_area(a, b);
    if inter < 0.0 {
        0.0
    } else {
        inter
    }
}

fn nearest_contained_region(lb: &[i32; 4], contained: &[[i32; 4]]) -> usize {
    let line_cx = (lb[0] as f64 + lb[2] as f64) / 2.0;
    let line_cy = (lb[1] as f64 + lb[3] as f64) / 2.0;

    let mut best_idx = 0;
    let mut best_dist_sq = f64::INFINITY;

    for (i, r) in contained.iter().enumerate() {
        let rcx = (r[0] as f64 + r[2] as f64) / 2.0;
        let rcy = (r[1] as f64 + r[3] as f64) / 2.0;
        let dx = rcx - line_cx;
        let dy = rcy - line_cy;
        let dist_sq = dx * dx + dy * dy;
        if dist_sq < best_dist_sq {
            best_dist_sq = dist_sq;
            best_idx = i;
        }
    }

    best_idx
}

/// A region sitting inside another (IoA above `REGION_IN_BLOCK_IOA`) is one of two
/// things: a duplicate - one balloon boxed twice, once whole and once around its
/// longest column - or one section of a conjoined pair the model also boxed as a
/// whole. MangaTranslator tells them apart by count, and so does this: a container
/// with two or more children is the conjoined whole and goes, leaving its
/// sections; a container with exactly one child is the real balloon and the child
/// goes. Without this a nested duplicate split a single balloon down its last
/// column on the first real chapter it was run over.
fn dedupe_nested_regions(regions: &[[i32; 4]]) -> Vec<[i32; 4]> {
    let mut drop = vec![false; regions.len()];
    for (i, big) in regions.iter().enumerate() {
        let big_area = box_area(*big);
        let children: Vec<usize> = regions
            .iter()
            .enumerate()
            .filter(|&(j, small)| {
                if j == i {
                    return false;
                }
                let a = box_area(*small);
                // Equal areas are ordered by index so a pair of identical boxes
                // resolves to one survivor rather than none.
                let smaller = a < big_area || (a == big_area && j > i);
                a > 0.0 && smaller && safe_intersect_area(*small, *big) / a > REGION_IN_BLOCK_IOA
            })
            .map(|(j, _)| j)
            .collect();
        match children.len() {
            0 => {}
            1 => drop[children[0]] = true,
            _ => drop[i] = true,
        }
    }
    regions
        .iter()
        .enumerate()
        .filter(|&(i, _)| !drop[i])
        .map(|(_, r)| *r)
        .collect()
}

/// Splits blocks the detector drew across two neighbouring bubbles, using per-bubble
/// text regions from a second detector (MangaTranslator's conjoined-bubble rule).
pub fn split_by_regions(
    blocks: Vec<TextBlockOut>,
    regions: &[[i32; 4]],
    im_w: i32,
    lang: &str,
) -> Vec<TextBlockOut> {
    let regions = dedupe_nested_regions(regions);
    let mut out = Vec::with_capacity(blocks.len());

    for blk in blocks {
        if blk.lines.len() < 2 {
            out.push(blk);
            continue;
        }

        let contained: Vec<[i32; 4]> = regions
            .iter()
            .copied()
            .filter(|&region| {
                let r_area = box_area(region);
                if r_area <= 0.0 {
                    return false;
                }
                let inter = safe_intersect_area(region, blk.xyxy);
                (inter / r_area) > REGION_IN_BLOCK_IOA
            })
            .collect();

        if contained.len() < 2 {
            out.push(blk);
            continue;
        }

        let mut groups: Vec<Vec<Quad>> = vec![Vec::new(); contained.len()];
        let mut first_seen: Vec<Option<usize>> = vec![None; contained.len()];

        for (line_idx, line) in blk.lines.iter().enumerate() {
            let lb = quad_bbox(line);
            let lb_area = box_area(lb);

            let mut matches: Vec<(usize, f64)> = Vec::new();
            if lb_area > 0.0 {
                for (r_idx, &region) in contained.iter().enumerate() {
                    let inter = safe_intersect_area(lb, region);
                    if inter / lb_area >= LINE_MATCH_IOA {
                        matches.push((r_idx, inter));
                    }
                }
            }

            matches.sort_by(|a, b| b.1.total_cmp(&a.1));

            let assigned_r_idx = if !matches.is_empty() {
                let best = matches[0];
                let is_ambiguous =
                    matches.len() > 1 && (matches[1].1 / best.1) >= AMBIGUOUS_MATCH_RATIO;
                if !is_ambiguous {
                    best.0
                } else {
                    nearest_contained_region(&lb, &contained)
                }
            } else {
                nearest_contained_region(&lb, &contained)
            };

            if first_seen[assigned_r_idx].is_none() {
                first_seen[assigned_r_idx] = Some(line_idx);
            }
            groups[assigned_r_idx].push(*line);
        }

        let non_empty_count = groups.iter().filter(|g| !g.is_empty()).count();
        if non_empty_count < 2 {
            out.push(blk);
            continue;
        }

        let mut non_empty_indices: Vec<usize> = (0..contained.len())
            .filter(|&i| !groups[i].is_empty())
            .collect();
        non_empty_indices.sort_by_key(|&i| first_seen[i].unwrap());

        for i in non_empty_indices {
            let lines = std::mem::take(&mut groups[i]);
            let mut tb = TextBlock::new(blk.xyxy, blk.language);
            tb.lines = lines;
            examine_textblk(&mut tb, im_w, true, lang);
            tb.adjust_bbox(false);
            out.push(TextBlockOut {
                xyxy: tb.xyxy,
                lines: tb.lines,
                vertical: tb.vertical,
                font_size: tb.font_size,
                angle: tb.angle,
                language: tb.language,
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_full(w: u32, h: u32) -> GrayImage {
        GrayImage::from_pixel(w, h, image::Luma([255]))
    }

    fn mask_empty(w: u32, h: u32) -> GrayImage {
        GrayImage::from_pixel(w, h, image::Luma([0]))
    }

    /// A vertical text line: tall and narrow, corners in the quad order DBNet
    /// emits.
    fn vline(x: i32, y: i32, w: i32, h: i32) -> Quad {
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    }

    #[test]
    fn a_line_inside_a_proposal_is_assigned_to_it() {
        let blks = [([100, 100, 200, 400], 1usize)];
        let lines = [vline(120, 110, 30, 260)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lines.len(), 1);
        assert_eq!(out[0].language, Language::Ja);
    }

    #[test]
    fn a_line_outside_every_proposal_becomes_its_own_block() {
        let blks = [([600, 20, 700, 90], 1usize)];
        let lines = [vline(100, 100, 30, 260)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        // The proposal has no lines but a full mask, so it survives with a
        // synthetic line; the stray becomes a second block.
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|b| b.language == Language::Unknown));
    }

    #[test]
    fn a_stray_line_over_blank_mask_is_discarded() {
        let blks: [([i32; 4], usize); 0] = [];
        let lines = [vline(100, 100, 30, 260)];
        assert!(group_output(&blks, &lines, 800, 600, &mask_empty(800, 600), "ja").is_empty());
    }

    #[test]
    fn an_empty_proposal_over_blank_mask_is_discarded() {
        let blks = [([100, 100, 200, 400], 1usize)];
        assert!(group_output(&blks, &[], 800, 600, &mask_empty(800, 600), "ja").is_empty());
    }

    #[test]
    fn an_empty_proposal_over_text_gets_one_synthetic_line() {
        let blks = [([100, 100, 200, 400], 1usize)];
        let out = group_output(&blks, &[], 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lines.len(), 1);
        assert_eq!(out[0].xyxy, [100, 100, 200, 400]);
    }

    #[test]
    fn tall_narrow_japanese_lines_read_as_vertical() {
        let blks = [([100, 100, 220, 400], 1usize)];
        let lines = [vline(180, 110, 30, 280), vline(140, 110, 30, 280)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert!(out[0].vertical);
        // Font size for vertical text is the mean line *width*.
        assert!((out[0].font_size - 30.0).abs() < 1.0, "{}", out[0].font_size);
        assert_eq!(out[0].angle, 0);
    }

    #[test]
    fn a_line_sitting_on_the_reading_origin_gets_a_real_distance_not_a_nan() {
        // The horizontal origin is the page's top-left corner, so a line whose
        // centre lands there divides 0 by 0 on the way into `acos`. NumPy
        // answers NaN; a NaN here sorts above every real distance in
        // `total_cmp` and defeats every `distance > threshold` guard, so the
        // block drifts to the end of the reading order and merges with things
        // it should not.
        let mut blk = TextBlock::new([-10, -10, 10, 10], Language::Eng);
        blk.lines.push([[-10, -10], [10, -10], [10, 10], [-10, 10]]);
        examine_textblk(&mut blk, 800, false, "ja");
        assert_eq!(blk.distance.len(), 1);
        assert!(blk.distance[0].is_finite(), "{:?}", blk.distance);
        assert_eq!(blk.distance[0], 0.0);

        // Centred on writing axis gives 0 perpendicular distance without NaN.
        let mut blk = TextBlock::new([0, -10, 300, 10], Language::Eng);
        blk.lines.push([[0, -10], [300, -10], [300, 10], [0, 10]]);
        examine_textblk(&mut blk, 800, false, "ja");
        assert!(blk.distance[0].is_finite(), "{:?}", blk.distance);
        assert!(blk.distance[0].abs() < 1e-6, "{:?}", blk.distance);

        // A line quad collapsed to a point has no writing direction at all.
        let mut blk = TextBlock::new([50, 50, 50, 50], Language::Ja);
        blk.lines.push([[50, 50], [50, 50], [50, 50], [50, 50]]);
        examine_textblk(&mut blk, 800, false, "ja");
        assert!(blk.distance[0].is_finite(), "{:?}", blk.distance);
    }

    #[test]
    fn a_page_with_no_area_yields_no_blocks_instead_of_panicking() {
        // Zero dimensions must not panic in padding clamp.
        let blks = [([0, 0, 10, 10], 0usize)];
        let lines = [[[0, 0], [10, 0], [10, 5], [0, 5]]];
        assert!(group_output(&blks, &lines, 0, 600, &mask_full(1, 600), "ja").is_empty());
        assert!(group_output(&blks, &lines, 800, 0, &mask_full(800, 1), "ja").is_empty());
        assert!(group_output(&blks, &lines, 0, 0, &mask_full(1, 1), "ja").is_empty());
    }

    #[test]
    fn wide_short_english_lines_read_as_horizontal() {
        let blks = [([100, 100, 400, 180], 0usize)];
        let lines = [
            [[110, 110], [380, 110], [380, 132], [110, 132]],
            [[110, 140], [380, 140], [380, 162], [110, 162]],
        ];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert!(!out[0].vertical);
        assert_eq!(out[0].language, Language::Eng);
        // English blocks are padded outward, so the recorded size exceeds the
        // measured 22 px line height.
        assert!(out[0].font_size > 22.0, "{}", out[0].font_size);
    }

    #[test]
    fn a_japanese_block_splits_where_its_columns_are_far_apart() {
        // Two columns three font-sizes apart inside one proposal. The gap is
        // wider than the split rule tolerates, so this must come back as two.
        let blks = [([100, 100, 400, 400], 1usize)];
        let lines = [vline(110, 110, 30, 280), vline(330, 110, 30, 280)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out.len(), 2, "{out:#?}");
    }

    #[test]
    fn adjacent_columns_stay_one_block() {
        let blks = [([100, 100, 200, 400], 1usize)];
        let lines = [vline(110, 110, 30, 280), vline(145, 110, 30, 280)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lines.len(), 2);
    }

    #[test]
    fn japanese_pages_sort_right_to_left() {
        let blks = [([50, 50, 150, 300], 1usize), ([600, 50, 700, 300], 1usize)];
        let lines = [vline(60, 60, 30, 220), vline(610, 60, 30, 220)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out.len(), 2);
        assert!(out[0].xyxy[0] > out[1].xyxy[0], "right block should come first");
    }

    #[test]
    fn english_pages_sort_left_to_right() {
        let blks = [([50, 50, 300, 120], 0usize), ([500, 50, 750, 120], 0usize)];
        let lines = [
            [[60, 60], [290, 60], [290, 84], [60, 84]],
            [[510, 60], [740, 60], [740, 84], [510, 84]],
        ];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert!(out[0].xyxy[0] < out[1].xyxy[0]);
    }

    #[test]
    fn korean_pages_do_not_flip_lr_even_when_all_blocks_are_ja() {
        // Two blocks tagged Ja: right block [600..700], left block [50..150].
        let blks = [([50, 50, 150, 300], 1usize), ([600, 50, 700, 300], 1usize)];
        let lines = [vline(60, 60, 30, 220), vline(610, 60, 30, 220)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ko");
        assert_eq!(out.len(), 2);
        assert!(out[0].xyxy[0] < out[1].xyxy[0], "left block should come first in Korean LTR");
    }

    #[test]
    fn korean_pages_use_strict_vertical_threshold_and_top_left_origin() {
        // Single block with aspect ratio 1.5 (norm_v = 1.5 * norm_h):
        // In Japanese (norm_v > norm_h), this would be considered vertical.
        // In Korean (norm_v > norm_h * 2.0 is required), this must stay horizontal.
        let mut blk_ja = TextBlock::new([100, 100, 200, 250], Language::Ja);
        blk_ja.lines.push([[100, 100], [200, 100], [200, 250], [100, 250]]);
        examine_textblk(&mut blk_ja, 800, false, "ja");
        assert!(blk_ja.vertical, "Ja should use relaxed vertical threshold");

        let mut blk_ko = TextBlock::new([100, 100, 200, 250], Language::Ja);
        blk_ko.lines.push([[100, 100], [200, 100], [200, 250], [100, 250]]);
        examine_textblk(&mut blk_ko, 800, false, "ko");
        assert!(!blk_ko.vertical, "Ko must use strict 2.0 vertical threshold");
    }

    #[test]
    fn vertical_korean_columns_still_read_right_to_left() {
        // Vertical Korean (세로쓰기) reads top-to-bottom, right-to-left, exactly
        // like vertical Japanese: the column nearest the right edge comes first.
        let mut blk = TextBlock::new([100, 60, 630, 280], Language::Ja);
        blk.lines.push(vline(100, 60, 30, 220));
        blk.lines.push(vline(600, 60, 30, 220));
        examine_textblk(&mut blk, 800, true, "ko");
        assert!(blk.vertical, "tall narrow columns are vertical regardless of language");
        assert!(
            blk.lines[0][0][0] >= 600,
            "the right-hand column must be read first in vertical Korean"
        );
    }

    #[test]
    fn the_block_box_covers_both_its_lines_and_its_proposal() {
        // Block box expands to enclose lines extending outside proposal.
        let blks = [([100, 100, 200, 300], 1usize)];
        let lines = [vline(120, 90, 30, 260)];
        let out = group_output(&blks, &lines, 800, 600, &mask_full(800, 600), "ja");
        assert_eq!(out[0].xyxy, [100, 90, 200, 350]);
    }

    #[test]
    fn quads_intersect_counts_a_shared_edge() {
        let a = vline(0, 0, 10, 10);
        let b = vline(10, 0, 10, 10);
        assert!(quads_intersect(&a, &b));
        assert!(!quads_intersect(&a, &vline(11, 0, 10, 10)));
    }

    #[test]
    fn crop_mean_of_an_empty_slice_is_nan() {
        let m = mask_full(10, 10);
        assert!(crop_mean(&m, 5, 5, 0, 10).is_nan());
        assert!((crop_mean(&m, 0, 10, 0, 10) - 255.0).abs() < 1e-9);
    }

    #[test]
    fn round_half_even_matches_numpy() {
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(3.5), 4.0);
    }

    fn hline(x: i32, y: i32, w: i32, h: i32) -> Quad {
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    }

    #[test]
    fn split_by_regions_horizontal_block_with_two_regions_splits() {
        let lines = vec![
            hline(110, 120, 160, 30),
            hline(110, 170, 160, 30),
            hline(310, 120, 160, 30),
            hline(310, 170, 160, 30),
        ];
        let blk = TextBlockOut {
            xyxy: [100, 100, 500, 220],
            lines,
            vertical: true,
            font_size: 15.0,
            angle: 0,
            language: Language::Eng,
        };
        let regions = [[100, 100, 280, 220], [300, 100, 480, 220]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 2);

        assert_eq!(out[0].xyxy, [110, 120, 270, 200]);
        assert_eq!(out[0].lines.len(), 2);
        assert!(!out[0].vertical);
        assert!((out[0].font_size - 30.0).abs() < 1e-6);

        assert_eq!(out[1].xyxy, [310, 120, 470, 200]);
        assert_eq!(out[1].lines.len(), 2);
        assert!(!out[1].vertical);
        assert!((out[1].font_size - 30.0).abs() < 1e-6);
    }

    #[test]
    fn split_by_regions_horizontal_block_with_one_region_unchanged() {
        let lines = vec![
            hline(110, 120, 160, 30),
            hline(110, 170, 160, 30),
            hline(310, 120, 160, 30),
            hline(310, 170, 160, 30),
        ];
        let blk = TextBlockOut {
            xyxy: [100, 100, 500, 220],
            lines,
            vertical: false,
            font_size: 30.0,
            angle: 0,
            language: Language::Eng,
        };
        let regions = [[100, 100, 280, 220]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].xyxy, [100, 100, 500, 220]);
        assert_eq!(out[0].lines.len(), 4);
    }

    #[test]
    fn split_by_regions_unmatched_line_lands_with_nearest_region() {
        let lines = vec![
            hline(110, 120, 80, 30),
            hline(410, 120, 80, 30),
            hline(210, 120, 40, 30),
        ];
        let blk = TextBlockOut {
            xyxy: [100, 100, 500, 200],
            lines,
            vertical: false,
            font_size: 30.0,
            angle: 0,
            language: Language::Eng,
        };
        let regions = [[100, 100, 200, 200], [400, 100, 500, 200]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].lines.len(), 2);
        assert_eq!(out[1].lines.len(), 1);
    }

    #[test]
    fn split_by_regions_all_lines_in_same_region_unchanged() {
        let lines = vec![
            hline(110, 120, 80, 30),
            hline(110, 160, 80, 30),
        ];
        let blk = TextBlockOut {
            xyxy: [100, 100, 500, 200],
            lines,
            vertical: false,
            font_size: 30.0,
            angle: 0,
            language: Language::Eng,
        };
        let regions = [[100, 100, 200, 200], [400, 100, 500, 200]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].xyxy, [100, 100, 500, 200]);
        assert_eq!(out[0].lines.len(), 2);
    }

    // Page 14 of the first real chapter this ran over: the model boxed one
    // balloon twice, whole and around its last column, and the split cut the
    // balloon down that column. The inner duplicate has to go, not the balloon.
    #[test]
    fn a_region_nested_inside_one_other_is_a_duplicate_and_splits_nothing() {
        let lines = vec![
            vline(180, 110, 30, 120),
            vline(140, 110, 30, 120),
            vline(100, 110, 30, 120),
        ];
        let blk = TextBlockOut {
            xyxy: [90, 100, 220, 240],
            lines,
            vertical: true,
            font_size: 30.0,
            angle: 0,
            language: Language::Ja,
        };
        let regions = [[95, 105, 215, 235], [178, 108, 212, 232]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lines.len(), 3);
    }

    // The other nesting: the model boxed a conjoined pair both as a whole and
    // as its two sections. The whole is the redundant one; the sections split.
    #[test]
    fn a_region_holding_two_others_is_the_conjoined_whole_and_the_sections_split() {
        let lines = vec![
            vline(180, 110, 30, 120),
            vline(140, 110, 30, 120),
            vline(180, 310, 30, 120),
            vline(140, 310, 30, 120),
        ];
        let blk = TextBlockOut {
            xyxy: [130, 100, 220, 450],
            lines,
            vertical: true,
            font_size: 30.0,
            angle: 0,
            language: Language::Ja,
        };
        let regions = [[130, 100, 220, 450], [130, 100, 220, 250], [130, 300, 220, 450]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].lines.len(), 2);
        assert_eq!(out[1].lines.len(), 2);
    }

    #[test]
    fn split_by_regions_vertical_stacked_bubbles_splits() {
        let lines = vec![
            vline(180, 110, 30, 120),
            vline(140, 110, 30, 120),
            vline(180, 310, 30, 120),
            vline(140, 310, 30, 120),
        ];
        let blk = TextBlockOut {
            xyxy: [130, 100, 220, 450],
            lines,
            vertical: true,
            font_size: 30.0,
            angle: 0,
            language: Language::Ja,
        };
        let regions = [[130, 100, 220, 250], [130, 300, 220, 450]];
        let out = split_by_regions(vec![blk], &regions, 800, "ja");
        assert_eq!(out.len(), 2);
        assert!(out[0].vertical);
        assert_eq!(out[0].lines.len(), 2);
        assert!(out[1].vertical);
        assert_eq!(out[1].lines.len(), 2);
    }
}
