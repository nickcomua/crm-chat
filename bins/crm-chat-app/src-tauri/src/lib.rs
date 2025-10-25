#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

mod db;
mod model;
mod models;
mod repositories;
mod services;
mod vector;
#[macro_use]
mod handlers;

pub use handlers::{
    create_board_note, delete_board_note, get_board_notes, get_chats, get_messages, get_top_n,
    merge_board_note, update_chat_name, update_chat_pin,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .typ::<models::WordDefinition>()
        .typ::<models::Chat>()
        .typ::<models::BoardNotePatch>()
        .typ::<models::BoardNoteCreate>()
        .typ::<models::BoardNote>()
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
            get_board_notes
        ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    builder
        .export(
            Typescript::default().header("// biome-ignore-all lint: autogen \n // biome-ignore assist/source/organizeImports: autogen"),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_chats,
            get_top_n,
            update_chat_pin,
            update_chat_name,
            merge_board_note,
            create_board_note,
            delete_board_note,
            get_messages,
            get_board_notes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
