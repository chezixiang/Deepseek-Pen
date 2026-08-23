## 有道Deepseek APP构建说明

###  构建ds-free-api Rust后端
-构建时间较长（约20-30分钟）

1.构建目标 wsl cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6/ && cargo build --release
2.压缩以便节省空间 wsl cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6/target/aarch64-unknown-linux-gnu/release/ && upx --lzma ds-free-api
3.复制到指定地点 Copy-Item -Path "D:\codes\youdao\Deepseek\ds-free-api\ds-free-api-0.2.6\target\aarch64-unknown-linux-gnu\release\ds-free-api" -Destination "D:\codes\youdao\Deepseek\app\backend\linux-aarch64-gnu\" -Force

### 构建Deepseek miniapp前端

1.用npm run build:prod进行完整构建（qjsc预编译阶段较长，请耐心等待）
2.如果1卡在“开始 qjsc 预编译”可以尝试 npm run build:dev

Code happy！