//! Job abstraction — a reactive worker keyed by Convex entity ID.
//!
//! Each `Job` subscribes to a Convex query that yields the current *set* of
//! entity IDs that still need work. The runner in `runner.rs` owns the
//! lifecycle: for every ID that newly appears in the set it spawns a tokio
//! task running `run_one`; when an ID disappears from the set (because the
//! entity transitioned to a terminal state, or was deleted) the task is
//! aborted if still running. No durable journal, no dedup table, no ingress —
//! Convex is the queue and the source of truth.

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::config::WorkerConfig;
use crate::ops::convex::ConvexApiClient;
use crate::session_manager::TelegramSessionManager;

/// Shared handles every job needs.
pub struct JobCtx {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
    pub config: WorkerConfig,
}

/// A reactive job driven by a Convex subscription stream.
#[async_trait]
pub trait Job: Send + Sync + 'static {
    /// Short name used in every log line, e.g. `"DialogSync"`.
    fn name(&self) -> &'static str;

    /// Subscribe to a stream that yields the *current set* of entity IDs
    /// that still need work. The runner diffs successive sets and spawns
    /// / cancels per-ID tasks accordingly. Emits the full set on every
    /// update.
    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>>;

    /// Do the work for a single entity. Called inside a per-ID tokio task.
    /// Must be idempotent — the stream may re-emit the same ID after a
    /// restart, a transient error, or a re-entry into the pending set.
    async fn run_one(&self, ctx: Arc<JobCtx>, entity_id: String) -> anyhow::Result<()>;
}
