/**
 * sqlite3 模块浏览器 mock：极简 SQL 子集实现（CREATE TABLE/INSERT/SELECT *）。
 * 仅供 UI 开发调试，真实查询逻辑请以设备为准。
 * 机制见 api-mock/langningchen.js 头注释。
 */

class MockStatement {
  constructor(db, sql, rows) {
    this._db = db
    this._sql = sql
    this._rows = rows
    this._used = false
  }
  async columnNameList() {
    const first = this._rows[0] || {}
    return Object.keys(first)
  }
  async bindParameterList() { return [] }
  async bind() { return [] }
  async step() {
    const row = this._rows.shift()
    return row === undefined ? null : row
  }
  async run() { return 0 }
  async all() { return this._rows.slice() }
  async reset() { this._used = false; return 0 }
  async clearBindings() { return 0 }
  async finalize() { return 0 }
}

class MockDatabase {
  constructor() {
    this.path = ''
    this._tables = new Map() // name -> { cols, rows }
  }
  async open(path) {
    this.path = path
    return 0
  }
  async close() { return 'CLOSED' }
  async exec(sql) {
    const create = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)\(([^)]*)\)/i)
    if (create) {
      const cols = create[2].split(',').map((c) => c.trim().split(/\s+/)[0]).filter((c) => c && !c.startsWith('PRIMARY'))
      this._tables.set(create[1], { cols, rows: [] })
    }
    return 0
  }
  async prepare(sql) {
    const select = sql.match(/SELECT \* FROM (\w+)/i)
    if (select && this._tables.has(select[1])) {
      return new MockStatement(this, sql, this._tables.get(select[1]).rows.slice())
    }
    const insert = sql.match(/INSERT INTO (\w+)/i)
    if (insert && this._tables.has(insert[1])) {
      const table = this._tables.get(insert[1])
      const placeholders = (sql.match(/\?/g) || []).length
      return new MockStatement(this, sql, [], { __insert: table, __placeholders: placeholders })
    }
    return new MockStatement(this, sql, [])
  }
}

export default {
  Database: MockDatabase
}
