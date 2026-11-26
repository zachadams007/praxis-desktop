//! Shared ISO-8601 → Unix-ms parser (no chrono dependency).
//!
//! Handles the shapes our usage sources actually return:
//!   - Cursor:  `2026-10-02T15:00:15.000Z`
//!   - Claude:  `2026-09-15T00:20:00.713377+00:00`
//!
//! Fractional seconds may be 1–9 digits; offsets may be `Z`, `+HH:MM`, or `-HH:MM`.
//! Any malformed input returns `None` - never a wrong time.

/// Parse an ISO-8601 timestamp into Unix milliseconds.
pub fn parse_iso8601_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    let (datetime, offset_secs) = split_offset(s)?;
    let (date, time) = datetime.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > 31 {
        return None;
    }

    let (time, frac_ms) = match time.split_once('.') {
        Some((t, f)) => {
            // Take first 3 digit-chars as milliseconds (pad/truncate).
            let digits: String = f.chars().filter(|c| c.is_ascii_digit()).take(3).collect();
            let padded = format!("{digits:0<3}");
            (t, padded.parse::<i64>().unwrap_or(0))
        }
        None => (time, 0),
    };
    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: i64 = t.next()?.parse().ok()?;
    if hour > 23 || min > 59 || sec > 60 {
        return None;
    }

    // Days since epoch via Howard Hinnant's civil-from-days algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146097 + doe - 719468;

    let secs = days_since_epoch * 86400 + hour * 3600 + min * 60 + sec - offset_secs;
    if secs < 0 {
        return None;
    }
    Some((secs as u64) * 1000 + frac_ms as u64)
}

/// Split trailing `Z` / `+HH:MM` / `-HH:MM` from the datetime body.
/// Returns (datetime_without_offset, offset_east_of_utc_in_seconds).
fn split_offset(s: &str) -> Option<(&str, i64)> {
    if let Some(body) = s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        return Some((body, 0));
    }
    // Find the last + or - that starts a timezone offset (after the T… time part).
    let bytes = s.as_bytes();
    let t_pos = s.find('T')?;
    let mut i = s.len();
    while i > t_pos + 1 {
        i -= 1;
        if bytes[i] == b'+' || bytes[i] == b'-' {
            let sign: i64 = if bytes[i] == b'+' { 1 } else { -1 };
            let off = &s[i + 1..];
            let (hh, mm) = if let Some((h, m)) = off.split_once(':') {
                (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
            } else if off.len() == 4 {
                (off[..2].parse().ok()?, off[2..].parse().ok()?)
            } else {
                return None;
            };
            if hh > 23 || mm > 59 {
                return None;
            }
            return Some((&s[..i], sign * (hh * 3600 + mm * 60)));
        }
    }
    // No offset → treat as UTC (Cursor sometimes omits Z in tests).
    Some((s, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cursor_zulu() {
        assert_eq!(
            parse_iso8601_ms("2026-10-02T15:00:15.000Z"),
            Some(1_790_953_215_000)
        );
    }

    #[test]
    fn parses_claude_offset_with_6_digit_frac() {
        // 2026-09-15T00:20:00.713377+00:00 → same instant as …Z
        let ms = parse_iso8601_ms("2026-09-15T00:20:00.713377+00:00").unwrap();
        let z = parse_iso8601_ms("2026-09-15T00:20:00.713Z").unwrap();
        assert_eq!(ms, z);
        assert_eq!(ms, 1_789_431_600_713);
    }

    #[test]
    fn parses_negative_offset() {
        // 12:00-05:00 == 17:00Z
        let east = parse_iso8601_ms("2026-01-01T17:00:00.000Z").unwrap();
        let west = parse_iso8601_ms("2026-01-01T12:00:00.000-05:00").unwrap();
        assert_eq!(east, west);
    }

    #[test]
    fn rejects_junk() {
        assert_eq!(parse_iso8601_ms("not-a-timestamp"), None);
        assert_eq!(parse_iso8601_ms("2026-13-05T20:43:09.235Z"), None);
    }
}
