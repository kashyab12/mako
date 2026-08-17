//! Subsequence matching, ported from the web build so both front ends rank
//! the same query the same way.
//!
//! Tuned for short identifier-ish strings — session titles, model names, file
//! paths. The shape that matters: a contiguous hit always outranks a scattered
//! one, and a hit that starts at a word boundary outranks one that starts
//! mid-word. Without those two rules a subsequence matcher happily puts
//! "s-e-s-s-i-o-n" spread across a paragraph above the session actually called
//! "session".

/// Score `needle` against `haystack`, or `None` when it does not match at all.
pub fn score(needle: &str, haystack: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let query: Vec<char> = needle.to_lowercase().chars().collect();
    let target: Vec<char> = haystack.to_lowercase().chars().collect();

    // Fast path: a contiguous run beats anything scattered, so it is worth
    // looking for one before walking character by character.
    if let Some(at) = contains_at(&target, &query) {
        let boundary = at == 0 || !target[at - 1].is_alphanumeric();
        return Some(1000 - at as i32 + if boundary { 220 } else { 0 });
    }

    let mut total = 0i32;
    let mut cursor = 0usize;
    let mut streak = 0i32;
    for wanted in query {
        let at = target[cursor..].iter().position(|c| *c == wanted)? + cursor;
        let boundary = at == 0 || !target[at - 1].is_alphanumeric();
        // A run of adjacent matches compounds: "gpui" hitting four consecutive
        // characters should not score the same as four scattered ones.
        streak = if at == cursor { streak + 1 } else { 0 };
        total += 12 + streak * 8 + if boundary { 26 } else { 0 }
            - (at - cursor).min(12) as i32;
        cursor = at + 1;
    }
    Some(total)
}

/// Index of the first contiguous occurrence of `needle` in `target`.
fn contains_at(target: &[char], needle: &[char]) -> Option<usize> {
    if needle.len() > target.len() {
        return None;
    }
    (0..=target.len() - needle.len()).find(|&start| target[start..start + needle.len()] == *needle)
}
