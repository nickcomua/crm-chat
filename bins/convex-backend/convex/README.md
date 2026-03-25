# Convex Backend

Self-hosted Convex backend for CRM Chat. Handles Telegram client authentication, chat/message storage, and real-time subscriptions.

## Data Model

```mermaid
erDiagram
    clients {
        id _id PK
        string userId
        string kind "Telegram"
        string externalId "phone or user_id"
        array activeChats
        object status "Authenticating | Connected | Error"
    }
    chats {
        id _id PK
        string chatId UK "composite key"
        string userId
        id clientId FK
        string chatType "Dialog | Group"
        boolean isPinned
        string pinnedName
        number lastMessageTs
    }
    messages {
        id _id PK
        string messageId UK "composite key"
        string externalId "Telegram msg ID"
        string userId
        id clientId FK
        string chatId FK
        string senderId
        string text
        boolean out "sent by owner"
        boolean deleted
        number ts
    }
    phoneAuths {
        id _id PK
        string userId
        id clientId FK
        string phone
        string step "state machine"
        string assignedRobot
        number updatedAt
    }
    qrAuths {
        id _id PK
        string userId
        string step "state machine"
        string qrUrl
        number qrExpires
        string assignedRobot
        number updatedAt
    }
    notifications {
        id _id PK
        string userId
        string severity "Info | Warning | Error"
        string message
        boolean dismissed
    }

    clients ||--o{ chats : "has"
    clients ||--o{ messages : "has"
    clients ||--o| phoneAuths : "authenticates via"
    chats ||--o{ messages : "contains"
```

## Authentication

Dual JWT auth system — both validated by the same Clerk provider:

- **Clerk JWTs** — for human users (frontend). Subject: `user_*`.
- **Clerk M2M JWTs** — for worker services (crm-worker). Subject: `mch_*`.

Auth helpers in `helpers/auth.ts`:

| Helper | Purpose |
|--------|---------|
| `requireAuth()` | Extract caller identity, throw if unauthenticated |
| `requireHuman()` | Restrict to Clerk human users |
| `requireWorker()` | Restrict to Clerk M2M workers (`mch_` subject prefix) |
| `isWorkerCaller()` | Check if caller is a worker (no throw) |
| `requireOwner()` | Verify resource ownership (row-level security) |
| `sendError()` | Insert an error notification for a user |

## Phone Auth State Machine

```mermaid
stateDiagram-v2
    [*] --> SendingCode : human.start(phone)
    SendingCode --> SendingCode : robot.claim()
    SendingCode --> WaitingCode : robot.completeSendCode(Success)
    SendingCode --> Connected : robot.completeSendCode(AlreadyAuthorized)
    SendingCode --> Failed : robot.completeSendCode(Failed)
    WaitingCode --> VerifyingCode : human.submitCode(code)
    VerifyingCode --> Connected : robot.completeVerifyCode(Success)
    VerifyingCode --> WaitingCode : robot.completeVerifyCode(InvalidCode)
    VerifyingCode --> WaitingPassword : robot.completeVerifyCode(PasswordRequired)
    VerifyingCode --> Failed : robot.completeVerifyCode(SignUpRequired)
    VerifyingCode --> Failed : robot.completeVerifyCode(Failed)
    WaitingPassword --> VerifyingPassword : human.submitPassword(pw)
    VerifyingPassword --> Connected : robot.completeVerifyPassword(Success)
    VerifyingPassword --> WaitingPassword : robot.completeVerifyPassword(InvalidPassword)
    VerifyingPassword --> Failed : robot.completeVerifyPassword(Failed)
    SendingCode --> Cancelled : human.cancel()
    WaitingCode --> Cancelled : human.cancel()
    WaitingPassword --> Cancelled : human.cancel()
    Connected --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

## QR Auth State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending : human.start()
    Pending --> Generating : robot.claim()
    Generating --> Token : robot.updateQrToken(url, expires)
    Token --> Token : robot.updateQrToken() (refresh)
    Token --> Authorized : robot.completeQrAuth(Authorized)
    Token --> AlreadyAuthorized : robot.completeQrAuth(AlreadyAuthorized)
    Generating --> Failed : robot.completeQrAuth(Failed)
    Token --> Failed : robot.completeQrAuth(Failed)
    Pending --> Cancelled : human.cancel()
    Generating --> Cancelled : human.cancel()
    Token --> Cancelled : human.cancel()
    Authorized --> [*]
    AlreadyAuthorized --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

## Robot–Human Interaction

```mermaid
sequenceDiagram
    participant H as Human (Frontend)
    participant C as Convex Backend
    participant R as Robot (telegram-subscriber)

    H->>C: phoneAuth.start({phone})
    Note over C: Client(Authenticating) + PhoneAuth(SendingCode)

    R-->>C: subscribe(pendingForRobot)
    C-->>R: [PhoneAuth{SendingCode}]
    R->>C: phoneAuth.robotClaim({authId})

    R->>Telegram: Send login code
    R->>C: phoneAuth.robotCompleteSendCode(Success)
    Note over C: PhoneAuth → WaitingCode
    C-->>H: reactive update

    H->>C: phoneAuth.submitCode({authId, code})
    Note over C: PhoneAuth → VerifyingCode

    R-->>C: subscribe(assignedToRobot)
    C-->>R: [PhoneAuth{VerifyingCode}]
    R->>Telegram: Verify code
    R->>C: phoneAuth.robotCompleteVerifyCode(Success)
    Note over C: PhoneAuth → Connected, Client → Connected
    C-->>H: reactive update
```

## API Reference

### Queries

| Function | Access | Args | Returns | Description |
|----------|--------|------|---------|-------------|
| `clients.list` | Human | — | `ClientDoc[]` | All clients for current user |
| `chats.list` | Human | — | `ChatDoc[]` | Chats sorted by lastMessageTs desc |
| `messages.listByChat` | Human | `chatId` | `MessageDoc[]` | Messages for a chat (ownership verified) |
| `notifications.list` | Human | — | `NotificationDoc[]` | Undismissed notifications |
| `phoneAuth.active` | Human | — | `PhoneAuthPublicDoc[]` | Active phone auths (secrets stripped) |
| `qrAuth.listForUser` | Human | — | `QrAuthDoc[]` | Active + most recent terminal QR auth |
| `qrAuth.active` | Human | — | `QrAuthDoc[]` | Active QR auths only |
| `phoneAuth.pendingForRobot` | Worker | — | `PhoneAuthDoc[]` | Unclaimed phone auths |
| `phoneAuth.assignedToRobot` | Worker | — | `PhoneAuthDoc[]` | Phone auths assigned to caller |
| `qrAuth.pendingForRobot` | Worker | — | `QrAuthDoc[]` | Unclaimed QR auths |
| `qrAuth.assignedToRobot` | Worker | — | `QrAuthDoc[]` | QR auths assigned to caller |

### Mutations

| Function | Access | Description |
|----------|--------|-------------|
| `clients.deleteClient` | Human | Delete client + cancel active phone auths |
| `chats.upsert` | Human/Robot | Create or update a chat |
| `chats.deleteChat` | Human/Robot | Delete a chat |
| `messages.upsert` | Human/Robot | Create or update a message |
| `messages.markDeleted` | Human/Robot | Soft-delete a message |
| `notifications.dismiss` | Human | Dismiss a notification |
| `phoneAuth.start` | Human | Start phone auth flow |
| `phoneAuth.submitCode` | Human | Submit SMS verification code |
| `phoneAuth.submitPassword` | Human | Submit 2FA password |
| `phoneAuth.cancel` | Human | Cancel phone auth |
| `phoneAuth.robotClaim` | Worker | Claim a pending phone auth |
| `phoneAuth.robotCompleteSendCode` | Worker | Report SMS send result |
| `phoneAuth.robotCompleteVerifyCode` | Worker | Report code verification result |
| `phoneAuth.robotCompleteVerifyPassword` | Worker | Report password verification result |
| `qrAuth.start` | Human | Start QR auth flow |
| `qrAuth.cancel` | Human | Cancel QR auth |
| `qrAuth.robotClaim` | Worker | Claim a pending QR auth |
| `qrAuth.robotUpdateQrToken` | Worker | Provide QR code URL |
| `qrAuth.robotCompleteQrAuth` | Worker | Report QR auth result |
