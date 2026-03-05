use std::fmt::Display;
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::humanize::format_int;

/// View layer for step-based terminal output. All output goes to stderr.
///
/// Separates logging/timing/display concerns from algorithm code.
/// Algorithms become pure computation; the orchestration layer wraps them
/// and owns all terminal output via `StepView`.
pub struct StepView {
    interactive: bool,
    indent: usize,
}

impl StepView {
    pub fn new() -> Self {
        StepView {
            interactive: std::io::stderr().is_terminal(),
            indent: 0,
        }
    }

    /// Create a child view with one more level of indentation.
    pub fn indented(&self) -> Self {
        StepView {
            interactive: self.interactive,
            indent: self.indent + 1,
        }
    }

    pub fn is_interactive(&self) -> bool {
        self.interactive
    }

    pub fn prefix(&self) -> String {
        "  ".repeat(self.indent)
    }

    /// Print a top-level header: "=== text ==="
    pub fn header(&self, text: &str) {
        eprintln!("\n{}=== {} ===", self.prefix(), text);
    }

    /// Print a sub-section header: "--- text ---"
    pub fn section(&self, text: &str) {
        eprintln!("\n{}--- {} ---", self.prefix(), text);
    }

    /// Print an info line (no timing).
    pub fn info(&self, text: impl Display) {
        eprintln!("{}{}", self.prefix(), text);
    }

    /// Timed step (infallible). Prints "Label..." then overwrites with the
    /// result of `finish_msg`.
    pub fn run_step<T>(
        &self,
        label: &str,
        work: impl FnOnce() -> T,
        finish_msg: impl FnOnce(&T, Duration) -> String,
    ) -> T {
        self.print_start(label);
        let start = Instant::now();
        let result = work();
        let elapsed = start.elapsed();
        self.print_finish(label, &finish_msg(&result, elapsed));
        result
    }

    /// Timed step (fallible). On `Ok`, calls `finish_msg`. On `Err`, prints
    /// "Label... failed".
    pub fn try_run_step<T, E>(
        &self,
        label: &str,
        work: impl FnOnce() -> Result<T, E>,
        finish_msg: impl FnOnce(&T, Duration) -> String,
    ) -> Result<T, E> {
        self.print_start(label);
        let start = Instant::now();
        let result = work();
        let elapsed = start.elapsed();
        match &result {
            Ok(val) => self.print_finish(label, &finish_msg(val, elapsed)),
            Err(_) => self.print_finish(label, &format!("{label}... failed")),
        }
        result
    }

    /// Step with a background ticker and atomic progress counter.
    /// Displays "Label... 1,234 (5s)" updating every second.
    /// Optional `total_hint` shows "1,234 / 5,000".
    pub fn run_step_with_progress<T>(
        &self,
        label: &str,
        total_hint: Option<usize>,
        work: impl FnOnce(Arc<AtomicUsize>) -> T,
        finish_msg: impl FnOnce(&T, Duration) -> String,
    ) -> T {
        self.print_start(label);
        let start = Instant::now();
        let counter = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));

        let ticker = {
            let counter = Arc::clone(&counter);
            let stop = Arc::clone(&stop);
            let prefix = self.prefix();
            let label = label.to_string();
            let interactive = self.interactive;
            let tick_interval = if interactive {
                Duration::from_secs(1)
            } else {
                Duration::from_secs(5)
            };

            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(tick_interval);
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let count = counter.load(Ordering::Relaxed);
                    let elapsed = start.elapsed().as_secs();
                    let progress = match total_hint {
                        Some(total) => {
                            format!("{} / {}", format_int(count), format_int(total))
                        }
                        None => format_int(count),
                    };
                    if interactive {
                        let line = format!("{}{label}... {progress} ({elapsed}s)", prefix);
                        eprint!("\r{line}");
                        let _ = std::io::stderr().flush();
                    } else {
                        eprintln!("{}{label}... {progress} ({elapsed}s)", prefix);
                    }
                }
            })
        };

        let result = work(Arc::clone(&counter));
        let elapsed = start.elapsed();

        stop.store(true, Ordering::Relaxed);
        let _ = ticker.join();

        self.print_finish(label, &finish_msg(&result, elapsed));
        result
    }

    /// Step with just elapsed seconds ticking (no counter).
    pub fn run_timed_step<T>(
        &self,
        label: &str,
        work: impl FnOnce() -> T,
        finish_msg: impl FnOnce(&T, Duration) -> String,
    ) -> T {
        self.print_start(label);
        let start = Instant::now();
        let stop = Arc::new(AtomicBool::new(false));

        let ticker = {
            let stop = Arc::clone(&stop);
            let prefix = self.prefix();
            let label = label.to_string();
            let interactive = self.interactive;
            let tick_interval = if interactive {
                Duration::from_secs(1)
            } else {
                Duration::from_secs(5)
            };

            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(tick_interval);
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let elapsed = start.elapsed().as_secs();
                    if interactive {
                        let line = format!("{prefix}{label}... ({elapsed}s)");
                        eprint!("\r{line}");
                        let _ = std::io::stderr().flush();
                    } else {
                        eprintln!("{}{label}... ({elapsed}s)", prefix);
                    }
                }
            })
        };

        let result = work();
        let elapsed = start.elapsed();

        stop.store(true, Ordering::Relaxed);
        let _ = ticker.join();

        self.print_finish(label, &finish_msg(&result, elapsed));
        result
    }

    fn print_start(&self, label: &str) {
        if self.interactive {
            eprint!("{}{}...", self.prefix(), label);
            let _ = std::io::stderr().flush();
        } else {
            eprintln!("{}{}...", self.prefix(), label);
        }
    }

    fn print_finish(&self, _label: &str, message: &str) {
        if self.interactive {
            // Overwrite the start line
            let line = format!("{}{}", self.prefix(), message);
            // Pad to clear any leftover characters from progress updates
            let padding = " ".repeat(20);
            eprintln!("\r{line}{padding}");
        } else {
            eprintln!("{}{}", self.prefix(), message);
        }
    }
}

pub fn format_ms(d: Duration) -> String {
    format_int(d.as_millis())
}
