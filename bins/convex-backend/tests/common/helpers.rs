/// Assert that a typed mutation returned an error containing the expected substring.
pub fn assert_mutation_error<T: std::fmt::Debug, E: std::fmt::Display>(
    result: Result<T, E>,
    expected_substring: &str,
) {
    match result {
        Ok(val) => panic!("Expected error but got success: {val:?}"),
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
