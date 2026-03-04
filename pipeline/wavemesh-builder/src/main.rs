use anyhow::Result;
use clap::Parser;

/// CLI for the wavemesh-builder binary.
#[derive(Parser)]
#[command(name = "wavemesh-builder")]
struct Cli {
    /// Level JSON file path (repeatable; default: all levels in resources/levels/)
    #[arg(short, long)]
    level: Vec<String>,

    /// Output .wavemesh path (only valid with single --level)
    #[arg(short, long)]
    output: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    wavemesh_builder::run(cli.level, cli.output)
}
