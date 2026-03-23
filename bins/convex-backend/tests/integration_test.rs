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

use common::{assert_mutation_error, fetch_m2m_jwt, get_test_env};
use convex::ConvexClient;
use convex_backend::{
    ConvexApi, ConvexApiClient, WorkerTasksPendingForWorkerArgs, WorkerTasksRunTaskArgs,
    WorkerTasksWorkerCompleteArgs,
};
use futures::StreamExt;

/// Create a fresh ConvexApiClient authenticated via Clerk M2M.
async fn connect_robot_client() -> ConvexApiClient {
    let env = get_test_env().await;
    let token = fetch_m2m_jwt(&env.m2m_secret_key).await;
    let mut client = ConvexClient::new(&env.convex_url)
        .await
        .expect("Failed to connect to Convex");
    client.set_auth(Some(token)).await;
    // Give the server a moment to process the auth token
    tokio::time::sleep(Duration::from_millis(500)).await;
    ConvexApiClient::new(client)
}

// =============================================================================
// Query Subscriptions (empty results in fresh database)
// =============================================================================

#[tokio::test]
async fn test_subscribe_worker_tasks_pending_empty() {
    let client = connect_robot_client().await;

    let mut sub = client
        .subscribe_worker_tasks_pending_for_worker(WorkerTasksPendingForWorkerArgs {
            maxMediaWorkflows: None,
        })
        .await
        .expect("Failed to subscribe");

    let result = tokio::time::timeout(Duration::from_secs(10), sub.next())
        .await
        .expect("Timeout waiting for subscription")
        .expect("Subscription stream ended")
        .expect("Subscription yielded error");

    assert!(
        result.is_empty(),
        "Expected no pending tasks, got {}",
        result.len()
    );
}

#[tokio::test]
async fn test_query_worker_tasks_pending_empty() {
    let client = connect_robot_client().await;

    let result = client
        .query_worker_tasks_pending_for_worker(WorkerTasksPendingForWorkerArgs {
            maxMediaWorkflows: Some(2.0),
        })
        .await
        .expect("Query failed");

    assert!(
        result.is_empty(),
        "Expected empty array, got {} items",
        result.len()
    );
}

// =============================================================================
// Typed Mutation Args
// =============================================================================

#[tokio::test]
async fn test_run_task_invalid_id() {
    let client = connect_robot_client().await;

    let result = client
        .worker_tasks_run_task(WorkerTasksRunTaskArgs {
            taskId: "not_a_valid_convex_id".into(),
        })
        .await;

    // Convex rejects invalid document IDs at the validator level
    assert_mutation_error(result, "");
}

#[tokio::test]
async fn test_worker_complete_invalid_id() {
    let client = connect_robot_client().await;

    let result = client
        .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
            taskId: "not_a_valid_convex_id".into(),
            task: None,
        })
        .await;

    assert_mutation_error(result, "");
}

// =============================================================================
// Args Serialization (no container needed, but grouped here for convenience)
// =============================================================================

#[tokio::test]
async fn test_run_task_args_serialization() {
    let args = WorkerTasksRunTaskArgs {
        taskId: "test_id_123".into(),
    };
    let map: std::collections::BTreeMap<String, serde_json::Value> = args.into();
    assert_eq!(map.get("taskId"), Some(&serde_json::json!("test_id_123")));
    assert_eq!(map.len(), 1);
}

#[tokio::test]
async fn test_worker_complete_args_serialization() {
    let args = WorkerTasksWorkerCompleteArgs {
        taskId: "test_id_456".into(),
        task: None,
    };
    let map: std::collections::BTreeMap<String, serde_json::Value> = args.into();
    assert_eq!(map.get("taskId"), Some(&serde_json::json!("test_id_456")));
    // task is None so it shouldn't be serialized (or serialized as null)
}

// =============================================================================
// Auth Enforcement
// =============================================================================

#[tokio::test]
async fn test_unauthenticated_rejected() {
    let env = get_test_env().await;
    let client = ConvexApiClient::new(
        ConvexClient::new(&env.convex_url)
            .await
            .expect("Failed to connect"),
    );
    // Deliberately do NOT call set_auth

    let result = client
        .worker_tasks_run_task(WorkerTasksRunTaskArgs {
            taskId: "test_id".into(),
        })
        .await;
    assert_mutation_error(result, "");
}
