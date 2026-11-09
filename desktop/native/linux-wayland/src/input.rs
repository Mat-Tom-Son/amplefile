//! A common input surface; the grant and accepted-turn policy stay in the host.
use crate::{ei, niri};
use anyhow::Result;
use std::os::fd::OwnedFd;
pub enum Sender {
    Eis(ei::Sender),
    Niri(niri::Input),
}
macro_rules! delegate {
    ($self:ident,$method:ident $(,$arg:expr)*) => {match $self { Self::Eis(input) => input.$method($($arg),*),Self::Niri(input) => input.$method($($arg),*) }};
}
impl Sender {
    pub fn new(fd: OwnedFd) -> Result<Self> {
        Ok(Self::Eis(ei::Sender::new(fd)?))
    }
    pub fn niri(position: (i32, i32), size: (i32, i32), pixels: (u32, u32)) -> Result<Self> {
        Ok(Self::Niri(niri::Input::new(position, size, pixels)?))
    }
    pub fn dispatch(&mut self) -> Result<()> {
        delegate!(self, dispatch)
    }
    pub fn regions(&self) -> Result<Vec<ei::Region>> {
        delegate!(self, regions)
    }
    pub fn ready_for(&self, pointer: bool, keyboard: bool) -> bool {
        delegate!(self, ready_for, pointer, keyboard)
    }
    pub fn validate_text(&self, text: &str) -> Result<()> {
        delegate!(self, validate_text, text)
    }
    pub fn validate_shortcut(&self, keys: &[String]) -> Result<()> {
        delegate!(self, validate_shortcut, keys)
    }
    pub fn begin_sequence(&mut self) -> Result<()> {
        delegate!(self, begin_sequence)
    }
    pub fn end_sequence(&mut self) {
        delegate!(self, end_sequence)
    }
    pub fn move_absolute(&mut self, mapping: &str, x: f64, y: f64) -> Result<()> {
        delegate!(self, move_absolute, mapping, x, y)
    }
    pub fn click(&mut self, mapping: &str, x: f64, y: f64, button: u32, count: u8) -> Result<()> {
        delegate!(self, click, mapping, x, y, button, count)
    }
    pub fn scroll(&mut self, mapping: &str, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        delegate!(self, scroll, mapping, x, y, dx, dy)
    }
    pub fn shortcut(&mut self, keys: &[String]) -> Result<()> {
        delegate!(self, shortcut, keys)
    }
    pub fn type_text(&mut self, text: &str) -> Result<()> {
        delegate!(self, type_text, text)
    }
    pub async fn drag(&mut self, mapping: &str, path: &[(f64, f64)]) -> Result<()> {
        match self {
            Self::Eis(input) => input.drag(mapping, path).await,
            Self::Niri(input) => input.drag(mapping, path).await,
        }
    }
}
