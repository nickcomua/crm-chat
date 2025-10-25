use std::env;

use anyhow::Context;
use rig::{
    Embed,
    client::EmbeddingsClient,
    embeddings::EmbeddingsBuilder,
    vector_store::{InsertDocuments, VectorSearchRequest, VectorStoreIndex},
};
use rig_surrealdb::{Mem, SurrealVectorStore, Wss};
use serde::{Deserialize, Serialize, de};
use surrealdb::{Surreal, opt::auth::Root};

#[derive(Embed, Serialize, Deserialize, Clone, Debug, Eq, PartialEq, Default)]
struct WordDefinition {
    word: String,
    #[serde(skip)]
    #[embed]
    definition: String,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let openai_client = rig::providers::openai::Client::from_env();
    let model = openai_client.embedding_model(rig::providers::openai::TEXT_EMBEDDING_3_SMALL);

    
    let surreal = Surreal::new::<Wss>(&env::var("SURREAL_URL")?)
        .await
        .context("connecting")?;
    surreal.use_ns("example").use_db("example").await?;
    surreal.signin(Root {
        username: &env::var("SURREAL_USERNAME")?,
        password: &env::var("SURREAL_PASSWORD")?,
        // database: "test",
        // namespace: "test",
    })
    .await
    .context("loggin")?;
    let words = vec![
        WordDefinition {
            word: "flurbo".to_string(),
            definition: "A fictional currency from Rick and Morty.".to_string(),
        },
        WordDefinition {
            word: "glarb-glarb".to_string(),
            definition: "A creature from the marshlands of Glibbo.".to_string(),
        },
    ];

    let documents = EmbeddingsBuilder::new(model.clone())
        .documents(words)
        .unwrap()
        .build()
        .await?;

    let vector_store = SurrealVectorStore::new(
        model,
        surreal,
        Some("documents".to_string()),
        rig_surrealdb::SurrealDistanceFunction::Cosine,
    );
    vector_store.insert_documents(documents).await?;

    let query = "weird alien creature";
    let results = vector_store
        .top_n::<WordDefinition>(
            VectorSearchRequest::builder()
                .query(query)
                .samples(2)
                .build()?,
        )
        .await?;

    for (distance, _id, doc) in results {
        println!("Distance: {:.3}, Word: {}", distance, doc.word);
    }

    Ok(())
}
