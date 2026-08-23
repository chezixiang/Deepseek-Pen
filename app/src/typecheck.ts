/**
 * 类型用法样例（编译期检查 + 文档）。
 * 本文件不参与打包，仅让 tsc 校验 @dictpen/types 的各模块声明，
 * 同时演示官方系统模块与 langningchen 扩展的推荐写法。
 */

import fs from 'fs'
import storage from 'storage'
import sqlite3 from 'sqlite3'
import crypto from 'crypto'
import zip from 'zip'
import am from 'am'
import pm from 'pm'
import updater from 'updater'
import { AI, IME, ScanInput, Shell, Update } from 'langningchen'

// ---- $falcon 全局（falcon.d.ts，无需 import） ----
const info = `${$falcon.env.deviceModel} ${$falcon.env.deviceWidth}x${$falcon.env.deviceHeight}`
const assets = `${$workspace}/assets/sound.mp3`
const savePath = `${$dataDir}/downloads/tmp.txt`

// ---- fs ----
async function fsDemo() {
    const names: string[] = await fs.readdir('.')
    const dirents = await fs.readdir('.', { withFileTypes: true })
    const isDir = dirents.length > 0 && dirents[0].isDirectory()
    const stat = await fs.stat(savePath)
    await fs.mkdir(`${$dataDir}/tmp`)
    const content: string = await fs.readFile(assets)
    await fs.rm(`${$dataDir}/tmp`)
    console.log(names, isDir, stat.size, content)
}

// ---- storage ----
async function storageDemo() {
    await storage.setStorage('key1', 'val1')
    const val: string = await storage.getStorage('key1')
    const keys: string[] = await storage.getStorageKeys()
    await storage.removeStorage('key1')
    await storage.clearStorage()
    console.log(val, keys)
}

// ---- sqlite3 ----
async function sqliteDemo() {
    const db = new sqlite3.Database()
    await db.open(`${$dataDir}/demo.db`)
    await db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, name TEXT)')
    const st = await db.prepare('INSERT INTO t(name) VALUES (?)')
    await st.bind(['name1'])
    await st.run()
    await st.finalize()
    const sel = await db.prepare('SELECT * FROM t')
    const rows = await sel.all()
    await db.close()
    console.log(rows, db.path)
}

// ---- crypto / zip ----
async function cryptoZipDemo() {
    const md5 = new crypto.Hash('md5')
    const digest: string = await md5.hashFile(savePath)
    const zf = new zip.ZipFile('/tmp/test.zip')
    await zf.extractall('/tmp/out')
    console.log(digest)
}

// ---- am / pm / updater ----
function systemDemo() {
    const top: string = am.getTopApp()
    am.moveToBack()
    am.hide()
    console.log(am.hasWindowFocus(), am.isAttachedToWindow())

    const pkgs = pm.getInstalledPackages()
    const pkg = pm.getPackageInfo('8000000000000000')
    pm.installPackage('/userdisk/app.amr', (r) => console.log(r.res === pm.SUCCESS))
    console.log(pkgs, pkg)

    if (updater.isReady()) {
        updater.getUpdateInfo($appid, (info) => {
            if (info.status === updater.ST_HAS_NEW_VERSION) {
                console.log(info.checkResult?.version)
            }
        })
        updater.on('updateInfo', ({ event, info }) => {
            if (event === updater.EVT_DOWNLOAD_PERCENT_CHANGE) {
                console.log(info.downloadPercent)
            }
        })
    }
}

// ---- langningchen 社区扩展 ----
function extensionDemo() {
    AI.initialize()
    AI.addUserMessage('你好').then(() => AI.generateResponse())
    AI.on('ai_stream', (delta: string) => console.log(delta))
    const candidates = IME.getCandidates('nihao')
    console.log(candidates[0]?.hanZi)
    ScanInput.on('scan_input', (data: string) => console.log(data))
    Shell.initialize()
    Shell.exec('pwd').then((out: string) => console.log(out))
    Update.setRepo({ owner: 'octocat', repo: 'Hello-World' })
}

export { fsDemo, storageDemo, sqliteDemo, cryptoZipDemo, systemDemo, extensionDemo, info }
