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
                && !name.starts_with('_')
            {
                println!("cargo:rerun-if-changed=convex/{}", name);
                Some(path)
            } else {
                None
            }
        })
        .collect();

    let config = Configuration {
        schema_path: std::path::PathBuf::from("convex/schema.ts"),
        out_file: format!("{}/convex_types.rs", std::env::var("OUT_DIR").unwrap()),
        function_paths,
    };

    match generate(config) {
        Ok(_) => {}
        Err(e) => panic!("convex-typegen failed: {}", e),
    }
}
