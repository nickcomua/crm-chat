//! Integration tests for convex-typegen generated code against a real Convex backend.
//!
//! These tests spin up a Docker container with the Convex backend, deploy
//! the actual Convex functions, and exercise the generated `ConvexApi` trait.
//!
//! Run with: `cargo test -p convex-backend --test integration_test -- --nocapture`
//!
//! Prerequisites: Docker running, Node.js + npm available.

mod common;

use std::time::Duration;

use common::{assert_mutation_error, get_test_env, mint_robot_jwt};
use convex::ConvexClient;
use convex_backend::{ConvexApi, PhoneAuthRobotClaimArgs, QrAuthRobotClaimArgs};
use futures::StreamExt;

/// Create a fresh ConvexClient authenticated as the test robot.
async fn connect_robot_client() -> ConvexClient {
    let env = get_test_env().await;
    let token = mint_robot_jwt(&env.robot_private_key_pem, &env.robot_id);
    let mut client = ConvexClient::new(&env.convex_url)
        .await
        .expect("Failed to connect to Convex");
    client.set_auth(Some(token)).await;
    // Give the server a moment to process the auth token
    tokio::time::sleep(Duration::from_millis(500)).await;
    client
}

// =============================================================================
// Query Subscriptions (empty results in fresh database)
// =============================================================================

#[tokio::test]

async fn test_subscribe_phone_auth_pending_empty() {
    let mut client = connect_robot_client().await;

    let mut sub = client
        .subscribe_phone_auth_pending_for_robot()
        .await
        .expect("Failed to subscribe");

    let result = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("Timeout waiting for subscription")
        .expect("Subscription stream ended")
        .expect("Subscription yielded error");

    assert!(
        result.is_empty(),
        "Expected no pending phone auths, got {}",
        result.len()
    );
}

#[tokio::test]

async fn test_subscribe_qr_auth_pending_empty() {
    let mut client = connect_robot_client().await;

    let mut sub = client
        .subscribe_qr_auth_pending_for_robot()
        .await
        .expect("Failed to subscribe");

    let result = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("Timeout waiting for subscription")
        .expect("Subscription stream ended")
        .expect("Subscription yielded error");

    assert!(result.is_empty(), "Expected no pending QR auths, got {}", result.len());
}

#[tokio::test]

async fn test_query_phone_auth_pending() {
    let mut client = connect_robot_client().await;

    let result = client
        .query_phone_auth_pending_for_robot()
        .await
        .expect("Query failed");

    assert!(result.is_empty(), "Expected empty array, got {} items", result.len());
}

// =============================================================================
// Typed Mutation Args
// =============================================================================

#[tokio::test]

async fn test_phone_auth_robot_claim_invalid_id() {
    let mut client = connect_robot_client().await;

    let result = client
        .phone_auth_robot_claim(PhoneAuthRobotClaimArgs {
            authId: "not_a_valid_convex_id".into(),
        })
        .await;

    // Convex rejects invalid document IDs at the validator level
    assert_mutation_error(result, "");
}

#[tokio::test]

async fn test_qr_auth_robot_claim_invalid_id() {
    let mut client = connect_robot_client().await;

    let result = client
        .qr_auth_robot_claim(QrAuthRobotClaimArgs {
            authId: "not_a_valid_convex_id".into(),
        })
        .await;

    assert_mutation_error(result, "");
}

// =============================================================================
// Args Serialization (no container needed, but grouped here for convenience)
// =============================================================================

#[tokio::test]

async fn test_phone_auth_args_serialization() {
    let args = PhoneAuthRobotClaimArgs {
        authId: "test_id_123".into(),
    };
    let map: std::collections::BTreeMap<String, serde_json::Value> = args.into();
    assert_eq!(map.get("authId"), Some(&serde_json::json!("test_id_123")));
    assert_eq!(map.len(), 1);
}

#[tokio::test]

async fn test_qr_auth_args_serialization() {
    let args = QrAuthRobotClaimArgs {
        authId: "test_id_456".into(),
    };
    let map: std::collections::BTreeMap<String, serde_json::Value> = args.into();
    assert_eq!(map.get("authId"), Some(&serde_json::json!("test_id_456")));
    assert_eq!(map.len(), 1);
}

// =============================================================================
// Auth Enforcement
// =============================================================================

#[tokio::test]

async fn test_unauthenticated_rejected() {
    let env = get_test_env().await;
    let mut client = ConvexClient::new(&env.convex_url)
        .await
        .expect("Failed to connect");
    // Deliberately do NOT call set_auth

    let result = client
        .phone_auth_robot_claim(PhoneAuthRobotClaimArgs {
            authId: "test_id".into(),
        })
        .await;
    assert_mutation_error(result, "");
}
