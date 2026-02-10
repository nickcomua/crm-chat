use std::path::PathBuf;

/// Deploy Convex functions to a running backend instance.
///
/// Sets required environment variables in Convex's env store, then deploys.
pub async fn deploy_convex(
    convex_url: &str,
    admin_key: &str,
    jwks_data_uri: &str,
) -> anyhow::Result<()> {
    let convex_backend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

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
    // auth.config.ts reads these via process.env at deploy time.
    for (key, value) in [
        ("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test.invalid"),
        ("ROBOT_JWKS", jwks_data_uri),
    ] {
        let output = convex_cmd(&convex_backend_dir, convex_url, admin_key)
            .args(["env", "set", key, value])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("convex env set {key} failed: {stderr}");
        }
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

fn convex_cmd(
    dir: &PathBuf,
    convex_url: &str,
    admin_key: &str,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("npx");
    cmd.arg("convex")
        .current_dir(dir)
        .env("CONVEX_SELF_HOSTED_URL", convex_url)
        .env("CONVEX_SELF_HOSTED_ADMIN_KEY", admin_key);
    cmd
}
