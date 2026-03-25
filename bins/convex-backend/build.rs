use std::collections::HashMap;

use convex_typegen::{Configuration, generate};

fn main() {
    println!("cargo:rerun-if-changed=convex/schema.ts");

    // Collect function files (all .ts files except schema, auth.config, and _generated)
    let function_paths: Vec<std::path::PathBuf> = std::fs::read_dir("convex")
        .expect("convex/ directory must exist")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if name.ends_with(".ts")
                && name != "schema.ts"
                && name != "auth.config.ts"
                && name != "convex.config.ts"
                && name != "env.ts"
                && !name.starts_with('_')
            {
                println!("cargo:rerun-if-changed=convex/{}", name);
                Some(path)
            } else {
                None
            }
        })
        .collect();

    // No helper stubs needed for the current project — the Bun plugin already
    // redirects _generated/* and convex/* imports, and helpers/auth.ts +
    // helpers/result.ts work naturally since their runtime imports are all
    // covered by the mock modules.
    let helper_stubs = HashMap::new();

    let config = Configuration {
        schema_path: std::path::PathBuf::from("convex/schema.ts"),
        out_file: std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap())
            .join("convex_types.rs"),
        function_paths,
        helper_stubs,
    };

    match generate(config) {
        Ok(_) => {}
        Err(e) => panic!("convex-typegen failed: {}", e),
    }
}
