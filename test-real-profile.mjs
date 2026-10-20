/**
 * 真实场景验证：把 patch 后的插件装到真的家目录位置，用一个临时家目录跑，
 * 但**用真的 dsh**去 dump-config，确认：
 *   ① workbuddy 能被预检认出来（在你的 headless profile 里）
 *   ② 选它之后 overlay 里写对了 provider/model
 *   ③ 假线路被拒绝
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/MYPangYang/.dsh/profiles/desktop/node_modules/dsh-bili-pond'
const HOME = mkdtempSync(join(tmpdir(), 'bili-real-' ))
const STATE = join(HOME, 'bili-duty')
mkdirSync(STATE, { recursive: true })

const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href)
let failures = 0
const ok = (c, l, e) => { if (c) console.log('  ✓ ' + l); else { failures++; console.log('  ✗ ' + l + (e ? '  → ' + e : '')) } }

const writeCfg = (patch) => {
  let cur = {}
  try { cur = JSON.parse(readFileSync(join(STATE, 'config.json'), 'utf8')) } catch {}
  writeFileSync(join(STATE, 'config.json'), JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8')
}

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
mod.apply(ctx, { perDay: 5 })
const handler = routes[0].handler
const call = async (method, url) => {
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await handler({ method, url, on: () => {} }, res)
  return JSON.parse(res.body || '{}')
}

// ① 用真 dsh 查 headless profile 里有哪些线路（通过 /models 的 profileKnown）
writeCfg({ dutyProvider: 'workbuddy', dutyModel: 'glm-5.3-flash' })
const m = await call('GET', '/api/bili-pond/models')
console.log('  profileKnown =', m.profileKnown, '| profileError =', m.profileError || '(none)')
ok(m.profileKnown === true, '① 能读到 headless profile 的线路', m.profileError)

// ② 选 workbuddy + glm-5.3-flash ⇒ 应该放行（会真的 spawn 一轮，所以只验证未被预检拒绝）
const r = await call('POST', '/api/bili-pond/run')
ok(r.started !== false || String(r.error || '').includes('profile 里没有可用线路') === false,
  '② workbuddy 通过了预检（没被"线路不存在"拦下）', JSON.stringify(r).slice(0, 240))
const overlay = join(STATE, 'headless-overlay.yml')
if (existsSync(overlay)) {
  const text = readFileSync(overlay, 'utf8')
  ok(text.includes('agent-default-model') && text.includes('provider: workbuddy') && text.includes('model: glm-5.3-flash'),
    '② overlay 里 provider/model 写对了', text.split('\n').slice(0, 14).join(' | '))
} else ok(false, '② overlay 文件生成了')

// ③ 假线路必须被拒
writeCfg({ dutyProvider: 'nope-xyz', dutyModel: '' })
const r2 = await call('POST', '/api/bili-pond/run')
ok(r2.started === false, '③ 假线路被拒绝', JSON.stringify(r2).slice(0, 200))

console.log('\n临时家目录：' + HOME)
console.log(failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗')
// 先别删：跑起来的 headless 进程要读这里的 overlay
process.exit(failures === 0 ? 0 : 1)
