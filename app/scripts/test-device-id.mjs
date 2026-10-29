// 设备标识派生回归：同一台机器必须永远得到同一个 ID。
//
// 这些用例锁的是 2026-10-28 的严重 bug：MAC 可能读到全零/换网卡，
// 手动配对又另生成随机 UUID，导致同一台笔卸载重装后服务端出现两台设备。
// 新算法只认硬件 SN；旧 MAC 算法仅作为无 SN 设备的兼容兜底。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  buildDeviceIdRecord,
  buildProbeCommand,
  chooseDeviceId,
  deviceIdFromMac,
  deviceIdFromSerial,
  isLegacyUuidDeviceId,
  isPlaceholderDeviceId,
  isUsableSerial,
  normalizeDeviceId,
  normalizeMac,
  normalizeSerial,
  parseDeviceIdRecord,
  parseSnProbe,
  parseSystemProbe,
  PROBE_APP_MARK,
  PROBE_END_MARK,
  PROBE_USER_MARK,
  recordMatchesFingerprints,
  serialFingerprint,
  serialFromCpuInfo
} from '../src/services/device-id.js'

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')

const CPUINFO = `processor\t: 0
BogoMIPS\t: 48.00
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x0
CPU part\t: 0xd03
CPU revision\t: 4

processor\t: 3
BogoMIPS\t: 48.00
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x0
CPU part\t: 0xd03
CPU revision\t: 4

Serial\t\t: 8c571a98d606d768
`

// 1) 真机样本解析
assert.equal(serialFromCpuInfo(CPUINFO), '8c571a98d606d768')
assert.equal(serialFromCpuInfo('processor : 0\n'), '')
assert.equal(serialFromCpuInfo('Serial\t\t: 0000000000000000\n'), '', '全零序列号必须视为不可用')

// 1b) shell 探测输出解析（真机格式：key=value，空值保留）
const probe = parseSnProbe('cpuinfo=8c571a98d606d768\ndevice-tree=\nemmc0=df011853434136344710165c5c05bb00\nmac-wlan0=60:7d:09:ab:c6:32\n')
assert.equal(probe.cpuinfo, '8c571a98d606d768')
assert.equal(probe['device-tree'], '')
assert.equal(probe.emmc0, 'df011853434136344710165c5c05bb00')
assert.equal(probe['mac-wlan0'], '60:7d:09:ab:c6:32')
assert.deepEqual(parseSnProbe(''), {})

// 1c) 一次探测带回「硬件标识 + 两份 ID 记录」：真机实测输出（adb 会把 \n 变成 \r\r）
const REC = '{"v":1,"id":"pen-1349504857b21b6122b513f7178197aa","sns":["abcd1234deadbeef"]}'
const probeOut = [
  'cpuinfo=8c571a98d606d768\r\r',
  'device-tree=\r\r',
  'emmc0=df011853434136344710165c5c05bb00\r\r',
  PROBE_APP_MARK + '\r\r',
  REC + '\r\r',
  PROBE_USER_MARK + '\r\r',
  REC + '\r\r',
  PROBE_END_MARK + '\r\r',
  ''
].join('\n')
const sys = parseSystemProbe(probeOut)
assert.equal(sys.values.cpuinfo, '8c571a98d606d768')
assert.equal(sys.values.emmc0, 'df011853434136344710165c5c05bb00')
assert.equal(sys.values['device-tree'], '')
assert.equal(sys.records.app, REC, '应用数据目录记录')
assert.equal(sys.records.user, REC, '用户盘记录')
assert.equal(parseDeviceIdRecord(sys.records.app).id, 'pen-1349504857b21b6122b513f7178197aa')

// 记录为空 / 缺结束标记时不能把后续内容误当成记录
const emptyProbe = parseSystemProbe(
  'cpuinfo=8c571a98d606d768\n' + PROBE_APP_MARK + '\n\n' + PROBE_USER_MARK + '\n\n' + PROBE_END_MARK + '\n'
)
assert.equal(emptyProbe.records.app, '')
assert.equal(emptyProbe.records.user, '')
assert.equal(parseSystemProbe('cpuinfo=x\n' + PROBE_APP_MARK + '\n' + REC).records.app, REC, '缺结束标记也要收下记录')
assert.equal(parseSystemProbe('').records.app, '')

// 1d) 探测命令：一条命令做完三件事，且必须 chmod 644
//（4.9.7 的 fs 没有 writeFile，shell 又以 root 写文件；umask 077 时应用读不回，
//  探测等于全空 → 退回随机 UUID，正是本次 bug 的老路）
const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'"
const cmd = buildProbeCommand({
  items: [['cpuinfo', 'cat /proc/cpuinfo 2>/dev/null']],
  outFile: '/data/ds-probe-1.txt',
  doneFile: '/data/ds-probe-1.done',
  appPath: '/data/.ds-device-id.json',
  userPath: '/userdisk/.ds-device-id.json',
  shq: q
})
assert.ok(cmd.indexOf('cpuinfo=$(cat /proc/cpuinfo 2>/dev/null)') > 0)
assert.ok(cmd.indexOf("cat '/data/.ds-device-id.json'") > 0, '必须 cat 应用数据目录记录')
assert.ok(cmd.indexOf("cat '/userdisk/.ds-device-id.json'") > 0, '必须 cat 用户盘记录')
assert.ok(cmd.indexOf(PROBE_APP_MARK) > 0 && cmd.indexOf(PROBE_APP_MARK) < cmd.indexOf(PROBE_USER_MARK))
assert.ok(cmd.indexOf(PROBE_USER_MARK) < cmd.indexOf(PROBE_END_MARK))
assert.ok(cmd.indexOf('chmod 644') > 0, 'root 写出的探测文件必须放开读权限')
assert.ok(cmd.indexOf("> '/data/ds-probe-1.txt'") > 0, '输出必须落到应用数据目录')
assert.ok(cmd.indexOf("echo done > '/data/ds-probe-1.done'") > 0, '完成哨兵')

// 2) 合法性判定
assert.equal(isUsableSerial('8c571a98d606d768'), true)
assert.equal(isUsableSerial(' 8c571a98d606d768\n'), true)
assert.equal(isUsableSerial('0000000000000000'), false)
assert.equal(isUsableSerial('ffffffffffffffff'), false)
assert.equal(isUsableSerial('unknown'), false)
assert.equal(isUsableSerial('abc'), false)
assert.equal(isUsableSerial(''), false)

// 3) SN → ID：确定、可复现，且与 Node crypto 公式一致
const SN = '8c571a98d606d768'
const expected = 'pen-' + sha256Hex('deepseek-pen:sn:' + SN).slice(0, 32)
assert.equal(deviceIdFromSerial(SN, sha256Hex), expected)
assert.match(expected, /^pen-[0-9a-f]{32}$/)
// 固定向量（真机 SN）：算法/域分隔变化会立刻暴露
assert.equal(expected, 'pen-1349504857b21b6122b513f7178197aa')

// 大小写/空白/换行不影响结果（重装后读取形态可能不同）
assert.equal(deviceIdFromSerial('8C571A98D606D768', sha256Hex), expected)
assert.equal(deviceIdFromSerial('  8c571a98d606d768\r\n', sha256Hex), expected)

// 不同 SN 必须不同 ID
assert.notEqual(deviceIdFromSerial('8c571a98d606d769', sha256Hex), expected)
// 无效 SN 不产出 ID（由调用方继续兜底）
assert.equal(deviceIdFromSerial('0000000000000000', sha256Hex), '')

// 4) 旧 MAC 算法兼容：升级后无 SN 的老设备 ID 不能变
const MAC = '60:7d:09:ab:c6:32'
const legacy = 'pen-' + sha256Hex('deepseek-pen:' + MAC).slice(0, 32)
assert.equal(deviceIdFromMac(MAC, sha256Hex), legacy)
assert.equal(deviceIdFromMac('60:7D:09:AB:C6:32', sha256Hex), legacy)
assert.equal(deviceIdFromMac('00:00:00:00:00:00', sha256Hex), '', '全零 MAC 不能当身份')
assert.equal(deviceIdFromMac('01:00:5e:00:00:01', sha256Hex), '', '组播 MAC 不能当身份')
assert.equal(normalizeMac('address=60:7d:09:ab:c6:32\n'), MAC)

// 4a) 历史随机 UUID 识别（旧 bug 产物，能读到 SN 时应迁移）
assert.equal(isLegacyUuidDeviceId('b8e60ec6-4dd2-4144-bdef-e0efd6e7132e'), true)
assert.equal(isLegacyUuidDeviceId('B8E60EC6-4DD2-4144-BDEF-E0EFD6E7132E'), true)
assert.equal(isLegacyUuidDeviceId(expected), false)
assert.equal(isLegacyUuidDeviceId(''), false)

// 4b) 旧版全零 MAC 占位 ID：多台设备会撞成同一个，必须识别并废弃
const zeroMacId = 'pen-' + sha256Hex('deepseek-pen:00:00:00:00:00:00').slice(0, 32)
assert.equal(isPlaceholderDeviceId(zeroMacId, sha256Hex), true)
assert.equal(isPlaceholderDeviceId(zeroMacId.toUpperCase(), sha256Hex), true)
assert.equal(isPlaceholderDeviceId(expected, sha256Hex), false, '正常 SN ID 不能被误判')
assert.equal(isPlaceholderDeviceId(legacy, sha256Hex), false, '真实 MAC ID 不能被误判')

// 5) 持久化记录：SN 指纹用于识别"还是不是同一台机器"
const fp = serialFingerprint(SN, sha256Hex)
assert.equal(fp, sha256Hex('deepseek-pen:snfp:' + SN).slice(0, 16))
assert.notEqual(serialFingerprint('8c571a98d606d769', sha256Hex), fp)

const text = buildDeviceIdRecord(expected, fp)
const rec = parseDeviceIdRecord(text)
assert.equal(rec.id, expected)
assert.equal(rec.snHash, fp)
assert.deepEqual(rec.snHashes, [fp])
assert.equal(parseDeviceIdRecord(expected).id, expected, '兼容纯 ID 文本')
assert.equal(parseDeviceIdRecord(expected).snHash, '')
assert.equal(parseDeviceIdRecord('not-a-device-id'), null)
assert.equal(parseDeviceIdRecord(''), null)
assert.equal(buildDeviceIdRecord('junk', fp), '')

// 多指纹：本次只读到 eMMC、下次读到 CPU SN，也应认作同一台机器
const multi = parseDeviceIdRecord(buildDeviceIdRecord(expected, [fp, 'abc12345']))
assert.deepEqual(multi.snHashes, [fp, 'abc12345'])
assert.equal(recordMatchesFingerprints(multi, ['deadbeef', fp]), true, '任一指纹匹配即同机')
assert.equal(recordMatchesFingerprints(multi, ['deadbeef']), false, '全部不匹配才是换机')
assert.equal(recordMatchesFingerprints(multi, []), true, '本次读不到 SN 时信任记录')
assert.equal(recordMatchesFingerprints({ id: expected, snHashes: [] }, ['deadbeef']), true, '无指纹的老记录信任')

// 5b) 决策函数：记录复用 / 占位废弃 / 换机重算
const snList = [{ sn: SN, source: 'cpuinfo', fp }]
const matchedRec = { id: expected, snHashes: [fp], path: '/userdisk/.ds-device-id.json' }
const d1 = chooseDeviceId({ saved: matchedRec, snList, sha256Hex })
assert.equal(d1.id, expected)
assert.equal(d1.reused, true)

// 记录无指纹（老格式）：继续复用，并补写指纹
const d2 = chooseDeviceId({ saved: { id: expected, snHashes: [], path: 'p' }, snList, sha256Hex })
assert.equal(d2.id, expected)
assert.equal(d2.addFingerprints, true)

// 本次读不到 SN：信任记录，不能换 ID
const d3 = chooseDeviceId({ saved: matchedRec, snList: [], sha256Hex })
assert.equal(d3.id, expected)
assert.equal(d3.reused, true)

// 指纹不匹配（换机/克隆用户盘）：按本机 SN 重算
const d4 = chooseDeviceId({
  saved: { id: 'pen-' + 'b'.repeat(32), snHashes: ['deadbeefdeadbeef'], path: 'p' },
  snList,
  sha256Hex
})
assert.equal(d4.id, expected)
assert.equal(d4.reused, false)

// 全零 MAC 占位 ID：即使记录存在也必须废弃
const d5 = chooseDeviceId({ saved: { id: zeroMacId, snHashes: [fp], path: 'p' }, snList, sha256Hex })
assert.equal(d5.id, expected)
assert.equal(d5.ignoredPlaceholder, true)

// 无记录、无 SN：交给 MAC/随机兜底
assert.equal(chooseDeviceId({ saved: null, snList: [], sha256Hex }).id, '')

// 5c) 历史随机 UUID 记录：有 SN 就必须收敛到 SN 派生 ID（否则 bug 被固化）
const uuidRec = { id: 'b8e60ec6-4dd2-4144-bdef-e0efd6e7132e', snHashes: [fp], path: 'p' }
const d6 = chooseDeviceId({ saved: uuidRec, snList, sha256Hex })
assert.equal(d6.id, expected, 'UUID 记录必须被 SN 覆盖')
assert.equal(d6.reused, false)
assert.equal(d6.ignoredLegacyUuid, true)
// 没有 SN 时保留 UUID 记录（总比再生成一个随机 ID 好）
const d7 = chooseDeviceId({ saved: uuidRec, snList: [], sha256Hex })
assert.equal(d7.id, uuidRec.id)
assert.equal(d7.reused, true)

// 6) 模拟"卸载重装"：同一 SN 反复派生必须完全一致
for (let i = 0; i < 5; i++) {
  assert.equal(deviceIdFromSerial(SN, sha256Hex), expected)
}

// 7) 设备 ID 形态校验
assert.equal(normalizeDeviceId('PEN-' + 'A'.repeat(32)), 'pen-' + 'a'.repeat(32))
assert.match(normalizeDeviceId('4f3c2a10-1111-4222-8333-123456789abc'), /^[0-9a-f-]{36}$/)
assert.equal(normalizeDeviceId('pen-xyz'), '')
assert.equal(normalizeDeviceId(''), '')

// 8) normalizeSerial 只取第一行、去 NUL/BOM
assert.equal(normalizeSerial('\uFEFF  ABC123\u0000\nsecond'), 'ABC123')

console.log('PASS device id derivation (SN-based, idempotent across reinstall)')
