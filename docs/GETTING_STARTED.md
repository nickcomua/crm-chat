# CRM Chat — Getting Started

CRM Chat is a personal CRM assistant that connects to your Telegram account, syncs conversations, and provides an organized view of your contacts with message history and media.

## What You'll Need

1. **A Clerk account** — handles user login ([clerk.com](https://clerk.com))
2. **Telegram API credentials** — allows CRM Chat to access your Telegram messages ([my.telegram.org](https://my.telegram.org))
3. **Docker** — runs the backend services

## Setup

### 1. Get Telegram API Credentials

1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone number
2. Click **API development tools**
3. Create a new application (name and platform don't matter)
4. Note your **API ID** (`TG_ID`) and **API Hash** (`TG_HASH`)

### 2. Set Up Clerk Authentication

CRM Chat uses [Clerk](https://clerk.com) for user authentication. You need three keys:

| Key | Where to Find | Purpose |
|-----|---------------|---------|
| Publishable key (`pk_...`) | Clerk Dashboard → API Keys | Browser-side login |
| Secret key (`sk_...`) | Clerk Dashboard → API Keys | Server-side auth verification |
| M2M secret (`ak_...`) | Clerk Dashboard → Machines | Worker service authentication |

**Setting up M2M (machine-to-machine) auth:**

1. In the Clerk Dashboard, go to **Machines**
2. Create a new machine client
3. Copy the secret key — this is your `CLERK_M2M_SECRET_KEY`

The worker service uses this key to authenticate with Convex as a "robot" user, separate from human browser sessions.

### 3. Deploy

See the [Deployment Guide](DEPLOYMENT.md) for Docker deployment or [Local Setup](LOCAL_SETUP.md) for development.

Quick version:

```bash
cp .env.example .env
# Fill in: TG_ID, TG_HASH, CLERK_M2M_SECRET_KEY, VITE_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY

docker compose up -d
docker compose exec backend ./generate_admin_key.sh
# Copy the key into .env as CONVEX_SELF_HOSTED_ADMIN_KEY

cd bins/convex-backend && bun install
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY=<key-from-above> \
bun x convex deploy
```

## Using CRM Chat

### Connecting Your Telegram Account

1. Open the web interface and sign in with Clerk
2. Click **Add Account** to connect a Telegram account
3. Choose an authentication method:
   - **Phone number** — enter your phone, receive an SMS code, and optionally enter your 2FA password
   - **QR code** — scan the QR code with the Telegram app on your phone

Once connected, the worker starts syncing your Telegram dialogs.

### How Sync Works

After connecting, CRM Chat goes through these phases:

1. **Dialog Sync** — fetches your chat list from Telegram (contacts, groups)
2. **Listening** — subscribes to new incoming/outgoing messages in real-time
3. **Chat Scanning** — for chats you enable, downloads full message history
4. **Media Download** — downloads photos, videos, documents from scanned chats
5. **Profile Photo Sync** — downloads contact profile pictures

### Viewing Conversations

- The **chat list** shows all synced Telegram conversations, sorted by most recent message
- Click a chat to view its full message history
- Messages update in real-time as new ones arrive
- Use **search** to find messages across all chats

### Enabling Chat Scanning

By default, chats are synced but not fully scanned. To download the complete history of a chat:

1. Open the chat
2. Enable **scanning** for that chat
3. The worker will download all messages and (optionally) media

You can configure per-chat media download settings to control which types of media are saved (photos, videos, documents, voice messages, etc.).

### Media Management

CRM Chat can download and store media from your Telegram chats:

- **Photos, videos, audio, documents, voice messages, stickers, animations, video notes**
- Media download respects per-chat settings — you control what gets saved
- Failed downloads can be retried from the UI
- Media is stored in Convex file storage

## Architecture Overview

For a detailed technical overview, see [Architecture](ARCHITECTURE.md).

```
┌─────────┐     ┌───────────┐     ┌──────────┐
│ Browser  │◄───►│  Convex   │◄───►│  Worker  │◄───► Telegram
│ (React)  │     │ (Backend) │     │  (Rust)  │
└─────────┘     └───────────┘     └──────────┘
     │               │                  │
   Clerk          Database           Restate
   Auth           + Storage         Workflows
```

- **Browser**: React app with real-time Convex subscriptions
- **Convex**: Self-hosted database, functions, and file storage
- **Worker**: Rust service that connects to Telegram and syncs data
- **Restate**: Durable workflow engine for reliable multi-step operations

## Further Reading

- [Local Development Setup](LOCAL_SETUP.md) — full dev environment setup
- [Deployment Guide](DEPLOYMENT.md) — Docker production deployment
- [Architecture](ARCHITECTURE.md) — system design, data flow, and schema diagrams
- [Environment Variables](ENVIRONMENT.md) — complete env var reference
