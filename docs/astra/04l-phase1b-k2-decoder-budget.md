# 路线 C K2：HTTP 解压工作区与受限输出可行性

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**结论：待总工程师裁定K2解压子项。** 本文不宣布 K2 整体关闭。总工程师已条件关闭固定范围 K1，依据 04k 及其最小清理调整；本轮接受该边界，不重开同义调查，不视为生产通过。02d 仍为现行规范，02f 仍草案，r3/1C/G1 未放行。

独立证据根 E：`docs/astra/evidence/k2-decoder-20261003-c84a16/`；精确源码 S：`E/vendor/`。以下包路径均相对 S。只新增 E 与本文；既有项目、原型、报告、契约、缓存、归档和历史证据不写。无子 Agent、其他会话、生产接入、设备操作、Git 提交、依赖升级或全局 Cargo 配置修改。用户手动转交。

## 1. 精确状态与分配表

先列现状，后给预算。数字均为 **allocation 请求布局**，不是 malloc 实占、RSS、设备可用 RAM 或 OOM 成功承诺。固定布局来自本轮 x86_64 Linux 宿主；其他 target 必须重新求 sizeof，不能照搬。只讨论 HTTP body，TLS 证书解压未运行、未展开。

### 1.1 版本、features、默认参数及输入控制

| 编码 | 精确依赖与有效 feature | 实际默认状态 / 输入可控项 |
|---|---|---|
| gzip | wreq 5.3.0 → async-compression 0.4.42/tokio,gzip → compression-codecs 0.4.38/gzip → flate2 1.1.9/rust_backend → miniz_oxide 0.8.9/with-alloc,simd；crc32fast 1.5.0 | GzipDecoder 的 raw DEFLATE + CRC/ISIZE；multiple_members=false。输入控制 fixed/dynamic/stored block、码表、距离、gzip extra/name/comment、长度和 footer；不能使固定 inflate 状态扩容 |
| deflate | 同上，async/codecs 的 **zlib** feature；不是 raw DeflateDecoder | ZlibDecoder → FlateDecoder::new(true)，默认 15-bit 配置，miniz 后端固定 32 KiB 字典；CMF/CINFO、FDICT、Adler32 可受输入控制，不加载外部字典；multiple_members=false |
| br | async/codecs brotli → brotli 8.0.2/std → brotli-decompressor 5.0.0/std；alloc-stdlib 0.2.2、alloc-no-stdlib 2.0.4 | `BrotliState::new`，**不是 new_strict**；初始 large_window=true，标准 WBITS 最大24，扩展10..30。输入还控制 metablock 长度、是否最后块、1..256 block types/trees/context maps；无 custom dictionary，multiple_members=false |
| zstd | async/codecs zstd → zstd 0.13.3 → zstd-safe 7.2.4 → zstd-sys 2.0.16+zstd.1.5.7 | buffered output、validate checksum、无字典、无多字典表、无 maxBlockSizeParam；默认 maxWindow=(1<<27)+1。wreq **只对本编码**设置 multiple_members=true。frame 可控 W/FCS/dictID/checksum/blocks/skippable frame；完整已知小 FCS 存在绕过流式 window gate 的单次捷径 |

共同底层：compression-core 0.4.32、tokio-util 0.7.18、bytes 1.11.1、Tokio 1.52.3、futures-util 0.3.32。项目 wreq-util 2.2.6 默认 features 合并四编码，`Accepts::as_str` 全开为 `gzip, br, zstd, deflate`。本轮未改 Accept-Encoding、探测优先级、删头或自动解压。

**不可漏算的 feature 合并**：compression-codecs 对 zstd 关闭 defaults，但 boring2 4.15.15 的可选 zstd 依赖未关闭 defaults，已启用的 cert-compression 使 zstd 的 legacy/arrays/zdict_builder 合并到同一包。这里只为 HTTP decoder 确定编译能力，不审计 TLS 证书路径。宿主显式启用同一 zstd defaults，离线 `cargo tree -e features` 已确认 legacy；不把无 legacy 的瘦构建冒充当前行为。zstdmt、外部 pkg-config zstd、替代 flate backend 没有在本宿主启用。完整生产二进制 features/环境仍非本轮证明。

### 1.2 分配、同时持有、成员切换、保留及释放

| 编码 | 状态 / 工作区申请 | 源和目的同时持有 | 成员及历史容量 | 最后释放 |
|---|---|---|---|---|
| gzip | 一个 `Box<InflateState>`：43296 B，其中含32768 B字典及固定 Huffman/位状态；codec 值96 B内嵌外层对象。header parser 固定10/2 B片段、extra计数器，footer8 B，不累计 name/comment | 完整编码 Bytes owner + bit/parser余量 + inflate字典 + FramedRead目的 + 已返回输出可同时存在 | 只处理首成员；reset（若显式调用）原地重置，不另建字典；当前路径没有跨成员重建。字典不会因输出变短或 EOF 自动释放 | decoder/外层持有者 drop 才释放 Box；停止 poll、错误或 C 标记均不等于 drop |
| deflate | 同一个43296 B布局；codec值32 B，zlib header/checksum在固定状态中 | 同 gzip；不是“原始源被字典替代后可不计” | 首 zlib stream；没有 raw fallback 或自动多成员；同固定状态保留 | 同 gzip |
| br | Box<State>=2600 B；初建context Huffman表1080×4=4320 B；window ring、两组block表、三组树/offset及maps见§2.2 | 编码 owner、最多8 B输入scratch、ring中的历史/待输出、外部目的同时存在；ring不是外部17 B sink | 每metablock清 maps/树；固定block表和context表及ring保留。ring仅为空时申请一次，最后块可缩小初始申请；当前单成员，无持续累计历史metablock分配 | `BrotliState::Drop` cleanup释放全部自有 allocation，然后state Box；静态122784 B字典为只读映像共享一次，不按流重复 |
| zstd现代 | DCtx=95992 B；一块合并 input+output workspace，input≤131072、output≤W+262144+64；见§2.3 | 外部编码 owner +内部压缩block暂存 +内部解码环 +外部输出；直写捷径减少本次新申请但可能仍保留旧workspace | SessionOnly reset不释放旧workspace；不足或 oversized-duration 路径才先free旧combined块再申请新块；现代高水位可跨frame留存 | `DCtx::Drop → ZSTD_freeDCtx` 释放combined、legacy及DCtx；sizeof_DCtx接口本身**不含legacyContext** |
| zstd legacy | 当前流式dispatch支持v0.4..v0.7，各有wrapper+DCtx+input+output；v0.1..v0.3流式返回version_unsupported。详见§2.3 | legacy工作区可与现代combined workspace同时留存，必须相加；不是二选一 | 同legacy版本复用；换legacy版本先释放旧context再创建新context；切到现代并不自动释放旧legacy；任意frame次数不会累加所有历史版本 | 父DCtx drop按previousLegacyVersion释放最后legacy；非当前协议active也继续占账 |

共同外壳状态：wreq `Pending(Peekable)` → 选中的一个 decoder → `StreamReader` → `FramedRead<BytesCodec>` → Fuse。仅一条选中的解码路径；不是 gzip+br+zstd+deflate 四层串联。header exact-value检测及顺序 gzip/br/zstd/deflate 保持现状，不新增逗号链解析、多层自动解压。

源码定位：wreq `src/client/decoder.rs:235,267,418,475`；async `src/generic/bufread/decoder.rs:1`；codecs各 `src/{gzip,brotli,zstd}/decoder.rs`；flate2 `src/ffi/miniz_oxide.rs:37,65,100`；miniz `src/inflate/stream.rs:61,121,155`。`E/audit-*/source-excerpts.json` 保存带行号片段与文件哈希，完整源码已封存。

## 2. 源码上界，不以观测最大值填数

### 2.1 gzip / deflate

`InflateState` 与 `DecompressorOxide` 全部为定长数组/标量；唯一堆申请是固定 Box，inflate过程中无动态码树 Vec。单decoder内部动态工作区：

```text
W_gzip = W_deflate = sizeof(InflateState) = 43296 B   [本target]
```

codec值、外壳Box、源/输出、错误对象另算，不把96/32 B再重复加到已经计完整外壳的账中。gzip name/comment 可任意长，但 `consume_cstr` 每次消费并更新CRC、不保存字符串；extra仅u16剩余计数。因此长header不增加这部分heap，却可能增加处理时间。gzip ISIZE模2^32检查不是整个响应4 GiB限额；不能借它给长流设新总长度政策。zlib合法header window不改变miniz固定申请；错误/截断在既有路径返回，不能将固定工作区当作数据接受保证。

### 2.2 Brotli：实际默认含30-bit large window

`brotli-decompressor/src/decode.rs:152,1810,2812,3034`；`state.rs:388,449,463`；`huffman/mod.rs:28,61`；StandardAlloc最终是exact长度Box slice，无池/缓存。输入无custom dictionary：

```text
R <= 2^30 + 42 + 24                       ring及write-ahead slack
T_fixed = (1080 + 2*3*1080)*4 = 30240     context表和block type/length表
T_groups <= 3*256*(1080*4 + 4) = 3320832  三组树及每树u32 offset
Maps <= 256 + 256*64 + 256*4 = 17664
State = 2600
W_br <= 1077113226 B                     约1 GiB +3.22 MiB，不含外壳/源/外部输出
```

每组ntrees来源为最多8-bit变长数+1，故≤256；map大小由最多256 block types的固定context位宽导出，不能被输出总长度放大。每metablock开头/结尾 reset/free，而不是Vec历史容量留存；树组init先reset再alloc。ring只在空时申请，无ring旧新扩容叠加；state新建时没有历史ring。上述把所有组极值相加是保守包络，不声称同时可达。

标准非扩展WBITS≤24的**条件子集**可用 `W_br<=2^24+3371402=20148618 B`；当前接受域不是这个子集。默认扩展30位有效，不可擅自 `new_strict` 或cap24。即使目的每次只有1 B，非最后metablock也能要求完整window ring。测试只用可由最后块窥视缩小ring的30位声明，未分配1 GiB；1 GiB上界来自源码，非压力观测。

静态字典122784 B及其他只读表属于映像共享 `Image_decoder_rodata`，不是每流新增heap。线程栈/构造临时状态/递归深度、allocator元数据及碎片在§4具名列出，不被heap式子吞掉或填零。

### 2.3 zstd：现代、legacy及历史叠加

现代C源码 `decompress/zstd_decompress.c:1970,2016,2170,2230,2259`：设声明window为w，`W=max(w,1024)`，`B=min(w,131072)`（解析blockSizeMax），F为已知FCS或unknown：

```text
I = max(B,4)
O = min(F, W + 2*B + 64)   # unknown时取右项
I+O <= 134611009 B         # 用 maxWindow=134217729 的保守包络
W_zmodern <= 95992 + 134611009 = 134707001 B
```

不是所有输入都申请此值。W=2^27未知FCS实际combined=134611008，连DCtx=134707000，与头部/历史测试吻合；多出的1 B是保守阈值式，不是实测误差。window descriptor可表达的邻点为0x87=120 MiB、0x88=128 MiB、0x89=144 MiB；single-segment FCS也可直接决定window。block上限128 KiB不等于output ring或外部chunk大小。

**重要例外**：已知FCS≤当前目的余量且当前源内有完整frame时，C在流式window检查之前走单次解压。故声明256 MiB、实际FCS512 B的frame可由当前8192 B目的接受；17 B目的或输入碎片化会走window gate报错。这不产生256 MiB新ring：捷径使用外部目的和固定DCtx，却意味着“统一先验拒绝w>128 MiB”及“任意小slice替换”都不是保持现状的适配。

legacy默认开启，流式分派在现代window gate之前。64-bit布局与上界：

| 版本 | window域 | DCtx / wrapper B | input / output申请包络 B | 合计 L_v B |
|---|---:|---:|---:|---:|
| v0.4 | 低4位+11，≤26位 | 141448 / 136 | 131072 / 2^26 | 67381520 |
| v0.5 | 低4位+11，≤26位 | 157848 / 128 | 131072 / 2^26 | 67397912 |
| v0.6 | 低4位+12，≤27位 | 152712 / 120 | 131072 / (2^27+131072+16) | 134632720 |
| v0.7 | 检查≤27位且window≤2^27 | 152864 / 160 | 131072 / (2^27+131072+16) | 134632912 |

32-bit legacy有25位额外检查；本轮不以x86_64数字证明ARM布局。v0.4/5 output是window而非现代双block公式；v0.6/7的wildcopy是8，与现代32分开。v0.1..v0.3编入源码不代表该流式API接受；dispatch明确unsupported。FSE动态表创建helper并非这些解码调用链的新增动态树，表内嵌DCtx。

历史现代combined与最多一个legacy可以同时存在。因此当前完整zstd接受路径的保守请求包络：

```text
W_zstd <= W_zmodern + max(L_4,L_5,L_6,L_7)
       <= 269339913 B       # 约256.86 MiB / decoder，不含外壳、源、FramedRead、目的
```

换legacy版本先free旧版本；现代combined替换也是先free后malloc，不须加两份同类旧新workspace，但现代+legacy真并存不可去重。SessionOnly reset不释放高水位；oversize默认因子3、持续阈值128（`common/zstd_internal.h:258,265`），不是按当前frame小window立即缩容，也不能作为固定低预算。`ZSTD_sizeof_DCtx`只算现代in/out及字典，漏legacy，故本轮用原生malloc/free计量而不单用此API。

该式适用于默认无字典/无multiple-DDict、默认编译常量、无外部zstd替换。不能把仅window约128 MiB写成总内存，更不是建议设备预算。32个活/退休decoder会达非常高的条件包络，本轮既不设32个有效存活，也不做多GiB并发试验。

## 3. 受限目的与完整源余块

### 3.1 原FramedRead特定路径的有限输出证明

04e只确认初始8192，并未证明全部输出。这里补足 **BytesCodec专用路径**，不推广到任意codec：

1. FramedRead初始capacity=8192；BytesCodec遇非空立即`split_to(len)`返回全部内容，故每次读前buffer.len=0；Pending也不会累计未分帧数据。
2. 读前只`reserve(1)`。bytes 1.11.1 `bytes_mut.rs:607–790`：唯一Vec可回收前缀；唯一Shared有足够底层capacity可回收；有别名则申请`max(1,original_capacity)`。original_capacity表示8192，不会因零len分支扩大。归纳每个payload backing申请≤8192，read只写可用spare，返回len≤8192。
3. shared控制对象为40 B（本target）。多个短输出可能共用同一8192 backing；按allocation身份去重，不能每slice都算一块，也不能只算len。
4. 外部无限保存并继续poll会有无限多个历史backing，库没有限制用户保留数量。若 `R_i` 个未退休返回owner并存，则保守 `O_i <= (R_i+1)*(8192+40)`；+1为framing存储。受限单outstanding适配取R_i≤1，`O_i<=16464 B`。这含保守两块，不假称任何时刻都真有两块。

该证明依赖bytes/工具链请求capacity语义及无外部reserve/自定义codec。不是依据本次最大输出8192采样。申请失败、allocator usable-size/arena与RSS另记。

### 3.2 编码源，不能拿输出限额替代

`StreamReader::consume`只advance，`chunk: Option<Bytes>`仍保留完整owner，余len=0也未drop。`poll_fill_buf`取得下一个chunk后才赋值替换旧chunk，因此换块瞬间**旧、新完整backing同时存在**。Pending的Peekable仅将初始item转入reader，不在常规路径永久多预取一块；但上游producer自己的暂存和排队必须另计。

定义 `S_i` 为该上游路径一个交给reader的完整唯一backing及其owner元数据上界，不是slice长度。保守源持有为 `Enc_i<=2*S_i`，再与上游已计allocation做union。暂停时常见只有1份，不能用常见状态覆盖换块。尾随检查绕过reader残块、直接poll其inner，也须遵守同一完整源责任。

K1受限页路径可条件代入p=16384及04k owner56 B，但页payload/owner已在K1池内，不再重复加物理内存；应将reader-held / 换块重叠加入K1 `S_s` 源槽及页池条件。若现有组合只允许一个源槽且旧空owner钉槽，直接接原StreamReader可能无法申请下一槽而停住；不能拿K1条件关闭当作已验证解压组合。

**B候选**：同栈reader适配先退掉已消耗的空owner，再poll下一块，或在组合账本明确保留一个换块槽。前者只缩短不可读空owner寿命，不改变解码输入字节/错误；仍需验证取消/尾检查和source credit时序。本轮没有修改K1或StreamReader，这一组合实施证据仍未取得。H1的`S_H1`与`U_H1_other`未闭合，保持具名外参，不调查完整H1接收，不把417792策略值填成backing。

### 3.3 推荐的保行为目的机制

保留原编码选择、原StreamReader输入分片、原FramedRead/BytesCodec及8192调用形状。取得一个已证明有限的解码块后停止后续poll；对目的sink预留实际字节/事件/allocation credit，逐次复制≤min(Q,剩余credit)，源块直至耗尽/安全丢弃才退休。这样先取得的8192全归U，目的才归候选A后的P，不是事后拒收掩盖未知源。

本宿主`transfer`模式保留FramedRead，预分配17 B目的，逐段copy并在同一块处理完前不poll下一块。四编码输出完整、成员和zstd大window差分保持，补充18例按预期完成。它是有限内部可行性实验，**不是Transport全局credit仲裁、真实wreq网络、线程桥、C/D或生产实现**。

直接把async decoder输出改为1/17 B有能力限制外部输出，但不保证现有接受/错误时序；zstd已有明确反例。重分片编码输入还会改变gzip/br/zlib尾随成员错误，不能用预先切小源块作为无语义代价适配。保留原驱动后受限复制是本轮优先推荐。

## 4. 组合路径与取消退休

| 参数 | 责任 / 不能填零的理由 |
|---|---|
| `K1_unique(s)` / `S_s` | 04k固定域已条件关闭的页、source、metadata唯一allocation及有效源槽；解码源页若已包含只增加归属边，不双加 |
| `S_H1`, `U_H1_other` | H1完整源backing、producer/预读等；本轮不展开，不能用8 KiB解码输出覆盖 |
| `N_dec_live(t)` | 含active、EOF/error但仍持有、cancelled/retiring decoder；K4提供，不等于32 active |
| `H_wrap_i`, `H_error_i` | 实际wreq Box/Fuse/reader/source、固定错误内容及库包装布局；codec字段已内嵌不重复。宿主dyn Box不等于生产Box，不用宿主差值填写生产常量 |
| `D_sink(t)`, `P_bridge(t)`, `J(t)` | 目的、bridge副本和D后用户owner；copy期间源目的是真两份，不因内容相同去重 |
| `Stack_decode`, `Alloc_extra`, `Image_decoder_rodata` | 线程栈/临时、allocator实占碎片/保留arena、共享代码静态表，均非本报告heap请求预算；无RSS硬限声明 |
| `K3_protocol_TLS`, `K4_other` | headers/TLS证书/共享连接和控制池等范围外责任，明确非零未知参数 |

每个decoder的局部请求包络：`W_encoding + O_i + Enc_i + H_wrap_i + H_error_i + D_sink_i`，只在这些是不同allocation时相加。全路径必须按同一时刻/实际id取union：

```text
Heap_request(t) <= UniqueUnion(K1_unique, U_H1_other, Enc_i, O_i, D_sink, P_bridge, J)
                 + sum(i in N_dec_live(t)) [W_encoding(i)+H_wrap_i+H_error_i]
                 + K3_protocol_TLS + K4_other
```

body只选一种encoding时，用该W而非四种总和；不同并发响应按各自编码数分别求和。plain支路不创建decoder，却仍依赖完整source；header逗号链未匹配时按现有plain/选择逻辑，不擅自串联。如果未来批准真正嵌套解码，必须逐层工作区+中间源目的重新建账，当前上界不覆盖新增能力。

取消：停止poll保留所有decoder状态；宿主C-held仅标记取消意图，输出、源、workspace仍实存。所有非超时取消用例中，完整decoder drop后Rust/native/input-owner归零。该证据支持RAII局部释放，不证明真实Transport C到drop时间或任务退休数量。同步decode一次poll可能消耗大量metadata/空frame或高ratio计算，目的满才返回也不提供每poll时间上界；本轮AS/CPU/wall是实验安全阈值，不得转成新生产错误政策。调度取消先C、正在poll的独占持有者返回后drop，退休前继续占额度，不能等待drop才允许C，也不能C后立即把额度借给新decoder。

## 5. 有限测试与独立核对

先完成`E/source-derivation-before-tests.md`后构建运行，资源方案先写`resource-plan.json`。离线WSL Ubuntu x86_64，rustc 1.97.1（8bab26f4f68e0e26f0bb7960be334d5b520ea452）、LLVM22.1.6、GCC15.2.0，dev；无网络/设备。单decoder单进程，case输入≤2 MiB、输出≤4 MiB、frames≤8、wall12s、CPU8s、AS512MiB、文件16MiB、循环≤5000000；构建wall300s/CPU240s/AS3GiB/jobs2。未做32路大window，最大现代window仅单context；Brotli 30-bit只测小最终块声明接受，不申请GiB。

来源：48个相关archive逐包与项目lock checksum核对、从本机缓存复制；3个缺失Windows/WASI精确源从04k vendor只读核验后复制。唯一依赖适配为新`host-jobserver/Cargo.toml`删除Linux不使用的Windows-only getrandom声明，避免缺失r-efi/wasip2离线解析；jobserver源码未改，版本未改，decoder源码未patch。原vendor保留未改。新CFLAGS只把zstd编译单元malloc/calloc/free转向计量函数，实际仍调用系统分配；Rust GlobalAlloc单独计量。C布局诊断是未改C源码编译期sizeof，非用峰值推导大小。

宿主边界：真实精确decoder依赖链和StreamReader/FramedRead，手工复现wreq的multiple_members与尾随检查；不是链接完整wreq/Hyper/TLS网络。wreq Pending空body捷径和公开Error wrapper只做源码核对，没有冒称端到端通过。构造错误/空body行为不在adapter中改写。

| 证据集 | 结果与边界 |
|---|---|
| `runs/build-165701-40d644` | 原宿主构建code0，240.28s；`freeze-baseline-6b6808bc`保存源码、lock和可执行文件 |
| `tests-0a967279` | 63例，59按预期，4个raw/short-17在预设wall12s被kill，returncode=-9；全部保留，不合并称63通过 |
| 原组正常/分片/短空间 | 四编码原始262144 B、512 B逐字节输入、1 B输出均核对；输出短空间不是内部工作区结论 |
| 高ratio | 四编码1 MiB重复K，完整字节核对；zstd为手写8个RLE block；其他压缩器只生成输入，期望从原始文件取得。长输出由多次输出完成，不聚合到decoder |
| 成员 | gzip/br/zlib相同块两个成员只返回首个且EOF；分成后续块则code2尾随错误。zstd两frame两种分片均完整1024 B，skippable frame被跳过 |
| 错误 | invalid/truncated code2、error kind/message保留；错误后drop归零，不据分配后错误证明预先受限 |
| 取消与完整backing | 四编码首输出后C-held仍保留1 MiB编码owner；drop后所有计量allocation/input owner归零。它不是设备C/D验证 |
| zstd窗口与历史 | 0x87/88/89/90声明、头部截断、已知小FCS完整输入/短输出差分；大→小frame后native仍134707000 B，drop后零；不是small frame自动缩容 |
| Brotli声明 | 标准24、扩展25和30位小最终块接受并完整输出；31位既有错误。未用此小样本峰值代替1 GiB源码界 |
| legacy | v0.4/5/6/7手写raw frame各完整512 B；v5→现代→v6完整1536 B、旧/新版本及现代workspace生命周期可见，最后归零 |
| `runs/build-170624-a0b7a7` | 受限transfer宿主构建code0，71.55s；decoder依赖未变 |
| `followup-eb903e76` | 18/18按预期：四编码small/short17与transfer17、成员、zstd大window受限转移/分片拒绝、gzip/deflate校验错误及完整前缀 |

原始数据由独立Python定义 `bytes(range(256))*N` / `b'K'*N`；gzip/zlib用Python标准zlib编码，Brotli用encoder生成输入但期望不经decoder生成，Brotli边界及zstd现代/legacy另有手写格式输入。checker逐字节比对输出及SHA256，cancel核对正确非空前缀；不以被测decoder自解自验为唯一oracle。每case manifest记录原输入/输出长度与hash，准确进程code/timeout分别保存。无效输入不声称其全部输出必须等于正常原文。

四次超时发生在大量17 B写入/源碎片的同步文件宿主工作量中，本轮未做阻塞栈诊断，不强行归因为decoder性能。补充只换成512 B有限样本验证同一短空间机制，不延长阈值、不改旧判定，不证明大样本17 B模式性能通过。

计量局限：Rust ledger固定8192槽（静态约192 KiB另加Mutex），native拦截仅zstd编译单元；日志/文件/宿主/内核不等于业务heap。realloc回调不能观察libc内部旧新搬迁峰，源码按需给重叠；没有以采样RSS填硬预算。完整source负对照的预分配读buffer还可能在EOF前申请一个未返回块，这属于宿主producer，不误计为生产decoder工作区。

保留失败账：材料准备缺r-efi code1；首次构建找不到rustc code101；第二次离线缺wasip2 code101；随后精确Linux-only构建成功。PowerShell错误路径/brace/glob和WSL systemd警告记录为准备命令问题，不充测试通过。既有K1及04c等历史FAIL没有重跑、改判或覆盖。

## 6. A / B / C 裁定建议

| 路径 | A：保持行为已有依据 | B：同栈内部适配可实现 | C：审批或明确能力阻塞 |
|---|---|---|---|
| gzip | 固定43296 B工作区；特定FramedRead单backing8192界；长总输出不放大工作区 | 原驱动后受限copy，完整源/输出credit与退休；本轮局部transfer验证 | 无来源backing界或live数量则不能成总预算；不得为方便改成多成员或“修复”尾错误 |
| deflate | 同固定工作区与输出界；保持zlib格式 | 同上；不引入raw fallback | 同源/live依赖；新增fallback或错误语义需另批 |
| br | 完整当前接受域内部heap≤1077113226 B，本target保守包络；不是16 MiB | 原驱动后受限copy可行，不改变large-window | 若设备承担不了该合法window代价，capWBITS/new_strict属接收能力变化，停审批；本轮未证明更省RAM且同接受域的替代实现 |
| zstd | 含legacy/历史的内部heap≤269339913 B条件包络；不是128 MiB总额 | 保留原8192形状后受限copy，避免破坏单次捷径；已测差分 | 直接短slice替代已有拒收反例，不批准；lower WindowLogMax不能覆盖legacy/捷径全域，不能凭一个参数宣称统一低预算 |
| K1页→decoder→sink | 条件union公式成立；不重复K1页payload | 先退空owner或换块源槽，且组合信用证明；不改K1固定域 | **尚未做该真实组合**，source-slot交接/取消退休仍需最小宿主验证；不把K1关闭等价成组合通过 |
| H1→decoder→sink | decoder子式成立 | 相同目的方案可复用 | `S_H1/U_H1_other`未给有限backing，故完整路径不能宣称已证；本轮按范围停止 |
| 四编码混合并发、retiring | 按真实decoder集合逐项求和；不是一响应四层相加 | allocation token直到真实drop才退，可保持C先行设计 | `N_dec_live/H_wrap/H_error/Stack/Alloc_extra/K3/K4`未批准/未量化，生产总额阻断，不填32或零 |

**可裁定的实质结论**：四个decoder的输入驱动heap申请均存在与总响应长度无关的源码有限包络；保留当前行为不必关闭编码。但br及zstd完整接受域代价很大。现有输出路径并非天然无界块；补足BytesCodec专用归纳后，保留原驱动+受限目的转移可行。不能在未解决完整源/有效存活/布局外参前把此结论扩成K2全部或生产总预算通过。

### 6.1 仅供审批的低预算政策，不实施

| 精确候选 | 受影响输入 | 保行为替代 / 最低验证 |
|---|---|---|
| br `new_strict` 或显式WBITS≤24 | 当前接受的large-window扩展，尤其25..30位；new_strict还可能排除扩展10..24而非仅大window | 保留现状预算；或另行研究同算法分页/外存历史，未证明。审批前要求标准/扩展边界、真实历史距离、分片/错误/取消及声明与实际申请差分 |
| zstd `DParameter::WindowLogMax(k)`，例如k=23 | 现代流式window>8 MiB；还必须说明单次捷径、legacy是否保留。该参数不是统一所有路径硬cap | 保留原预算/调用形状；若要统一拒绝须新增header/legacy政策，明确FCS已知捷径原接受输入及错误映射。至少现代+legacy全边界、skippable、多frame历史和短输出差分 |
| 直接目的17 B或任意Q替换原FramedRead | 已实证原接受的144/256 MiB声明、512 B内容完整frame被拒绝；输出/错误前缀与时序也可能变 | 推荐保留原FramedRead并copy到Q；无需用总响应限长解决流式工作集 |
| 禁编码/改Accept-Encoding/限制整个长响应 | 编码协商、自动解压或原本合法长流发生变化 | 不作为本轮默认候选；无授权不实施 |

不建议用OOM、分配后拒收、短view、停止poll或总响应8 MiB封顶替代stream工作集证明。request既有聚合限额与stream无限总长度工作集是不同责任。

## 7. 封存与手动交付

报告完成后重新核验相关输入、独立字节结果、lock/features与二进制freeze；新增seal清单与差分，随后最后另写一次delivery，含本文hash与seal清单hash。delivery写出后不回写本文、索引、旧报告或旧证据。以E内最后delivery为交付入口。

最低下一步不是全栈泛化重审：总工程师先裁定本解压子项的A/B界与成本；若采纳保行为路线，只需授权在既定K1源槽交接上组合原decoder与受限sink、求真实wreq外壳/错误布局并验证取消退休，再由对应负责人补H1/K4具名参数。任何接收能力变化单独批准，不能用本报告默认授权。

**结论：待总工程师裁定K2解压子项。K1固定域条件关闭不变；02d有效、02f草案、r3/1C/G1未放行；不宣布K2整体关闭或生产通过。**
