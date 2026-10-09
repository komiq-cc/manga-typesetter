//! Live painter buffer budget. Growth charges only the added capacity.
//! Buffers refund on drop, including early returns. Reallocations are checked
//! against the same limit while the old buffer can still be live.
use crate::Error;
use std::cell::Cell;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicUsize, Ordering};

// The review's eleven old-build jobs peak at 1007.0 MiB live (English page,
// 6554 glyphs, four bands, scale 2). 1152 MiB is the smallest 128-MiB step
// leaving at least ten percent of the limit spare; it is below 1536 MiB.
pub const MAX_PAINT_BYTES: usize = 1152 * 1024 * 1024;
// A shaping run is bounded before HarfBuzz/Swash's infallible allocations.
// This also bounds the engine's retained shaping buffers after a refusal.
pub const MAX_RUN_BYTES: usize = 262_144;
#[derive(Clone, Copy)]
struct State {
    id: usize,
    used: usize,
    peak: usize,
    failed: bool,
    limit: usize,
}
thread_local! {
    static STATE: Cell<Option<State>> = const { Cell::new(None) };
}
static SERIAL: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
thread_local! {
    static NEXT_LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
}
fn scope_limit() -> usize {
    #[cfg(test)]
    if let Some(limit) = NEXT_LIMIT.with(|s| s.take()) {
        return limit;
    }
    MAX_PAINT_BYTES
}
#[cfg(test)]
pub fn limit_next_scope_for_test(limit: usize) {
    NEXT_LIMIT.with(|s| s.set(Some(limit)));
}
#[cfg(test)]
pub fn peak_for_test() -> usize {
    STATE.with(|s| s.get().unwrap().peak)
}
pub struct Scope(bool);
impl Scope {
    pub fn new() -> Self {
        Self(STATE.with(|s| {
            if s.get().is_none() {
                let id = SERIAL.fetch_add(1, Ordering::Relaxed) + 1;
                s.set(Some(State {
                    id,
                    used: 0,
                    peak: 0,
                    failed: false,
                    limit: scope_limit(),
                }));
                true
            } else {
                false
            }
        }))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if self.0 {
            STATE.with(|s| s.set(None));
        }
    }
}
pub fn check() -> Result<(), Error> {
    if STATE.with(|s| s.get().is_some_and(|s| s.failed)) {
        Err(Error::BadSpec)
    } else {
        Ok(())
    }
}
fn fail() -> Error {
    STATE.with(|s| {
        if let Some(mut v) = s.get() {
            v.failed = true;
            s.set(Some(v));
        }
    });
    Error::BadSpec
}
fn charge(bytes: usize) -> Result<usize, Error> {
    STATE.with(|s| {
        let Some(mut v) = s.get() else {
            return Ok(0);
        };
        let total = v.used.checked_add(bytes).ok_or_else(fail)?;
        if v.failed || total > v.limit {
            return Err(fail());
        }
        v.used = total;
        v.peak = v.peak.max(total);
        s.set(Some(v));
        Ok(v.id)
    })
}
fn release(id: usize, bytes: usize) {
    STATE.with(|s| {
        if let Some(mut v) = s.get() {
            if v.id == id {
                debug_assert!(bytes <= v.used, "painter refund exceeds live charge");
                v.used = v.used.saturating_sub(bytes);
                s.set(Some(v));
            }
        }
    });
}

/// Internal vectors own their charge. No pointer registry or global allocator.
#[derive(Debug, PartialEq)]
pub struct Buffer<T> {
    data: Vec<T>,
    id: usize,
}
impl<T> Default for Buffer<T> {
    fn default() -> Self {
        Self::new()
    }
}
impl<T> Buffer<T> {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            id: 0,
        }
    }
    pub fn account(&mut self) -> Result<(), Error> {
        let current = STATE.with(|s| s.get().map_or(0, |v| v.id));
        if self.id != current {
            self.id = charge(self.data.capacity() * std::mem::size_of::<T>())?;
        }
        Ok(())
    }
    pub fn into_vec(mut self) -> Vec<T> {
        std::mem::take(&mut self.data)
    }
}
impl<T> Deref for Buffer<T> {
    type Target = Vec<T>;
    fn deref(&self) -> &Vec<T> {
        &self.data
    }
}
impl<T> DerefMut for Buffer<T> {
    fn deref_mut(&mut self) -> &mut Vec<T> {
        &mut self.data
    }
}
impl<T> Drop for Buffer<T> {
    fn drop(&mut self) {
        release(self.id, self.data.capacity() * std::mem::size_of::<T>());
    }
}
impl<T: Clone> Clone for Buffer<T> {
    fn clone(&self) -> Self {
        let mut v = Self::new();
        if reserve(&mut v, self.len()).is_ok() {
            v.extend_from_slice(self);
        }
        v
    }
}
impl<T> FromIterator<T> for Buffer<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        let mut v = Self::new();
        for item in iter {
            if push(&mut v, item).is_err() {
                break;
            }
        }
        v
    }
}
impl<'a, T> IntoIterator for &'a Buffer<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
impl<'a, T> IntoIterator for &'a mut Buffer<T> {
    type Item = &'a mut T;
    type IntoIter = std::slice::IterMut<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter_mut()
    }
}
// Keep the allocation charged until the owning iterator is dropped.
pub struct Iter<T> {
    data: std::vec::IntoIter<T>,
    id: usize,
    bytes: usize,
}
impl<T> Iterator for Iter<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        self.data.next()
    }
}
impl<T> Drop for Iter<T> {
    fn drop(&mut self) {
        release(self.id, self.bytes);
    }
}
impl<T> IntoIterator for Buffer<T> {
    type Item = T;
    type IntoIter = Iter<T>;
    fn into_iter(mut self) -> Iter<T> {
        let bytes = self.capacity() * std::mem::size_of::<T>();
        Iter {
            data: std::mem::take(&mut self.data).into_iter(),
            id: self.id,
            bytes,
        }
    }
}

pub fn reserve<T>(v: &mut Buffer<T>, additional: usize) -> Result<(), Error> {
    check()?;
    v.account()?;
    let wanted = v.len().checked_add(additional).ok_or_else(fail)?;
    if wanted <= v.capacity() {
        return Ok(());
    }
    let old = v.capacity() * std::mem::size_of::<T>();
    let bytes = wanted
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(fail)?;
    // Transient realloc: check the entire new buffer with old still charged.
    let id = charge(bytes)?;
    if v.data.try_reserve_exact(additional).is_err() {
        release(id, bytes);
        return Err(fail());
    }
    release(id, old);
    v.id = id;
    Ok(())
}
pub fn push<T>(v: &mut Buffer<T>, value: T) -> Result<(), Error> {
    if v.len() == v.capacity() {
        reserve(v, v.capacity().max(4))?;
    }
    v.data.push(value);
    Ok(())
}
pub fn filled<T: Clone>(len: usize, value: T) -> Result<Buffer<T>, Error> {
    let mut v = Buffer::new();
    resize(&mut v, len, value)?;
    Ok(v)
}
pub fn resize<T: Clone>(v: &mut Buffer<T>, len: usize, value: T) -> Result<(), Error> {
    reserve(v, len.saturating_sub(v.len()))?;
    v.data.resize(len, value);
    Ok(())
}
// Public decoded job vectors stay live for the whole scope. They do not grow
// again during painting. Decode uses exact capacities, not doubling.
pub fn reserve_raw<T>(v: &mut Vec<T>, additional: usize) -> Result<(), Error> {
    check()?;
    let wanted = v.len().checked_add(additional).ok_or_else(fail)?;
    if wanted <= v.capacity() {
        return Ok(());
    }
    let bytes = (wanted - v.capacity())
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(fail)?;
    charge(bytes)?;
    v.try_reserve_exact(additional).map_err(|_| fail())
}
pub fn collect<T>(items: impl ExactSizeIterator<Item = Result<T, Error>>) -> Result<Vec<T>, Error> {
    let mut out = Vec::new();
    reserve_raw(&mut out, items.len())?;
    for item in items {
        out.push(item?);
    }
    Ok(out)
}
pub fn boxed<T>(value: T) -> Result<Box<T>, Error> {
    let mut v = Vec::new();
    reserve_raw(&mut v, 1)?;
    v.push(value);
    let ptr = Box::into_raw(v.into_boxed_slice()) as *mut T;
    // SAFETY: one initialized T, allocated with T's alignment and size.
    Ok(unsafe { Box::from_raw(ptr) })
}

/// Check a known lower bound before generating bands or indexing edges.
pub fn ensure(bytes: usize) -> Result<(), Error> {
    STATE.with(|s| {
        if let Some(v) = s.get() {
            if v.failed || v.used.checked_add(bytes).is_none_or(|n| n > v.limit) {
                return Err(fail());
            }
        }
        Ok(())
    })
}
#[cfg(test)]
pub fn limit_for_test(limit: usize) {
    STATE.with(|s| {
        let mut v = s.get().unwrap();
        v.limit = limit;
        s.set(Some(v));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregate_limit_and_overflow_refuse_before_allocating() {
        let _scope = Scope::new();
        let mut a = Buffer::<u64>::new();
        assert!(reserve(&mut a, usize::MAX).is_err());
        STATE.with(|s| {
            let mut v = s.get().unwrap();
            v.used = MAX_PAINT_BYTES - 8;
            v.failed = false;
            s.set(Some(v));
        });
        reserve(&mut a, 1).unwrap();
        let mut b = Buffer::<u64>::new();
        assert!(reserve(&mut b, 1).is_err());
        assert_eq!(b.capacity(), 0);
        assert!(check().is_err());
    }
    #[test]
    fn growth_and_drop_count_only_live_capacity() {
        let _scope = Scope::new();
        let mut v = Buffer::<u64>::new();
        for i in 0..100 {
            push(&mut v, i).unwrap();
        }
        assert_eq!(STATE.with(|s| s.get().unwrap().used), v.capacity() * 8);
        drop(v);
        assert_eq!(STATE.with(|s| s.get().unwrap().used), 0);
    }
    #[test]
    fn owned_iterator_refunds_only_when_dropped() {
        let _scope = Scope::new();
        let v = filled(128, 7u64).unwrap();
        let bytes = v.capacity() * 8;
        let mut iter = v.into_iter();
        assert_eq!(iter.next(), Some(7));
        assert_eq!(STATE.with(|s| s.get().unwrap().used), bytes);
        drop(iter);
        assert_eq!(STATE.with(|s| s.get().unwrap().used), 0);
    }
    #[test]
    fn buffer_from_an_earlier_scope_is_charged_to_this_one() {
        let mut v = {
            let _scope = Scope::new();
            filled(128, 7u64).unwrap()
        };
        let _scope = Scope::new();
        let bytes = v.capacity() * 8;
        limit_for_test(bytes - 1);
        assert_eq!(v.account(), Err(Error::BadSpec));
        assert_eq!(STATE.with(|s| s.get().unwrap().used), 0);
    }
}
