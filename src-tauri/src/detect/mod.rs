//! In-process manga detection and OCR using ONNX Runtime.
//!
//! Implements panel detection (manga109 YOLO), comic text detection
//! (DBNet/YOLO/UNet), text ordering, and Japanese/Chinese/Korean OCR.

pub mod accel;
pub mod analyze;
pub mod crops;
pub mod cvops;
pub mod dbnet;
pub mod engine;
pub mod geometry;
pub mod minrect;
pub mod ocr;
pub mod paddle_ocr;
pub mod panels;
pub mod sorting;
pub mod textblock;
pub mod textdetector;
