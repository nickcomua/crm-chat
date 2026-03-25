use std::sync::Once;
use std::time::Duration;

use convex::ConvexClient;
use testcontainers::core::{ExecCommand, IntoContainerPort};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use tokio::sync::OnceCell;

use super::deploy::deploy_convex;

static DOCKER_HOST_INIT: Once = Once::new();

/// Shared test environment backed by a Convex Docker container.
pub struct ConvexTestEnv {
    pub convex_url: String,
    pub m2m_secret_key: String,
    // Held to keep the container alive via RAII.
    _container: ContainerAsync<GenericImage>,
}

static TEST_ENV: OnceCell<ConvexTestEnv> = OnceCell::const_new();

/// Get or initialize the shared Convex test environment.
///
/// The container is started once and reused across all tests in this binary.
pub async fn get_test_env() -> &'static ConvexTestEnv {
    TEST_ENV
        .get_or_init(|| async {
            ConvexTestEnv::setup()
                .await
                .expect("Failed to setup Convex test environment")
        })
        .await
}

impl ConvexTestEnv {
    async fn setup() -> anyhow::Result<Self> {
        // Auto-detect Docker socket for OrbStack/Docker Desktop/standard Docker.
        // testcontainers (bollard) needs DOCKER_HOST to find the socket.
        // std::sync::Once guarantees this runs exactly once across all threads.
        DOCKER_HOST_INIT.call_once(|| {
            if std::env::var("DOCKER_HOST").unwrap_or_default().is_empty() {
                let home = std::env::var("HOME").unwrap_or_default();
                let candidates = [
                    format!("{home}/.orbstack/run/docker.sock"),
                    "/var/run/docker.sock".to_string(),
                    format!("{home}/.docker/run/docker.sock"),
                ];
                for path in &candidates {
                    if std::path::Path::new(path).exists() {
                        // SAFETY: This runs inside Once::call_once, which guarantees
                        // single-threaded execution. It runs before bollard reads
                        // DOCKER_HOST (which happens in .start() below).
                        unsafe {
                            std::env::set_var("DOCKER_HOST", format!("unix://{path}"));
                        }
                        break;
                    }
                }
            }
        });

        eprintln!("[test] Starting Convex backend container...");

        // with_exposed_port is on GenericImage;
        // with_env_var is on ImageExt (returns ContainerRequest).
        let image = GenericImage::new("ghcr.io/get-convex/convex-backend", "latest")
            .with_exposed_port(3210.tcp())
            .with_exposed_port(3211.tcp());

        let container: ContainerAsync<GenericImage> = image
            .with_env_var("INSTANCE_NAME", "test-instance")
            .with_env_var(
                "INSTANCE_SECRET",
                "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974",
            )
            .with_env_var("CONVEX_CLOUD_ORIGIN", "http://127.0.0.1:3210")
            .with_env_var("CONVEX_SITE_ORIGIN", "http://127.0.0.1:3211")
            .with_env_var("RUST_LOG", "error")
            .start()
            .await?;

        let host = container.get_host().await?;
        let port = container.get_host_port_ipv4(3210.tcp()).await?;
        let convex_url = format!("http://{host}:{port}");

        eprintln!("[test] Container started at {convex_url}, waiting for backend...");

        // Poll until the backend is responsive
        for attempt in 0..60 {
            match ConvexClient::new(&convex_url).await {
                Ok(_) => {
                    eprintln!("[test] Backend ready after {attempt} attempts");
                    break;
                }
                Err(_) if attempt < 59 => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => anyhow::bail!("Convex backend not ready after 60s: {e}"),
            }
        }

        // Generate the admin key inside the container
        eprintln!("[test] Generating admin key...");
        let mut exec_result = container
            .exec(ExecCommand::new(["./generate_admin_key.sh"]))
            .await?;
        let stdout_bytes: Vec<u8> = exec_result.stdout_to_vec().await?;
        let stdout = String::from_utf8_lossy(&stdout_bytes);
        // The admin key is the last non-empty line of stdout
        // (format: "test-instance|01abcdef...")
        let admin_key = stdout
            .lines()
            .rfind(|l| !l.is_empty())
            .expect("No admin key in generate_admin_key.sh output")
            .to_string();
        eprintln!(
            "[test] Admin key: {}...",
            &admin_key[..admin_key.len().min(30)]
        );

        // Read Clerk M2M secret key from environment
        let m2m_secret_key = std::env::var("CLERK_M2M_SECRET_KEY")
            .expect("CLERK_M2M_SECRET_KEY must be set for integration tests");

        // Deploy Convex functions
        eprintln!("[test] Deploying Convex functions...");
        deploy_convex(&convex_url, &admin_key).await?;
        eprintln!("[test] Deploy complete!");

        Ok(Self {
            convex_url,
            m2m_secret_key,
            _container: container,
        })
    }
}
