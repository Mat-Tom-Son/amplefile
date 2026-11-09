//! Read only a portal-granted, explicitly linear XRGB DMA-BUF. PipeWire may
//! expose an opaque GstMemory size (1 byte); the kernel fd is authoritative.
use anyhow::{ensure, Context, Result};
use gstreamer::{BufferRef, MemoryRef};
use gstreamer_allocators::DmaBufMemory;
use std::{
    os::fd::{AsRawFd, BorrowedFd},
    ptr::NonNull,
};

// Linux x86-64 UAPI: _IOW('b', 0, struct dma_buf_sync), with one u64 flags.
const DMA_BUF_IOCTL_SYNC: libc::c_ulong = (1 << 30) | (8 << 16) | ((b'b' as libc::c_ulong) << 8);
fn sync(fd: i32, flags: u64) -> Result<()> {
    for _ in 0..4 {
        if unsafe { libc::ioctl(fd, DMA_BUF_IOCTL_SYNC, &flags) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::EINTR) | Some(libc::EAGAIN)) {
            return Err(error).context("Cannot synchronize the shared screen buffer");
        }
    }
    anyhow::bail!("Shared screen buffer synchronization was interrupted")
}
struct ReadSync {
    fd: i32,
    active: bool,
}
impl ReadSync {
    fn finish(mut self) -> Result<()> {
        self.active = false;
        sync(self.fd, 1 | 4)
    }
}
impl Drop for ReadSync {
    fn drop(&mut self) {
        if self.active {
            let _ = sync(self.fd, 1 | 4);
        }
    }
}
struct Mapping {
    pointer: NonNull<libc::c_void>,
    length: usize,
}
impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.pointer.as_ptr(), self.length);
        }
    }
}

fn span(width: u32, height: u32, stride: usize, offset: usize) -> Result<usize> {
    ensure!(
        width > 0
            && height > 0
            && width <= crate::capture::MAX_DIMENSION
            && height <= crate::capture::MAX_DIMENSION,
        "Frame exceeds limits"
    );
    let row = width as usize * 4;
    ensure!(stride >= row, "Invalid linear screen stride");
    let span = (height as usize - 1)
        .checked_mul(stride)
        .and_then(|size| size.checked_add(row))
        .and_then(|size| size.checked_add(offset))
        .context("Frame layout overflow")?;
    ensure!(
        span <= crate::capture::MAX_BYTES,
        "Frame layout exceeds limits"
    );
    Ok(span)
}
fn rgba(bytes: &[u8], width: u32, height: u32, stride: usize, offset: usize) -> Result<Vec<u8>> {
    ensure!(
        span(width, height, stride, offset)? <= bytes.len(),
        "Shared screen plane exceeds the buffer"
    );
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height as usize {
        let start = offset + y * stride;
        for pixel in bytes[start..start + width as usize * 4].chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
    }
    Ok(pixels)
}
fn memory_fd(memory: &MemoryRef) -> Result<BorrowedFd<'_>> {
    let dma = memory
        .downcast_memory_ref::<DmaBufMemory>()
        .context("Shared screen memory is not a DMA-BUF")?;
    Ok(unsafe { BorrowedFd::borrow_raw(dma.fd()) })
}
pub fn read(
    buffer: &BufferRef,
    width: u32,
    height: u32,
    stride: usize,
    offset: usize,
) -> Result<Vec<u8>> {
    ensure!(buffer.n_memory() == 1, "Expected one linear screen plane");
    let memory = buffer.peek_memory(0);
    let offset = memory
        .offset()
        .checked_add(offset)
        .context("Screen plane offset overflow")?;
    let length = span(width, height, stride, offset)?;
    let file = std::fs::File::from(memory_fd(memory)?.try_clone_to_owned()?);
    ensure!(
        file.metadata()?.len() >= length as u64,
        "Kernel screen buffer is smaller than its plane layout"
    );
    sync(file.as_raw_fd(), 1)?;
    let sync_guard = ReadSync {
        fd: file.as_raw_fd(),
        active: true,
    };
    let pointer = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            length,
            libc::PROT_READ,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    ensure!(
        pointer != libc::MAP_FAILED,
        "Shared screen buffer could not be mapped: {}",
        std::io::Error::last_os_error()
    );
    if pointer.is_null() {
        unsafe {
            libc::munmap(pointer, length);
        }
        anyhow::bail!("Screen mapping returned a null address");
    }
    let mapping = Mapping {
        pointer: NonNull::new(pointer).unwrap(),
        length,
    };
    // The kernel allocation and every selected row were checked before mapping.
    let bytes = unsafe {
        std::slice::from_raw_parts(mapping.pointer.as_ptr().cast::<u8>(), mapping.length)
    };
    let pixels = rgba(bytes, width, height, stride, offset)?;
    drop(mapping);
    sync_guard.finish()?;
    Ok(pixels)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_bgrx_and_excludes_row_padding_and_plane_offset() {
        let data = [
            99, 99, 1, 2, 3, 0, 4, 5, 6, 0, 77, 77, 7, 8, 9, 0, 10, 11, 12, 0,
        ];
        assert_eq!(
            rgba(&data, 2, 2, 10, 2).unwrap(),
            [3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]
        );
    }
    #[test]
    fn malformed_layouts_fail_before_any_mapping() {
        for (width, height, stride, offset) in [
            (0, 1, 4, 0),
            (1, 0, 4, 0),
            (4097, 1, 16388, 0),
            (2, 1, 4, 0),
            (1, 2, usize::MAX, 0),
            (1, 1, 4, usize::MAX),
        ] {
            assert!(span(width, height, stride, offset).is_err());
        }
        assert!(rgba(&[0; 7], 2, 1, 8, 0).is_err());
    }
}
