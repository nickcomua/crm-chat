use std::collections::HashMap;
use std::path::{Path, PathBuf};

use convex_typegen::{Configuration, generate};

const SKIP_FILES: &[&str] = &["schema.ts", "auth.config.ts", "convex.config.ts", "env.ts"];

fn main() {
    // Watch the entire convex/ directory so adding/renaming files triggers a rebuild
    println!("cargo:rerun-if-changed=convex");

    let mut function_paths: Vec<PathBuf> = Vec::new();
    collect_function_files(Path::new("convex"), &mut function_paths);

    let helper_stubs = HashMap::new();

    let config = Configuration {
        schema_path: PathBuf::from("convex/schema.ts"),
        out_file: PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("convex_types.rs"),
        function_paths,
        helper_stubs,
    };

    match generate(config) {
        Ok(_) => {}
        Err(e) => panic!("convex-typegen failed: {}", e),
    }
}

/// Recursively collect .ts function files, skipping _generated/, config files,
/// and helper utilities that don't export Convex functions.
fn collect_function_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("failed to read directory {}: {}", dir.display(), e));

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if path.is_dir() {
            // Skip _generated/ and helpers/ (no Convex function exports)
            if !name.starts_with('_') && name != "helpers" {
                collect_function_files(&path, out);
            }
            continue;
        }

        if name.ends_with(".ts")
            && !name.ends_with(".test.ts")
            && !name.starts_with('_')
            && !SKIP_FILES.contains(&name.as_str())
        {
            out.push(path);
        }
    }
}
