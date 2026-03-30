# CRM Chat — Architecture

## System Architecture

```mermaid
graph TB
    subgraph Browser
        React[React App<br/>Vite + shadcn/ui]
        ClerkUI[Clerk Auth UI]
    end

    subgraph Docker["Docker Compose"]
        Convex[Convex Backend<br/>port 3210/3211]
        Dashboard[Convex Dashboard<br/>port 6791]
        Restate[Restate<br/>port 8080/9070]
        Worker[crm-worker<br/>Rust]
        Web[Web Server]
    end

    subgraph External
        Telegram[Telegram API]
        ClerkAPI[Clerk API]
        Sentry[Sentry<br/>optional]
        ES[Elasticsearch<br/>optional]
    end

    React -->|WebSocket subscriptions| Convex
    React -->|mutations| Convex
    ClerkUI -->|JWT| ClerkAPI
    React --> ClerkUI

    Worker -->|queries + mutations| Convex
    Worker -->|M2M JWT| ClerkAPI
    Worker -->|connects via grammers| Telegram
    Worker <-->|durable workflows| Restate

    Dashboard -->|admin API| Convex
    Web -->|serves| React

    Worker -.->|errors| Sentry
    React -.->|errors| Sentry
    Worker -.->|embeddings| ES
```

## Components

### Frontend (`bins/crm-chat-web`)

React single-page application built with Vite.

- **Convex React SDK** — real-time data subscriptions via `useQuery()` and mutations via `useMutation()`
- **Clerk** — user authentication, wrapped in `ConvexProviderWithClerk`
- **TanStack Router** — file-based routing
- **shadcn/ui** — UI component library (Radix UI primitives)
- **React Compiler** — automatic memoization (no manual `useMemo`/`useCallback`)
- **Ultracite** — Biome-based linting and formatting

### Convex Backend (`bins/convex-backend`)

Self-hosted Convex instance serving as the database, function runtime, and file storage.

- **Schema** defined in `convex/schema.ts` with table definitions in `convex/model/`
- **Dual auth**: Clerk JWTs for humans, Clerk M2M JWTs for the worker
- Auth helpers (`requireHuman()`, `requireWorker()`) enforce access control per-function
- **Domain-driven dispatch**: state changes in the database trigger worker actions via Convex subscriptions (no explicit task queues)

### Worker (`bins/crm-worker`)

Rust service that bridges Telegram and Convex.

- Connects to Convex via the Rust SDK and subscribes to queries
- Uses **grammers** (Rust Telegram client library) for Telegram connections
- Registers with **Restate** for durable workflow execution
- Services: `DialogSync`, `ChatScanner`, `MediaDownloader`, `UpdateListener`, `ProfilePhotoSync`, `PhoneAuthWorkflow`, `QrAuthWorkflow`

### Restate

Durable workflow orchestration engine. The worker registers its services with Restate, which handles:

- Reliable invocation with automatic retries
- Workflow state persistence across restarts
- Concurrency control (e.g., `MAX_MEDIA_WORKFLOWS`)

### Shared Libraries

| Library | Path | Purpose |
|---------|------|---------|
| `messanger-interface` | `libs/messanger-interface` | Platform-agnostic messenger traits (`MessengerClient`, `ChatSummary`, `MessageSummary`) |
| `messanger-telegram` | `libs/messanger-telegram` | Telegram implementation using grammers |
| `hack` | `libs/hack` | Shared utilities |
| `convex-typegen` | `libs/convex-typegen` | Generates Rust types from `convex/schema.ts` |

## Data Flow

### Message Sync Flow

```mermaid
sequenceDiagram
    participant TG as Telegram
    participant W as Worker
    participant R as Restate
    participant C as Convex
    participant UI as Browser

    Note over W,C: Worker subscribes to client phases

    W->>C: Subscribe to clients.pendingWork
    C-->>W: Client with phase=NeedsSync

    W->>R: Register DialogSync workflow
    R->>W: Invoke DialogSync.sync(clientId)

    W->>C: workerStartSync(clientId)
    W->>TG: Fetch dialog list
    TG-->>W: Dialogs

    loop Each dialog
        W->>C: workerUpsertChat(chat)
    end

    W->>C: workerCompleteSync(clientId)
    Note over C: phase → Listening

    C-->>W: Subscription fires: phase=Listening
    W->>R: Register UpdateListener
    R->>W: Invoke UpdateListener.listen(clientId)

    W->>TG: Subscribe to updates
    TG-->>W: New message

    W->>C: workerUpsertMessage(message)
    C-->>UI: Real-time subscription update
```

### Chat Scanning Flow

```mermaid
sequenceDiagram
    participant UI as Browser
    participant C as Convex
    participant W as Worker
    participant R as Restate
    participant TG as Telegram

    UI->>C: updateScanEnabled(chatId, true)
    Note over C: scanPhase → Queued

    W->>C: Subscribe to chats.pendingWork
    C-->>W: Chat with scanPhase=Queued

    W->>R: Register ChatScanner workflow
    R->>W: Invoke ChatScanner.scan(chatId)

    W->>C: workerStartScan(chatId)
    Note over C: scanPhase → ScanningMessages

    loop Paginate through history
        W->>TG: Get messages (offset)
        TG-->>W: Message batch

        loop Each message
            W->>C: workerUpsertMessage(msg)
            opt Has media
                W->>C: workerCreatePendingMedia(media)
            end
        end

        W->>C: workerUpdateSyncProgress(chatId, progress)
        C-->>UI: Progress update
    end

    W->>C: workerCompleteScan(chatId)
    Note over C: scanPhase → Listening, fullScanned=true
```

### Phone Authentication Flow

```mermaid
sequenceDiagram
    participant UI as Browser
    participant C as Convex
    participant W as Worker
    participant TG as Telegram

    UI->>C: phoneAuth.start(phone)
    Note over C: Create Client + PhoneAuth<br/>step=SendingCode

    W->>C: Subscribe to phoneAuths.pendingWork
    C-->>W: PhoneAuth with step=SendingCode

    W->>TG: Send login code to phone
    TG-->>W: phoneCodeHash

    W->>C: workerCompleteSendCode(Success)
    Note over C: step → WaitingCode
    C-->>UI: Show code input

    UI->>C: phoneAuth.submitCode(code)
    Note over C: step → VerifyingCode

    C-->>W: Subscription: step=VerifyingCode
    W->>TG: Verify code + phoneCodeHash
    TG-->>W: Success / PasswordRequired / Failed

    alt Success
        W->>C: workerCompleteVerifyCode(Success)
        Note over C: Client → Connected, phase=NeedsSync
    else Password Required (2FA)
        W->>C: workerCompleteVerifyCode(PasswordRequired)
        Note over C: step → WaitingPassword
        C-->>UI: Show password input

        UI->>C: phoneAuth.submitPassword(password)
        Note over C: step → VerifyingPassword
        C-->>W: Subscription fires

        W->>TG: Verify password
        TG-->>W: Success

        W->>C: workerCompleteVerifyPassword(Success)
        Note over C: Client → Connected
    else Failed
        W->>C: workerCompleteVerifyCode(Failed)
        Note over C: step → Failed, send notification
    end
```

### QR Code Authentication Flow

```mermaid
sequenceDiagram
    participant UI as Browser
    participant C as Convex
    participant W as Worker
    participant TG as Telegram

    UI->>C: qrAuth.start()
    Note over C: Create Client + QrAuth<br/>step=Pending

    W->>C: Subscribe to qrAuths.pendingWork
    C-->>W: QrAuth with step=Pending

    W->>TG: Request QR login token
    TG-->>W: QR token URL + expiry

    W->>C: workerUpdateToken(qrUrl, qrExpires)
    Note over C: step → Token
    C-->>UI: Display QR code

    Note over UI: User scans QR<br/>with Telegram app

    TG-->>W: Authorization callback
    W->>C: workerComplete(Authorized, telegramUserId)
    Note over C: Client → Connected, phase=NeedsSync
    C-->>UI: Auth complete
```

### Media Download Flow

```mermaid
sequenceDiagram
    participant C as Convex
    participant W as Worker
    participant R as Restate
    participant TG as Telegram

    Note over C: Media record created with status=Pending<br/>(by message upsert or chat scan)

    W->>C: Subscribe to media.pendingWork
    C-->>W: Media with status=Pending

    W->>R: Register MediaDownloader workflow
    R->>W: Invoke MediaDownloader.download(mediaId)

    W->>C: workerStartMediaDownload(telegramFileId)
    Note over C: status → Downloading

    W->>TG: Download file
    loop Progress chunks
        TG-->>W: Data chunk
        W->>C: workerUpdateMediaProgress(bytes)
    end

    W->>C: generateUploadUrl()
    C-->>W: Upload URL

    W->>C: Upload file to storage
    W->>C: workerStoreMedia(storageId, metadata)
    Note over C: status → Stored
```

## Database Schema

```mermaid
erDiagram
    clients {
        string userId "Clerk token identifier"
        string kind "Telegram"
        string telegramId "telegram:+phone or telegram:id"
        string externalId "Telegram numeric user ID"
        string phoneNumber "optional"
        array scanningChatIds "legacy"
        object status "Authenticating | Connected | Error"
        string phase "Authenticating | NeedsSync | Syncing | Listening | Disconnected"
        boolean photosSynced
        object mediaSettings "per-client download prefs"
    }

    chats {
        string chatId "unique chat identifier"
        string userId "owner (Clerk token)"
        id clientId FK "references clients"
        string chatType "Dialog | Group"
        boolean isPinned
        string pinnedName "custom display name"
        number lastMessageTimestamp "Unix ms"
        boolean scanEnabled "full history scan"
        boolean fullScanned
        string scanPhase "Queued | ScanningMessages | DownloadingMedia | Listening"
        number totalMessages
        number syncedMessages
        id photoStorageId "profile photo in Convex storage"
        string photoExternalId
        object mediaSettings "per-chat download prefs"
    }

    messages {
        string messageId "unique message identifier"
        string externalId "Telegram message ID"
        string userId "owner (Clerk token)"
        id clientId FK "references clients"
        string chatId FK "references chats.chatId"
        string senderId
        string text "optional"
        boolean outgoing
        boolean deleted "soft delete"
        number timestamp "Unix ms"
        string mediaExternalId "Telegram file ID"
        string mediaKind "Photo | Video | Audio | ..."
        string replyToMessageId
        string replyToText
        object forwardedFrom "senderName + date"
        array reactions "emoji + count + recent users"
    }

    media {
        string telegramFileId "Telegram file reference"
        string userId "owner (Clerk token)"
        id clientId FK "references clients"
        string chatId FK "references chats.chatId"
        string messageId FK "references messages.messageId"
        string status "Pending | Downloading | Stored | Failed | Skipped"
        id storageId "Convex file storage ID"
        string kind "Photo | Video | Audio | Voice | Document | Sticker | Animation | VideoNote"
        string mimeType
        string fileName
        number fileSize
        number bytesDownloaded
        number downloadedAt "Unix ms"
        number width
        number height
        number duration
        string error
    }

    phoneAuths {
        string userId "owner (Clerk token)"
        id clientId FK "references clients"
        string phone "international format"
        string step "SendingCode | WaitingCode | VerifyingCode | WaitingPassword | VerifyingPassword | Connected | Failed | Cancelled"
        string phoneCodeHash "secret - worker only"
        string loginCode "secret - worker only"
        string passwordToken "secret - worker only"
        string password "secret - worker only"
        string passwordHint "shown to user"
        string error
        string claimedByWorkerId
        number updatedAt "Unix ms"
    }

    qrAuths {
        string userId "owner (Clerk token)"
        id clientId FK "references clients"
        string step "Pending | Generating | Token | Authorized | AlreadyAuthorized | Failed | Cancelled"
        string qrUrl "QR code login URL"
        number qrExpires "Unix ms"
        bigint telegramUserId
        string phoneNumber
        string error
        number updatedAt "Unix ms"
    }

    notifications {
        string userId "owner (Clerk token)"
        string severity "Info | Warning | Error"
        string message
        boolean dismissed
    }

    clients ||--o{ chats : "has"
    clients ||--o{ phoneAuths : "authenticates via"
    clients ||--o{ qrAuths : "authenticates via"
    chats ||--o{ messages : "contains"
    chats ||--o{ media : "stores media for"
    messages ||--o| media : "may have"
    clients ||--o{ notifications : "receives"
```

## Domain-Driven Dispatch

CRM Chat uses a **domain-driven dispatch** pattern instead of explicit task queues. The pattern works as follows:

1. **State change**: A mutation updates a record's phase/status/step (e.g., `client.phase = "NeedsSync"`)
2. **Reconciler query**: The worker subscribes to `pendingWork` queries that scan for records in actionable states
3. **Workflow dispatch**: When the subscription fires, the worker registers a Restate workflow for the work item
4. **Completion**: The workflow updates the record's state to its next phase, which may trigger further work

This pattern provides:
- **Consistency**: The database is the single source of truth for what needs doing
- **Idempotency**: Re-reading the query after a restart rediscovers incomplete work
- **Cancellation**: Setting a terminal state (e.g., `Cancelled`, `Disconnected`) causes cancel-watcher subscriptions to fire, stopping active workflows

### Reconciler Work Items

| Source | Service | Trigger State | Action |
|--------|---------|---------------|--------|
| `clients.pendingWork` | `DialogSync` | `phase=NeedsSync` | Sync Telegram dialog list |
| `clients.pendingWork` | `UpdateListener` | `phase=Listening` | Subscribe to real-time updates |
| `clients.pendingWork` | `ProfilePhotoSync` | `phase=Listening, photosSynced=false` | Download contact photos |
| `chats.pendingWork` | `ChatScanner` | `scanPhase=Queued` | Download full chat history |
| `media.pendingWork` | `MediaDownloader` | `status=Pending` | Download media file |
| `phoneAuths.pendingWork` | `PhoneAuthWorkflow` | `step=SendingCode\|VerifyingCode\|VerifyingPassword` | Drive phone auth flow |
| `qrAuths.pendingWork` | `QrAuthWorkflow` | `step=Pending` | Drive QR auth flow |

## CI/CD Pipeline

```mermaid
graph LR
    Push[Git Push] --> Check[nix flake check<br/>Linux + macOS]
    Push --> |main branch| Docker[Build Docker Images]

    Check --> Clippy[Clippy lint]
    Check --> Fmt[Format check]
    Check --> Audit[cargo audit/deny]
    Check --> Test[cargo nextest]

    Docker --> BuildWorker[crm-worker image<br/>amd64 + arm64]
    Docker --> BuildWeb[crm-chat-web image<br/>amd64 + arm64]
    BuildWorker --> Push2Hub[Push to Docker Hub<br/>nick395/crm-worker]
    BuildWeb --> Push2Hub2[Push to Docker Hub<br/>nick395/crm-chat-web]

    Push2Hub --> Integration[Integration Tests<br/>Playwright]
    Push2Hub2 --> Integration
```

- **check.yml**: Runs on every push — clippy, rustfmt, alejandra (Nix formatting), cargo audit, cargo nextest across Linux (x86 + ARM) and macOS
- **docker.yml**: Runs on `main` — builds multi-arch Docker images via Nix and pushes to Docker Hub
- **integration-tests.yml**: Runs after Docker build or on manual trigger — Playwright browser tests against a running instance
