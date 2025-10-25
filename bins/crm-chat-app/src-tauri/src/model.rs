// let openai_client = rig::providers::openai::Client::from_env();
// let model: rig::providers::openai::EmbeddingModel =
// openai_client.embedding_model(rig::providers::openai::TEXT_EMBEDDING_3_LARGE);

use rig::client::EmbeddingsClient;
use tokio::sync::OnceCell;

static CLIENT_ONCE: OnceCell<rig::providers::openai::Client> = OnceCell::const_new();

pub async fn ai_client() -> &'static rig::providers::openai::Client {
    CLIENT_ONCE
        .get_or_init(|| async { rig::providers::openai::Client::from_env() })
        .await
}

static MODEL_ONCE: OnceCell<rig::providers::openai::EmbeddingModel> = OnceCell::const_new();

pub async fn embedding_model() -> &'static rig::providers::openai::EmbeddingModel {
    MODEL_ONCE
        .get_or_init(|| async {
            ai_client()
                .await
                .embedding_model(rig::providers::openai::TEXT_EMBEDDING_3_LARGE)
        })
        .await
}
