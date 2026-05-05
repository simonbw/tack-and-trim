use std::path::Path;

fn build_to_bytes(level_path: &str) -> Vec<u8> {
    let tmp = tempfile::NamedTempFile::new().expect("failed to create temp file");
    let output_path = tmp.path().to_str().unwrap().to_string();
    mesh_builder::build_wavemesh_for_level(level_path, Some(&output_path))
        .expect("build failed");
    std::fs::read(&output_path).expect("failed to read output")
}

fn find_level_path() -> String {
    // Try relative path from workspace root (cargo test runs from package dir).
    let candidates = [
        "../../resources/levels/default.level.json",
        "resources/levels/default.level.json",
    ];
    for c in &candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    panic!(
        "Could not find default.level.json. Searched: {:?}",
        candidates
    );
}

#[test]
fn deterministic_single_thread() {
    std::env::set_var("WAVEMESH_THREADS", "1");
    let level = find_level_path();
    let a = build_to_bytes(&level);
    let b = build_to_bytes(&level);
    assert_eq!(a.len(), b.len(), "output lengths differ");
    assert!(a == b, "outputs differ (single-threaded)");
}

#[test]
fn deterministic_multi_thread() {
    // Don't set WAVEMESH_THREADS — use default thread count.
    // Note: rayon's global pool can only be initialized once per process,
    // so this test may use whatever thread count was set by an earlier test.
    let level = find_level_path();
    let a = build_to_bytes(&level);
    let b = build_to_bytes(&level);
    assert_eq!(a.len(), b.len(), "output lengths differ");
    assert!(a == b, "outputs differ (multi-threaded)");
}
