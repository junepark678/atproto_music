use atmusic_atproto::http::safe_client::SafeClient;
use atmusic_server::config::{Config, ServeArgs};
use atmusic_storage::Database;
use clap::{Parser, Subcommand};
use std::{path::PathBuf, process::ExitCode};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "atmusic", version, about = "AT Protocol music application")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Migrate local storage and start the HTTP application.
    Serve(Box<ServeArgs>),
    /// Apply embedded database migrations without starting HTTP.
    Migrate {
        #[arg(
            long,
            env = "ATMUSIC_DATABASE_PATH",
            default_value = "data/music.sqlite"
        )]
        database_path: PathBuf,
    },
    /// Create and verify a consistent online SQLite snapshot without overwriting a file.
    Backup {
        #[arg(
            long,
            env = "ATMUSIC_DATABASE_PATH",
            default_value = "data/music.sqlite"
        )]
        database_path: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Restore a verified backup into a new directory; retain the encryption key separately.
    Restore {
        #[arg(long)]
        backup_path: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
}
#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
async fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Backup {
            database_path,
            output,
        } => {
            let report = atmusic_storage::backup::snapshot(database_path, output)
                .await
                .map_err(|_| "backup: snapshot creation or verification failed".to_owned())?;
            tracing::info!(
                schema_version = report.schema_version,
                bytes = report.bytes,
                "backup verified"
            );
        }
        Command::Restore {
            backup_path,
            destination,
        } => {
            atmusic_storage::backup::restore(backup_path, destination)
                .await
                .map_err(|_| {
                    "restore: backup validation or destination creation failed".to_owned()
                })?;
            tracing::info!("backup restored into new directory");
        }
        Command::Migrate { database_path } => {
            let database = Database::open(database_path)
                .await
                .map_err(|_| "database_path: migration failed".to_owned())?;
            tracing::info!(
                schema_version = database
                    .schema_version()
                    .await
                    .map_err(|_| "database_path: schema inspection failed".to_owned())?,
                "migrations complete"
            );
            database.close().await;
        }
        Command::Serve(args) => {
            let config = Config::try_from(*args).map_err(|error| error.to_string())?;
            let database = Database::open(&config.database_path)
                .await
                .map_err(|_| "database_path: database initialization failed".to_owned())?;
            let listener = TcpListener::bind(config.bind)
                .await
                .map_err(|_| "bind: unable to bind HTTP listener".to_owned())?;
            tracing::info!(address = %listener.local_addr().map_err(|_| "bind: unable to inspect listener".to_owned())?, "listening");
            let metrics_listener = TcpListener::bind(config.metrics_bind)
                .await
                .map_err(|_| "metrics_bind: unable to bind metrics listener".to_owned())?;
            tracing::info!(metrics_bind = %metrics_listener.local_addr().map_err(|_| "metrics_bind: unable to inspect listener".to_owned())?, "metrics listener initialized");
            let client = SafeClient::production()
                .map_err(|_| "outbound: safe HTTP client initialization failed".to_owned())?;
            let initialized = atmusic_server::startup::initialize(config, database.clone(), client)
                .await
                .map_err(str::to_owned)?;
            let state = initialized.state;
            tracing::info!(
                publication_enabled = state.outbox.is_some(),
                relay_enabled = false,
                "worker initialization complete"
            );
            let report = atmusic_server::shutdown::serve_application_until(
                vec![
                    (listener, atmusic_server::router_with_state(state.clone())),
                    (metrics_listener, atmusic_server::metrics::router(state)),
                ],
                database.writer(),
                initialized.runtime,
                atmusic_server::shutdown::signal(),
            )
            .await
            .map_err(|_| "server: HTTP listener failed".to_owned())?;
            if report.timed_out
                || report.workers.task_failed > 0
                || !report.workers.cleanup_failed.is_empty()
            {
                tracing::error!(
                    unfinished_writes = report.unfinished_writes,
                    unfinished_servers = report.unfinished_servers,
                    unfinished_workers = report.workers.unfinished,
                    worker_cleanup_failed = !report.workers.cleanup_failed.is_empty(),
                    worker_tasks_failed = report.workers.task_failed,
                    timed_out = report.timed_out,
                    "shutdown did not complete"
                );
                return Err(if report.timed_out {
                    "shutdown: drain deadline reached; persisted operations remain recoverable"
                } else {
                    "shutdown: worker cleanup failed; persisted operations remain recoverable"
                }
                .to_owned());
            }
            database.close().await;
        }
    }
    Ok(())
}
