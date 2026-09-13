## 有道Deepseek APP构建说明

###  构建ds-free-api Rust后端
-构建时间较长（约20-30分钟）

1.构建目标 wsl cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6/ && cargo build --release
2.压缩以便节省空间 wsl cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6/target/aarch64-unknown-linux-gnu/release/ && upx --lzma ds-free-api
3.复制到指定地点 Copy-Item -Path "D:\codes\youdao\Deepseek\ds-free-api\ds-free-api-0.2.6\target\aarch64-unknown-linux-gnu\release\ds-free-api" -Destination "D:\codes\youdao\Deepseek\app\backend\linux-aarch64-gnu\" -Force

### 运行Rust单元测试（宿主 target，无需交叉编译）
- 仓库 .cargo/config.toml 的 [env] 把 CC 指向 aarch64 交叉编译器，宿主测试需临时覆盖：
  wsl cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6/ && cargo test --target x86_64-unknown-linux-gnu --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"'
- 注意：默认 target 是 aarch64-unknown-linux-gnu，测试二进制无法在本机直接运行，必须显式指定宿主 target。

### 构建Deepseek miniapp前端

1.用npm run build:prod进行完整构建（qjsc预编译阶段较长，请耐心等待）
  - 版本号会自动递增：scripts/build-wrapper.js 每次构建把 src/services/build-info.js 的 BUILD_NUM +1（如需校准直接改该文件）
  - 打包前会自动重跑 scripts/inline-backend.js，把 app/backend/linux-aarch64-gnu/ds-free-api 内嵌进 backend-blob.js
2.如果1卡在“开始 qjsc 预编译”可以尝试 npm run build:dev

Code happy！