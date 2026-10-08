//! Linear-memory allocation exported to JavaScript.
//!
//! The ABI works in bytes. JS creates typed-array views over the module
//! memory at returned pointers; Rust never receives JS objects.

use core::ptr;
use std::alloc::{alloc as std_alloc, dealloc, Layout};

/// Alignment of every ABI allocation. Eight bytes so a caller may lay `f64`
/// or `u32` tables into a buffer it allocated without a second contract.
pub const ABI_ALLOC_ALIGNMENT: usize = 8;

/// Allocates `byte_len` bytes. Returns null for a zero length or on failure.
/// Release with [`free`] and the same length.
pub fn alloc(byte_len: usize) -> *mut u8 {
    if byte_len == 0 {
        return ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(byte_len, ABI_ALLOC_ALIGNMENT) else {
        return ptr::null_mut();
    };
    // SAFETY: `layout` has a non-zero size.
    unsafe { std_alloc(layout) }
}

/// Frees a buffer returned by [`alloc`].
///
/// # Safety
///
/// `ptr` must be null or a live pointer returned by `alloc(byte_len)` with
/// this exact length, and must not be used afterwards.
pub unsafe fn free(ptr: *mut u8, byte_len: usize) {
    if ptr.is_null() || byte_len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(byte_len, ABI_ALLOC_ALIGNMENT) else {
        return;
    };
    // SAFETY: guaranteed by the caller.
    unsafe { dealloc(ptr, layout) }
}

/// Font bytes that arrived through [`alloc`] and are now owned by the engine.
///
/// Keeping the caller's allocation instead of copying it into a `Vec` halves
/// the peak memory of loading a font, which matters for CJK collections.
pub struct AbiBytes {
    ptr: *mut u8,
    len: usize,
}

impl AbiBytes {
    /// # Safety
    ///
    /// `ptr` must come from `alloc(len)`, hold `len` initialised bytes, and
    /// ownership passes to the returned value.
    pub unsafe fn from_raw(ptr: *mut u8, len: usize) -> Self {
        Self { ptr, len }
    }
}

impl AsRef<[u8]> for AbiBytes {
    fn as_ref(&self) -> &[u8] {
        if self.ptr.is_null() {
            return &[];
        }
        // SAFETY: `from_raw` guarantees `len` initialised bytes owned by self.
        unsafe { core::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for AbiBytes {
    fn drop(&mut self) {
        // SAFETY: the pointer came from `alloc(len)` and is dropped once.
        unsafe { free(self.ptr, self.len) }
    }
}

// SAFETY: `AbiBytes` uniquely owns its allocation and only hands out shared
// slices, exactly like `Box<[u8]>`.
unsafe impl Send for AbiBytes {}
// SAFETY: as above; there is no interior mutability.
unsafe impl Sync for AbiBytes {}

/// Counts live heap bytes so the cost of a loaded font can be reported
/// exactly instead of in 64 KiB pages of linear-memory growth. Installed for
/// the wasm build only: a library must not choose the allocator of a native
/// program that links it.
#[cfg(target_arch = "wasm32")]
pub mod counting {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub static LIVE: AtomicUsize = AtomicUsize::new(0);
    pub static PEAK: AtomicUsize = AtomicUsize::new(0);

    pub struct Counting;

    // SAFETY: every call is forwarded to `System` unchanged; the counters are
    // bookkeeping only.
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = unsafe { System.alloc(layout) };
            if !p.is_null() {
                let now = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let p = unsafe { System.realloc(ptr, layout, new_size) };
            if !p.is_null() {
                if new_size >= layout.size() {
                    let grow = new_size - layout.size();
                    let now = LIVE.fetch_add(grow, Ordering::Relaxed) + grow;
                    PEAK.fetch_max(now, Ordering::Relaxed);
                } else {
                    LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
                }
            }
            p
        }
    }

    #[global_allocator]
    static GLOBAL: Counting = Counting;
}
