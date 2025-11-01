use std::{env, sync::Arc};

use surrealdb::{opt::auth::Root, Surreal};
use tokio::sync::OnceCell;

static DB_ONCE: OnceCell<Arc<Surreal<surrealdb::engine::any::Any>>> = OnceCell::const_new();

pub async fn db() -> &'static Surreal<surrealdb::engine::any::Any> {
    DB_ONCE
        .get_or_init(|| async {
            let db = surrealdb::engine::any::connect(
                env::var("SURREALDB_ENDPOINT").expect("env SURREALDB_ENDPOINT"),
            )
            .await
            .expect("connecting");
            let username = env::var("SURREAL_USERNAME");
            let password = env::var("SURREAL_PASSWORD");
            if let (Ok(username), Ok(password)) = (username, password) {
                db.signin(Root {
                    username: &username,
                    password: &password,
                })
                .await
                .expect("signin should work");
            }
            // @todo move to env
            db.use_ns("tg")
                .use_db("tg")
                .await
                .expect("ns and db should exist");
            Arc::new(db)
        })
        .await
}
