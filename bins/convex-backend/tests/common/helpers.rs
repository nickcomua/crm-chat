/// Assert that a typed mutation returned successfully.
pub fn assert_mutation_success(result: anyhow::Result<()>) {
    if let Err(e) = result {
        panic!("Mutation call failed: {e}");
    }
}

/// Assert that a typed mutation returned an error containing the expected substring.
pub fn assert_mutation_error(result: anyhow::Result<()>, expected_substring: &str) {
    match result {
        Ok(()) => panic!("Expected error but got success"),
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
