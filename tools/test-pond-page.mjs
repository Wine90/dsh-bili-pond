/**
 * 大肥鱼整页（侧栏图标 + 主面板）——接线校验
 * ============================================================================
 * 只查"接上了没有"，不查样式。改这页时最常踩的坑：
 *   · 侧栏图标 id 与 main key 不是同一个字符串 ⇒ 点图标切不过去（宿主靠 id 分派）
 *   · 忘了给 apply 的 inject 加 'layout' ⇒ 打不开面板
 *   · 图标 base64 写坏 ⇒ 侧栏是个碎图
 *   · 宿主 /pond 路由没接 readHistory ⇒ 页面永远是空封面墙
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const host = readFileSync(join(root, 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let pass = 0
const ok = (name, cond) => {
  if (!cond) throw new Error('断言失败：' + name)
  pass += 1
  console.log('  ✓ ' + name)
}

ok('client 里声明了 POND_ID', /const POND_ID = 'dsh-bili-pond'/.test(client))
ok('侧栏图标注册在 sidebar.panellist', /slots\.inject\('sidebar\.panellist'[\s\S]{0,220}name: 'sidebar\.panellist', id: POND_ID/.test(client))
ok('主面板注册在 main，且 key 用同一个 POND_ID', /slots\.inject\('main'[\s\S]{0,160}name: 'main', key: POND_ID/.test(client))
ok('侧栏底部也留了入口', /slots\.inject\('sidebar\.footer\.action'/.test(client))
ok('apply 的 inject 里有 layout（打开面板要用）', /inject: \['slots', 'layout'\]/.test(client))
ok('openPond 走 layout.selectPanel', /layout\.selectPanel\(id\)/.test(client))
ok('页面组件存在', /function PondPage\(\)/.test(client))
ok('页面样式拼进了同一个 style', /style\.textContent = CSS \+ POND_CSS/.test(client))
ok('图标是内联 PNG data URI', /const POND_ICON = 'data:image\/png;base64,[A-Za-z0-9+/=]{200,}'/.test(client))
ok('页面只发一个请求拿全量', /jget\('\/pond\?limit=120'\)/.test(client))
ok('页面有四个 Tab', /\['history', '历史'\], \['memory', '记忆'\], \['diary', '日记'\], \['settings', '设置'\]/.test(client))
ok('中文名是「B站鱼塘」', /label: 'B站鱼塘'/.test(client) && /'B站鱼塘'/.test(client))
ok('页尾是链接，不是一行纯文本（GitHub / B站空间）', /className: 'pond-foot'[\s\S]{0,400}github\.com\/YOYOLnFu\/dsh-bili-pond[\s\S]{0,200}space\.bilibili\.com\/14430149/.test(client))
ok('署名：变量探索SEQVEC 链到 B站空间', /space\.bilibili\.com\/14430149[\s\S]{0,120}变量探索SEQVEC/.test(client))
ok('GitHub 链接保留', /github\.com\/YOYOLnFu\/dsh-bili-pond/.test(client))
ok('Gitee 链接已去掉', !/gitee\.com\/YOYOLnFu\/bilibili/.test(client))
ok('按钮不抢底色（宿主说了算），只加发光', !/\.pond \.pond-btn\.primary[\s\S]{0,80}background:#2563eb !important/.test(client) && /\.pond \[data-bd-btn\]:hover \{ box-shadow:/.test(client) && /\.pond \[data-bd-btn\]:active \{ box-shadow:/.test(client))
ok('左下角入口用 .pond-entry（原样 + 发光，不写内联描边）', /className: 'pond-entry'/.test(client) && /\.pond-entry:hover \{ box-shadow:/.test(client))
ok('右侧记录默认限高、可展开', /\.pond-list\.cap \{ max-height/.test(client) && /const sideBlock = \(key, title, rows, empty\)/.test(client))
ok('整页自身滚动（视口封顶 max-height + overflow-y:auto，不依赖宿主面板高度）', /\.pond \{ display:flex;[\s\S]{0,220}max-height:calc\(100vh - 120px\);[\s\S]{0,160}overflow-y:auto/.test(client))
ok('跑一轮/刷新 用设置页同一套 data-bd-btn（不再自造按钮样式）', /'data-bd-btn': '', 'data-primary': ''[^}]*onClick: run/.test(client) && /'data-bd-btn': '', type: 'button', onClick: load/.test(client))
ok('顶部显示小号名字（取自 account.uname）', /d\.account && d\.account\.uname/.test(client))
ok('插件名/作者/GitHub/版本号移到右上角', /className: 'pond-meta'[\s\S]{0,320}B站鱼塘 · [\s\S]{0,260}变量探索SEQVEC[\s\S]{0,200}GitHub[\s\S]{0,40}v1\.3\.\d/.test(client))
ok('宿主 /pond 返回 account（读 bili_credential.json 问 nav）', /const pondAccount = async \(\) =>/.test(host) && /account: await pondAccount\(\)/.test(host) && /x\/web-interface\/nav/.test(host))
ok('设置 Tab 复用原来的设置页', /h\(Panel\)/.test(client))

ok('宿主有 /api/bili-pond/pond 路由', /path === '\/api\/bili-pond\/pond'/.test(host))
ok('宿主 import 了 readHistory', /readHistory/.test(host) && /from '\.\/lib\/history\.mjs'/.test(host))
ok('经验值口径写在注释里（陪伴账本，不是战斗力）', /陪伴账本/.test(host))
ok('每看一条 +10 / 回过 +5 / 一天 +20', /items\.length \* 10 \+ replies\.length \* 5 \+ days\.size \* 20/.test(host))
ok('返回体带 stats / items / daily', /stats: \{/.test(host) && /items, memory,/.test(host) && /daily: \{ date: dayKey/.test(host))

ok('assets/icon.png 存在', existsSync(join(root, 'assets', 'icon.png')))
ok('package.json 的 files 含 assets（发布不会漏图）', (pkg.files || []).includes('assets'))

/* ⭐ 1.3.6：主色固定 / 设置页能滚 / 用量账本 */
ok('主色固定', /--bd-accent:#2563eb;/.test(client), '--bd-accent 不再跟随主题 brand（壁纸主题下是浅色 ⇒ 白底白字）')
ok('设置页可滚动', /\[data-bd-page\]\{[^}]*overflow-y:auto/.test(client), '设置页根节点自己滚（宿主不给滚）')
ok('设置页按钮也有发光', /\[data-bd-btn\]:hover\{[^}]*box-shadow/.test(client), '悬停有蓝光')
ok('用量账本路由', /usage: readUsageToday\(\)/.test(host), '/pond 返回今日用量')
ok('用量抓取', /roundUsage\.in \+= Number\(u\.inputTokens\)/.test(host), '从 status/step_end 事件累加 token')
ok('轮末记账', /recordUsage\(roundUsage\)/.test(host), '每轮结束记一行 usage-log.jsonl')
ok('状态条显示费用', /今日 ≈/.test(client), '首页状态条显示 ¥ 与 tokens')

ok('设置卡片不被 flex 压缩裁剪（1.3.9 真根因）', /\.pond > \.pond-card \{ overflow:visible; flex:0 0 auto; \}/.test(client), 'overflow:hidden 会让自动最小高度归零，被压成 509px 裁掉 1600px 内容')
ok('设置区两栏重排（1.3.10）', /\.pond-settings \[data-bd-page\] \{ display:grid; grid-template-columns:1fr 1fr;/.test(client) && /@media \(max-width:1100px\)/.test(client), '宽屏两栏 grid，窄屏回退单列')

/* ⭐ 1.3.11：记忆 / 日记 / 鱼说 —— 写入端落地（此前只有展示层） */
const py = readFileSync(join(root, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const duty = readFileSync(join(root, 'prompts', 'duty.md'), 'utf8')
ok('MCP 有 bili_memory_append（记忆写入端）', /async def bili_memory_append\(what: str/.test(py))
ok('MCP 有 bili_diary_write（日记写入端）', /async def bili_diary_write\(markdown: str/.test(py))
ok('MCP 有 bili_say（鱼说写入端）', /async def bili_say\(text: str/.test(py))
ok('值班章程要求写记忆/日记/鱼说', /bili_memory_append/.test(duty) && /bili_diary_write/.test(duty) && /bili_say/.test(duty))
ok('宿主 /pond 返回 say 字段', /say: \{ date: dayKey\(new Date\(\)\), text: say \}/.test(host))

console.log(`✅ 大肥鱼整页校验通过（${pass} 条断言）`)
