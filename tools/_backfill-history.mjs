import { appendHistory, backfillReports, enrich, readHistory } from '../lib/history.mjs'

const stateDir = process.argv[2] || 'C:\\Users\\MYPangYang\\.dsh\\bili-duty'
const log = (m) => console.log('[history]', m)

const harvested = backfillReports(stateDir, { log })
log(`从 ${new Set(harvested.map((e) => e.reportRef)).size} 份日报解析出 ${harvested.length} 条`)
const added = appendHistory(stateDir, harvested)
log(`写入 ${added} 条`)

const all = readHistory(stateDir)
const before = all.filter((e) => e.pic).length
await enrich(stateDir, all, { log })
const after = all.filter((e) => e.pic).length
log(`封面覆盖：${before} → ${after} / ${all.length}`)

appendHistory(stateDir, all)
const picked = all.filter((e) => e.picked).length
log(`总计 ${all.length} 条（挑中 ${picked} / 跳过 ${all.length - picked}）`)
const byDate = {}
for (const e of all) byDate[e.date] = (byDate[e.date] || 0) + 1
log('按天：' + Object.entries(byDate).sort().map(([d, n]) => `${d}=${n}`).join(' '))
