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
ok('左下角重复入口已删除，只保留左上侧栏图标', !/slots\.inject\('sidebar\.footer\.action'/.test(client) && !/function PondEntry\(/.test(client))
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
ok('左下角入口的旧样式已清理', !/className: 'pond-entry'/.test(client) && !/\.pond-entry:hover/.test(client))
ok('右侧记录默认限高、可展开', /\.pond-list\.cap \{ max-height/.test(client) && /const sideBlock = \(key, title, rows, empty\)/.test(client))
ok('整页自身滚动（视口封顶 max-height + overflow-y:auto，不依赖宿主面板高度）', /\.pond \{ display:flex;[\s\S]{0,220}max-height:calc\(100vh - 120px\);[\s\S]{0,160}overflow-y:auto/.test(client))
ok('跑一轮/刷新 用设置页同一套 data-bd-btn（不再自造按钮样式）', /'data-bd-btn': '', 'data-primary': ''[^}]*onClick: run/.test(client) && /'data-bd-btn': '', type: 'button', onClick: load/.test(client))
ok('顶部显示小号名字（取自 account.uname）', /d\.account && d\.account\.uname/.test(client))
ok('插件名/作者/GitHub/版本号移到右上角', /className: 'pond-meta'[\s\S]{0,320}B站鱼塘 · [\s\S]{0,260}变量探索SEQVEC[\s\S]{0,200}GitHub[\s\S]{0,40}v1\.3\.\d/.test(client))
ok('宿主 /pond 返回 account（读 bili_credential.json 问 nav）', /const pondAccount = async \(\) =>/.test(host) && /account: await pondAccount\(\)/.test(host) && /x\/web-interface\/nav/.test(host))
ok('设置 Tab 复用原来的设置页', /h\(Panel, \{[\s\S]{0,80}layout: 'embedded'/.test(client))
ok('关键词饼图聚合为 Top 4 + 其他，避免扇区过碎', /keywordStats\.slice\(4\)/.test(client) && /donutParts\.push\(\{ k: '其他'/.test(client) && /donutParts\.map\(/.test(client))
ok('鱼说句子居中且署名紧跟句后', /\.pond-say \{[^}]*text-align:center/.test(client) && /\.pond-say em \{ display:inline;/.test(client))
ok('顶部标题旁显示插件英文名', /className: 'pond-en'[\s\S]{0,50}dsh-bili-pond/.test(client))

ok('宿主有 /api/bili-pond/pond 路由', /path === '\/api\/bili-pond\/pond'/.test(host))
ok('宿主 import 了 readHistory', /readHistory/.test(host) && /from '\.\/lib\/history\.mjs'/.test(host))
ok('经验值口径写在注释里（陪伴账本，不是战斗力）', /陪伴账本/.test(host))
ok('每看一条 +10 / 回过 +5 / 一天 +20', /allItems\.length \* 10 \+ replies\.length \* 5 \+ days\.size \* 20/.test(host))
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
ok('状态条只显示 token', /今日 token/.test(client) && !/≈¥/.test(client) && !/d\.usage\.cny/.test(client), '首页不展示估算金额')

ok('设置卡片不被 flex 压缩裁剪（1.3.9 真根因）', /\.pond > \.pond-card \{ overflow:visible; flex:0 0 auto; \}/.test(client), 'overflow:hidden 会让自动最小高度归零，被压成 509px 裁掉 1600px 内容')
ok('HARness 设置页按容器自适应网格重排', client.includes("grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))") && client.includes("'data-bd-layout': layout"), '宽内容双栏，窄内容自动单列')
ok('设置行与内联控件可自然换行', /\[data-bd-row\]\{[\s\S]*?flex-wrap:wrap;/.test(client) && /\[data-bd-inline\]\{[\s\S]*?flex-wrap:wrap;/.test(client), '不再把固定宽度控件硬塞在同一行')
ok('大主页运行/收尾中按钮保持禁用', /disabled: busy \|\| running \|\| finalizing/.test(client) && /aria-busy/.test(client), '启动、运行、写历史补封面三个阶段都不允许重复点击')
ok('大主页跑完自动刷新封面墙', client.includes('if (!on && !fin) await load()') && /finalizing/.test(client), '等历史写盘/补封面完成后才拉 /pond，不再依赖手动刷新')
ok('宿主会等历史收尾完成', /finalizing: Boolean\(dutyFinalizing\)/.test(host) && /finally\(\(\) => \{ dutyFinalizing = false \}\)/.test(host), '子进程退出后仍保持忙碌，直到 history.jsonl 写完')
ok('挑中计数复用新版日报解析', /harvestReport\(file\)\.filter\(\(e\) => e\.picked\)/.test(host), '不再只认 ### BV号 一种标题格式')
ok('封面墙取最新记录，统计仍用全量历史', /const allItems = readHistory\(stateDir\)/.test(host) && /const items = allItems\.slice\(0, limit\)/.test(host) && /const picked = allItems\.filter/.test(host), '超过 limit 后不能只显示最早的历史')
ok('封面补齐有单请求超时', /timeoutMs: 4000/.test(host) && /AbortSignal\.timeout/.test(readFileSync(join(root, 'lib', 'history.mjs'), 'utf8')), '接口挂住时不能把 dutyFinalizing 永久卡住')
ok('统计并入自动转写后的快捷区', (() => { const a = client.indexOf("key: 'sw'"); const b = client.indexOf("key: 'acts'", a); const s = client.slice(a, b); return s.indexOf('自动转写') >= 0 && s.indexOf('data-pond-stats') > s.indexOf('自动转写'); })())
ok('统计顺序保持 看过 / 回过 / 今天回过 / token / 经验', (() => { const a = client.indexOf("key: 'stats'"); const b = client.indexOf("key: 'acts'", a); const s = client.slice(a, b); return s.indexOf('看过 ') < s.indexOf('回过 ') && s.indexOf('回过 ') < s.indexOf('今天回过 ') && s.indexOf('今天回过 ') < s.indexOf('今日 token ') && s.indexOf('今日 token ') < s.indexOf('攒了 '); })())
ok('独立统计横条已移除，省掉一行', !/className: 'pond-strip'/.test(client) && !/\.pond-strip \{/.test(client))

/* ⭐ 1.3.11：记忆 / 日记 / 鱼说 —— 写入端落地（此前只有展示层） */
const py = readFileSync(join(root, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const duty = readFileSync(join(root, 'prompts', 'duty.md'), 'utf8')
ok('MCP 有 bili_memory_append（记忆写入端）', /async def bili_memory_append\(what: str/.test(py))
ok('MCP 有 bili_diary_write（日记写入端）', /async def bili_diary_write\(markdown: str/.test(py))
ok('MCP 有 bili_say（鱼说写入端）', /async def bili_say\(text: str/.test(py))
ok('值班章程要求写记忆/日记/鱼说', /bili_memory_append/.test(duty) && /bili_diary_write/.test(duty) && /bili_say/.test(duty))
ok('宿主 /pond 返回 say 字段', /say: \{ date: dayKey\(new Date\(\)\), text: say \}/.test(host))
const whitelistBlock = (host.match(/const mcpWhitelist =[\s\S]*?return list/) || [''])[0]
ok('值班工具白名单包含记忆 / 日记 / 鱼说', ['bili_memory_append', 'bili_diary_write', 'bili_say'].every((name) => whitelistBlock.includes(name)), '工具存在还不够，必须实际下发给值班轮')

/* ⭐ 1.3.12：圈地自萌 + 大主页快捷开关 */
ok('宿主 /pond 返回 config（首页开关读得到）', /config: cfg,[\s\S]{0,180}account:/.test(host))
ok('大主页有快捷开关区', /data-pond-quick/.test(client) && client.includes("['off', '关闭']") && client.includes("['circle', '圈地自萌']") && client.includes("['comment', '普通评论']"))
ok('快捷评论档位互斥保存', client.includes("{ autoComment: false, circleMode: true, replyToComments: false }") && client.includes("{ autoComment: true, circleMode: false, replyToComments: false }") && client.includes("{ autoComment: false, circleMode: false, replyToComments: false }"))
ok('快捷开关覆盖私信 / 自动运行 / 守护 / 转写', client.includes("quickSave({ dmOn: v }, '私信')") && ['自动运行', '评论区守护', '自动转写'].every((k) => client.includes(`quickSave({ autoRun: v }, '${k}')`) || client.includes(`quickSave({ guardOn: v }, '${k}')`) || client.includes(`quickSave({ transcribe: v }, '${k}')`)))
ok('快捷保存先锁住并发、失败回滚', /quickLock\.current = true/.test(client) && /config: previous/.test(client) && /await load\(\)/.test(client))
ok('圈地模式立即显示选中，成功后再交给配置状态', /setQuickCommentMode\(id\)/.test(client) && /quickCommentMode \|\| savedCommentMode/.test(client) && /\.then\(\(\) => setQuickCommentMode\(null\)\)/.test(client))
ok('从设置页返回首页会立刻重拉配置，绑定 UID 后状态不滞后', /if \(tab !== 'history'\) return[\s\S]{0,180}load\(\)[\s\S]{0,80}syncRun\(\)/.test(client))
ok('设置页绑定或保存后会把新配置同步给首页快捷区', /onConfigChanged\?\.\(p\)/.test(client) && /applyConfigPatch\(\{ mentionUid: uid, mentionName: r\.name \}\)/.test(client) && /applyConfigPatch\(\{ dmUid: uid \}\)/.test(client) && /onConfigChanged: \(p\) => setData/.test(client))
ok('快捷保存回包不覆盖刚点下的模式', /\{ \.\.\.\(prev\.config \|\| \{\}\), \.\.\.\(r\.config \|\| \{\}\), \.\.\.patch \}/.test(client))
ok('保存提示改为浮动弹窗，不再参与快捷区布局', /\.pond-quick-toast \{[^}]*position:fixed/.test(client) && /\.pond-quick-toast \{[^}]*right:24px/.test(client) && /role: 'status'/.test(client))
ok('保存提示会自动消失，不再常驻撑布局', /quickMsg\.tone === 'warn' \? 8000 : 2500/.test(client))
ok('评论与私信都只提示 UID 是否绑定', /mentionReady \? '@ 已绑定' : '@ 未绑定'/.test(client) && /dmReady \? 'UID 已绑定' : 'UID 未绑定'/.test(client) && !/普通评论还没设置「@ 谁」/.test(client))
ok('未绑定私信 UID 时不允许直接打开私信', /if \(v && !dmReady\)/.test(client) && /私信还没绑定 UID/.test(client))
ok('评论模式按钮不换行，避免四个字短暂变两行', /\.pond-quick-seg button \{[^}]*white-space:nowrap/.test(client) && /\.pond-quick-seg button \{[^}]*flex:0 0 auto/.test(client))
ok('大页面可直接切到完整设置', /className: 'pond-quick-more'[^}]*setTab\('settings'\)/.test(client))
ok('跑一轮 / 刷新已收进快捷操作区', (() => { const a = client.indexOf("key: 'quick'"); const b = client.indexOf("key: 'strip'", a); const q = client.slice(a, b); return q.includes("className: 'pond-quick-acts'") && q.includes("'data-primary': ''") && q.includes("'刷新'") && q.includes("'更多设置'") })())
ok('大主页内嵌设置固定单列，避免双列网格留下中间空洞', client.includes('[data-bd-page][data-bd-layout="embedded"]{grid-template-columns:minmax(0,1fr);}'))
ok('设置接口接受 circleMode', /'autoComment', 'circleMode', 'transcribe'/.test(host))
ok('圈地模式下普通宿主工具也有硬闸', /if \(cfg\.circleMode\)[\s\S]{0,160}禁止新楼/.test(host))
ok('overlay 注入 BILI_CIRCLE_MODE', host.includes("BILI_CIRCLE_MODE: '${cfg.circleMode ? '1' : '0'}'"))
ok('值班白名单包含圈地专用工具', whitelistBlock.includes('bili_circle_scan') && whitelistBlock.includes('bili_circle_reply'))
ok('圈地模式仅在有待回复守护项时放开 bili_reply', /!circleOnForWhitelist\(\) \|\| pending/.test(whitelistBlock), '缩小圈地模式下普通回复工具的暴露面')
ok('MCP bili_reply 在圈地模式拒绝新楼', /if rpid == 0 and os\.environ\.get\("BILI_CIRCLE_MODE"\) == "1"/.test(py) && /禁止发表任何新楼评论/.test(py))
ok('评论扫描返回视频 UP 的 mid', /"owner_mid": int\(owner\.get\("mid", 0\) or 0\)/.test(py))
ok('圈地扫描只认 UP 主本人一级评论', /c\["mid"\] != data\["owner_mid"\]/.test(py))
ok('邀请识别有否定词优先与固定邀请句式', /_CIRCLE_NEG = re\.compile/.test(py) && /_CIRCLE_POS =/.test(py) && /if _CIRCLE_NEG\.search\(value\)/.test(py))
ok('圈地回复禁止 rpid=0', /if target <= 0:[\s\S]{0,120}拒绝新楼/.test(py))
ok('圈地回复固定 root=parent=邀请评论', /root=target,[\s\S]{0,80}parent=target/.test(py))
ok('圈地回复按账号 + BV + 邀请 rpid 本地去重', /circle-log\.jsonl/.test(py) && /_circle_has_replied\(bvid, target\)/.test(py))
ok('圈地规则写进值班提示词与章程', /圈地自萌开着/.test(host) && /圈地自萌/.test(duty) && /绝不允许发新楼|绝不起新楼/.test(duty))

console.log(`✅ 大肥鱼整页校验通过（${pass} 条断言）`)
