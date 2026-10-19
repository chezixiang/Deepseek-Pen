# 阶段 1A：Native Transport 接口契约与验收矩阵（1A-r1 修订版）

> **被 02d 替代（2026-10-03）**：当前唯一修复基线为 `docs/astra/02d-phase1-transport-contract-r2.md`（T1A.3-r2）。本文件以下正文原样保留，作为 r1 历史文本及 02d 明确纳入的继承条款；终态提交、排队事件、投递闸门与 M 矩阵以 02d 为准。修订记录见 `docs/astra/02e-phase1-r2-revision-record.md`。

- **文档版本**：T1A.2-r1
- **替代**：`docs/astra/02-phase1-transport-contract.md`（T1A.1，2026-09-27 冻结）
- **阶段**：阶段 1A 契约修订（1A-r1）；仍不含 Transport 实现
- **修订日期**：2026-09-30（Asia/Shanghai）
- **工作区**：`G:\youdao\Deepseek`
- **修订依据**：阶段 0 · P4c 真机验证——`docs/astra/01-phase0-p4c.md`、`.probe/probe/p4c/EVIDENCE.md` 及 `p4c/device/*`、`p4c/mock/out/*` 原始输出
- **状态**：生命周期语义（context 状态机、generation、投递闸门、显式终止链、销毁场景责任划分、矩阵 M19/M25–M31、1B 进入条件）已按 P4c 证据修订；实现与 G1 运行证据仍未执行。

> **1A-r1 修订摘要**：P4c 真机验证证明，本固件在页面退出（onStop）、切后台、停止小程序、卸载四种场景下都不会停止 native 线程与 JS 回调，只有 `kill -9` 能真正终止。因此本契约新增**显式终止链**模型：`cancel` / `cancelAll` / `closeContext` + 投递闸门 + generation 计数是唯一停止路径；任何“宿主销毁会停止回调或释放上下文”的假设均被移除。接口命名、取消幂等、背压水位与上下文隔离语义从 T1A.1 原样继承。
>
> 修订点清单、P4c 证据映射与未决问题见：`docs/astra/02c-phase1-r1-revision-record.md`；本文件 §13 为摘要。

---

## 1. 阶段边界

### 1.1 本阶段冻结的内容（1A-r1 口径）

1. Native Transport 对 QuickJS 暴露的操作名：`request`、`openStream`、`cancel`、`setProxy`、`clearCookies`、`getCookies`（自 T1A.1 继承，保持不变）；1A-r1 新增（纯增量）：`openContext`、`closeContext`、`cancelAll`。
2. 普通响应与原始字节流的返回形态（继承）。
3. 流事件类型、顺序、序号和唯一终止规则；1A-r1 增补**终止闩锁**与**投递闸门**（修订）。
4. 取消的竞态、幂等和错误返回语义（继承）；1A-r1 明确取消由 JS 主动触发、不依赖宿主生命周期，并增加上下文级批量终止（修订）。
5. 请求队列、响应缓存、流事件缓存和背压上限（继承，未修订）。
6. `contextId` 作用域内的 Cookie Jar、代理配置和请求快照规则（继承）；1A-r1 增加显式 `open/closed` 状态机与 generation 计数（修订）。
7. 所有回调/Promise 投递到 QuickJS 的线程与生命周期约束；1A-r1 把“投递前检查”规范化为强制条款（修订）。
8. G1 所需的 mock server 验收用例矩阵；1A-r1 重定义 M19，新增 M25–M31，并更新 G1 门槛映射（修订）。

### 1.2 明确不在本阶段

- 不实现完整 Transport 库、TLS/HTTP2 适配、代理适配或 Cookie Jar。
- 不加入 DeepSeek endpoint、账号、token、session、PoW、mute、retry policy、业务 SSE 解析或业务错误分类。
- 不修改或切换现有 `ds.js`、`native.js`、`backend-blob.js`，不替换默认入口。
- 不把响应解析成 SSE、JSON 业务事件或模型事件；Transport 只交付 HTTP 元数据和原始字节。
- 不在 Native 保存账号、会话、业务配置或跨重启持久化状态。
- 1A-r1 本身为文档修订：不实现、不构建、不安装、不进入 1B。

### 1.3 变更保护

- `app/HOWTOBUILD.md`、`ds-free-api/**` 等工作区既有修改属于既有变更，本轮不触碰。
- 保护文件为：`app/src/services/ds.js`、`app/src/services/native.js`、`app/src/services/backend-blob.js`；1A-r1 不改动这些文件。
- `重构计划/00-baseline.md` 不修改；`.probe/probe/VERIFY.md`、`.probe/probe/p4c/**` 作为证据文件保持原样（只读引用）。
- 1A-r1 的改动范围仅 `docs/astra/` 下的文档：本文件（新增）、`02-phase1-transport-contract.md`（仅追加被替代标注）、`02c-phase1-r1-revision-record.md`（新增）。

### 1.4 与 T1A.1 的继承/替代关系

| 主题 | 处置 | 出处 |
|---|---|---|
| 操作命名、事件类型、取消幂等、背压水位、上下文隔离、Cookie epoch、401/429 口径 | **继承 T1A.1，不改语义** | 本文件 §2–§7 对应小节 |
| 宿主销毁语义（原 §4.2） | **被修订**：显式终止链 + 投递闸门 | 本文件 §4 |
| contextId 生命周期 | **新增**：open/closed 状态机与 generation | 本文件 §2.8–§2.10、§6.5、§7.5 |
| 验收矩阵 | **修订**：M19 重定义，新增 M25–M31 | 本文件 §8 |
| 1B 进入条件 | **修订**：显式终止链为必选项 | 本文件 §11 |

---

## 2. 冻结后的公共 API（继承 + 1A-r1 增量）

Native 模块名沿用路线规划中的 `libjsapi_ds_transport.so` / `ds_transport`。以下签名是 JS 侧契约的规范写法；C++/JSAPI 内部可以使用不同的私有函数名，但不得改变 JS 可见语义。标注“1A-r1 新增”的为增量条款，其余自 T1A.1 原样继承。

### 2.1 公共类型

```js
/** 由调用方生成；只用于传输相关联和取消，不表达账号或业务语义。 */
type RequestId = string

/** 由调用方生成；同一 Transport 实例内必须唯一，且不得包含业务对象引用。 */
type ContextId = string

/** 1A-r1 新增：Transport 实例内单调递增，从 1 开始；每次状态转换（创建、close、reopen）+1。 */
type ContextGeneration = number

/** 1A-r1 新增：上下文显式生命周期状态。 */
type ContextState = "open" | "closed"

type Headers = Record<string, string | string[]>
type Body = string | Uint8Array | null

type RedirectMode = "follow" | "manual" | "error"

type ProxyConfig = null | {
  url: string,                 // http://、https:// 或 socks5://
  username?: string,
  password?: string,
}

type RequestInput = {
  requestId: RequestId,
  contextId: ContextId,
  method: string,
  url: string,
  headers?: Headers,
  body?: Body,
  timeoutMs?: number,           // 默认 15000；必须为正整数
  redirect?: RedirectMode,      // 默认 "follow"
}

type Response = {
  requestId: RequestId,
  status: number,
  headers: Headers,              // 名称小写；重复字段用 string[]
  body: Uint8Array,
  url: string,                   // 最终响应 URL
}
```

固定规则（继承，未改动）：

- `requestId` 和 `contextId` 为非空 UTF-8 字符串，长度上限 128 字节。
- `method` 按 HTTP token 校验并在传输层规范化为大写；`url` 必须是绝对 HTTP(S) URL。
- 请求头名称大小写不敏感；返回时全部转为小写。`Set-Cookie` 等重复头不得被覆盖。
- `body` 作为不透明字节交给网络层。Transport 不依据 URL、header 或 body 猜测业务类型。
- `timeoutMs` 是整个操作的 deadline，包含排队、连接、重定向、发送和接收；超时统一产生 `ERR_TIMEOUT`。
- `redirect: "follow"` 最多跟随 5 次，只对最终响应交付 `headers`；`manual` 把 3xx 当作普通 HTTP 响应；`error` 遇到 3xx 产生 `ERR_REDIRECT`。
- HTTP 状态码不是 Transport 异常：401、429、以及其他 4xx/5xx 都以正常 HTTP 响应交给 JS。

1A-r1 新增规则：

- 每次 admission（`request`/`openStream`）绑定当次 `contextId` 的 generation 快照（§6.5）；之后该操作的所有投递都携带这份 captured generation，并受 §7.5 投递闸门检查。
- 对 `state == "closed"` 且未重开的 `contextId` 发起任何操作（含 `setProxy`/`clearCookies`/`getCookies`）一律 reject `ERR_CONTEXT_CLOSED`；继续使用必须显式 `openContext()`（§2.8）。

### 2.2 `request(input)`：单响应请求

```js
Promise<Response> request(RequestInput input)
```

- 调用成功表示请求已被接受并最终得到 HTTP 响应；Promise 只 settle 一次。
- 401/429/其他 HTTP 错误状态 resolve `Response`，不得 reject。
- DNS、连接、TLS、超时、重定向策略、响应过大、背压/内部资源等传输失败 reject 一个结构化错误：

```js
{
  name: "TransportError",
  code: "ERR_TIMEOUT" | "ERR_CANCELLED" | "ERR_NETWORK" |
        "ERR_TLS" | "ERR_REDIRECT" | "ERR_RESPONSE_TOO_LARGE" |
        "ERR_QUEUE_FULL" | "ERR_DUPLICATE_REQUEST_ID" |
        "ERR_BACKPRESSURE" | "ERR_INVALID_ARGUMENT" | "ERR_PROXY" |
        "ERR_RUNTIME_DESTROYED" | "ERR_CONTEXT_CLOSED",
  message: string,
  requestId: string,
}
```

- `request()` 不发出流事件，也不接受 `stream: true`。需要增量字节事件时必须使用 `openStream()`。
- `requestId` 在调用方生成，使 `request()` 在 Promise settle 前即可被 `cancel()` / `cancelAll()` 取消。
- 响应 body 聚合完成、Cookie 处理完成后才 resolve；body 超过单响应上限时 reject `ERR_RESPONSE_TOO_LARGE`。
- 1A-r1：`ERR_CONTEXT_CLOSED` 为新增 code；其余 code 集合与 T1A.1 一致。取消路径产生的 reject 统一为 `ERR_CANCELLED`（含 `cancelAll`，reason 不在错误对象中回显）。

### 2.3 `openStream(input, onEvent)`：原始字节流

```js
Promise<{ requestId: RequestId }> openStream(
  RequestInput input,
  (event: StreamEvent) => void,
)
```

- `onEvent` 必须是函数；它是该 stream 的唯一回调，不使用全局事件总线。
- Promise resolve 只表示请求已登记/入队；它不表示 HTTP 已连接或响应已到达。
- 第一条事件回调不得早于 `openStream()` Promise settle；事件在 JS 线程按下文的顺序规则投递。
- `openStream()` 不解析 SSE、JSON、UTF-8 文本边界或 `[DONE]`；`chunk.bytes` 是原始 `Uint8Array`。
- `openStream()` 的流终止由且仅由一个 `end`、`error` 或 `cancelled` 事件表示。
- 1A-r1（终止唯一路径）：`end` / `error` / `cancelled` 任一提交后，该 stream 的后续一切投递全部丢弃（终止闩锁，§3.2 第 11 条；投递闸门，§7.5）。停止投递不依赖宿主销毁、不依赖页面生命周期（§4.2）。

### 2.4 `cancel({requestId})`：统一取消（JS 主动触发）

```js
Promise<CancelResult> cancel({ requestId: RequestId })

type CancelResult = {
  requestId: RequestId,
  outcome: "cancel-requested" | "already-cancelled" | "already-terminal",
  terminalType?: "end" | "error" | "cancelled",
}
```

- 取消适用于 `request()` 和 `openStream()` 的排队、连接、发送、接收阶段。
- 第一次在未终止操作上调用：原子地标记取消，返回 `cancel-requested`；stream 最终交付一个 `cancelled` 事件，普通请求 Promise reject `ERR_CANCELLED`。
- 在取消已经提交但终止回调尚未执行时再次调用：返回 `already-cancelled`，不产生第二条终止事件。
- 在 `end`/`error`/`cancelled` 已经提交后调用：返回 `already-terminal`，不改变已确定的结果。
- 竞态由“先提交终止状态者”获胜：网络终止先提交则取消不覆盖它；取消先提交则后到的网络结果被丢弃。
- 不存在的 `requestId` 或已不属于当前 Transport 实例的 ID reject `ERR_INVALID_ARGUMENT`；它不被当作一次新的取消操作。
- `cancel()` 本身不发 `error` 事件，不触发重试，不改变 Cookie Jar，不改变代理配置。

1A-r1 强化（依据 §4.2 的 P4c 事实）：

- `cancel` 是 JS 主动控制入口，**不依赖任何宿主生命周期事件**：在宿主完全存活、没有任何销毁信号的条件下，`cancel` 必须独立产生完整效果（停止读取 + 提交唯一终态 + 闸门丢弃后续投递）。
- `cancel` 的最终执行点是 Native 投递闸门（§7.5），而不是宿主的销毁时机；即使底层网络线程仍有收尾工作，也不得再产生用户可见投递。
- 取消语义（原子性、幂等、竞态、返回结构）保持 T1A.1 不变，本修订只补充触发与执行保证，不改变命名与返回形态。

### 2.5 `setProxy({contextId, proxy})`：上下文级代理

（继承 T1A.1 全部规则。）要点：

- 代理配置只属于指定 `contextId`；`proxy: null` 表示该上下文恢复直连。
- 只影响调用成功后新接纳的请求；已经排队/连接/发送的请求使用其 admission 时的代理快照。
- 不存在“全局当前代理”；一个上下文的 `setProxy()` 不影响任何其他上下文。
- 支持能力以 URL scheme 校验；不支持的 scheme 或不可解析配置 reject `ERR_PROXY`/`ERR_INVALID_ARGUMENT`。
- 代理用户名和密码只在 Native 内存中使用，不通过 `getCookies()`、事件或普通日志回显。
- 1A-r1：closed 且未重开的 `contextId` reject `ERR_CONTEXT_CLOSED`；`openContext()` 重开后代理配置回到默认直连（新 generation 不继承旧配置）。

### 2.6 `clearCookies({contextId})`：上下文级清理

（继承 T1A.1 全部规则。）要点：

- 只清理指定 `contextId` 的 Cookie Jar；不清理其他上下文，不清理请求显式传入的 `Cookie` header。
- 清理操作递增该上下文的 cookie epoch。清理之后才完成的旧请求，其晚到 `Set-Cookie` 不得把 Cookie 写回已清空的 Jar。
- 已经在清理前提交并写入 Jar 的 Cookie 会被计入 `cleared`；`clearCookies()` 自身不发网络请求。
- `clearCookies()` 不改变代理、TLS、UA、请求队列或已有请求的取消状态。
- 1A-r1：closed 且未重开的 `contextId` reject `ERR_CONTEXT_CLOSED`；cookie epoch 与 context generation 相互独立（§6.5），不得互相替代。

### 2.7 `getCookies({contextId, url?})`：只读 Cookie 快照

```js
Promise<{
  contextId: ContextId,
  cookies: Array<{
    name: string,
    value: string,
    domain: string,
    path: string,
    secure: boolean,
    httpOnly: boolean,
    expires?: number,
  }>,
}> getCookies({ contextId, url?: string })
```

- 返回调用时刻的副本，不返回内部可变引用，不触发网络请求。
- 指定 `url` 时只返回该 URL 可发送的 Cookie；省略时返回该上下文 Jar 的完整非过期快照。
- Cookie 只按 `contextId` 隔离；Native 不知道也不保存账号、session 或业务 token 的含义。
- 1A-r1：closed 且未重开的 `contextId` reject `ERR_CONTEXT_CLOSED`。

### 2.8 `openContext({contextId})`：显式建立 / 重开上下文（1A-r1 新增）

```js
Promise<{
  contextId: ContextId,
  generation: ContextGeneration,
  state: "open",
}> openContext({ contextId: ContextId })
```

- 显式建立上下文；首次建立时 `generation = 1`、`state = "open"`、Cookie Jar 与代理为空/默认。
- 对已 `open` 的上下文重复调用：幂等，返回当前 generation 与 `state: "open"`，不改变任何配置。
- 对已 `closed` 的上下文调用（重开）：`generation += 1`，`state → "open"`；Cookie Jar 与代理配置重置为默认（新 generation 是新的隔离单元，防止跨生命周期身份残留）。
- 省略显式 `openContext()` 时，首次 admission 可以隐式创建（等价 `generation = 1`）；DsRuntime 生命周期管理应显式调用，以便把 generation 纳入业务状态（1B 联调建议，非强制）。
- `contextId` 仍然是不透明句柄：`openContext` 不引入任何账号/业务语义。

### 2.9 `closeContext({contextId})`：封禁 + 批量终止 + generation 提升（1A-r1 新增）

```js
Promise<{
  contextId: ContextId,
  generation: ContextGeneration,   // close 完成后的（已递增）generation
  state: "closed",
  cancelled: number,               // 本次原子提交 cancelled 的未终止操作数
  outcomes: Array<{
    requestId: RequestId,
    outcome: "cancel-requested" | "already-cancelled" | "already-terminal",
  }>,
}> closeContext({ contextId: ContextId })
```

规范顺序（实现必须按此顺序原子化提交状态，投递可异步）：

1. `state: open → closing`：立即停止接纳；此后该 `contextId` 的新操作 reject `ERR_CONTEXT_CLOSED`。
2. 对该上下文内所有未终止操作原子提交 `cancelled` 终态（`reason = "context-closed"`）：stream 得到 `cancelled` 事件，`request()` reject `ERR_CANCELLED`。
3. `generation += 1`；`state → closed`（此后所有非终态投递被闸门丢弃）。
4. 已提交终态（第 2 步产生）允许投递一次：仅在 JS 上下文仍可调用且该终态尚未投递时投递；失败或不可调用即丢弃，不重试。

- 幂等：重复 `closeContext()` 返回 `state: "closed"` 与当前 generation，不再次递增、不产生新终态；`outcomes` 反映各 request 的 `already-cancelled` / `already-terminal` 状态。
- 第 4 条与“closed 后丢弃”不冲突：唯一获准投递的是 `closeContext` 自身原子提交的终态，且每个操作至多一次；除该终态外，closed 上下文不再有任何投递（含晚到 chunk 与第二终态）。
- `closeContext()` 不依赖任何宿主行为：只能由 JS 显式调用；Native 不以“宿主看起来在销毁”为触发条件（P4c 表明既没有可靠信号，也不存在可靠时机，见 §4.2）。
- 重开：必须显式 `openContext()`（§2.8），generation 再次递增；旧 generation 的一切未投递内容（终态除外）全部丢弃。

### 2.10 `cancelAll({contextId, reason?})`：上下文级批量取消（1A-r1 新增）

```js
Promise<{
  contextId: ContextId,
  generation: ContextGeneration,
  cancelled: number,
  outcomes: Array<{
    requestId: RequestId,
    outcome: "cancel-requested" | "already-cancelled" | "already-terminal",
  }>,
}> cancelAll({ contextId: ContextId, reason?: "user" | "app-lifecycle-end" })
```

- 语义等价于对该上下文内所有未终止操作逐一执行 `cancel()`：先提交者获胜、每操作单终态、幂等（与 §2.4 完全一致）。
- 默认 `reason = "app-lifecycle-end"`，用于 App / 页面生命周期结束的显式终止；`"user"` 用于用户主动停止。
- `cancelled` 为本次原子提交态的操作数；`outcomes` 与该上下文当前登记的操作一一对应，已终态的操作返回 `already-terminal`。
- `cancelAll` 不改变上下文状态（仍 `open`，可继续使用）；如需同时封禁并丢弃旧 generation 的余下投递，随后调用 `closeContext()`。
- 生命周期结束的规范顺序：**先 `cancelAll()`（让每个 stream 的终态获得一次投递机会），再 `closeContext()`（提升 generation，丢弃其余投递）**。只调用其中任一个也满足“显式终止”要求，但 1B 的默认实践按此顺序。
- `cancelAll` 不得实现为“先等网络线程退出再提交终态”：终态提交与投递抑制必须先于底层收尾完成（投递闸门保证），否则违反 §4.2 的原则。
---

## 3. 流事件模型

### 3.1 事件类型

```js
type StreamEvent =
  | {
      type: "headers",
      requestId: string,
      seq: number,
      status: number,
      headers: Headers,
      url: string,
    }
  | {
      type: "chunk",
      requestId: string,
      seq: number,
      bytes: Uint8Array,
    }
  | {
      type: "end",
      requestId: string,
      seq: number,
      totalBytes: number,
    }
  | {
      type: "error",
      requestId: string,
      seq: number,
      error: {
        name: "TransportError",
        code: string,
        message: string,
      },
    }
  | {
      type: "cancelled",
      requestId: string,
      seq: number,
      reason:
        | "user"              // 继承
        | "runtime-destroyed" // 继承（1A-r1 修订触发条件，见 §4.6）
        | "timeout-policy"    // 继承
        | "app-lifecycle-end" // 1A-r1 新增
        | "context-closed",   // 1A-r1 新增
    }
```

`cancelled.reason` 与触发路径的固定映射（1A-r1）：

| 触发路径 | reason |
|---|---|
| `cancel()`；`cancelAll({reason:"user"})` | `"user"` |
| `cancelAll()` 默认（App / 页面生命周期结束） | `"app-lifecycle-end"` |
| `closeContext()` | `"context-closed"` |
| 显式 runtime 终止链（§4.6） | `"runtime-destroyed"` |
| 策略超时（如实现选用） | `"timeout-policy"` |

- `"runtime-destroyed"` 不再由“宿主销毁”自动触发；只允许由显式终止链在检测到上下文不可调用时提交（P4c 表明宿主销毁信号不可依赖，见 §4.2）。

### 3.2 顺序与唯一性

1. `seq` 从 1 开始，在一个 stream 内严格递增；不同 stream 之间不比较顺序。
2. 正常响应：`headers`（恰好一次）→ 零或多条 `chunk` → `end`（恰好一次）。
3. headers 之前发生网络失败：`error`（恰好一次）；此时不发 `headers` 或 `chunk`。
4. headers 之后发生读失败：`headers` → 已投递的 `chunk` → `error`；不得再发 `end`。
5. 取消获胜：已投递前缀后发 `cancelled`；不得再发 `chunk`、`end` 或 `error`。
6. HTTP 401/429/其他 4xx/5xx 仍是正常响应：发 `headers`、按 body 发 `chunk`、最后发 `end`；状态码由业务层判断。
7. redirect follow 模式只为最终响应生成 `headers`；manual 模式把 3xx 作为最终 HTTP 响应；Transport 不生成 redirect 业务事件。
8. 终止事件集合只有 `{end, error, cancelled}`，每个 stream 最多一个，且必须是最后一个可观察事件。
9. 终止状态一经提交，晚到网络数据全部丢弃；不得调用用户回调第二次。
10. `onEvent` 抛出的 JS 异常被 Transport 记录并隔离，不改变已经确定的网络状态，也不生成第二条 `error`。

1A-r1 新增（终止唯一路径的规范化）：

11. **终止闩锁（terminal latch）**：`end` / `error` / `cancelled` 任一提交后，该 stream 的一切后续投递全部丢弃——包括晚到的 `chunk`/`headers`、重复取消反馈、第二次终态。`openStream` 停止投递只经由这一条路径，不存在“宿主帮忙停”的第二条路径。
12. 允许触发停止投递的原因白名单：`{end, error, cancelled}` 终态提交、`cancel` / `cancelAll` 提交终态、`closeContext` 提交终态。宿主销毁、页面/应用生命周期回调、`.so` 卸载动作均不在白名单内（依据 §4.2）。
13. 每一次投递在调用 JS 之前必须通过 §7.5 投递闸门；检查失败即丢弃，不重试、不创建/不触碰失效 JS 值。

### 3.3 回调数据所有权

（继承 T1A.1，未修订。）

- `headers`、错误对象和 `Uint8Array` 均为该次回调的 JS-owned 值；回调返回后调用方不得依赖 Native 内部 buffer。
- Native 不把可变网络 buffer 的裸指针交给 QuickJS；需要保留数据时由 JS 复制。
- `chunk` 的边界只受传输/缓存上限影响，不保证与 TCP、HTTP/2 DATA、SSE 行或 UTF-8 字符边界一致。

---

## 4. 取消、终止与生命周期（1A-r1 重写）

### 4.1 终止状态机

```text
accepted/queued
  ├─ cancel wins ───────────────> cancelled (terminal)
  ├─ timeout wins ──────────────> error(ERR_TIMEOUT) (terminal)
  ├─ transport failure ─────────> error(code) (terminal)
  └─ response fully read ───────> end (terminal)
```

- 状态转换必须是单次原子提交；重复 `cancel()` 只能读取已提交状态。
- `headers` 不是终止状态；收到 headers 后仍可取消。
- `end/error/cancelled` 进入 terminal 后，连接、读取任务、队列节点和 JS 回调引用进入清理流程；清理过程不得产生任何新的用户可见投递。
- 1A-r1：`cancelled` 的 reason 由触发路径固定映射（§3.1 表）；`cancelAll` 的默认 reason 为 `"app-lifecycle-end"`。

### 4.2 生命周期原则：宿主销毁不构成终止（P4c 关键修订）

| # | 事实（P4c 真机） | 原始证据 | 契约含义 |
|---|---|---|---|
| F1 | 页面停止（`onStop`，无 `onDestroy`）后，30 s 延迟回调仍被投递、JS 在“已停止”的页面上成功执行并写文件 | `p4c/device/s1-result.txt`、`s1-log.txt`、`01-phase0-p4c.md:171-187` | `onStop` 不是停止信号；页面级资源必须由 JS 显式取消 |
| F2 | 切后台 / 停止小程序后实例驻留、探针 `.so` 保持映射，晚到回调仍被投递 | `p4c/device/s2-state-after-stop.txt`、`s2-result.txt` | 后台/停止动作不构成终止；Native 无自动动作 |
| F3 | 卸载后框架 `has no jsapi_check_unload symbol; ignore dlclose`，晚到回调在“已卸载”的 app 上仍成功执行 JS（写 `/tmp/p4c-late-hit.json`；日志同秒出现 `mkdir failed`） | `p4c/device/s4-result.txt`、`s4-late-hit.json`、`s4-log.txt` | 卸载不构成终止，也不构成资源释放；不得依赖 `dlclose` |
| F4 | `kill -9` 宿主进程后 native 线程随进程终止：仅 `scheduled` 标记，没有 `deadline`，无 JS 回调写入；新宿主启动后无旧模块活动 | `p4c/device/s3-result.txt`、`s3-state-after-kill.txt`、`post-kill-log-grep.txt` | 进程终止是唯一“硬终止”；也是唯一可接受的“已终止”证据路径 |
| F5 | 设备重启后探针模块不会自动加载、`custom_init_jsapis` 不会被调用；手动启动后一切正常 | `p4c/device/post-reboot-dynamic-load-lines.txt`、`post-reboot-maps-probe.txt`（空）、`after-reboot-probe-result.txt` | 上下文必须显式建立；重启后的恢复走显式路径，不依赖模块常驻 |

规范性原则：

- **P1**：Native 不得把任何宿主生命周期事件（页面停止 / 切后台 / 停止小程序 / 卸载 / 不可观测的运行时销毁）当作取消或停止投递的条件。
- **P2**：JS / DsRuntime 不得把“页面已销毁 / 应用已卸载”当作资源已释放的证据；终止必须由 JS 显式提交。
- **P3**：显式终止链（`cancel` / `cancelAll` / `closeContext`，见 §4.3）加投递闸门（§7.5）是唯一受认可的停止机制；`kill -9`（进程消失）是唯一的例外路径。
- **P4**：每次可观察投递都在闸门下执行——正确性不取决于“上游已经停了”，而取决于“投递前检查”。

### 4.3 显式终止链（JS → Native）

| 入口 | 粒度 | 效果 |
|---|---|---|
| `cancel({requestId})` | 单操作 | 原子提交该操作终态；stream 得 `cancelled(reason:"user")`，request reject `ERR_CANCELLED` |
| `cancelAll({contextId, reason?})` | 上下文批量 | 逐操作执行 `cancel()`；默认 `reason:"app-lifecycle-end"` |
| `closeContext({contextId})` | 上下文批量 + 封禁 | 停止接纳 → 批量提交 `cancelled(reason:"context-closed")` → `generation += 1` → `state:"closed"` |

保证条款：

- **G1（不依赖宿主）**：在宿主完全存活、没有任何生命周期事件的条件下，三个入口必须独立产生完整效果（停止读取 + 提交终态 + 闸门丢弃后续投递）。
- **G2（即时抑制）**：终态提交与投递抑制先于底层网络收尾生效；不得实现为“等网络线程退出再提交终态”。
- **G3（幂等与单终态）**：与 `cancel()` 相同的原子性、幂等性与竞态规则（先提交者获胜）。
- **规范顺序（生命周期结束）**：`cancelAll()` →（终态投递机会）→ `closeContext()`。
- 反例禁令：不得以“等待 runtime destroyed 事件”“依赖 GC / 析构”“依赖宿主回调兜底”实现终止；不得在 `closeContext()` 后投递除既有终态之外的任何内容。

### 4.4 五种销毁场景的 JS / Native 责任划分（1A-r1 必载）

| # | 场景 | 固件事实（证据） | Native 责任 | JS 责任 | 能否作为“已终止”证据 |
|---|---|---|---|---|---|
| 1 | **onStop**（退出页面 / 切页） | 实例未销毁、无 `onDestroy`；晚到回调仍被投递（F1） | 不把 onStop 当信号（也收不到）：继续按闸门投递；收到 `cancel` 后停止该操作的全部后续投递 | 页面停止时必须对本页拥有的未终止请求调用 `cancel`（或显式声明接管并记录）；不得假设页面销毁会停止回调 | **否**（只能作为“显式取消有效性 / 负向对照”） |
| 2 | **切后台**（appPaused / 回桌面） | 实例驻留、`.so` 保持映射；晚到仍投递（F2） | 无自动动作；后台事件不产生任何 cancelled/error | 后台不构成终止；若策略要求停止，必须显式 `cancel` / `cancelAll`；否则接受回调继续投递 | **否** |
| 3 | **停止小程序**（用户停止 / 切换走） | 同上（F2）：实例驻留，系统未对实例执行停止原语 | 无自动动作 | 按“App 生命周期结束”口径执行 `cancelAll` + `closeContext`；再次运行时用 `openContext()` 建立新 generation | **否** |
| 4 | **卸载**（uninstall） | `ignore dlclose`；晚到回调在已卸载的 app 上成功执行（F3） | 不依赖 `dlclose` / 卸载钩子；闸门对 closed generation 的投递继续丢弃 | 在最后一个可得的 App 生命周期节点执行 `cancelAll` + `closeContext`；不得等待卸载信号（§4.5） | **否** |
| 5 | **kill -9**（进程终止） | native 线程随进程消失；无 `deadline`、无 JS 写入（F4） | 无履行机会（进程已终止） | 无履行机会 | **是（唯一认可的硬终止证据）**；断言口径为“无任何晚到回调” |

补充对照（mock 与真机的差异，引用 `.probe/probe/p4c/EVIDENCE.md:41-51`）：S3 的效果等价于 mock `drop` 模式（消息/线程不复存在）；S1/S2/S4 在本固件上没有 mock 对应——框架并未真正释放上下文，mock `survive`（投递到已释放上下文 → SIGSEGV）在真机未出现。该差异说明：真机的风险不是“崩溃”，而是“回调在已卸载的应用上继续执行”。

### 4.5 卸载场景专门处理（1A-r1 必载）

- 事实：固件未观察到“所属 App 已卸载”到 JS 的可依赖信号；框架只在日志中记录 `AppLifecycle->appDestroyed` 并 `ignore dlclose`（`s4-log.txt`）。
- 规范：**JS 必须在 App 生命周期结束时主动 `cancelAll`（随后 `closeContext`）**；不得等待卸载信号。若未来固件提供卸载/销毁回调，该回调只能作为补充触发点，正确性不得依赖它。
- Native 责任：不得把 `jsapi_check_unload` 一类钩子作为唯一清理依赖；1B 是否导出该符号属设计决策，语义必须与显式终止链一致（列为未决问题，§10）。
- 残余风险声明：若 JS 完全没有执行机会（宿主被直接杀死 / 断电），唯一保障是进程终止；此时验收口径是“无晚到回调”，而不是“已取消”。

### 4.6 JS context 不可调用时的行为（原 T1A.1 §4.2 修订）

- 保留顺序：停止接纳新任务 → 取消所有未终止请求 → 回调抑制。
- 修订触发条件：改为“显式终止链执行过程中检测到 JS context 已不可调用”；不再以“宿主开始销毁 JS runtime”为前提（该信号不可依赖）。
- 若 JS context 仍可安全投递：每个未终止 stream 交付一次 `cancelled`（reason 按 §3.1 映射），普通 `request()` reject `ERR_CANCELLED`（runtime 终止链可用 `ERR_RUNTIME_DESTROYED`）。
- 若 JS context 已经不可调用：内部仍只提交一次 terminal 状态，但丢弃所有尚未投递的 JS 回调；绝不触碰失效 `JSContext`、`JSValue` 或用户函数。
- worker、socket、定时器和回调持有物必须在 context 引用释放前完成停止/解绑；不得依赖 QuickJS GC 代替网络任务取消。
- 终止闩锁与闸门状态必须保留到相关内存释放，防止清理阶段产生二次投递。
- 该行为覆盖 mock 的显式终止用例（M19）；真机的 kill -9 边界由 M28 覆盖（无投递可做，断言“无晚到”）。
---

## 5. 队列、缓存上限与背压（继承 T1A.1，未修订）

以下是 T1A.1 的固定默认上限；1A-r1 未做任何数值调整（P4c 不构成修订依据）。实现不得无界增长。数值改变必须升级契约版本并更新验收矩阵。

| 资源 | 硬上限 | 低水位/处理 | 超限行为 |
|---|---:|---|---|
| 全局活跃请求 | 32 | — | 新操作 reject `ERR_QUEUE_FULL` |
| 全局排队请求 | 64 | FIFO admission；同优先级不饿死 | 新操作 reject `ERR_QUEUE_FULL` |
| 单 `contextId` 活跃请求 | 8 | — | 该上下文新操作 reject `ERR_QUEUE_FULL` |
| 单 `contextId` 排队请求 | 16 | — | 该上下文新操作 reject `ERR_QUEUE_FULL` |
| 请求 body | 16 MiB | — | `ERR_INVALID_ARGUMENT` |
| `request()` 聚合响应 body | 8 MiB | — | reject `ERR_RESPONSE_TOO_LARGE` |
| response headers | 64 KiB | — | `ERR_RESPONSE_TOO_LARGE` |
| 单个 stream 的单条 chunk | 64 KiB | 大块必须拆分 | 不得交付超限 chunk |
| 单 stream 待投递事件 | 128 条 | 低于 64 条恢复读取 | 先暂停读取；读取不可暂停时报 `ERR_BACKPRESSURE` |
| 单 stream 待投递 payload | 1 MiB | 低于 512 KiB 恢复读取 | 先暂停读取；读取不可暂停时报 `ERR_BACKPRESSURE` |
| 全局待投递事件 | 512 条 | 低于 256 条恢复全局读取 | 新读取暂停；不可暂停的 stream 独立报 `ERR_BACKPRESSURE` |
| 全局待投递 payload | 4 MiB | 低于 2 MiB 恢复全局读取 | 同上 |

背压规则（继承）：

1. “待投递”从 Native 已取得但尚未在 JS 线程调用 `onEvent` 的数据开始计量；正在执行的回调不重复计量。
2. 首选真正暂停底层读取；不得通过无限扩大 Native buffer 或 QuickJS 消息队列解决慢消费者。
3. 每个 stream 预留一个 terminal slot。达到硬上限且底层读取不可暂停时，停止读取、丢弃尚未投递的 chunk，并在已排队前缀之后交付唯一的 `error(ERR_BACKPRESSURE)`。
4. `ERR_BACKPRESSURE` 是传输资源错误，不是业务重试指令；Native 不自动重试或换上下文。
5. `request()` 不产生流事件，因此只受 admission、headers、聚合 body 上限约束。
6. 取消优先于继续读取；取消后不得为了排空 socket 而继续产生用户可见 chunk。

1A-r1 补充：闸门检查（§7.5）发生在“投递到 JS”之前，“待投递”计量包含等待通过闸门的排队项；已 `closeContext` 的上下文不得因闸门丢弃而无限积压——丢弃即释放，不计入水位恢复的条件。

---

## 6. 多身份传输上下文隔离（继承 + 1A-r1 生命周期）

`contextId` 是唯一的传输隔离边界；它是一个不透明句柄，Native 不把它解释成账号。

### 6.1 每个上下文拥有

- 独立 Cookie Jar。
- 独立代理配置。
- 独立 Cookie epoch 和请求快照。
- 独立的活动请求计数/排队计数。
- 1A-r1 新增：独立的生命周期状态（`open`/`closed`）与 generation 计数（§6.5）。

### 6.2 每个请求 admission 时快照

- `contextId` 对应的代理配置。
- 发起时刻可发送的 Cookie。
- 本次请求的 method、URL、headers、body、timeout 和 redirect policy。
- 1A-r1 新增：admission 时刻的 context generation（作为该操作全部投递的 captured generation）。

### 6.3 明确禁止的跨上下文行为

- A 的 `Set-Cookie` 出现在 B 的请求中。
- A 的 `setProxy()` 改变 B 的新请求或已有请求。
- `clearCookies(A)` 删除 B 的 Cookie，或被 A 的晚到响应重新写回。
- 通过 Native 全局 mutable default、单例 Cookie Jar 或单例 proxy 覆盖调用方上下文。
- 在 Native 保存账号 ID、session ID、业务 token 或以这些字段命名的状态。
- 1A-r1 新增：用旧 generation 的上下文状态（Jar、代理、计数或未终止操作）服务新 generation 的请求；或把旧 generation 的投递放行到新 generation。

### 6.4 Cookie 发送和接收

- 若调用方没有显式 `Cookie` header，Native 按 `contextId` + URL 从 Jar 生成 Cookie header。
- 若调用方显式提供 `Cookie` header，按调用方值发送，不把其他上下文的 Cookie 合并进去。
- 响应 `Set-Cookie` 在 headers 事件/Response resolve 前写入同一上下文 Jar；跨上下文不可见。
- `clearCookies()` 的 epoch 规则防止清理后由旧请求的晚到 `Set-Cookie` 复活 Cookie。

### 6.5 上下文状态机与 generation（1A-r1 新增）

```text
(created, gen=1, open)
    │ closeContext()                      │ openContext()（对已 closed）
    ▼                                     ▼
(closed, gen=n+1)  ────── openContext() ──> (open, gen=n+2)
```

规范性规则：

1. generation 从 1 开始，单调递增；每次状态转换（创建、close、reopen）恰好 +1；重复 `closeContext()` 幂等，不再递增。
2. 每个 admission 记录 captured generation；该操作的所有投递都携带这份快照，投递前由闸门（§7.5）比对当前 generation。
3. `closed` 且未重开的上下文：一切新操作 reject `ERR_CONTEXT_CLOSED`；旧 generation 的一切非终态投递被丢弃。
4. 重开（`openContext()`）后：Cookie Jar 与代理配置重置为默认（新 generation 是新的隔离单元）；旧 generation 的未投递内容除已提交终态外全部丢弃。
5. cookie epoch（§2.6）与 context generation 相互独立：epoch 管“清理后不复活 Cookie”，generation 管“生命周期隔离与投递栅栏”；不得互相替代。
6. `contextId` + generation 组合仍不携带业务语义；Native 不得据此推断账号、session 或重试策略。

---

## 7. QuickJS 回调投递契约（1A-r1 修订）

### 7.1 线程规则

- 网络、连接、读取、超时和缓存工作运行在 Native worker/网络线程；QuickJS 主线程不执行阻塞网络操作。
- 任何 `onEvent` 调用、Promise resolve/reject、JSValue 创建/释放和用户 JS 异常读取只在对应 JS loop/thread 执行。
- 每个 stream 使用单一 JS-thread dispatcher，保证同一 stream 的 `seq` 顺序；不同 stream 之间不承诺全局顺序。

### 7.2 投递机制

契约允许两种实现层路径，但语义只有一套：

1. 优先使用 SDK 的 JS Handler/Looper，把带有 requestId、seq 和拥有数据的任务排队到 JS 线程后执行。
2. 若仅可经 `postJSMessage` 一类消息桥回投，消息体必须自含 requestId、seq 与数据所有权，不得把裸指针与生命周期绑定在宿主回调上。

无论走哪条路径，投递前必须完成（T1A.1 已列，1A-r1 将其并入闸门 §7.5）：

- transport 实例与 context 的有效性检查。
- requestId 与 stream generation 检查。
- 事件数据的独立所有权。
- 终止状态检查，避免 terminal 后投递晚到 chunk。

1A-r1 修订：`postJSMessage` 的返回值语义不可依赖——P4c 实测设备成功返回 1（非 0），失败/拒绝时的返回值未覆盖（`01-phase0-p4c.md:202-211` 第 3 条）；实现不得以 0/1 判定投递成败，投递结果以闸门状态与后续行为为准。

### 7.3 回调引用与 GC

- `openStream()` 接收的 `onEvent` 在 stream 结束、取消或 runtime 销毁时释放；不是全局永久订阅。
- 回调引用必须被 QuickJS GC mark/collect 机制覆盖；投递中的任务持有必要的 context/对象引用，context 失效后安全丢弃。
- 回调投递失败或 context 已销毁不得再次尝试调用失效 JS 值。
- 回调异常只记录，不改变 Transport 已提交的终止状态。

### 7.4 与参考实现的对应关系

（继承 T1A.1，未修订。）

- `JSCModuleExtension.h` 提供 `registerCModuleLoader()` 和 `postJSMessage()`，说明模块加载与跨线程回投是宿主支持的桥接点。
- Pen-LVGL 的 `JQAsyncExecutor` 将异步结果通过 JS Handler 排队到 JS 线程，提供 `onCallback*Async()` / `onErrorAsync()`，并在 JS 线程调用用户函数。
- Pen-LVGL 的 `JQPublishObject` 对订阅回调执行 GC mark/collect；本契约选择“每个 stream 一个回调”而非全局 topic，避免多个请求的事件串线。
- 这些是参考实现证据，不等同于本机 Transport 已通过；本机仍需在阶段 1B 的 mock/真机路径复核（并叠加 P4c 的“宿主不释放上下文”事实）。

### 7.5 投递闸门（1A-r1 新增，强制）

每一次 JS 可见投递（事件、Promise resolve/reject、`onEvent` 调用）在调用 JS 前必须通过以下检查：

```text
非终态投递（headers / chunk / 未终止操作的 Promise settle）：
  require  transport 实例仍在且该操作已登记
  require  该操作尚未提交终态
  require  ctx.state == "open"
  require  capturedGeneration == ctx.generation
  else     → 丢弃（不重试、不触碰 JS 值、不产生新终态）

终态投递（每个操作至多一次的唯一终态）：
  require  该操作已提交终态且尚未投递过
  require  JS 上下文仍可调用
  else     → 丢弃
  说明：终态允许在 closing/closed 或 generation 已提升后投递一次（§2.9 第 4 条）；
        该豁免仅限“本契约认可的终态提交路径”产生的终态，绝不适用于任何数据投递。

重复投递：
  require  该操作对应事件未投递过（含终态）
  else     → 丢弃
```

- 闸门检查是**投递前**动作（push 之前），而不是依赖上游停止；即使网络线程仍在工作、缓冲区仍有数据、宿主仍存活，检查失败即丢弃。
- 闸门状态（captured generation、终态闩锁、已投递标记）随操作生命周期维护，直到相关内存释放。
- 该条款是“无晚到投递”类断言（M25–M28）的实现基础；1B 评审必须能指出闸门代码位置。
---

## 8. Mock server 验收用例矩阵（M01–M31，1A-r1 更新）

### 8.1 执行约定

- Mock server 只提供通用 HTTP/HTTPS、Cookie、重定向、延迟、分片、代理记录和可控连接断开；不得包含 DeepSeek endpoint 或业务字段。
- 每条用例记录：请求上下文、requestId、代理路径、收到的 headers/body、事件序列、终止原因、队列峰值、是否发生晚到回调、宿主进程存活状态与 native 线程状态（`.so` 映射）。
- 销毁类用例（M19、M25–M31）另行记录：捕获的 generation、闸门检查结果、终态提交顺序、`cancelAll`/`closeContext` 返回值。
- 下面的“阶段 1A 状态”均为**契约已定义，尚未在本阶段运行**；不得把矩阵存在当作 G1 通过证据。
- 1A-r1 证据口径：除 M28 外，任何销毁场景的通过记录只能表述为“显式取消后无晚到投递 / 宿主不停止的负向对照”，不得表述为“宿主已终止”或“已由宿主释放”。

### 8.2 用例表

| ID | 场景/fixture | 调用与关键断言 | G1 覆盖 | 状态 |
|---|---|---|---|---|
| M01 | `GET /plain` 返回 200 小 body | `request()` resolve；status、headers、`Uint8Array` body、requestId 正确；无流事件 | GET / 普通请求 | 待 1B |
| M02 | `POST /echo` 返回收到的 JSON | body=`Uint8Array` 或 string；服务端收到精确字节；Response body 精确 | POST JSON | 待 1B |
| M03 | `/cookie/set` 返回 `Set-Cookie`，`/cookie/echo` 回显 Cookie | 同一 context 的第二次请求带 Cookie；Set-Cookie 在 resolve/headers 前可通过 `getCookies()` 观察 | Set-Cookie/回传 | 待 1B |
| M04 | 两个 context 交叉访问 cookie fixture | A 的 Cookie 不出现在 B；`clearCookies(A)` 后 B 仍有 Cookie；A 的旧请求晚到 Set-Cookie 不复活 | Cookie 隔离/清理 | 待 1B |
| M05 | 两个代理 fixture，分别写入 proxy marker | `setProxy(A)` 只使 A 走 proxy-A；B 直连或走 proxy-B；已有请求使用 admission 快照 | 代理隔离 | 待 1B |
| M06 | `/redirect/start` 返回 302 → `/redirect/final` 200 | 默认 `follow` 只交付最终 headers/end；最终 URL 正确；最多 5 跳 | 302 / redirect | 待 1B |
| M07 | 同一 302 使用 `redirect:"manual"` | 交付 status=302 的 headers/end，不访问 final；不产生 redirect 业务事件 | redirect policy | 待 1B |
| M08 | `/status/401` 返回 401 | `request()` resolve 401；`openStream()` 仍按 headers→chunk*→end；不得变成 Transport error | 401 | 待 1B |
| M09 | `/status/429` 返回 429 | 同 M08；业务层得到可观察 HTTP 状态；Native 不退避、不换 context、不重试 | 429 | 待 1B |
| M10 | `/stream/basic` 返回 headers + 3 chunks + close | 严格 `headers → chunk → chunk → chunk → end`；seq 连续；唯一终止 | 分片流 / 顺序 | 待 1B |
| M11 | UTF-8 字符拆在任意 byte 边界 | chunk 原样交付；Transport 不重组/解码；JS 拼接原始 bytes 可恢复完全 payload | 跨 chunk UTF-8 | 待 1B |
| M12 | `/stream/long` 持续输出，调用 `cancel()` | 取消后停止读取；只产生一次 `cancelled`；不再有 chunk/end/error；闸门丢弃取消后晚到数据 | 取消长流 | 待 1B |
| M13 | M12 中连续调用两次 `cancel()`，并覆盖 end/cancel 竞态 | 第一次 `cancel-requested`；第二次 `already-cancelled` 或 `already-terminal`；终止事件最多一条 | 取消幂等/竞态 | 待 1B |
| M14 | `/delay/headers` 或 `/delay/body` 超过 timeout | 只产生/返回 `ERR_TIMEOUT`；不会既 timeout 又 cancelled/end；socket/队列释放 | 连接/整体超时 | 待 1B |
| M15 | 同一 context 重复请求 + 不同 context 并发请求 | requestId 不重复；无 Cookie/代理串用；每个 Promise/stream 各自 settle/terminal 一次 | 重复请求 | 待 1B |
| M16 | 32+ 活跃、64+ 排队和单 context 超限 | 超过固定上限立即 `ERR_QUEUE_FULL`；队列不无界；已接受请求顺序可追踪 | 队列上限 | 待 1B |
| M17 | 慢 `onEvent`，server 发送超过 1 MiB/128 events | 先暂停读取并在低水位恢复；读取不可暂停时只报一次 `ERR_BACKPRESSURE`，不突破硬上限 | 背压/缓存上限 | 待 1B |
| M18 | `request()` body/response/header 超限 fixture | 分别触发 `ERR_INVALID_ARGUMENT`、`ERR_RESPONSE_TOO_LARGE`；无泄漏、无二次 settle | 缓存上限 | 待 1B |
| M19 | **显式终止链**：对含 pending request/stream 的 context 依次执行 `cancelAll()` 与 `closeContext()`（1A-r1 重定义） | 各 stream 恰得一次 `cancelled`（reason 按 §3.1 映射：`app-lifecycle-end` / `context-closed`）；`request()` reject `ERR_CANCELLED`；close 后新 admission reject `ERR_CONTEXT_CLOSED`；无二次 settle、无晚到 chunk；`outcomes` 与实际结果一致 | 销毁场景（显式链） | 待 1B |
| M20 | 本地 TLS fixture + ALPN h2/h1 记录器 | 记录 TLS 握手、ALPN、协议版本；请求结果与 h2/h1 期望一致；失败分类稳定 | TLS/HTTP2 | 待 1B |
| M21 | 代理 fixture 下的 TLS/HTTP2 请求 | 只通过指定 context 代理；代理错误为 `ERR_PROXY`/`ERR_NETWORK`；不影响其他 context | 代理行为证据 | 待 1B |
| M22 | headers 前断连、headers 后断连、空 body | 前者仅 `error`；后者 `headers→error`；空 body 为 `headers→end` | 错误/空流 | 待 1B |
| M23 | `Set-Cookie` 与 `clearCookies()` 并发 | clear epoch 后的旧响应不得写回；新 admission 使用清理后的快照 | Cookie race | 待 1B |
| M24 | 回调主动抛 JS exception | 记录 callback exception；Transport 不重复 terminal，不把用户异常伪装成网络 error | 回调隔离 | 待 1B |
| M25 | **S1 对应：宿主页面停止**（宿主不向 Native 发任何销毁信号；对应 `p4c/device/s1-*`） | (a) 负向对照：不调用 cancel 时晚到事件仍被投递，且 Transport 不因“页面已停止”自行停止；(b) 调用 `cancel()` 后：该操作零后续投递、终态唯一；断言宿主页面停止本身不产生任何终态 | 销毁责任 / S1 | 待 1B |
| M26 | **S2 对应：切后台 / 停止小程序**（appPaused 不触发任何 Native 终止；对应 `p4c/device/s2-*`） | (a) 后台状态下投递继续（负向对照）；(b) `cancelAll()` 后零后续投递；断言后台/停止事件不产生 cancelled/error、不改变闸门状态 | 销毁责任 / S2 | 待 1B |
| M27 | **S4 对应：卸载**（模拟“无卸载信号 + `ignore dlclose`”；对应 `p4c/device/s4-*`） | (a) 负向对照：未显式取消时晚到投递仍会执行；(b) 按 §4.5 在最后一个可得生命周期节点执行 `cancelAll()+closeContext()`：无晚到执行、无失效 JS 访问；断言实现不以 `dlclose`/卸载钩子为正确性前提；close 后旧 generation 投递全部丢弃（终态豁免除外） | 卸载专门处理 / S4 | 待 1B |
| M28 | **S3 对应：kill -9 硬终止**（唯一认可的“已终止”证据；对应 `p4c/device/s3-*`） | 挂起请求时对宿主执行 `kill -9`：native 标记止于 kill 之前（无 deadline/post/trampoline）；无任何 JS 回调写入；宿主重启后无旧 `.so` 活动、无 probe 命中；**断言“无任何晚到回调”**。执行约束：先拉取日志再 kill（宿主重启会删除旧日志，`p4c/EVIDENCE.md:53-67`） | 硬终止证据 / S3 | 待 1B |
| M29 | **context 状态机与 generation** | `closeContext()` 幂等（不二次递增、不产生新终态）；closed 后所有操作 reject `ERR_CONTEXT_CLOSED`；`openContext()` 重开后 generation+1，旧 generation 的晚到投递全部丢弃（终态豁免除外）；`clearCookies()` epoch 语义不受影响 | 显式生命周期 | 待 1B |
| M30 | **终态闩锁后的晚到注入** | 对已提交 `end`/`error`/`cancelled` 的 stream 注入后续 chunk/网络完成/重复取消：全部丢弃；无第二次回调、无二次 settle；先提交终止者获胜 | 终止唯一路径 | 待 1B |
| M31 | **cancelAll 并发与幂等** | `cancel()` 与 `cancelAll()`、`closeContext()`、正常完成并发：每操作恰一个终态；重复 `cancelAll()` 返回 `already-*` 语义且不改变已提交状态；`outcomes` 与实际一致；`cancelAll` 不改变上下文 open 状态 | 显式终止链 | 待 1B |

### 8.3 G1 门槛映射（1A-r1 更新）

| G1 门槛项 | 矩阵用例 |
|---|---|
| GET | M01 |
| POST JSON | M02 |
| Set-Cookie/回传 | M03、M04、M23 |
| HTTP 302 | M06、M07 |
| HTTP 401/429 | M08、M09 |
| SSE/原始分片流 | M10、M11、M22 |
| 跨 chunk UTF-8 | M11 |
| 取消长流 | M12、M13、M30 |
| 连接/整体超时 | M14 |
| 重复请求 | M15 |
| 销毁场景（显式终止链） | M19、M29、M30、M31 |
| 销毁硬证据（kill -9，唯一认可） | **M28（必须执行并断言“无任何晚到回调”）** |
| 销毁责任负向对照（S1/S2/S4） | M25、M26、M27（只证明“宿主不停止 + 显式取消有效”，不作为“已终止”证据） |
| 队列/缓存上限 | M16、M17、M18 |
| 代理隔离 | M05、M21 |
| TLS/HTTP2 证据 | M20、M21 |

G1 放行要求（1A-r1 修订）：

1. M01–M31 均有可重放的请求日志、事件序列和资源峰值记录；mock 结果与真机结果分栏记录。
2. M28（kill -9）必须执行且断言“无任何晚到回调”；缺少该用例或断言失败时，G1 的“销毁场景”项按未通过处理。
3. M25–M27（S1/S2/S4 对应场景）的记录不得作为“宿主已终止投递/已释放资源”的证据；它们只用于（a）证明宿主不停止的负向对照，（b）证明显式终止链在被调用后有效。
4. 单纯 `request()` 返回 200 不得替代 M20/M21 的 TLS、HTTP2 和代理证据（继承）。
---

## 9. 证据与来源（1A-r1 更新）

### 9.1 本地规划与基线

| 证据 | 关键内容 |
|---|---|
| `G:\youdao\Deepseek\重构计划\总体重构路线.md:150-166` | 阶段 1 需要统一 request/stream/headers/chunk/end/error/cancel，明确终止唯一性、取消、队列/缓存、背压、上下文隔离、QuickJS 回调；G1 要求 GET、POST JSON、Cookie、302、401/429、分片流、跨 chunk UTF-8、取消、超时、重复请求、销毁全部有证据。 |
| `G:\youdao\Deepseek\重构计划\总体重构路线.md:83-92` | 明确源计划中 `requestStream/data` 与 `openStream/chunk` 存在分叉，本阶段只保留一套正式契约。 |
| `G:\youdao\Deepseek\重构计划\下一步开发计划.md:133-186` | 原始 Transport 边界、普通响应/流事件草案和禁止混入的业务概念。本文将 `requestStream` 替换为 `openStream`，将 `data` 替换为 `chunk`，并补全 cancel/终止语义。 |
| `G:\youdao\Deepseek\重构计划\下一步开发计划.md:749-792` | 阶段 1 范围：Chrome136 emulation、UA、HTTP/2、Cookie、代理、超时、重定向、request、stream、cancel、headers/body；mock 场景清单。 |
| `G:\youdao\Deepseek\重构计划\00-baseline.md:210-218` | G7（Transport 契约未冻结）和 G8（mock 矩阵未成套）是阶段 1 前缺口；本文针对这两项交付契约和矩阵，不宣称运行通过。 |

### 9.2 阶段 0 真机证据

| 证据 | 对本文的作用 |
|---|---|
| `G:\youdao\Deepseek\.probe\probe\VERIFY.md:19-25` | 本机已记录 `dlopen → custom_init_jsapis → registerCModuleLoader`、`postJSMessage` 回投、同步/Promise/订阅回调的宿主事实；只支撑桥接设计，不支撑 Transport 已实现。 |
| `G:\youdao\Deepseek\.probe\probe\VERIFY.md:41-54` | P1–P3 通过；其中“P4c 设备重启仍未测”的状态已由 `.probe/probe/p4c/` 真机证据关闭（`VERIFY.md` 本身按原样保留，`p4c/EVIDENCE.md:68-70` 有说明）。 |
| `G:\youdao\Deepseek\.probe\probe\VERIFY.md:70-82` | 安装后 `.so` 会被 PMS 注入 SONAME/RUNPATH 并改名；Transport 阶段仍需按真实安装形态复核模块加载。 |

### 9.3 Pen-LVGL 参考实现

| 参考路径 | 观察到的模式 |
|---|---|
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\jsmodules\JSCModuleExtension.h:14-35` | `registerCModuleLoader()` 注册 C 模块；`postJSMessage()` 专门把后台消息投回 JS loop，禁止跨线程直接调用 JS。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\jqutil_v2\JQAsyncExecutor.h:39-87` | 异步 Promise/回调 ID、JS Handler、异步 callback/error API 和 context holder 的接口形态。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\src\jqutil_v2\JQAsyncExecutor.cpp:384-425` | `removeCallbackAsync()`、`onCallback*Async()` 通过 JS Handler 排队，真正调用在 JS 线程完成。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\src\jqutil_v2\JQPublishObject.cpp:14-31,47-65` | 发布订阅回调有 GC mark/collect、token 和取消机制；本文采用每 stream 私有 callback，避免全局 topic 串流。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\JQuickContext.h:108-121` | 宿主提供应用 lifecycle callback；本文据此定义 runtime destroy 的停止接纳、取消、回调抑制顺序。 |

### 9.4 P4c 真机证据（1A-r1 核心依据）

| 证据 | 关键内容 | 对本文的作用 |
|---|---|---|
| `docs/astra/01-phase0-p4c.md:10-24` | Q1/Q2 结论：非进程终止的四种“销毁”都不停止 native 线程与 JS 回调；`kill -9` 无投递；“宿主销毁即停投递”假设被否证 | §4.2 原则、§4.4 责任划分、§11 进入条件 |
| `docs/astra/01-phase0-p4c.md:171-187` | S1–S4 逐场景明细（含 `post-rc-nonzero(1)` 说明与 mock 对照） | §4.2 F1–F4、§8 M25–M28 |
| `docs/astra/01-phase0-p4c.md:202-211` | 未决输入：取消/销毁语义显式化（第 1 条）、`ignore dlclose`（第 2 条）、`postJSMessage` 返回值语义（第 3 条）、日志保留策略（第 4 条） | §7.2、§4.5、§10 |
| `.probe/probe/p4c/EVIDENCE.md:6-13` | 证据索引：Q1/Q2 结论与原始文件对应关系 | 全篇证据引用入口 |
| `.probe/probe/p4c/EVIDENCE.md:41-51` | mock 三态（alive/drop/survive）与真机差异：设备 `postJSMessage` 成功返回 1；S4 未崩溃因框架未真正释放 | §4.4 补充对照、§7.2、§8.1 |
| `.probe/probe/p4c/device/s1-result.txt`、`s1-log.txt` | 页面停止后晚到回调仍执行并写文件；日志仅 `onStop`、无 `onDestroy` | F1、M25 |
| `.probe/probe/p4c/device/s2-state-after-stop.txt`、`s2-result.txt` | 切后台后 3 s/45 s `.so` 仍映射、实例驻留；晚到回调仍执行 | F2、M26 |
| `.probe/probe/p4c/device/s3-result.txt`、`s3-state-after-kill.txt`、`post-kill-log-grep.txt` | `kill -9` 后仅 `scheduled`，无 `deadline`、无 JS 写入；新宿主无旧模块活动 | F4、M28（唯一硬终止口径） |
| `.probe/probe/p4c/device/s4-result.txt`、`s4-late-hit.json`、`s4-log.txt` | 卸载后 `ignore dlclose`；晚到回调在已卸载 app 上成功执行 JS；`mkdir failed` 记录 | F3、§4.5、M27 |
| `.probe/probe/p4c/device/post-reboot-dynamic-load-lines.txt`、`post-reboot-maps-probe.txt`（空）、`after-reboot-probe-result.txt` | 重启后模块未自动加载；手动启动后正常 | F5、§4.3（上下文显式建立） |

---

## 10. 未决问题与验证边界（1A-r1 更新）

以下项目不是接口命名分叉；标注“待验证”的条目在被实测确认前不得写入接口语义，实现必须选择保守默认并保留调整点：

1. **固件是否向 JS 暴露 App 级销毁 / 卸载回调：待验证。** P4c 未观察到可依赖信号（`s4-log.txt` 的 `appDestroyed` 仅为框架内部日志）；1A-r1 按“不可依赖”设计，补充测项。
2. **`postJSMessage` 返回值语义：待验证（部分）。** 设备成功返回 1（非 0），失败/拒绝路径未覆盖；实现不得用 0/1 判定成败（`01-phase0-p4c.md:202-211` 第 3 条）。
3. **`jsapi_check_unload` 钩子：设计决策 + 待验证。** 未导出该符号的库被框架 `ignore dlclose`（S4）；1B 若选择导出，其语义必须与显式终止链一致，且不得作为唯一清理依赖。
4. **同一宿主进程内“卸载后重装并再次启动”的同 appid 行为：待验证。** P4c 未覆盖（回滚阶段为重启宿主后的干净状态）；新旧 native 模块状态并存的未知由 generation 机制兜底设计，但需要真机补测。
5. **页面生命周期的可得钩子范围：待验证。** 同页面重复 `start` 不重跑 `created()`（`VERIFY.md` N2 与 P4c 再次确认）；是否还有 `onHide`/`onUnload` 一类可挂钩子未系统梳理，影响 §4.5 的“最后可得节点”选择。
6. 设备 runtime 在显式终止链执行期间允许的最后一个安全 JS loop 时刻：仍待验证；1A-r1 已按“闸门丢弃”设计，不依赖该时刻的精确性。
7. X7 Pro 上真实 Transport 依赖的 HTTP/2、TLS profile、ALPN 和代理库能否在现有 JSAPI 进程中稳定运行（继承）。
8. 实现所选网络栈能否在读取不可暂停时精确执行 `ERR_BACKPRESSURE` 的硬上限行为；必须通过 M17 实测峰值确认（继承）。
9. 真实代理错误、TLS 失败和 HTTP/2 fallback 的错误 code 映射；必须在 M20/M21 中固定日志和 code（继承）。
10. 16 MiB 请求 body 与 8 MiB 聚合响应上限是否覆盖未来阶段 3 的所有业务输入；阶段 3 若需要上传流式 body，必须另立接口/契约版本，不得偷偷放宽当前上限（继承）。

这些问题不会恢复旧命名，也不允许通过增加别名规避契约；它们是阶段 1B 的实现/验证清单。

---

## 11. 阶段 1B 进入条件（1A-r1 修订）

阶段 1B 只能在以下条件全部满足后开始：

1. 本文件（T1A.2-r1）是唯一 Transport 契约；`request` / `openStream` / `cancel` / `setProxy` / `clearCookies` / `getCookies` 的命名、取消幂等、背压水位与上下文隔离按 T1A.1 继承项保持不变；不得回退到 `requestStream`、`data` 事件或第二套 terminal 语义。
2. **显式终止链是硬性实现项，不得依赖宿主兜底**：context 状态机（open/closed + generation）、投递闸门（§7.5）、`cancelAll`、`closeContext`、终止闩锁（§3.2）必须成套实现；评审时按“是否存在把宿主销毁 / 生命周期回调当作取消、停止投递或释放资源的代码或假设”逐条检视，命中即不满足进入条件。
3. **销毁验收必须包含 kill -9 用例（M28）并断言“无任何晚到回调”**；S1/S2/S4 场景（M25–M27）只能作为显式取消有效性与负向对照证据，任何一处都不得作为“已终止 / G1 销毁项通过”的证据。
4. **JS 生命周期义务在 1B 必须落为接口与联调桩**：在最后一个可得的 App 生命周期节点执行 `cancelAll()` + `closeContext()`（§4.5）；不得等待固件卸载信号。
5. 按 M01–M31 建立可重放 mock server/fixture；至少先完成静态契约检查、事件序列断言、Cookie/代理隔离断言、队列/背压峰值断言、显式终止链断言与 kill -9 断言。
6. 实现计划承诺：普通请求只走 `request()`，流式请求只走 `openStream()`；不实现 `stream:true` 兼容分支，不暴露 `requestStream()` 或 `data`（继承）。
7. 实现计划承诺：所有 HTTP 401/429 作为可观察响应交给 JS；Native 不加入业务重试、账号切换、PoW、session 或 DeepSeek 逻辑（继承）。
8. 明确 mock 与真机两套结果表：M20/M21 的 TLS、HTTP2、代理行为必须有独立证据，不得以普通 200 响应替代（继承）。
9. 保护文件 `ds.js`、`native.js`、`backend-blob.js` 以及现有默认入口保持不变；阶段 1B 的代码应有独立回滚边界（继承）。
10. §10 的待验证项不得以猜测方式固化为接口语义；实现必须为它们选择保守默认并留出调整点。

**停止条件**：显式终止链未成套实现、kill -9 断言缺失、或实现中仍存在宿主生命周期依赖时，不得宣称 G1 通过，不得将本阶段标记为完成。

---

## 12. 阶段 1A 结论（1A-r1）

- `request` 是唯一普通请求入口；`openStream` 是唯一流请求入口；不再存在 `requestStream`。
- `chunk` 是唯一流数据事件；不再存在 `data`。
- `headers` 只表示响应元数据，`end`/`error`/`cancelled` 是互斥且唯一的 terminal 事件；任何终态提交后，该操作后续投递全部丢弃（终止闩锁 + 投递闸门）。
- `cancel` 由 JS 主动触发、不依赖宿主生命周期；`cancelAll`（上下文批量）与 `closeContext`（批量 + 封禁 + generation 提升）构成完整显式终止链。
- `contextId` 具有显式 `open/closed` 状态与 generation 计数；Native 每次投递前检查；closed 且未重开的上下文拒绝新操作。
- **宿主销毁不是停止条件**：onStop、切后台、停止小程序、卸载均不停止 native 线程与 JS 回调（P4c）；`kill -9` 是唯一受认可的硬终止证据，销毁验收必须包含该场景并断言“无任何晚到回调”。
- Cookie Jar 与代理均按 `contextId` 隔离；Native 不识别账号，不持有业务状态。
- 流事件有确定顺序、有限缓存和背压错误；QuickJS 回调只能经 JS loop 投递，且全部经过投递闸门。
- G1 的 mock 验收矩阵（M01–M31）已成套列出，但本文件不伪造实现或运行证据；阶段 1B 必须逐项执行并记录结果。

---

## 13. 修订记录摘要（详细版见 `02c-phase1-r1-revision-record.md`）

| 编号 | 修订点 | 落点 | 核心依据 |
|---|---|---|---|
| R1 | 宿主销毁不构成终止：原则 P1–P4 与事实 F1–F5 | §4.2 | P4c S1–S4、Q1 |
| R2 | `contextId` 显式 closed 状态 + generation + 投递前检查 | §2.1、§2.8、§2.9、§6.5、§7.5 | P4c S4、S2、`01-phase0-p4c.md:202-211` 第 1 条 |
| R3 | `cancel` 可由 JS 主动触发、不依赖宿主生命周期；新增 `cancelAll` | §2.4、§2.10、§4.3 | P4c 四场景“宿主均不停止”+ S3 唯一硬终止 |
| R4 | `openStream` 终止收敛唯一路径：终止闩锁 + 后续投递全丢弃 | §2.3、§3.2（11–13）、§7.5 | P4c S1/S2/S4 晚到投递事实 |
| R5 | 五种销毁场景 JS/Native 责任划分 | §4.4 | P4c S1–S4 |
| R6 | 卸载专门处理：无卸载信号 → JS 在最后可得生命周期节点 `cancelAll` | §4.5 | P4c S4（`ignore dlclose`） |
| R7 | 矩阵更新：M19 重定义，新增 M25–M31；kill -9 为唯一硬证据 | §8 | P4c S1–S4 |
| R8 | 1B 进入条件修订：显式终止链必选、kill -9 断言必含 | §11 | P4c 全部结论 |
| R9 | 未决问题更新（卸载信号、`postJSMessage` 返回值、`jsapi_check_unload`、同宿主重装） | §10 | `01-phase0-p4c.md:202-211` |
| R10 | 证据来源更新（P4c 映射、VERIFY 状态说明） | §9.2、§9.4 | `p4c/EVIDENCE.md` |