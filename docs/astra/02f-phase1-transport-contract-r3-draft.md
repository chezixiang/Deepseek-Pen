# Native Transport 分层预算契约 r3 草案

**DRAFT / NOT APPROVED / 未发布。** 日期：2026-10-03，Asia/Shanghai。

本文件是B方向的待审议草案，不具有规范效力；**现行规范仍为02d T1A.3-r2及其继承的02b**。总工程师已选择B设计方向，不等于批准本文件、数值、实现或容量结论。调查依据04e及其精确版本证据目录。本轮不改现有契约/实现/测试，用户手动转交。

**结论：待总工程师审批。1C仍阻断，G1未通过。** 不给现有binding写入r3标识，不新增r1/r2/r3运行开关，不以草案重新解释旧失败。

## 1. 按条款继承、替代和新增

下表仅描述“若将来逐项获批”的差异；未批准时所有现行条款继续有效。未列出的02d及其继承条款原样保留，不能笼统废弃r2。

| 现行条款 | 候选处置 | 草案编号 |
|---|---|---|
| 02d §1.1规范合并方式 | 保留引用合并结构；将来只对下面列明项建立优先级，不整份撤销02d | R3-I |
| 02d §1.2九个API、outcome/reason、隔离、五件套；02b §1、§2未被r2改动部分 | 全部继承；本草案不新增公共类型、错误码、探针或兼容分支 | R3-I |
| 02d §2 N/Q/X/C/D/R/T、统一丢弃、正常EOF候选、error/cancelled | 原样继承；A不替代N/C/D，资源退休不是C | R3-I、§3 |
| 02d §3全部闸门、最终检查到D线性化、唯一终态、admission/控制Promise | 原样继承 | R3-I |
| 02d §4.1–4.3 cancel/cancelAll/close顺序、generation、确认时点 | 原样继承 | R3-I |
| 02b §5背压规则1“Native已取得”起点；02d §4.4第一项对其计量引用 | **只替换投递payload计量起点为A**；库内取得不再混入该P数值，但须受新增U预算。所有A后层级/在途仍计量 | R3-A，需独立批准 |
| 02b §5、02d §1.2水位/错误码/恢复/terminal slot | 1/4MiB、128/512、低水位及64KiB输出上限原样保留；新增reservation联立不变量 | R3-Q |
| 02b §5 response headers 64KiB及§3.3 headers所有权 | 保留64KiB数值与安全所有权；新增明确的octet表示/阶段/重复项/解压删头前检查 | R3-H，需独立批准 |
| 02b §5“大块拆分” | 保留输出要求；额外规定单次ownership transfer≤64KiB、源余块归U，不能宣称原条款已限制库返回块 | R3-Q，需独立批准 |
| 02b §5 request聚合8MiB/请求体16MiB | 原数值保留；新增增量聚合、副本与待settle持有预算 | R3-B |
| 02b §3.3、§7.1–7.4；02d §4.4清理账目 | 继承线程/所有权，增补allocation唯一计量和token退休证据 | R3-O |
| 02b §5 terminal slot和32/64、8/16 admission | 每操作一slot及原admission数值保留；总存活与control池数量/退休规则为未决审批项，**不在本草案默认修改admission** | R3-C，需独立批准 |
| 02d §5–6、02b未被替代的M/G1义务 | 原矩阵与进入1C门槛保留；新增分层预算验收义务/证据层次/旧失败映射 | R3-V |
| 02d §7、02b §10等设备/生命周期未决 | 全部保留；不根据本轮源码调查关闭 | R3-I |

## 2. 独立审批单

不得通过一句“同意B”打包批准以下选择：

| 编号 | 请求批准的精确内容 | 目前状态 |
|---|---|---|
| R3-A | 1/4MiB的取得边界改为受限ownership transfer A；A前库body和adapter源余块必须有独立有限U | 建议批准语义方向，尚未批准；没有U不得宣称可实施完成 |
| R3-H | 64KiB计数按名称小写octets+原始值octets+每对4B；库规范化后、content decoder删头前、重复值不合并；JS表示另有预算 | 候选，需同栈拦截；与UTF-16/string.length、HPACK+32口径分别审议 |
| R3-Q | 单次转移最多65536B，每流最多一个outstanding源消费/余块；byte/event/allocation预留先于转移，流/全局原水位不变 | 建议值，不是现有wreq可强制的返回上限 |
| R3-C | 批准N_live/N_terminal/N_control/N_context/N_conn及退休/满池语义；是否影响原admission必须明确 | **未决，无默认数值**；32/96不能直接填terminal总数 |
| R3-U | 批准库内body/protocol/decoder/backing的有限表、有效并发与异常处理 | 部分子项已有源码界，其余未决；不得只批准6/15MiB后视为表完整 |

建议先批准A/H/Q的候选语义和限定同栈能力补齐范围，再以真实上界填写C/U。**不是建议先发布不完整规范或先实施再追认**。所有关键未决关闭且正式授权后，才可进入分层预算实现。

## 3. R3-I：r2语义原样保留

1. 任意end/error/cancelled一旦C，所有尚未D的headers/chunk无条件失效，含queue、局部批次、已post、已通过早期检查者；合法非终态仍须D<C。所有实际队列边界与最终入口仍过闸门。
2. 网络EOF仅候选；正常headers/chunk前缀全部D/R后才竞争C(end)，body必须完整，end.totalBytes与实际交付一致。EOF等待不重置deadline，不阻止cancel/error先C。
3. cancel/error不drain，C/数据抑制先于确认，不等待socket/driver退出；先提交者胜、outcome/reason/幂等不变。cancelAll保持context/generation，close按停接纳→C→generation→closed。唯一终态只投原接收者且不嵌套当前回调。
4. request唯一settle、openStream登记确认先于事件、丢弃不消耗可见seq、JS不可调用安全丢弃、Cookie epoch与context隔离不变。
5. S1/S2/S4仍为负向对照，M28为硬终止；宿主生命周期不作兜底。资源表不授权关闭/破坏已交付JS-owned值。

## 4. R3-A：明确取得与分层责任

建议文本：

> A(op,generation,range)是在已经取得适用的byte/event/allocation reservation后，将response body字节复制或转移到Transport受限自有存储，并原子提交ownership token的时点。A不是网络N，不是wreq poll返回，不是Q/post，也不是D。目的存储分配和复制不得先于所需预留。
>
> A至D或完成安全丢弃的全部payload为P，包含ingress、合并区、队列、bridge消息、局部变量、在途读取/转移的已形成持有物。跨阶段只转移归属，不退休credit。
>
> A前所有网络库body、协议解码、adapter源余块均须纳入独立U预算；某Bytes已经返回适配器但尚未A，也不能叫offered/rejected而不计。读动作必须在开始前有库内/源持有责任额度或受已证明的库固有上界保护。没有可证明源上界的bytes_stream不能自动成为合规受限源。

body以当前批准content decoding语义得到的二进制字节为P单位，按`(operation,generation,decoded-offset)`唯一计；不得文本解码后重编码或把压缩前/后offset混用。是否继续当前自动解压必须与R3-U一起批准；本草案默认**不实施任何编码行为改变**。同一内容复制两次在P只计一次，但A_backing按两个allocation计。

N到A的责任没有消失，只是从原1/4MiB移入必须证明的U。若未批准R3-A，现行r2仍从Native已取得起计，旧严格失败仍阻断。

## 5. R3-Q：转移、预留与恢复

| 资源 | 继承数值 | 新候选约束 |
|---|---:|---|
| stream P / global P | 1048576 / 4194304 B | `P_i+R_i<=1048576`；`sum(P_i)+R_global<=4194304` |
| stream E / global E | 128 / 512 | 实际非终态事件+reserved事件≤上限；headers占1槽、非空chunk占1槽 |
| 恢复 | stream严格<64事件且<524288B；global严格<256事件且<2097152B | 还须满足新的原子reservation可用；不得多流同时看到空额而超售 |
| 单chunk | ≤65536 B | 单次A转移也≤65536 B，这是额外候选义务，不是旧条款已包含 |
| outstanding source | 原规范无此数量 | 建议每流≤1个正在消费动作或保留余块；其完整backing受U额度，未释放不继续poll下一块 |

token含唯一id、op、captured generation和取消epoch；reserve在流/全局同时成功或全部失败。短转移可退还未用额度，但仅在确认无在途责任后。层间转移不得退额；D或实际安全丢弃恰一次退休。物理backing另行退休，C不等于可把所有在途额度立刻复用。

公平仲裁只在有credit时发起转移，不旁路prefetch；只用二进制单reader。wreq poll没有`n`参数，先poll出大块再切片**不能**证明源取得被65536限制；只可能在U已覆盖完整源块时证明A受限。

WAIT/Pending不是EOF；不为获知EOF在满P/U下启动可能取得未知body的poll。正常前缀可由D退额后继续读取直到EOF，错误/取消/原deadline需要独立有界控制推进。若实现需要额外EOF探测槽，槽的byte/backing和数量必须入R3-U，不设无预算豁免。

## 6. R3-H：headers表示单独审议

建议规则：

- 64KiB针对每次待发布最终response的普通header multimap，名称使用规范化小写ASCII字节，值使用解析所得原始octets；每一对按`name_octets + value_octets + 4`计数，重复值每对单计、不先逗号合并。不是JS UTF-16长度；不得用lossy UTF-8将不同原值计少。
- 检查位置在HTTP库规范化完成、wreq content-decoder删Content-Encoding/Content-Length之前；该原件用于限额，不要求新增公开原始头API。公开返回内容仍按批准的wreq/Transport表示，差异与表示临时副本计A/H预算。
- H2 pseudo headers作为协议元数据单列U，不加进普通公开header multimap；status/url等固定字段和字符串长度需单列控制预算，不能默认为无限。
- headers事件占一个E、不占body P，H的原始及JS表示/backing独立受限；校验超限按既有ERR_RESPONSE_TOO_LARGE，不许用只检查最后对象掩盖之前无限解析。
- informational headers、trailers、redirect中间头、CONNECT代理头均属于U_protocol，不因不产生公开headers事件而豁免。若要改变公开trailers/API，必须另批，本草案不增加字段。

04e已确认普通Response::headers无法提供上述删头前原件。最小实现前提是批准同栈拦截/计量能力；否则此项保持未决，不替换成“wreq给什么就按什么算”悄然合规。H2 profile的262144/+32不是此64KiB规则，减小SETTINGS会改变指纹，不能混同。

## 7. R3-U / R3-B / R3-O：预算表

每个预算项在正式批准时必须包含：数值/单位、逻辑或allocation表示、有效并发、代码版本/features/patch/target、共享归属、进入前约束、异常/取消退休判据及真实栈证据。**UNRESOLVED不是0、无限许可或默认通过。** 这里的“源码已证”仅为04e中局部量，不表示新实现已有通过预算。

| 项 | 目前可写的值 | 地位 / 正式发布前义务 |
|---|---|---|
| P_transfer/E_transfer | 1/4MiB，128/512 | 继承数值；A变更待批，需实现守恒证明 |
| transfer Q | 65536B，1 outstanding/stream | 建议值待批；不承诺库返回Bytes也受此界 |
| U_H2_DATA | 每流6291456B；每session合计15728640B；跨session用`sum min(15728640,n_s*6291456)` | 固定profile/未释放capacity的源码可证明子账；不能按流+session双加；n_s必须含尚持有的旧流 |
| U_H2_event / slab / backing | UNRESOLVED | 空DATA可增长，需同栈适配。禁止以窗口/满frame推数量。小帧聚合/对象cap及超限行为须批 |
| U_H2_receive_headers | HPACK表度量65536B；list阈值262144B；未完成编码块保守360448B | 源码逻辑子界；共享、临时Huffman/backing/发送HPACK/headers对象总额仍UNRESOLVED |
| U_H1_input / returned backing | 自适应策略上限417792B | 仅策略值，不是分配预算；总额UNRESOLVED，需限定read/backing能力 |
| U_TLS_record | 单backing申请≤16716B，扩容瞬时两块≤33432B / TLS层 | 局部已证，默认alignment；不是allocator实占或TLS总预算；握手/证书/session缓存UNRESOLVED |
| U_proxy_connect | response scratch 8192B / CONNECT future | 局部已证，N_connect待证；请求Vec/双TLS/SOCKS UNRESOLVED |
| U_decoder / U_staging | zstd默认window约128MiB是现状配置，不是建议budget | 四种decoder工作区、编码残块、解码输出backing总额UNRESOLVED；减window/禁编码须批 |
| A_transfer_bridge | UNRESOLVED | 建议精确目的存储，原子allocation预留；真实bridge复制次数、ABI对象大小、固定池cap/碎片界待证明，不写“4MiB物理上限” |
| B_request | 8MiB解码body/操作，16MiB请求body不变 | 单操作逻辑继承；32个仅在全部retained结果≤32时为256MiB；source+chunks+合并+JS副本重叠A_request UNRESOLVED |
| N_live / N_conn / N_client / N_context | UNRESOLVED | 不是32 active、不是64 queue、不是idle key cap；需包含retiring/idle/后台建连及context生命周期 |
| C_terminal / C_control | 每操作一个terminal slot不变；全局与control数值UNRESOLVED | 固定池字节数及满额语义须审议，不以32/96猜数 |
| J / K / overall M | 不并入P 1/4MiB | 另报范围/生命周期/平台限制；不承诺RSS等于P，不抹去用户态库body |

建议的最小实现结构而非新增数值：U_staging保留每流最多一个完整源块；目的分配先拿P/E/A额度；不用共享大backing的短view跨异步；共享buffer记录allocation id与引用者。若同一块同时由库和adapter持有，A只算一次，U/P按区间与阶段记录，不重复或遗漏。

request必须增量受限，不直接使用无界collect再检查。取消/错误使已持有聚合结果失效后，需完成恰一次释放；正常settle后的用户-owned结果继续有效。不把stream的4MiB误作为所有request聚合总额。

## 8. R3-C：control与存活数量不能暗改admission

必须给出以下最小决策：

1. operation从admission到数据/terminal/网络在途责任退休的全部阶段，哪个数量池承担它；C后仍持有的旧对象不能从所有池消失。active/queued原语义不自动改变。
2. 全局/每context最大retiring operations、未通知terminal、未settle control调用、存活context/client/连接的数值；为现有操作的cancel/close/error预留不依赖数据空额的执行能力。
3. 池满时新admission/控制调用的行为、FIFO、公平性、deadline和既有错误码映射。若要延迟释放admission、改变公开拒绝/等待语义或新增限制，必须逐项批准并更新M16/M19/M31，不以内部优化名义实施。
4. request已C(end)待settle body、用户回调仍在运行、旧generation outstanding token、后台connect与connection pool分别持有至各自退休点；一个terminal slot不保证这些资源同时释放。

本草案**不推荐随意填96个terminal或512个control**：没有退休与调用并发约束，任何这类数值都可能失真。最小阻塞是先选择生命周期/入口政策；不是要求审计整个Tokio runtime内存。

## 9. 待批准行为变化

| 可能需要的变更 | 审批边界 |
|---|---|
| http2内部空帧消除、小帧聚合、受限backing/headers拦截 | 同栈内部适配也需授权；保留END_STREAM/错误/共享流语义及TLS/H2 profile，新增静态+真实宿主证据 |
| H2 windows/SETTINGS/HPACK策略、禁H2或换TLS/HTTP库 | 指纹/栈变更，未授权；不能为贴合1/4MiB偷偷调整 |
| 降解压window、禁编码、修改Accept-Encoding或返回解码语义 | 接收能力/网络行为变更，需明确值与超限错误；不默认允许 |
| 减并发、限制context/authority、连接池/PSK驱逐策略 | admission/复用行为变更，需有效并发及稳定性/指纹差分；原32/64、8/16暂不变 |
| 公共API/控制确认语义、新错误码、公开探针 | 接口变更另批；当前草案仍九API |
| 内部重试、redirect映射 | 不能直接照搬业务builder的10跳与wreq默认重试；Transport继续继承5跳及无自动重试要求，具体target-stack映射需证据 |

## 10. R3-V：旧失败不改判，新验收不串层

| 历史项 | 原结论保留 | 新版本必须另证 |
|---|---|---|
| 04b accounting-large | backlog漏计历史FAIL | 所有A后局部/队列/在途守恒 |
| 04c strict-windows/wsl-acquisition | r2严格入口FAIL，1114112>1048576，code=2；不改断言 | R3-A批准后追踪为“规范边界变更，旧失败不消除”；新受限transfer前credit + A前U总预算 |
| 04c accepted专项 | 已接纳范围54/54，不是容量总通过 | offered/rejected也有U归属，无事后切片逃逸 |
| 04d Node真实网络/受控Readable | 保留版本/实验结论，无wreq证明效力 | 精确wreq宿主独立证明driver、TLS/H2、解压和共享allocation |
| 02e/05历史闸门与正常完整性反例 | 保留原件；新预算不覆盖其义务 | 02d M01–M34及两轮三路径三入口、WQ/WX/WG继续是门槛 |

新增验收ID只作草案，不标PASS：

| ID | 义务 | 证据层 |
|---|---|---|
| LB-A | A前reserve、流/全局原子竞争、allocation先申请、旧1114112负对照、单源余块 | Node模型机制 + 真实wreq映射 |
| LB-Q | 1/4MiB及128/512含reservation，严格低水位/公平性、64KiB transfer、不以WAIT充EOF | Node模型 + 真实wreq完整性 |
| LB-U1 | H2空DATA、1B小帧、固定窗口共享竞争、cancel一流时兄弟流仍在途 | 真实wreq宿主；Node不承担另一库内部证明 |
| LB-U2 | H1 read-ahead/backing、TLS record与握手、CONNECT成功/延迟/失败、SOCKS、4种解压window/余块 | 真实wreq源码上界 + 宿主适配验证 |
| LB-H | 重复头、原始octets/JS表示、decoder删头前检查、HPACK/Huffman/CONTINUATION、trailers | 模型测表示 + 真实wreq内部 |
| LB-O | alias allocation唯一归属、复制重叠预算、request增量8MiB/待settle、D后所有权 | 模型 + 宿主；真实桥在设备复证 |
| LB-C | control池耗尽下C/唯一terminal仍可推进，retiring不无限增长，EOF/deadline/取消token恰退役 | 模型确定性调度 + 宿主多线程 + 设备 |
| LB-F | 精确版本/features/patch/target及TLS/ALPN/H2设置/压缩/复用行为差分，无未批准变更 | 真实wreq宿主与设备分表 |

Node模型只证明其接口和状态机，不强迫它证明BoringSSL/http2/zstd内部内存；它的模拟预算参数必须标为假设。宿主必须提供上界证明与运行前提核验，不用RSS或采样最大值填硬预算。设备证据必须来自另行授权的真实构建/安装/线程桥与M20/M21/M28，不能由宿主结果继承。

## 11. 最小实施门与停止条件

审批顺序：独立批准A/H/Q及同栈能力工作范围 -> 关闭04e K1–K4并批准完整C/U数值/并发/异常行为 -> 授权实现及新测试 -> 三层分表证据、02d §6与LB项验收 -> 总工程师决定是否恢复1C。设备阶段仍需单独授权，不能以本文件预授。

任一以下条件成立即保持停止：无法限制空DATA事件/小帧backing；源返回/解压工作区无法提供有限上界；缺有效存活数量；headers位置/表示尚未批准；只能靠改profile、降低并发或改公共行为才装得下却未授权；取消先C或正常完整性被破坏；只能提供Node/RSS/采样证据。

**当前：K1–K4未关闭，预算表有UNRESOLVED，不能进入分层预算正式实现，更不能发布r3、将旧FAIL改判、解封1C或宣布G1通过。结论为待总工程师审批。**
