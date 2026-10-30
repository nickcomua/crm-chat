//! Packed grammers `SqliteSession` files, stored as base64.
//!
//! The blob is the database file and, when libsql left a WAL beside it, that
//! WAL too. It is not a GramJS string session. Nothing here prints the bytes.

use std::fmt::Write as _;

const MAGIC: &[u8] = b"crmchat-grammers-sqlite-v1\n";
const MAX_PART: usize = 1_500_000;

pub fn pack(database: &[u8], wal: &[u8]) -> Result<String, String> {
    if database.len() > MAX_PART || wal.len() > MAX_PART {
        return Err("session file is too large".to_string());
    }
    if !database.starts_with(b"SQLite format 3\0") {
        return Err("session file is not a sqlite database".to_string());
    }
    let mut raw = Vec::with_capacity(MAGIC.len() + 8 + database.len() + wal.len());
    raw.extend_from_slice(MAGIC);
    raw.extend_from_slice(&u32::try_from(database.len()).unwrap().to_be_bytes());
    raw.extend_from_slice(database);
    raw.extend_from_slice(&u32::try_from(wal.len()).unwrap().to_be_bytes());
    raw.extend_from_slice(wal);
    Ok(encode(&raw))
}

pub fn unpack(encoded: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    if encoded.is_empty()
        || encoded.len() > MAX_PART * 2
        || encoded.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err("session is not a grammers sqlite session".to_string());
    }
    let raw = decode(encoded)?;
    let rest = raw
        .strip_prefix(MAGIC)
        .ok_or_else(|| "session is not a grammers sqlite session".to_string())?;
    let (database_len, rest) = read_len(rest)?;
    if database_len > MAX_PART || rest.len() < database_len {
        return Err("session is not a grammers sqlite session".to_string());
    }
    let (database, rest) = rest.split_at(database_len);
    let (wal_len, rest) = read_len(rest)?;
    if wal_len > MAX_PART || rest.len() != wal_len {
        return Err("session is not a grammers sqlite session".to_string());
    }
    if !database.starts_with(b"SQLite format 3\0") {
        return Err("session is not a grammers sqlite session".to_string());
    }
    Ok((database.to_vec(), rest.to_vec()))
}

fn read_len(bytes: &[u8]) -> Result<(usize, &[u8]), String> {
    let len_bytes: [u8; 4] = bytes
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "session is not a grammers sqlite session".to_string())?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    Ok((len, &bytes[4..]))
}

fn encode(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= input.len() {
        let value = ((input[index] as u32) << 16)
            | ((input[index + 1] as u32) << 8)
            | input[index + 2] as u32;
        push_quartet(&mut out, TABLE, value);
        index += 3;
    }
    match input.len() - index {
        0 => {}
        1 => {
            let value = (input[index] as u32) << 16;
            let _ = write!(
                out,
                "{}{}==",
                TABLE[((value >> 18) & 63) as usize] as char,
                TABLE[((value >> 12) & 63) as usize] as char
            );
        }
        _ => {
            let value = ((input[index] as u32) << 16) | ((input[index + 1] as u32) << 8);
            let _ = write!(
                out,
                "{}{}{}=",
                TABLE[((value >> 18) & 63) as usize] as char,
                TABLE[((value >> 12) & 63) as usize] as char,
                TABLE[((value >> 6) & 63) as usize] as char
            );
        }
    }
    out
}

fn push_quartet(out: &mut String, table: &[u8], value: u32) {
    let _ = write!(
        out,
        "{}{}{}{}",
        table[((value >> 18) & 63) as usize] as char,
        table[((value >> 12) & 63) as usize] as char,
        table[((value >> 6) & 63) as usize] as char,
        table[(value & 63) as usize] as char
    );
}

fn decode(input: &str) -> Result<Vec<u8>, String> {
    if input.len() % 4 != 0 {
        return Err("session is not a grammers sqlite session".to_string());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut index = 0;
    while index < bytes.len() {
        let chunk = &bytes[index..index + 4];
        let pad = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if pad > 2 || chunk[..4 - pad].contains(&b'=') {
            return Err("session is not a grammers sqlite session".to_string());
        }
        let mut value = 0u32;
        for (shift, byte) in chunk.iter().enumerate() {
            let sextet = if *byte == b'=' {
                0
            } else {
                sextet(*byte)
                    .ok_or_else(|| "session is not a grammers sqlite session".to_string())?
            };
            value |= sextet << (18 - shift * 6);
        }
        out.push((value >> 16) as u8);
        if pad < 2 {
            out.push((value >> 8) as u8);
        }
        if pad < 1 {
            out.push(value as u8);
        }
        index += 4;
    }
    Ok(out)
}

fn sextet(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some((byte - b'A') as u32),
        b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
        b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"hello"), "aGVsbG8=");
        assert_eq!(decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode("Zg==").unwrap(), b"f");
    }

    #[test]
    fn round_trip_and_rejects_without_echoing_input() {
        let mut database = b"SQLite format 3\0".to_vec();
        database.extend(std::iter::repeat(0x7u8).take(64));
        let wal = vec![1, 2, 3, 4];
        let encoded = pack(&database, &wal).unwrap();
        assert!(!encoded.chars().any(char::is_whitespace));
        assert_eq!(unpack(&encoded).unwrap(), (database, wal));

        let junk = "not-a-session-and-not-echoed";
        let error = unpack(junk).unwrap_err();
        assert!(!error.contains(junk));
        assert!(!error.contains("echoed"));
    }
}
