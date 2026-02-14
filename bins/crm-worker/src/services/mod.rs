//! Restate service definitions.
//!
//! - `PhoneAuthWorkflow`: Durable workflow for phone-based Telegram authentication
//! - `QrAuthWorkflow`: Durable workflow for QR-code-based Telegram authentication
//! - `ClientScanner`: Virtual object for per-client chat/message scanning

pub mod client_scanner;
pub mod phone_auth;
pub mod qr_auth;
