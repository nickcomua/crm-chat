use anyhow::Result;
use chat_types::{DBMessageContent, DbChat, DbChatContent, DbMessage, Record, TgChat};
use grammers_client::session::Session;
use grammers_client::types::{Chat, Message as Msg};
use grammers_client::{Client, Config, SignInError, Update};
use simple_logger::SimpleLogger;
use std::collections::HashSet;
use std::pin::pin;
use std::{env, sync::LazyLock};
use surrealdb::{
    RecordId,
    Surreal,
    engine::remote::ws::{Client as SurrealClient, Wss},
    // engine::remote::http::{Client,Https},
    opt::auth::Root,
};
use tokio::io::{self, AsyncWriteExt};
use tokio::select;
use tokio_stream::StreamExt;
use tokio_util::codec::{FramedRead, LinesCodec};

// const TARGET_CHAT_ID: i64 = -1003131771241;
const CHAT_IDS: &[i64] = &[
    8364513870, 527580149, // "Magic✙Cone✙Daisy"
    // -1003131771241, // "portfolio Chat"
    1040055501, // "Бойвий Хохлоїд із Ізмаїльщини"
    1294615465, // "Ніна"
    // -1001363208402,                // "Ъ | Senec Vinitor | #УкрТґ"
    // 1437229810,     // "DeezLoadᅠ"
    // -1002917300804, // "YaninA"
    // 777000,                        // "Telegram"
    289433591,  // "Женя"
    6969846831, // "яна копрофілка"
    787169801,  // "Дмитро"
    758048386,  // "Костя"
    495344577,  // "Маргупсень"
    // -1001185849430, // "Тримаю в курсі"
    327669845, //"Оля Лайф"
];

static DB: LazyLock<Surreal<SurrealClient>> = LazyLock::new(Surreal::init);

async fn prompt(message: &str) -> Result<String> {
    let mut stdout = io::stdout();
    stdout.write_all(message.as_bytes()).await?;
    stdout.flush().await?;

    let stdin = io::stdin();
    let mut reader = FramedRead::new(stdin, LinesCodec::new());
    let line = reader.next().await.transpose()?.unwrap();

    Ok(line)
}

const SESSION_FILE: &str = "dialogs.session";
#[tokio::main]
async fn main() -> Result<()> {
    SimpleLogger::new()
        .with_level(log::LevelFilter::Debug)
        .init()
        .unwrap();

    let api_id = env::var("TG_ID").expect("TG_ID invalid").parse().unwrap();
    let api_hash = env::var("TG_HASH").unwrap();

    DB.connect::<Wss>("surrealdb.kaminazuma.com")
        .await
        .expect("connecting");
    // Sign in to the server
    DB.signin(Root {
        username: &env::var("SURREAL_USERNAME").unwrap(),
        password: &env::var("SURREAL_PASSWORD").unwrap(),
        // database: "test",
        // namespace: "test",
    })
    .await
    .expect("loggin");
    // Select a namespace + database
    DB.use_ns("tg").use_db("tg").await.expect("db selecting");
    // Create the client object

    let client = Client::connect(Config {
        session: Session::load_file_or_create(SESSION_FILE)?,
        api_id,
        api_hash: api_hash.clone(),
        params: Default::default(),
    })
    .await?;

    // If we can't save the session, sign out once we're done.
    // let mut sign_out = false;

    if !client.is_authorized().await? {
        println!("Signing in...");
        let phone = prompt("Enter your phone number (international format): ").await?;
        dbg!(&phone);
        let token = client.request_login_code(&phone).await?;
        let code = prompt("Enter the code you received: ").await?;
        let signed_in = client.sign_in(&token, &code).await;
        match signed_in {
            Err(SignInError::PasswordRequired(password_token)) => {
                // Note: this `prompt` method will echo the password in the console.
                //       Real code might want to use a better way to handle this.
                let hint = password_token.hint().unwrap_or("None");
                let prompt_message = format!("Enter the password (hint {}): ", &hint);
                let password = prompt(prompt_message.as_str()).await?;

                client
                    .check_password(password_token, password.trim())
                    .await?;
            }
            Ok(_) => (),
            Err(e) => panic!("{}", e),
        };
        println!("Signed in!");
        match client.session().save_to_file(SESSION_FILE) {
            Ok(_) => {}
            Err(e) => {
                println!("NOTE: failed to save the session, will sign out when done: {e}");
                // sign_out = true;
            }
        }
    }

    let mut dialogs = client.iter_dialogs();
    println!("Showing up to {} dialogs:", dialogs.total().await?);
    let clinet_phone = client
        .get_me()
        .await
        .expect("get me")
        .phone()
        .unwrap()
        .to_string();

    let client_id = format!("telegram:{}", clinet_phone.clone());
    while let Some(dialog) = dialogs.next().await? {
        let chat = dialog.chat();
        let chat_id =
            RecordId::from_table_key("chat", format!("{}:{}", client_id.clone(), chat.id()));
        let _: Vec<DbChat> = DB
            .upsert("chat")
            .content(DbChat {
                id: chat_id.clone(),
                client_id: client_id.clone(),
                content: vec![DbChatContent::Telegram(match chat {
                    Chat::User(user) => TgChat::User(user.raw.clone()),
                    Chat::Group(group) => TgChat::Group(group.raw.clone()),
                    Chat::Channel(channel) => TgChat::Channel(channel.raw.clone()),
                })],
            })
            .await
            .expect("upsert");
        // println!(
        //     "- {: >10} {} {}",
        //     chat.id(),
        //     chat.name().unwrap_or_default(),
        //     client.iter_messages(chat).total().await?
        // );
        if !CHAT_IDS.contains(&chat.id()) {
            continue;
        }
        let ids: Vec<Record> = DB
            .query("SELECT id FROM message where chat_id=$caht_id")
            .bind(("caht_id", chat_id.clone()))
            .await?
            .take(0)?;
        let ids = ids.into_iter().map(|x| x.id).collect::<HashSet<_>>();
        let mut messages = client.iter_messages(chat);

        while let Some(msg) = messages.next().await? {
            // dbg!(&msg);
            let id = RecordId::from_table_key(
                "message",
                format!("{}:{}:{}", client_id.clone(), chat.id(), msg.id()),
            );

            if ids.contains(&id) {
                break;
            }

            let _: Option<Vec<DbMessage>> = DB
                .upsert("message")
                .content(DbMessage {
                    id,
                    client_id: client_id.clone(),
                    chat_id: chat_id.clone(),
                    content: vec![DBMessageContent::Telegram(msg.raw.clone())],
                    deleted: false,
                })
                .await
                .ok();
            // .expect("upsert");
        }

        client.session().save_to_file(SESSION_FILE)?;
    }

    loop {
        let exit = pin!(async { tokio::signal::ctrl_c().await });
        let upd = pin!(async { client.next_update().await });

        let update = select! {
            _ = exit => break,
            u = upd => u?,
        };
        let client_id = client_id.clone();
        let handle = client.clone();
        tokio::spawn(async move {
            match handle_update(handle, update, client_id).await {
                Ok(_) => {}
                Err(e) => eprintln!("Error handling updates!: {e}"),
            }
        });
    }
    client.session().save_to_file(SESSION_FILE)?;
    Ok(())

    // if sign_out {
    //     // TODO revisit examples and get rid of "handle references" (also, this panics)
    //     drop(client.sign_out_disconnect().await);
    // }

    // Ok(())
}

async fn handle_update(_client: Client, update: Update, client_id: String) -> Result<()> {
    match update {
        Update::NewMessage(message) if !message.outgoing() => {
            let chat: Chat = message.chat();
            let chat_id =
                RecordId::from_table_key("chat", format!("{}:{}", client_id.clone(), chat.id()));
            let raw: &Msg = &message;
            // println!(
            //     "Responding to {}",
            //     chat.name().unwrap_or(&format!("id {}", chat.id()))
            // );
            // client.send_message(&chat, message.text()).await?;
            let id = RecordId::from_table_key(
                "message",
                format!("{}:{}:{}", client_id.clone(), chat.id(), message.id()),
            );
            let _: Option<Vec<DbMessage>> = DB
                .upsert("message")
                .content(DbMessage {
                    id,
                    client_id: client_id.clone(),
                    chat_id,
                    content: vec![DBMessageContent::Telegram(raw.raw.clone())],
                    deleted: false,
                })
                .await
                .ok();
        }
        Update::MessageDeleted(deleted) => {
            println!("Message deleted: {:?}", deleted);
        }
        _ => {}
    }

    Ok(())
}
