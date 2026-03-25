use std::path::PathBuf;

/// Deploy Convex functions to a running backend instance.
///
/// Sets required environment variables in Convex's env store, then deploys.
pub async fn deploy_convex(convex_url: &str, admin_key: &str) -> anyhow::Result<()> {
    // Allow overriding via env var for nixosTest (where the binary runs in a VM)
    let convex_backend_dir = PathBuf::from(
        std::env::var("CONVEX_BACKEND_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string()),
    );

    // Ensure node_modules exist
    let npm_status = tokio::process::Command::new("npm")
        .arg("install")
        .current_dir(&convex_backend_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status()
        .await?;

    if !npm_status.success() {
        anyhow::bail!("npm install failed with exit code: {npm_status}");
    }

    // Set environment variables in Convex's env store.
    // auth.config.ts reads CLERK_JWT_ISSUER_DOMAIN via process.env at deploy time.
    let clerk_issuer = std::env::var("CLERK_JWT_ISSUER_DOMAIN")
        .expect("CLERK_JWT_ISSUER_DOMAIN must be set for integration tests");
    let output = convex_cmd(&convex_backend_dir, convex_url, admin_key)
        .args(["env", "set", "CLERK_JWT_ISSUER_DOMAIN", &clerk_issuer])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("convex env set CLERK_JWT_ISSUER_DOMAIN failed: {stderr}");
    }

    // Deploy functions
    let output = convex_cmd(&convex_backend_dir, convex_url, admin_key)
        .arg("deploy")
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!("convex deploy failed:\nstdout: {stdout}\nstderr: {stderr}");
    }

    Ok(())
}

fn convex_cmd(dir: &PathBuf, convex_url: &str, admin_key: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("npx");
    cmd.arg("convex")
        .current_dir(dir)
        .env("CONVEX_SELF_HOSTED_URL", convex_url)
        .env("CONVEX_SELF_HOSTED_ADMIN_KEY", admin_key);
    cmd
}
