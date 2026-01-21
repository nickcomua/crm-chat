//! Authentication types and methods for Telegram client.
//!
//! This module provides clonable wrappers around grammers' authentication types
//! and implements phone-based and QR code login flows.

use grammers_client::{client::PasswordToken, SignInError};
use messanger_interface::MessengerError;
use tracing::{debug, error, info, instrument, warn};

/// Result of a QR login token export operation.
#[derive(Debug, Clone)]
pub enum QrLoginToken {
    /// A new token was generated. Contains the `tg://login?token=...` URL and expiry timestamp.
    Token {
        /// The `tg://login?token=...` URL that should be displayed as a QR code
        url: String,
        /// Unix timestamp when this token expires
        expires: i32,
    },
    /// The token was accepted on another device, login succeeded.
    Success,
    /// The client needs to connect to a different DC to complete login.
    /// This is handled automatically by `login_with_qr`.
    MigrateTo { dc_id: i32 },
}

/// Clonable login token returned by `request_login_code`.
/// This wraps the data from grammers' `LoginToken` so it can be cloned and stored.
#[derive(Debug, Clone)]
pub struct ClonableLoginToken {
    /// The phone number associated with this login attempt
    pub phone: String,
    /// The hash received from Telegram for this login code request
    pub phone_code_hash: String,
}

/// Result of a sign-in attempt that requires further action.
#[derive(Debug, Clone)]
pub enum SignInResult {
    /// Sign-in was successful, contains the user ID
    Success { user_id: i64 },
    /// A 2FA password is required to complete sign-in
    PasswordRequired(Box<ClonablePasswordToken>),
    /// Sign-up is required (account doesn't exist)
    SignUpRequired,
    /// The provided code was invalid
    InvalidCode,
}

/// Clonable password token for 2FA authentication.
/// This contains all the data needed to verify a password.
#[derive(Debug, Clone)]
pub struct ClonablePasswordToken {
    /// Optional hint for the password
    pub hint: Option<String>,
    /// The raw password data from Telegram (serialized for storage)
    pub password_data: grammers_tl_types::types::account::Password,
}

impl ClonablePasswordToken {
    /// Get the password hint, if any
    pub fn hint(&self) -> Option<&str> {
        self.hint.as_deref()
    }
}

/// Result of checking a 2FA password.
#[derive(Debug, Clone)]
pub enum CheckPasswordResult {
    /// Password was correct, sign-in successful
    Success { user_id: i64 },
    /// The provided password was invalid
    InvalidPassword,
}

use crate::TelegramClient;

impl TelegramClient {
    /// Request a login code for the given phone number.
    ///
    /// This is the first step in the phone number authentication flow.
    /// After calling this, the user will receive a code via Telegram or SMS.
    ///
    /// # Arguments
    /// * `phone` - The phone number in international format (e.g., "+1234567890")
    ///
    /// # Returns
    /// A `ClonableLoginToken` that should be passed to `sign_in` along with the received code.
    #[instrument(skip(self), fields(phone = %phone))]
    pub async fn request_login_code(
        &self,
        phone: &str,
    ) -> Result<ClonableLoginToken, MessengerError> {
        use grammers_tl_types as tl;

        info!("Requesting login code");
        let client = self.client.lock().await;

        // We invoke SendCode directly to capture the phone_code_hash,
        // since grammers' LoginToken has private fields we can't access.
        // Note: api_id is stored in the client internally, but we need to use 0 here
        // as we're invoking the raw request. The client's invoke will use the configured api_id.
        let request = tl::functions::auth::SendCode {
            phone_number: phone.to_string(),
            api_id: 0, // Will be ignored since we're using client.invoke
            api_hash: self.api_hash.clone(),
            settings: tl::types::CodeSettings {
                allow_flashcall: false,
                current_number: false,
                allow_app_hash: false,
                allow_missed_call: false,
                allow_firebase: false,
                unknown_number: false,
                logout_tokens: None,
                token: None,
                app_sandbox: None,
            }
            .into(),
        };

        debug!("Invoking SendCode request");
        let result = client.invoke(&request).await;

        match result {
            Ok(tl::enums::auth::SentCode::Code(sent_code)) => {
                info!("Login code sent successfully");
                Ok(ClonableLoginToken {
                    phone: phone.to_string(),
                    phone_code_hash: sent_code.phone_code_hash,
                })
            }
            Ok(tl::enums::auth::SentCode::Success(_)) => {
                warn!("Already authorized when requesting login code");
                Err(MessengerError::Authentication(
                    "Already authorized".to_string(),
                ))
            }
            Ok(tl::enums::auth::SentCode::PaymentRequired(_)) => {
                error!("Payment required to send login code");
                Err(MessengerError::Authentication(
                    "Payment required to send login code".to_string(),
                ))
            }
            Err(e) => {
                // Check if it's a DC migration error (303)
                let err_str = e.to_string();
                if err_str.contains("303") || err_str.contains("PHONE_MIGRATE") {
                    info!("DC migration required, handling migration");
                    // Let grammers handle the migration by using its method
                    drop(client);
                    let client = self.client.lock().await;
                    let _token = client
                        .request_login_code(phone, &self.api_hash)
                        .await
                        .map_err(|e| {
                            error!(error = %e, "Failed to request login code during migration");
                            MessengerError::Authentication(format!(
                                "Failed to request login code: {}",
                                e
                            ))
                        })?;
                    // grammers handled the migration, now try invoking again
                    debug!("Retrying SendCode after migration");
                    let retry_result = client.invoke(&request).await;
                    match retry_result {
                        Ok(tl::enums::auth::SentCode::Code(sent_code)) => {
                            info!("Login code sent successfully after migration");
                            Ok(ClonableLoginToken {
                                phone: phone.to_string(),
                                phone_code_hash: sent_code.phone_code_hash,
                            })
                        }
                        Ok(tl::enums::auth::SentCode::Success(_)) => {
                            warn!("Already authorized after migration");
                            Err(MessengerError::Authentication(
                                "Already authorized".to_string(),
                            ))
                        }
                        Ok(tl::enums::auth::SentCode::PaymentRequired(_)) => {
                            error!("Payment required after migration");
                            Err(MessengerError::Authentication(
                                "Payment required to send login code".to_string(),
                            ))
                        }
                        Err(e) => {
                            error!(error = %e, "Failed to request login code after migration");
                            Err(MessengerError::Authentication(format!(
                                "Failed to request login code after migration: {}",
                                e
                            )))
                        }
                    }
                } else {
                    error!(error = %e, "Failed to request login code");
                    Err(MessengerError::Authentication(format!(
                        "Failed to request login code: {}",
                        e
                    )))
                }
            }
        }
    }

    /// Sign in with the login code received after calling `request_login_code`.
    ///
    /// # Arguments
    /// * `token` - The `ClonableLoginToken` returned by `request_login_code`
    /// * `code` - The verification code received via Telegram or SMS
    ///
    /// # Returns
    /// * `SignInResult::Success` - Login successful
    /// * `SignInResult::PasswordRequired` - 2FA password is needed, call `check_password`
    /// * `SignInResult::SignUpRequired` - Account doesn't exist
    /// * `SignInResult::InvalidCode` - The provided code was wrong
    #[instrument(skip(self, token, code), fields(phone = %token.phone))]
    pub async fn sign_in(
        &self,
        token: &ClonableLoginToken,
        code: &str,
    ) -> Result<SignInResult, MessengerError> {
        use grammers_tl_types as tl;

        info!("Attempting sign in with code");
        let client = self.client.lock().await;

        let request = tl::functions::auth::SignIn {
            phone_number: token.phone.clone(),
            phone_code_hash: token.phone_code_hash.clone(),
            phone_code: Some(code.to_string()),
            email_verification: None,
        };

        match client.invoke(&request).await {
            Ok(tl::enums::auth::Authorization::Authorization(auth)) => {
                // Extract user ID from the authorization
                let user_id = match auth.user {
                    tl::enums::User::User(user) => user.id,
                    tl::enums::User::Empty(empty) => empty.id,
                };
                info!(user_id = user_id, "Sign in successful");
                Ok(SignInResult::Success { user_id })
            }
            Ok(tl::enums::auth::Authorization::SignUpRequired(_)) => {
                warn!("Sign up required - account does not exist");
                Ok(SignInResult::SignUpRequired)
            }
            Err(e) if e.is("SESSION_PASSWORD_NEEDED") => {
                info!("2FA password required");
                // Need to fetch password information for 2FA
                let password_request = tl::functions::account::GetPassword {};
                let password_info: tl::types::account::Password = client
                    .invoke(&password_request)
                    .await
                    .map_err(|e| {
                        error!(error = %e, "Failed to get password information");
                        MessengerError::Authentication(format!(
                            "Failed to get password information: {}",
                            e
                        ))
                    })?
                    .into();

                let hint = password_info.hint.clone();
                debug!(hint = ?hint, "Got password hint");

                Ok(SignInResult::PasswordRequired(Box::new(
                    ClonablePasswordToken {
                        hint,
                        password_data: password_info,
                    },
                )))
            }
            Err(e) if e.is("PHONE_CODE_INVALID") || e.is("PHONE_CODE_EXPIRED") => {
                warn!("Invalid or expired code");
                Ok(SignInResult::InvalidCode)
            }
            Err(e) => {
                error!(error = %e, "Sign in failed");
                Err(MessengerError::Authentication(format!(
                    "Sign in failed: {}",
                    e
                )))
            }
        }
    }

    /// Check the 2FA password to complete sign-in.
    ///
    /// This should be called when `sign_in` returns `SignInResult::PasswordRequired`.
    ///
    /// # Arguments
    /// * `token` - The `ClonablePasswordToken` from `SignInResult::PasswordRequired`
    /// * `password` - The user's 2FA password
    ///
    /// # Returns
    /// * `CheckPasswordResult::Success` - Login successful
    /// * `CheckPasswordResult::InvalidPassword` - The provided password was wrong
    #[instrument(skip(self, token, password))]
    pub async fn check_password(
        &self,
        token: ClonablePasswordToken,
        password: &str,
    ) -> Result<CheckPasswordResult, MessengerError> {
        info!("Checking 2FA password");
        let client = self.client.lock().await;

        // Convert our clonable token back to grammers' PasswordToken
        let grammers_token = PasswordToken::new(token.password_data);

        // Use grammers' check_password which handles the SRP calculation
        match client.check_password(grammers_token, password).await {
            Ok(user) => {
                let user_id = user.id().bare_id();
                info!(user_id = user_id, "Password check successful");
                Ok(CheckPasswordResult::Success { user_id })
            }
            Err(SignInError::InvalidPassword(_)) => {
                warn!("Invalid password provided");
                Ok(CheckPasswordResult::InvalidPassword)
            }
            Err(e) => {
                error!(error = %e, "Password check failed");
                Err(MessengerError::Authentication(format!(
                    "Password check failed: {}",
                    e
                )))
            }
        }
    }

    /// Perform QR code login.
    ///
    /// This function returns a stream of `QrLoginToken` events. Display each token as a QR code.
    /// The stream will yield `QrLoginToken::Token` with URLs to display, and finally
    /// `QrLoginToken::Success` when login completes.
    ///
    /// # Arguments
    /// * `api_id` - Your Telegram API ID
    ///
    /// # Returns
    /// A stream of `QrLoginToken` events
    ///
    /// # Example
    /// ```ignore
    /// use futures::StreamExt;
    ///
    /// let mut stream = client.login_with_qr(api_id);
    /// while let Some(result) = stream.next().await {
    ///     match result? {
    ///         QrLoginToken::Token { url, expires } => {
    ///             println!("Scan this QR code: {}", url);
    ///             println!("Expires at: {}", expires);
    ///         }
    ///         QrLoginToken::Success => {
    ///             println!("Login successful!");
    ///             break;
    ///         }
    ///         QrLoginToken::MigrateTo { dc_id } => {
    ///             // Handled internally, but yielded for visibility
    ///         }
    ///     }
    /// }
    /// ```
    pub fn login_with_qr(
        &self,
        api_id: i32,
    ) -> impl futures::Stream<Item = Result<QrLoginToken, MessengerError>> + '_ {
        use async_stream::stream;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use grammers_tl_types as tl;

        stream! {
            info!("Starting QR code login");
            let client = self.client.lock().await;

            // IDs of users already logged in on this client (to exclude from QR login)
            let except_ids: Vec<i64> = vec![];

            loop {
                // Request a new login token
                let request = tl::functions::auth::ExportLoginToken {
                    api_id,
                    api_hash: self.api_hash.clone(),
                    except_ids: except_ids.clone(),
                };

                debug!("Exporting login token");
                let result = match client.invoke(&request).await {
                    Ok(r) => r,
                    Err(e) => {
                        error!(error = %e, "Failed to export login token");
                        yield Err(MessengerError::Authentication(format!("Failed to export login token: {}", e)));
                        return;
                    }
                };

                match result {
                    tl::enums::auth::LoginToken::Token(token) => {
                        // Generate the tg:// URL for QR code
                        let encoded = URL_SAFE_NO_PAD.encode(&token.token);
                        let url = format!("tg://login?token={}", encoded);

                        debug!(expires = token.expires, "Generated QR login token");

                        yield Ok(QrLoginToken::Token {
                            url,
                            expires: token.expires,
                        });

                        // Wait a bit before checking again or requesting a new token
                        // The token typically expires in ~30 seconds
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    tl::enums::auth::LoginToken::MigrateTo(migrate) => {
                        info!(dc_id = migrate.dc_id, "QR login requires DC migration");
                        yield Ok(QrLoginToken::MigrateTo { dc_id: migrate.dc_id });

                        // Need to import the token on a different DC
                        let import_request = tl::functions::auth::ImportLoginToken {
                            token: migrate.token,
                        };

                        let import_result = match client.invoke_in_dc(migrate.dc_id, &import_request).await {
                            Ok(r) => r,
                            Err(e) => {
                                error!(error = %e, dc_id = migrate.dc_id, "Failed to import login token");
                                yield Err(MessengerError::Authentication(format!(
                                    "Failed to import login token to DC {}: {}",
                                    migrate.dc_id, e
                                )));
                                return;
                            }
                        };

                        // Handle the result from the other DC
                        match import_result {
                            tl::enums::auth::LoginToken::Success(success) => {
                                info!("QR login successful after DC migration");
                                match success.authorization {
                                    tl::enums::auth::Authorization::Authorization(_) => {
                                        yield Ok(QrLoginToken::Success);
                                        return;
                                    }
                                    tl::enums::auth::Authorization::SignUpRequired(_) => {
                                        error!("QR login failed - account signup required");
                                        yield Err(MessengerError::Authentication(
                                            "Account signup required - QR login only works for existing accounts".to_string(),
                                        ));
                                        return;
                                    }
                                }
                            }
                            _ => {
                                debug!("Unexpected response after DC migration, continuing");
                                continue;
                            }
                        }
                    }
                    tl::enums::auth::LoginToken::Success(success) => {
                        info!("QR login successful");
                        match success.authorization {
                            tl::enums::auth::Authorization::Authorization(_) => {
                                yield Ok(QrLoginToken::Success);
                                return;
                            }
                            tl::enums::auth::Authorization::SignUpRequired(_) => {
                                error!("QR login failed - account signup required");
                                yield Err(MessengerError::Authentication(
                                    "Account signup required - QR login only works for existing accounts".to_string(),
                                ));
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}
