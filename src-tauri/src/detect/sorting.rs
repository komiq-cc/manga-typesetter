//! Manga reading-order sorting and text line-type assignment.
//!
//! Hierarchical reading order: macro (panel layout) + micro (spatial bubble banding).
//! SFX vs dialogue classification via median font size heuristic.

/// Classification of a detected text line into dialogue or sound effect (SFX).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineType {
    /// Spoken dialogue inside speech bubbles or captions.
    #[default]
    Dialogue,
    /// Sound effects, typically drawn larger.
    Sfx,
}

impl LineType {
    /// Return the string representation ("dialogue" or "sfx").
    pub fn as_str(&self) -> &'static str {
        match self {
            LineType::Dialogue => "dialogue",
            LineType::Sfx => "sfx",
        }
    }
}

impl std::fmt::Display for LineType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Manga reading direction (RTL Japanese vs LTR western).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReadingDirection {
    #[default]
    Rtl,
    // Mirrors the upstream enum; nothing selects it until a direction toggle ships.
    #[allow(dead_code)]
    Ltr,
}

/// Detected text block with bounding box, orientation, font size, text, and line type.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Block {
    /// Bounding rectangle `[x1, y1, x2, y2]` in page coordinates.
    #[serde(rename = "box")]
    pub r#box: [i32; 4],
    /// Whether the text within the bubble is vertically oriented.
    #[serde(default)]
    pub vertical: bool,
    /// Estimated font size in pixels (used for SFX vs dialogue heuristic).
    #[serde(default)]
    pub font_size: f32,
    /// OCR-extracted Japanese or Korean text.
    #[serde(default)]
    pub jp: String,
    /// Assigned line type (`dialogue` or `sfx`).
    #[serde(default, rename = "type")]
    pub line_type: LineType,
}

impl Block {
    /// Create a new text block with default `LineType::Dialogue`.
    pub fn new(r#box: [i32; 4], vertical: bool, font_size: f32, jp: String) -> Self {
        Self {
            r#box,
            vertical,
            font_size,
            jp,
            line_type: LineType::Dialogue,
        }
    }
}

/// Horizontal intersection over union between two bounding boxes.
fn iou_x(a: [f32; 4], b: [f32; 4]) -> f32 {
    let inter = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let union = (a[2] - a[0]) + (b[2] - b[0]) - inter;
    if union > 0.0 {
        inter / union
    } else {
        0.0
    }
}

/// Vertical overlap ratio relative to the smaller box's height.
fn iou_y_overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let inter = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let min_h = (a[3] - a[1]).min(b[3] - b[1]);
    if min_h > 0.0 {
        inter / min_h
    } else {
        0.0
    }
}

#[derive(Debug, Clone)]
struct PanelNode {
    id: usize,
    bbox: [f32; 4],
    center: (f32, f32),
    visited: bool,
}

/// Sort panel bounding boxes into reading order using a topological graph sort
/// with ceiling and right-neighbor vetoes.
///
/// Ported directly from `sort_panels_by_reading_order` in `python/sidecar/sorting.py`.
pub fn sort_panels_by_reading_order(
    panels: &[[i32; 4]],
    direction: ReadingDirection,
) -> Vec<usize> {
    if panels.is_empty() {
        return Vec::new();
    }

    let rtl = matches!(direction, ReadingDirection::Rtl);

    let mut nodes: Vec<PanelNode> = panels
        .iter()
        .enumerate()
        .map(|(i, &b)| {
            let bbox = [b[0] as f32, b[1] as f32, b[2] as f32, b[3] as f32];
            let center = ((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0);
            PanelNode {
                id: i,
                bbox,
                center,
                visited: false,
            }
        })
        .collect();

    let mut sorted_indices = Vec::with_capacity(nodes.len());

    // Roots: panels with no panel above them in the same column.
    let mut root_indices = Vec::new();
    for i in 0..nodes.len() {
        let mut is_root = true;
        for j in 0..nodes.len() {
            if nodes[i].id == nodes[j].id {
                continue;
            }
            let is_above = nodes[j].bbox[3] <= (nodes[i].bbox[1] + 50.0);
            let x_overlap = iou_x(nodes[j].bbox, nodes[i].bbox);
            if is_above && x_overlap > 0.2 {
                is_root = false;
                break;
            }
        }
        if is_root {
            root_indices.push(i);
        }
    }

    let initial_idx = if !root_indices.is_empty() {
        if rtl {
            // max root node by bbox[2] (right-most panel)
            let mut best_i = root_indices[0];
            let mut best_val = nodes[best_i].bbox[2];
            for &i in &root_indices[1..] {
                if nodes[i].bbox[2] > best_val {
                    best_val = nodes[i].bbox[2];
                    best_i = i;
                }
            }
            best_i
        } else {
            // min root node by bbox[0] (left-most panel)
            let mut best_i = root_indices[0];
            let mut best_val = nodes[best_i].bbox[0];
            for &i in &root_indices[1..] {
                if nodes[i].bbox[0] < best_val {
                    best_val = nodes[i].bbox[0];
                    best_i = i;
                }
            }
            best_i
        }
    } else {
        // min node by bbox[1] (top-most panel)
        let mut best_i = 0;
        let mut best_val = nodes[0].bbox[1];
        for (i, node) in nodes.iter().enumerate().skip(1) {
            if node.bbox[1] < best_val {
                best_val = node.bbox[1];
                best_i = i;
            }
        }
        best_i
    };

    nodes[initial_idx].visited = true;
    sorted_indices.push(nodes[initial_idx].id);
    let mut current_idx = initial_idx;

    while sorted_indices.len() < nodes.len() {
        let c_box = nodes[current_idx].bbox;
        let candidates: Vec<usize> = nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| !n.visited)
            .map(|(i, _)| i)
            .collect();

        if candidates.is_empty() {
            break;
        }

        // 1. Column candidate search (panel directly below current)
        let mut col_candidates: Vec<(f32, usize)> = Vec::new();
        for &cand_idx in &candidates {
            let cand_box = nodes[cand_idx].bbox;
            let overlap = iou_x(c_box, cand_box);
            let is_below = cand_box[1] >= (c_box[1] + (c_box[3] - c_box[1]) * 0.5);
            if overlap > 0.2 && is_below {
                let dist_y = (cand_box[1] - c_box[3]).max(0.0);
                col_candidates.push((dist_y, cand_idx));
            }
        }

        let mut col_cand = if !col_candidates.is_empty() {
            col_candidates.sort_by(|&(dist_a, idx_a), &(dist_b, idx_b)| {
                let key1_a = (dist_a / 50.0) as i32;
                let key1_b = (dist_b / 50.0) as i32;
                if key1_a != key1_b {
                    return key1_a.cmp(&key1_b);
                }
                let key2_a = if rtl {
                    -nodes[idx_a].center.0
                } else {
                    nodes[idx_a].center.0
                };
                let key2_b = if rtl {
                    -nodes[idx_b].center.0
                } else {
                    nodes[idx_b].center.0
                };
                key2_a.total_cmp(&key2_b)
            });
            Some(col_candidates[0].1)
        } else {
            None
        };

        // 2. Row candidate search (panel to the left for RTL, or right for LTR)
        let mut row_candidates: Vec<(f32, usize)> = Vec::new();
        for &cand_idx in &candidates {
            let cand_box = nodes[cand_idx].bbox;
            let (is_row_neighbor, dist_x) = if rtl {
                (
                    cand_box[2] <= (c_box[0] + 50.0),
                    c_box[0] - cand_box[2],
                )
            } else {
                (
                    cand_box[0] >= (c_box[2] - 50.0),
                    cand_box[0] - c_box[2],
                )
            };

            if is_row_neighbor {
                let y_inter = (c_box[3].min(cand_box[3]) - c_box[1].max(cand_box[1])).max(0.0);
                if y_inter > 0.0 {
                    row_candidates.push((dist_x, cand_idx));
                }
            }
        }

        let mut row_cand = if !row_candidates.is_empty() {
            row_candidates.sort_by(|&(dist_a, _), &(dist_b, _)| dist_a.total_cmp(&dist_b));
            Some(row_candidates[0].1)
        } else {
            None
        };

        // Veto ceiling for row_cand to prevent jumping to the bottom of the previous column.
        if let Some(r_idx) = row_cand {
            let r_box = nodes[r_idx].bbox;
            let is_blocked = candidates.iter().any(|&other_idx| {
                if other_idx == r_idx {
                    return false;
                }
                let other_box = nodes[other_idx].bbox;
                let is_above = other_box[3] <= (r_box[1] + 50.0);
                let x_overlap = iou_x(other_box, r_box);
                is_above && x_overlap > 0.2
            });
            if is_blocked {
                row_cand = None;
            }
        }

        // Dual veto: ceiling (topological) + right-neighbor (row start).
        if let Some(c_idx) = col_cand {
            let c_cand_box = nodes[c_idx].bbox;
            let is_blocked = candidates.iter().any(|&other_idx| {
                if other_idx == c_idx {
                    return false;
                }
                let other_box = nodes[other_idx].bbox;
                let is_above = other_box[3] <= (c_cand_box[1] + 50.0);
                let x_overlap = iou_x(other_box, c_cand_box);
                if is_above && x_overlap > 0.2 {
                    return true;
                }
                let has_block_neighbor = if rtl {
                    other_box[0] > (c_cand_box[0] + 20.0)
                } else {
                    other_box[2] < (c_cand_box[2] - 20.0)
                };
                let y_overlap_ratio = iou_y_overlap(c_cand_box, other_box);
                has_block_neighbor && y_overlap_ratio > 0.3
            });
            if is_blocked {
                col_cand = None;
            }
        }

        let next_node_idx = match (row_cand, col_cand) {
            (Some(r), None) => Some(r),
            (None, Some(c)) => Some(c),
            (Some(r), Some(c)) => {
                let curr_h = c_box[3] - c_box[1];
                let r_box = nodes[r].bbox;
                let c_cand_box = nodes[c].bbox;
                let bottom_diff = (c_box[3] - r_box[3]).abs();
                let is_row_aligned = bottom_diff < (curr_h * 0.25);

                if c_cand_box[1] >= r_box[3] || is_row_aligned {
                    Some(r)
                } else {
                    Some(c)
                }
            }
            (None, None) => None,
        };

        let next_idx = match next_node_idx {
            Some(idx) => idx,
            None => {
                // Recompute roots among remaining unvisited nodes.
                let mut sub_roots = Vec::new();
                for &node_i in &candidates {
                    let n_box = nodes[node_i].bbox;
                    let mut is_root = true;
                    for &parent_i in &candidates {
                        if node_i == parent_i {
                            continue;
                        }
                        let p_box = nodes[parent_i].bbox;
                        let is_above = p_box[3] <= (n_box[1] + 50.0);
                        let x_overlap = iou_x(p_box, n_box);
                        if is_above && x_overlap > 0.2 {
                            is_root = false;
                            break;
                        }
                    }
                    if is_root {
                        sub_roots.push(node_i);
                    }
                }

                if !sub_roots.is_empty() {
                    if rtl {
                        let mut best_i = sub_roots[0];
                        let mut best_val = nodes[best_i].bbox[2];
                        for &i in &sub_roots[1..] {
                            if nodes[i].bbox[2] > best_val {
                                best_val = nodes[i].bbox[2];
                                best_i = i;
                            }
                        }
                        best_i
                    } else {
                        let mut best_i = sub_roots[0];
                        let mut best_val = nodes[best_i].bbox[0];
                        for &i in &sub_roots[1..] {
                            if nodes[i].bbox[0] < best_val {
                                best_val = nodes[i].bbox[0];
                                best_i = i;
                            }
                        }
                        best_i
                    }
                } else {
                    let mut best_i = candidates[0];
                    let mut best_val = nodes[best_i].bbox[1];
                    for &i in &candidates[1..] {
                        if nodes[i].bbox[1] < best_val {
                            best_val = nodes[i].bbox[1];
                            best_i = i;
                        }
                    }
                    best_i
                }
            }
        };

        nodes[next_idx].visited = true;
        sorted_indices.push(nodes[next_idx].id);
        current_idx = next_idx;
    }

    sorted_indices
}

#[derive(Debug, Clone)]
struct EnrichedItem<T> {
    item: T,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    w: f32,
    h: f32,
    cx: f32,
    cy: f32,
}

#[derive(Debug, Clone)]
struct Band<T> {
    y_min: f32,
    y_max: f32,
    items: Vec<EnrichedItem<T>>,
}

#[derive(Debug, Clone)]
struct Column<T> {
    x_min: f32,
    x_max: f32,
    items: Vec<EnrichedItem<T>>,
}

/// Spatial banding sort for bubbles (horizontal row bands + vertical columns).
///
/// Keeps slightly offset bubbles grouped into the same reading line and column.
fn spatial_sort<T: Clone>(
    items: &[T],
    get_bbox: impl Fn(&T) -> [f32; 4],
    rtl: bool,
) -> Vec<T> {
    if items.is_empty() {
        return Vec::new();
    }

    const Y_OVERLAP_RATIO_THRESHOLD: f32 = 0.25;
    const Y_CENTER_BAND_FACTOR: f32 = 0.5;
    const X_OVERLAP_RATIO_THRESHOLD: f32 = 0.2;
    const X_CENTER_BAND_FACTOR: f32 = 0.5;

    let mut enriched: Vec<EnrichedItem<T>> = items
        .iter()
        .map(|item| {
            let bbox = get_bbox(item);
            let x1 = bbox[0];
            let y1 = bbox[1];
            let x2 = bbox[2];
            let y2 = bbox[3];
            let w = (x2 - x1).max(1.0);
            let h = (y2 - y1).max(1.0);
            let cx = (x1 + x2) / 2.0;
            let cy = (y1 + y2) / 2.0;
            EnrichedItem {
                item: item.clone(),
                x1,
                y1,
                x2,
                y2,
                w,
                h,
                cx,
                cy,
            }
        })
        .collect();

    // Stable sort by vertical centre.
    enriched.sort_by(|a, b| a.cy.total_cmp(&b.cy));

    let mut bands: Vec<Band<T>> = Vec::new();
    for e in enriched {
        let y1 = e.y1;
        let y2 = e.y2;
        let h = e.h;
        let mut best_band_idx = None;
        let mut best_score = -1.0f32;

        for (i, band) in bands.iter().enumerate() {
            let band_h = (band.y_max - band.y_min).max(1.0);
            let overlap_v = (y2.min(band.y_max) - y1.max(band.y_min)).max(0.0);
            let overlap_ratio = overlap_v / h.min(band_h);
            let center_delta_y = (e.cy - (band.y_min + band.y_max) / 2.0).abs();

            let same_row = (overlap_ratio >= Y_OVERLAP_RATIO_THRESHOLD)
                || (center_delta_y <= Y_CENTER_BAND_FACTOR * h.min(band_h));

            if same_row {
                let score = overlap_ratio - (center_delta_y / (h + band_h)) * 0.1;
                if score > best_score {
                    best_score = score;
                    best_band_idx = Some(i);
                }
            }
        }

        match best_band_idx {
            None => {
                bands.push(Band {
                    y_min: y1,
                    y_max: y2,
                    items: vec![e],
                });
            }
            Some(idx) => {
                bands[idx].items.push(e);
                bands[idx].y_min = bands[idx].y_min.min(y1);
                bands[idx].y_max = bands[idx].y_max.max(y2);
            }
        }
    }

    bands.sort_by(|a, b| a.y_min.total_cmp(&b.y_min));

    let mut ordered_items = Vec::with_capacity(items.len());
    for band in bands {
        let mut columns: Vec<Column<T>> = Vec::new();

        for e in band.items {
            let x1 = e.x1;
            let x2 = e.x2;
            let w = e.w;
            let mut best_col_idx = None;
            let mut best_score = -1.0f32;

            for (i, col) in columns.iter().enumerate() {
                let col_w = (col.x_max - col.x_min).max(1.0);
                let overlap_h = (x2.min(col.x_max) - x1.max(col.x_min)).max(0.0);
                let overlap_ratio = overlap_h / w.min(col_w);
                let col_center_x = (col.x_min + col.x_max) / 2.0;
                let center_delta_x = (e.cx - col_center_x).abs();

                let same_col = (overlap_ratio >= X_OVERLAP_RATIO_THRESHOLD)
                    || (center_delta_x <= X_CENTER_BAND_FACTOR * w.min(col_w));

                if same_col {
                    let score = overlap_ratio - (center_delta_x / (w + col_w)) * 0.1;
                    if score > best_score {
                        best_score = score;
                        best_col_idx = Some(i);
                    }
                }
            }

            match best_col_idx {
                None => {
                    columns.push(Column {
                        x_min: x1,
                        x_max: x2,
                        items: vec![e],
                    });
                }
                Some(idx) => {
                    columns[idx].items.push(e);
                    columns[idx].x_min = columns[idx].x_min.min(x1);
                    columns[idx].x_max = columns[idx].x_max.max(x2);
                }
            }
        }

        if rtl {
            columns.sort_by(|a, b| {
                let center_a = (a.x_min + a.x_max) / 2.0;
                let center_b = (b.x_min + b.x_max) / 2.0;
                center_b.total_cmp(&center_a)
            });
        } else {
            columns.sort_by(|a, b| {
                let center_a = (a.x_min + a.x_max) / 2.0;
                let center_b = (b.x_min + b.x_max) / 2.0;
                center_a.total_cmp(&center_b)
            });
        }

        for mut col in columns {
            col.items.sort_by(|a, b| a.cy.total_cmp(&b.cy));
            for e in col.items {
                ordered_items.push(e.item);
            }
        }
    }

    ordered_items
}

/// Sort detected text blocks into natural reading order.
///
/// Ported from `sort_bubbles_by_reading_order` in `python/sidecar/sorting.py`.
///
/// When `panels` are provided:
/// - Panels are sorted into topological reading order via `sort_panels_by_reading_order`.
/// - Blocks are assigned to a panel if their centre falls inside it, or to the nearest
///   panel within 300 pixels.
/// - Blocks within each panel are sorted using spatial banding.
/// - Any unassigned blocks are spatially sorted and placed at the end.
///
/// When no panels are provided, the entire block list is sorted directly via spatial banding.
pub fn sort_bubbles_by_reading_order(
    blocks: &[Block],
    direction: ReadingDirection,
    panels: Option<&[[i32; 4]]>,
) -> Vec<Block> {
    if blocks.is_empty() {
        return Vec::new();
    }

    let rtl = matches!(direction, ReadingDirection::Rtl);
    let block_bbox = |b: &Block| {
        [
            b.r#box[0] as f32,
            b.r#box[1] as f32,
            b.r#box[2] as f32,
            b.r#box[3] as f32,
        ]
    };

    let panel_list = match panels {
        Some(p) if !p.is_empty() => p,
        _ => return spatial_sort(blocks, block_bbox, rtl),
    };

    let mut sorted_panel_indices = sort_panels_by_reading_order(panel_list, direction);
    if sorted_panel_indices.is_empty() {
        sorted_panel_indices = (0..panel_list.len()).collect();
    }

    let mut panel_bins: Vec<Vec<Block>> = vec![Vec::new(); panel_list.len()];
    let mut unassigned: Vec<Block> = Vec::new();

    for block in blocks {
        let b = block_bbox(block);
        let bcx = (b[0] + b[2]) / 2.0;
        let bcy = (b[1] + b[3]) / 2.0;
        let mut assigned_pid = None;

        // Containment check
        for (i, pbbox) in panel_list.iter().enumerate() {
            let px1 = pbbox[0] as f32;
            let py1 = pbbox[1] as f32;
            let px2 = pbbox[2] as f32;
            let py2 = pbbox[3] as f32;
            if px1 <= bcx && bcx <= px2 && py1 <= bcy && bcy <= py2 {
                assigned_pid = Some(i);
                break;
            }
        }

        // Distance fallback
        if assigned_pid.is_none() {
            let mut best_dist = f32::INFINITY;
            let mut best_pid = 0;
            for (i, pbbox) in panel_list.iter().enumerate() {
                let px1 = pbbox[0] as f32;
                let py1 = pbbox[1] as f32;
                let px2 = pbbox[2] as f32;
                let py2 = pbbox[3] as f32;
                let dx = (px1 - bcx).max(0.0).max(bcx - px2);
                let dy = (py1 - bcy).max(0.0).max(bcy - py2);
                let dist = (dx * dx + dy * dy).sqrt();
                if dist < best_dist {
                    best_dist = dist;
                    best_pid = i;
                }
            }
            if best_dist < 300.0 {
                assigned_pid = Some(best_pid);
            }
        }

        match assigned_pid {
            Some(pid) => {
                panel_bins[pid].push(block.clone());
            }
            None => {
                unassigned.push(block.clone());
            }
        }
    }

    let mut final_order = Vec::with_capacity(blocks.len());
    for &pid in &sorted_panel_indices {
        if pid < panel_bins.len() && !panel_bins[pid].is_empty() {
            let items = std::mem::take(&mut panel_bins[pid]);
            final_order.extend(spatial_sort(&items, block_bbox, rtl));
        }
    }

    if !unassigned.is_empty() {
        final_order.extend(spatial_sort(&unassigned, block_bbox, rtl));
    }

    final_order
}

/// Compute the statistical median of a slice of floats.
///
/// Matches Python `statistics.median`: for odd length, returns the middle
/// element; for even length, returns the arithmetic mean of the two middle elements.
pub fn median(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// Heuristic classification of text blocks into SFX vs dialogue.
///
/// Ported from `_assign_types` in `python/sidecar/main.py`.
///
/// Uses glyph size relative to the page median: text with font size > 2.2x the
/// median is classified as `LineType::Sfx`; all other text is `LineType::Dialogue`.
pub fn assign_types(blocks: &mut [Block]) {
    if blocks.is_empty() {
        return;
    }
    let font_sizes: Vec<f32> = blocks.iter().map(|b| b.font_size).collect();
    let mut med = median(&font_sizes);
    if med <= 0.0 {
        med = 1.0;
    }
    let threshold = 2.2 * med;
    for b in blocks.iter_mut() {
        b.line_type = if b.font_size > threshold {
            LineType::Sfx
        } else {
            LineType::Dialogue
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median(&[]), 0.0);
        assert_eq!(median(&[5.0]), 5.0);
        assert_eq!(median(&[1.0, 3.0, 2.0]), 2.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
    }

    #[test]
    fn assign_types_classifies_outsized_fonts_as_sfx() {
        let mut blocks = vec![
            Block::new([0, 0, 10, 10], true, 20.0, "text 1".into()),
            Block::new([0, 20, 10, 30], true, 22.0, "text 2".into()),
            Block::new([0, 40, 10, 50], true, 21.0, "text 3".into()),
            Block::new([0, 60, 50, 120], true, 60.0, "SFX BOOM".into()),
        ];
        // median is (21 + 22)/2 = 21.5, threshold = 21.5 * 2.2 = 47.3
        assign_types(&mut blocks);
        assert_eq!(blocks[0].line_type, LineType::Dialogue);
        assert_eq!(blocks[1].line_type, LineType::Dialogue);
        assert_eq!(blocks[2].line_type, LineType::Dialogue);
        assert_eq!(blocks[3].line_type, LineType::Sfx);
    }

    #[test]
    fn spatial_sort_orders_rtl_columns() {
        // Two bubbles in the same horizontal band: right bubble should come first in RTL.
        let left = Block::new([100, 100, 200, 200], true, 20.0, "left".into());
        let right = Block::new([500, 100, 600, 200], true, 20.0, "right".into());
        let sorted = sort_bubbles_by_reading_order(
            &[left.clone(), right.clone()],
            ReadingDirection::Rtl,
            None,
        );
        assert_eq!(sorted[0].r#box, right.r#box);
        assert_eq!(sorted[1].r#box, left.r#box);
    }

    #[test]
    fn spatial_sort_orders_ltr_columns() {
        // Two bubbles in the same horizontal band: left bubble should come first in LTR.
        let left = Block::new([100, 100, 200, 200], true, 20.0, "left".into());
        let right = Block::new([500, 100, 600, 200], true, 20.0, "right".into());
        let sorted = sort_bubbles_by_reading_order(
            &[left.clone(), right.clone()],
            ReadingDirection::Ltr,
            None,
        );
        assert_eq!(sorted[0].r#box, left.r#box);
        assert_eq!(sorted[1].r#box, right.r#box);
    }

    #[test]
    fn panel_sort_orders_z_pattern() {
        // 4 panels in a 2x2 grid:
        // Top-right: 0, Top-left: 1, Bottom-right: 2, Bottom-left: 3
        let panels = vec![
            [500, 0, 1000, 500],   // top-right (0)
            [0, 0, 490, 500],      // top-left (1)
            [500, 520, 1000, 1000], // bottom-right (2)
            [0, 520, 490, 1000],   // bottom-left (3)
        ];
        let order = sort_panels_by_reading_order(&panels, ReadingDirection::Rtl);
        assert_eq!(order, vec![0, 1, 2, 3]);

        // In LTR, top-left (1) comes before top-right (0), and bottom-left (3) comes before bottom-right (2).
        let ltr_order = sort_panels_by_reading_order(&panels, ReadingDirection::Ltr);
        assert_eq!(ltr_order, vec![1, 0, 3, 2]);
    }

    #[derive(serde::Deserialize)]
    struct GoldenOrdered {
        #[serde(rename = "box")]
        r#box: [i32; 4],
        #[serde(rename = "type")]
        line_type: LineType,
        #[allow(dead_code)]
        jp: String,
    }

    #[derive(serde::Deserialize)]
    struct GoldenSortingPage {
        file: String,
        panels: Vec<[i32; 4]>,
        input_boxes: Vec<[i32; 4]>,
        ordered: Vec<GoldenOrdered>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenDetectorPage {
        file: String,
        #[allow(dead_code)]
        img_width: u32,
        #[allow(dead_code)]
        img_height: u32,
        blocks: Vec<Block>,
    }

    #[test]
    fn sorting_and_type_assignment_matches_golden_fixtures() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let sorting_fixture_path =
            manifest_dir.join("testdata/analyze-golden/sorting-golden.json");
        let detector_fixture_path =
            manifest_dir.join("testdata/analyze-golden/detector-golden.json");

        let Ok(sorting_json) = std::fs::read_to_string(&sorting_fixture_path) else {
            eprintln!(
                "skipping golden test: fixture not found at {}",
                sorting_fixture_path.display()
            );
            return;
        };
        let Ok(detector_json) = std::fs::read_to_string(&detector_fixture_path) else {
            eprintln!(
                "skipping golden test: fixture not found at {}",
                detector_fixture_path.display()
            );
            return;
        };

        let sorting_pages: Vec<GoldenSortingPage> = serde_json::from_str(&sorting_json)
            .expect("sorting-golden.json is not the expected shape");
        let detector_pages: Vec<GoldenDetectorPage> = serde_json::from_str(&detector_json)
            .expect("detector-golden.json is not the expected shape");

        assert!(
            !sorting_pages.is_empty(),
            "expected non-empty sorting golden fixture"
        );

        for sort_page in &sorting_pages {
            let det_page = detector_pages
                .iter()
                .find(|p| p.file == sort_page.file)
                .unwrap_or_else(|| {
                    panic!(
                        "no matching detector page found for file {}",
                        sort_page.file
                    )
                });

            // Verify input blocks match input_boxes
            assert_eq!(
                det_page.blocks.len(),
                sort_page.input_boxes.len(),
                "{}: detector block count ({}) differs from input_boxes ({})",
                sort_page.file,
                det_page.blocks.len(),
                sort_page.input_boxes.len()
            );
            for (i, (b, ib)) in det_page
                .blocks
                .iter()
                .zip(&sort_page.input_boxes)
                .enumerate()
            {
                assert_eq!(
                    b.r#box, *ib,
                    "{}: input block {} box mismatch: {:?} vs {:?}",
                    sort_page.file, i, b.r#box, ib
                );
            }

            // Run reading order sort
            let mut ordered_blocks = sort_bubbles_by_reading_order(
                &det_page.blocks,
                ReadingDirection::Rtl,
                Some(&sort_page.panels),
            );

            // Run type assignment
            assign_types(&mut ordered_blocks);

            assert_eq!(
                ordered_blocks.len(),
                sort_page.ordered.len(),
                "{}: ordered block count ({}) differs from expected ({})",
                sort_page.file,
                ordered_blocks.len(),
                sort_page.ordered.len()
            );

            for (i, (actual, expected)) in ordered_blocks
                .iter()
                .zip(&sort_page.ordered)
                .enumerate()
            {
                assert_eq!(
                    actual.r#box, expected.r#box,
                    "{}: block {} box order mismatch: got {:?}, expected {:?}",
                    sort_page.file, i, actual.r#box, expected.r#box
                );
                assert_eq!(
                    actual.line_type, expected.line_type,
                    "{}: block {} type mismatch for box {:?}: got {:?}, expected {:?}",
                    sort_page.file, i, actual.r#box, actual.line_type, expected.line_type
                );
            }

            eprintln!(
                "golden sorting {}: {} blocks matched perfectly",
                std::path::Path::new(&sort_page.file)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                ordered_blocks.len()
            );
        }
    }
}
