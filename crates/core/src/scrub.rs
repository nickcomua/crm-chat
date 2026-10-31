use crate::schema::is_secret_field;

/// Adapter JSON, without a JSON crate. Shells convert their payload into this
/// and persist only [`LoginRecord`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    List(Vec<Payload>),
    Map(Vec<(String, Payload)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginRecord {
    pub account_id: String,
    pub label: String,
    pub observed_name: String,
}

pub fn scrub_payload(payload: &Payload) -> Payload {
    let secrets = secret_values(payload);
    strip(payload, &secrets)
}

/// What a login may write. Secret keys are dropped, and any value that arrived
/// under a secret key is removed even if it is copied onto another field.
pub fn login_record(account_id: &str, label: &str, payload: &Payload) -> LoginRecord {
    let secrets = secret_values(payload);
    let scrubbed = strip(payload, &secrets);
    LoginRecord {
        account_id: blank_if_secret(account_id, &secrets),
        label: blank_if_secret(label, &secrets),
        observed_name: observed_name(&scrubbed),
    }
}

/// Payload a shell may build after login. It has no secret inputs.
pub fn safe_login_payload(account_id: &str, label: &str) -> Payload {
    Payload::Map(vec![
        (
            "account_id".to_owned(),
            Payload::Text(account_id.to_owned()),
        ),
        ("label".to_owned(), Payload::Text(label.to_owned())),
    ])
}

fn secret_values(payload: &Payload) -> Vec<String> {
    let mut values = Vec::new();
    collect_secret_values(payload, &mut values);
    values
}

fn collect_secret_values(payload: &Payload, values: &mut Vec<String>) {
    let Payload::Map(entries) = payload else {
        if let Payload::List(items) = payload {
            for item in items {
                collect_secret_values(item, values);
            }
        }
        return;
    };
    for (key, value) in entries {
        if is_secret_field(key) {
            collect_text(value, values);
        }
        collect_secret_values(value, values);
    }
}

fn collect_text(payload: &Payload, values: &mut Vec<String>) {
    match payload {
        Payload::Text(text) => {
            if !text.is_empty() {
                values.push(text.clone());
            }
        }
        Payload::List(items) => {
            for item in items {
                collect_text(item, values);
            }
        }
        Payload::Map(entries) => {
            for (_, value) in entries {
                collect_text(value, values);
            }
        }
    }
}

fn strip(payload: &Payload, secrets: &[String]) -> Payload {
    match payload {
        Payload::Text(text) => Payload::Text(blank_if_secret(text, secrets)),
        Payload::List(items) => {
            Payload::List(items.iter().map(|item| strip(item, secrets)).collect())
        }
        Payload::Map(entries) => Payload::Map(
            entries
                .iter()
                .filter(|(key, _)| !is_secret_field(key))
                .map(|(key, value)| (key.clone(), strip(value, secrets)))
                .collect(),
        ),
    }
}

fn blank_if_secret(text: &str, secrets: &[String]) -> String {
    if text.is_empty() || secrets.iter().any(|secret| secret == text) {
        String::new()
    } else {
        text.to_owned()
    }
}

fn observed_name(payload: &Payload) -> String {
    for key in ["display_name", "name", "title", "first_name"] {
        if let Some(value) = field_text(payload, key) {
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn field_text(payload: &Payload, key: &str) -> Option<String> {
    let Payload::Map(entries) = payload else {
        return None;
    };
    entries.iter().find_map(|(candidate, value)| {
        if candidate == key {
            text_of(value)
        } else {
            None
        }
    })
}

fn text_of(payload: &Payload) -> Option<String> {
    match payload {
        Payload::Text(text) => Some(text.clone()),
        Payload::List(_) | Payload::Map(_) => None,
    }
}
