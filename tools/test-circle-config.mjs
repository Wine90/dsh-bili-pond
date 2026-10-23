/** 圈地自萌与普通评论互斥的后端测试。 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PLUGIN = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label)
  else { failures += 1; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')) }
}

async function withPlugin(initial, patch) {
  const HOME = mkdtempSync(join(tmpdir(), 'circle-cfg-'))
  const STATE = join(HOME, 'bili-duty')
  mkdirSync(STATE, { recursive: true })
  writeFileSync(join(STATE, 'config.json'), JSON.stringify(initial), 'utf8')
  const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href + '?t=' + Date.now() + Math.random())
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
  await routes[0].handler({
    method: 'POST', url: '/api/bili-pond/config',
    on: (ev, cb) => { if (ev === 'data') cb(Buffer.from(JSON.stringify(patch))); if (ev === 'end') cb() },
  }, res)
  const out = JSON.parse(res.body)
  rmSync(HOME, { recursive: true, force: true })
  return out.config
}

console.log('=== 圈地自萌与普通评论互斥 ===')
{
  const c = await withPlugin({ circleMode: true, autoComment: false }, { autoComment: true })
  ok(c.circleMode === true && c.autoComment === false && c.replyToComments === false,
    '只发 autoComment=true 不能绕过圈地模式', JSON.stringify(c))
}
{
  const c = await withPlugin({ circleMode: false }, { circleMode: true, autoComment: true, replyToComments: true })
  ok(c.circleMode === true && c.autoComment === false && c.replyToComments === false,
    '开启圈地模式会同时关掉普通评论与回楼中楼', JSON.stringify(c))
}
{
  const c = await withPlugin({ circleMode: true, autoComment: false }, { circleMode: false, autoComment: false, replyToComments: false })
  ok(c.circleMode === false && c.autoComment === false && c.replyToComments === false,
    '关闭圈地模式后保持关闭评论', JSON.stringify(c))
}
{
  const c = await withPlugin({ circleMode: false }, { autoComment: true, replyToComments: true })
  ok(c.circleMode === false && c.autoComment === true && c.replyToComments === true,
    '普通评论模式不受圈地模式影响', JSON.stringify(c))
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)
