//! Native portal, media and emulated-input adapters. These APIs carry no app,
//! Chat or approval policy. The host owns setup and accepted-turn authority.
pub mod ei;
pub mod capture;
pub mod portal;
pub mod seat;
mod keyboard;

pub mod compositor;
pub mod virtual_input;
pub mod input;
pub mod session_lock;

mod linear_frame;
