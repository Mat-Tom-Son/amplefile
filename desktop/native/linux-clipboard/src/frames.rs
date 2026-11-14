//! The helper's pipe format, shared by both directions.
//!
//! A stream starts with [`MAGIC`], then holds frames: a little-endian `u32`
//! name length, the target name (printable ASCII), a little-endian `u32` data
//! length, then the data. A zero name length ends the stream. In `read`
//! output a data length of [`ABSENT`] means the owner did not provide that
//! target, and no data follows.

use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 8] = b"AFCLIP1\n";
pub const ABSENT: u32 = u32::MAX;
pub const MAX_TARGETS: usize = 32;
pub const MAX_NAME: usize = 255;
pub const MAX_ENTRY: usize = 64 << 20;
pub const MAX_TOTAL: usize = 256 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub target: String,
    pub data: Vec<u8>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn read_u32(input: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    input.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

/// A target name the helper will intern: printable ASCII, no control bytes.
pub fn valid_target_name(name: &[u8]) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME && name.iter().all(|byte| (0x20..0x7f).contains(byte))
}

/// The targets and bytes the app asks the helper to serve. Rejects
/// duplicates, unnamed or oversized entries, and an empty list.
pub fn read_entries(input: &mut impl Read) -> io::Result<Vec<Entry>> {
    let mut magic = [0u8; 8];
    input.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(invalid("not an AmpleFile clipboard request"));
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut total = 0usize;
    loop {
        let name_length = read_u32(input)? as usize;
        if name_length == 0 {
            break;
        }
        if entries.len() == MAX_TARGETS {
            return Err(invalid("too many targets"));
        }
        if name_length > MAX_NAME {
            return Err(invalid("target name too long"));
        }
        let mut name = vec![0u8; name_length];
        input.read_exact(&mut name)?;
        if !valid_target_name(&name) {
            return Err(invalid("target name is not printable ASCII"));
        }
        let target = String::from_utf8(name).map_err(|_| invalid("target name is not ASCII"))?;
        if entries.iter().any(|entry| entry.target == target) {
            return Err(invalid("duplicate target"));
        }
        let data_length = read_u32(input)? as usize;
        if data_length > MAX_ENTRY {
            return Err(invalid("target data too large"));
        }
        total += data_length;
        if total > MAX_TOTAL {
            return Err(invalid("clipboard request too large"));
        }
        let mut data = vec![0u8; data_length];
        input.read_exact(&mut data)?;
        entries.push(Entry { target, data });
    }
    if entries.is_empty() {
        return Err(invalid("nothing to put on the clipboard"));
    }
    Ok(entries)
}

/// Writes `read` results: each requested target with its bytes, or [`ABSENT`].
pub fn write_results(output: &mut impl Write, results: &[(String, Option<Vec<u8>>)]) -> io::Result<()> {
    output.write_all(MAGIC)?;
    for (target, data) in results {
        output.write_all(&(target.len() as u32).to_le_bytes())?;
        output.write_all(target.as_bytes())?;
        match data {
            Some(data) => {
                output.write_all(&(data.len() as u32).to_le_bytes())?;
                output.write_all(data)?;
            }
            None => output.write_all(&ABSENT.to_le_bytes())?,
        }
    }
    output.write_all(&0u32.to_le_bytes())?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        for (name, data) in entries {
            bytes.extend((name.len() as u32).to_le_bytes());
            bytes.extend(name.as_bytes());
            bytes.extend((data.len() as u32).to_le_bytes());
            bytes.extend(*data);
        }
        bytes.extend(0u32.to_le_bytes());
        bytes
    }

    #[test]
    fn reads_targets_in_order() {
        let bytes = request(&[("x-special/gnome-copied-files", b"copy\nfile:///a"), ("UTF8_STRING", "/a é".as_bytes()), ("STRING", b"")]);
        let entries = read_entries(&mut bytes.as_slice()).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].target, "x-special/gnome-copied-files");
        assert_eq!(entries[1].data, "/a é".as_bytes());
        assert!(entries[2].data.is_empty());
    }

    #[test]
    fn stops_at_the_terminator_and_leaves_the_rest_of_the_pipe() {
        let mut bytes = request(&[("text/uri-list", b"file:///a\r\n")]);
        bytes.extend(b"trailing");
        let mut input = bytes.as_slice();
        read_entries(&mut input).unwrap();
        assert_eq!(input, b"trailing");
    }

    #[test]
    fn rejects_bad_requests() {
        assert!(read_entries(&mut b"AFCLIP0\n\0\0\0\0".as_slice()).is_err());
        assert!(read_entries(&mut request(&[]).as_slice()).is_err());
        assert!(read_entries(&mut request(&[("a", b"1"), ("a", b"2")]).as_slice()).is_err());
        assert!(read_entries(&mut request(&[("bad\nname", b"1")]).as_slice()).is_err());
        let mut truncated = request(&[("text/plain", b"abc")]);
        truncated.truncate(truncated.len() - 6);
        assert!(read_entries(&mut truncated.as_slice()).is_err());
        let mut oversized = MAGIC.to_vec();
        oversized.extend(4u32.to_le_bytes());
        oversized.extend(b"TEXT");
        oversized.extend(((MAX_ENTRY + 1) as u32).to_le_bytes());
        assert!(read_entries(&mut oversized.as_slice()).is_err());
        let many: Vec<(String, &[u8])> = (0..=MAX_TARGETS).map(|index| (format!("t{index}"), b"" as &[u8])).collect();
        let many: Vec<(&str, &[u8])> = many.iter().map(|(name, data)| (name.as_str(), *data)).collect();
        assert!(read_entries(&mut request(&many).as_slice()).is_err());
    }

    #[test]
    fn writes_present_and_absent_results() {
        let mut output = Vec::new();
        write_results(&mut output, &[("TARGETS".into(), Some(b"a\nb".to_vec())), ("text/uri-list".into(), None)]).unwrap();
        let mut expected = MAGIC.to_vec();
        expected.extend(7u32.to_le_bytes());
        expected.extend(b"TARGETS");
        expected.extend(3u32.to_le_bytes());
        expected.extend(b"a\nb");
        expected.extend(13u32.to_le_bytes());
        expected.extend(b"text/uri-list");
        expected.extend(ABSENT.to_le_bytes());
        expected.extend(0u32.to_le_bytes());
        assert_eq!(output, expected);
    }
}
