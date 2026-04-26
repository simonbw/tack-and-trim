//! Per-instance world-state pointer storage.
//!
//! All data — per-frame buffers and packed world-state buffers — lives
//! in a single `WebAssembly.Memory({shared: true})` allocated and
//! partitioned by JS on the main thread. The kernel doesn't own any
//! allocations; it just remembers the (ptr, len) pairs the host hands
//! over via `set_packed_*` and re-borrows them as slices each call.
//!
//! Wasm globals/statics are per-Instance, so each worker's Instance has
//! its own copy of these pointers. Workers populate them once during
//! their init step (with offsets into the shared memory).

#[derive(Clone, Copy)]
pub struct PackedRef {
    pub ptr: *const u32,
    pub len: usize,
}

impl PackedRef {
    const fn empty() -> Self {
        Self {
            ptr: core::ptr::null(),
            len: 0,
        }
    }

    /// Re-borrow as a slice. Empty when no buffer has been registered.
    ///
    /// # Safety
    /// Caller must guarantee the pointer is still valid (i.e., the host
    /// hasn't freed/relocated the underlying region since `set_packed_*`).
    /// The shared-memory region is owned by the main thread for the
    /// lifetime of the worker pool, so this holds for the entire
    /// game-session lifetime.
    #[inline]
    pub unsafe fn as_slice(&self) -> &'static [u32] {
        if self.ptr.is_null() || self.len == 0 {
            &[]
        } else {
            core::slice::from_raw_parts(self.ptr, self.len)
        }
    }
}

pub struct WorldState {
    pub packed_terrain: PackedRef,
    pub packed_wave_mesh: PackedRef,
    pub packed_tide_mesh: PackedRef,
    pub packed_wind_mesh: PackedRef,
}

impl WorldState {
    pub const fn empty() -> Self {
        Self {
            packed_terrain: PackedRef::empty(),
            packed_wave_mesh: PackedRef::empty(),
            packed_tide_mesh: PackedRef::empty(),
            packed_wind_mesh: PackedRef::empty(),
        }
    }
}

static mut WORLD_STATE: WorldState = WorldState::empty();

/// # Safety
/// Single-threaded per-instance; only call from the wasm dispatch path.
/// Callers must not nest a `with_world_state_mut`.
pub unsafe fn with_world_state<R>(f: impl FnOnce(&WorldState) -> R) -> R {
    f(&*core::ptr::addr_of!(WORLD_STATE))
}

/// # Safety: see `with_world_state`.
pub unsafe fn with_world_state_mut<R>(f: impl FnOnce(&mut WorldState) -> R) -> R {
    f(&mut *core::ptr::addr_of_mut!(WORLD_STATE))
}
