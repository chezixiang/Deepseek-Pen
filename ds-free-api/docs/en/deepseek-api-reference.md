# DeepSeek Endpoint Reference

### Base URLs
- `https://chat.deepseek.com/api/v0` — All API endpoints
- `https://fe-static.deepseek.com` — WASM file download

### Common Headers
- All requests: `User-Agent` required (WAF bypass)
- Auth requests: `Authorization: Bearer <token>`
- PoW requests: `X-Ds-Pow-Response: <base64>`

### Error Response Formats
- **Missing field** → HTTP 422: `{"detail":[{"loc":"body.<field>"}]}`
- **Invalid Token** → HTTP 200: `{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}`
- **Business Error** → HTTP 200: `{"code":0,"data":{"biz_code":<N>,"biz_msg":"<msg>","biz_data":null}}`
- **Login Failure** → HTTP 200: `{"code":0,"data":{"biz_code":2,"biz_msg":"PASSWORD_OR_USER_NAME_IS_WRONG"}}`

### PoW target_path Mapping

| Endpoint | target_path |
|------|-------------|
| completion | `/api/v0/chat/completion` |
| edit_message | `/api/v0/chat/edit_message` |
| upload_file | `/api/v0/file/upload_file` |

## 0. login
- url: https://chat.deepseek.com/api/v0/users/login
- Request Header:
  - `User-Agent`: Required (WAF bypass, value should look like a real browser UA)
  - `Content-Type: application/json`: Optional (not needed if HTTP library sets it automatically)
- Request Payload:
```json
{
  "email": null,
  "mobile": "[phone_number]",
  "password": "<password>",
  "area_code": "+86",
  "device_id": "[any base64 or empty string, but field is mandatory]",
  "os": "web"
}
```
  - `email` / `mobile`: Choose one, pass null for the other
  - `device_id`: Required field (omission → 422), but value can be empty or random
  - `os`: Required (omission → 422), must be `"web"`
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "code": 0,
            "msg": "",
            "user": {
                "id": "test",
                "token": "api-token",
                "email": "te****t@mails.tsinghua.edu.cn",
                "mobile_number": "999******99",
                "area_code": "+86",
                "status": 0,
                "id_profile": {
                    "provider": "WECHAT",
                    "id": "test",
                    "name": "test",
                    "picture": "https://static.deepseek.com/user-avatar/test",
                    "locale": "zh_CN",
                    "email": null
                },
                "id_profiles": [
                    {
                        "provider": "WECHAT",
                        "id": "test",
                        "name": "test",
                        "picture": "https://static.deepseek.com/user-avatar/test",
                        "locale": "zh_CN",
                        "email": null
                    }
                ],
                "chat": {
                    "is_muted": 0,
                    "mute_until": null
                },
                "has_legacy_chat_history": false,
                "need_birthday": false
            }
        }
    }
}
```
- Key field: `data.biz_data.user.token` (Bearer token for all subsequent requests)
- Error response: `biz_code=2, biz_msg="PASSWORD_OR_USER_NAME_IS_WRONG"`

## 1. create
- url: https://chat.deepseek.com/api/v0/chat_session/create
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required (keep consistently for WAF bypass)
- Request Payload: `{}`
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "chat_session": {
                "id": "e6795fb3-272f-4782-87cf-6d6140b5bf76",
                "seq_id": 197895830,
                "agent": "chat",
                "model_type": "default",
                "title": null,
                "title_type": "WIP",
                "version": 0,
                "current_message_id": null,
                "pinned": false,
                "inserted_at": 1775732630.005,
                "updated_at": 1775732630.005
            },
            "ttl_seconds": 259200
        }
    }
}
```
- Key field: `data.biz_data.chat_session.id` (the `chat_session_id` used by subsequent completion)
- Note: `chat_session` is a nested object containing full session info

## 2. get_wasm_file
- url: https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm
- Request Header: No auth required, no User-Agent needed, direct GET
- Request Payload: GET operation, none
- Response: 26612 bytes, `Content-Type: application/wasm`, standard WASM format (`\x00asm` magic number)
- Note: The hash portion `7b9ca65ddd` in the URL may change; recommend making it configurable

## 3. create_pow_challenge
- url: https://chat.deepseek.com/api/v0/chat/create_pow_challenge
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required (WAF bypass, omission → 429)
- Request Payload: `{"target_path": "/api/v0/chat/completion"}`
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "challenge": {
                "algorithm": "DeepSeekHashV1",
                "challenge": "7ffc9d19b6eed96a6fca68f8ffe30ee61035d4959e4180f187bf85b356016a96",
                "salt": "3bde54628ea8413fee87",
                "signature": "ce4678cf7a1290c2a7ac88c4195a5b8497e5fc4b0e8044e804f5a6f3af6fe462",
                "difficulty": 144000,
                "expire_at": 1775380966945,
                "expire_after": 300000,
                "target_path": "/api/v0/chat/completion"
            }
        }
    }
}
```
- Key fields: `challenge` (hash input prefix), `salt` (for concatenation), `difficulty` (target threshold), `expire_at` (expiration timestamp ms)
- `algorithm`: Fixed as `"DeepSeekHashV1"`
- `expire_after`: 300000ms = 5 minute validity

## 4. completion
- url: https://chat.deepseek.com/api/v0/chat/completion
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
  - `X-Ds-Pow-Response`: Required (base64-encoded PoW response, **must be recomputed for each request**)
- Request Payload:
```json
{
    "chat_session_id": "<id from create endpoint>",
    "parent_message_id": null,
    "model_type": "default",
    "prompt": "你好",
    "ref_file_ids": ["file-xxx"],
    "thinking_enabled": true,
    "search_enabled": true,
    "preempt": false
}
```
- `model_type`: `"expert"` (default) | `"default"` | etc.
- `ref_file_ids`: Array of file IDs returned after file upload, session-level memory, no need to re-pass for subsequent `edit_message`
- `preempt`: Preemption mode (not currently used in web UI), default false
- Response: `text/event-stream` SSE stream

### SSE Event Types

**1. `ready` — Session ready**
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}
```

**2. `update_session` — Session updated**
```
event: update_session
data: {"updated_at":1775386361.526172}
```

**3. Incremental content — Operator format**

All incremental updates use a unified data format, combining `"p"` (path) and `"o"` (operator):

- **`"p"` path + `"v"` value** (SET operation, replace field value):
  ```
  data: {"p":"response/status","v":"FINISHED"}
  ```

- **`"p"` + `"o":"APPEND"` + `"v"` value** (append to field):
  ```
  data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，"}
  ```

- **`"p"` + `"o":"SET"` + `"v"` value** (explicitly set field value, for numeric fields):
  ```
  data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.95}
  ```

- **`"p"` + `"o":"BATCH"` + `"v"` array** (batch update multiple fields):
  ```
  data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},{"p":"quasi_status","v":"FINISHED"}]}
  ```

- **Plain `"v"` value** (continue appending to the previous `"p"` path):
  ```
  data: {"v":"用户"}
  ```

- **Full JSON object** (initial state snapshot, no `"p"`):
  ```
  data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","fragments":[{"id":2,"type":"RESPONSE","content":"Hello"}]}}}
  ```

### SSE Stream Status Paths (dynamic fields under `response/`)

**Important: content is organized via the `fragments` array; use `-1` index to access the last fragment**

| Path | thinking=OFF | thinking=ON | search=OFF | search=ON |
|------|:---:|:---:|:---:|:---:|
| `response/fragments/-1/content` | ✅ `type: RESPONSE` | ✅ THINK→RESPONSE | ✅ | ✅ |
| `response/fragments/-1/elapsed_secs` | ❌ | ✅ thinking time (s) | - | - |
| `response/search_status` | - | - | ❌ | ✅ `SEARCHING` → `FINISHED` |
| `response/search_results` | - | - | ❌ | ✅ array `{url, title, snippet}` |
| `response/accumulated_token_usage` | ✅ | ✅ | ✅ | ✅ |
| `response/quasi_status` | ✅ | ✅ | ✅ | ✅ appears in BATCH |
| `response/status` | ✅ `WIP`→`FINISHED` | ✅ | ✅ | ✅ |

### Fragment Structure

```typescript
{
  id: number,           // fragment sequence number
  type: "THINK" | "RESPONSE",  // type discriminator
  content: string,      // text content
  elapsed_secs?: number, // THINK type only: thinking time in seconds
  references: [],       // references (currently empty)
  stage_id: number      // stage ID
}
```

### Differentiating Thinking Content from Actual Output

**Core rule: distinguish via `fragments[].type` field**

```
type == "THINK"     → Thinking content (only appears when thinking=ON)
type == "RESPONSE"  → Actual output content
```

**Stream phase order (thinking=ON, search=ON):**

```
1. SEARCHING   → p=response/search_status, v="SEARCHING"
2. SEARCH      → p=response/search_results, v=[{url, title, snippet}, ...]
3. SEARCH END  → p=response/search_status, v="FINISHED"
4. SNAPSHOT    → {"v":{"response":{..., "fragments":[{"type":"THINK","content":""}]}}}
5. THINKING    → p=response/fragments/-1/content, o="APPEND", v="..."
6. THINK END   → p=response/fragments/-1/elapsed_secs, o="SET", v=0.95
7. RESPONSE    → p=response/fragments, o="APPEND", v=[{"type":"RESPONSE","content":"..."}]
8. CONTENT     → p=response/fragments/-1/content, v="..." (continues appending)
9. BATCH       → p=response, o="BATCH", v=[{accumulated_token_usage},{quasi_status}]
10. DONE       → p=response/status, o="SET", v="FINISHED"
```

**Stream phase order (thinking=OFF, search=OFF):**

```
1. SNAPSHOT    → {"v":{"response":{..., "fragments":[{"type":"RESPONSE","content":""}]}}}
2. CONTENT     → p=response/fragments/-1/content, o="APPEND", v="..."
3. BATCH       → p=response, o="BATCH", v=[{accumulated_token_usage},{quasi_status}]
4. DONE        → p=response/status, o="SET", v="FINISHED"
```

**Implementation note:** When parsing the SSE stream, maintain a `current_path` state variable. Update it when a `p` field appears; subsequent `{"v":"..."}` or `{"o":"APPEND","v":"..."}` belong to that path. For `fragments/-1`, this refers to the last element in the array.

**4. `hint` — Server hint/error (must handle)**
```
event: hint
data: {"type":"error","content":"Content is too long. Please shorten it and try again.","clear_response":true,"finish_reason":"input_exceeds_limit"}
```
- `type`: `"error"` indicates an error hint; other values (e.g. `"info"`) can be ignored
- `content`: Human-readable hint message
- `clear_response`: When true, indicates existing output should be cleared
- `finish_reason`: `"input_exceeds_limit"` (input too long), `"rate_limit_reached"` (rate limited), etc.

**Note**: The hint event is always the second SSE event (immediately after `ready`). Stream handlers should check whether the second event is a hint with `type=error`; if so, actively terminate the stream and return an error (e.g. `Overloaded` or `BadRequest`), rather than continuing to wait for subsequent events.

**5. Stream end sequence (in order):**

```
data: {"p":"response/status","v":"FINISHED"}

event: finish
data: {}

event: update_session
data: {"updated_at":1775387665.945004}

event: title          # Only appears when thinking=OFF and search=OFF
data: {"content":"Greeting Assistance"}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

- `close`: Session end signal. `click_behavior` controls click behavior (`"none"` or `"retry"`), `auto_resume` indicates whether the session can auto-resume
- `title`: Only appears when thinking=OFF and search=OFF, indicates auto-generated session title

Note: `event: title` and `event: close` may not always appear. The most reliable end signals are `event: finish` or `response/status` changing to `FINISHED`.

## 5. edit_message
- url: https://chat.deepseek.com/api/v0/chat/edit_message
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
  - `X-Ds-Pow-Response`: Required (recompute for each request)
- Request Payload:
```json
{
    "chat_session_id": "<session_id>",
    "message_id": 1,
    "prompt": "test again",
    "search_enabled": true,
    "thinking_enabled": true
}
```
- **Note**: `model_type` and `ref_file_ids` are not in the edit_message payload — both are passed on the first completion and remembered at the session level; subsequent edit_message calls inherit them
- `message_id`: Must already exist (an empty session with `message_id=1` will return `biz_code=26, "invalid message id"`)
- After editing, a new `message_id` is generated; obtain `response_message_id` from the SSE `ready` event for use in subsequent `stop_stream`
- Actual packet capture confirmation: first `edit_message(message_id=1)` yields `response_message_id=4` (not 2), subsequent conversations increment as `1→4, 3→6, 5→8...`
- Response: Same as `completion` (SSE stream)

## 6. stop_stream
- url: https://chat.deepseek.com/api/v0/chat/stop_stream
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required (WAF bypass)
- Request Payload:
```json
{
    "chat_session_id": "57bf7fb1-5fde-4d21-a08e-5dfa017216d5",
    "message_id": 2
}
```
  - `chat_session_id`: Session ID from the create endpoint
  - `message_id`: ID of the response message to cancel. An edit request's `message_id=1` corresponds to response `message_id=2`, so stop_stream always passes `2`.
- Response:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```
- Purpose: Cancel an ongoing streaming response. After the client disconnects, calling this endpoint allows DeepSeek to stop generating, avoiding wasted resources.
- Note: No PoW header required

## 7. delete
- url: https://chat.deepseek.com/api/v0/chat_session/delete
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
- Request Payload: `{"chat_session_id": "<session_id>"}`
- Response:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```

## 8. update_title
- url: https://chat.deepseek.com/api/v0/chat_session/update_title
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
- Request Payload:
```json
{
    "chat_session_id": "<session_id>",
    "title": "test"
}
```
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "chat_session_updated_at": 1775382827.122839,
            "title": "test"
        }
    }
}
```
- Error codes: `biz_code=5` → `EMPTY_CHAT_SESSION` (cannot set title on empty session); `biz_code=1` → `ILLEGAL_CHAT_SESSION_ID`

## 9. upload_file
- url: https://chat.deepseek.com/api/v0/file/upload_file
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
  - `X-Ds-Pow-Response`: Required (target_path is `/api/v0/file/upload_file`)
- Request Payload: `multipart/form-data`, field name `file`
```
Content-Disposition: form-data; name="file"; filename="test.txt"
Content-Type: text/plain
```
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "id": "file-12c6dd1a-e37b-4671-8d41-a5b0c6cc313b",
            "status": "PENDING",
            "file_name": "test.txt",
            "previewable": false,
            "file_size": 23,
            "token_usage": null,
            "error_code": null,
            "inserted_at": 1775387379.024,
            "updated_at": 1775387379.024
        }
    }
}
```
- Key field: `data.biz_data.id` (used as `ref_file_ids` in subsequent completion)
- Note: After upload, `status` is `PENDING`; poll `fetch_files` until `status=SUCCESS`

## 10. fetch_files?file_ids=<id>
- url: https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=<id>
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: Required
- Request Payload: None, GET operation
- Response:
```json
{
    "code": 0,
    "msg": "",
    "data": {
        "biz_code": 0,
        "biz_msg": "",
        "biz_data": {
            "files": [
                {
                    "id": "file-12c6dd1a-e37b-4671-8d41-a5b0c6cc313b",
                    "status": "SUCCESS",
                    "file_name": "test.txt",
                    "previewable": true,
                    "file_size": 23,
                    "token_usage": 4,
                    "error_code": null,
                    "inserted_at": 1775387379.024,
                    "updated_at": 1775387396.0
                }
            ]
        }
    }
}
```
- Key field: `files[].status` → `SUCCESS` indicates upload completed
- `token_usage`: Token count consumed for file parsing
