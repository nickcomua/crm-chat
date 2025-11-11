use sdb_api::module_bindings::{Client, ClientKind, ClientTableAccess, DbConnection, SubscriptionEventContext};
use spacetimedb_sdk::{DbContext, Table};

fn connect_to_db(token: String, module_name: String, uri: String) -> DbConnection {
    DbConnection::builder()
        // Register our `on_connect` callback, which will save our auth token.
        // .on_connect(on_connected)
        // // Register our `on_connect_error` callback, which will print a message, then exit the process.
        // .on_connect_error(on_connect_error)
        // // Our `on_disconnect` callback, which will print a message, then exit the process.
        // .on_disconnect(on_disconnected)
        // If the user has previously connected, we'll have saved a token in the `on_connect` callback.
        // In that case, we'll load it and pass it to `with_token`,
        // so we can re-authenticate as the same `Identity`.
        .with_token(Some(token))
        // Set the database name we chose when we called `spacetime publish`.
        .with_module_name(module_name)
        // Set the URI of the SpacetimeDB host that's running our database.
        .with_uri(uri)
        // Finalize configuration and connect!
        .build()
        .expect("Failed to connect")
}

fn on_subscription_applied(ctx: &SubscriptionEventContext) {
    ctx.db.client().iter().for_each(|client| {
        println!("client: {:?}", client);
    });
}

async fn run_client(client: &Client){
    if client.kind != ClientKind::Telegram {
        println!("not a telegram client: {:?}", client);
        return;
    }
    messanger_telegram::GrammersSessionStore::new(Session::new())
}


async fn spawn_telegram_subscriber(ctx: &DbConnection) {

    ctx.db.client().on_insert(|ctx,client | {
        // println!("client: {:?}", ctx.event.);
    });

    ctx.subscription_builder()
        .on_applied(on_subscription_applied)
        .subscribe(["select * from client"]);
}

fn main() {}
