fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "telegram_app_credentials",
            "telegram_begin_login",
            "telegram_submit_code",
            "telegram_submit_password",
            "telegram_poll",
            "telegram_load_account",
            "telegram_messages",
            "telegram_logout",
            "telegram_restore",
            "workspace_status",
            "workspace_remember_accounts",
        ]),
    ))
    .expect("failed to run tauri-build");
}
