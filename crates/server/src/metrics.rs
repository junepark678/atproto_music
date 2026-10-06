//! Operator metrics use a separate listener and never label observations with account data.
use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};
use axum::{
    Extension, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub struct Metrics {
    verification_rejections: AtomicU64,
    requests: AtomicU64,
    rate_rejections: AtomicU64,
}
impl Metrics {
    pub fn verification_rejected(&self) {
        self.verification_rejections.fetch_add(1, Ordering::Relaxed);
    }
    pub fn request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }
    pub fn rate_rejected(&self) {
        self.rate_rejections.fetch_add(1, Ordering::Relaxed);
    }
}
impl crate::workers::relay::RelayObserver for Metrics {
    fn verification_rejected(&self, _: &str) {
        Metrics::verification_rejected(self);
    }
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(get_metrics))
        .with_state(state)
        .layer(middleware::from_fn(crate::http::error::request_id))
}
pub async fn get_metrics(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let config = state.config.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "metrics_not_ready",
            "Metrics are not initialized.",
            &id,
        )
    })?;
    if let Some(expected) = config.metrics_token() {
        let value = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| {
                HttpError::new(
                    StatusCode::UNAUTHORIZED,
                    "operator_auth_required",
                    "An operator token is required.",
                    &id,
                )
            })?;
        let supplied = hex::decode(value)
            .ok()
            .and_then(|value| <[u8; 32]>::try_from(value).ok());
        let mut signature = Hmac::<Sha256>::new_from_slice(expected).expect("HMAC key");
        signature.update(b"atmusic operator token comparison v1");
        let mut candidate =
            Hmac::<Sha256>::new_from_slice(&supplied.unwrap_or([0; 32])).expect("HMAC key");
        candidate.update(b"atmusic operator token comparison v1");
        if supplied.is_none()
            || signature
                .verify_slice(&candidate.finalize().into_bytes())
                .is_err()
        {
            return Err(HttpError::new(
                StatusCode::FORBIDDEN,
                "invalid_operator_token",
                "The operator token is invalid.",
                &id,
            ));
        }
    } else if !peer.ip().is_loopback() {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "metrics_loopback_only",
            "Metrics are restricted to loopback.",
            &id,
        ));
    }
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let pool = database.reader_pool();
    let queued: i64 = sqlx_count(pool, "SELECT count(*) FROM outbox")
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let failed: i64 = sqlx_count(pool, "SELECT count(*) FROM operations WHERE state='failed'")
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let repository = database.repositories();
    let backfills = repository
        .pending_backfill_count()
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let indexing = crate::http::index_status::app_indexing(&state, &repository, "global")
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let text = format!(
        "# TYPE atmusic_storage_ready gauge\natmusic_storage_ready {}\n# TYPE atmusic_outbox_pending gauge\natmusic_outbox_pending {queued}\n# TYPE atmusic_operations_failed gauge\natmusic_operations_failed {failed}\n# TYPE atmusic_backfills_pending gauge\natmusic_backfills_pending {backfills}\n# TYPE atmusic_index_caught_up gauge\natmusic_index_caught_up {}\n# TYPE atmusic_index_lag_known gauge\natmusic_index_lag_known {}\n# TYPE atmusic_index_lag_seconds gauge\natmusic_index_lag_seconds {}\n# TYPE atmusic_verification_rejections_total counter\natmusic_verification_rejections_total {}\n# TYPE atmusic_api_requests_total counter\natmusic_api_requests_total {}\n# TYPE atmusic_rate_rejections_total counter\natmusic_rate_rejections_total {}\n",
        u8::from(database.is_ready()),
        u8::from(indexing.caught_up),
        u8::from(indexing.lag_seconds.is_some()),
        indexing.lag_seconds.unwrap_or(0),
        state
            .metrics
            .verification_rejections
            .load(Ordering::Relaxed),
        state.metrics.requests.load(Ordering::Relaxed),
        state.metrics.rate_rejections.load(Ordering::Relaxed)
    );
    Ok((
        [
            ("content-type", "text/plain; version=0.0.4; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        text,
    )
        .into_response())
}
async fn sqlx_count(pool: &sqlx::SqlitePool, query: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(query).fetch_one(pool).await
}
