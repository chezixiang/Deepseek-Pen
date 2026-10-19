# astra：Native Transport 重构记录

本目录归档「路线 C」Native Transport 重构的阶段 0 至 1C 文档：接口契约、修订记录、
实现与验收报告。文件按编号顺序阅读；同一阶段的修订版（`-r1` / `-r2`）取代前一版，
但旧版保留，用于追溯修订原因。

## 文档

| 文件 | 内容 |
|---|---|
| `01-phase0-p4c.md` | 阶段 0 · P4c 验证（设备重启自动加载 / 宿主销毁后的晚到回调） |
| `02-phase1-transport-contract.md` | 阶段 1A：Native Transport 接口契约与验收矩阵 |
| `02b-phase1-transport-contract-r1.md` | 1A-r1 修订版契约 |
| `02c-phase1-r1-revision-record.md` | 1A-r1 修订记录 |
| `02d-phase1-transport-contract-r2.md` | 1A-r2 终态与排队投递契约（**现行规范**） |
| `02e-phase1-r2-revision-record.md` | 1A-r2 修订记录 |
| `02f-phase1-transport-contract-r3-draft.md` | 分层预算契约 r3（**草案，未批准**） |
| `03-phase1b-prep.md` | 阶段 1B-0：可重放 mock / fixture / 宿主生命周期模拟 |
| `04-phase1b-impl.md` | 阶段 1B-ii 实现报告（M01–M31） |
| `04b` – `04k` | 1B 修复、容量边界审查、路线 C K1（接收侧有界性）系列 |
| `04l` – `04p` | 路线 C K2（解压与源交接、信用生命周期、取消唤醒）系列 |
| `05-phase1c-device-port.md` | 阶段 1C：真机移植记录（**STOPPED**，停于移植前一致性门） |

## 证据根

各报告引用的证据根位于 `docs/astra/evidence/<id>-<date>-<hash>/`。该目录约 3.9 GB，
含 vendor 源码快照、编译二进制、tar 包与原始抓取，**不入库**（见根 `.gitignore`），
只在本机保留。因此报告中的证据链接在克隆出的仓库里无法解析，属于预期行为；
需要复核时以本机证据根和报告内的 SHA-256 清单为准。

## 当前边界

- 02d 为现行契约；02f 仍为草案，未批准。
- K1 的元数据子界已闭合；K2 的取消唤醒已闭合；M1（批准 K1 聚合分片语义）未裁定。
- 1C 停在移植前一致性核查，未进入交叉编译、打包、安装与真机断言。
