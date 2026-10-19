# 路线 C K1：接收元数据子界与最终收口

日期：2026-10-03，Asia/Shanghai。工作区：`G:\youdao\Deepseek`。

**建议：固定范围内 K1 条件关闭，限纳入本轮明确列出的最小内部清理调整后的隔离原型。结论为待总工程师最终裁定 K1 状态。** 原 04j 结构发现可重复的零 DATA Headers 孤儿节点，不能直接宣称原库闭包成立。调整只在新目录验证，没有替换生产库。02d 仍有效、02f 仍草案；未放行 r3/1C/G1，不宣布生产总预算通过。

## 1. 输入、范围与实现边界

独立证据根 E：`docs/astra/evidence/h2-k1-metadata-20261003-b7e409/`。本轮仅新增 E 和本报告，既有原实现、原型、报告、契约、缓存与证据只读。未升级依赖、接生产、操作设备、提交 Git、使用子 Agent、创建或联系其他会话。结果由用户手动转交。

核验 04j `delivery-23f51953.json` 的报告 SHA `8e371046…affad` 和 `seal-47dfc7d0/artifacts.json` SHA `434ea187…addbb`，并核对 3069 项相关封存输入；保护清单另含 delivery、契约、lock 等。没有递归审计无关业务树。详见 E/audit/input-verification.json、protected.json。

适用条件为客户端 Chrome136 profile：F=16384、H=262144，首次读取前配置完毕、读取期间不变，push=false、固定 Ws=6291456/Wc=15728640、无 adaptive/custom 窗口增长，使用 04j 受限 Adapter，无队列未 pop 就提前归还信用，无用户网络页别名逃逸。动态 setter 迁移不在范围；旧 setter-growth code101 仍是范围外兼容缺口。**本补丁不能作为通用 http2 替换库发布。**

精确版本继承 04j：http2 0.4.21、hyper2 1.5.5、bytes 1.11.1、slab 0.4.12、http 1.4.1、tokio 1.52.3、tokio-util 0.7.18；依赖与 lock 不升级。所有构建使用 E 内 vendor/cargo-home/target，离线。WSL Ubuntu，rustc 1.97.1 `(8bab26f4f68e0e26f0bb7960be334d5b520ea452)`、LLVM22.1.6、`x86_64-unknown-linux-gnu`、dev，Tokio current-thread。

实际网络层级仍为 TCP 明文 H2 peer → 真实 http2 client driver → bounded codec/页 → hyper2 原 Incoming poll_frame → Adapter。沿用实验 `k1_from_recv`，不是 hyper2 完整 dispatcher/wreq/TLS/解压/QuickJS/ABI/设备。未扩展 HeaderMap 内容、连接池或全部 allocator 审计。

## 2. 先证原结构，再做最小调整

原版 `recv.rs::release_closed_capacity` 在 `ref_count=0 && in_flight_recv_data=0` 时直接返回。`ResponseFuture` 只含 OpaqueStreamRef，不像 RecvStream::drop 会 clear_recv_buffer；`Stream::is_released` 不检查 pending_recv，Store::Ptr::remove 只删 Stream，Deque 只有索引，**不会自动删共享 Buffer 的槽**。

有限复现 `orphan-160059-1314dd6f/metadata-orphan`：A 收到合法 HEADERS END_STREAM 后不 poll response，释放全部 A 句柄；B 保持在途；再合法创建/退休六轮。7 个无 DATA 响应留下 7 个不可访问 Headers，Slab capacity 4→8，B 入队时到16；B 仍完整交付 `B-survives`。最后 stream 引用消失时 Slab live=7，直至 session 销毁才释放。网络进程 code0 是**成功复现缺陷**；独立 retirement 断言 code1 是预期红灯，不能计为退休通过。

因此原结构的正确式子必须额外含 `O_s(t)`：累计遗失在共享 Slab 的节点数，`live <= N_queue+2L+O_s`。O 随 session 请求轮次增长，不能用当前 L 或历史同时持有峰值替代，更不能假装这些 Stream 仍由 K4 正常持有。原结构的请求 churn 不是高水位复用。

唯一语义调整：在上述零 in-flight 早退分支加已有 `self.clear_recv_buffer(stream)`，随后仍 return。非零分支、窗口归还、状态机、帧接收、错误/reset、API 不变。不加 cap、拒收、RST、admission 或任意阈值。此时最后一个引用已经消失，剩余响应对调用者不可访问；调整只是提前 drop 不可访问的 HeaderMap/Response。仍有引用、已 closed 但未释放的流不触发此清理。语义审查见 E/audit/investigation.md。

调整前后源码哈希及重建原件保存在 E/audit/baseline-source；原二进制哈希在原运行目录，旧 executable 因同一新 target 内增量重建未另外保留，不声称仍有其文件。最终差分由封存 isolated.patch 给出。下文无 O 的式子只适用于此调整原型；若不接受该调整，具体阻塞就是 O 的无界累计，而不是“还需更多测试”。

## 3. 全部实际入队分支

以下路径相对 E/codec-http2；核对 recv/state/buffer、streams 路由、stream/counts/store/share/client 的退休调用链。共享 Event 枚举只有 Headers、Data、Trailers。

| 分支 | 同时节点结论与原因 |
|---|---|
| recv_headers → Headers | `state.recv_open` 只从 AwaitingHeaders/对应 reserved 初态接受最终响应；非信息性头成功后进入 Streaming 或 recv-closed。后续 HEADERS 路由到 trailers，不会再次 enqueue 最终 Headers。每个本地请求流最多1个 |
| 信息性 headers | `pseudo.is_informational()` 为真不入队；非 END_STREAM 留 AwaitingHeaders，可来多轮而无累计 Event。非法终止/状态只会更早关闭，不额外增加节点。HPACK/header 内容及临时分配仍归 K3，不是免费 |
| recv_data → Data | 校验、flow、END_STREAM 转移在前；零 payload 不入队。非空先追加尚未发布的队尾 Data 页，满后 acquire 新页；一个流队列 DATA 前段均满、至多尾页不满。页面一经 pop/publish 不再追加。故 `d_i=ceil(q_i/p)`，q_i=实际排队非空 DATA 字节，p=16384 |
| recv_trailers → Trailers | streams 路由先要求 END_STREAM；recv_close 成功才入队，之后无法再次 recv_close。content-length 错误在入队前返回。每流最多1个，与最终 Headers 和所有尚未读取 DATA 可以同时存在 |
| recv_push_promise → Headers(Server(req)) | 是第四个新增 Event 的路径，不能漏。固定 profile 的 `ensure_can_reserve` 在 push=false 时拒绝走 reserve/enqueue，因此本域贡献0。若放开 push，一个 promised 流可能同时有 promise 请求头+最终响应头+trailers，需改为3且纳入有效流/内容责任；本结论不支持该范围 |
| poll_data → push_front | pop 非 Data（正常为 Trailers）后原值放回；有一个刚刚产生的 vacant 槽，当前锁内无并行 insert，因此恢复原 live，无新增峰值、无 reserve |
| poll_trailers → push_front | pop 非 Trailers（可为 Data；误用时也可能 Headers）再放回，理由同上，不凭注释“是 trailer”忽略其它 variant |
| reset/error/EOF/GOAWAY | 通过 State::Cause/通知记录，不是 Event；新增数0。已入队内容未必立即删除，可先被 poll 返回。必须继续计到 clear/pop 或 session drop，不能以 closed/reset 当退休 |
| clear_recv_buffer / 最后引用 | 每次 remove 返回值后 drop，一一退页/头内容；调整后零 DATA 队列也清除。closed 但 ResponseFuture/RecvStream/SendStream/FlowControl 等仍持有的流仍属 L；reset 队列/retiring 保留的对象也不能凭 active 数排除 |

固定 profile 每个有效持有流最大 `d_i+1+1=d_i+2`，其他 Event 为0。队列中 Headers/trailers 的值移出时，局部栈临时与槽 backing 可以短暂并存，但不是第二个堆节点；头内容所有权转移仍交 K3。Frame/HPACK 正在解码但未入队的对象也不偷算作零成本，它们属于已有 codec 源/K3责任。

## 4. 条件容量证明与历史高水位

K4 必须提供每个 session 的整个存活区间上的 `L_s(u)`：有效持有流数，包括 closed、cancelled、retiring 和持有页的流；不是并发协议 active 计数。下式不要求 K4 本轮给生产数值，但要求其最终提供该时间包络及 live/retiring session 集合。

令 `q_i` 为排队字节，未 pop 不提前 release，固定窗口下 `q_i<=Ws`、`sum q_i<=Q=min(Wc,L*Ws)`。继承04j：

```text
p = 16384; Ws/p = 384
Nq(L) = min(384*L, floor((min(Wc,L*Ws)+L*(p-1))/p))
N_queue(t) <= Nq(L(t))
n_s(t) = Slab live <= N_queue(t)+2*L_s(t)
M_s(t) = sup{ Nq(L_s(u))+2*L_s(u) : session出生 <= u <= t }
```

若有更精确历史实际 live 高水位 m_s，可用 m_s<=M_s；不得把 M_s 改成当前 L 对应值。多轮清空不缩容、连接空闲但未销毁也保留历史责任。初始无流 M=0 才得到零槽。

slab 0.4.12 的 insert_at：有 vacancy 时复用，只有 `key==entries.len()` 时 Vec::push；try_remove 将 Occupied 原地换为 Vacant(next)，不截短 entries。可归纳 `entries.len = 历史最大同时 live`：只在没有 vacancy 时增加。Buffer 没有 reserve/shrink 路径，且 pop+push_front 复用刚释放的槽。

不是依据一次 capacity 采样：E/audit/toolchain 保存**已安装相同工具链** HTML 源的哈希与结构化提取。RawVec::grow_amortized 在 push-one 时用 max(2*cap,len+1,MIN_NON_ZERO_CAP)，240B元素的 MIN=4；Global 的返回切片长度为请求 new_size，RawVec 记录请求 cap，不把 malloc usable-size 变成容量。由此本工具链：

```text
G(0)=0; G(M>0)=max(4,next_power_of_two(M))
C_s(t) <= G(M_s(t))
常驻 Slab backing <= 240*G(M_s)
R(0)=0; R(4)=4; R(C>=8)=C+C/2
增长时旧新请求 allocation 的保守和 <= 240*R(G(M_s))
```

System.realloc 可能原地，也可能搬迁；不以回调返回后只剩新 id 排除旧新重叠。每次增长只有该 Slab 的旧块和新块，历史旧块不累加；一次操作无并发内部 Slab growth。上式是 allocation 请求布局预算，不是 libc 内部工作区、碎片、保留 arena、RSS 或 OOM 成功承诺。算术需 checked、Layout 可表示且分配成功；不把 overflow/OOM 当批准的新拒收策略。其它 rustc/target/allocator、额外 reserve 调用需重推。

## 5. 页、控制对象与去重

精确布局来自最终同源码 `layout-161210-3a317743` 的 `cargo rustc -p http2 -- -Zprint-type-sizes`（仅布局诊断设置 RUSTC_BOOTSTRAP=1，未安装/升级工具链），并与正常构建的 size/align 和实际 GlobalAlloc 请求交叉核对。布局构建不替换已测试宿主 binary；封存重核 binary SHA。

| 对象 | size / align（字节） | 分配与归属 |
|---|---:|---|
| Event / PollMessage | 224 / 8 | 内嵌在 Slot，不单独 Box；HeaderMap动态 backing 不在此 size 内 |
| Slot<Event> / Slab Entry<Slot<Event>> | 240 / 8，各自 | 此 target 利用 enum 布局，Entry 与 Slot 同大小，不额外加 usize/tag；实际请求960/1920与4/8槽吻合 |
| Buffer/Slab对象 | 40 / 8 | 内嵌 Recv，是包围对象的字段，不在240C中，但不能再当独立 allocation；K4核算包围对象时包含 |
| 每流 Deque | 24 / 8 | 内嵌 Stream，与共享槽分开；若K4已计 Stream，不再加24L |
| Page | 48 / 8 | queue时内嵌 Event；publish后从槽移入 Owned<Page>，没有 Box<Page> |
| Bytes owner `Owned<Page>` | 56 / 8 | bytes::from_owner 的 Box，8B atomic +内嵌48B Page。每个发布页一次，不另加48；Bytes clone只改refcount |
| Bytes / BytesMut句柄 | 32 / 8 | 栈/Adapter/协议对象字段，不每clone堆分配。受限Adapter不外泄其网络页Bytes |
| Pool/Arc句柄；Weak句柄 | 各8 / 8 | Pool clone不分配新ArcInner；Page和Recv中的句柄已内嵌 |
| State / Mutex<State> / ArcInner | 80/8、88/8、104/8 | 只有一个104B池 allocation；State含free Vec的24B头，不再加80/88 |
| free Vec元素 Box<[u8]> | 16 / 8 | fat pointer向量，一次 `with_capacity(P_s)` 请求16P_s；不是16KiB payload |
| 每页payload Box<[u8]> | 16384 / 1 | acquire无free时申请；归free不是物理释放。最后pool strong消失才drop全部free页 |

定义 `h_owner` 为实际已分配且尚未释放的 Owned<Page> 数，`S_s` 为K4/Adapter提供的源槽界。真实顺序为先预留源槽再poll，Page publish后计held；最后Bytes引用drop调用Page::drop，然后owner Box实际释放，再退source credit。所以即使Page::drop先减held，不能用瞬时held代替owner；可用 `h_owner<=source_credit<=S_s`，每流至多一个，实验全局2槽。用户独立输出 J 不钉页，不代表 J 免费。

池 `allocated=queue+held+free`（短暂页预留/返回阶段按物理owner核算），没有free页时才申请；只有live减少才push free。若整个session选择固定 `P_s >= sup_u(Nq(L_s(u))+min(L_s(u),S_s(u)))`，既有有限页池不耗尽且 `allocated<=P_s`、free.len<=P_s。free向量预分配P_s，从不增长，故无其realloc旧新项。P_s是派生条件参数，不是本轮新设任意生产cap；现有770只是实验算例，不支持原型外随意env配置，不通过满池exit73伪造容量成功。

生产结构的Pool在最后strong释放时销毁State/free/payload，Arc控制块在最后weak释放才销毁。本原型额外 POOLS 注册表持 Weak，snapshot prune后才释放104B控制块；weak不延长State/payload。未snapshot时 dead weak 可随累计session增长，明确是**探针责任**而不是生产池泄漏或生产预算常量。

## 6. K1条件预算总表

所有项先按同一时刻、真实 allocation 身份去重。表内源/页/Slab/owner都是不同allocation，可形成保守总和；各自独立峰值之和仅为上包络，不宣称可同时达到。

| 域 | 条件预算 | 重叠/不可机械相加 |
|---|---|---|
| codec 源payload（继承04j） | `T+C=16393+360448=376841`，每串行接收codec | frame/read/DATA/HPACK输入同id只计一次；无Partial的DATA阶段只有T；不能另加每帧Bytes长度 |
| codec源的Bytes共享控制（源码补充） | 保守每源backing至多40B，共≤80B | bytes::Shared=三个机器字24B；BytesMut::Shared=Vec+usize+atomic共40B。源表示唯一/共享转换只创建一个控制块，freeze复用共享表示；本组合不保留源别名。至多T/C两块，不能再加一份按Bytes句柄计算的owner。HPACK独立字符串控制归K3 |
| 页payload | `p*A_s(t)<=p*P_s` | queue/held/U/free的并集，U已经是其中held；J/目的独立copy是另一域 |
| recv共享Slab | 常驻`240G(M_s)`；含增长`240R(G(M_s))` | 覆盖Headers/Data/Trailers所有内嵌值；不是再加224n、48N_queue、HeaderMap结构体 |
| published页owner | `56*h_owner<=56*S_s` | 已含Page及Arc句柄；不再加48h、8h；同页Bytes clones只一块 |
| Pool控制及free索引 | `104+16P_s` | State/Mutex/Vec头在104中；Weak观察者延迟退休单列；payload不在16P里 |
| 包围对象内嵌字段 | Buffer40、Recv内Pool8、每流Deque24、Adapter Bytes字段32等布局事实 | 归K4包围对象预算。不能把字段size当独立请求allocation加一次，再把整个Stream/session/Adapter加一次 |
| 独立目的/用户输出 | 继承04j目的信用与J生命周期公式 | 与源页复制时真实重叠，不能内容相同就去重；不混入本轮元数据常量，不以D后退信用当物理释放 |
| K3内容/工作区 | `K3_HeaderOwned_s(t)`、`K3_HpackWorkspace_s(t)` 等非零具名外参 | Headers/trailers节点数已闭合，但内容、表、Huffman、临时/持有HeaderMap仍需K3；不能用H=262144冒充这些总allocation界 |

对live及retiring池/session按真实身份求和，本轮元数据的局部请求容量上包络为：

```text
Meta_s <= 240*R(G(M_s)) + 56*S_s + 104 + 16*P_s
K1_source_page_metadata_s <= 376841 + 80 + 16384*P_s + Meta_s
```

若只问当前实际台账，Slab使用当前C和当次增长旧C、页用A、owner用h_owner，比包络紧。若pool-only retiring与session集合重叠只能算一次；多个session同时增长必须在各自项内计旧新，不用单session数值代全局。上式不含K2/K3/K4包围对象、目的/J及allocator额外成本，**不是生产总预算**。

纯算例：假定**整个session**始终L<=2、源槽S=2，则Nq=768、P=770、M=772、G=1024。Slab常驻245760B，增长旧新368640B；free12320B、Pool104B、owner112B；Meta常驻258296B、增长包络381176B。页12615680B；加源payload及源控制80B，局部上包络为**13373777B**。没有灌满该数量，不能把本轮实测6节点/8槽当此算例验证，也不能把本轮曾4个并持请求的场景套入L<=2。

K2必须提供HTTP1/解压输入输出单块、workspace及其与上游持有物的生命周期边界；本轮不得把K2填0或把解压前后页重复当同一allocation。K3必须提供头内容、动态表、Huffman/临时字符串、交给上层后保留物的物理容量与别名模型。K4必须提供session/live/retiring集合、整个session历史L包络、source槽及包围控制对象/输出持有数量、退休及异常满额政策。没有生产数值不妨碍本局部公式，但阻止把公式变成生产总额。

## 7. 有限验证、独立核对与证据分层

预设 E/audit/resource-plan.json：每进程session1，最多4个同时请求句柄、6轮、16请求；DATA<=262144B、双向H2<=524288B/256帧，网络尝试<=16；case8秒、屏障2秒、外wall12秒、CPU10秒、AS512MiB、RSS每10ms采样超128MiB停止；每stdout/stderr16MiB，匿名tmpfs最多32MiB；构建wall300秒。实际共6个网络进程，无无界灌入、无延长期限。固定源码后串行运行，原反例与最终版各自freeze；最终组内未修改Rust源码。

最终构建 `build-160638-62ff94a9` code0；`closure-160909-8dbd014e` 五进程code0；`unit-161028-b36c31a5` 2/2；工具链/依赖图 `metadata-161120-901f7b32`；布局构建如上code0。正常宿主二进制及源码关系在final freeze/binary.json；所有结果目录新建不覆盖。

宿主沿用的CONFIG行与K1_LIVE_STREAMS=2是初始A/B及源槽场景标签，不是对后续轮次的动态测量；本轮请求创建源码、WIRE及预定计划明确记录后续最多4个并持请求。没有据该旧标签把4流场景冒称2流压力证据。

| 已测机制 | 结果 |
|---|---|
| metadata-rounds | 与原反例相同7个不poll零DATA响应，每轮恢复Slab live0；B完整10B，Slab峰live2/cap4，retirement独立断言转绿 |
| metadata-combined | 两轮103不入队，最终headers仍排队时输入16383+2+16384B DATA，再trailer END_STREAM；同时h2/d3/t1。poll_trailers先pop Data再push_front；A交16384B后取消、余16385B页和trailer退休，B在途并最终交10B |
| metadata-highwater | 相同输入A完整32769B，实际经过Data和Trailers两条push_front；后续合法2/4/2个并持请求三轮退休，最终live0而cap仍8；session drop才释放1920B Slab |
| error / reset-eof | 继承04j真实hyper2 INTERNAL_ERROR→Err、CANCEL→EOF映射；A25B、B15B分别与wire完整核对，最终队列/页/owner退净，无新Event错误节点 |

E/check.py 不导入宿主/旧checker，解析实际WIRE_TX frame字节和WIRE_RX，独立拼出输入、比对META_DELIVERY/ADAPTER_RESULT，检查所有Page租期、标记allocation acquire/retire、push_front不增capacity、组合h/d/t节点、空后容量保留与源码/binary哈希。5例共41组屏障，逐组保留并核对 `host_enqueue → peer_command → peer_ping_written → driver ping_received → peer_ack_read → host_ack_resumed` 的同一单调时钟。

最大单例DATA32779B、双向H2 33529B；帧数最大52。该计数另加peer初始化固定发送但未进入WIRE_TX的两个空SETTINGS/ACK，共18B/2帧；client24B preface不是H2帧，另有24B传输责任，仍远低于上限。最大采样RSS4620288B，最长网络wall1.953秒，均只是本宿主观测，不是目标界。union台账包含本轮新增pool/free/owner与既有页/Slab/目的/HPACK标记，**仍不是进程总内存**；未将realloc内部旧新重叠伪装为采样可见。

源码证明而非压力实测：所有状态机入队分支、push禁用、任意轮数归纳、整个session历史G/R增长式、free向量不增长、两块codec源共享控制上界、非当前L退休计账。窗口源界及一次后续WINDOW_UPDATE为已接受04j证据，本轮没有重新灌2MiB。

未覆盖：真机/ARM、其它target/release布局、完整6/15MiB压力、后续connection WINDOW_UPDATE、完整hyper2 dispatcher/wreq、TLS、解压、实际Transport C/D/generation及JS、K3内容、K4连接池/调度公平性、全部allocator成本。没有将明确未覆盖范围填零。

失败账：原结构retirement断言失败是保留的红灯；第一次checker把空SETTINGS body字段当缺字段，KeyError，未完整checks目录保留，修正空字符串解析后完整重建。PowerShell glob/WSL PATH引号失败只属命令准备；WSL systemd user-session警告、已有lifetime/unused-mut、DrvFS hard-link回退原样保留。新网络例没有超时，不改判04g三项旧2秒超时、04j两项8秒阈值失败、setter-growth或hold负例，也不扩大范围去“关闭”它们。

最终符号索引审计首次把 `pub(super) fn clear_recv_buffer` 写成 `pub fn`，因此匹配断言失败；修正后Windows默认GBK读取工具链源发生解码错误，以 `python -X utf8` 重跑成功，不涉及被测源码或测试判定变更。

## 8. 探针与退休边界

探针结构必须与生产容量拆开：Tracking LEDGER静态Mutex786448B，SEEN/CODEC/OWNED三表各32776B，合计884776B，另有clock、CAP、POOLS静态头、日志/宿主输入输出/采样列表等。其固定记录上限只是实验停止条件，不是生产对象cap。`POOLS: Vec<Weak<_>>` 每元素8B，Vec按其自身历史注册数量增长且retain不缩容；本轮单session典型预留4项32B，不得推广为长期生产32B。它可能令dead Arc104B延迟到snapshot，不能把观察者制造的延迟算成生产Page退休缺陷。

原型Page上的id/stream/held、State上计数器也参与本次真实layout，未另行假造“去探针后更小”数字。最终每例明确看到Slab/页payload/free向量/Bytes owner全部dealloc；Pool State在最后strong时退，注册表weak在末次snapshot剪除后Arc dealloc。J在driver drop后仍有效，随后独立释放。归free、clear queue、drop driver、drop user四个时点没有混成一个。

## 9. 最终建议与封存

**建议固定范围内 K1 条件关闭**：04j已接受的固定源/页/Adapter机制，加本轮“最后引用零DATA队列清理”的最小原型调整、完整Event计数、历史Slab增长及页控制元数据公式，形成可审计的局部条件闭包。不接受该调整时，具体阻塞为原结构累计孤儿Headers，不能直接验收04j原实现。此建议不授权生产合并或通用库发布，也不把K2/K3/K4变成已完成。

正文完成后运行E/seal.py，重新核对相关保护输入、最终source freeze/binary、独立检查，写全新seal目录及artifacts/isolated.patch。随后**最后另写一次delivery**，记录最终报告SHA、seal清单SHA和结果位置，不回写索引或报告。最终以该delivery为交付入口。

**结论：待总工程师最终裁定 K1 状态。02d有效，02f仍草案，r3/1C/G1未放行，生产总预算未通过。**
