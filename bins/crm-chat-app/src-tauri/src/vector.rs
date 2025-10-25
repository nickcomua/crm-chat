use std::env;

use rig_qdrant::QdrantVectorStore;
// use rig_surrealdb::SurrealVectorStore;
use crate::model::embedding_model;
use qdrant_client::{
    qdrant::QueryPointsBuilder,
    Qdrant,
};
use tokio::sync::OnceCell;

// use crate::{db::db, model::embedding_model};

// static VECTOR_ONCE: OnceCell<SurrealVectorStore<surrealdb::engine::any::Any, rig::providers::openai::EmbeddingModel>> = OnceCell::const_new();

// pub async fn vector_store() -> &'static SurrealVectorStore<surrealdb::engine::any::Any, rig::providers::openai::EmbeddingModel> {
//     VECTOR_ONCE.get_or_init(|| async {
//         SurrealVectorStore::new(
//             embedding_model().await.clone(),
//             db().await.clone(),
//             Some("documents".to_string()),
//             rig_surrealdb::SurrealDistanceFunction::Cosine,
//         )
//      }).await
// }

static VECTOR_ONCE: OnceCell<QdrantVectorStore<rig::providers::openai::EmbeddingModel>> =
    OnceCell::const_new();

pub async fn vector_store() -> &'static QdrantVectorStore<rig::providers::openai::EmbeddingModel> {
    VECTOR_ONCE
        .get_or_init(|| async {
            let client = Qdrant::from_url(&env::var("QDRAN_URL").unwrap())
                .api_key(env::var("QDRAN_KEY").unwrap())
                .build()
                .expect("to connect");
            let query_params = QueryPointsBuilder::new(env::var("QDRAN_COLLECTION").unwrap()).with_payload(true).with_vectors(true);
            QdrantVectorStore::new(
                client,
                embedding_model().await.clone(),
                query_params.build(),
            )
        })
        .await
}
