// shell 写入兼容层：OS 4.9.7 的 falcon fs 模块没有 fs.writeFile（真机确认），
// 所有「JS 直接写文件」在那些机型上静默失败——chatStream 的 curl 配置文件写不出来
// （报 no URL specified!）、appLog 写不出来（反馈日志为空）、camera/上传的临时文件写不出来。
//
// 但同机型的 fs.readFile、execShell、shell base64 都是好的（chatStream 能从
// curl 写出的 outFile 里读到错误文本，就是 fs.readFile 可用的铁证；curl 能跑就是 execShell 可用）。
//
// 所以这里的兜底策略：内容 UTF-8 → base64（纯 JS 编码，设备无 TextEncoder/Buffer）→
// 分块 printf >> 追加（每块一个哨兵文件做完成同步，规避 execShell 并发乱序）→
// base64 -d 解码落盘。base64 -d 会忽略换行，b64 文件尾部多一个换行无害。
//
// 本模块保持零 import（叶子模块）：native.js 与 store.js 是互相循环的孪生实现，
// 各自引入本模块不会成环。bridge 依赖全部注入，宿主机可用真 sh 做集成测试。

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 手写 UTF-8 编码（与 api-auth.js 的 utf8Bytes 同思路，独立实现避免跨模块依赖）
function utf8Bytes(str) {
  const s = String(str == null ? '' : str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
        continue
      }
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out
}

// 字节数组 → base64（标准字母表 + 填充，无换行）
function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64_CHARS.charAt(b0 >> 2);
    out += B64_CHARS.charAt(((b0 & 3) << 4) | (b1 >= 0 ? b1 >> 4 : 0));
    out += b1 >= 0 ? B64_CHARS.charAt(((b1 & 15) << 2) | (b2 >= 0 ? b2 >> 6 : 0)) : '=';
    out += b2 >= 0 ? B64_CHARS.charAt(b2 & 63) : '=';
  }
  return out
}

function utf8ToBase64(text) {
  return bytesToBase64(utf8Bytes(text))
}

// 按 base64 字符数切块。单条命令 = 块 + 路径/固定段 ≈ 块 + 250 字符。
// 实测宿主机 sh -c 在 8192 字符处截断（引号失衡报 unexpected EOF）；
// 设备端 execShell 桥的限额未知但只会更小，取 6000（命令 ~6250）留足余量。
function splitB64Chunks(b64, chunkChars = 6000) {
  const chunks = [];
  for (let i = 0; i < b64.length; i += chunkChars) {
    chunks.push(b64.slice(i, i + chunkChars));
  }
  return chunks
}

function randId() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36)
}

/**
 * 用 shell 把文本内容精确写入文件（fs.writeFile 不可用/失败时的兜底）。
 * @param {Object} bridge { execShell, shq, waitForFile, sleep, dataDirBase, joinPath }
 * @param {string} path 目标文件绝对路径
 * @param {string} content 文本内容（UTF-8 精确写入；空串等价截断）
 * @returns {Promise<boolean>} 是否成功（绝不抛出）
 */
async function shellWriteFile(bridge, path, content) {
  const text = String(content == null ? '' : content);
  try {
    const execShell = bridge.execShell;
    if (typeof execShell !== 'function') return false
    const shq = bridge.shq;
    const waitForFile = bridge.waitForFile;
    const dataDir = bridge.dataDirBase();
    const q = (s) => shq(s);
    // execShell 是异步 fire-and-forget 且不保证 FIFO：任何「先 setup 后使用」的
    // 跨命令顺序都不能依赖。因此目录创建并入首块命令（同一 sh -c 内天然串行），
    // 多块的其余顺序靠「每块写哨兵 → await 哨兵」同步。
    const tmpDir = bridge.joinPath(dataDir, 'wshell_' + randId());
    const tmpOk = (name) => bridge.joinPath(tmpDir, name);

    if (text === '') {
      // 空内容 = 截断：哨兵直接放 dataDir（目录必存在，无需 mkdir）
      const okFile = bridge.joinPath(dataDir, 'wok_' + randId() + '.ok');
      execShell(': > ' + q(path) + ' && printf ok > ' + q(okFile) + '; true');
      const ok = await waitForFile(okFile, 5000);
      execShell('rm -f ' + q(okFile) + ' 2>/dev/null; true');
      return ok !== null
    }

    const b64 = utf8ToBase64(text);
    const chunks = splitB64Chunks(b64);
    if (chunks.length === 1) {
      // 单块：一条命令完成「解码落盘 + 哨兵」，最小往返；哨兵直接放 dataDir
      const okFile = bridge.joinPath(dataDir, 'wok_' + randId() + '.ok');
      execShell(
        'printf %s ' + q(chunks[0]) + ' | base64 -d > ' + q(path) +
        ' && printf ok > ' + q(okFile) + '; true'
      );
      const done = await waitForFile(okFile, 8000);
      execShell('rm -f ' + q(okFile) + ' 2>/dev/null; true');
      return done !== null
    }

    // 多块：b64 逐块追加到临时文件，最后解码落盘
    const b64File = bridge.joinPath(tmpDir, 'b64');
    const okFile = bridge.joinPath(tmpDir, 'ok');
    for (let i = 0; i < chunks.length; i++) {
      const chunkOk = tmpOk('ok.' + i);
      const setup = i === 0 ? 'rm -rf ' + q(tmpDir) + ' 2>/dev/null; mkdir -p ' + q(tmpDir) + '; ' : '';
      execShell(
        setup +
        'printf %s ' + q(chunks[i]) + ' >> ' + q(b64File) +
        ' && printf ' + i + ' > ' + q(chunkOk) + '; true'
      );
      const got = await waitForFile(chunkOk, 5000);
      if (got === null) {
        execShell('rm -rf ' + q(tmpDir) + ' 2>/dev/null; true');
        return false
      }
    }
    execShell(
      'base64 -d ' + q(b64File) + ' > ' + q(path) +
      ' && printf ok > ' + q(okFile) + '; chmod 644 ' + q(path) + ' 2>/dev/null; true'
    );
    const done = await waitForFile(okFile, 8000);
    execShell('rm -rf ' + q(tmpDir) + ' 2>/dev/null; true');
    return done !== null
  } catch (e) {
    return false
  }
}

/**
 * shell 追加一行到文本文件（appLog 在无 fs.writeFile 机型上的兜底）。
 * 行内不能有裸换行（appLog 的行本来就是单行）。
 * 注意 printf 的格式串必须带引号：未引用的 `\n` 会被 shell 先吃掉反斜杠变字面 n。
 * @returns {Promise<boolean>}
 */
async function shellAppendLine(bridge, path, line) {
  try {
    const execShell = bridge.execShell;
    if (typeof execShell !== 'function') return false
    const id = 'wapp_' + randId();
    const okFile = bridge.joinPath(bridge.dataDirBase(), id + '.ok');
    execShell(
      'printf ' + bridge.shq('%s\\n') + ' ' + bridge.shq(String(line == null ? '' : line)) + ' >> ' + bridge.shq(path) +
      ' && printf ok > ' + bridge.shq(okFile) + '; true'
    );
    const ok = await bridge.waitForFile(okFile, 5000);
    execShell('rm -f ' + bridge.shq(okFile) + ' 2>/dev/null; true');
    return ok !== null
  } catch (e) {
    return false
  }
}

/**
 * shell 截断文件（等价 writeFile(path, '')）。
 */
async function shellTruncate(bridge, path) {
  return shellWriteFile(bridge, path, '')
}

/**
 * shell 取文件字节数（fs.stat 不可用机型的 statSize 兜底）。失败返回 0。
 * 哨兵文件直接存 wc -c 的输出（字节数），一次命令完成「测量 + 完成通知」。
 */
async function shellFileSize(bridge, path) {
  try {
    const execShell = bridge.execShell;
    if (typeof execShell !== 'function') return 0
    const okFile = bridge.joinPath(bridge.dataDirBase(), 'wstat_' + randId() + '.ok');
    execShell('wc -c < ' + bridge.shq(path) + ' > ' + bridge.shq(okFile) + ' 2>/dev/null; true');
    const ok = await bridge.waitForFile(okFile, 5000);
    execShell('rm -f ' + bridge.shq(okFile) + ' 2>/dev/null; true');
    if (ok === null) return 0
    const m = String(ok).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0
  } catch (e) {
    return 0
  }
}

export { bytesToBase64, shellAppendLine, shellFileSize, shellTruncate, shellWriteFile, splitB64Chunks, utf8Bytes, utf8ToBase64 };
