use std::{collections::HashSet, env, str::FromStr, sync::Arc};

use anyhow::{Context, Ok, Result};
use async_openai::{Client, config::OpenAIConfig, types::CreateEmbeddingRequestArgs};
use chat_types::{Record, Relation};
// use dotenv::dotenv;
use futures::future::join_all;
use qdrant_client::{
    Payload, Qdrant,
    qdrant::{
        CreateCollectionBuilder, Distance, PointId, PointStruct, ScalarQuantizationBuilder,
        ScrollPointsBuilder, UpsertPointsBuilder, VectorParamsBuilder,
        vectors_output::VectorsOptions,
    },
};
// use async_openai::{types::CreateEmbeddingRequestArgs, Client};
// use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use serde_json::json;
use surrealdb::{
    RecordId, Surreal,
    engine::{
        local::SurrealKv,
        remote::{ws::{Ws, Wss}, http::Http},
    },
    opt::auth::Root,
};
use tokio::sync::Mutex;
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
// const EMBEDDING_MODEL: &str = "qwen3-embedding:8b";
const EMBEDDING_MODEL: &str = "text-embedding-3-large";

async fn create_embeddings(inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
    // let client = get_gemini_client();
    if inputs.len() == 0 {
        return Ok(vec![]);
    }
    // let client = get_ollama_client();
    let client = Client::new();

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

async fn get_chank(
    db: &Surreal<surrealdb::engine::local::Db>,
    start: usize,
    step: usize,
) -> Result<Vec<DbSelectMessageText>> {
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
        .bind(json!({ "limit": step, "start": start }))
        .await?
        .take(0)?;
    return Ok(chank);
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateRecord {
    document: String,
    embedded_text: String,
    embedding: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateRecordWithId {
    id: RecordId,
    document: String,
    embedded_text: String,
    embedding: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmbeddedTextDb {
    embedded_text: String,
}
// static DB: LazyLock<Surreal<SurrealClient>> = LazyLock::new(Surreal::init);
#[tokio::main]
async fn main() -> Result<()> {
    // dotenv().ok(); // Load environment variables=
    // let ws_config = WebsocketConfig::default().max_message_size(128 << 20);
    // let config = Config::new().websocket(ws_config)?;
    let db = Surreal::new::<Http>(&env::var("SURREAL_URL")?)
        .await
        .context("connecting")?;

    // let db: Surreal<surrealdb::engine::local::Db> =
    // Surreal::new::<SurrealKv>(&env::var("SURREAL_URL")?)
    //     .await
    //     .context("connecting")?;
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

    let update_batch_size = 10_000;
    let mut offset = None;

    let all_ids: Vec<EmbeddedTextDb> = db
        .query("SELECT embedded_text from documents")
        .await?
        .take(0)?;
    let all_ids = Arc::new(Mutex::new(
        all_ids
            .into_iter()
            .map(|id| id.embedded_text)
            .collect::<HashSet<_>>(),
    ));

    dbg!(all_ids.lock().await.len());
    loop {
        let mut scroll_points_builder = ScrollPointsBuilder::new(collection_name)
            .limit(update_batch_size)
            .with_payload(true)
            .with_vectors(true);
        if let Some(offset) = offset {
            scroll_points_builder = scroll_points_builder.offset(offset);
        }
        let batch: qdrant_client::qdrant::ScrollResponse =
            client.scroll(scroll_points_builder).await?;
        offset = batch.next_page_offset.clone();
        dbg!("got batch");
        // join_all(
        //     batch
        //         .result
        //         .iter()
        //         .map(|p| async {
        for p in batch.result {
            if let Some(vs) = &p.vectors {
                let embedded_text = p
                    .payload
                    .get("text")
                    .context("get text")?
                    .as_str()
                    .context("as str")?
                    .to_owned();
                if all_ids.lock().await.contains(&embedded_text) {
                    dbg!("already inserted");
                    // return Ok(());
                    continue;
                }
                all_ids.lock().await.insert(embedded_text.clone());
                let id = RecordId::from_str(
                    p.payload
                        .get("id")
                        .context("get id")?
                        .as_str()
                        .context("id to string")?,
                )?;
                if let Some(new_document) = db
                    .create::<Option<CreateRecordWithId>>("documents")
                    .content(CreateRecord {
                        embedded_text,
                        document: serde_json::to_string(&p.payload)?,
                        embedding: match &vs.vectors_options {
                            Some(VectorsOptions::Vector(v)) => {
                                v.data.iter().map(|&x| x as f64).collect()
                            }
                            _ => panic!(),
                        },
                    })
                    .await
                    .unwrap()
                {
                    db.insert::<Vec<Relation>>("embeding")
                        .relation(Relation {
                            r#in: id,
                            out: new_document.id,
                        })
                        .await?;
                    dbg!("inserted");
                } else {
                    dbg!("not inserted");
                }
            }
            // Ok(())
        }
        //         })
        //         .collect::<Vec<_>>(),
        // )
        // .await;

        if batch.next_page_offset.is_none() {
            break;
        }
    }

    return Ok(());

    // if !client.collection_exists(collection_name).await? {
    //     client
    //         .create_collection(
    //             CreateCollectionBuilder::new(collection_name)
    //                 .vectors_config(VectorParamsBuilder::new(3072, Distance::Cosine))
    //                 .quantization_config(ScalarQuantizationBuilder::default()),
    //         )
    //         .await?;
    // }

    // let step = 1000;
    // let mut start = 0;
    // let mut chank: Vec<DbSelectMessageText> = get_chank(&db, start, step).await?;

    // let calculated_ids = client
    //     .scroll(
    //         ScrollPointsBuilder::new(collection_name)
    //             // .filter(Filter::must([Condition::matches(
    //             //     "color",
    //             //     "red".to_string(),
    //             // )]))
    //             .limit(u32::MAX)
    //             .with_payload(false)
    //             .with_vectors(false),
    //     )
    //     .await?
    //     .result
    //     .into_iter()
    //     .filter_map(|p| {
    //         if let Some(PointId {
    //             point_id_options: Some(id),
    //         }) = p.id
    //         {
    //             Some(match id {
    //                 qdrant_client::qdrant::point_id::PointIdOptions::Num(id) => id.to_string(),
    //                 qdrant_client::qdrant::point_id::PointIdOptions::Uuid(id) => {
    //                     id.replace('-', "")
    //                 }
    //             })
    //         } else {
    //             None
    //         }
    //     })
    //     .collect::<HashSet<_>>();
    // dbg!(calculated.len());
    // dbg!(&calculated[0]);

    // while chank.len() != 0 {
    //     chank = chank
    //         .into_iter()
    //         .filter(|m| !calculated_ids.contains(&m.hash))
    //         .collect::<Vec<_>>();
    //     println!("filtered chank {}", start);

    //     dbg!(chank.len());
    //     // .into_iter().take(100).collect();

    //     let embeddings =
    //         create_embeddings(chank.iter().map(|m| m.message.clone()).collect::<Vec<_>>()).await?;

    //     if chank.len() != 0 {
    //         // dbg!(&embeddings[0].len());
    //         client
    //             .upsert_points(UpsertPointsBuilder::new(
    //                 collection_name,
    //                 chank
    //                     .into_iter()
    //                     .enumerate()
    //                     .map(|(i, m)| {
    //                         let mut payload = Payload::new();
    //                         payload.insert("text", m.message.clone());
    //                         payload.insert("id", m.id.to_string());
    //                         PointStruct::new(m.hash.clone(), embeddings[i].clone(), payload)
    //                     })
    //                     .collect::<Vec<_>>(),
    //             ))
    //             .await?;
    //         // break;
    //     }
    //     start += step;
    //     chank = get_chank(&db, start, step).await?;
    //     println!("got chank {}", start);
    // }
    // Ok(())
}
