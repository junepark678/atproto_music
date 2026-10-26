use axum::{
    Json,
    extract::Request,
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct RequestId(pub String);

#[derive(Debug)]
pub struct HttpError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
    pub request_id: String,
    pub fields: Option<BTreeMap<String, String>>,
    pub headers: Box<HeaderMap>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<BTreeMap<String, String>>,
}
#[derive(Serialize)]
struct Envelope {
    error: ErrorBody,
}

impl HttpError {
    pub fn new(
        status: StatusCode,
        code: &'static str,
        message: &'static str,
        id: &RequestId,
    ) -> Self {
        Self {
            status,
            code,
            message,
            request_id: id.0.clone(),
            fields: None,
            headers: Box::default(),
        }
    }
    pub fn storage(id: &RequestId) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_unavailable",
            "Application storage is unavailable.",
            id,
        )
    }
}
impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(Envelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    request_id: self.request_id,
                    fields: self.fields,
                },
            }),
        )
            .into_response();
        response.headers_mut().extend(*self.headers);
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        response
    }
}

pub async fn request_id(mut request: Request, next: Next) -> Response {
    let api_response = request.uri().path().starts_with("/api/v1/");
    let id = RequestId(uuid::Uuid::new_v4().to_string());
    request.extensions_mut().insert(id.clone());
    let span = tracing::info_span!("http_request", request_id = %id.0, method = %request.method());
    let mut response = tracing::Instrument::instrument(next.run(request), span).await;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id.0).expect("UUID header"),
    );
    if api_response {
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
    }
    response
}
