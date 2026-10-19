# 路线 C K1：codec 源 backing 上界闭合

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**交付类型 B：可兑现条件化源申请容量子界的最小隔离补丁及剩余义务。结论：待总工程师验收codec子界。** 现行规范仍为02d；02f仍草案。完整K1、r3、1C、G1均未放行。本轮不证明全库内存、allocator实占、生产wreq或设备有界。

## 1. 答案、条件与数值

在固定接收frame最大payload `F=16384`、接收header-list配置 `H=262144`，真实driver同步处理一帧后才取下一帧、页聚合复制完成即释放源、采用本轮隔离补丁的条件下：

```text
T = F + 9 = 16393 B                         单个frame源allocation申请大小
m = max(1, floor(H/F))
K = max(5, m + (m >> 2)) = 20               原有non-final CONTINUATION限制
C = (K + 2) * F = 360448 B                  单个Partial编码暂存申请大小
U_source(t) = sum(capacity(a), a in live unique frame/Partial allocations)
U_source(t) <= T + C = 376841 B              每个串行接收codec的保守源子界
```

这不是观测最大值代替证明。`T/C`在申请和读入前从现有配置计算；§4给出归纳。没有源reserve/realloc，因此本补丁源域的增长旧新重叠为0；首HEADERS源复制到Partial时两者同时存在，已包含在`T+C`，不再额外加一遍。

合法DATA不能插在未完成CONTINUATION中间，故正常DATA页复制期间源仅`T`。一块当前目的页 `P=16384` 与它同时存在，单次copy配对为 `T+P=32777 B`。跨页复制先后发生，不能把同一源对每次copy重复累加；完整目的页池另按唯一页计。目的页、header解码输出、控制对象与allocator开销不在`U_source`，不能把此数称为复制期间全进程峰值。保守跨协议阶段的源界仍使用`T+C`。

补丁不要求缩窗口、满池RST、禁H2、降低公开并发或改变admission。它以定额frame分配、Partial一次预留与HPACK源脱离换取可审核的不变量；不是批准生产容量或成本。04h的770页仍只是其特定条件算例，本轮回环使用8页且输入有限，没有验证完整窗口页池责任。

## 2. 范围与证据定位

独立证据根，下文E：`docs/astra/evidence/h2-k1-codec-20261003-c7e921/`。仅新增E及本报告。没有改旧源码、原型、报告、契约、缓存、业务文件；没有子Agent、会话创建/联系、Git提交/暂存、设备操作、依赖升级、全局Cargo配置或生产接入。用户手动转交。

读取04e至04h及02d/02f；核对所用04h最终delivery与seal。`audit/frozen-input-verification.json`核验相关冻结源码/vendor/archive与旧seal，并核验04h最终报告SHA；`audit/protection-before.json`覆盖3029项相关输入。保护只覆盖相关输入，不扫描无关业务树。旧三项失败单独只读摘录在`audit/historical-timeouts.json`，不改判。

| 材料 | E内定位 |
|---|---|
| 基线/补丁 | `before/`、`after/`，均复制04h diagnostic/pages；承接空DATA消除、页聚合与旧屏障观测 |
| 精确依赖 | `vendor/`、`archives/`；http2 0.4.21、tokio-util 0.7.18、bytes 1.11.1、tokio 1.52.3、http 1.4.1 |
| 最终构建 | `results/before-build-142022-5d9c073b/`、`after-build-142122-540ba940/` |
| 最终codec组 | `results/before-codec-142228-0bc0a147/`、`after-codec-142258-c61c1db3/` |
| 最终回环组 | `results/before-loop-142328-a14a1022/`、`after-loop-142352-73780496/` |
| 最终feature/metadata/rustc | `results/before-metadata-142424-609ccc43/`、`after-metadata-142453-dc4c334e/` |
| 独立输入/交付/台账检查 | `results/independent-98cd6cfb/checks.json`，含失败尝试，不冒称全通过 |
| 最终源码/二进制关联及失败推进 | `results/audit-774950da/audit.json`；较早audit-fe859896误把构建计入尝试，保留且由本文件替代统计 |
| 标准库精确分配链 | `audit/std-source-5a81a7ed/`，HTML自带1.97.1/8bab26f4f标识，另存提取文本和哈希 |
| 最终封存 | 报告完成后新建`results/seal-*/`，其中semantic.patch、locks、archives、binaries、report、artifacts；最后另写`delivery-*.json`定位 |

WSL Ubuntu，rustc 1.97.1 `(8bab26f4f68e0e26f0bb7960be334d5b520ea452)`、LLVM22.1.6、x86_64-unknown-linux-gnu dev。两个宿主显式`--offline --locked`，仅E内cargo-home/vendor/target。新增直接futures-core=0.3.32仅用于调用Stream trait，已在原lock传递依赖内，未升级。只测真实http2 codec及明文H2回环，不是hyper2/wreq完整栈。

## 3. 原精确源码状态模型与引用闭包

状态用 `(allocation id A, 申请容量 c, offset o, 视图len l, 视图cap v, 引用集合 R)` 表示。读可写量为`v-l`，不是`c-l`，frame逻辑长又是另一变量。以下路径相对E中的before/http2或vendor对应包，引用的是实际精确版本，不是最新文档。

| 转移 | 源码与含义 |
|---|---|
| 初始化 | tokio-util `src/codec/framed_impl.rs:25,46`初始8192容量；只是初值 |
| 读前 | `framed_impl.rs:210`附近reserve(1)，`src/util/poll_buf.rs:58`用整个chunk_mut建ReadBuf；实际暴露spare，不受reserve参数n限制 |
| 长度前缀 | http2 `src/codec/mod.rs:44`为3字节BE、adjustment9、skip0；tokio-util `length_delimited.rs:500`先以原payload n校验F，再调整到n+9并reserve缺量 |
| split后预留 | `length_delimited.rs:572,600` split_to完整frame后仍reserve下一段3字节前缀；此时刚产出的frame仍活，不能假设read handle唯一 |
| split/freeze | bytes `src/bytes_mut.rs:394,245` split_to缩小两个视图但共享allocation；freeze不等于紧凑复制；advance使offset增加，容量视图不等于原申请容量 |
| VEC reserve | `bytes_mut.rs:610`起：若前缀空间足够且offset>=len，则搬回原块；否则重建包含offset的Vec调用reserve，可能扩容 |
| ARC唯一reserve | 同文件约670起：先尝试尾部恢复/前移；否则目标取`max(2*old_capacity, offset+len+additional)`再Vec reserve |
| ARC共享reserve | 同文件约760起：新容量取`max(len+additional, original_capacity)`，新Vec复制后才release旧共享handle；旧块可能仍由其他视图保留 |
| 最后释放 | `bytes_mut.rs:1127,1453`；Bytes的共享vtable同理最后引用才释放原Vec；drop一个短view不代表原backing已释放 |

原frame上限只约束logical payload。读入前可能已有read-ahead；reserve也可能保留更大的历史容量。原源码未直接提供`T`固定申请不变量，且共享与offset的增长状态必须纳入。基线`growth`明确构造8192B旧块被7990B冻结view持有，read剩10B后reserve得到16393B新块；两块同时活24585B，复制后旧view字节仍正确。这个数是具体状态验证，不是原实现通用Bmax。

**不作“原实现必然无有限界”的错误结论。** 对固定配置、特定role、已限定所有header持有者的闭包，可继续推导更宽且实现相关的界；本轮选择B类，用局部内部复制消除跨历史源引用依赖。原实现不能仅凭F与DATA页立即释放推出本报告的固定源界。

实际影响源backing的引用逐项核对如下：

| 持有者 | 原路径与本轮处理 |
|---|---|
| read buffer / 当前frame / DATA | 共享同一源时按allocation去重；DATA padding只advance/truncate，仍钉原块。原页append仅借`&[u8]`同步copy，不保存源，recv返回后source退出 |
| Partial.buf | `codec/framed_read.rs:180,318`首HEADERS留下未解完payload；空buf分支替换为续帧split_off，非空extend可增长；本补丁固定独立C并原地整理 |
| HPACK StringMarker / take临时 | `hpack/decoder.rs:287,457`非Huffman通过split_to.freeze取得字符串；临时name/value同样有源引用。补丁改成独立copy，消费原buffer后原地移前，不split |
| 普通header字段 | `hpack/header.rs:98` HeaderName::from_lowercase / HeaderValue::from_bytes复制；不能笼统说所有响应头都永久共享codec源 |
| pseudo / Protocol / 动态表 | `hpack/header.rs:67`起及ext.rs：authority/scheme/path/protocol可保留Bytes；table.insert(entry.clone())先于header语义接纳。因此即便异常响应最终reset，也不能忽略动态表所持引用；补丁切断这一源边 |
| 已返回headers/队列/外部持有者 | 可持有上述pseudo值及其clone；codec级header-alias保留两帧header并复用动态索引，基线codec drop后仍有8192B源，补丁源归零。该输入验证codec持有图，不冒称它是合法client响应 |
| Huffman输出 / 动态表普通字段 | Huffman从decoder.buffer产生独立输出，不是frame/Partial源allocation；仍有另外的解码工作区与header预算，不填零、不纳入本子界冒充关闭 |
| SETTINGS/PING/WINDOW_UPDATE/RST/PRIORITY | load从借用slice解析成数值/固定字段，未保存输入Bytes |
| GOAWAY debug / unknown / 错误 | GOAWAY `frame/go_away.rs:51` copy_from_slice独立；unknown return None丢源；错误局部drop，EOF/Pending可能仍持read或Partial，直至codec真实drop才退休 |
| PUSH_PROMISE | 与HEADERS共用宏，源处理相同；Chrome profile仍push=false，未以禁push作为排除解码前源取得的理由 |

没有未知源引用被静默排除。HPACK解码输出、表/头部对象、GOAWAY复制具有真实独立allocation责任，但不再持有本域的源。若未来新增可逃逸源字段/clone，必须重开此证明，不得继承固定数量结论。

## 4. 隔离补丁与归纳证明

与before/http2相比，语义差分仅四个文件：新 `src/codec/bounded_read.rs`、`codec/mod.rs`、`codec/framed_read.rs`、`hpack/decoder.rs`。共同观测器、测试宿主与构建配置另列，不混成生产补丁。tokio-util和bytes源码未修改。

### 4.1 Frame读取

`after/http2/src/codec/bounded_read.rs:39`在首次poll前按`F+9`申请一次BytesMut；length-delimited对象仅保留原max配置接口，替换其FramedRead读取层。初始状态`target=3,len=0`。`:58`先计算need，再取`spare[..need]`建ReadBuf，**切片发生在poll_read之前**，不是读完后截断。

归纳：前缀阶段`0<=len<=3`，单次真实暴露`3-len`；凑齐3B立即校验n<=F，超大返回原FRAME_SIZE_ERROR映射，不读取其payload。合法后target=n+9<=T；每次暴露`target-len`，ReadBuf保证不会多写。长度到target则mem::take整个buffer；当前reader回到空状态，不保留同源尾部、read-ahead或split别名。没有reserve/grow；短读、Pending保留相同buffer。非法EOF保留错误，空EOF不伪造DATA。固定配置下need必<=剩余capacity，assert只是验证推导，并非越界读后拒收政策。

`BytesMut::with_capacity`精确实现是`Vec::with_capacity`（bytes_mut.rs:147）；封存标准库 `raw_vec/mod.rs:446–480`用capacity构造Layout，u8 alignment=1，Global `alloc.rs:205–212`返回请求size；因此本工具链这两类申请正好T/C。这不是“任何Rust实现都保证不多分配”的泛化。malloc内部size-class、allocator metadata/fragmentation、保留页、RSS并不由Layout决定，仍未证明；换工具链/allocator必须重核。

`BytesMut::freeze`可建立Bytes Shared控制块但不复制payload（bytes_mut.rs:245，bytes.rs:960）。其控制块与句柄不混入T；本宿主u8 payload没有源realloc。原始bytes增长测试仍保留以证明旧新重叠机制，但补丁实际frame路径没有走它。

### 4.2 Partial与HPACK

现有规则允许首HEADERS、至多K个non-final CONTINUATION、一个final CONTINUATION，单帧payload<=F，故整块编码内容至多`(K+2)F`；frame header、priority、padding只使可用编码内容更少。第K+1个non-final在append前按旧规则拒绝，其已取得frame仍计T。不新增header拒绝阈值。

首非final HEADERS解析后，在`framed_read.rs:189`按C申请一个独立buffer，复制未消费payload，随即让旧frame源退出。后续append只用此buffer；原is_over_size检查、continuation计数/stream-id错误保持。HPACK `take`在`decoder.rs:457`先copy字符串到独立Bytes，再copy_within移前剩余编码字节、truncate，offset不逐轮累加、capacity不改变。包括consume(n=0)也只整理，不产生源alias。Huffman原独立输出逻辑不改。

归纳：每个Partial最多一个C backing，buffer保存累计收到且尚未消费的编码子串，len<=累计编码量<=C；消费只减len并回到相同起点，所以后续合法append无需扩容。空Partial不会换成续帧backing。与一块当前frame同时活的最大申请并集为C+T。最后CONTINUATION成功/错误take出的Partial drop，取消/EOF后driver销毁也drop；EOF但对象仍被持有时**仍计C**，不提前宣布释放。

HPACK copy的目的字符串不是免费：可能与frame/Partial暂时共存，动态表及header可继续持有它们。只是源别名责任已断开；源子界不代表字符串总额、Huffman工作区或元数据已闭合。该改法存在反复copy_within的CPU代价，不是已优化生产decoder。

### 4.3 同时活数与页复制

真实`proto/connection.rs:350`取得一帧后同步`recv_frame`；`:512`到streams.recv_data。页版`proto/streams/recv.rs:687`取source、同步append直到完成，Page不保存Bytes，函数退出drop source后才返回下一次codec poll。没有await跨越源复制。因此无Partial时只有一块源；有Partial时只有一块C和一块正在读/解码frame，未发生隐藏历史源积压。

这是**driver使用条件**，不是公开Codec可任意连续poll并保留DATA的通用保证。若外部消费者保留r个frame源并继续poll，至少应加`r*T`；本轮不批准这种使用。多session/retiring codec若有已证明数量S，可形式上乘S，但S未由active/admission推得，不在本轮填生产数值。

## 5. 有限验证与停止条件

codec-check使用精确真实Codec，受控AsyncRead仅确定输入分割并记录真实ReadBuf暴露长度，不仿写decoder；DATA复制到固定16KiB目的块。真实TCP回环使用原页聚合driver，并沿用host_enqueue、peer_command、peer_ping_written、driver ping_received、peer_ack_read、host_ack_resumed屏障点。

每个codec输入<=400000B、完整输入帧<=64；最大实际360646B、22帧。回环预设复核上限512帧、131072B，宿主批输入<=65536B、payload<=34816B、n<=128，本轮n=4。codec无网络等待，外部wall12秒、CPU10秒、AS512MiB、10ms采样RSS>128MiB停止、单日志16MiB。回环另有原屏障2秒、async8秒；构建单独300秒。固定源码/二进制后串行运行，不并行构建与测试，不加时限，不跑Node全矩阵。

| 最终代表状态 | 基线 / 补丁结果与含义 |
|---|---|
| prefix：1/1/1长度前缀与余头短读 | 101 / 0；基线首读暴露8192>3，补丁逐次暴露need，交付abc |
| stitch / maximum | 两边0；多次跨读拼接12000B，最大合法16384B完整 |
| mixed | 两边0；4个1B DATA穿插8192B extension与PING，最后z；完整5B，不做长期小片保留实验 |
| padding | 两边0；非零padding及zero-padding，交付abc；源仍按完整frame backing计 |
| continuation | 两边0；40000B非Huffman字符串跨3帧，完整header值独立核验 |
| continuation-limit | 两边0；22帧、360448B编码内容；header过list阈值按旧is_over_size路径保持，codec层完成解码，不声称它被client当正常响应接纳 |
| header-alias | 101 / 0；pseudo值入动态表、下一帧索引复用，codec销毁但headers仍held；基线源未退休，补丁源退休 |
| huffman | 两边0；既有Huffman输出www.example.com保持，输入分割2/1/7 |
| cancel / truncated / oversize | cancel在Partial未完成时Pending后drop；截断EOF保持错误；oversize基线101源于前置read gate，补丁仅取3B即FRAME_SIZE_ERROR，均保留释放记录 |
| growth | 两边0；独立bytes共享reserve验证8192+16393同时存活24585B，不误当补丁路径峰值 |
| TCP backing / boundary / pause / cancel | 最终两边各4/4 code0；跨backing、16383+2+16384、A暂停或取消时B仍15B完整，窗口/SETTINGS不改 |

最终codec补丁13/13 code0；基线10个code0、3个预期gate code101，不称基线功能全通过。最终回环8个进程全部code0。独立checker从WIRE_TX/INPUT解帧，另处理padding，核对交付SHA和header值；从源acquire/retire按allocation id重建去重并集，补丁所有正常退出source_remaining为空。实际记录最大源并集376841B与推导相符，但不以达到该值作为证明。回环每次COPY核对源/目的不同id与容量之和，patch source=16393、destination=16384。

最终四组源码哈希与当前文件、二进制哈希逐项匹配，见audit。观测器标记allocation后才记acquire，申请至标记之间没有其他源申请；退休在allocator释放回调记录，晚于删除台账但早于System.dealloc。原指针尾端识别盲区仍存在于基线历史codec快照；补丁在offset0、len0且capacity非零的新块上立即登记，覆盖读前空buffer和Partial，不拿旧快照补齐证明。raw退休事件用固定栈缓冲和write(1)，避免allocator内递归格式化；固定观测表满会停止实验，不是生产政策。

全部104个有限测试尝试：87次code0、14次code101、3次code-9，含阶段验证/预期gate/工具失败，**不是104例全通过**。最大10ms采样RSS 4653056B、最长wall12.035秒，仅为观测。构建/metadata不算测试尝试；观测器本身固定表、锁、输出成本不计目标预算。

## 6. 失败原件、屏障与线端

1. `before-codec-140204-c2c92bb4`：边界输入构造把HPACK前缀少算1B，total<=22断言失败；header-alias的断言在allocator台账锁内panic导致12秒外部停止。前者修正输入到恰22帧，后者将布尔判定移到锁外再assert；两项是新工具错误，失败原件保留。
2. `before-codec-141557-369c8fb8/continuation-limit`与`after-codec-141637-c29dce71/continuation-limit` code-9，约10.3秒，stop字段null，符合CPU硬限停止而非runner wall标记；没有捕获信号原因字段，不能仅凭code-9严格断言所有kill均由CPU限引起。stdout尚无INPUT，说明尚未完成输入hex输出步骤。
3. `before-loop-141716-cbbfb08b/boundary`、`after-loop-141739-2729b002/boundary`均peer barrier timeout，完整可得推进时序保存在audit与stdout。基线第二次peer_command=34214us，peer_ping_written=2279001us，写PING时已超过2秒；失败时未见其driver收到PING/ACK。不能补造缺失时点，不能归咎协议或机器调度而不举证。
4. 新宿主原hex每字节format会产生大量临时分配，新增allocator记录让此成本放大。仅两组新宿主hex改为一次预分配编码，保持输入、断言、时限和语义补丁不变后重建，最终边界通过。它支持缩小到观测/输入准备成本的解释，不是严格probe-off因果基准；未将成功覆盖旧失败。
5. Windows通过WSL UNC读取标准库HTML失败Errno22，改用WSL本地只读路径及新目录成功；转录在audit/std-source-windows-failure.md。最初报告apply_patch格式无效未落盘。均不是协议证据。

04g旧三项plain small-64、plain mixed-64、pages pause-64的2秒超时仍为未关闭历史项。本轮没有重跑或关闭它们；04h未复现结论也不升格根因结论。新增boundary屏障失败以上述完整可得时序保留，不盲目加时限。

最终成功配对的客户端帧有序序列相同，保留SETTINGS `000100010000000200000000000400600000000600040000`、初始connection WINDOW_UPDATE `00ef0001`，stream=6291456、connection=15728640。回环继续使用Chrome136既有SETTINGS/pseudo/priority顺序。字节与本层控制语义保持不等于packet分段、时间、TLS/ALPN或完整Chrome136指纹等价；精确按帧read可能改变调度/系统调用频率，本轮没有证明这些等价。有限输入未跨后续WINDOW_UPDATE阈值。

## 7. 剩余义务与最小验收范围

建议只验收本补丁下的**单个串行接收codec源payload申请容量子界**及对应状态/引用证明，不能验收整个K1。尚需单列：

- 固定F/H在读期间不变。原公开setter可动态调整，补丁不提供任意中途增大F的兼容保证；生产要么证明配置生命周期固定，要么扩展状态迁移并重证，不能用assert当新拒绝政策。当前Chrome宿主设置在握手前建立，未更改公开admission。
- allocator可用块大小、碎片、保留页和OOM未闭合；Bytes控制块/元数据、独立HPACK输出及已有目的页另有责任。本轮不扩到K2–K4、TLS或解压审计。
- 部分header block在EOF对象仍存活时保留C，直到真实drop；session/retiring codec有效总数S未闭合，不能拿active数乘本界冒充全局预算。
- 逐帧allocation及copy_within可能降低吞吐，固定C可能使短Partial更贵。优化复用、lazy增长、多线程、更多错误排列、setter变化与资源失败均须保留同等不变量；不得将仅采样RSS或一次回环作为性能保证。
- 页聚合及时退源与受限adapter前提仍必要；公开Codec任意外部保留DATA不适用。页池完整窗口、全部正常流公正推进、flow阈值、完整wreq及设备仍未验证，不在此接入。

目前没有发现必须采用缩窗口、满池RST、禁H2或降低公开并发才能兑现这个局部源界的冲突，故未实施这些政策。若生产要求固定F/H之外的动态变化或消除本补丁复制成本，应另提交最小内部实现方案，不能由本报告默许改网络政策。

## 8. 封存规则与交付状态

`seal.py`在本报告最终正文完成之后运行，核对3029项保护、精确archive/vendor、项目lock版本/checksum、四文件语义差分和四个宿主二进制，再写新的不可覆盖seal。`delivery-*.json`最后只写一次，关联报告SHA与seal artifacts SHA，既不回写旧索引，也不在已封存报告追加补记。最终定位以E中delivery为准；任何不完整seal必须保留，不能冒称完整。

**结论：待总工程师验收codec子界。完整K1未关闭，r3/1C/G1未放行，不宣称全库内存有界，不接入生产wreq。**
