# Overnight Work Summary (2026-01-29 evening → morning)

## ✅ Completed Tasks

### 1. Rolled Back Clerk Authentication
- **Removed**: ClerkProvider, sign-in route, Clerk hooks
- **Restored**: Simple localStorage token auth (no login required)
- **Files changed**:
  - `bins/crm-chat-web/src/main.tsx` - removed ClerkProvider
  - `bins/crm-chat-web/src/routes/_auth.tsx` - removed Clerk hooks
  - `bins/crm-chat-web/src/routes/sign-in.tsx` - deleted

### 2. Anonymous Connections Support
- **Updated** `bins/sdb_server/src/user.rs`
- **Changed**: `client_connected` reducer to allow connections without JWT
- Anonymous users get a basic `Human` record created automatically
- Maintains backward compatibility with authenticated users (Robot + Human with JWT)

### 3. Auto-Clear Invalid Tokens
- **Updated** `bins/crm-chat-web/src/routes/_auth.tsx`
- **Added**: Error handler that detects token validation failures
- Automatically clears invalid localStorage tokens and retries connection
- Prevents "401 Unauthorized" errors on stale Clerk tokens

### 4. Improved TaskID Generation
- **Updated** `bins/crm-chat-web/src/hooks/use-task.ts`
- **Changed**: From `crypto.randomUUID()` to `${Date.now()}-${randomString}`
- More reliable format for debugging
- Added console logging for task creation

### 5. Build & Deploy
- Built web app: `nick395/crm-chat-web:latest` and `:fixed`
- Published server module to SpacetimeDB maincloud with changes
- Robot (telegram-subscriber) confirmed running and processing tasks

## ⚠️ Known Issues

### WebSocket Connection Problem (Critical)
**Status**: Not yet resolved

**Symptoms**:
- Browser connects to SpacetimeDB but WebSocket closes immediately
- Connection keeps retrying but never stays open
- Tasks are NOT being created in the database (confirmed via SQL query)
- UI shows "Generating QR code..." indefinitely

**Evidence**:
```
Console errors:
- WebSocket connection to 'wss://maincloud.spacetimedb.com/...' failed
- Creating QR auth task with ID: 1769724788761-8y5ig4m8efi
```

**Database check**:
```bash
SELECT * FROM task  # Returns 0 rows
```

**Robot status**: ✅ Working perfectly
- Generates QR tokens every ~30 seconds
- Processes old tasks from database
- No errors in logs

**Possible causes**:
1. SpacetimeDB SDK issue with anonymous (no-token) connections
2. Server `client_connected` reducer rejecting connections
3. WebSocket handshake failing at network/proxy level
4. SpacetimeDB maincloud requiring authentication even for anonymous clients

**Next steps to debug**:
- [ ] Check SpacetimeDB SDK source for anonymous connection handling
- [ ] Test connection with valid SpacetimeDB token
- [ ] Add more detailed logging to `client_connected` reducer
- [ ] Test direct WebSocket connection with `wscat` or similar
- [ ] Check if SpacetimeDB maincloud allows anonymous connections

## 📝 Git Commits

```
cd6504e - feat: add server-side createQrAuthTask reducer
5647552 - fix: roll back Clerk auth, enable anonymous connections
```

## 🔄 Deployment Status

- ✅ Server: Published to maincloud.spacetimedb.com
- ✅ Web: Deployed to https://crm-chat.kaminazuma.com
- ✅ Robot: Running on local machine (PID in /tmp/tg-sub.log)
- ❌ E2E flow: Blocked by WebSocket connection issue

## 📊 Testing Results

| Component | Status | Notes |
|-----------|--------|-------|
| Web UI loads | ✅ | No sign-in required |
| SpacetimeDB connection | ❌ | WebSocket closes immediately |
| Task creation from web | ❌ | No tasks in database |
| Robot task processing | ✅ | Generates QR tokens successfully |
| Dialog opens | ✅ | Shows "Generating QR code..." |
| QR code display | ❌ | Never receives task data |

## 🎯 Priority Next Steps

1. **Fix WebSocket connection** (blocker for everything else)
2. Once connection works:
   - Test QR code display
   - Test end-to-end QR auth flow
   - Verify task cleanup after completion
3. Push changes to origin
4. Update documentation

## 📂 Modified Files

```
bins/crm-chat-web/src/main.tsx
bins/crm-chat-web/src/routes/_auth.tsx
bins/crm-chat-web/src/hooks/use-task.ts
bins/sdb_server/src/user.rs
libs/sdb_api/src/module_bindings/create_qr_auth_task_reducer.rs
libs/sdb_api/src/module_bindings/mod.rs
```

---

*Generated: 2026-01-30 ~04:00 AM*
