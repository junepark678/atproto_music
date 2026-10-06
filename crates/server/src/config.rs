//! Validated operator configuration. Secret values are never included in diagnostics.
use std::{fmt, net::SocketAddr, path::PathBuf};

use atmusic_core::namespace::{Namespace, OwnershipEvidence};
use clap::Args;
use url::Url;

#[derive(Clone, Args)]
pub struct ServeArgs {
    #[arg(long, env = "ATMUSIC_BIND", default_value = "127.0.0.1:3000")]
    pub bind: SocketAddr,
    #[arg(
        long,
        env = "ATMUSIC_DATABASE_PATH",
        default_value = "data/music.sqlite"
    )]
    pub database_path: PathBuf,
    #[arg(long, env = "ATMUSIC_PUBLIC_ORIGIN")]
    pub public_origin: String,
    #[arg(long, env = "ATMUSIC_ENCRYPTION_KEY", hide_env_values = true)]
    pub encryption_key: String,
    #[arg(long, env = "ATMUSIC_LEXICON_PREFIX")]
    pub lexicon_prefix: Option<String>,
    #[arg(long, env = "ATMUSIC_RELAY_URL")]
    pub relay_url: Option<String>,
    #[arg(long, env = "ATMUSIC_NAMESPACE_OWNER_DOMAIN")]
    pub namespace_owner_domain: Option<String>,
    #[arg(long, env = "ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE")]
    pub namespace_ownership_reference: Option<String>,
    #[arg(long, env = "ATMUSIC_METRICS_BIND", default_value = "127.0.0.1:0")]
    pub metrics_bind: SocketAddr,
    #[arg(long, env = "ATMUSIC_METRICS_TOKEN", hide_env_values = true)]
    pub metrics_token: Option<String>,
    #[arg(long, env = "ATMUSIC_TRUSTED_PROXY_CIDRS", value_delimiter = ',')]
    pub trusted_proxy_cidrs: Vec<String>,
}

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub public_origin: Url,
    pub namespace: Option<Namespace>,
    pub relay_url: Option<Url>,
    pub metrics_bind: SocketAddr,
    pub trusted_proxy_cidrs: Vec<ipnet::IpNet>,
    metrics_token: Option<[u8; 32]>,
    encryption_key: [u8; 32],
}

#[derive(Debug)]
pub struct ConfigError {
    pub field: &'static str,
    pub message: &'static str,
}
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}
impl std::error::Error for ConfigError {}
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("public_origin", &self.public_origin)
            .field("namespace", &self.namespace)
            .field("encryption_key", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}
impl TryFrom<ServeArgs> for Config {
    type Error = ConfigError;
    fn try_from(args: ServeArgs) -> Result<Self, Self::Error> {
        let mut config = Self::from_values(
            args.bind,
            args.database_path,
            &args.public_origin,
            &args.encryption_key,
            args.lexicon_prefix.as_deref(),
            args.relay_url.as_deref(),
        )?;
        config = config.with_metrics(args.metrics_bind, args.metrics_token.as_deref())?;
        config = config.with_trusted_proxies(&args.trusted_proxy_cidrs)?;
        match (
            args.namespace_owner_domain,
            args.namespace_ownership_reference,
        ) {
            (Some(domain), Some(reference)) => {
                config =
                    config.with_namespace_ownership(OwnershipEvidence { domain, reference })?;
            }
            (None, None) => {}
            _ => {
                return Err(ConfigError {
                    field: "namespace_ownership",
                    message: "requires both owner domain and reviewable ownership reference",
                });
            }
        }
        Ok(config)
    }
}
impl Config {
    pub fn from_values(
        bind: SocketAddr,
        database_path: PathBuf,
        public_origin: &str,
        encryption_key: &str,
        lexicon_prefix: Option<&str>,
        relay_url: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let invalid = |field, message| ConfigError { field, message };
        let origin = Url::parse(public_origin)
            .map_err(|_| invalid("public_origin", "must be a valid HTTPS origin"))?;
        let authority = public_origin
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
            .unwrap_or_default();
        let has_explicit_port = if authority.starts_with('[') {
            authority
                .split_once(']')
                .is_some_and(|(_, rest)| rest.starts_with(':'))
        } else {
            authority.contains(':')
        };
        if origin.scheme() != "https"
            || has_explicit_port
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(invalid(
                "public_origin",
                "must be a HTTPS origin without credentials, path, query or fragment",
            ));
        }
        if database_path.as_os_str().is_empty() || database_path == PathBuf::from(":memory:") {
            return Err(invalid(
                "database_path",
                "must name a persistent SQLite file",
            ));
        }
        let namespace = lexicon_prefix
            .map(Namespace::new)
            .transpose()
            .map_err(|_| {
                invalid(
                    "lexicon_prefix",
                    "must be a valid reverse-domain NSID prefix",
                )
            })?;
        let relay_url = relay_url
            .map(|v| {
                let url = Url::parse(v)
                    .map_err(|_| invalid("relay_url", "must be a valid secure relay URL"))?;
                if !matches!(url.scheme(), "wss" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                {
                    return Err(invalid(
                        "relay_url",
                        "must use WSS or HTTPS without credentials or fragment",
                    ));
                }
                Ok(url)
            })
            .transpose()?;
        let key: [u8; 32] = hex::decode(encryption_key)
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| {
                invalid(
                    "encryption_key",
                    "must contain exactly 64 hexadecimal characters",
                )
            })?;
        if key == [0; 32] {
            return Err(invalid("encryption_key", "must not be an all-zero key"));
        }
        Ok(Self {
            bind,
            database_path,
            public_origin: origin,
            namespace,
            relay_url,
            metrics_bind: "127.0.0.1:0".parse().expect("loopback socket"),
            trusted_proxy_cidrs: Vec::new(),
            metrics_token: None,
            encryption_key: key,
        })
    }
    pub fn encryption_key(&self) -> &[u8; 32] {
        &self.encryption_key
    }
    pub fn with_trusted_proxies(mut self, cidrs: &[String]) -> Result<Self, ConfigError> {
        if cidrs.len() > 32 {
            return Err(ConfigError {
                field: "trusted_proxy_cidrs",
                message: "must contain at most 32 explicit CIDRs",
            });
        }
        self.trusted_proxy_cidrs = cidrs
            .iter()
            .map(|cidr| {
                cidr.parse().map_err(|_| ConfigError {
                    field: "trusted_proxy_cidrs",
                    message: "must contain valid IPv4 or IPv6 CIDRs",
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(self)
    }
    pub fn metrics_token(&self) -> Option<&[u8; 32]> {
        self.metrics_token.as_ref()
    }
    pub fn with_metrics(
        mut self,
        bind: SocketAddr,
        token: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let token = token
            .map(|value| {
                let key: [u8; 32] = hex::decode(value)
                    .ok()
                    .and_then(|bytes| bytes.try_into().ok())
                    .ok_or(ConfigError {
                        field: "metrics_token",
                        message: "must contain exactly 64 hexadecimal characters",
                    })?;
                if key == [0; 32] {
                    return Err(ConfigError {
                        field: "metrics_token",
                        message: "must not be an all-zero token",
                    });
                }
                Ok(key)
            })
            .transpose()?;
        if !bind.ip().is_loopback() && token.is_none() {
            return Err(ConfigError {
                field: "metrics_bind",
                message: "remote metrics require an operator token",
            });
        }
        self.metrics_bind = bind;
        self.metrics_token = token;
        Ok(self)
    }
    pub fn with_namespace_ownership(
        mut self,
        evidence: OwnershipEvidence,
    ) -> Result<Self, ConfigError> {
        let prefix = self
            .namespace
            .as_ref()
            .ok_or(ConfigError {
                field: "lexicon_prefix",
                message: "ownership evidence requires a configured prefix",
            })?
            .prefix()
            .to_owned();
        self.namespace =
            Some(
                Namespace::with_ownership(prefix, evidence).map_err(|_| ConfigError {
                    field: "namespace_ownership",
                    message: "owner domain and reference must match a non-fixture namespace",
                })?,
            );
        Ok(self)
    }
}
