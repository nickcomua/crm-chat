# CRM Chat - Business Logic Documentation

## Table of Contents
1. [System Architecture Overview](#1-system-architecture-overview)
2. [Data Model](#2-data-model)
3. [Authentication Flows](#3-authentication-flows)
4. [Client Lifecycle](#4-client-lifecycle)
5. [Chat & Message Sync Pipeline](#5-chat--message-sync-pipeline)
6. [Media Download Pipeline](#6-media-download-pipeline)
7. [Task Queue & Orchestration](#7-task-queue--orchestration)
8. [Authorization Matrix](#8-authorization-matrix)
9. [Error Handling](#9-error-handling)

---

## 1. System Architecture Overview

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                         FRONTEND (React + Vite)                        │
 │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
 │  │ Auth UI  │  │ Chat List│  │ Messages │  │  Media   │              │
 │  │(Phone/QR)│  │          │  │          │  │ Gallery  │              │
 │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
 │       │              │              │              │                    │
 │       └──────────────┴──────────────┴──────────────┘                   │
 │                              │                                         │
 │              Clerk JWT  ─────┤──── useQuery / useMutation              │
 └──────────────────────────────┼─────────────────────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │    CONVEX BACKEND      │
                    │  (Self-hosted :3210)   │
                    │                        │
                    │  ┌──────────────────┐  │
                    │  │  8 Tables        │  │
                    │  │  Queries         │  │
                    │  │  Mutations       │  │
                    │  │  Task Queue      │  │
                    │  │  Scheduler       │  │
                    │  └──────────────────┘  │
                    └──┬─────────────────┬──┘
                       │                 │
           Clerk JWT   │                 │  Robot RS256 JWT
           (Humans)    │                 │  (Workers)
                       │                 │
                       │    ┌────────────▼───────────────┐
                       │    │      CRM-WORKER (Rust)     │
                       │    │                            │
                       │    │  ┌──────────────────────┐  │
                       │    │  │  TaskOrchestrator     │  │
                       │    │  │  (tokio loop)         │  │
                       │    │  │  Subscribes to        │  │
                       │    │  │  pending tasks        │  │
                       │    │  └──────────┬───────────┘  │
                       │    │             │               │
                       │    │  ┌──────────▼───────────┐  │
                       │    │  │  Restate Runtime      │  │
                       │    │  │  (Durable Execution)  │  │
                       │    │  │                       │  │
                       │    │  │  7 Services:          │  │
                       │    │  │  - PhoneAuthWorkflow  │  │
                       │    │  │  - QrAuthWorkflow     │  │
                       │    │  │  - DialogSync         │  │
                       │    │  │  - UpdateListener     │  │
                       │    │  │  - ProfilePhotoSync   │  │
                       │    │  │  - ChatScanner        │  │
                       │    │  │  - MediaDownloader    │  │
                       │    │  └──────────┬───────────┘  │
                       │    └─────────────┼──────────────┘
                       │                  │
                       │     ┌────────────▼──────────┐
                       │     │   TELEGRAM API         │
                       │     │   (grammers client)    │
                       │     └────────────────────────┘
```

### Dual Authentication

```
  Human (Browser)                    Robot (crm-worker)
       │                                  │
  Clerk JWT                        RS256 Self-Signed JWT
  (issuer: clerk.dev)              (issuer: crm-chat-robot.local)
       │                                  │
       ▼                                  ▼
  ┌──────────────────────────────────────────┐
  │           Convex Auth Layer              │
  │                                          │
  │  requireHuman()  ◄─── Frontend calls     │
  │  requireWorker() ◄─── Worker calls       │
  │  requireOwner()  ◄─── Resource ownership │
  └──────────────────────────────────────────┘
```

---

## 2. Data Model

### Entity-Relationship Diagram

```
  ┌─────────────────┐        ┌─────────────────────┐
  │   HUMANS        │        │   NOTIFICATIONS      │
  │  (Clerk-managed)│        │                      │
  │                 │   1:N  │  _id                 │
  │  userId ◄───────┼────────┤  userId              │
  │                 │        │  severity (Info|      │
  │                 │        │    Warning|Error)     │
  │                 │        │  message              │
  │                 │        │  dismissed             │
  └──────┬──────────┘        └─────────────────────┘
         │
         │ 1:N
         ▼
  ┌──────────────────────┐
  │     CLIENTS           │
  │                       │
  │  _id                  │        ┌──────────────────────┐
  │  userId ──────────────┼────►   │   PHONE AUTHS        │
  │  kind ("Telegram")    │  1:N   │                      │
  │  telegramId           │        │  _id                 │
  │  status ──────────┐   │◄──────┤  clientId             │
  │  scanningChatIds   │   │       │  userId              │
  │  mediaSettings?    │   │       │  phone               │
  │                    │   │       │  step (state machine) │
  └──┬────────┬────────┘   │       │  phoneCodeHash?      │
     │        │             │       │  loginCode?          │
     │        │             │       │  password?           │
     │        │             │       │  claimedByWorkerId?  │
     │        │             │       └──────────────────────┘
     │        │             │
     │        │             │       ┌──────────────────────┐
     │        │             │       │   QR AUTHS           │
     │        │             │       │                      │
     │        │             │  1:N  │  _id                 │
     │        │             ├──────►│  userId              │
     │        │             │       │  step (state machine) │
     │        │             │       │  qrUrl?              │
     │        │             │       │  qrExpires?          │
     │        │             │       │  telegramUserId?     │
     │        │             │       │  claimedByWorkerId?  │
     │        │             │       └──────────────────────┘
     │        │
     │ 1:N    │ 1:N
     │        │
     ▼        ▼
  ┌──────────────────────┐       ┌──────────────────────┐
  │     CHATS             │       │   WORKER TASKS       │
  │                       │       │                      │
  │  _id                  │       │  _id                 │
  │  chatId (telegram ID) │       │  task (union of 15   │
  │  userId               │       │    typed variants)   │
  │  clientId ─────►      │       │  status (Pending|    │
  │  chatType (Dialog|    │       │    Dispatched)       │
  │    Group)             │       │  createdAt           │
  │  isPinned             │       │  dispatchedAt?       │
  │  lastMessageTimestamp │       └──────────────────────┘
  │  scanEnabled?         │
  │  fullScanned?         │
  │  scanPhase?           │
  │  mediaSettings?       │
  │  photoStorageId? ──►_storage
  │  totalMessages?       │
  │  syncedMessages?      │
  └──────┬────────────────┘
         │
         │ 1:N (via chatId string)
         ▼
  ┌──────────────────────┐
  │     MESSAGES          │
  │                       │
  │  _id                  │
  │  messageId (convex)   │
  │  externalId (telegram)│
  │  userId               │
  │  clientId ─────►      │
  │  chatId ──────► chats │
  │  senderId             │
  │  text?                │
  │  outgoing             │
  │  deleted              │
  │  timestamp            │
  │  mediaExternalId? ──┐ │
  │  mediaKind?         │ │
  └─────────────────────┼─┘
                        │
         ┌──────────────▼─────────────┐
         │     MEDIA                   │
         │                             │
         │  _id                        │
         │  telegramFileId             │
         │  userId                     │
         │  clientId ─────►            │
         │  chatId                     │
         │  messageId ──► messages     │
         │  status (Pending|Downloading│
         │    |Stored|Failed|Skipped)  │
         │  storageId? ──────► _storage│
         │  kind (Photo|Video|Audio|   │
         │    Voice|Sticker|Animation| │
         │    Document|VideoNote)      │
         │  mimeType?, fileName?       │
         │  fileSize?, bytesDownloaded?│
         │  width?, height?, duration? │
         │  downloadedAt?, error?      │
         └─────────────────────────────┘
```

### Table Summary

| Table | Records | Key Indexes | Purpose |
|-------|---------|-------------|---------|
| **clients** | Per Telegram account | `by_userId`, `by_userId_telegramId` | Telegram client connections |
| **chats** | Per conversation | `by_userId_lastMessageTimestamp`, `by_clientId` | Dialog/Group metadata |
| **messages** | Per message | `by_chatId_timestamp`, `by_externalId` | Message content & metadata |
| **media** | Per media file | `by_clientId_status`, `by_telegramFileId` | Media download tracking |
| **phoneAuths** | Per auth attempt | `by_step`, `by_clientId` | Phone login state machine |
| **qrAuths** | Per QR attempt | `by_step`, `by_userId` | QR login state machine |
| **notifications** | Per alert | `by_userId_dismissed` | User-facing notifications |
| **workerTasks** | Per async job | `by_status` | Task queue for workers |

---

## 3. Authentication Flows

### 3.1 Phone Authentication State Machine

```
                    User enters phone number
                           │
                           ▼
                   ┌───────────────┐
                   │  SendingCode  │◄──── Client created (Authenticating)
                   └───────┬───────┘      Worker task: PhoneAuth:run
                           │
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌────────────┐  ┌──────────┐   ┌───────────┐
     │ WaitingCode│  │AlreadyAuth│  │  Failed   │
     │            │  │→Connected │  │ (terminal) │
     └─────┬──────┘  └──────────┘  └───────────┘
           │
           │  User enters 5-digit SMS code
           ▼
     ┌──────────────┐
     │VerifyingCode │◄──── Worker task: PhoneAuth:submitCode
     └──────┬───────┘
            │
   ┌────────┼──────────┬───────────────┬──────────┐
   ▼        ▼          ▼               ▼          ▼
Connected  Invalid   Password       SignUp     Failed
(terminal) Code →    Required       Required   (terminal)
           back to                  (terminal)
           WaitingCode
                       │
                       ▼
              ┌─────────────────┐
              │ WaitingPassword │◄──── Shows password hint
              └────────┬────────┘
                       │
                       │  User enters 2FA password
                       ▼
              ┌──────────────────┐
              │VerifyingPassword │◄──── Worker task: PhoneAuth:submitPassword
              └────────┬─────────┘
                       │
              ┌────────┼────────────┐
              ▼        ▼            ▼
          Connected  Invalid     Failed
          (terminal) Password    (terminal)
                     → back to
                     WaitingPassword


  ★ Any non-terminal step ──── User clicks Cancel ────► Cancelled (terminal)
    (deletes client, enqueues PhoneAuth:cancel worker task)
```

### 3.2 QR Authentication State Machine

```
                     User clicks "Login with QR"
                            │
                            ▼
                    ┌───────────────┐
                    │    Pending    │◄──── Worker task: QrAuth:run
                    └───────┬───────┘
                            │
                            │  Worker claims
                            ▼
                    ┌───────────────┐
                    │  Generating   │◄──── Worker connects to Telegram
                    └───────┬───────┘
                            │
                            │  QR URL generated
                            ▼
                    ┌───────────────┐
                    │    Token      │◄──── QR displayed to user
                    │  (qrUrl,     │      Waiting for scan...
                    │   qrExpires) │
                    └───────┬───────┘
                            │
              ┌─────────────┼────────────┐
              ▼             ▼            ▼
     ┌──────────────┐  ┌─────────────┐  ┌─────────┐
     │  Authorized  │  │  Already    │  │ Failed  │
     │  (terminal)  │  │ Authorized  │  │(terminal)│
     │              │  │  (terminal) │  └─────────┘
     └──────┬───────┘  └──────┬──────┘
            │                 │
            └────────┬────────┘
                     │
                     ▼
          Client created/updated
          status → Connected
          Services started


  ★ Any non-terminal step ──── User clicks Cancel ────► Cancelled (terminal)
```

### 3.3 Interaction Between Human and Worker

```
  HUMAN (Frontend)              CONVEX                    WORKER (Restate)
       │                          │                            │
       │  phoneAuth.start()       │                            │
       ├─────────────────────────►│  Create Client             │
       │                          │  Create PhoneAuth          │
       │                          │  Enqueue PhoneAuth:run     │
       │                          │────────────────────────────►│
       │                          │                            │  Connect to Telegram
       │                          │                            │  Send SMS code
       │                          │  workerCompleteSendCode()  │
       │                          │◄────────────────────────────│
       │                          │  step → WaitingCode        │
       │                          │                            │
       │  useQuery(active) ◄──────│  Returns public auth doc   │
       │  Shows code input        │                            │
       │                          │                            │
       │  phoneAuth.submitCode()  │                            │
       ├─────────────────────────►│  step → VerifyingCode      │
       │                          │  Enqueue PhoneAuth:submit  │
       │                          │────────────────────────────►│
       │                          │                            │  Verify with Telegram
       │                          │  workerCompleteVerify...() │
       │                          │◄────────────────────────────│
       │                          │  step → Connected          │
       │                          │  Client → Connected        │
       │                          │  Enqueue DialogSync        │
       │                          │  Enqueue UpdateListener    │
       │                          │────────────────────────────►│
       │                          │                            │  Begin sync...
```

---

## 4. Client Lifecycle

```
                         ┌─────────────────────┐
                         │   Phone/QR Auth      │
                         │   completes          │
                         └──────────┬───────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                   CLIENT: Connected                         │
  │                                                             │
  │  Automatic services started:                                │
  │                                                             │
  │  ┌──────────────┐    ┌──────────────────┐                   │
  │  │ DialogSync   │───►│ enqueuePostSync  │                   │
  │  │ :sync        │    │ Tasks            │                   │
  │  └──────────────┘    └───────┬──────────┘                   │
  │                              │                              │
  │                    ┌─────────┼─────────────┐                │
  │                    ▼                       ▼                │
  │         ┌──────────────────┐   ┌────────────────────┐       │
  │         │ ProfilePhotoSync │   │ ChatScanner:scan   │       │
  │         │ :sync            │   │ (per enabled chat) │       │
  │         └──────────────────┘   └─────────┬──────────┘       │
  │                                          │                  │
  │                                          ▼                  │
  │                               ┌──────────────────┐          │
  │                               │ MediaDownloader  │          │
  │                               │ :download        │          │
  │                               │ (per media file) │          │
  │                               └──────────────────┘          │
  │                                                             │
  │  Long-lived service:                                        │
  │  ┌──────────────────┐                                       │
  │  │ UpdateListener   │◄──── Streams new messages in          │
  │  │ :listen          │      real-time from Telegram          │
  │  └──────────────────┘                                       │
  └──────────────────────────────────────────┬──────────────────┘
                                             │
                                             │  User deletes client
                                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                   CLIENT: Deleted                            │
  │                                                             │
  │  1. Cancel any active phone auth sessions                   │
  │  2. Enqueue UpdateListener:stop                             │
  │  3. Enqueue ProfilePhotoSync:stop                           │
  │  4. Delete client record                                    │
  └─────────────────────────────────────────────────────────────┘
```

### Client Service Dependency Chain

```
  Auth Complete
       │
       ├──► DialogSync:sync ──────────────────┐
       │    (fetch all dialogs from Telegram)  │
       │                                       │  on complete
       └──► UpdateListener:listen              │
            (stream real-time updates)         ▼
                                        enqueuePostSyncTasks()
                                               │
                                    ┌──────────┴──────────┐
                                    │                     │
                                    ▼                     ▼
                          ProfilePhotoSync     ChatScanner:scan
                          :sync                (for each chat with
                          (download avatars)    scanEnabled && !fullScanned)
                                                      │
                                                      ▼
                                              MediaDownloader:download
                                              (per media file found)
```

---

## 5. Chat & Message Sync Pipeline

### 5.1 Chat Scanning Lifecycle

```
  User enables scanning for a chat
       │
       ▼
  updateScanEnabled(chatId, true)
       │
       ├── scanEnabled = true
       ├── If !fullScanned → Enqueue ChatScanner:scan
       │
       ▼
  ┌──────────────────────────────────────────────────────────┐
  │  CHAT SCANNING PHASES                                    │
  │                                                          │
  │  ┌────────────────────┐                                  │
  │  │  ScanningMessages  │  Sync messages from Telegram     │
  │  │                    │  Update totalMessages,            │
  │  │                    │  syncedMessages counts            │
  │  └────────┬───────────┘                                  │
  │           │                                              │
  │           ▼                                              │
  │  ┌────────────────────┐                                  │
  │  │ DownloadingMedia   │  Process pending media files     │
  │  │                    │  (filtered by mediaSettings)     │
  │  └────────┬───────────┘                                  │
  │           │                                              │
  │           ▼                                              │
  │  ┌────────────────────┐                                  │
  │  │    Listening        │  Initial scan complete           │
  │  │                    │  fullScanned = true               │
  │  │                    │  New messages via UpdateListener  │
  │  └────────────────────┘                                  │
  └──────────────────────────────────────────────────────────┘
```

### 5.2 Message Upsert with Auto-Media Creation

```
  Worker calls messages.upsert() with media
       │
       ▼
  ┌─────────────────────────────────┐
  │  Message has mediaExternalId?   │
  │  and mediaKind?                 │
  └─────────────┬───────────────────┘
                │ Yes
                ▼
  ┌─────────────────────────────────┐
  │  Check Media Settings           │
  │                                 │
  │  Priority:                      │
  │  1. Chat-level mediaSettings    │
  │  2. Client-level mediaSettings  │
  │  3. Default: save everything    │
  │                                 │
  │  Setting keys per kind:         │
  │  Photo     → savePhotos         │
  │  Video     → saveVideos         │
  │  Audio     → saveAudio          │
  │  Voice     → saveVoice          │
  │  Sticker   → saveStickers       │
  │  Document  → saveDocuments      │
  │  Animation → saveAnimations     │
  │  VideoNote → saveVideoNotes     │
  └─────────┬───────────┬──────────┘
            │           │
     Should Save    Should Skip
            │           │
            ▼           ▼
    Create media   Create media
    status:Pending status:Skipped
            │
            ▼
    Enqueue MediaDownloader:download
```

### 5.3 Chat Data Purge (on scan disable)

```
  User disables scanning
       │
       ▼
  updateScanEnabled(chatId, false)
       │
       ├── scanEnabled = false
       ├── fullScanned = false
       ├── Schedule purgeChatData()
       │
       ▼
  ┌──────────────────────────────────────┐
  │  purgeChatData() [self-scheduling]   │
  │                                      │
  │  1. Guard: is chat still disabled?   │──► No → Stop (user re-enabled)
  │  2. Delete 200 messages              │
  │  3. Delete 200 media + storage files │
  │  4. More records?                    │
  │     ├── Yes → Re-schedule self       │
  │     └── No  → Done                   │
  └──────────────────────────────────────┘
```

---

## 6. Media Download Pipeline

### 6.1 Media Status State Machine

```
                ┌─────────────┐
                │   Pending   │◄──── Created by message upsert
                └──────┬──────┘      or createPending()
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
  ┌──────────────┐ ┌────────┐  ┌─────────┐
  │ Downloading  │ │Skipped │  │ Failed  │
  │              │ │        │  │         │
  │ bytesDown-   │ │(user   │  │(error   │
  │ loaded       │ │settings│  │stored)  │
  │ updated      │ │or user │  │         │
  └──────┬───────┘ │cancel) │  └────┬────┘
         │         └───┬────┘       │
         ▼             │            │
  ┌──────────────┐     │     User retryDownload()
  │   Stored     │     │            │
  │              │     │            ▼
  │ storageId →  │     │     Reset to Pending
  │ _storage     │     │
  │ downloadedAt │     │  User requestDownload()
  └──────────────┘     │     (from Skipped)
                       │            │
                       │            ▼
                       │     Reset to Pending
                       │
                  User cancelDownload()
                  (from Pending/Downloading)
                       │
                       ▼
                    Skipped
```

### 6.2 Media Download Concurrency Control

```
  ┌──────────────────────────────────────────────────────────────┐
  │  TaskOrchestrator subscribes to pendingForWorker             │
  │  with maxMediaWorkflows = N (configurable)                   │
  │                                                              │
  │  Convex query logic:                                         │
  │                                                              │
  │  Dispatched MediaDownloader tasks:  count = D                │
  │  Available slots:                   N - D                    │
  │                                                              │
  │  Example: maxMediaWorkflows = 3                              │
  │                                                              │
  │  Dispatched: [Media:A, Media:B]     → D = 2                 │
  │  Available slots:                   → 3 - 2 = 1             │
  │                                                              │
  │  Pending tasks:                                              │
  │  [PhoneAuth:run, Media:C, Media:D, ChatScanner:scan]        │
  │                                                              │
  │  Returned to worker:                                         │
  │  [PhoneAuth:run, Media:C, ChatScanner:scan]                 │
  │   ^^^^^^^^^^^^^^^^         ^^^^^^^^^^^^^^^                   │
  │   Non-media: always        Non-media: always                │
  │   returned                 returned                          │
  │                   ^^^^^^^                                    │
  │                   1 media slot filled                        │
  │                   Media:D excluded (no slots)                │
  └──────────────────────────────────────────────────────────────┘
```

### 6.3 Media Settings Composition

```
  ┌─────────────────────────┐     ┌────────────────────────────┐
  │  Client-Level Settings  │     │  Chat-Level Settings       │
  │  (global defaults)      │     │  (per-chat overrides)      │
  │                         │     │                            │
  │  savePhotos:    true    │     │  savePhotos:    undefined  │──► Fall through
  │  saveVideos:    false   │     │  saveVideos:    true       │──► Override!
  │  saveAudio:     true    │     │  saveAudio:     undefined  │──► Fall through
  │  saveVoice:     true    │     │  saveStickers:  false      │──► Override!
  │  saveStickers:  true    │     │                            │
  │  saveDocuments: true    │     └────────────────────────────┘
  │  saveAnimations:true    │
  │  saveVideoNotes:true    │     Effective for this chat:
  └─────────────────────────┘     ┌────────────────────────────┐
                                  │  Photos:     true  (client)│
                                  │  Videos:     true  (chat!) │
                                  │  Audio:      true  (client)│
                                  │  Voice:      true  (client)│
                                  │  Stickers:   false (chat!) │
                                  │  Documents:  true  (client)│
                                  │  Animations: true  (client)│
                                  │  VideoNotes: true  (client)│
                                  └────────────────────────────┘
```

---

## 7. Task Queue & Orchestration

### 7.1 Task Types (15 Variants)

```
  workerTask (discriminated union on "type")
  │
  ├── Authentication ───────────────────────────────────────────
  │   ├── PhoneAuth:run             { authId, doc }
  │   ├── PhoneAuth:submitCode      { authId }
  │   ├── PhoneAuth:submitPassword  { authId }
  │   ├── PhoneAuth:cancel          { authId }
  │   ├── QrAuth:run                { authId, doc }
  │   └── QrAuth:cancel             { authId }
  │
  ├── Client Lifecycle ─────────────────────────────────────────
  │   ├── DialogSync:sync           { clientId, userId, telegramId }
  │   ├── UpdateListener:listen     { clientId, userId, telegramId }
  │   ├── UpdateListener:stop       { clientId }
  │   ├── ProfilePhotoSync:sync     { clientId, userId, telegramId }
  │   └── ProfilePhotoSync:stop     { clientId }
  │
  ├── Chat Operations ──────────────────────────────────────────
  │   └── ChatScanner:scan          { chatId, clientId, userId }
  │
  └── Media ────────────────────────────────────────────────────
      └── MediaDownloader:download  { telegramFileId, userId,
                                      clientId, telegramId,
                                      chatId, kind, mimeType?,
                                      fileSize? }
```

### 7.2 Task Lifecycle

```
  Mutation enqueues task
       │
       ▼
  ┌──────────────────────────┐
  │  enqueueTask()           │
  │                          │
  │  Dedup check:            │
  │  - Same (type, key)      │
  │    in Pending?  → skip   │
  │  - Same (type, key)      │
  │    in Dispatched? → skip │
  │  - Otherwise → insert    │
  └────────────┬─────────────┘
               │
               ▼
  ┌────────────────────────┐         ┌────────────────────────┐
  │  workerTasks table     │         │  TaskOrchestrator      │
  │                        │  sub    │  (Rust tokio loop)     │
  │  status: "Pending"     │◄────────│                        │
  │  createdAt: now        │         │  Subscribes to         │
  │                        │         │  pendingForWorker()    │
  └────────────────────────┘         └───────────┬────────────┘
                                                 │
                                     For each pending task:
                                                 │
                                     ┌───────────▼────────────┐
                                     │ 1. markDispatched()    │
                                     │    status → Dispatched │
                                     │    dispatchedAt: now   │
                                     │                        │
                                     │ 2. HTTP POST to Restate│
                                     │    /{service}/{key}    │
                                     │    /{handler}/send     │
                                     └───────────┬────────────┘
                                                 │
                                                 ▼
                                     ┌────────────────────────┐
                                     │  Restate Service       │
                                     │  (durable execution)   │
                                     │                        │
                                     │  Runs handler...       │
                                     │  Calls Convex mutations│
                                     │  to update state       │
                                     └────────────────────────┘
```

### 7.3 Deduplication Keys

| Task Type | Dedup Key | Effect |
|-----------|-----------|--------|
| `PhoneAuth:*` | `authId` | One task per auth session |
| `QrAuth:*` | `authId` | One task per auth session |
| `DialogSync:sync` | `clientId` | One sync per client |
| `UpdateListener:*` | `clientId` | One listener per client |
| `ProfilePhotoSync:*` | `clientId` | One sync per client |
| `ChatScanner:scan` | `chatId` | One scanner per chat |
| `MediaDownloader:download` | `telegramFileId` | One download per file |

### 7.4 Task → Restate Service Mapping

```
  Task Type                    Restate Service       Key          Handler
  ─────────────────────────    ───────────────────   ──────────   ───────────
  PhoneAuth:run               PhoneAuthWorkflow      authId       run
  PhoneAuth:submitCode        PhoneAuthWorkflow      authId       submitCode
  PhoneAuth:submitPassword    PhoneAuthWorkflow      authId       submitPassword
  PhoneAuth:cancel            PhoneAuthWorkflow      authId       cancel
  QrAuth:run                  QrAuthWorkflow         authId       run
  QrAuth:cancel               QrAuthWorkflow         authId       cancel
  DialogSync:sync             DialogSync             clientId     sync
  UpdateListener:listen       UpdateListener         clientId     listen
  UpdateListener:stop         UpdateListener         clientId     stop
  ProfilePhotoSync:sync       ProfilePhotoSync       clientId     sync
  ProfilePhotoSync:stop       ProfilePhotoSync       clientId     stop
  ChatScanner:scan            ChatScanner            chatId       scan
  MediaDownloader:download    MediaDownloader        fileId       download
```

### 7.5 Crash Recovery & Cleanup

```
  Worker starts up
       │
       ├── resetDispatched()
       │   Find all Dispatched tasks → reset to Pending
       │   (Tasks stranded by previous crash)
       │
       ├── Register existing Telegram sessions
       │   Scan disk for .session files
       │   Call workerRegisterConnected() for each
       │
       └── Begin subscription loop
            pendingForWorker() → process → markDispatched() → POST Restate


  Background cleanup (self-scheduling internal mutation):
       │
       └── cleanup()
           Find Dispatched tasks older than 1 hour
           Delete in batches of 200
           Re-schedule if more remain
```

---

## 8. Authorization Matrix

### Mutations

| Operation | Human | Worker | Notes |
|-----------|:-----:|:------:|-------|
| **Phone Auth** | | | |
| `start` | O | | Creates client + auth |
| `submitCode` | O | | Must own auth |
| `submitPassword` | O | | Must own auth |
| `cancel` | O | | Must own auth, deletes client |
| `workerClaim` | | O | Must be unclaimed |
| `workerCompleteSendCode` | | O | Must be assigned worker |
| `workerCompleteVerifyCode` | | O | Must be assigned worker |
| `workerCompleteVerifyPassword` | | O | Must be assigned worker |
| **QR Auth** | | | |
| `start` | O | | Creates auth |
| `cancel` | O | | Must own auth |
| `workerClaim` | | O | Must be unclaimed |
| `workerUpdateQrToken` | | O | Must be assigned worker |
| `workerCompleteQrAuth` | | O | Must be assigned worker |
| **Clients** | | | |
| `deleteClient` | O | | Must own client |
| `workerRegisterConnected` | | O | Creates/updates client |
| **Chats** | | | |
| `upsert` | O | O | Both can create/update |
| `updateScanEnabled` | O | | Must own chat |
| `updateMediaSettings` | O | | Must own chat |
| `rescan` | O | | Must own chat |
| `markFullScanned` | | O | |
| `updateSyncProgress` | | O | |
| `updatePhoto` | | O | |
| **Messages** | | | |
| `upsert` | O | O | Auto-creates media |
| `markDeleted` | O | O | Soft delete |
| **Media** | | | |
| `generateUploadUrl` | O | | |
| `createPending` | | O | |
| `startDownload` | | O | |
| `updateProgress` | | O | |
| `storeMedia` | | O | |
| `markFailed` | | O | |
| `markSkipped` | | O | |
| `retryDownload` | O | | From Failed |
| `cancelDownload` | O | | From Pending/Downloading |
| `requestDownload` | O | | From Skipped |
| **Notifications** | | | |
| `dismiss` | O | | Must own notification |
| **Worker Tasks** | | | |
| `markDispatched` | | O | |
| `enqueuePostSyncTasks` | | O | |
| `resetDispatched` | | O | |

### Queries

| Query | Human | Worker | Returns |
|-------|:-----:|:------:|---------|
| `clients.list` | O | | User's clients |
| `clients.getForWorker` | | O | Single client |
| `chats.list` | O | | Scan-enabled chats + photo URLs |
| `chats.listByClient` | O | | Chats for a client |
| `chats.listForWorker` | | O | Chats for a client |
| `messages.listByChat` | O | | Paginated messages |
| `messages.getLastPerChat` | O | | Last message per chat |
| `phoneAuth.active` | O | | Non-terminal auths (secrets stripped) |
| `qrAuth.active` | O | | Non-terminal QR auths |
| `qrAuth.listForUser` | O | | Active + most recent terminal |
| `notifications.list` | O | | Undismissed notifications |
| `media.getForMessages` | O | | Media + storage URLs |
| `media.getForChat` | O | | All media for chat |
| `media.listByStatus` | O | | Media by download status |
| `media.countByStatus` | O | | Status counts |
| `media.countByStatusForChat` | O | | Per-chat status counts |
| `media.listPendingForClient` | | O | Download queue |
| `workerTasks.pendingForWorker` | | O | Task queue |

---

## 9. Error Handling

### 9.1 Result Type Pattern

All mutations return a Rust-inspired `Result<T>`:

```typescript
type Result<T> = { ok: true; value: T } | { ok: false; error: string }
```

Benefits:
- No opaque "Server Error" messages
- Frontend can display specific error messages
- Type-safe success/failure branching

### 9.2 Notification System

Errors during worker operations generate user-facing notifications:

```
  Worker encounters error
       │
       ▼
  sendError(ctx, userId, message)
       │
       ▼
  ┌──────────────────────────┐
  │  notifications table     │
  │                          │
  │  severity: "Error"       │
  │  message: "Invalid code" │
  │  dismissed: false        │
  └──────────────────────────┘
       │
       │  useQuery(notifications.list)
       ▼
  Frontend shows toast/banner
       │
       │  User clicks dismiss
       ▼
  notifications.dismiss()
```

### 9.3 Worker Claiming (Optimistic Locking)

```
  PhoneAuth/QrAuth record:
  ┌────────────────────────────┐
  │  claimedByWorkerId: null   │
  └─────────────┬──────────────┘
                │
      Worker A calls workerClaim()
                │
                ▼
  ┌────────────────────────────┐
  │  claimedByWorkerId: "A"   │
  └─────────────┬──────────────┘
                │
      Worker B calls workerClaim()
                │
                ▼
         REJECTED (already claimed)

      Only Worker A can call
      workerComplete*() mutations
      (requireAssignedWorker check)
```

### 9.4 Orphaned Storage Cleanup

When media records are deleted (e.g., during chat purge) but download was in-flight:

```
  Worker calls storeMedia(telegramFileId, storageId)
       │
       ▼
  Media record found?
  ├── No (deleted by purge) → Delete orphaned storage file
  ├── Status not Downloading/Pending → Delete orphaned storage file
  └── OK → Update to Stored
```

---

## Appendix: Complete Data Flow - End to End

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  1. USER AUTHENTICATES                                             │
  │                                                                    │
  │  Phone/QR Auth → Client created → Status: Connected                │
  └────────────────────────────────────────┬────────────────────────────┘
                                           │
  ┌────────────────────────────────────────▼────────────────────────────┐
  │  2. INITIAL SYNC                                                    │
  │                                                                    │
  │  DialogSync:sync → Fetch all Telegram dialogs                      │
  │  → Create Chat records (isPinned ones get scanEnabled=true)        │
  │  → UpdateListener:listen starts (background)                       │
  └────────────────────────────────────────┬────────────────────────────┘
                                           │
  ┌────────────────────────────────────────▼────────────────────────────┐
  │  3. POST-SYNC ORCHESTRATION                                         │
  │                                                                    │
  │  enqueuePostSyncTasks():                                           │
  │  → ProfilePhotoSync:sync (download chat avatars)                   │
  │  → ChatScanner:scan (per enabled chat)                             │
  └────────────────────────────────────────┬────────────────────────────┘
                                           │
  ┌────────────────────────────────────────▼────────────────────────────┐
  │  4. CHAT SCANNING                                                   │
  │                                                                    │
  │  ChatScanner processes each chat:                                  │
  │  → Phase: ScanningMessages (fetch message history)                 │
  │  → messages.upsert() per message                                   │
  │    → Auto-creates Media records (filtered by settings)             │
  │    → Enqueues MediaDownloader:download tasks                       │
  │  → Phase: DownloadingMedia                                         │
  │  → Phase: Listening (fullScanned = true)                           │
  └────────────────────────────────────────┬────────────────────────────┘
                                           │
  ┌────────────────────────────────────────▼────────────────────────────┐
  │  5. REAL-TIME UPDATES                                               │
  │                                                                    │
  │  UpdateListener receives new Telegram messages:                    │
  │  → messages.upsert() → auto media creation                        │
  │  → chats.upsert() → update lastMessageTimestamp                   │
  │  → Frontend reacts via useQuery subscriptions                      │
  └────────────────────────────────────────┬────────────────────────────┘
                                           │
  ┌────────────────────────────────────────▼────────────────────────────┐
  │  6. USER INTERACTIONS                                               │
  │                                                                    │
  │  Toggle chat scanning → enable/disable + purge                     │
  │  Adjust media settings → per-chat or per-client                    │
  │  Retry failed downloads → re-enqueue MediaDownloader               │
  │  Cancel downloads → mark Skipped                                   │
  │  Request skipped → re-enqueue MediaDownloader                      │
  │  Rescan chat → reset fullScanned, re-enqueue ChatScanner           │
  │  Delete client → stop services, cancel auths, delete record        │
  │  Dismiss notifications → mark dismissed                            │
  └─────────────────────────────────────────────────────────────────────┘
```
