# 阶段 1A：Native Transport 接口契约与验收矩阵

- **文档版本**：T1A.1
- **阶段**：阶段 1A（契约冻结；不含 Transport 实现）
- **冻结日期**：2026-09-27（Asia/Shanghai）
- **工作区**：`G:\youdao\Deepseek`
- **当前 HEAD**：`421e4d075fc5695e627b67b327299456359e5e9e`
- **状态**：接口、事件、取消、上下文隔离、队列/缓存上限和 mock 验收矩阵已冻结；实现与 G1 运行证据未在本阶段执行。

> 本文是阶段 1B 的唯一 Transport 契约基线。后续实现不得通过兼容别名重新引入 `requestStream`、`data` 或第二套终止事件。若必须改变本文的外部语义，先递增契约版本、更新矩阵，再开始实现。

> **修订声明（2026-09-30，1A-r1）**：本文版本 T1A.1 已被 [`02b-phase1-transport-contract-r1.md`](02b-phase1-transport-contract-r1.md)（T1A.2-r1）替代——阶段 0 P4c 真机验证否证了“宿主销毁会停止回调 / 释放上下文”的隐含假设。阶段 1B 只以修订版为唯一契约。被替代的具体内容：§4.2（宿主销毁语义）、§8.2 的 M19 及矩阵扩展（M25–M31）、§10 第 3 项、§11（1B 进入条件）、§12 相关结论。以下内容原样保留并原样继承进修订版：§2–§3 接口与事件命名、§5 队列/背压水位、§6 上下文隔离、§7.1–§7.4 投递规则；两者冲突时以修订版为准。修订点与证据映射见 [`02c-phase1-r1-revision-record.md`](02c-phase1-r1-revision-record.md)。

---

## 1. 阶段边界

### 1.1 本阶段冻结的内容

1. Native Transport 对 QuickJS 暴露的唯一操作名：`request`、`openStream`、`cancel`、`setProxy`、`clearCookies`、`getCookies`。
2. 普通响应与原始字节流的返回形态。
3. 流事件类型、顺序、序号和唯一终止规则。
4. 取消的竞态、幂等和错误返回语义。
5. 请求队列、响应缓存、流事件缓存和背压上限。
6. `contextId` 作用域内的 Cookie Jar、代理配置和请求快照规则。
7. 所有回调/Promise 投递到 QuickJS 的线程与生命周期约束。
8. G1 所需的 mock server 验收用例矩阵。

### 1.2 明确不在本阶段

- 不实现完整 Transport 库、TLS/HTTP2 适配、代理适配或 Cookie Jar。
- 不加入 DeepSeek endpoint、账号、token、session、PoW、mute、retry policy、业务 SSE 解析或业务错误分类。
- 不修改或切换现有 `ds.js`、`native.js`、`backend-blob.js`，不替换默认入口。
- 不把响应解析成 SSE、JSON 业务事件或模型事件；Transport 只交付 HTTP 元数据和原始字节。
- 不在 Native 保存账号、会话、业务配置或跨重启持久化状态。

### 1.3 变更保护

- `app/HOWTOBUILD.md` 在本轮开始前已有工作区修改，属于既有变更，本文不触碰。
- 本文新增前的保护文件为：`app/src/services/ds.js`、`app/src/services/native.js`、`app/src/services/backend-blob.js`；阶段 1A 不改动这些文件。
- 本阶段只新增本文件；任何实现、构建、设备安装或默认路径切换均属于阶段 1B 及之后。

---

## 2. 冻结后的公共 API

Native 模块名沿用路线规划中的 `libjsapi_ds_transport.so` / `ds_transport`。以下签名是 JS 侧契约的规范写法；C++/JSAPI 内部可以使用不同的私有函数名，但不得改变 JS 可见语义。

### 2.1 公共类型

```js
/** 由调用方生成；只用于传输相关联和取消，不表达账号或业务语义。 */
type RequestId = string

/** 由调用方生成；同一 Transport 实例内必须唯一，且不得包含业务对象引用。 */
type ContextId = string

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

固定规则：

- `requestId` 和 `contextId` 为非空 UTF-8 字符串，长度上限 128 字节。
- `method` 按 HTTP token 校验并在传输层规范化为大写；`url` 必须是绝对 HTTP(S) URL。
- 请求头名称大小写不敏感；返回时全部转为小写。`Set-Cookie` 等重复头不得被覆盖。
- `body` 作为不透明字节交给网络层。Transport 不依据 URL、header 或 body 猜测业务类型。
- `timeoutMs` 是整个操作的 deadline，包含排队、连接、重定向、发送和接收；超时统一产生 `ERR_TIMEOUT`。
- `redirect: "follow"` 最多跟随 5 次，只对最终响应交付 `headers`；`manual` 把 3xx 当作普通 HTTP 响应；`error` 遇到 3xx 产生 `ERR_REDIRECT`。
- HTTP 状态码不是 Transport 异常：401、429、以及其他 4xx/5xx 都以正常 HTTP 响应交给 JS。

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
        "ERR_RUNTIME_DESTROYED",
  message: string,
  requestId: string,
}
```

- `request()` 不发出流事件，也不接受 `stream: true`。需要增量字节事件时必须使用 `openStream()`。
- `requestId` 在调用方生成，使 `request()` 在 Promise settle 前即可被 `cancel()` 取消。
- 响应 body 聚合完成、Cookie 处理完成后才 resolve；body 超过单响应上限时 reject `ERR_RESPONSE_TOO_LARGE`。

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

### 2.4 `cancel({requestId})`：统一取消

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

### 2.5 `setProxy({contextId, proxy})`：上下文级代理

```js
Promise<{ contextId: ContextId, enabled: boolean }> setProxy({
  contextId: ContextId,
  proxy: ProxyConfig,
})
```

- 代理配置只属于指定 `contextId`；`proxy: null` 表示该上下文恢复直连。
- 只影响调用成功后新接纳的请求；已经排队/连接/发送的请求使用其 admission 时的代理快照。
- 不存在“全局当前代理”；一个上下文的 `setProxy()` 不影响任何其他上下文。
- 支持能力以 URL scheme 校验；不支持的 scheme 或不可解析配置 reject `ERR_PROXY`/`ERR_INVALID_ARGUMENT`。
- 代理用户名和密码只在 Native 内存中使用，不通过 `getCookies()`、事件或普通日志回显。

### 2.6 `clearCookies({contextId})`：上下文级清理

```js
Promise<{ contextId: ContextId, cleared: number }> clearCookies({
  contextId: ContextId,
})
```

- 只清理指定 `contextId` 的 Cookie Jar；不清理其他上下文，不清理请求显式传入的 `Cookie` header。
- 清理操作递增该上下文的 cookie epoch。清理之后才完成的旧请求，其晚到 `Set-Cookie` 不得把 Cookie 写回已清空的 Jar。
- 已经在清理前提交并写入 Jar 的 Cookie 会被计入 `cleared`；`clearCookies()` 自身不发网络请求。
- `clearCookies()` 不改变代理、TLS、UA、请求队列或已有请求的取消状态。

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
      reason: "user" | "runtime-destroyed" | "timeout-policy",
    }
```

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

### 3.3 回调数据所有权

- `headers`、错误对象和 `Uint8Array` 均为该次回调的 JS-owned 值；回调返回后调用方不得依赖 Native 内部 buffer。
- Native 不把可变网络 buffer 的裸指针交给 QuickJS；需要保留数据时由 JS 复制。
- `chunk` 的边界只受传输/缓存上限影响，不保证与 TCP、HTTP/2 DATA、SSE 行或 UTF-8 字符边界一致。

---

## 4. 取消、终止和宿主销毁

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
- `end/error/cancelled` 进入 terminal 后，连接、读取任务、队列节点和 JS 回调引用进入清理流程。

### 4.2 QuickJS runtime 销毁

- 宿主开始销毁 JS runtime 时，Transport 先停止接纳新任务，再取消所有属于该 runtime 的未终止请求。
- 若 JS context 仍可安全投递：每个未终止 stream 交付一次 `cancelled(reason: "runtime-destroyed")`，普通 `request()` reject `ERR_RUNTIME_DESTROYED`。
- 若 JS context 已经不可调用：内部仍只提交一次 terminal 状态，但丢弃所有尚未投递的 JS 回调；绝不触碰失效 `JSContext`、`JSValue` 或用户函数。
- worker、socket、定时器和回调持有物必须在 context 引用释放前完成停止/解绑；不得依赖 QuickJS GC 代替网络任务取消。
- 该行为覆盖阶段 1 的销毁 mock；真实设备的宿主 lifecycle 仍需在阶段 1B/真机证据中复核。

---

## 5. 队列、缓存上限与背压

以下是 T1A.1 的固定默认上限；实现不得无界增长。数值改变必须升级契约版本并更新验收矩阵。

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
| 单 stream 待投递事件 | 128 条 | 低于 64 条恢复读取 | 先暂停读取；无法暂停则 `ERR_BACKPRESSURE` |
| 单 stream 待投递 payload | 1 MiB | 低于 512 KiB 恢复读取 | 先暂停读取；无法暂停则 `ERR_BACKPRESSURE` |
| 全局待投递事件 | 512 条 | 低于 256 条恢复全局读取 | 新读取暂停；无法暂停的 stream 独立报 `ERR_BACKPRESSURE` |
| 全局待投递 payload | 4 MiB | 低于 2 MiB 恢复全局读取 | 同上 |

背压规则：

1. “待投递”从 Native 已取得但尚未在 JS 线程调用 `onEvent` 的数据开始计量；正在执行的回调不重复计量。
2. 首选真正暂停底层读取；不得通过无限扩大 Native buffer 或 QuickJS 消息队列解决慢消费者。
3. 每个 stream 预留一个 terminal slot。达到 hard limit 且无法暂停时，停止读取、丢弃尚未投递的 chunk，并在已排队前缀之后交付唯一的 `error(ERR_BACKPRESSURE)`。
4. `ERR_BACKPRESSURE` 是传输资源错误，不是业务重试指令；Native 不自动重试或换上下文。
5. `request()` 不产生流事件，因此只受 admission、headers、聚合 body 上限约束。
6. 取消优先于继续读取；取消后不得为了排空 socket 而继续产生用户可见 chunk。

---

## 6. 多身份传输上下文隔离

`contextId` 是唯一的传输隔离边界；它是一个不透明句柄，Native 不把它解释成账号。

### 6.1 每个上下文拥有

- 独立 Cookie Jar。
- 独立代理配置。
- 独立 Cookie epoch 和请求快照。
- 独立的活动请求计数/排队计数。

### 6.2 每个请求 admission 时快照

- `contextId` 对应的代理配置。
- 发起时刻可发送的 Cookie。
- 本次请求的 method、URL、headers、body、timeout 和 redirect policy。

### 6.3 明确禁止的跨上下文行为

- A 的 `Set-Cookie` 出现在 B 的请求中。
- A 的 `setProxy()` 改变 B 的新请求或已有请求。
- `clearCookies(A)` 删除 B 的 Cookie，或被 A 的晚到响应重新写回。
- 通过 Native 全局 mutable default、单例 Cookie Jar 或单例 proxy 覆盖调用方上下文。
- 在 Native 保存账号 ID、session ID、业务 token 或以这些字段命名的状态。

### 6.4 Cookie 发送和接收

- 若调用方没有显式 `Cookie` header，Native 按 `contextId` + URL 从 Jar 生成 Cookie header。
- 若调用方显式提供 `Cookie` header，按调用方值发送，不把其他上下文的 Cookie 合并进去。
- 响应 `Set-Cookie` 在 headers 事件/Response resolve 前写入同一上下文 Jar；跨上下文不可见。
- `clearCookies()` 的 epoch 规则防止清理后由旧请求的晚到 `Set-Cookie` 复活 Cookie。

---

## 7. QuickJS 回调投递契约

### 7.1 线程规则

- 网络、连接、读取、超时和缓存工作运行在 Native worker/网络线程；QuickJS 主线程不执行阻塞网络操作。
- 任何 `onEvent` 调用、Promise resolve/reject、JSValue 创建/释放和用户 JS 异常读取只在对应 JS loop/thread 执行。
- 每个 stream 使用单一 JS-thread dispatcher，保证同一 stream 的 `seq` 顺序；不同 stream 之间不承诺全局顺序。

### 7.2 投递机制

契约允许两种实现层路径，但语义只有一套：

1. 优先使用 SDK 的 JS Handler/Looper，把带有 requestId、seq 和拥有数据副本的任务排入 JS 线程；或
2. 使用宿主 `postJSMessage(CJSMessageFunction, context, argc, argv[])` 把消息投回 JS loop，再在 JS 线程构造事件并调用回调。

实现不得从网络线程直接调用 `JS_Call` 或用户回调。每条投递任务必须拥有：

- runtime/context 的有效性检查。
- requestId 与 stream generation 检查。
- 事件数据的独立所有权。
- 终止状态检查，避免 terminal 后投递晚到 chunk。

### 7.3 回调引用与 GC

- `openStream()` 接收的 `onEvent` 在 stream 结束、取消或 runtime 销毁时释放；不是全局永久订阅。
- 回调引用必须被 QuickJS GC mark/collect 机制覆盖；投递中的任务持有必要的 context/对象引用，context 失效后安全丢弃。
- 回调投递失败或 context 已销毁不得再次尝试调用失效 JS 值。
- 回调异常只记录，不改变 Transport 已提交的终止状态。

### 7.4 与参考实现的对应关系

- `JSCModuleExtension.h` 提供 `registerCModuleLoader()` 和 `postJSMessage()`，说明模块加载与跨线程回投是宿主支持的桥接点。
- Pen-LVGL 的 `JQAsyncExecutor` 将异步结果通过 JS Handler 排队到 JS 线程，提供 `onCallback*Async()` / `onErrorAsync()`，并在 JS 线程调用用户函数。
- Pen-LVGL 的 `JQPublishObject` 对订阅回调执行 GC mark/collect；本契约选择“每个 stream 一个回调”而非全局 topic，避免多个请求的事件串线。
- 这些是参考实现证据，不等同于本机 Transport 已通过；本机仍需在阶段 1B 的 mock/真机路径复核。

---

## 8. Mock server 验收用例矩阵

### 8.1 执行约定

- Mock server 只提供通用 HTTP/HTTPS、Cookie、重定向、延迟、分片、代理记录和可控连接断开；不得包含 DeepSeek endpoint 或业务字段。
- 每条用例记录：请求上下文、requestId、代理路径、收到的 headers/body、事件序列、终止原因、队列峰值、是否发生晚到回调。
- 下面的“阶段 1A 状态”均为**契约已定义，尚未在本阶段运行**；不能把矩阵存在当作 G1 通过证据。

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
| M12 | `/stream/long` 持续输出，调用 `cancel()` | 取消后停止读取；只产生一次 `cancelled`；不再有 chunk/end/error | 取消长流 | 待 1B |
| M13 | M12 中连续调用两次 `cancel()`，并覆盖 end/cancel 竞态 | 第一次 `cancel-requested`；第二次 `already-cancelled` 或 `already-terminal`；终止事件最多一条 | 取消幂等/竞态 | 待 1B |
| M14 | `/delay/headers` 或 `/delay/body` 超过 timeout | 只产生/返回 `ERR_TIMEOUT`；不会既 timeout 又 cancelled/end；socket/队列释放 | 连接/整体超时 | 待 1B |
| M15 | 同一 context 重复请求 + 不同 context 并发请求 | requestId 不重复；无 Cookie/代理串用；每个 Promise/stream 各自 settle/terminal 一次 | 重复请求 | 待 1B |
| M16 | 32+ 活跃、64+ 排队和单 context 超限 | 超过固定上限立即 `ERR_QUEUE_FULL`；队列不无界；已接受请求顺序可追踪 | 队列上限 | 待 1B |
| M17 | 慢 `onEvent`，server 发送超过 1 MiB/128 events | 先暂停读取并在低水位恢复；无法暂停时只报一次 `ERR_BACKPRESSURE`，不突破 hard limit | 背压/缓存上限 | 待 1B |
| M18 | `request()` body/response/header 超限 fixture | 分别触发 `ERR_INVALID_ARGUMENT`、`ERR_RESPONSE_TOO_LARGE`；无泄漏、无二次 settle | 缓存上限 | 待 1B |
| M19 | runtime/context 销毁时存在 pending request/stream | context 可调用时各 stream 一次 `cancelled(runtime-destroyed)`；context 已失效时无回调、无 crash、无失效 JS 访问 | 销毁场景 | 待 1B |
| M20 | 本地 TLS fixture + ALPN h2/h1 记录器 | 记录 TLS 握手、ALPN、协议版本；请求结果与 h2/h1 期望一致；失败分类稳定 | TLS/HTTP2 | 待 1B |
| M21 | 代理 fixture 下的 TLS/HTTP2 请求 | 只通过指定 context 代理；代理错误为 `ERR_PROXY`/`ERR_NETWORK`；不影响其他 context | 代理行为证据 | 待 1B |
| M22 | headers 前断连、headers 后断连、空 body | 前者仅 `error`；后者 `headers→error`；空 body 为 `headers→end` | 错误/空流 | 待 1B |
| M23 | `Set-Cookie` 与 `clearCookies()` 并发 | clear epoch 后的旧响应不得写回；新 admission 使用清理后的快照 | Cookie race | 待 1B |
| M24 | 回调主动抛 JS exception | 记录 callback exception；Transport 不重复 terminal，不把用户异常伪装成网络 error | 回调隔离 | 待 1B |

### 8.3 G1 门槛映射

| G1 门槛项 | 矩阵用例 |
|---|---|
| GET | M01 |
| POST JSON | M02 |
| Set-Cookie/回传 | M03、M04、M23 |
| HTTP 302 | M06、M07 |
| HTTP 401/429 | M08、M09 |
| SSE/原始分片流 | M10、M11、M22 |
| 跨 chunk UTF-8 | M11 |
| 取消长流 | M12、M13 |
| 连接/整体超时 | M14 |
| 重复请求 | M15 |
| 销毁场景 | M19 |
| 队列/缓存上限 | M16、M17、M18 |
| 代理隔离 | M05、M21 |
| TLS/HTTP2 证据 | M20、M21 |

G1 放行要求：M01–M24 均有可重放的请求日志、事件序列和资源峰值记录；mock 结果与真机结果分栏记录。单纯 `request()` 返回 200 不得替代 M20/M21 的 TLS、HTTP2 和代理证据。

---

## 9. 证据与来源

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
| `G:\youdao\Deepseek\.probe\probe\VERIFY.md:41-54` | P1–P3 通过，P4c 设备重启仍未测；因此本文将 runtime 销毁/设备生命周期列为 1B/真机验证项。 |
| `G:\youdao\Deepseek\.probe\probe\VERIFY.md:70-82` | 安装后 `.so` 会被 PMS 注入 SONAME/RUNPATH 并改名；Transport 阶段仍需按真实安装形态复核模块加载。 |

### 9.3 Pen-LVGL 参考实现

| 参考路径 | 观察到的模式 |
|---|---|
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\jsmodules\JSCModuleExtension.h:14-35` | `registerCModuleLoader()` 注册 C 模块；`postJSMessage()` 专门把后台消息投回 JS loop，禁止跨线程直接调用 JS。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\jqutil_v2\JQAsyncExecutor.h:39-87` | 异步 Promise/回调 ID、JS Handler、异步 callback/error API 和 context holder 的接口形态。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\src\jqutil_v2\JQAsyncExecutor.cpp:384-425` | `removeCallbackAsync()`、`onCallback*Async()` 通过 JS Handler 排队，真正调用在 JS 线程完成。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\src\jqutil_v2\JQPublishObject.cpp:14-31,47-65` | 发布订阅回调有 GC mark/collect、token 和取消机制；本文采用每 stream 私有 callback，避免全局 topic 串流。 |
| `G:\youdao\Deepseek\.probe\refs\Pen-LVGL\launcher\native\iot-miniapp-sdk\include\JQuickContext.h:108-121` | 宿主提供应用 lifecycle callback；本文据此定义 runtime destroy 的停止接纳、取消、回调抑制顺序。 |

---

## 10. 未决问题与验证边界

以下项目不是接口命名分叉，本文已给出阶段 1B 应采用的外部语义；它们仍需用实现和证据确认，未确认前不得宣称 G1 通过：

1. X7 Pro 上真实 Transport 依赖的 HTTP/2、TLS profile、ALPN 和代理库能否在现有 JSAPI 进程中稳定运行。
2. 参考 SDK 的具体版本/许可与本机固件 ABI 的完整匹配；阶段 0 已验证探针链路，但未验证真实 Transport 依赖闭包。
3. 设备 runtime 销毁时宿主允许的最后一个安全 JS loop 时刻，以及 P4c 设备重启后的自动加载行为。
4. 实现所选网络栈能否在无法暂停读取时精确执行 `ERR_BACKPRESSURE` 的 hard-limit 行为；必须通过 M17 实测峰值确认。
5. 真实代理错误、TLS 失败和 HTTP/2 fallback 的错误 code 映射；必须在 M20/M21 中固定日志和 code。
6. 16 MiB 请求 body 与 8 MiB 聚合响应上限是否覆盖未来阶段 3 的所有业务输入；阶段 3 若需要上传流式 body，必须另立接口/契约版本，不得偷偷放宽当前上限。

这些问题不会恢复旧命名，也不允许通过增加别名规避契约；它们是阶段 1B 的实现/验证清单。

---

## 11. 阶段 1B 进入条件

阶段 1B 只能在以下条件全部满足后开始：

1. 本文件 `T1A.1` 被作为唯一 Transport 契约保存；实现任务引用本文件，不再引用 `requestStream`、`data` 事件或第二套 terminal 语义。
2. 阶段 0 的 G0 证据边界被明确记录：探针 P1–P3 已有 `VERIFY.md` 证据；P4c 设备重启和宿主销毁行为要么补齐证据，要么由阶段负责人明确记录为 1B 的首个阻塞项。
3. 按 M01–M24 建立可重放 mock server/fixture；至少先完成静态契约检查、事件序列断言、Cookie/代理隔离断言、队列/背压峰值断言和销毁无晚到回调断言。
4. 实现计划承诺：普通请求只走 `request()`，流式请求只走 `openStream()`；不实现 `stream:true` 兼容分支，不暴露 `requestStream()` 或 `data`。
5. 实现计划承诺：所有 HTTP 401/429 作为可观察响应交给 JS；Native 不加入业务重试、账号切换、PoW、session 或 DeepSeek 逻辑。
6. 明确 mock 与真机两套结果表：M20/M21 的 TLS、HTTP2、代理行为必须有独立证据，不能以普通 200 响应替代。
7. 保护文件 `ds.js`、`native.js`、`backend-blob.js` 以及现有默认入口保持不变；阶段 1B 的代码应有独立回滚边界。

**停止条件**：任一接口语义、终止唯一性、取消幂等、上下文隔离、上限/背压或 G1 矩阵覆盖项仍未冻结/可判定时，停留在阶段 1A，不进入阶段 1B。

---

## 12. 阶段 1A 结论

- `request` 是唯一普通请求入口。
- `openStream` 是唯一流请求入口；不再存在 `requestStream`。
- `chunk` 是唯一流数据事件；不再存在 `data`。
- `headers` 只表示响应元数据，`end`/`error`/`cancelled` 是互斥且唯一的 terminal 事件。
- `cancel` 是统一、可重复调用且不产生额外终止事件的取消入口。
- Cookie Jar 与代理均按 `contextId` 隔离；Native 不识别账号，不持有业务状态。
- 流事件有确定顺序、有限缓存和背压错误；QuickJS 回调只能经 JS loop 投递。
- G1 的 mock 验收矩阵已成套列出，但本文件不伪造实现或运行证据；阶段 1B 必须逐项执行并记录结果。

