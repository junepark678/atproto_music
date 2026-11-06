#![allow(dead_code)]
//! Real HTTP/SQLite fixtures, isolated per test; teardown touches only owned resources.
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use atmusic_server::{
    AppState, Clock, SystemClock,
    config::Config,
    shutdown::{self, DrainReport},
};
use atmusic_storage::Database;
use tempfile::TempDir;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

pub struct TestServer {
    pub database: Database,
    pub state: AppState,
    pub client: reqwest::Client,
    pub address: SocketAddr,
    pub database_path: PathBuf,
    directory: TempDir,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<std::io::Result<DrainReport>>>,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with_clock(Arc::new(SystemClock)).await
    }

    pub async fn start_with_clock(clock: Arc<dyn Clock>) -> Self {
        Self::start_with_state(clock, |state| state).await
    }

    pub async fn start_with_state<F>(clock: Arc<dyn Clock>, configure: F) -> Self
    where
        F: FnOnce(AppState) -> AppState,
    {
        Self::start_with_router(clock, configure, atmusic_server::router_with_state).await
    }

    pub async fn start_with_router<F, R>(clock: Arc<dyn Clock>, configure: F, routes: R) -> Self
    where
        F: FnOnce(AppState) -> AppState,
        R: FnOnce(AppState) -> axum::Router,
    {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("music.sqlite");
        let database = Database::open(&database_path).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = Config::from_values(
            address,
            database_path.clone(),
            "https://music.example",
            &"11".repeat(32),
            None,
            None,
        )
        .unwrap();
        let state = configure(AppState::new(config, Some(database.clone())).with_clock(clock));
        let router = routes(state.clone());
        let writer = database.writer().clone();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            shutdown::serve_until(listener, router, &writer, async move {
                let _ = stopped.await;
            })
            .await
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        Self {
            database,
            state,
            client,
            address,
            database_path,
            directory,
            stop: Some(stop),
            task: Some(task),
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
    pub fn directory(&self) -> &Path {
        self.directory.path()
    }

    pub async fn shutdown(mut self) -> DrainReport {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let report = self.task.as_mut().unwrap().await.unwrap().unwrap();
        self.task.take();
        if !report.timed_out {
            self.database.close().await;
        }
        report
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.database.writer().stop_admission();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
