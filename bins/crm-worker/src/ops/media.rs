//! Media download & upload pipeline.
//!
//! Stream-downloads from Telegram and pipes directly to Convex storage upload.
//! The file never sits fully in memory -- chunks stream from the Telegram
//! download receiver directly into the reqwest upload body.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use convex_backend::{ConvexApi, ConvexApiClient, WorkerOpsStoreMediaArgs};
use futures::StreamExt;
use messanger_interface::media::MediaSummary;
use messanger_telegram::TelegramClient;
use tracing::info;

use crate::error::WorkerError;
use crate::ops::convex::{self as cx};
use crate::ops::telegram::default_mime_for_kind;

/// Download and upload media for a single message (used in real-time updates).
pub async fn download_and_upload_media(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    chat_external_id: &str,
    msg_external_id: &str,
    media_external_id: &str,
    summary: &MediaSummary,
    task_id: &str,
) -> Result<(), WorkerError> {
    let msg_id: i32 = msg_external_id.parse().map_err(|_| {
        WorkerError::MutationFailed(format!("Invalid message ID: {msg_external_id}"))
    })?;

    let content_type = summary
        .mime_type
        .as_deref()
        .unwrap_or_else(|| default_mime_for_kind(summary.kind));

    download_and_upload(
        convex,
        tg_client,
        chat_external_id,
        msg_id,
        media_external_id,
        content_type,
        summary.mime_type.as_deref(),
        summary.file_name.as_deref(),
        summary.width.map(|w| w as f64),
        summary.height.map(|h| h as f64),
        summary.duration,
        summary.file_size,
        task_id,
    )
    .await
}

/// Stream-download from Telegram and pipe directly to Convex storage upload.
///
/// Progress is reported to Convex every ~2 seconds.
#[allow(clippy::too_many_arguments)]
pub async fn download_and_upload(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    chat_external_id: &str,
    msg_id: i32,
    external_id: &str,
    content_type: &str,
    mime_type: Option<&str>,
    file_name: Option<&str>,
    width: Option<f64>,
    height: Option<f64>,
    duration: Option<f64>,
    known_file_size: Option<usize>,
    task_id: &str,
) -> Result<(), WorkerError> {
    // Step 0: Transition to "downloading" status
    cx::start_download(convex, task_id, external_id).await;

    // Step 1: Get a presigned upload URL
    let upload_url = convex
        .media_generate_upload_url()
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    // Step 2: Start the streaming download
    let media_stream = tg_client
        .stream_message_media(chat_external_id, msg_id)
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to download from Telegram: {e}")))?
        .ok_or_else(|| WorkerError::MutationFailed("No media in Telegram message".to_string()))?;

    let file_size = media_stream.file_size.or(known_file_size);

    // Wrap the chunk receiver into a streaming body with byte counter
    let bytes_counter = Arc::new(AtomicUsize::new(0));
    let counter_for_stream = bytes_counter.clone();
    let stream =
        tokio_stream::wrappers::ReceiverStream::new(media_stream.chunks).map(move |chunk| {
            if let Ok(ref data) = chunk {
                counter_for_stream.fetch_add(data.len(), Ordering::Relaxed);
            }
            chunk
        });
    let body = reqwest::Body::wrap_stream(stream);

    // Progress reporter
    let progress_convex = convex.clone();
    let progress_task_id = task_id.to_string();
    let progress_ext_id = external_id.to_string();
    let progress_bytes = bytes_counter.clone();
    let progress_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.tick().await;
        loop {
            interval.tick().await;
            let current = progress_bytes.load(Ordering::Relaxed);
            cx::update_download_progress(
                &progress_convex,
                &progress_task_id,
                &progress_ext_id,
                current as f64,
                file_size.map(|s| s as f64),
            )
            .await;
        }
    });

    // Step 3: Upload to Convex storage
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Failed to upload to Convex storage: {e}"))
        })?;

    // Step 4: Wait for download to complete
    let total_bytes = media_stream
        .download_handle
        .await
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Download task panicked: {e}"))
        })?
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Failed to download from Telegram: {e}"))
        })?;

    progress_handle.abort();

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(WorkerError::MutationFailed(format!(
            "Convex storage upload failed (HTTP {status}): {body}"
        )));
    }

    let upload_result: serde_json::Value = response.json().await.map_err(|e| {
        WorkerError::MutationFailed(format!("Failed to parse upload response: {e}"))
    })?;

    let storage_id = upload_result["storageId"].as_str().ok_or_else(|| {
        WorkerError::MutationFailed("Missing storageId in upload response".to_string())
    })?;

    // Step 5: Store the media record
    let final_size = file_size.unwrap_or(total_bytes);
    convex
        .worker_ops_store_media(WorkerOpsStoreMediaArgs {
            taskId: task_id.to_string(),
            telegramFileId: external_id.to_string(),
            storageId: storage_id.to_string(),
            mimeType: mime_type.map(String::from),
            fileName: file_name.map(String::from),
            fileSize: Some(final_size as f64),
            width,
            height,
            duration,
        })
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    info!(
        external_id,
        storage_id,
        total_bytes,
        ?file_size,
        content_type,
        "Media streamed to Convex storage"
    );
    Ok(())
}
