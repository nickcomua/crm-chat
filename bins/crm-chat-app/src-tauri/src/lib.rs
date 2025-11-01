#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

mod db;
mod live_query;
mod model;
mod models;
mod repositories;
mod services;
mod vector;
#[macro_use]
mod handlers;

pub use handlers::{
    create_board_note, delete_board_note, get_board_notes, get_chats, get_messages, get_top_n,
    merge_board_note, subscribe_live_query, 
    // unsubscribe_live_query, 
    update_chat_name,
    update_chat_pin,
};
pub use models::LiveQueryEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .typ::<models::WordDefinition>()
        .typ::<models::Chat>()
        .typ::<models::BoardNotePatch>()
        .typ::<models::BoardNoteCreate>()
        .typ::<models::BoardNote>()
        .typ::<models::LiveQueryAction>()
        .typ::<models::LiveQueryEvent>()
        // Then register them (separated by a comma)
        .commands(collect_commands![
            get_chats,
            get_top_n,
            update_chat_pin,
            update_chat_name,
            merge_board_note,
            create_board_note,
            delete_board_note,
            get_messages,
            get_board_notes,
            subscribe_live_query,
            // unsubscribe_live_query
        ])
        .events(tauri_specta::collect_events![LiveQueryEvent]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    builder
        .export(
            Typescript::default().header("// biome-ignore-all lint: autogen \n // biome-ignore-all assist/source/organizeImports: autogen"),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            // Mount events for tauri-specta
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
