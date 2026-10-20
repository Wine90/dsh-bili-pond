/**
 * 评论上限 ≤ 每轮挑中数 的钳制测试。
 * 用法：node test-comment-cap.mjs [插件目录]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 默认指向仓库根（本脚本在 tools/ 下）；也可以在命令行传插件目录
const PLUGIN = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (c, l, e) => {
  if (c) console.log('  ✓ ' + l)
  else { failures++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + e : '')) }
}

/** 用一份初始 config.json 起插件，POST 一次 patch，返回保存后的 config */
async function withPlugin(initial, patch) {
  const HOME = mkdtempSync(join(tmpdir(), 'cap-'))
  const STATE = join(HOME, 'bili-duty')
  mkdirSync(STATE, { recursive: true })
  writeFileSync(join(STATE, 'config.json'), JSON.stringify(initial), 'utf8')
  const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href + '?t=' + Date.now())
  const routes = []
  const ctx = {
    get: (n) => (n === 'dshHomePath' ? (name) => join(HOME, name) : undefined),
    effect: (f) => { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => {}, debounce: (f) => f,
    settings: { describe: () => [], update: async () => {} },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
  mod.apply(ctx, {})
  const route = routes[0]
  const post = async (url, body) => {
    const res = { body: '', writeHead() {}, end(b) { this.body = b } }
    await route.handler({
      method: 'POST', url,
      on: (ev, cb) => { if (ev === 'data') cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
    }, res)
    return JSON.parse(res.body)
  }
  const out = await post('/api/bili-pond/config', patch)
  rmSync(HOME, { recursive: true, force: true })
  return out.config
}

console.log('=== ① 挑 3 条，想设 5 条评论 ⇒ 应被钳到 3 ===')
{
  const c = await withPlugin({ perRoundMax: 3 }, { perRoundMax: 3, commentPerRound: 5 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 3, '评论上限被钳到 3', c.commentPerRound)
}

console.log('\n=== ② 挑 3 条，设 2 条评论 ⇒ 低于上限，应原样保留 ===')
{
  const c = await withPlugin({ perRoundMax: 3 }, { perRoundMax: 3, commentPerRound: 2 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 2, '低于上限时不动', c.commentPerRound)
}

console.log('\n=== ③ 挑 8 条，设 5 条评论 ⇒ 5 ≤ 8，应保留 5 ===')
{
  const c = await withPlugin({ perRoundMax: 8 }, { perRoundMax: 8, commentPerRound: 5 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 5, '挑得多时评论上限仍是 5', c.commentPerRound)
}

console.log('\n=== ④ 只改评论上限、不带 perRoundMax ⇒ 用已存的挑中数(3)来钳 ===')
{
  const c = await withPlugin({ perRoundMax: 3, commentPerRound: 1 }, { commentPerRound: 4 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 3, '按磁盘上的 perRoundMax=3 钳', c.commentPerRound)
}

console.log('\n=== ⑤ 把挑中数从 5 调小到 2 ⇒ 评论上限 5 应跟着降到 2 ===')
{
  const c = await withPlugin({ perRoundMax: 5, commentPerRound: 5 }, { perRoundMax: 2 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 2, '挑中数调小后评论上限跟着降', c.commentPerRound)
}

console.log('\n=== ⑥ 挑 0 条（只跑不挑）⇒ 评论上限也应为 0 ===')
{
  const c = await withPlugin({ perRoundMax: 3 }, { perRoundMax: 0, commentPerRound: 3 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 0, '没东西可挑时评论上限是 0', c.commentPerRound)
}

console.log('\n=== ⑦ 评论上限 0（主动关闭评论）⇒ 保持 0 ===')
{
  const c = await withPlugin({ perRoundMax: 3, commentPerRound: 1 }, { commentPerRound: 0 })
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, commentPerRound: c.commentPerRound }))
  ok(c.commentPerRound === 0, '0 不被抬上去', c.commentPerRound)
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)

