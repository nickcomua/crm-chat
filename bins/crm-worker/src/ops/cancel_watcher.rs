//! Cancel watcher — subscribes to a workerTask's status and fires a
//! `CancellationToken` when the task becomes `Cancelled` or is deleted.
//!
//! Shared by all Restate handlers that need a universal cancel mechanism.

use convex_backend::{
    ConvexApi, ConvexApiClient, WorkerTasksGetTaskStatusArgs, WorkerTasksGetTaskStatusReturn,
};
use futures::StreamExt;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

/// Spawn a background task that subscribes to `workerTasks.getTaskStatus`.
///
/// When the status becomes `"Cancelled"` or the task is deleted (returns `null`),
/// the provided `CancellationToken` is cancelled.
///
/// Returns a `JoinHandle` — callers should hold it to keep the watcher alive
/// and can drop it when the handler exits.
pub fn spawn_cancel_watcher(
    convex: &ConvexApiClient,
    task_id: &str,
    token: CancellationToken,
) -> JoinHandle<()> {
    let convex = convex.clone();
    let task_id = task_id.to_string();

    tokio::spawn(async move {
        let mut stream = match convex
            .subscribe_worker_tasks_get_task_status(WorkerTasksGetTaskStatusArgs {
                taskId: task_id.clone(),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                warn!(task_id = %task_id, error = %e, "cancel_watcher: subscription failed");
                return;
            }
        };

        while let Some(result) = stream.next().await {
            match result {
                Ok(Some(status)) => {
                    if matches!(status, WorkerTasksGetTaskStatusReturn::Cancelled) {
                        debug!(task_id = %task_id, "cancel_watcher: task cancelled");
                        token.cancel();
                        return;
                    }
                }
                Ok(None) => {
                    // Task deleted — treat as cancel
                    debug!(task_id = %task_id, "cancel_watcher: task deleted");
                    token.cancel();
                    return;
                }
                Err(e) => {
                    warn!(task_id = %task_id, error = %e, "cancel_watcher: subscription error");
                    // Don't cancel on transient errors — keep watching
                }
            }
        }

        // Stream ended (connection dropped?) — cancel to be safe
        debug!(task_id = %task_id, "cancel_watcher: stream ended");
        token.cancel();
    })
}
