## 有道Deepseek APP构建说明
# 警告，如果你在使用git bash，请将每条命令使用 “pwsh -NoProfile -Command [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "你的命令" ”包裹

###  构建ds-free-api Rust后端
-构建时间较长
-请使用Powershell（和wsl）

1.构建目标 wsl --cd /mnt/g/youdao/Deepseek/ds-free-api bash -lc "cargo build --release"

2.压缩以便节省空间 wsl --cd /mnt/g/youdao/Deepseek/ds-free-api/target/aarch64-unknown-linux-gnu/release bash -lc "upx --lzma ds-free-api"

3.复制到指定地点 Copy-Item -Path "G:\youdao\Deepseek\ds-free-api\target\aarch64-unknown-linux-gnu\release\ds-free-api" -Destination "G:\youdao\Deepseek\app\backend\linux-aarch64-gnu\" -Force

### 构建Deepseek miniapp前端
-只需在Windows cmd环境运行即可

1.用npm run build:prod进行完整构建（qjsc预编译阶段较长，约15分钟，请耐心等待）（注意工具使用的终端会超时，这是正常现象）
2.如果1卡在“开始 qjsc 预编译”超过10分钟可以尝试 npm run build:dev
3.发布前把 package.json 的 version 和 src/services/store.js 的 APP_VERSION 一起改成同一版本号
（amr 文件名由 package.json 的 version 决定；build N 由构建脚本自动 +1，不用手改）

### 常用调试路径

/userdisk/secondary/miniapp/data/mini_app/pkg/8000000000182376/data/ds-app.log
/userdisk/secondary/miniapp/data/mini_app/pkg/8000000000182376/data/ds-free-api/logs/runtime.log
ps aux | grep "ds-free-api"


