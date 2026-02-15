use std::path::PathBuf;

use std::collections::HashMap;

use convex_typegen::{Configuration, generate};

#[test]
fn test_crm_chat_schema() {
    let schema_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("convex/schema.ts");

    let dir = tempfile::TempDir::new().unwrap();
    let out_file = dir.path().join("convex_types.rs");

    let config = Configuration {
        schema_path,
        out_file: out_file.to_string_lossy().to_string(),
        function_paths: vec![],
        helper_stubs: HashMap::new(),
    };

    generate(config).expect("Failed to generate types from CRM chat schema");

    let output = std::fs::read_to_string(&out_file).expect("Failed to read generated file");
    println!("Generated output:\n{}", output);

    // Verify key types were generated (must match tables in schema.ts)
    assert!(
        output.contains("ClientsTable"),
        "Missing ClientsTable struct"
    );
    assert!(output.contains("ChatsTable"), "Missing ChatsTable struct");
    assert!(
        output.contains("MessagesTable"),
        "Missing MessagesTable struct"
    );
    assert!(output.contains("MediaTable"), "Missing MediaTable struct");
    assert!(
        output.contains("PhoneAuthsTable"),
        "Missing PhoneAuthsTable struct"
    );
    assert!(
        output.contains("QrAuthsTable"),
        "Missing QrAuthsTable struct"
    );
    assert!(
        output.contains("NotificationsTable"),
        "Missing NotificationsTable struct"
    );
}
