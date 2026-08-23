# DeepSeek 端点详情

### Base URLs
- `https://chat.deepseek.com/api/v0` — 所有 API 端点
- `https://fe-static.deepseek.com` — WASM 文件下载

### 统一 Headers
- 所有请求: `User-Agent` 必填（WAF 绕过）
- 鉴权请求: `Authorization: Bearer <token>`
- PoW 请求: `X-Ds-Pow-Response: <base64>`

### 错误响应格式
- **字段缺失** → HTTP 422: `{"detail":[{"loc":"body.<field>"}]}`
- **Token 无效** → HTTP 200: `{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}`
- **业务错误** → HTTP 200: `{"code":0,"data":{"biz_code":<N>,"biz_msg":"<msg>","biz_data":null}}`
- **登录失败** → HTTP 200: `{"code":0,"data":{"biz_code":2,"biz_msg":"PASSWORD_OR_USER_NAME_IS_WRONG"}}`

### PoW target_path 映射
| 端点 | target_path |
|------|-------------|
| completion | `/api/v0/chat/completion` |
| edit_message | `/api/v0/chat/edit_message` |
| upload_file | `/api/v0/file/upload_file` |



## 0. login
- url: https://chat.deepseek.com/api/v0/users/login
- Request Header:
  - `User-Agent`: 必填（WAF 绕过，值需像真实浏览器 UA）
  - `Content-Type: application/json`: 可选（HTTP 库自动设置时不需要）
- Request Payload:
```json
{
  "email": null,
  "mobile": "[phone_number]",
  "password": "<password>",
  "area_code": "+86",
  "device_id": "[任意base64或空字符串，但字段不能省略]",
  "os": "web"
}
```
  - `email` / `mobile`: 二选一，另一个传 null
  - `device_id`: 必填字段（省略 → 422），但值可为空或随机
  - `os`: 必填（省略 → 422），固定 `"web"`
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
- 关键字段: `data.biz_data.user.token`（后续所有请求的 Bearer token）
- 错误响应: `biz_code=2, biz_msg="PASSWORD_OR_USER_NAME_IS_WRONG"`



## 1. create
- url: https://chat.deepseek.com/api/v0/chat_session/create
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填（统一保留，WAF 绕过）
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
- 关键字段: `data.biz_data.chat_session.id`（后续 completion 用的 `chat_session_id`）
- 注意: `chat_session` 内嵌对象包含完整 session 信息


## 2. get_wasm_file
- url: https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm
- Request Header: 无需鉴权，无需 User-Agent，直链 GET 即可
- Request Payload: GET 操作，无
- Response: 26612 bytes，`Content-Type: application/wasm`，标准 WASM 格式（`\x00asm` magic number）
- 注意: URL 中的 hash 部分 `7b9ca65ddd` 可能会变，建议可配置



## 3. create_pow_challenge
- url: https://chat.deepseek.com/api/v0/chat/create_pow_challenge
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填（WAF 绕过，省略 → 429）
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
- 关键字段: `challenge`（哈希输入前缀）、`salt`（拼接用）、`difficulty`（目标阈值）、`expire_at`（过期时间戳 ms）
- `algorithm`: 固定 `"DeepSeekHashV1"`
- `expire_after`: 300000ms = 5 分钟有效期



## 4. completion
- url: https://chat.deepseek.com/api/v0/chat/completion
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
  - `X-Ds-Pow-Response`: 必填（base64 编码的 PoW 响应，**每次请求必须重新计算**）
- Request Payload:
```json
{
    "chat_session_id": "<来自 create 端点的 id>",
    "parent_message_id": null,
    "model_type": "default",
    "prompt": "你好",
    "ref_file_ids": ["file-xxx"],
    "thinking_enabled": true,
    "search_enabled": true,
    "preempt": false
}
```
- `model_type`: `"expert"` (默认) | `"default"` | 等
- `ref_file_ids`: 上传文件后返回的文件 ID 数组，会话级别记忆，后续 `edit_message` 无需重复传入
- `preempt`: 预占模式（目前网页端未使用），默认 false
- Response: `text/event-stream` SSE 流

### SSE 事件格式

**1. `ready` — 会话就绪**
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}
```

**2. `update_session` — 会话更新**
```
event: update_session
data: {"updated_at":1775386361.526172}
```

**3. 增量内容 — 操作符格式**

所有增量更新使用统一的数据格式，通过 `"p"`（路径）和 `"o"`（操作符）组合：

- **`"p"` 路径 + `"v"` 值**（SET 操作，替换字段值）:
  ```
  data: {"p":"response/status","v":"FINISHED"}
  ```

- **`"p"` + `"o":"APPEND"` + `"v"` 值**（追加到字段）:
  ```
  data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，"}
  ```

- **`"p"` + `"o":"SET"` + `"v"` 值**（显式设置字段值，用于数值）:
  ```
  data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.95}
  ```

- **`"p"` + `"o":"BATCH"` + `"v"` 数组**（批量更新多个字段）:
  ```
  data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},{"p":"quasi_status","v":"FINISHED"}]}
  ```

- **纯 `"v"` 值**（继续追加到上一 `"p"` 路径）:
  ```
  data: {"v":"用户"}
  ```

- **完整 JSON 对象**（初始状态快照，无 `"p"`）:
  ```
  data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","fragments":[{"id":2,"type":"RESPONSE","content":"Hello"}]}}}
  ```

### SSE 流状态路径（`response/` 下的动态字段）

**重要：内容通过 `fragments` 数组组织，使用 `-1` 索引访问最后一个 fragment**

| 路径 | thinking=OFF | thinking=ON | search=OFF | search=ON |
|------|:---:|:---:|:---:|:---:|
| `response/fragments/-1/content` | ✅ `type: RESPONSE` | ✅ THINK→RESPONSE | ✅ | ✅ |
| `response/fragments/-1/elapsed_secs` | ❌ | ✅ 思考耗时(秒) | - | - |
| `response/search_status` | - | - | ❌ | ✅ `SEARCHING` → `FINISHED` |
| `response/search_results` | - | - | ❌ | ✅ 数组 `{url, title, snippet}` |
| `response/accumulated_token_usage` | ✅ | ✅ | ✅ | ✅ |
| `response/quasi_status` | ✅ | ✅ | ✅ | ✅ BATCH 中出现 |
| `response/status` | ✅ `WIP`→`FINISHED` | ✅ | ✅ | ✅ |

### Fragment 结构

```typescript
{
  id: number,           // fragment 序号
  type: "THINK" | "RESPONSE",  // 类型区分
  content: string,      // 文本内容
  elapsed_secs?: number, // THINK 类型有：思考耗时
  references: [],       // 引用（目前为空）
  stage_id: number      // 阶段 ID
}
```

### 思考内容 vs 实际输出的区分方法

**核心规则：通过 `fragments[].type` 字段区分**

```
type == "THINK"     → 思考内容（仅 thinking=ON 时出现）
type == "RESPONSE"  → 实际输出内容
```

**流的阶段顺序（thinking=ON, search=ON）：**

```
1. SEARCHING   → p=response/search_status, v="SEARCHING"
2. SEARCH      → p=response/search_results, v=[{url, title, snippet}, ...]
3. SEARCH END  → p=response/search_status, v="FINISHED"
4. SNAPSHOT    → {"v":{"response":{..., "fragments":[{"type":"THINK","content":""}]}}}
5. THINKING    → p=response/fragments/-1/content, o="APPEND", v="..."
6. THINK END   → p=response/fragments/-1/elapsed_secs, o="SET", v=0.95
7. RESPONSE    → p=response/fragments, o="APPEND", v=[{"type":"RESPONSE","content":"..."}]
8. CONTENT     → p=response/fragments/-1/content, v="..." (继续追加)
9. BATCH       → p=response, o="BATCH", v=[{accumulated_token_usage},{quasi_status}]
10. DONE       → p=response/status, o="SET", v="FINISHED"
```

**流的阶段顺序（thinking=OFF, search=OFF）：**

```
1. SNAPSHOT    → {"v":{"response":{..., "fragments":[{"type":"RESPONSE","content":""}]}}}
2. CONTENT     → p=response/fragments/-1/content, o="APPEND", v="..."
3. BATCH       → p=response, o="BATCH", v=[{accumulated_token_usage},{quasi_status}]
4. DONE        → p=response/status, o="SET", v="FINISHED"
```

**实现建议：** 解析 SSE 流时，维护一个 `current_path` 状态变量。当 `p` 字段出现时更新它，后续的 `{"v":"..."}` 或 `{"o":"APPEND","v":"..."}` 都归属到该路径。对于 `fragments/-1`，表示数组最后一个元素。

**4. `hint` — 服务端提示/错误（必处理）**
```
event: hint
data: {"type":"error","content":"Content is too long. Please shorten it and try again.","clear_response":true,"finish_reason":"input_exceeds_limit"}
```
- `type`: `"error"` 表示错误提示，其他值（如 `"info"`）可忽略
- `content`: 人类可读的提示信息
- `clear_response`: 为 true 时表示已有输出应被清除
- `finish_reason`: `"input_exceeds_limit"`（输入超长）、`"rate_limit_reached"`（限流）等

**注意**: hint 事件固定为第二个 SSE 事件（紧接在 `ready` 之后）。流处理器应检查第二个事件是否为 `type=error` 的 hint，若是则主动终止流并返回错误（如 `Overloaded` 或 `BadRequest`），而非继续等待后续事件。

**5. 流结束序列（按顺序）:**

```
data: {"p":"response/status","v":"FINISHED"}

event: finish
data: {}

event: update_session
data: {"updated_at":1775387665.945004}

event: title          # 仅在 thinking=OFF 且 search=OFF 时出现
data: {"content":"Greeting Assistance"}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

- `close`: 会话语义结束信号。`click_behavior` 控制点击行为（`"none"` 或 `"retry"`），`auto_resume` 表示是否可自动恢复
- `title`: 仅在 thinking=OFF 且 search=OFF 时出现，表示自动生成的会话标题

注意: `event: title` 和 `event: close` 可能不总是出现。最可靠的结束信号是 `event: finish` 或 `response/status` 变为 `FINISHED`。



## 5. edit_message
- url: https://chat.deepseek.com/api/v0/chat/edit_message
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
  - `X-Ds-Pow-Response`: 必填（每次请求重新计算）
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
- **注意**: `model_type` 和 `ref_file_ids` 不在 edit_message payload 中——二者在首次 completion 时传入后由 session 级别记忆，后续 edit_message 继承
- `message_id`: 必须已存在（空 session 的 `message_id=1` 会返回 `biz_code=26, "invalid message id"`）
- 编辑后生成新的 `message_id`，需从 SSE `ready` 事件中获取 `response_message_id` 字段用于后续 `stop_stream`
- 实际抓包确认：首次 `edit_message(message_id=1)` 的 `response_message_id=4`（而非 2），后续对话按 `1→4, 3→6, 5→8...` 递增
- Response: 同 `completion`（SSE 流）


## 6. stop_stream
- url: https://chat.deepseek.com/api/v0/chat/stop_stream
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填（WAF 绕过）
- Request Payload:
```json
{
    "chat_session_id": "57bf7fb1-5fde-4d21-a08e-5dfa017216d5",
    "message_id": 2
}
```
  - `chat_session_id`: 来自 create 端点的 session ID
  - `message_id`: 要取消的响应消息 ID。编辑请求的 `message_id=1` 对应响应 `message_id=2`，所以停止流固定传 `2`。
- Response:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```
- 作用: 取消正在进行的流式输出。客户端断开连接后调用此端点可让 DeepSeek 侧停止继续生成，避免浪费资源。
- 注意: 不需要 PoW header

## 7. delete
- url: https://chat.deepseek.com/api/v0/chat_session/delete
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
- Request Payload: `{"chat_session_id": "<session_id>"}`
- Response:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}
```


## 8. update_title
- url: https://chat.deepseek.com/api/v0/chat_session/update_title
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
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
- 错误码: `biz_code=5` → `EMPTY_CHAT_SESSION`（空 session 无法设置标题）；`biz_code=1` → `ILLEGAL_CHAT_SESSION_ID`



## 9. upload_file
- url: https://chat.deepseek.com/api/v0/file/upload_file
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
  - `X-Ds-Pow-Response`: 必填（target_path 为 `/api/v0/file/upload_file`）
- Request Payload: `multipart/form-data`，字段名 `file`
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
- 关键字段: `data.biz_data.id`（后续 completion 的 `ref_file_ids` 使用）
- 注意: 上传后 `status` 为 `PENDING`，需轮询 `fetch_files` 直到 `status=SUCCESS`



## 10. fetch_files?file_ids=<id>
- url: https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=<id>
- Request Header:
  - `Authorization: Bearer <token>`
  - `User-Agent`: 必填
- Request Payload: 无，GET 操作
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
- 关键字段: `files[].status` → `SUCCESS` 表示上传完成
- `token_usage`: 文件解析消耗的 token 数
