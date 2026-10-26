//! Representative confirmed edges, bounded cursors and serialized durable edge intents.
use super::{FollowRow, NewOperation, Operation, PageBounds, Repository};
use crate::StorageError;
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::{QueryBuilder, Sqlite};

const VISIBLE: &str = " f.confirmed=1 AND a.active=1 AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor OR x.did=f.subject) AND NOT EXISTS(SELECT 1 FROM users subject WHERE subject.did=f.subject AND subject.active=0) AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri)";

pub enum FollowIntent {
    Existing(FollowRow),
    Absent,
    Pending(Operation),
    Failed(Operation),
}

impl Repository {
    pub async fn follow_page(
        &self,
        did: &str,
        followers: bool,
        bounds: PageBounds,
    ) -> Result<Vec<FollowRow>, StorageError> {
        if !(1..=101).contains(&bounds.limit) {
            return Err(StorageError::Invariant("invalid follow page limit"));
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT f.* FROM follows f JOIN users a ON a.did=f.actor WHERE",
        );
        query
            .push(VISIBLE)
            .push(if followers {
                " AND f.subject="
            } else {
                " AND f.actor="
            })
            .push_bind(did);
        query.push(" AND f.uri=(SELECT min(g.uri) FROM follows g WHERE g.actor=f.actor AND g.subject=f.subject AND g.confirmed=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=g.uri))");
        if let Some((time, uri)) = bounds.upper {
            query
                .push(" AND (f.created_at,f.uri)<=(")
                .push_bind(super::public::timestamp(&time)?)
                .push(",")
                .push_bind(uri)
                .push(")");
        }
        if let Some((time, uri)) = bounds.last {
            query
                .push(" AND (f.created_at,f.uri)<(")
                .push_bind(super::public::timestamp(&time)?)
                .push(",")
                .push_bind(uri)
                .push(")");
        }
        query
            .push(" ORDER BY f.created_at DESC,f.uri DESC LIMIT ")
            .push_bind(i64::from(bounds.limit));
        Ok(query.build_query_as().fetch_all(&self.readers).await?)
    }

    /// The publisher check is part of admission: a no-op is allowed without a
    /// worker, but no new durable pending result is fabricated while unavailable.
    pub async fn follow_intent<F>(
        &self,
        actor: String,
        subject: String,
        create: bool,
        publisher_ready: bool,
        factory: F,
    ) -> Result<FollowIntent, StorageError>
    where
        F: FnOnce() -> Result<NewOperation, StorageError> + Send + 'static,
    {
        self.writer.execute(move |connection|Box::pin(async move {
            let kind=if create {"follow_create"} else {"follow_delete"};
            let pending:Vec<(Operation,Option<String>)>= {
                let rows:Vec<(String,Option<String>)>=sqlx::query_as("SELECT o.operation_id,o.record_uri FROM operations o JOIN outbox b USING(operation_id) WHERE o.owner=? AND o.state='pending' AND o.kind IN('follow_create','follow_delete') AND json_extract(b.payload_json,'$.subject')=? ORDER BY o.rowid")
                    .bind(&actor).bind(&subject).fetch_all(&mut *connection).await?;
                let mut result=Vec::new();
                for (id,uri) in rows {let op=sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(id).fetch_one(&mut *connection).await?;result.push((op,uri));}
                result
            };
            if let Some((latest,_))=pending.last() && latest.kind==kind {return Ok(FollowIntent::Pending(latest.clone()));}
            let visible_query=format!("SELECT f.* FROM follows f JOIN users a ON a.did=f.actor WHERE {VISIBLE} AND f.actor=? AND f.subject=? ORDER BY f.uri");
            let active:Vec<FollowRow>=sqlx::query_as(&visible_query).bind(&actor).bind(&subject).fetch_all(&mut *connection).await?;
            if pending.is_empty() {
                if create && let Some(first)=active.first() {return Ok(FollowIntent::Existing(first.clone()));}
                if !create && active.is_empty() {
                    let suffix=format!("%/{}",atmusic_core::follow::follow_rkey(&subject).map_err(|_|StorageError::Invariant("invalid follow subject"))?);
                    let failed:Option<Operation>=sqlx::query_as("SELECT o.* FROM operations o JOIN tombstones t ON t.operation_id=o.operation_id WHERE t.uri LIKE ? AND o.owner=? AND o.kind='follow_delete' AND o.state='failed' ORDER BY o.rowid DESC LIMIT 1").bind(suffix).bind(&actor).fetch_optional(&mut *connection).await?;
                    return Ok(failed.map(FollowIntent::Failed).unwrap_or(FollowIntent::Absent));
                }
            }
            if !publisher_ready {return Err(StorageError::Invariant("outbox_not_ready"));}
            let mut input=factory()?;
            if input.owner!=actor || input.kind!=kind {return Err(StorageError::Invariant("follow intent identity mismatch"));}
            if !create {
                let mut uris:Vec<String>=active.iter().map(|row|row.uri.clone()).chain(pending.iter().filter(|(op,_)|op.kind=="follow_create").filter_map(|(_,uri)|uri.clone())).collect();
                if let Some(uri)=&input.record_uri {uris.push(uri.clone());}
                uris.sort();uris.dedup();
                if uris.len()>10000 {return Err(StorageError::Invariant("too many follow targets"));}
                input.record_uri=uris.first().cloned();
                let first=input.record_uri.as_ref().ok_or(StorageError::Invariant("unfollow requires record targets"))?;
                let prefix=format!("at://{actor}/");
                let (collection,rkey)=first.strip_prefix(&prefix).and_then(|path|path.split_once('/')).ok_or(StorageError::Ownership)?;
                input.collection=collection.into();input.rkey=rkey.into();
                input.payload_json=Some(json!({"subject":subject,"targetUris":uris}).to_string());
                input.canonical_digest=Some(hex::encode(sha2::Sha256::digest(input.payload_json.as_deref().unwrap().as_bytes())));
            }
            super::outbox::insert_operation(connection,&input).await?;
            for (predecessor,_) in pending {
                sqlx::query("INSERT INTO operation_dependencies(operation_id,predecessor_id) VALUES(?,?)").bind(&input.operation_id).bind(predecessor.operation_id).execute(&mut *connection).await?;
            }
            if !create {
                let value:Value=serde_json::from_str(input.payload_json.as_deref().unwrap()).map_err(|_|StorageError::Invariant("invalid follow targets"))?;
                for uri in value["targetUris"].as_array().unwrap() {
                    sqlx::query("INSERT INTO tombstones(uri,owner,operation_id,created_at,pending) VALUES(?,?,?,?,1) ON CONFLICT(uri) DO UPDATE SET operation_id=excluded.operation_id,pending=1")
                        .bind(uri.as_str().unwrap()).bind(&actor).bind(&input.operation_id).bind(super::public::timestamp(&input.created_at)?).execute(&mut *connection).await?;
                }
            }
            let operation=sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(input.operation_id).fetch_one(connection).await?;
            Ok(FollowIntent::Pending(operation))
        })).await
    }
}
