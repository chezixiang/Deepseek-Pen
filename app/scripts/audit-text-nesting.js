#!/usr/bin/env node
// Falcon/Weex 模板审计：<text> 节点带 measure 函数，**任何**元素子节点都会让
// Yoga 断言 "Cannot add child: Nodes with measure functions cannot have children."
// 并 abort 整个框架进程。这里逐标签维护栈，找出所有「<text> 内还有元素子节点」的位置。
const fs = require('fs')
const path = require('path')

const VOID = new Set(['image', 'input', 'img', 'br', 'hr', 'icon', 'video', 'canvas'])
const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

function audit(file) {
    const src = fs.readFileSync(file, 'utf8')
    const end = src.indexOf('<script')
    // 先去掉 HTML 注释：注释里出现的 <text> 不是节点，否则会把说明文字误报成嵌套
    const tpl = (end >= 0 ? src.slice(0, end) : src).replace(/<!--[\s\S]*?-->/g, '')
    const stack = []
    const problems = []
    let m
    tagRe.lastIndex = 0
    while ((m = tagRe.exec(tpl))) {
        const closing = m[1] === '/'
        const name = m[2]
        const selfClose = m[4] === '/'
        const line = tpl.slice(0, m.index).split('\n').length
        if (closing) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name === name) { stack.length = i; break }
            }
            continue
        }
        if (selfClose || VOID.has(name)) {
            if (stack.some((s) => s.name === 'text')) {
                problems.push({ line, child: name, inside: stack.filter(s => s.name === 'text').map(s => s.name + '@' + s.line).join(',') })
            }
            continue
        }
        if (name !== 'template' && stack.some((s) => s.name === 'text')) {
            problems.push({ line, child: name, inside: stack.filter(s => s.name === 'text').map(s => s.name + '@' + s.line).join(',') })
        }
        stack.push({ name, line })
    }
    return { file, problems }
}

const files = []
const seen = new Set()
for (const dir of ['src/pages', 'src']) {
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            // 只审 .vue 模板：本项目的 .js 里没有模板语法，而 markdown.js 等文件里
            // 的 `<invoke>`/`<parameter>` 是协议标签的**正则字面量**（不是节点），
            // 扫进来会误报。src/pages 是 src 的子目录，用 Set 去重避免重复报同一文件。
            else if (/\.vue$/.test(e.name) && !seen.has(p)) {
                seen.add(p)
                files.push(p)
            }
        }
    }
    if (fs.existsSync(dir)) walk(dir)
}

let bad = 0
for (const f of files) {
    const { problems } = audit(f)
    if (problems.length) {
        bad++
        console.log('❌ ' + f)
        for (const p of problems) console.log(`   line ${p.line}: <${p.child}> inside ${p.inside}`)
    }
}
console.log(bad === 0 ? `✅ 审计通过：${files.length} 个文件均无「<text> 带元素子节点」` : `\n共 ${bad} 个文件存在问题`)
process.exit(bad === 0 ? 0 : 1)
