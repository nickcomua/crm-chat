use convex::{FunctionResult, Value};
use serde::Deserialize;

/// Convert a `convex::Value` to `serde_json::Value` for deserialization.
fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Int64(n) => serde_json::json!(*n),
        Value::Float64(f) => serde_json::json!(*f),
        Value::Boolean(b) => serde_json::json!(*b),
        Value::String(s) => serde_json::Value::String(s.clone()),
        Value::Array(arr) => serde_json::Value::Array(arr.iter().map(value_to_json).collect()),
        Value::Object(obj) => {
            let map: serde_json::Map<String, serde_json::Value> =
                obj.iter().map(|(k, v)| (k.clone(), value_to_json(v))).collect();
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::Null,
    }
}

/// Parse a `FunctionResult` containing an array of documents into typed structs.
pub fn parse_docs<T: for<'de> Deserialize<'de>>(result: &FunctionResult) -> Vec<T> {
    match result {
        FunctionResult::Value(Value::Array(items)) => items
            .iter()
            .filter_map(|item| serde_json::from_value(value_to_json(item)).ok())
            .collect(),
        _ => vec![],
    }
}

/// Assert that a mutation returned successfully (no error).
pub fn assert_mutation_success(result: anyhow::Result<FunctionResult>) {
    match result {
        Ok(FunctionResult::Value(_)) => {}
        Ok(FunctionResult::ErrorMessage(msg)) => panic!("Mutation returned error: {msg}"),
        Ok(FunctionResult::ConvexError(err)) => {
            panic!("Mutation returned ConvexError: {}", err.message)
        }
        Err(e) => panic!("Mutation call failed: {e}"),
    }
}

/// Assert that a mutation returned an error containing the expected substring.
pub fn assert_mutation_error(result: anyhow::Result<FunctionResult>, expected_substring: &str) {
    match result {
        Ok(FunctionResult::Value(v)) => {
            panic!("Expected error but got success: {v:?}")
        }
        Ok(FunctionResult::ErrorMessage(msg)) => {
            if !expected_substring.is_empty() {
                assert!(
                    msg.contains(expected_substring),
                    "Error '{msg}' does not contain '{expected_substring}'"
                );
            }
        }
        Ok(FunctionResult::ConvexError(err)) => {
            if !expected_substring.is_empty() {
                assert!(
                    err.message.contains(expected_substring),
                    "ConvexError '{}' does not contain '{expected_substring}'",
                    err.message
                );
            }
        }
        Err(e) => {
            if !expected_substring.is_empty() {
                let msg = e.to_string();
                assert!(
                    msg.contains(expected_substring),
                    "Error '{msg}' does not contain '{expected_substring}'"
                );
            }
        }
    }
}
