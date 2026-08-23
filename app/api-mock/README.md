# api-mock 浏览器/模拟器桩

aiot-vue-cli 在 web/simulator 构建时会把本目录下每个 `*.js` 注册为**同名虚拟模块**
（文件名开头的 `$jsapi.` 映射为 `$jsapi/`）；设备打包（`-p`）时本目录不参与，
import 交给设备运行时解析真实原生模块。因此同一份代码两端通用。

## 已提供

| 文件 | mock 的模块 | 说明 |
|---|---|---|
| `langningchen.js` | `langningchen` | 社区原生扩展五模块（AI/IME/ScanInput/Shell/Update），AI 含模拟流式输出 |
| `fs.js` | `fs` | 内存文件系统 |
| `storage.js` | `storage` | 内存 KV 存储 |
| `sqlite3.js` | `sqlite3` | 极简 SQL 子集（CREATE/INSERT/SELECT *） |
| `crypto.js` | `crypto` | md5（简单实现，非安全场景） |
| `zip.js` | `zip` | extractall 空实现 |
| `am.js` | `am` | 应用栈管理 |
| `pm.js` | `pm` | 包管理（内存应用表） |
| `updater.js` | `updater` | 恒返回"已是最新" |
| `$jsapi.storage.js` | `$jsapi/storage` | 框架 jsapi storage |
| `$jsapi.http.js` | `$jsapi/http` | 浏览器 fetch 兜底 |

类型声明见 `@dictpen/types` 的 `system.d.ts` / `langningchen.d.ts`。

## 真实性边界

mock 只保证**签名与交互流程正确**，便于纯前端开发调试；返回数据均为模拟值，
涉及真实文件/数据库/硬件的行为以设备为准。
