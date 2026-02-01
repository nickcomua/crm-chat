//! Authentication tasks module.
//!
//! This module contains all authentication-related tasks:
//! - Phone-based login: SendLoginCode, ReceiveLoginCode, VerifyLoginCode
//! - 2FA password: ReceivePassword, VerifyPassword
//! - QR code login: GenerateQrCode

pub mod send_login_code;
pub mod receive_login_code;
pub mod verify_login_code;
pub mod receive_password;
pub mod verify_password;
pub mod generate_qr_code;

pub use send_login_code::{SendLoginCode, SendLoginCodeOutput};
pub use receive_login_code::{ReceiveLoginCode, ReceiveLoginCodeOutput};
pub use verify_login_code::{VerifyLoginCode, VerifyLoginCodeOutput};
pub use receive_password::{ReceivePassword, ReceivePasswordOutput};
pub use verify_password::{VerifyPassword, VerifyPasswordOutput};
pub use generate_qr_code::{GenerateQrCode, GenerateQrCodeOutput};
