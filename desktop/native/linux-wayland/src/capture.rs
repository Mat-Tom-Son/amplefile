//! Bounded CPU frames through the portal-granted PipeWire connection only.
use anyhow::{ensure, Context, Result};
use gstreamer::{self as gst, prelude::*};
use gstreamer_app::AppSink;
use gstreamer_video::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{os::fd::{AsRawFd, OwnedFd}, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};

pub const MAX_DIMENSION: u32 = 4096;
pub const MAX_BYTES: usize = 128 * 1024 * 1024;

pub struct Capture {
    pipeline: gst::Pipeline,
    sink: AppSink,
    // Drop the media pipeline before closing the descriptor it borrowed.
    _remote: Option<OwnedFd>,
    latest: Mutex<Option<Frame>>,
}

impl Drop for Capture {
    fn drop(&mut self) { let _ = self.pipeline.set_state(gst::State::Null); }
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameInfo {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub format: &'static str,
    pub bytes: usize,
    pub sha256: String,
    #[serde(rename = "capturedAtMs")]
    pub captured_at_ms: u64,
}

#[derive(Clone)]
pub struct Frame { pub info: FrameInfo, pixels: Arc<[u8]> }

impl Frame {
    pub fn from_sample(sample: &gst::Sample) -> Result<Self> {
        let caps=sample.caps().context("Missing video caps")?;
        let structure=caps.structure(0).context("Missing video structure")?;
        let buffer=sample.buffer().context("Missing frame buffer")?;
        if structure.get::<String>("format")? == "DMA_DRM" {
            ensure!(caps.features(0).is_some_and(|features|features.contains("memory:DMABuf")) && structure.get::<String>("drm-format")? == "XR24","Only explicitly linear XRGB DMA-BUFs are CPU readable");
            let width:u32=structure.get::<i32>("width")?.try_into()?;let height:u32=structure.get::<i32>("height")?.try_into()?;
            let meta=buffer.meta::<gstreamer_video::VideoMeta>().context("DMA-BUF has no video layout")?;
            ensure!(meta.format()==gstreamer_video::VideoFormat::Bgrx && meta.width()==width && meta.height()==height && meta.n_planes()==1,"DMA-BUF layout disagrees with its format");
            let stride=usize::try_from(meta.stride()[0])?;
            let pixels=crate::linear_frame::read(buffer,width,height,stride,meta.offset()[0])?;
            return Self::rgba(width,height,stride,pixels);
        }
        let info=gstreamer_video::VideoInfo::from_caps(caps)?;
        ensure!(info.format()==gstreamer_video::VideoFormat::Rgba && buffer.size()<=MAX_BYTES,"Unsupported frame format or buffer size");
        ensure!(info.width() > 0 && info.height() > 0 && info.width() <= MAX_DIMENSION
            && info.height() <= MAX_DIMENSION && info.size() <= MAX_BYTES, "Frame exceeds limits");
        let frame = gstreamer_video::VideoFrameRef::from_buffer_ref_readable(
            buffer, &info).context("Frame is not CPU readable")?;
        // VideoMeta may change a buffer's plane offset and stride. Use the
        // framework's mapped frame, never assume tightly packed buffer bytes.
        let info = frame.info();
        let map = frame.plane_data(0)?;
        let stride = usize::try_from(info.stride()[0])?;
        let row = info.width() as usize * 4;
        ensure!(map.len() <= MAX_BYTES && stride >= row
            && stride.checked_mul(info.height() as usize).is_some_and(|size| size <= map.len()), "Invalid frame stride");
        let mut pixels=Vec::with_capacity(row*info.height() as usize);
        for row_data in map.chunks(stride).take(info.height() as usize) {
            pixels.extend_from_slice(&row_data[..row]);
        }
        Self::rgba(info.width(),info.height(),stride,pixels)
    }
    fn rgba(width:u32,height:u32,stride:usize,pixels:Vec<u8>)->Result<Self> {
        ensure!(pixels.len()==width as usize*height as usize*4 && pixels.len()<=MAX_BYTES,"Invalid RGBA frame size");
        Ok(Self {info:FrameInfo {width,height,stride,format:"RGBA",bytes:pixels.len(),sha256:format!("{:x}",Sha256::digest(&pixels)),captured_at_ms:SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?},pixels:pixels.into()})
    }

    pub fn png(&self) -> Result<Vec<u8>> {
        let mut encoded = Vec::new();
        let mut encoder = png::Encoder::new(&mut encoded, self.info.width, self.info.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&self.pixels)?;
        ensure!(encoded.len() <= 24 * 1024 * 1024, "PNG exceeds the observation limit");
        Ok(encoded)
    }
}

impl Capture {
    fn pipeline(source: gst::Element, remote: Option<OwnedFd>, linear_dmabuf: bool) -> Result<Self> {
        if std::env::var_os("AMPLEFILE_LIVE_SHARE_DIAGNOSTIC").is_some() {
            if let Some(pad) = source.static_pad("src") {
                pad.add_probe(gst::PadProbeType::BUFFER, |pad, info| {
                    if let Some(buffer) = info.buffer() {
                        let allocators:Vec<_> = buffer.iter_memories().map(|memory|memory.allocator().map(|allocator|allocator.name().to_string())).collect();
                        eprintln!("Capture metadata: caps={:?}, allocators={:?}, video_format={:?}",pad.current_caps(),allocators,buffer.meta::<gstreamer_video::VideoMeta>().map(|meta|meta.format()));
                    }
                    gst::PadProbeReturn::Remove
                });
            }
        }
        let pipeline = gst::Pipeline::new();
        let convert = gst::ElementFactory::make("videoconvert").build()?;
        let caps = if linear_dmabuf {
            gst::Caps::builder("video/x-raw").features(["memory:DMABuf"])
                .field("format","DMA_DRM").field("drm-format","XR24")
                .field("width",gst::IntRange::<i32>::new(1,MAX_DIMENSION as i32))
                .field("height",gst::IntRange::<i32>::new(1,MAX_DIMENSION as i32)).build()
        } else {
            gst::Caps::builder("video/x-raw").field("format","RGBA")
                .field("width",gst::IntRange::<i32>::new(1,MAX_DIMENSION as i32))
                .field("height",gst::IntRange::<i32>::new(1,MAX_DIMENSION as i32)).build()
        };
        let sink=AppSink::builder().caps(&caps).max_buffers(1).drop(true).sync(false).build();
        let capture=Self {pipeline,sink,_remote:remote,latest:Mutex::new(None)};
        if linear_dmabuf {
            // Request an explicit linear XRGB DMA-BUF. A tiled/compressed
            // modifier must never reach the CPU frame mapper.
            capture.pipeline.add_many([&source,capture.sink.upcast_ref()])?;
            gst::Element::link_many([&source,capture.sink.upcast_ref()])?;
        } else {
            capture.pipeline.add_many([&source,&convert,capture.sink.upcast_ref()])?;
            gst::Element::link_many([&source,&convert,capture.sink.upcast_ref()])?;
        }
        if capture.pipeline.set_state(gst::State::Playing).is_err() {
            let detail = capture.pipeline.bus().and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error])).and_then(|message| {
                if let gst::MessageView::Error(error) = message.view() { Some(error.error().to_string()) } else { None }
            }).unwrap_or_else(|| "The media service refused the capture stream".to_owned());
            anyhow::bail!("Screen capture could not start: {detail}");
        }
        Ok(capture)
    }

    pub async fn portal(remote: OwnedFd, node: u32) -> Result<Self> {Self::portal_memory(remote,node,false).await}
    pub async fn portal_linear(remote: OwnedFd, node: u32) -> Result<Self> {Self::portal_memory(remote,node,true).await}
    async fn portal_memory(remote: OwnedFd, node: u32, linear_dmabuf: bool) -> Result<Self> {
        // Native state changes can block on a failed media service. Keep the
        // async portal-close path runnable; the owning process also requires
        // an independent kill-and-reap deadline from its desktop host.
        tokio::task::spawn_blocking(move || {
            let source = gst::ElementFactory::make("pipewiresrc")
                .property("fd", remote.as_raw_fd()).property("path", node.to_string())
                .property("do-timestamp", true).build()?;
            Self::pipeline(source, Some(remote),linear_dmabuf)
        }).await?
    }

    pub fn test_pattern() -> Result<Self> {
        let source = gst::ElementFactory::make("videotestsrc")
            .property("num-buffers", 1i32).property_from_str("pattern", "smpte").build()?;
        Self::pipeline(source, None,false)
    }

    pub async fn frame(&self) -> Result<Frame> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(sample) = self.sink.try_pull_sample(gst::ClockTime::ZERO) {
                let frame = Frame::from_sample(&sample)?;
                *self.latest.lock().map_err(|_| anyhow::anyhow!("Frame cache failed"))? = Some(frame.clone());
                return Ok(frame);
            }
            if let Some(message) = self.pipeline.bus().and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error])) {
                if let gst::MessageView::Error(error) = message.view() { anyhow::bail!("Screen capture failed: {}",error.error()); }
            }
            ensure!(!self.sink.is_eos(), "Capture ended before a frame arrived");
            // PipeWire can send frames only when pixels change. Reuse only
            // this live stream's latest image, retaining its real timestamp.
            if let Some(frame) = self.latest.lock().map_err(|_| anyhow::anyhow!("Frame cache failed"))?.as_ref() {
                return Ok(frame.clone());
            }
            ensure!(tokio::time::Instant::now() < deadline, "Timed out waiting for a usable frame");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn framework_frame_and_png_have_matching_dimensions() {
        gst::init().unwrap();
        let capture = Capture::test_pattern().unwrap();
        let frame = capture.frame().await.unwrap();
        let png = frame.png().unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        assert_eq!((decoder.info().width, decoder.info().height), (frame.info.width, frame.info.height));
        assert_eq!(frame.pixels.len(), frame.info.width as usize * frame.info.height as usize * 4);
    }
    #[test]
    fn missing_and_oversized_caps_fail_before_mapping() {
        gst::init().unwrap();
        assert!(Frame::from_sample(&gst::Sample::builder().build()).is_err());
        let caps = gst::Caps::builder("video/x-raw").field("format", "RGBA")
            .field("width", 16384i32).field("height", 16384i32).build();
        assert!(Frame::from_sample(&gst::Sample::builder().caps(&caps).build()).is_err());
    }
}
