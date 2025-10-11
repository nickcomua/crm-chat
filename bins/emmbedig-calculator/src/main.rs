use std::{env, sync::LazyLock};

use anyhow::{Context, Ok, Result};
use async_openai::{Client, config::OpenAIConfig, types::CreateEmbeddingRequestArgs};
use dotenv::dotenv;
use qdrant_client::{
    Payload, Qdrant,
    qdrant::{
        CreateCollectionBuilder, Distance, PointStruct, ScalarQuantizationBuilder,
        UpsertPointsBuilder, VectorParamsBuilder,
    },
};
// use async_openai::{types::CreateEmbeddingRequestArgs, Client};
// use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use surrealdb::{
    RecordId, Surreal,
    engine::remote::ws::{Client as SurrealClient, Wss},
    opt::{Config, auth::Root},
};

// #[derive(Debug, Clone, Serialize, Deserialize)]
// enum DBMessageContent {
//     Telegram(tl::enums::Message),
// }

// #[derive(Debug, Clone, Serialize, Deserialize)]
// struct DbMessage {
//     id: RecordId,
//     chat_id: RecordId,
//     client_id: String,
//     content: Vec<DBMessageContent>,
//     #[serde(default)]
//     deleted: bool,
// }
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbSelectMessageText {
    id: RecordId,
    hash: String,
    message: String,
}

/// Initializes the OpenAI client with Gemini API compatibility
// fn get_gemini_client() -> Client<OpenAIConfig> {
//     let base_url = "https://generativelanguage.googleapis.com/v1beta/openai";
//     let api_key = std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY must be set");
//     let config = OpenAIConfig::new()
//         .with_api_base(base_url)
//         .with_api_key(api_key);
//     Client::with_config(config)
// }

fn get_ollama_client() -> Client<OpenAIConfig> {
    let base_url = "http://localhost:11434/v1";
    let config = OpenAIConfig::new().with_api_base(base_url);
    // .with_api_key();
    Client::with_config(config)
}

// const EMBEDDING_MODEL: &str = "gemini-embedding-001";
// const EMBEDDING_MODEL: &str = "mxbai-embed-large";
const EMBEDDING_MODEL: &str = "qwen3-embedding:8b";

async fn create_embeddings(inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
    // let client = get_gemini_client();
    let client = get_ollama_client();

    let request = CreateEmbeddingRequestArgs::default()
        .model(EMBEDDING_MODEL)
        .input(inputs)
        .build()?;

    let response: async_openai::types::CreateEmbeddingResponse =
        client.embeddings().create(request).await?;
    // let response: Value = client.embeddings().create_byot(request).await.unwrap();

    // let mut f = File::create("data1.json").await?;
    // f.write_all(serde_json::to_string(&response)?.as_bytes())
    // .await?;
    // Ok(vec![])
    Ok(response.data.into_iter().map(|e| e.embedding).collect())
}

async fn get_chank(db: &Surreal<SurrealClient>, start: usize) -> Result<Vec<DbSelectMessageText>> {
    let chank: Vec<DbSelectMessageText> = db
        .query(
            "SELECT 
                id, 
                crypto::md5(type::string(id)) as hash,
                content[0].Telegram.Message.message as message 
            FROM message 
            WHERE content[0].Telegram.Message.message
            LIMIT $limit 
            START $start",
        )
        .bind(json!({ "limit": 1000, "start": start }))
        .await?
        .take(0)?;
    return Ok(chank);
}

// static DB: LazyLock<Surreal<SurrealClient>> = LazyLock::new(Surreal::init);
#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok(); // Load environment variables=
    // let ws_config = WebsocketConfig::default().max_message_size(128 << 20);
    // let config = Config::new().websocket(ws_config)?;
    let db = Surreal::new::<Wss>(&env::var("SURREAL_URL")?)
        .await
        .context("connecting")?;
    // Sign in to the server
    db.signin(Root {
        username: &env::var("SURREAL_USERNAME")?,
        password: &env::var("SURREAL_PASSWORD")?,
        // database: "test",
        // namespace: "test",
    })
    .await
    .expect("loggin");
    // Select a namespace + database
    db.use_ns("tg").use_db("tg").await.expect("db selecting");

    let collection_name = "messages";
    // dbg!(collections_list);

    let client = Qdrant::from_url(&env::var("QDRAN_URL")?)
        .api_key(env::var("QDRAN_KEY")?)
        .build()?;
    if !client.collection_exists(collection_name).await? {
        client
            .create_collection(
                CreateCollectionBuilder::new(collection_name)
                    .vectors_config(VectorParamsBuilder::new(1024, Distance::Cosine))
                    .quantization_config(ScalarQuantizationBuilder::default()),
            )
            .await?;
    }
    let mut start = 0;
    let mut chank: Vec<DbSelectMessageText> = get_chank(&db, start).await?;
    while chank.len() != 0 {
        dbg!(chank.len());
        // .into_iter().take(100).collect();

        let embeddings =
            create_embeddings(chank.iter().map(|m| m.message.clone()).collect::<Vec<_>>()).await?;

        dbg!(embeddings.len());
        dbg!(&embeddings[0].len());
        // let mut f = File::create("data.json").await?;
        // f.write_all(serde_json::to_string(&embeddings)?.as_bytes())
        //     .await?;

        client
            .upsert_points(UpsertPointsBuilder::new(
                collection_name,
                chank
                    .into_iter()
                    .enumerate()
                    .map(|(i, m)| {
                        let mut payload = Payload::new();
                        payload.insert("text", m.message.clone());
                        payload.insert("id", m.id.to_string());
                        PointStruct::new(m.hash.clone(), embeddings[i].clone(), payload)
                    })
                    .collect::<Vec<_>>(),
            ))
            .await?;
        
        start += 1000;
        chank = get_chank(&db, start).await?;
    }
    Ok(())
}
