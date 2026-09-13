# 修复 302 重定向问题

## 问题描述

即使配置文件完全正常，设备没有风控，运行 `./ds-free-api` 时依然会返回 302 错误并中止服务：

```
[root@YoudaoDictionaryPen-678:/userdisk/ds-free-api]# ./ds-free-api
Error: provider error: HTTP status 302: <html>
<head><title>302 Found</title></head>
<body>
<center><h1>302 Found</h1></center>
<hr><center>TLB</center>
</body>
</html>

[root@YoudaoDictionaryPen-678:/userdisk/ds-free-api]#
```

## 根本原因

DeepSeek 的 API 端点在某些情况下会返回 302 重定向响应（由 TLB/负载均衡器返回），但 `rquest` HTTP 客户端**默认不自动跟随重定向**。

当客户端收到 302 响应时：
1. `rquest` 返回 302 状态码和重定向页面的 HTML 内容
2. `client.rs` 中的 `status.is_success()` 检查失败（302 不是 2xx）
3. 程序将 302 作为错误抛出，导致服务启动失败

根本问题：**HTTP 客户端缺少重定向策略配置**。

## 解决方案

在 `src/ds_core/client.rs` 的 `DsClient::new()` 方法中，为 HTTP 客户端添加重定向策略配置。

### 修改位置
文件：`src/ds_core/client.rs`  
方法：`DsClient::new()`（第 274-298 行）

### 修改前（第 283 行）：
```rust
let mut builder = rquest::Client::builder().emulation(Emulation::Chrome136);
```

### 修改后（第 283-285 行）：
```rust
let mut builder = rquest::Client::builder()
    .emulation(Emulation::Chrome136)
    .redirect(rquest::redirect::Policy::limited(10));
```

## 技术细节

### 重定向策略说明
- **`.redirect(rquest::redirect::Policy::limited(10))`**：配置 HTTP 客户端自动跟随最多 10 次重定向
- 这是 `rquest` 库推荐的安全重定向策略，可以防止无限重定向循环
- 修改后客户端会自动处理以下重定向状态码：
  - **301 Moved Permanently**：永久重定向
  - **302 Found**：临时重定向（本次修复的目标）
  - **303 See Other**：查看其他位置
  - **307 Temporary Redirect**：临时重定向（保持请求方法）
  - **308 Permanent Redirect**：永久重定向（保持请求方法）

### 工作原理
启用重定向策略后：
1. 客户端发送请求到 DeepSeek API
2. 如果收到 302 响应，`rquest` 自动读取 `Location` 响应头
3. 客户端自动向新 URL 发送请求（最多跟随 10 次）
4. 最终返回重定向后的实际响应（200/4xx/5xx）
5. `status.is_success()` 检查的是最终响应的状态码，而不是中间的 302

## 影响范围

此修复影响所有通过 `DsClient` 发起的 DeepSeek API 调用：

### 账号初始化阶段
- 登录：`/users/login`
- 创建会话：`/chat_session/create`
- 健康检查：`/chat/completion`（带 PoW）
- 更新标题：`/chat_session/update_title`

### 正常请求阶段
- 聊天补全：`/chat/completion`
- 编辑消息：`/chat/edit_message`
- 文件上传：`/file/upload_file`
- 获取文件列表：`/file/list`
- 停止流式响应：`/chat/stop_stream`
- PoW WASM 下载：从 `wasm_url` 配置的地址

## 测试建议

修复后，请在之前出现 302 错误的环境中重新测试：

### 1. 编译项目
```bash
cd ds-free-api-0.2.6
cargo build --release
```

### 2. 复制二进制到设备
```bash
# 如果是交叉编译，确保目标架构正确
scp target/release/ds-free-api root@YoudaoDictionaryPen-678:/userdisk/ds-free-api/
```

### 3. 运行服务
```bash
./ds-free-api
```

### 4. 验证修复
- ✅ 服务正常启动，没有 302 错误
- ✅ 日志显示账号初始化成功
- ✅ 可以通过管理面板访问：`http://设备IP:22217/admin`
- ✅ API 调用正常返回响应

### 5. 调试日志（可选）
如果需要查看重定向过程：
```bash
RUST_LOG=debug ./ds-free-api 2>&1 | tee ds-free-api.log
```

## 兼容性

### 向后兼容
此修改**完全向后兼容**，不影响现有功能：
- 对于不返回 302 的正常请求，行为保持不变
- 仅增强了对重定向的处理能力
- 不改变任何 API 接口和配置项

### 性能影响
- 重定向会增加一次额外的 HTTP 请求
- 对于正常不重定向的请求，没有性能影响
- 10 次重定向限制确保不会陷入无限循环

### 安全性
- `.limited(10)` 策略防止重定向循环攻击
- 跨域重定向时自动移除敏感请求头（如 `Authorization`，由 `rquest` 自动处理）
- 不跟随 `file://` 等非 HTTP(S) 协议的重定向

## 相关问题排查

如果修复后仍有问题，请检查：

### 1. 网络连接
```bash
# 测试能否访问 DeepSeek API
curl -I https://chat.deepseek.com/api/v0/users/login
```

### 2. 代理配置
如果使用代理，确保 `config.toml` 中配置正确：
```toml
[proxy]
url = "http://proxy-server:port"
```

### 3. TLS/SSL 问题
确保系统证书库正常：
```bash
# Debian/Ubuntu
apt-get install ca-certificates

# CentOS/RHEL
yum install ca-certificates
```

### 4. DNS 解析
```bash
# 测试 DNS 解析
nslookup chat.deepseek.com
```

## 后续优化建议

如果未来需要更细粒度的重定向控制，可以考虑：
1. 在 `config.toml` 中添加 `redirect_limit` 配置项
2. 记录重定向日志（target: `ds_core::client`，level: `debug`）
3. 区分不同 API 端点的重定向策略

## 提交说明

修改文件：
- `src/ds_core/client.rs`（第 283-285 行）

建议的 commit message：
```
fix: add redirect policy to handle 302 responses from DeepSeek API

- Configure rquest client with .redirect(Policy::limited(10))
- Fixes issue where TLB returns 302 and causes service to exit
- Automatically follows up to 10 redirects for all API calls
```
