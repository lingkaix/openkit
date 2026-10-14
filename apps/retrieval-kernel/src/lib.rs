//! The domain-free Retrieval Kernel. Canonical files remain with their adapters.
pub mod directory;
mod model;
mod query;
mod store;
mod text;
pub use model::*;
pub use store::Kernel;
pub use text::tokens;

#[cfg(test)]
mod tests;
