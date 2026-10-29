// Copyright 2020 - developers of the `grammers` project.
// Copyright 2021 - developers of the `tdlib-rs` project.
// Copyright 2024 - developers of the `tgt` and `tdlib-rs` projects.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// https://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or https://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.
pub mod build;
mod generated;
mod observer;
mod tdjson;

pub use generated::{enums, functions, types};

/// Send a JSON request and wait for the matching `@extra` response.
///
/// crm-chat uses this for the small set of methods both shells share, so a
/// regenerated TL file does not have to change every call site.
pub async fn send_json(client_id: i32, request: Value) -> Value {
    send_request(client_id, request).await
}

use enums::Update;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::sync::atomic::{AtomicU32, Ordering};

static EXTRA_COUNTER: AtomicU32 = AtomicU32::new(0);
static OBSERVER: Lazy<observer::Observer> = Lazy::new(observer::Observer::new);

/// Create a TdLib client returning its id. Note that to start receiving
/// updates for a client you need to send at least a request with it first.
pub fn create_client() -> i32 {
    tdjson::create_client()
}

/// Synchronously executes a TDLib request documented as "Can be called synchronously".
///
/// Copies the response before returning. TDLib frees that buffer on the next
/// [`receive`] or `execute`, so call this before [`receive`] is running.
pub fn execute(request: &str) -> Option<String> {
    tdjson::execute(request)
}

/// Receive a single update or response from TdLib. If it's an update, it
/// returns a tuple with the `Update` and the associated `client_id`.
/// Note that to start receiving updates for a client you need to send
/// at least a request with it first.
pub fn receive() -> Option<(Update, i32)> {
    tdjson::receive(2.0).as_deref().and_then(decode_incoming)
}

/// Decodes one TDLib JSON payload.
///
/// A request response (`@extra`) is delivered to its waiter and yields `None`.
/// Malformed JSON, a missing client id, and an unknown update also yield `None`.
/// Nothing from the payload is written to the log.
pub fn decode_incoming(response_str: &str) -> Option<(Update, i32)> {
    let response: Value = match serde_json::from_str(response_str) {
        Ok(value) => value,
        Err(_) => {
            log::warn!("dropped a TDLib payload that was not JSON");
            return None;
        }
    };
    if response.get("@extra").is_some() {
        OBSERVER.notify(response);
        return None;
    }
    let Some(client_id) = response
        .get("@client_id")
        .and_then(Value::as_i64)
        .and_then(|client_id| i32::try_from(client_id).ok())
    else {
        log::warn!("dropped a TDLib update without a client id");
        return None;
    };
    match serde_json::from_value(response) {
        Ok(update) => Some((update, client_id)),
        Err(_) => {
            log::warn!("dropped a TDLib update that could not be decoded");
            None
        }
    }
}

pub(crate) async fn send_request(client_id: i32, mut request: Value) -> Value {
    let extra = EXTRA_COUNTER.fetch_add(1, Ordering::Relaxed);
    request["@extra"] = serde_json::to_value(extra).unwrap();

    let receiver = OBSERVER.subscribe(extra);
    tdjson::send(client_id, request.to_string());

    receiver.await.unwrap()
}
