# Bug 修复摘要

## 问题
服务启动时报错退出：`Error: provider error: HTTP status 302`

## 原因
HTTP 客户端未配置重定向策略，无法处理 DeepSeek API 返回的 302 重定向。

## 修复
在 `src/ds_core/client.rs` 第 285 行添加：
```rust
.redirect(rquest::redirect::Policy::limited(10))
```

## 影响
- ✅ 自动跟随所有 API 调用的重定向（最多 10 次）
- ✅ 兼容现有功能，无破坏性变更
- ✅ 修复 TLB 负载均衡器返回 302 导致的启动失败

## 测试
```bash
cargo build --release
./ds-free-api
# 应该正常启动，不再出现 302 错误
```

详细说明见 `FIX_302_REDIRECT.md`
