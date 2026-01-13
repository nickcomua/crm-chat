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

    let project_dir_str = project_dir.to_string_lossy().to_string();

    let temp_dir = tempfile::Builder::new()
        .prefix("spacetime_build_")
        .tempdir()
        .expect("creating spacetime temp dir");

    let temp_out_dir = temp_dir.path().join("module_bindings");
    fs::create_dir_all(&temp_out_dir).expect("failed to create temp module_bindings directory");
    let temp_out_dir_str = temp_out_dir.to_string_lossy().to_string();

    let temp_target = temp_dir.path().join("target");

    let status = Command::new("spacetime")
        .args([
            "generate",
            "--lang",
            "rust",
            "--out-dir",
            &temp_out_dir_str,
            "--project-path",
            &project_dir_str,
        ])
        .env("CARGO_TARGET_DIR", &temp_target)
        .current_dir(crate_dir)
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

    let rs_files: Vec<_> = fs::read_dir(&temp_out_dir)
        .expect("failed to read temp output dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "rs"))
        .collect();

    if !rs_files.is_empty() {
        // Use RUSTFMT env var if set (for Nix compatibility), otherwise fall back to PATH
        let rustfmt_cmd = env::var("RUSTFMT").unwrap_or_else(|_| "rustfmt".to_string());
        let fmt_status = Command::new(&rustfmt_cmd)
            .arg("--edition")
            .arg("2024")
            .args(&rs_files)
            .status();

        match fmt_status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                panic!("rustfmt failed with status {}", s);
            }
            Err(e) => {
                panic!("failed to invoke 'rustfmt': {}", e);
            }
        }
    }

    if out_dir.exists() {
        fs::remove_dir_all(&out_dir).expect("failed to remove old module_bindings");
    }

    // Use copy instead of rename to handle cross-device moves
    copy_dir_all(&temp_out_dir, &out_dir)
        .expect("failed to move generated bindings to final location");
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);

        if path.is_dir() {
            copy_dir_all(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}
