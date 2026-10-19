# 路线 C 分层预算：目标 wreq 能力调查

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师审批。B 设计方向已由用户转交确认；本轮仅调查与草案，不授权实现，不发布 r3，不解封 1C，不宣布 G1 通过。** 现行规范仍是 02d T1A.3-r2 及其继承的 02b。02f 是 DRAFT / NOT APPROVED。

## 1. 推荐与最小阻塞

**不能以“现成 wreq + 停止 poll + 64 KiB 切片”进入分层预算正式实现。** 可以申请一个有停止条件的同栈能力补齐阶段；必须先批准 02f 的独立变更项，而非笼统批准 r3。

本轮取得的关键事实：

1. 精确锁定栈为 wreq 5.3.0 / wreq-util 2.2.6 / hyper2 1.5.5 / http2 0.4.21 / boring2、boring-sys2、tokio-boring2 4.15.15。25 个相关包全部来自本机 WSL `.crate` 缓存，逐包 SHA-256 与当前项目 lock checksum 相同；没有下载、安装或运行 Cargo。
2. `bytes_stream()` 是 pull 消费接口，**不是带长度参数的网络读取接口**。wreq 单独调度 H1/H2 connection driver；停止消费只停止本消费者继续 poll，已经授权的 H2 DATA、headers/control 和共享连接仍可被取得。
3. Chrome136 真实配置为 stream window **6,291,456 B = 6 MiB**、connection window **15,728,640 B = 15 MiB**，不是 65,535 B。可证明的是 H2 接收队列中尚未释放 flow-control credit 的 **DATA payload 逻辑长度**；不是完整库内存，也不是解压后的 body。
4. 更小的硬阻塞：`http2` 对长度为零、非 END_STREAM 的 DATA 也 `push_back(Event::Data(...))`，其窗口扣减为零，队列底层 Slab 自动增长。停止 body 消费时，**不存在由 DATA 窗口推出的事件数上界**。这是静态源码路径反例，不是已运行攻击/测试；单流即足够，不依赖 32 并发。
5. wreq-util 默认 features 重新启用了 wreq 的 gzip/brotli/deflate/zstd。默认 zstd 允许约 **128 MiB window**，还有输入/输出工作区和对象开销。不能承诺“只读 64 KiB，所以解压工作区也只有 64 KiB”。
6. 局部有限项可利用：H1 有按 body channel readiness 停读机制；CONNECT 响应头数组固定 8 KiB；BoringSSL record 读取、H2 frame/CONTINUATION、接收 HPACK table 各有版本特定约束。但 backing allocation、解压工作区、连接/客户端总数和终态积压尚未形成一个获批的有限总预算。

**最小缺失能力/证据**：H2 空 DATA 不积压及小帧对象有界机制；H1/H2/解压返回块的 backing 上界或受限目的缓冲接口；解压/TLS 握手暂存预算；连接、共享缓存与终态/control 的有效存活数量策略。详见 §7，未决不得填零，不用采样最大值补空。

## 2. 来源、版本与实际配置

### 2.1 可复核来源

本轮独立目录 `E = docs/astra/evidence/wreq-budget-20261003-7b19c2/`；源码根 `S = E/sources/`。下文 `包版本/路径:行号` 均相对 S，行号来自原始解包源码，不是最新版文档。项目路径另写完整仓库相对路径。

- `E/sources.json`、`E/sources-extra.json`：25 包的 lock 元数据、实际缓存路径、canonical URL、完整 archive checksum、逐文件 SHA-256。
- `E/archives/`：精确版本原始 `.crate`；`E/sources/`：安全解包的只读调查副本，未应用 patch、未构建。
- 本机来源为 `\\wsl.localhost\Ubuntu\home\aquavie\.cargo\registry\cache\rsproxy.cn-e3de039b2554c837\` 等，具体每包以 manifest 为准。逻辑 source 仍为 `registry+https://github.com/rust-lang/crates.io-index`；镜像不是版本替代证据。
- Windows `C:\Users\Aquavie\.cargo\registry` 只有 index，无源码/cache；WSL 找到匹配缓存。WSL 启动有 PATH/systemd 警告，但缓存读取及 checksum 核对成功；没有将警告当成项目测试。
- `E/audit.py` 仅保护、复制、校验材料；没有执行项目脚本。`E/source-excerpts.json` 保存关键源码逐行片段，`E/input-facts.json` 保存配置/旧失败摘要，便于手动转交。

### 2.2 当前 lock，而非报告版本

| 包 | 当前锁定 | lock 起始行 | 用途 |
|---|---|---:|---|
| wreq / wreq-util | 5.3.0 / 2.2.6 | 4067 / 4111 | 客户端 / Chrome136 仿真 |
| hyper2 / http2 | 1.5.5 / 0.4.21 | 1498 / 1424 | H1/H2 driver / H2 协议；hyper2 中依赖别名 `h2` 实指 `http2` |
| boring-sys2 / boring2 / tokio-boring2 | 均 4.15.15 | 333 / 346 / 2946 | 打包 BoringSSL / Rust TLS / Tokio 包装 |
| bytes / http / http-body / http-body-util | 1.11.1 / 1.4.1 / 1.0.1 / 0.1.3 | 421 / 1385 / 1395 / 1405 | backing、headers、body frame/collect |
| tokio / tokio-util / futures-channel | 1.52.3 / 0.7.18 / 0.3.32 | 2930 / 2980 / 1186 | 调度、codec、H1 body channel |
| httparse / tokio-socks | 1.10.1 / 0.5.2 | 1442 / 见 manifest | H1 解析 / SOCKS |
| async-compression / compression-codecs / compression-core | 0.4.42 / 0.4.38 / 0.4.32 | 148 / 539 / 见 manifest | HTTP content 解码 |
| zstd / zstd-safe / zstd-sys | 0.13.3 / 7.2.4 / 2.0.16+zstd.1.5.7 | 见 manifest / 4254 | 实际 zstd 原生解码器 |
| cookie / cookie_store / slab | 0.18.2 / 0.21.1 / 0.4.12 | 见 manifest | response Cookie 存储 / H2 接收事件槽 |

以上所有调查包均 registry source，没有用 Git HEAD 或不匹配版本源码证明当前栈。项目 `Cargo.toml`、本地 path 依赖 `CAPTCHA/Cargo.toml`、已发现的 Cargo 配置中没有 `[patch]`/`[replace]`；未发现上层 workspace manifest。用户级 Cargo config 使用 rsproxy source replacement，项目 `.cargo/config.toml` 默认 target 是 aarch64-unknown-linux-gnu。

**TLS 特别限制**：`boring-sys2-4.15.15/build/main.rs:109–145,473–498,550–576` 会复制打包的 `deps/boringssl` 并应用 `boringssl-44b3df6f03d85c901767250329c571db405122d5.patch`、loongarch patch；还支持外部 `BORING_BSSL_*` 输入（`build/config.rs:132–173`）。本轮保留打包源码与 patch 原件，确认下面引用的 `ssl_buffer.cc`、`tls_record.cc` 未被这两份 patch 改写；`ssl_lib.cc` patch 涉及配置，不涉及所引用的读函数。不是“无任何 patch”。没有构建，不能确认未来编译环境、已装二进制或设备实际链接物；外部 TLS source/precompiled override 必须在实施证据中重新封存。

### 2.3 Features 合并与 Chrome136 调用

| 层 | 当前可从 manifest/调用点证明的有效路径 |
|---|---|
| 项目直接 wreq | `ds-free-api/Cargo.toml:31`：default-features=false；json、stream、multipart、socks、cookies、webpki-roots |
| wreq-util 默认 | `wreq-util-2.2.6/Cargo.toml:44–70,156–158`：default 包含 emulation/gzip/brotli/deflate/zstd；自身 wreq default=false，但四种压缩 feature 向 wreq 合并 |
| wreq 合并 | 上述直接集合 + cookies-abstract + gzip/brotli/deflate/zstd 及对应 optional deps；不是“关闭自动解压”。charset/native-roots/websocket/hickory 等没有在这条依赖路径启用，不把 lock 出现某包当 feature 证据 |
| HTTP/TLS | `wreq-5.3.0/Cargo.toml:335–349,384–390,442–472`：hyper2 client/http1/http2；boring2 pq-experimental/cert-compression；tokio-boring2 pq-experimental；tokio net/time/rt + stream 的 fs；tokio-util codec/io |
| H2 别名 | `hyper2-1.5.5/Cargo.toml:99–102`：`h2` package=http2，非另外锁定的原版 h2；Tokio sync 另由 hyper2 启用 |
| TLS feature 传播 | `tokio-boring2-4.15.15/Cargo.toml:41–51,80–86`；`boring2-4.15.15/Cargo.toml:52–79`：pq 到 boring-sys2，cert-compression 引入 brotli/flate2/zstd；与 HTTP body 压缩是两个不同持有路径 |
| 项目 Tokio | Cargo.toml:40 附近 macros/rt-multi-thread/signal；其他业务库可合并额外 Tokio features，本文不声称这是整个业务二进制完整 feature 闭包 |

这是对目标网络路径 manifest 的静态闭包核对，不是 `cargo tree`/构建输出，未运行 Cargo、未写 lock。完整二进制 feature/target/环境指纹仍属于未来宿主与设备证据。

`ds-free-api/src/ds_core/client.rs:673–684`：`.emulation(Emulation::Chrome136)`，随后覆盖业务 UA、connect timeout=15s、redirect limited(10)、可选 Proxy::all；`:1323,1369` 消费 `resp.bytes_stream()`。调用点证明目标库使用方式，不等于未来 Transport 已实现；业务的 10 跳**不替代** Transport 02b 的至多 5 跳。

Chrome136 路径：`wreq-util-2.2.6/src/emulation/mod.rs:303` -> `device/chrome.rs:1425–1428` 的 v136 -> `:1259–1264` v132 -> `http2_config!(3)`（`:74–86`）与 `tls_config!(7,CURVES_3)`（`:36–44`）。后者保留 permute/ECH grease/PSK/new ALPS；不是仅设置 UA。H2 参数：6 MiB/15 MiB、MAX_HEADER_LIST_SIZE=262144、HEADER_TABLE_SIZE=65536、push=false；config 3 **没有** config 1/2 的 max_concurrent_streams(1000)。`wreq/src/client/http.rs:1047–1078,2539–2556` 应用配置；`hyper2/src/client/conn/http2.rs:288–305` 显式窗口关闭 adaptive window。

## 3. 停止消费以后谁还持有/取得数据

| 持有者及版本定位 | 不再 poll body 的效果 | 仍存在的责任/背压边界 |
|---|---|---|
| wreq Response/Decoder：`wreq-5.3.0/src/client/response.rs:24–49,367–369`；`client/body.rs:434–455` | DataStream 不自行 spawn；停止 poll 停止这条消费者推进；non-data frame 被跳过 | 既有 Decoder、StreamReader 编码余块、调用者返回 Bytes 仍活着；`next()` 没有 byteMax 参数，不能先取得任意块再用短 view 冒充受限取得 |
| 连接任务：`wreq-5.3.0/src/util/client/mod.rs:430–462,550–598` | H1/H2 dispatcher 已交 executor 独立运行，建连竞争也可留下后台建连 future | response 消费暂停并不取消这些 task；连接池、其他流仍能驱动 socket/TLS |
| H1 dispatcher：`hyper2-1.5.5/src/proto/h1/dispatch.rs:195–267`；`body/incoming.rs:113–128,210–232,352–365` | 读取 body 前等待 Sender readiness，channel 满时停止继续 `poll_read_body` | channel(0) 并非零数据槽：futures-channel 0.3.32 `src/mpsc/mod.rs:379–395` 为 buffer+sender，单 sender 正常路径有一槽；已解析/预读 BytesMut 与当前调用输入仍可留存。错误 send、trailers 和外部已取出块另记 |
| H1 IO：`hyper2-1.5.5/src/proto/h1/io.rs:15–23,176–244,345–351,368–422` | 自适应 next/readiness 提供背压机制 | `reserve(next)` 后向 IO 暴露 spare capacity，并非 `min(spare,next)`；max 是读策略/解析阈值，不能直接当全部分配硬限；`split_to().freeze()` 可共享 backing |
| H2 driver/recv：`http2-0.4.21/src/proto/connection.rs:503–525`；`proto/streams/recv.rs:581–718` | 某流不 poll 不阻止 session 读其他帧 | 先 connection/stream flow 检查，随后 Event::Data 入共享 Slab；DATA 消耗窗口，headers/CONTINUATION/control 不受 DATA 窗口限制 |
| H2 credit 返回：`hyper2-1.5.5/src/body/incoming.rs:238–247`；`http2-0.4.21/src/proto/streams/recv.rs:375–430` | 无新 poll 则无这条消费释放 | **poll 成功就 release_capacity，不等 Bytes drop，更不等 JS D**。Decoder 已取的编码块、adapter staging、投递队列不能还用该窗口担保 |
| TLS 包装：`tokio-boring2-4.15.15/src/lib.rs:198–212`；`boring2-4.15.15/src/ssl/mod.rs:3843–3895` | 无独立 TLS 读任务；由 poll_read/SSL_read 驱动 | H2 driver 继续 poll IO 就能继续解 TLS；TLS 内部剩余 record、握手、证书、session cache 不因 body pause 消失 |
| 自动解压：`wreq-5.3.0/src/client/decoder.rs:92–110,314–400,475–515` | Decoder 在本消费者 poll 中推进，不后台无限生产解压输出 | StreamReader/Peekable 编码残块、FramedRead 输出 backing、解码工作区继续保留；暂停不是释放 |
| 代理：`wreq-5.3.0/src/connect.rs:339–355,666–755` | CONNECT future 可在最终 response 之前取得数据；成功后包装目标 TLS | HTTPS proxy 与目标 HTTPS 可为两层 TLS；固定 CONNECT 头数组不含请求 Vec、代理 TLS、SOCKS 协商或整个 socket |
| headers：`http2-0.4.21/src/codec/framed_read.rs:146–199,283–360`；`frame/headers.rs:934–1030` | final response 尚未返回或某流暂停时，driver 仍可 HPACK 解码 | 未完成 header block 为 session 级 Partial；解析后 HeaderMap/动态表/临时字符串及克隆可共同存在；informational headers 在 recv.rs:251 被排除入流队列，但仍经过解码 |

取消不等于暂停：`http2-0.4.21/src/share.rs:480–488` drop RecvStream 清接收 buffer；`proto/streams/streams.rs:1461–1524` 最后引用释放才触发其余取消/归还逻辑。H1 body drop 则可能 drain-or-close（dispatch.rs:209–215）。这些都不是 Transport 的 C；必须先按 r2 C 关闸，后观察 task/引用/连接收尾。禁止为单流取消直接摧毁共享 H2 session 影响兄弟流。

## 4. 可证明子界与不可替代的数值

分类固定为：**源码可证明**（仅该列出的量）；**可配置但待验证**（公开配置存在，非已采纳）；**需同栈适配**（保持目标库体系的内部能力改造）；**无法证明**（本轮不足，绝不默认合规）。B 表的空缺不是数学上的“任何有限界都不存在”；空 DATA 队列则有具体静态无限增长路径。

### 4.1 H2 payload 与对象数

令 q_i 为仍在 http2 接收队列、未由 hyper2 释放 capacity 的 DATA payload 字节，s 为一个实际 session，I_s 为其尚有接收持有物的流，不只是 Transport active 计数。

```text
q_i <= W_s = 6,291,456
sum(i in I_s) q_i <= W_c = 15,728,640
U_DATA_unique <= sum(actual sessions s) min(W_c, |I_s| * W_s)
```

推导：recv_data 按 payload.len 检查两级窗口再扣减入队；release_capacity 与 in_flight 严格对应；固定接收窗口、无 adaptive/custom window 更新、非重复计量。oversize/协议错误帧在 codec 中的瞬时 backing **不在 q 中**，另由 U_codec 负责。padding 在 `frame/data.rs:120–138` 被剥离；这是源码 payload 账，不把它冒称含全部 wire octets。

- **源码可证明，条件成立时**：1 流独占 session 的 q≤6 MiB；同一 session 多流合计≤15 MiB。一个 H2 DATA frame payload 默认≤16,384 B（`frame/settings.rs:103–104`；`codec/mod.rs:35–54`）。这不是一次 wreq 解压输出必≤16 KiB。
- **条件化算例，不是批准总额**：若所有 recv 持有物确实只有 32 个流、最多32个 session，则 q 总量≤32×6 MiB=192 MiB；32流全在一个 session 则≤15 MiB。不能同时再加32×6和每连接15，属于重复计量。8/context 同理≤48 MiB，但 context 是否共享/独立 client 必须在实施中证明。
- **无法据现有 admission 证明条件**：32 active 不限制已经 terminal 但仍持有的旧流、退休连接、后台建连及 idle session 数；这些必须纳入 N_live，不得直接假定≤32。内核/TLS 未分流输入也不在公式内。
- **需同栈适配**：空 DATA 路径 `recv.rs:582,675–680` + `flow_control.rs:171–186` + `buffer.rs:46–60` + `slab-0.4.12/src/lib.rs:75–116,1029`。合法 open stream 上重复零 payload/non-END DATA，窗口不变而事件数增长；无消费者就无 pop。有限 deadline/链路速率未给可证明输入速率，不构成固定对象预算。
- 即便排除空帧，1 B/frame 时可达每流 6,291,456 个事件的数量级；不能按“窗口/16 KiB=384 帧”算上界，那只是假定**每帧填满**。可批准的最小内部方案是丢弃无语义空 DATA、保留 END_STREAM 状态，并对非空小帧作有界聚合或设置经过批准的对象上限。聚合必须先有库内 allocation credit；不能机械降窗口改变 Chrome136。

### 4.2 Headers、HPACK 与 H1

| 量/分类 | 数值与推导 | 条件及不能推出的结论 |
|---|---|---|
| H2 接收动态表，源码可证明 | ≤65,536 的 HPACK `name.len+value.len+32` 账；`proto/settings.rs:67–68`、`hpack/decoder.rs:525–568`、`hpack/header.rs:38–40` | 每 session 一份，不按流重复计；不是 allocator capacity。发送 HPACK 表受 peer SETTINGS 控制（settings.rs:140–141），不能也填65,536 |
| H2 已接纳 header list，源码可证明 | 262,144 为 profile 阈值；`frame/headers.rs:956–1008,1078` 用 n+v+32 且严格 `<` 才保留条目 | 含 pseudo header 的库度量，与契约64KiB不同；先解码再判断，临时字符串、HeaderMap backing、capacity另记 |
| H2 未完成编码块，源码可证明的保守内容界 | `floor(262144/16384)=16`，25% padding=4，最多20个 non-final CONTINUATION；另有首 HEADERS和最终 END_HEADERS，内容≤22×16384=360448 B | `framed_read.rs:111–117,298–310`，单 session 同时一个 Partial；不含 framed read-ahead/backing/HPACK Huffman输出；第21个 non-final 在append前拒绝，但其单帧已由codec取得，仍需codec预算。不能说headers全部只占256KiB |
| H1 普通路径，源码可证明机制/总分配无法证明 | 当前 Chrome profile没有 Http1Config，故默认 `INIT=8192, MAX=8192+4096*100=417792 B`，不是Http1Config builder的409600 | hyper2 io.rs:15–23；wreq emulation只在Some时应用H1。MAX限制策略/解析检查，不等于返回Bytes backing硬界；输入spare、预读和header共享需补证明 |
| H1 调整，可配置但待验证 | Http1Config 的 read_buf_exact_size/max_buf_size/max_headers，wreq `client/config/http1.rs:52–87` | “exact”仍走spare读；不能只凭名字宣称硬界。调低header限制会缩小可接收响应范围，须审批；不能用它替代全栈预算 |
| H1 trailers/扩展，源码可证明逻辑子项 | `hyper2/.../h1/decode.rs:17–25,180–194,282–290`：默认 trailer 16KiB逻辑限制，扩展累计16KiB | append后比较与Vec容量不等同allocator上界；trailers并不因bytes_stream跳过而不存在 |

64 KiB 契约 headers 还需独立批准表示。wreq `Response::new` 先 Decoder::detect；`decoder.rs:239–262` 自动解压时删 Content-Encoding/Content-Length。因此普通 `Response::headers()` **不是严格的解码前线端头部原件**。H1 原始大小写/折叠、H2 pseudo、重复值与JS UTF-16均需区分。02f建议在库规范化完成但content-decoder删头之前按原始octets计量；保留重复值，名称小写字节+值字节+每对4 B；不以JS string.length或HPACK的+32替代。这个拦截点需要同栈适配，不假装当前公共API已经提供。

### 4.3 TLS、代理与解压

| 项/分类 | 已有精确证据与局部上界 | 未决/适用条件 |
|---|---|---|
| TLS record 接收，源码可证明 | `boring-sys2-4.15.15/deps/boringssl/src/include/openssl/ssl3.h:204,214,226,233–260`：5 B header +16384明文上限+256+64密文overhead=16709 B；`ssl/ssl_buffer.cc:50–96` alignment最多7B，单heap backing请求≤16716 B；扩容时旧新并存保守≤33432 B | 仅此TLS record读取buffer及默认alignment，非malloc实际size/RSS。`tls_record.cc:237–250,285–312` 先验长度/原地解密；明密文同backing不重复加两份。外部caller接收副本另算；握手/证书/会话缓存不在此界 |
| TLS运行机制，源码可证明 | `ssl_buffer.cc:145–165` BIO只读目标缺量；`ssl_lib.cc:1031–1045,1718–1724` 读余量与read_ahead兼容空操作 | 16KiB不是整个TLS连接预算；HTTPS代理可能两层SslStream，应按每层唯一对象计 |
| TLS握手/证书，无法证明总额 | cert-compression开启；`boring2/.../ssl/cert_compression.rs:91–119` Brotli路径为uncompressed_len建Vec；profile宣告证书压缩 | 最小补证是握手最大消息/证书解压/临时工作区及patch/环境闭包，不要求审计BoringSSL所有算法和allocator |
| CONNECT response scratch，源码可证明 | `wreq/src/connect.rs:730–748` `[0;8192]`，pos满则错误；每正在CONNECT的future 8192 B | 不含CONNECT请求Vec、auth/header字符串、底层代理TLS/目标TLS；若实证N_connect≤32才有256KiB scratch算例，目前N_connect未闭合 |
| SOCKS，无法证明统一代理预算 | 实际启用tokio-socks 0.5.2，调用链在wreq connect.rs；其不同版本/认证/地址路径非CONNECT的8KiB数组 | 本轮不把HTTP CONNECT证据覆盖SOCKS；补证只需被支持协议的握手buffer/并发/取消生命周期 |
| HTTP解压，源码可证明持有结构/总额无法证明 | wreq Decoder -> StreamReader -> async-compression -> FramedRead/BytesCodec；`tokio-util-0.7.18/src/codec/framed_impl.rs:25,46–53,208–226` 初始8KiB；`bytes_codec.rs:59–66` split所有已有输出 | 8KiB是初始capacity而非所有解码器/返回块/内部backing预算；不再poll不继续此decoder，但已建工作区仍在 |
| zstd窗口，源码可证明配置，不是完整预算 | `compression-codecs-0.4.38/src/zstd/decoder.rs:21–40`默认Decoder::new；`zstd-0.13.3/src/stream/raw.rs:139–152`初始化；zstd-sys `zstd/lib/zstd.h:1287–1290`默认log=27，C `decompress/zstd_decompress.c:40,244,2231–2265`实际maxWindow=(1<<27)+1=134217729 B，并据frame申请工作buffer | 约128MiB是允许window，不是每流必分配，也不是总memory硬界；32个活解码器仅window规模即约4GiB，不能称测得峰值。输入/输出/DCtx另算；wreq只调用new/multiple_members，未暴露该DParameter |
| 解压约束，需同栈适配 | lower codec有new_with_params/WindowLogMax路线，但wreq没有转发此预算；可改为bounded decoder sink/显式workspace policy | 调低可接受window、拒绝编码或关闭Accept-Encoding/自动解压会改变行为，须精确审批；不私改Chrome136行为 |

### 4.4 Shared cache 与控制数量

`wreq/src/client/http.rs:204–208` 默认 idle timeout=90s、max_idle_per_host=usize::MAX、pool_max_size=None；`util/client/pool.rs:79–93,124–139,345–367` 的 max_size 是 **idle key 的 LRU 容量**，每key又有Vec，不是所有活连接总数。timeout不是在无输入速率上界时的数量硬限。公开pool配置属于“可配置但待验证”，改池/复用将影响握手频率、PSK与可见连接行为，不能宣称绝不改变Chrome136整体行为。

PSK开启时，`tls/conn/mod.rs:37–44` 默认每authority 8 sessions；`tls/conn/cache.rs:42–71` 两个HashMap共用SslSession引用，每key驱逐但没有全key数量限。**8/authority不是8/client**。Http2 session与TLS resumption session也不是同一对象。须按client/authority唯一计，不能每流重复，也不能排除长期积累。Cookie Jar 在`wreq/src/cookie.rs:50,308,361`及`cookie_store-0.21.1/src/cookie_store.rs:43,260`持久保存响应Set-Cookie；不是本轮body硬预算，但不得用本报告宣称整个context内存有限。连接数、client数、authority数、Cookie数量归为一个集中持久资源政策问题，不扩展成任意运行库审计。

terminal/control：每操作一terminal slot不推出全局32槽。C之后active可能释放，但通知、request结果、旧generation token、正在收尾driver仍持有。用户能继续发控制API，其确认Promise也不受数据128/512约束。r2未给未settle控制调用、所有存活context、已终止未释放operation的数量上界；**无法证明**。需要批准admission占位退休规则与固定控制池/满池行为，且满池不得妨碍既有操作提交C或唯一终态机会。

## 5. 分账：逻辑与物理不重复也不遗漏

| 账本 | 建议归属与范围 | 数值地位 |
|---|---|---|
| P_transfer / E_transfer | 新A点之后至D/完成安全丢弃；按op,generation,解码后offset唯一逻辑区间；queue/bridge/inflight/reservation均算 | 1/4MiB、128/512数值继承；改变取得起点须审批，现行r2仍不变 |
| U_body | A前编码DATA、H1预读、解码器余块、adapter等待转移的完整源Bytes；返回到适配器不等于自动转成P | H2 q局部已证；其他未决。staging虽然在适配器模块，仍必须计入U，不能改名offered豁免 |
| U_protocol | frame/Partial/HPACK/HeaderMap/TLS/代理握手/control；未知归属输入在connection escrow | 按真实session/连接/握手层唯一持有者；§4局部量不能直接相加充总allocation |
| A_backing / A_copy | 全部这些账中的唯一allocation id、申请capacity及多方引用；短Bytes slice仍追全backing；源+目的复制重叠另记 | `bytes-1.11.1/src/bytes.rs:58–78,544–564`及hyper2 split路径支持共享事实；不能把len当allocation。库级capacity与桥副本总额未决 |
| B_request | request聚合解码后body≤8MiB，不占stream P；聚合前reserve，禁止无限collect后检查 | wreq `response.rs:302–307` bytes()调用BodyExt::collect，无8MiB业务限；最多32个**仅在全部保留结果也≤32时**为256MiB逻辑体；复制/待settle另计 |
| C_terminal/control | terminal通知、control确认、任务/操作/定时器、退役generation；request结果与网络清理有自己的退休判据 | 数量、固定对象大小、满池语义待批准；不写“最多32个terminal” |
| J / K / M | J为D后用户持有；K为内核socket；M为RSS/allocator/线程/代码等整体统计 | 不等于P的1/4MiB；独立报告。J不得取消后失效，K不伪装成用户态零缓存，M采样不作硬预算 |

U与P是内容所有权分类；A是物理视角，**不是再与U/P机械求和的第三份同一数据**。复制时可以同一逻辑区间对应两个allocation；共享TLS/HPACK/Bytes按唯一allocation建归属边，引用消失不保证allocator归还OS，capacity退役与RSS下降分开。

## 6. 最小可实施候选（待批准，未实现）

1. 冻结02f的A/H/Q/C四个审批项和编码语义。保持wreq/Chrome136设置、公共API、32/64与8/16、r2 C/D/R与deadline规则；所有需改变这些的方案单列审批，不用本轮推导作授权。
2. **先补目标库能力，不先把core做成“通过”**：H2接收空DATA无积压、非空小帧有界聚合/对象额度、frame/backing审计点；H1/解压受限sink或每次返回源块L_i上界及唯一backing额度；headers删头前度量。仅有公共bytes_stream不满足这些前提。
3. 后续适配器：每流一个outstanding消费/源余块；全局仲裁先原子取得byte+event+allocation token，再做最多64KiB的一次ownership transfer。源块留在U_staging直到所有引用释放；持有完整块时不继续poll下一个块。read返回不是A，复制提交才是A；若源返回超过已证明L_i，说明能力前提失效，停止，不以事后拒收证明硬限。
4. P公式为`P_i+R_i<=1MiB`、`sum(P)+R_global<=4MiB`；E同理128/512。每次非空transfer预留一个chunk槽；headers预留一槽但不占body payload。严格低水位仍为原值且需同时满足可预留额度。EOF/error/cancel须通过独立有界控制路径可达，不能为发现EOF在满P下盲poll并取得未知body。
5. 请求聚合增量受限至8MiB，复制前有独立allocation额度；不采用无界bytes().await再检查。取消先C，不等待release；已开始读/复制的token退休前仍占额，旧generation不能借C瞬间释放额度后迟到二次占用。
6. 证明N_live/N_conn/N_client/N_context/N_terminal/control的范围及退休条件；用最坏并发代入U公式。若必须降低并发、改变池/自动重试/公开拒绝行为，暂停申请审批。wreq默认H2重试次数2（client/http.rs:231,2163）及内部reused连接重试（util/client/mod.rs:986）须映射02b无自动重试义务；不直接继承业务builder当Transport合规实现。

可在不改已列Chrome136 TLS/H2设置的情况下利用：现有固定窗口、禁push、H1 readiness、停止poll、受限复制与内部token。不能因此保证网络时序完全相同。内部空帧丢弃/有界聚合有希望保持正常payload与profile字段，仍需同栈验证；调小H2 SETTINGS/window、禁H2、禁压缩、换TLS/HTTP库不是本方案的暗含许可。

## 7. 集中阻塞表与停止条件

| ID | 进入实现前的最小关闭条件 | 本轮分类/状态 | 停止点 |
|---|---|---|---|
| K1 | 同栈空DATA不积压；非空小帧/Slab/codec backing有限，保持END_STREAM与兄弟流推进 | 需同栈适配；有静态反例 | 不允许用6/15MiB窗口声称H2总预算已证 |
| K2 | H1、plain/H2、四种解压的单次源块/backing及decoder workspace界；决定是否保持全部当前可接收窗口 | 部分源码可证明，其余无法证明/需适配 | 找不到有限界或低内存只能靠改Accept-Encoding/拒绝合法window，停在变更审批 |
| K3 | headers表示及拦截点批准；TLS握手/证书压缩、HPACK临时/发送表、代理协商列有限预算 | 局部已证，总额未决 | 不把64KiB或256KiB header阈值冒充所有临时内存；不把record界充TLS总额 |
| K4 | 实际存活资源数与池/authority/context/terminal/control退休策略、满额行为批准 | 可配置但待验证 + 无法证明 | 32 active不能代替所有live；不得暗改admission/PSK/复用/错误码 |
| K5 | 真实wreq宿主确定性持有/释放、取消隔离、压缩与指纹证据；再按授权进入设备 | 本轮NOT_RUN | 源码推导不能冒充安装物/设备结论，Node不能替代此层 |

本轮不继续审计无关Tokio调度器、DNS全实现、进程所有allocator或业务缓存。K1–K4关闭后才有必要补充批准数值所需的精确局部证明；不能无限调查来推迟已明确的设计选择。若不批准同栈适配且坚持当前profile与公开API，当前结论就是**不可进入分层预算实现**，而非容量通过或理论上所有路线都不可行。

## 8. 旧失败与后续验收责任

| 原证据/义务 | 本轮核对与未来追踪 |
|---|---|
| 04b accounting-large | 原backlog漏计历史FAIL原件保留；04c部分修复不撤销当时失败 |
| 04c strict Windows/WSL | 两端仍status=FAIL，inputAtCoreEntry=1114112、previousPending=0、hardLimit=1048576；command code=2。此事实永久归属r2严格入口，不改断言、不改名PASS |
| 04c accepted 54/54 | 接纳后账本范围证据，不抵消strict，不证明wreq |
| 04d Node网络实验 | 继续作为Node/read/backing边界证据；不重复全套，不拿Node窗口/内存数据填wreq预算 |
| 新B验证 | 新目录/版本/test id，分别证明A前U和A后P；旧1114112源仍作不受限入口负对照，同时证明新合法受限转移无法超credit，不能只是把拒收改叫合法 |

三层最低验收：

- **Node模型**：只证明token守恒、公平竞争、短读/WAIT/EOF候选、取消迟到退休、精确副本及r2三闸门和M01–M34模型行为。不得强迫它证明BoringSSL/http2/zstd内部预算；注入库预算用受控模型并标明假设。
- **真实wreq宿主**：精确lock/features/patch/target封存；H1/TLS/H2/CONNECT/SOCKS、压缩四路径、空DATA/1B小帧、HPACK连续头、不同authority及retiring连接；停消费时driver持有与唯一backing台账；仍在途兄弟流的单流取消；外部输入/交付SHA；资源错误/EOF/取消全部竞争窗口；TLS/ALPN/SETTINGS/压缩行为差分。运行不能代替源码上界，但必须检验适配前提。
- **设备**：另行授权后才能构建/安装，重新验证真实JS线程C/D、内存容量和生命周期、M20/M21/M28；Node宿主kill不能替代设备硬终止。本轮全部NOT_RUN。

r2 02d §6 的两轮三路径/WQ-WX-WG、正常完整性、既有未决项仍是进入1C的必要条件，新预算证据不替代它们。

## 9. 范围保护与手动交付

唯一新增为本04e、02f和E目录。首次新增是证据工具；在任何现有输入写入之前记录`protection-before.json`，实际全程没有写现有输入。保护范围限于本轮依赖源码、契约/报告、指定历史关键证据及已有tracked改动；不扫node_modules、无关文件或外部永久归档。记录HEAD及Git状态，不回滚既有/并行改动。

结束结果见`E/protection-after.json`：重算限定范围原件哈希、独立副本哈希与允许范围外Git状态；`E/document-check.json`记录首次文档/行号引用/历史FAIL核验，`E/final-artifact-check.json`记录最终文档哈希及范围摘要。核验通过只表示范围与材料一致，不表示预算验收。没有构建、项目测试、Node实验、设备操作、子Agent、会话创建/联系、Git提交/暂存或依赖升级。

**推荐：先审批02f的独立条款与K1–K4能力补齐范围；不批准“直接进入容量实现/已具备有限总预算”。当前交付用于用户手动转交，结论为待总工程师审批。**
