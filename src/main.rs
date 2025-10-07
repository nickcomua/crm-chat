use base64::{Engine, prelude::BASE64_STANDARD};
use dotenv::dotenv;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    env,
    i32,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};
use surrealdb::{
    RecordId,
    Surreal,
    engine::remote::ws::{Client, Wss},
    // engine::remote::http::{Client,Https},
    opt::auth::Root,
};
use tdlib_rs::{
    enums::{
        self, AuthorizationState,
        InputMessageContent, MessageContent, Messages, Update,
    },
    functions,
    types::{
        self, Chat, ForumTopic, Message, UpdateDeleteMessages,
        UpdateMessageContent,
    },
};
use tokio::{
    fs::File,
    io::AsyncWriteExt,
    sync::mpsc::{self, Receiver, Sender},
};
fn ask_user(string: &str) -> String {
    println!("{string}");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    input.trim().to_string()
}
const TARGET_CHAT_ID: i64 = -1003131771241;
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

enum MessageRelated {
    Message(Message),
    DeleteMessages(UpdateDeleteMessages),
    Update(UpdateMessageContent),
}

async fn handle_update(
    update: Update,
    auth_tx: &Sender<AuthorizationState>,
    message_tx: &Sender<MessageRelated>,
) {
    // if let Update::AuthorizationState(update) = update {
    //     auth_tx.send(update.authorization_state).await.unwrap();
    // }
    match update {
        Update::AuthorizationState(update) => {
            auth_tx.send(update.authorization_state).await.unwrap();
        }
        Update::NewMessage(update) => {
            message_tx
                .send(MessageRelated::Message(update.message))
                .await
                .unwrap();
        }
        Update::DeleteMessages(update) => {
            if update.is_permanent && !update.from_cache {
                message_tx
                    .send(MessageRelated::DeleteMessages(update))
                    .await
                    .unwrap();
            }
        }
        Update::MessageContent(update) => {
            message_tx
                .send(MessageRelated::Update(update))
                .await
                .unwrap();
        }
        // Update::MessageSendSucceeded(update) => {
        //     println!("Message send succeeded: {:?}", update);
        // }
        // Update::MessageSendFailed(update) => {
        //     println!("Message send failed: {:?}", update);
        // }
        // Update::MessageContent(update) => {
        //     println!("Message content: {:?}", update);
        // }
        // Update::MessageEdited(update) => {
        //     println!("Message edited: {:?}", update);
        // }
        // Update::MessageInteractionInfo(update) => {
        //     println!("Message interacted: {:?}", update);
        // }
        // Update::MessageMentionRead(update) => {
        //     println!("Message mention read: {:?}", update);
        // }
        // Update::NewChat(update) => {
        //     println!("New chat: {:?}", update);
        // }
        // Update::ChatTitle(update) => {
        //     println!("Chat title: {:?}", update);
        // }
        // Update::ChatPhoto(update) => {
        //     println!("Chat photo: {:?}", update);
        // }
        // Update::ChatLastMessage(update) => {
        //     println!("Chat last message: {:?}", update);
        // }
        // Update::ChatReadInbox(update) => {
        //     println!("Chat read inbox: {:?}", update);
        // }
        // Update::AccentColors(update) => {
        //     println!("Accent colors: {:?}", update);
        // }
        // Update::ChatPermissions(update) => {
        //     println!("Chat permissions: {:?}", update);
        // }
        // Update::ChatOnlineMemberCount(update) => {
        //     println!("Chat online member count: {:?}", update);
        //     online_status_tx.send(update).await.unwrap();
        // }
        rest => {
            // println!("Unknown update: {:?}", rest);
        }
    }
}

async fn handle_authorization_state(
    client_id: i32,
    mut auth_rx: Receiver<AuthorizationState>,
    run_flag: Arc<AtomicBool>,
) -> Receiver<AuthorizationState> {
    while let Some(state) = auth_rx.recv().await {
        match state {
            AuthorizationState::WaitTdlibParameters => {
                let api_id = env::var("TG_ID").unwrap();
                let api_hash = env::var("TG_HASH").unwrap();

                let response = functions::set_tdlib_parameters(
                    false,
                    "tgdb".into(),
                    "tgdb/files".into(),
                    String::new(),
                    true,
                    true,
                    true,
                    true,
                    api_id.parse().unwrap(),
                    api_hash,
                    "en".into(),
                    "Rust Telegram Bot".into(),
                    "1.0".into(),
                    "1.0".into(),
                    client_id,
                )
                .await;

                if let Err(error) = response {
                    println!("{}", error.message);
                }
            }
            AuthorizationState::WaitPhoneNumber => loop {
                let input = ask_user("Enter your phone number (include the country calling code):");
                let response =
                    functions::set_authentication_phone_number(input, None, client_id).await;
                match response {
                    Ok(_) => break,
                    Err(e) => println!("{}", e.message),
                }
            },
            AuthorizationState::WaitOtherDeviceConfirmation(x) => {
                println!(
                    "Please confirm this login link on another device: {}",
                    x.link
                );
            }
            AuthorizationState::WaitEmailAddress(_x) => {
                let email_address = ask_user("Please enter email address: ");
                let response =
                    functions::set_authentication_email_address(email_address, client_id).await;
                match response {
                    Ok(_) => break,
                    Err(e) => println!("{}", e.message),
                }
            }
            AuthorizationState::WaitEmailCode(_x) => {
                let code = ask_user("Please enter email authentication code: ");
                let response = functions::check_authentication_email_code(
                    enums::EmailAddressAuthentication::Code(
                        tdlib_rs::types::EmailAddressAuthenticationCode { code },
                    ),
                    client_id,
                )
                .await;
                match response {
                    Ok(_) => break,
                    Err(e) => println!("{}", e.message),
                }
            }

            AuthorizationState::WaitCode(_) => loop {
                let input = ask_user("Enter the verification code:");
                let response = functions::check_authentication_code(input, client_id).await;
                match response {
                    Ok(_) => break,
                    Err(e) => println!("{}", e.message),
                }
            },
            AuthorizationState::WaitRegistration(_x) => {
                // x useless but contains the TOS if we want to show it
                let first_name = ask_user("Please enter your first name: ");
                let last_name = ask_user("Please enter your last name: ");
                functions::register_user(first_name, last_name, false, client_id)
                    .await
                    .unwrap();
            }
            AuthorizationState::WaitPassword(_x) => {
                let password = ask_user("Please enter password: ");
                functions::check_authentication_password(password, client_id)
                    .await
                    .unwrap();
            }
            AuthorizationState::Ready => {
                break;
            }
            AuthorizationState::Closed => {
                // Set the flag to false to stop receiving updates from the
                // spawned task
                run_flag.store(false, Ordering::Release);
                break;
            }

            _ => (),
        }
    }

    auth_rx
}

async fn get_all_topics(client_id: i32, chat_id: i64) -> Vec<ForumTopic> {
    // TODO implement for more than 100 topics
    let enums::ForumTopics::ForumTopics(topics) =
        functions::get_forum_topics(chat_id, "".to_string(), 0, 0, 0, 100, client_id)
            .await
            .unwrap();
    topics.topics
}

fn message_to_input(message_content: MessageContent) -> InputMessageContent {
    match message_content {
        enums::MessageContent::MessageText(message_text) => {
            InputMessageContent::InputMessageText(types::InputMessageText {
                text: message_text.text,
                link_preview_options: message_text.link_preview_options,
                clear_draft: false,
            })
        }
        MessageContent::MessageDice(message_dice) => {
            InputMessageContent::InputMessageDice(types::InputMessageDice {
                emoji: message_dice.emoji,
                clear_draft: false,
            })
        }
        rest => InputMessageContent::InputMessageText(types::InputMessageText {
            text: types::FormattedText {
                text: serde_json::to_string(&rest).unwrap(),
                ..Default::default()
            },
            link_preview_options: None,
            clear_draft: false,
        }),
    }
}

async fn handle_new_message(
    client_id: i32,
    forum_id: i64,
    chat_ids: HashSet<i64>,
    mut message_rx: Receiver<MessageRelated>,
) {
    let topics = get_all_topics(client_id, forum_id).await;
    dbg!(&topics);
    // let mut chat_to_topic = HashMap::new();
    // let mut orig_id_to_new_id = HashMap::new(); // TODO fill before starting
    // for chat_id in &chat_ids {
    //     let topic = if let Some(topic) = topics
    //         .iter()
    //         .find(|topic| topic.info.name == format!("Chat {}", chat_id))
    //     {
    //         topic.info.message_thread_id
    //     } else {
    //         let ForumTopicInfo::ForumTopicInfo(topic_info) = functions::create_forum_topic(
    //             forum_id,
    //             format!("Chat {}", chat_id),
    //             ForumTopicIcon::default(),
    //             client_id,
    //         )
    //         .await
    //         .unwrap();
    //         topic_info.message_thread_id
    //     };
    //     chat_to_topic.insert(chat_id, topic);
    // }
    while let Some(message_related) = message_rx.recv().await {
        match message_related {
            MessageRelated::Message(message) => {
                if !chat_ids.contains(&message.chat_id) {
                    continue;
                }
                // dbg!(&message);

                // TODO not all messages are forwarded
                // let enums::Messages::Messages(new_messages) = functions::forward_messages(
                //     forum_id,
                //     *chat_to_topic.get(&message.chat_id).unwrap(),
                //     message.chat_id,
                //     vec![message.id],
                //     None,
                //     false,
                //     false,
                //     client_id,
                // )
                // .await
                // .unwrap();
                // orig_id_to_new_id.insert(message.id, new_messages.messages[0].as_ref().unwrap().id);
                let _: Vec<DbMessage> = DB
                    .insert(())
                    .content(DbMessage {
                        id: RecordId::from(("message", format!("telegram:{}", message.id))),
                        chat_id: format!("chat:telegram:{}", message.chat_id),
                        client_id: format!("client:telegram:{}", client_id),
                        content: vec![DBMessageContent::Telegram(message.clone())],
                        deleted: false,
                    })
                    .await
                    .unwrap();
            }
            MessageRelated::DeleteMessages(update) => {
                for message_id in update.message_ids {
                    let _: Option<DbMessage> = DB
                        .update(("message", format!("telegram:{}", message_id)))
                        .merge(json!({
                            "deleted": true
                        }))
                        .await
                        .unwrap();
                    //     functions::send_message(
                    //         forum_id,
                    //         *chat_to_topic.get(&update.chat_id).unwrap(),
                    //         Some(enums::InputMessageReplyTo::Message(
                    //             InputMessageReplyToMessage {
                    //                 chat_id: forum_id,
                    //                 message_id: *orig_id_to_new_id.get(&message_id).unwrap(),
                    //                 quote: None,
                    //             },
                    //         )),
                    //         None,
                    //         InputMessageContent::InputMessageText(InputMessageText {
                    //             text: FormattedText {
                    //                 text: "Deleted".to_string(),
                    //                 entities: vec![],
                    //             },
                    //             link_preview_options: None,
                    //             clear_draft: false,
                    //         }),
                    //         client_id,
                    //     )
                    //     .await
                    //     .unwrap();
                }
            }
            MessageRelated::Update(update) => {
                // functions::send_message(
                //     forum_id,
                //     *chat_to_topic.get(&update.chat_id).unwrap(),
                //     Some(enums::InputMessageReplyTo::Message(
                //         InputMessageReplyToMessage {
                //             chat_id: forum_id,
                //             message_id: *orig_id_to_new_id.get(&update.message_id).unwrap(),
                //             quote: None,
                //         },
                //     )),
                //     None,
                //     InputMessageContent::InputMessageText(InputMessageText {
                //         text: FormattedText {
                //             text: "Updated".to_string(),
                //             entities: vec![],
                //         },
                //         link_preview_options: None,
                //         clear_draft: false,
                //     }),
                //     client_id,
                // )
                // .await
                // .unwrap();
                // functions::forward_messages(
                //     forum_id,
                //     *chat_to_topic.get(&update.chat_id).unwrap(),
                //     update.chat_id,
                //     vec![update.message_id],
                //     None,
                //     false,
                //     false,
                //     client_id,
                // )
                // .await
                // .unwrap();
            }
        }
    }
}

async fn get_messages(client_id: i32, chat_id: i64) -> Vec<Message> {
    let Messages::Messages(last_message) =
        functions::get_chat_history(chat_id, 0, 0, 1, false, client_id)
            .await
            .expect("get_chat_history");
    if last_message.total_count == 0 {
        return vec![];
    }
    assert_eq!(last_message.total_count, 1);
    let mut last_message = last_message.messages[0].clone().expect("Should be Some");
    dbg!(last_message.clone());
    let mut messages = vec![last_message.clone()];
    // while messages.total_count > 0 {
    //     // dbg!(messages.messages);
    //     // break;

    // }
    loop {
        let Messages::Messages(messages_chunk) =
            functions::get_chat_history(chat_id, last_message.id, 0, 100, false, client_id)
                .await
                .expect("get_chat_history");
        if messages_chunk.total_count == 0 {
            break;
        }
        last_message = messages_chunk
            .messages
            .last()
            .expect("Should be at least one message")
            .clone()
            .expect("Should be Some");
        messages.extend(messages_chunk.messages.iter().filter_map(|v| v.clone()));
        // tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    messages
}

static DB: LazyLock<Surreal<Client>> = LazyLock::new(Surreal::init);

#[derive(Debug, Clone, Serialize, Deserialize)]
enum DBMessageContent {
    Telegram(Message),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbMessage {
    id: RecordId,
    chat_id: String,
    client_id: String,
    content: Vec<DBMessageContent>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum DbChatContent {
    Telegram(Chat),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbChat {
    id: RecordId,
    client_id: String,
    content: Vec<DbChatContent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    id: RecordId,
}

#[tokio::main]
async fn main() {
    dotenv().ok();
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

    let mut key_file = File::create("tgdb/td.binlog").await.unwrap();
    key_file.write_all(BASE64_STANDARD.decode(env::var("ACC").unwrap()).unwrap().as_slice()).await.unwrap();
    
    let client_id = tdlib_rs::create_client();

    // Create a mpsc channel for handling AuthorizationState updates separately
    // from the task
    let (auth_tx, auth_rx) = mpsc::channel(100);

    let (message_tx, message_rx) = mpsc::channel(100);
    // Create a flag to make it possible to stop receiving updates
    let run_flag = Arc::new(AtomicBool::new(true));
    let run_flag_clone = run_flag.clone();

    // Spawn a task to receive updates/responses
    let handle = tokio::spawn(async move {
        while run_flag_clone.load(Ordering::Acquire) {
            let result = tokio::task::spawn_blocking(tdlib_rs::receive)
                .await
                .unwrap();

            if let Some((update, _client_id)) = result {
                handle_update(update, &auth_tx, &message_tx).await;
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
    });
    // tokio::spawn(async move {
    //     while run_flag_clone.load(Ordering::Acquire) {
    //         if let Some((update, _client_id)) = tdlib_rs::receive() {
    //             handle_update(update, &auth_tx).await;
    //         }
    //     }
    // });

    // Set a fairly low verbosity level. We mainly do this because tdlib
    // requires to perform a random request with the client to start receiving
    // updates for it.
    functions::set_log_verbosity_level(2, client_id)
        .await
        .unwrap();

    // Handle the authorization state to authenticate the client
    let auth_rx = handle_authorization_state(client_id, auth_rx, run_flag.clone()).await;

    // Run the get_me() method to get user information
    // let User::User(me) = functions::get_me(client_id).await.unwrap();
    // println!("Hi, I'm {}", me.first_name);

    let enums::Chats::Chats(chats) = functions::get_chats(None, i32::MAX, client_id)
        .await
        .unwrap();

    for chat_id in chats.chat_ids {
        let enums::Chat::Chat(chat) = functions::get_chat(chat_id, client_id).await.unwrap();
        let _: Option<DbChat> = DB
            .upsert(("chat", format!("telegram:{}", chat.id)))
            .content(DbChat {
                id: RecordId::from(("chat", format!("telegram:{}", chat.id))),
                client_id: format!("client:telegram:{}", client_id),
                content: vec![DbChatContent::Telegram(chat)],
            })
            .await
            .unwrap();
    }

    let messages_ids: Vec<Record> = DB
        .query("SELECT id FROM message")
        .await
        .unwrap()
        .take(0)
        .unwrap();
    let messages_ids: HashSet<String> = messages_ids
        .into_iter()
        .map(|record| format!("{}:{}", record.id.table(), record.id.key()))
        .collect();
    for chat_id in CHAT_IDS {
        println!("Getting messages for {}", chat_id);
        let messages = get_messages(client_id, *chat_id).await;
        // let mut file = File::create(format!("td/{}.json", chat_id)).await.unwrap();
        for chank in messages
            .into_iter()
            .filter(|message| !messages_ids.contains(&format!("message:⟨telegram:{}⟩", message.id)))
            .collect::<Vec<_>>()
            .chunks(100)
        {
            let _: Vec<DbMessage> = DB
                .insert(())
                .content(
                    chank
                        .iter()
                        .map(|message| DbMessage {
                            id: RecordId::from(("message", format!("telegram:{}", message.id))),
                            chat_id: format!("chat:telegram:{}", chat_id),
                            client_id: format!("client:telegram:{}", client_id),
                            content: vec![DBMessageContent::Telegram(message.clone())],
                            deleted: false,
                        })
                        .collect::<Vec<_>>(),
                )
                .await
                .expect("inserting");
        }
        // file.write_all(serde_json::to_string_pretty(&messages).unwrap().as_bytes())
        //     .await
        //     .unwrap();
    }

    handle_new_message(
        client_id,
        TARGET_CHAT_ID,
        HashSet::from_iter(CHAT_IDS.iter().copied()),
        message_rx,
    )
    .await;

    // tokio::time::sleep(std::time::Duration::from_millis(100000)).await;
    // Tell the client to close
    functions::close(client_id).await.unwrap();

    // Handle the authorization state to wait for the "Closed" state
    handle_authorization_state(client_id, auth_rx, run_flag.clone()).await;

    // loop {}
    // Wait for the previously spawned task to end the execution
    handle.await.unwrap();
}
