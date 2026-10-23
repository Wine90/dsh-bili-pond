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
ok('中文名是「B站鱼塘」', /label: 'B站鱼塘'/.test(client) && /\['B站鱼塘', h\('span'/.test(client))
ok('署名：变量探索SEQVEC 链到 B站空间', /space\.bilibili\.com\/14430149[\s\S]{0,120}变量探索SEQVEC/.test(client))
ok('GitHub 链接保留', /github\.com\/YOYOLnFu\/dsh-bili-pond/.test(client))
ok('Gitee 链接已去掉', !/gitee\.com\/YOYOLnFu\/bilibili/.test(client))
ok('主按钮写死蓝底白字（不依赖主题 token）', /\.pond-btn\.primary, \.pond \.pond-btn\.primary:hover[\s\S]{0,160}background:#2563eb/.test(client))
ok('右侧记录默认限高、可展开', /\.pond-list\.cap \{ max-height/.test(client) && /const sideBlock = \(key, title, rows, empty\)/.test(client))
ok('设置 Tab 复用原来的设置页', /h\(Panel\)/.test(client))

ok('宿主有 /api/bili-pond/pond 路由', /path === '\/api\/bili-pond\/pond'/.test(host))
ok('宿主 import 了 readHistory', /readHistory/.test(host) && /from '\.\/lib\/history\.mjs'/.test(host))
ok('经验值口径写在注释里（陪伴账本，不是战斗力）', /陪伴账本/.test(host))
ok('每看一条 +10 / 回过 +5 / 一天 +20', /items\.length \* 10 \+ replies\.length \* 5 \+ days\.size \* 20/.test(host))
ok('返回体带 stats / items / daily', /stats: \{/.test(host) && /items, memory,/.test(host) && /daily: \{ date: dayKey/.test(host))

ok('assets/icon.png 存在', existsSync(join(root, 'assets', 'icon.png')))
ok('package.json 的 files 含 assets（发布不会漏图）', (pkg.files || []).includes('assets'))

console.log(`✅ 大肥鱼整页校验通过（${pass} 条断言）`)
