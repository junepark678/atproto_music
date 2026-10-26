//! Single-process HTTP application. Only initialized, verified capabilities are advertised.
pub mod auth;
pub mod config;
pub mod http;
pub mod metrics;
pub mod shutdown;
pub mod startup;
pub mod workers;

use atmusic_storage::Database;
use axum::{Extension, Router, http::StatusCode, middleware, routing::get};
use config::Config;
use http::error::{HttpError, RequestId};
use std::sync::Arc;

pub trait Clock: Send + Sync {
    fn now(&self) -> chrono::DateTime<chrono::Utc>;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }
}
#[derive(Clone)]
pub struct AppState {
    pub config: Option<Arc<Config>>,
    pub database: Option<Database>,
    pub clock: Arc<dyn Clock>,
    pub oauth: Option<Arc<atmusic_atproto::oauth::service::OAuthService>>,
    pub identity: Option<Arc<atmusic_atproto::identity::IdentityResolver>>,
    pub outbox: Option<Arc<workers::outbox::OutboxWorker>>,
    pub limiter: Arc<http::limits::Limiter>,
    pub metrics: Arc<metrics::Metrics>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            config: None,
            database: None,
            clock: Arc::new(SystemClock),
            oauth: None,
            identity: None,
            outbox: None,
            limiter: Arc::default(),
            metrics: Arc::default(),
        }
    }
}
impl AppState {
    pub fn new(config: Config, database: Option<Database>) -> Self {
        Self {
            config: Some(Arc::new(config)),
            database,
            clock: Arc::new(SystemClock),
            oauth: None,
            identity: None,
            outbox: None,
            limiter: Arc::default(),
            metrics: Arc::default(),
        }
    }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }
    pub fn with_oauth(mut self, oauth: Arc<atmusic_atproto::oauth::service::OAuthService>) -> Self {
        self.oauth = Some(oauth);
        self
    }
    pub fn with_outbox(mut self, outbox: Arc<workers::outbox::OutboxWorker>) -> Self {
        self.outbox = Some(outbox);
        self
    }
    pub fn with_identity(
        mut self,
        identity: Arc<atmusic_atproto::identity::IdentityResolver>,
    ) -> Self {
        self.identity = Some(identity);
        self
    }
}
pub fn router() -> Router {
    router_with_state(AppState::default())
}
pub fn router_with_state(state: AppState) -> Router {
    let middleware_state = state.clone();
    Router::new()
        .route("/", get(http::assets::index))
        .route("/health/live", get(http::health::live))
        .route(
            "/api/v1/scrobbles",
            axum::routing::post(http::scrobbles::create::create),
        )
        .route("/health/ready", get(http::health::ready))
        .route("/api/v1/meta", get(http::health::meta))
        .route("/api/v1/auth/session", get(auth::session::get_session))
        .route(
            "/api/v1/auth/start",
            axum::routing::post(http::auth_start::start),
        )
        .route("/api/v1/auth/callback", get(http::auth_callback::callback))
        .route("/api/v1/feed", get(http::feed::get))
        .route("/api/v1/resolve", get(http::resolve::get))
        .route(
            "/api/v1/follows/{did}",
            axum::routing::put(http::follows::write::put).delete(http::follows::write::delete),
        )
        .route("/api/v1/account/export", get(http::account_export::export))
        .route(
            "/api/v1/account/local-data",
            axum::routing::delete(http::account_disconnect::disconnect),
        )
        .route(
            "/api/v1/users/{did}/following",
            get(http::follows::read::following),
        )
        .route(
            "/api/v1/users/{did}/followers",
            get(http::follows::read::followers),
        )
        .route("/api/v1/users/{did}/stats", get(http::stats::get))
        .route("/api/v1/users/{did}/profile", get(http::profile::get))
        .route(
            "/api/v1/auth/logout",
            axum::routing::post(http::logout::logout),
        )
        .route(
            "/oauth/client-metadata.json",
            get(http::oauth_metadata::client_metadata),
        )
        .route(
            "/api/v1/operations/{id}",
            get(http::operations::get_operation),
        )
        .route(
            "/api/v1/users/{did}/scrobbles",
            get(http::scrobbles::read::history),
        )
        .route(
            "/api/v1/scrobbles/{id}",
            get(http::scrobbles::read::record).delete(http::scrobbles::delete::delete),
        )
        .fallback(http::assets::fallback)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(
            middleware_state,
            http::limits::enforce,
        ))
        .with_state(state)
        .layer(middleware::from_fn(http::error::request_id))
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
}
async fn method_not_allowed(Extension(id): Extension<RequestId>) -> HttpError {
    HttpError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Method not allowed.",
        &id,
    )
}
