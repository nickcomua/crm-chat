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
            "telegram_open_chat",
            "telegram_close_chat",
            "telegram_incoming",
            "telegram_sponsored",
            "telegram_view_sponsored",
            "telegram_click_sponsored",
            "telegram_logout",
            "telegram_restore",
        ]),
    ))
    .expect("failed to run tauri-build");
}
