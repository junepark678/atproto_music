//! Compile-time public assets and a constrained placeholder/SPA fallback.
use super::error::{HttpError, RequestId};
use axum::{
    Extension,
    body::Body,
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

struct Asset {
    path: &'static str,
    bytes: &'static [u8],
    content_type: &'static str,
    immutable: bool,
}
include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

fn response(asset: &'static Asset) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, asset.content_type)
        .header(
            header::CACHE_CONTROL,
            if asset.immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .header("x-content-type-options", "nosniff")
        .body(Body::from(asset.bytes))
        .unwrap()
}

pub async fn index() -> Response {
    response(
        EMBEDDED_ASSETS
            .iter()
            .find(|asset| asset.path == "/index.html")
            .expect("mandatory embedded index"),
    )
}

fn safe_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut position = 0;
    while position < bytes.len() {
        let byte = if bytes[position] == b'%' {
            let high = *bytes.get(position + 1)?;
            let low = *bytes.get(position + 2)?;
            let nibble = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                b'A'..=b'F' => Some(value - b'A' + 10),
                _ => None,
            };
            let byte = nibble(high)? * 16 + nibble(low)?;
            if matches!(byte, b'/' | b'\\' | b'%') {
                return None;
            }
            position += 3;
            byte
        } else {
            let byte = bytes[position];
            position += 1;
            byte
        };
        if byte.is_ascii_control() || byte == b'\\' {
            return None;
        }
        decoded.push(byte);
    }
    let path = String::from_utf8(decoded).ok()?;
    if path.split('/').any(|segment| matches!(segment, "." | "..")) {
        return None;
    }
    Some(path)
}

pub async fn fallback(method: Method, uri: Uri, Extension(id): Extension<RequestId>) -> Response {
    let not_found = || {
        HttpError::new(StatusCode::NOT_FOUND, "not_found", "Route not found.", &id).into_response()
    };
    if method != Method::GET {
        return not_found();
    }
    let Some(path) = safe_path(uri.path()) else {
        return not_found();
    };
    if let Some(asset) = EMBEDDED_ASSETS.iter().find(|asset| asset.path == path) {
        return response(asset);
    }
    let reserved = path
        .split('/')
        .any(|segment| matches!(segment, "api" | "oauth"))
        || ["/assets", "/health", "/metrics", "/.well-known"]
            .iter()
            .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if reserved
        || path
            .rsplit('/')
            .next()
            .is_some_and(|segment| segment.contains('.'))
    {
        return not_found();
    }
    index().await
}
