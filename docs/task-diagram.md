# CRM Chat - Task-Based Authentication Flow

## Overview

The SpacetimeDB server uses a task-based architecture where tasks flow between **Human** (web UI) and **Robot** (telegram-subscriber worker) processors.

## Task Types

| Task | Type | Description |
|------|------|-------------|
| `SendLoginCode` | Robot | Sends SMS code to phone number |
| `ReceiveLoginCode` | Human | User enters received code |
| `VerifyLoginCode` | Robot | Verifies code with Telegram |
| `ReceivePassword` | Human | User enters 2FA password |
| `VerifyPassword` | Robot | Verifies 2FA password |
| `GenerateQrCode` | Robot | Generates QR codes for scanning |
| `DisplayMessage` | Human | Shows notification to user |

## Phone Authentication Flow

```mermaid
stateDiagram-v2
    direction TB
    
    [*] --> SendLoginCode: User enters phone
    
    state SendLoginCode {
        [*] --> Pending
        Pending --> Success: Code sent
        Pending --> AlreadyAuthorized: Already logged in
        Pending --> Failed: Error
    }
    
    SendLoginCode --> ReceiveLoginCode: Success
    SendLoginCode --> Connected: AlreadyAuthorized
    SendLoginCode --> [*]: Failed
    
    state ReceiveLoginCode {
        [*] --> WaitingForCode
        WaitingForCode --> CodeEntered: User types code
        WaitingForCode --> Aborted: User cancels
    }
    
    ReceiveLoginCode --> VerifyLoginCode: CodeEntered
    ReceiveLoginCode --> [*]: Aborted
    
    state VerifyLoginCode {
        [*] --> Verifying
        Verifying --> Success: Valid code
        Verifying --> PasswordRequired: 2FA enabled
        Verifying --> InvalidCode: Wrong code
        Verifying --> Failed: Error
    }
    
    VerifyLoginCode --> Connected: Success
    VerifyLoginCode --> ReceivePassword: PasswordRequired
    VerifyLoginCode --> ReceiveLoginCode: InvalidCode (retry)
    VerifyLoginCode --> [*]: Failed
    
    state ReceivePassword {
        [*] --> WaitingForPassword
        WaitingForPassword --> PasswordEntered: User types password
        WaitingForPassword --> Aborted: User cancels
    }
    
    ReceivePassword --> VerifyPassword: PasswordEntered
    ReceivePassword --> [*]: Aborted
    
    state VerifyPassword {
        [*] --> Verifying2FA
        Verifying2FA --> Success: Valid password
        Verifying2FA --> InvalidPassword: Wrong password
        Verifying2FA --> Failed: Error
    }
    
    VerifyPassword --> Connected: Success
    VerifyPassword --> ReceivePassword: InvalidPassword (retry)
    VerifyPassword --> [*]: Failed
    
    Connected --> [*]
```

## QR Code Authentication Flow

```mermaid
stateDiagram-v2
    direction TB
    
    [*] --> GenerateQrCode: User requests QR
    
    state GenerateQrCode {
        [*] --> Pending
        Pending --> Token: New QR token
        Token --> Token: Token expired, new one
        Token --> Authorized: User scanned
        Token --> Cancelled: User cancelled
        Token --> Failed: Error
    }
    
    GenerateQrCode --> Connected: Authorized
    GenerateQrCode --> [*]: Cancelled
    GenerateQrCode --> [*]: Failed
    
    Connected --> [*]
```

## Sequence Diagram - Phone Auth

```mermaid
sequenceDiagram
    participant User as Web UI (Human)
    participant SDB as SpacetimeDB
    participant Robot as Telegram Worker (Robot)
    participant TG as Telegram API
    
    User->>SDB: createTask(SendLoginCode, phone)
    SDB->>SDB: Create Client (SendingLoginCode)
    Robot->>SDB: Poll for Robot tasks
    SDB-->>Robot: SendLoginCode task
    Robot->>TG: Send auth code
    TG-->>Robot: Code sent, token
    Robot->>SDB: completeTask(Success, token)
    SDB->>SDB: Create ReceiveLoginCode task
    SDB->>SDB: Update Client (ReceivingLoginCode)
    
    User->>SDB: completeTask(code)
    SDB->>SDB: Create VerifyLoginCode task
    SDB->>SDB: Update Client (VerifyingLoginCode)
    Robot->>SDB: Poll for Robot tasks
    SDB-->>Robot: VerifyLoginCode task
    Robot->>TG: Verify code
    
    alt Code Valid
        TG-->>Robot: Success
        Robot->>SDB: completeTask(Success)
        SDB->>SDB: Update Client (Connected)
    else 2FA Required
        TG-->>Robot: Password required
        Robot->>SDB: completeTask(PasswordRequired)
        SDB->>SDB: Create ReceivePassword task
        Note over User,SDB: Password flow continues...
    else Invalid Code
        TG-->>Robot: Invalid
        Robot->>SDB: completeTask(InvalidCode)
        SDB->>SDB: Create new ReceiveLoginCode task
        Note over User,SDB: User can retry
    end
```

## Client Status State Machine

```mermaid
stateDiagram-v2
    direction LR
    
    [*] --> SendingLoginCode: Phone auth start
    [*] --> GeneratingQrCode: QR auth start
    
    SendingLoginCode --> ReceivingLoginCode: Code sent
    SendingLoginCode --> Connected: Already auth'd
    SendingLoginCode --> Error: Failed
    
    ReceivingLoginCode --> VerifyingLoginCode: Code entered
    ReceivingLoginCode --> [*]: Cancelled
    
    VerifyingLoginCode --> Connected: Success
    VerifyingLoginCode --> ReceivingPassword: 2FA required
    VerifyingLoginCode --> ReceivingLoginCode: Invalid code
    VerifyingLoginCode --> Error: Failed
    
    ReceivingPassword --> VerifyingPassword: Password entered
    ReceivingPassword --> [*]: Cancelled
    
    VerifyingPassword --> Connected: Success
    VerifyingPassword --> ReceivingPassword: Invalid password
    VerifyingPassword --> Error: Failed
    
    GeneratingQrCode --> Connected: Scanned
    GeneratingQrCode --> [*]: Cancelled
    GeneratingQrCode --> Error: Failed
    
    Connected --> [*]: Deleted
    Error --> [*]: Deleted
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web UI (React)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ QR Code     │  │ Phone Input │  │ Code/Password Input     │  │
│  │ Component   │  │ Component   │  │ Components              │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                      │                │
│         └────────────────┴──────────────────────┘                │
│                          │                                       │
│                   SpacetimeDB SDK                                │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SpacetimeDB Server                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                     Tasks Table                          │    │
│  │  ┌───────────┬──────────┬────────────────┬──────────┐   │    │
│  │  │ id        │ owner    │ payload        │ status   │   │    │
│  │  ├───────────┼──────────┼────────────────┼──────────┤   │    │
│  │  │ uuid-1    │ human-1  │ SendLoginCode  │ Assigned │   │    │
│  │  │ uuid-2    │ human-1  │ ReceiveCode    │ Pending  │   │    │
│  │  └───────────┴──────────┴────────────────┴──────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Reducers: createTask, completeTask, cancelTask, updateTask     │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Telegram Subscriber (Robot)                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Task Executor                                           │    │
│  │  • Polls SpacetimeDB for Robot tasks                    │    │
│  │  • Executes Telegram API calls                          │    │
│  │  • Updates task output via completeTask                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  grammers (Telegram MTProto Client)                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```
