/**
 * 老配置迁移测试：perDay → perDayMax、peakValley → autoRun、dmMode → dmOn。
 * 用法：node test-migrate.mjs [插件目录]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 默认指向仓库根（本脚本在 tools/ 下）；也可以在命令行传插件目录
const PLUGIN =
  process.argv[2] ||
  join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const ok = (c, l, e) => {
  if (c) console.log('  ✓ ' + l)
  else { failures++; console.log('  ✗ ' + l + (e ? '  → ' + e : '')) }
}

async function loadWith(cfgJson) {
  const HOME = mkdtempSync(join(tmpdir(), 'migrate-'))
  const STATE = join(HOME, 'bili-duty')
  mkdirSync(STATE, { recursive: true })
  writeFileSync(join(STATE, 'config.json'), JSON.stringify(cfgJson), 'utf8')
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
  const res = { body: '', writeHead() {}, end(b) { this.body = b } }
  await routes[0].handler({ method: 'GET', url: '/api/bili-pond/status' }, res)
  const st = JSON.parse(res.body)
  rmSync(HOME, { recursive: true, force: true })
  return st.config
}

console.log('=== ① perDay=5, peakValley=true ===')
{
  const c = await loadWith({ perDay: 5, peakValley: true, autoComment: true, mentionName: 'x' })
  console.log('   →', JSON.stringify({ perDayMax: c.perDayMax, autoRun: c.autoRun, peakValleyOnly: c.peakValleyOnly }))
  ok(c.perDayMax === 5, 'perDay=5 → perDayMax=5', String(c.perDayMax))
  ok(c.autoRun === true, 'peakValley=true → autoRun=true', String(c.autoRun))
  ok(c.peakValleyOnly === true, 'peakValley=true → peakValleyOnly=true', String(c.peakValleyOnly))
}

console.log('\n=== ② 没有任何老字段（新装）===')
{
  const c = await loadWith({})
  console.log('   →', JSON.stringify({ perDayMax: c.perDayMax, autoRun: c.autoRun, dmOn: c.dmOn }))
  ok(c.perDayMax === 18, '默认 perDayMax=18', String(c.perDayMax))
  ok(c.autoRun === false, '默认 autoRun=false', String(c.autoRun))
  ok(c.dmOn === false, '默认 dmOn=false', String(c.dmOn))
}

console.log('\n=== ③ 老 dmMode → 独立开关 dmOn ===')
{
  const only = await loadWith({ dmMode: 'only', autoComment: true, mentionName: 'x', dmUid: 123 })
  console.log('   only →', JSON.stringify({ dmOn: only.dmOn, autoComment: only.autoComment }))
  ok(only.dmOn === true, 'dmMode=only → dmOn=true', String(only.dmOn))
  ok(only.autoComment === false, 'dmMode=only 的旧语义是「不评论」⇒ autoComment 被关掉', String(only.autoComment))

  const both = await loadWith({ dmMode: 'both', autoComment: true, mentionName: 'x', dmUid: 123 })
  console.log('   both →', JSON.stringify({ dmOn: both.dmOn, autoComment: both.autoComment }))
  ok(both.dmOn === true, 'dmMode=both → dmOn=true', String(both.dmOn))
  ok(both.autoComment === true, 'dmMode=both 不动 autoComment', String(both.autoComment))

  const off = await loadWith({ dmMode: 'off' })
  console.log('   off  →', JSON.stringify({ dmOn: off.dmOn }))
  ok(off.dmOn === false, 'dmMode=off → dmOn=false', String(off.dmOn))
}

console.log('\n=== ④ 新字段优先：有 dmOn 就不看 dmMode ===')
{
  const c = await loadWith({ dmOn: false, dmMode: 'both', dmUid: 123 })
  console.log('   →', JSON.stringify({ dmOn: c.dmOn }))
  ok(c.dmOn === false, 'dmOn 已存在时不被 dmMode 覆盖', String(c.dmOn))
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)

