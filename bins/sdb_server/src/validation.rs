//! Validation helpers for task payloads and other user inputs.
//!
//! These functions validate data before it's stored in SpacetimeDB tables,
//! returning descriptive error messages for invalid input.

/// Validates international phone number format using phonelib.
///
/// Accepts phone numbers in international format (e.g., "+1234567890").
pub fn phone(phone: &str) -> Result<(), String> {
    if phone.is_empty() {
        return Err("Phone number cannot be empty".to_string());
    }
    if !phonelib::is_valid_phone_number(phone) {
        return Err(
            "Invalid phone number format. Expected international format like +1234567890"
                .to_string(),
        );
    }
    Ok(())
}

/// Validates Telegram auth code (exactly 5 digits).
pub fn auth_code(code: &str) -> Result<(), String> {
    if code.len() != 5 {
        return Err(format!(
            "Auth code must be exactly 5 digits, got {} characters",
            code.len()
        ));
    }
    if !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("Auth code must contain only digits (0-9)".to_string());
    }
    Ok(())
}

/// Validates 2FA password (must be non-empty).
pub fn password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_phone_valid() {
        assert!(phone("+12025550173").is_ok());
        assert!(phone("+442079460958").is_ok());
    }

    #[test]
    fn test_phone_invalid() {
        assert!(phone("").is_err());
        assert!(phone("123").is_err());
        assert!(phone("not-a-phone").is_err());
    }

    #[test]
    fn test_auth_code_valid() {
        assert!(auth_code("12345").is_ok());
        assert!(auth_code("00000").is_ok());
        assert!(auth_code("99999").is_ok());
    }

    #[test]
    fn test_auth_code_invalid() {
        assert!(auth_code("").is_err());
        assert!(auth_code("1234").is_err()); // too short
        assert!(auth_code("123456").is_err()); // too long
        assert!(auth_code("1234a").is_err()); // contains letter
        assert!(auth_code("12 34").is_err()); // contains space
    }

    #[test]
    fn test_password_valid() {
        assert!(password("secret").is_ok());
        assert!(password("a").is_ok());
        assert!(password("complex P@ssw0rd!").is_ok());
    }

    #[test]
    fn test_password_invalid() {
        assert!(password("").is_err());
    }
}
