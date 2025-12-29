use std::{env, str::FromStr};

use anyhow::{Context, Result};
use chat_types::Record;
use opentelemetry::trace::TracerProvider;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use rig::{
    client::{CompletionClient, ProviderClient},
    completion::Prompt,
    providers::{anthropic::decoders::jsonl, ollama, openai, openrouter},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use surrealdb::{
    RecordId, Surreal,
    engine::remote::ws::{Client as SurrealClient, Wss},
    opt::auth::Root,
};
use tracing::Level;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
struct Utterance {
    id: u32,
    text: String,
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
struct QALink {
    question_id: usize,
    answer_ids: Vec<usize>,
    confidence: usize,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
struct ExtractedDialogLinks {
    links: Vec<QALink>,
}

fn pretty_print_links(result: &Vec<QALink>, dialog: &Vec<DbSelectMessage>) {
    println!("\n✅ Extracted Q→A Links:");
    println!("Links:");

    for QALink {
        question_id,
        answer_ids,
        confidence,
    } in result
    {
        if answer_ids.is_empty() {
            println!(
                "  - Q ID: {}:{} → no answers | confidence: {:.2}",
                question_id, dialog[*question_id].message, confidence
            );
        } else {
            println!(
                "  - Q ID: {}:{} → Answers: {:?} | confidence: {:.2}",
                question_id,
                dialog[*question_id].message,
                answer_ids
                    .iter()
                    .map(|id| format!("{id}:{}", dialog[*id].message))
                    .collect::<Vec<_>>(),
                confidence
            );
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct DbSelectMessage {
    id: RecordId,
    message: String,
    out: bool,
}

async fn get_chank(
    db: &Surreal<SurrealClient>,
    chat_id: RecordId,
    start: usize,
    step: usize,
) -> Result<Vec<DbSelectMessage>> {
    let chank: Vec<DbSelectMessage> = db
        .query(
            "SELECT 
                id, 
                content[0].Telegram.Message.message as message,
                content[0].Telegram.Message.out as out
            FROM message
            WHERE content[0].Telegram.Message.message and chat_id=type::record($chat_id) and is_question = None
            ORDER BY id ASC
            LIMIT $limit 
            START $start",
        )
        .bind(json!({ "limit": step, "start": start, "chat_id": chat_id.to_string() }))
        .await?
        .take(0)?;
    return Ok(chank);
}

#[derive(Debug, Deserialize, Serialize)]
struct MessageStatusUpdate {
    id: RecordId,
    is_question: bool,
    is_answer: bool,
    confidence: usize,
    answers: Vec<RecordId>,
}

async fn with_tracing<T, F>(name: String, fut: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(opentelemetry_otlp::Protocol::HttpBinary)
        .build()?;
    // Create a new OpenTelemetry trace pipeline that prints to stdout
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            Resource::builder()
                .with_service_name(format!("servise-{}", name.clone()))
                .build(),
        )
        .build();
    let tracer = provider.tracer(name.clone());

    // Create a tracing layer with the configured tracer
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let filter_layer = tracing_subscriber::filter::EnvFilter::builder()
        .with_default_directive(Level::INFO.into())
        .from_env_lossy();

    let fmt_layer = tracing_subscriber::fmt::layer().pretty();

    // Use the tracing subscriber `Registry`, or any other subscriber
    // that impls `LookupSpan`
    tracing_subscriber::registry()
        .with(filter_layer)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    let result = fut.await;
    let _ = provider.shutdown();
    result
}
// todo add anaswers questions for each run
async fn async_main() -> Result<()> {
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
    let target_chat = RecordId::from_str("chat:⟨telegram:380973781241:1040055501⟩")?;
    dbg!(&target_chat);

    let ai_client = openrouter::Client::from_env();
    // let openai_client = ollama::Client::default();
    // let ai_client = openai::Client::from_env();

    let extractor = ai_client
        .extractor::<ExtractedDialogLinks>("x-ai/grok-4-fast")
        // .extractor::<ExtractedDialogLinks>("openai/gpt-oss-120b")
        // .extractor::<ExtractedDialogLinks>("openai/gpt-oss-20b")
        .preamble(
            "Extract Q→A links from dialog. Each line has integer ID and content.\n\
             OUTPUT RULES:\n\
             • Identify which messages are questions\n\
             • Map answers that occur later in conversation\n\
             • If question has no answer: []\n",
        )
        .build();

    // let mut start = 0;
    let batch_size = 1000;
    let mut dialog: Vec<DbSelectMessage> =
        get_chank(&db, target_chat.clone(), 0, batch_size).await?;
    while dialog.len() != 0 {
        let mut prompt = "Dialog:\n".to_string();
        for (id, msg) in dialog.iter().enumerate() {
            prompt.push_str(&format!(
                "{}:{}: {}\n",
                id,
                if msg.out { "A" } else { "B" },
                msg.message
            ));
        }

        println!("🔍 Extracting Q→A from dialog...\n{prompt}");

        if let Ok(ExtractedDialogLinks { links: result }) = extractor.extract(&prompt).await {
            pretty_print_links(&result, &dialog);
            let mut to_update = dialog
                .into_iter()
                .map(|m| MessageStatusUpdate {
                    id: m.id,
                    confidence: 0,
                    is_question: false,
                    is_answer: false,
                    answers: vec![],
                })
                .collect::<Vec<_>>();
            // @todo use relate
            for QALink {
                question_id,
                answer_ids,
                confidence,
            } in result
            {
                to_update[question_id].confidence = confidence;
                to_update[question_id].is_question = true;
                for answer_id in answer_ids {
                    to_update[answer_id].is_answer = true;
                    let id = to_update[answer_id].id.clone();
                    to_update[question_id].answers.push(id);
                }
            }
            for m in to_update {
                let _: Option<Record> = db.update(m.id.clone()).merge(m).await?;
            }
            // let _: Vec<()> = db.update("message").content(to_update).await?;
        }
        // start += batch_size;
        dialog = get_chank(&db, target_chat.clone(), 0, batch_size).await?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    with_tracing("questions-extractor".to_string(), async_main()).await
}
