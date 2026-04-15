//! Per-job runner: consume the job's subscription stream and manage per-entity
//! tokio tasks. One of these runs per `Job` for the lifetime of the worker.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures::StreamExt;
use tokio::task::JoinHandle;
use tracing::{Instrument, info, info_span, warn};

use crate::job::{Job, JobCtx};

/// Run a single job forever. Owns the per-entity tokio handles and diffs the
/// subscription stream to add/cancel tasks.
pub async fn run_job(job: Arc<dyn Job>, ctx: Arc<JobCtx>) {
    let name = job.name();
    let root = info_span!("job", name = name);
    let _g = root.enter();

    info!("subscribing");
    let mut stream = match job.subscribe(&ctx).await {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "subscribe failed — job will not run");
            return;
        }
    };

    let mut tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

    while let Some(current) = stream.next().await {
        let wanted: HashSet<String> = current.into_iter().collect();

        // Drop tasks whose entity left the set (terminal state reached or deleted).
        tasks.retain(|key, handle| {
            if !wanted.contains(key) {
                if !handle.is_finished() {
                    handle.abort();
                    info!(key = %key, "entity left set — aborting task");
                } else {
                    info!(key = %key, "entity left set — task already done");
                }
                false
            } else if handle.is_finished() {
                // Task finished but entity still in set — free the slot so the
                // next tick can re-spawn if it's still really pending.
                false
            } else {
                true
            }
        });

        // Spawn for new entities.
        for key in wanted {
            if tasks.contains_key(&key) {
                continue;
            }
            let job = job.clone();
            let ctx = ctx.clone();
            let key_for_task = key.clone();
            let task_span = info_span!("task", job = name, key = %key_for_task);
            let handle = tokio::spawn(
                async move {
                    info!("starting");
                    match job.run_one(ctx, key_for_task).await {
                        Ok(()) => info!("done"),
                        Err(e) => warn!(error = %e, "failed"),
                    }
                }
                .instrument(task_span),
            );
            tasks.insert(key, handle);
        }
    }

    warn!("subscription stream ended — job exiting");
}
