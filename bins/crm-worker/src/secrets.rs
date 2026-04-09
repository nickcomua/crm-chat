//! Compile-time typed secret declarations from `secretspec.toml`.
//!
//! The `declare_secrets!` macro reads `../../secretspec.toml` at compile time
//! and generates a `SecretSpec` struct with typed fields, a `Profile` enum,
//! and a builder for loading secrets from any provider.

secretspec_derive::declare_secrets!("../../secretspec.toml");
