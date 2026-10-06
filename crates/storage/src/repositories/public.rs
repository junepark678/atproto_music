use super::*;
use crate::StorageError;
use sqlx::{QueryBuilder, Sqlite, SqliteConnection};

pub(crate) fn timestamp(value: &str) -> Result<String, StorageError> {
    Ok(chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| StorageError::Invariant("invalid RFC3339 timestamp"))?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
}
impl Repository {
    pub async fn upsert_user(&self, user: User) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| Box::pin(async move { upsert_user(c, &user).await }))
            .await
    }
    pub async fn user(&self, did: &str) -> Result<Option<User>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM users WHERE did=?")
            .bind(did)
            .fetch_optional(&self.readers)
            .await?)
    }
    pub async fn active_user(&self, did: &str) -> Result<Option<User>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM users WHERE did=? AND active=1 AND NOT EXISTS(SELECT 1 FROM suppression WHERE suppression.did=users.did)").bind(did).fetch_optional(&self.readers).await?)
    }
    /// Called only after signature/CID/MST and schema validation at the protocol boundary.
    pub async fn apply_scrobble(&self, row: ScrobbleRow) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| Box::pin(async move { apply_scrobble(c, &row).await }))
            .await
    }
    pub async fn apply_follow(&self, row: FollowRow) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| Box::pin(async move { apply_follow(c, &row).await }))
            .await
    }
    pub async fn scrobble(&self, uri: &str) -> Result<Option<ScrobbleRow>, StorageError> {
        Ok(sqlx::query_as("SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did WHERE s.uri=? AND s.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=s.did)").bind(uri).fetch_optional(&self.readers).await?)
    }
    pub async fn history(
        &self,
        did: &str,
        bounds: PageBounds,
    ) -> Result<Vec<ScrobbleRow>, StorageError> {
        self.scrobble_page(Some(did), None, bounds).await
    }
    pub async fn feed(
        &self,
        viewer: Option<&str>,
        bounds: PageBounds,
    ) -> Result<Vec<ScrobbleRow>, StorageError> {
        self.scrobble_page(None, viewer, bounds).await
    }
    async fn scrobble_page(
        &self,
        did: Option<&str>,
        viewer: Option<&str>,
        bounds: PageBounds,
    ) -> Result<Vec<ScrobbleRow>, StorageError> {
        if !(1..=101).contains(&bounds.limit) {
            return Err(StorageError::Invariant("invalid page limit"));
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did WHERE s.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=s.did)",
        );
        if let Some(did) = did {
            query.push(" AND s.did=").push_bind(did);
        }
        if let Some(viewer) = viewer {
            query.push(" AND EXISTS(SELECT 1 FROM follows f JOIN users a ON a.did=f.actor WHERE f.actor=").push_bind(viewer)
                .push(" AND f.subject=s.did AND f.confirmed=1 AND a.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor))");
        }
        if let Some((time, uri)) = bounds.upper {
            query
                .push(" AND (s.listened_at,s.uri)<=(")
                .push_bind(timestamp(&time)?)
                .push(",")
                .push_bind(uri)
                .push(")");
        }
        if let Some((time, uri)) = bounds.last {
            query
                .push(" AND (s.listened_at,s.uri)<(")
                .push_bind(timestamp(&time)?)
                .push(",")
                .push_bind(uri)
                .push(")");
        }
        query
            .push(" ORDER BY s.listened_at DESC,s.uri DESC LIMIT ")
            .push_bind(i64::from(bounds.limit));
        Ok(query.build_query_as().fetch_all(&self.readers).await?)
    }
    pub async fn public_counts(&self, did: &str) -> Result<(i64, i64, i64), StorageError> {
        let scrobbles: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles s JOIN users u ON u.did=s.did WHERE s.did=? AND s.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=s.did)").bind(did).fetch_one(&self.readers).await?;
        let following: i64 = sqlx::query_scalar("SELECT count(DISTINCT f.subject) FROM follows f JOIN users a ON a.did=f.actor WHERE f.actor=? AND f.confirmed=1 AND a.active=1 AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor OR x.did=f.subject) AND NOT EXISTS(SELECT 1 FROM users subject WHERE subject.did=f.subject AND subject.active=0) AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri)").bind(did).fetch_one(&self.readers).await?;
        let followers: i64 = sqlx::query_scalar("SELECT count(DISTINCT f.actor) FROM follows f JOIN users a ON a.did=f.actor WHERE f.subject=? AND f.confirmed=1 AND a.active=1 AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor OR x.did=f.subject) AND NOT EXISTS(SELECT 1 FROM users subject WHERE subject.did=f.subject AND subject.active=0) AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri)").bind(did).fetch_one(&self.readers).await?;
        Ok((scrobbles, followers, following))
    }
    pub async fn follow_list(
        &self,
        did: &str,
        followers: bool,
        limit: i64,
    ) -> Result<Vec<FollowRow>, StorageError> {
        let column = if followers { "subject" } else { "actor" };
        let query = format!(
            "SELECT f.* FROM follows f JOIN users a ON a.did=f.actor WHERE f.{column}=? AND f.confirmed=1 AND a.active=1 AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor OR x.did=f.subject) AND NOT EXISTS(SELECT 1 FROM users subject WHERE subject.did=f.subject AND subject.active=0) AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri) AND f.uri=(SELECT min(g.uri) FROM follows g WHERE g.actor=f.actor AND g.subject=f.subject AND g.confirmed=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=g.uri)) ORDER BY f.created_at DESC,f.uri DESC LIMIT ?"
        );
        Ok(sqlx::query_as(&query)
            .bind(did)
            .bind(limit)
            .fetch_all(&self.readers)
            .await?)
    }
    pub async fn indexing(&self, scope: &str) -> Result<Indexing, StorageError> {
        Ok(sqlx::query_as(
            "SELECT state,caught_up,last_indexed_at,lag_seconds FROM indexing_status WHERE scope=?",
        )
        .bind(scope)
        .fetch_optional(&self.readers)
        .await?
        .unwrap_or(Indexing {
            state: "recovering".into(),
            caught_up: false,
            last_indexed_at: None,
            lag_seconds: None,
        }))
    }
    pub async fn set_indexing(&self, scope: String, status: Indexing) -> Result<(), StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("INSERT INTO indexing_status(scope,state,caught_up,last_indexed_at,lag_seconds) VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state,caught_up=excluded.caught_up,last_indexed_at=excluded.last_indexed_at,lag_seconds=excluded.lag_seconds")
                .bind(scope).bind(status.state).bind(status.caught_up).bind(status.last_indexed_at).bind(status.lag_seconds).execute(c).await?;
            Ok(())
        })).await
    }
}
pub(crate) async fn upsert_user(c: &mut SqliteConnection, user: &User) -> Result<(), StorageError> {
    sqlx::query("INSERT INTO users(did,handle,joined_at,indexed_at,active,revision,indexing_state) VALUES(?,?,?,?,?,?,?) ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,indexed_at=excluded.indexed_at,active=excluded.active,revision=excluded.revision,indexing_state=excluded.indexing_state")
        .bind(&user.did).bind(&user.handle).bind(timestamp(&user.joined_at)?).bind(user.indexed_at.as_deref().map(timestamp).transpose()?).bind(user.active).bind(&user.revision).bind(&user.indexing_state).execute(c).await?;
    Ok(())
}
pub(crate) async fn apply_scrobble(
    c: &mut SqliteConnection,
    row: &ScrobbleRow,
) -> Result<(), StorageError> {
    if !row.confirmed || !row.uri.starts_with(&format!("at://{}/", row.did)) {
        return Err(StorageError::Invariant(
            "unverified or owner-mismatched scrobble",
        ));
    }
    let suppressed: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
            .bind(&row.did)
            .fetch_one(&mut *c)
            .await?;
    if suppressed {
        return Ok(());
    }
    let tombstone: Option<(Option<String>, bool)> =
        sqlx::query_as("SELECT revision,pending FROM tombstones WHERE uri=?")
            .bind(&row.uri)
            .fetch_optional(&mut *c)
            .await?;
    if let Some((revision, pending)) = tombstone {
        if !pending
            && revision
                .as_deref()
                .is_some_and(|rev| rev >= row.revision.as_str())
        {
            return Ok(());
        }
        if !pending {
            sqlx::query("DELETE FROM tombstones WHERE uri=?")
                .bind(&row.uri)
                .execute(&mut *c)
                .await?;
        }
    }
    sqlx::query("INSERT INTO scrobbles(uri,cid,did,revision,artist,track,album,listened_at,created_at,duration_seconds,recording_mbid,indexed_at,artist_key,track_key,album_key,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(uri) DO UPDATE SET cid=excluded.cid,revision=excluded.revision,artist=excluded.artist,track=excluded.track,album=excluded.album,listened_at=excluded.listened_at,created_at=excluded.created_at,duration_seconds=excluded.duration_seconds,recording_mbid=excluded.recording_mbid,indexed_at=excluded.indexed_at,artist_key=excluded.artist_key,track_key=excluded.track_key,album_key=excluded.album_key WHERE excluded.revision>scrobbles.revision")
        .bind(&row.uri).bind(&row.cid).bind(&row.did).bind(&row.revision).bind(&row.artist).bind(&row.track).bind(&row.album).bind(timestamp(&row.listened_at)?).bind(timestamp(&row.created_at)?).bind(row.duration_seconds).bind(&row.recording_mbid).bind(timestamp(&row.indexed_at)?).bind(&row.artist_key).bind(&row.track_key).bind(&row.album_key).execute(&mut *c).await?;
    sqlx::query(
        "UPDATE users SET indexed_at=?,revision=? WHERE did=? AND (revision IS NULL OR revision<?)",
    )
    .bind(timestamp(&row.indexed_at)?)
    .bind(&row.revision)
    .bind(&row.did)
    .bind(&row.revision)
    .execute(c)
    .await?;
    Ok(())
}
pub(crate) async fn apply_follow(
    c: &mut SqliteConnection,
    row: &FollowRow,
) -> Result<(), StorageError> {
    if !row.confirmed || !row.uri.starts_with(&format!("at://{}/", row.actor)) {
        return Err(StorageError::Invariant(
            "unverified or owner-mismatched follow",
        ));
    }
    let suppressed: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
            .bind(&row.actor)
            .fetch_one(&mut *c)
            .await?;
    if suppressed {
        return Ok(());
    }
    let tombstone: Option<(Option<String>, bool)> =
        sqlx::query_as("SELECT revision,pending FROM tombstones WHERE uri=?")
            .bind(&row.uri)
            .fetch_optional(&mut *c)
            .await?;
    if let Some((revision, pending)) = tombstone {
        if !pending
            && revision
                .as_deref()
                .is_some_and(|rev| rev >= row.revision.as_str())
        {
            return Ok(());
        }
        if !pending {
            sqlx::query("DELETE FROM tombstones WHERE uri=?")
                .bind(&row.uri)
                .execute(&mut *c)
                .await?;
        }
    }
    sqlx::query("INSERT INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at,confirmed) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(uri) DO UPDATE SET cid=excluded.cid,subject=excluded.subject,revision=excluded.revision,created_at=excluded.created_at,indexed_at=excluded.indexed_at WHERE excluded.revision>follows.revision")
        .bind(&row.uri).bind(&row.cid).bind(&row.actor).bind(&row.subject).bind(&row.revision).bind(timestamp(&row.created_at)?).bind(timestamp(&row.indexed_at)?).execute(&mut *c).await?;
    sqlx::query(
        "UPDATE users SET indexed_at=?,revision=? WHERE did=? AND (revision IS NULL OR revision<?)",
    )
    .bind(timestamp(&row.indexed_at)?)
    .bind(&row.revision)
    .bind(&row.actor)
    .bind(&row.revision)
    .execute(c)
    .await?;
    Ok(())
}
