use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let crate_dir = Path::new(&manifest_dir);
    let project_dir = crate_dir.join("../../bins/sdb_server");
    let out_dir: PathBuf = crate_dir.join("src/module_bindings");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", project_dir.display());

    if !project_dir.exists() {
        panic!(
            "Spacetime project not found at '{}'. Adjust --project-path in build.rs.",
            project_dir.display()
        );
    }

    // Ensure output directory exists (and clear stale files if present)
    if out_dir.exists() {
        let _ = fs::remove_dir_all(&out_dir);
    }
    fs::create_dir_all(&out_dir).expect("failed to create module_bindings directory");

    let out_dir_str = out_dir.to_string_lossy().to_string();
    let project_dir_str = project_dir.to_string_lossy().to_string();

    let status = Command::new("spacetime")
        .args([
            "generate",
            "--lang",
            "rust",
            "--out-dir",
            &out_dir_str,
            "--project-path",
            &project_dir_str,
        ])
        .current_dir(&crate_dir)
        .status();

    match status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            panic!(
                "spacetime generate failed with status {}. Ensure 'spacetime' CLI is installed and on PATH.",
                s
            );
        }
        Err(e) => {
            panic!(
                "failed to invoke 'spacetime': {}. Install the Spacetime CLI and ensure it is on PATH.",
                e
            );
        }
    }
}
