/**
 * 历史记录数据层（2026-10-23 用户要的「看过的视频」页面）
 *
 * 原则（用户定的）：
 *  1. 数据里只存**原始事实**（时间戳、BV、标题、封面、UP、时长、播放量、命中关键词、
 *     选中还是跳过 + 原因、回了多少条）。分组/筛选一律在渲染时算，绝不把「今天/更早」
 *     这种派生结果存进文件 —— 以后想改分组规则不用重写历史。
 *  2. 缺的字段**不编**：老日报里没记封面/时长，就先留空，由 `enrich()` 事后现抓补齐。
 *
 * 存储：`<stateDir>/history.jsonl`，一行一条；同一 (date, bvid) 只留一条（后来者覆盖先来者）。
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const historyFile = (stateDir) => join(stateDir, 'history.jsonl')
export const cacheFile = (stateDir) => join(stateDir, 'video-cache.json')

const BV_RE = /BV[0-9A-Za-z]{10}/g

/** `2:17` / `1:02:33` → 秒 */
const toSeconds = (s) => {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return 0
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])
}

const clean = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/^[_*\s]+|[_*\s]+$/g, '').trim()

/**
 * 解析一份日报 markdown → 历史条目（不含封面等需要联网的字段）。
 * 日报格式是模型写的，所以这里只认「结构稳的那几样」：
 *   `## 这一轮挑中：N 条` 段落里的 `- BVxxx · 标题 · UP · 2:17 · 理由` = 挑中
 *   `### 看过但跳过` 段落里同样格式 = 跳过（理由就是跳过原因）
 *   `### 其他搜索结果处理` 里的 BV 号 = 跳过（按 ①②③ 分类给个粗原因）
 */
export const harvestReport = (mdPath, { source = 'duty' } = {}) => {
  const text = readFileSync(mdPath, 'utf8')
  const file = mdPath.replace(/\\/g, '/').split('/').pop()
  const date = (file.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || ''
  let ts = 0
  try { ts = Math.floor(statSync(mdPath).mtimeMs) } catch { ts = Date.now() }

  const kwLine = text.match(/关键词[：:]\s*`([^`]+)`/)
  const keywords = kwLine ? kwLine[1].split(/[、,，]+/).map((s) => s.trim()).filter(Boolean) : []

  const out = []
  let section = 'other'
  let cur = null // 老格式：`### BVxxx` 下面用 `- 标题：…` 逐行交代
  const mk = (bvid) => ({
    ts, date, bvid, source,
    title: '', owner: '', duration: 0, views: 0,
    picked: false, skipReason: '', note: '',
    replyCount: 0, keywords: [...keywords], reportRef: file,
  })
  const push = (bvid, rest, picked, skipReason) => {
    const parts = String(rest || '').split('·').map(clean).filter(Boolean)
    const e = mk(bvid)
    e.title = parts[0] || ''
    e.owner = parts[1] || ''
    e.duration = toSeconds(parts[2] || '')
    e.picked = picked
    e.skipReason = picked ? '' : (skipReason || parts[3] || '')
    e.note = picked ? (parts[3] || '') : ''
    out.push(e)
    return e
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    // 老格式：`### BVxxxx` 是一条视频的小节
    const h3bv = line.match(/^###\s+(BV[0-9A-Za-z]{10})\s*$/)
    if (h3bv) {
      cur = mk(h3bv[1])
      cur.picked = true // 老日报里单独开小节的都是挑中的
      out.push(cur)
      section = 'picked'
      continue
    }
    if (cur) {
      const t = line.match(/^[-*]\s*标题[：:]\s*(.+)$/)
      if (t) { cur.title = clean(t[1]); continue }
      const u = line.match(/^[-*]\s*UP[：:]\s*([^｜|]+)(?:[｜|]\s*播放[：:]\s*([\d.万]+))?/)
      if (u) {
        cur.owner = clean(u[1])
        const v = String(u[2] || '').trim()
        if (v) cur.views = v.includes('万') ? Math.round(parseFloat(v) * 10000) : Number(v) || 0
        continue
      }
      if (/^#{2,3}\s/.test(line)) cur = null // 小节结束
      else continue
    }

    if (/^##\s/.test(line)) {
      if (/挑中/.test(line)) section = 'picked'
      else if (/跳过|其他搜索结果/.test(line)) section = 'skipped'
      else section = 'other'
      continue
    }
    if (/^###\s/.test(line)) {
      if (/跳过/.test(line)) section = 'skipped'
      else if (/挑中|推荐/.test(line)) section = 'picked'
      continue
    }
    const bullet = line.match(/^[-*]\s+(BV[0-9A-Za-z]{10})\s*·?\s*(.*)$/)
    if (bullet) {
      const picked = section === 'picked'
      push(bullet[1], bullet[2], picked, picked ? '' : '')
      continue
    }
    // 「其他搜索结果处理」里的裸 BV 号（① 超时长 / ② 已看过 / ③ 太短）
    if (section === 'skipped' && /^[-*]/.test(line)) {
      const ids = line.match(BV_RE)
      if (!ids) continue
      const reason = /超.{0,4}时长|窗口/.test(line) ? '超出时长窗口'
        : /seen|已看过|判重/.test(line) ? '已看过'
          : /短于|低于时长/.test(line) ? '短于时长下限'
            : '其他搜索结果'
      for (const id of ids) push(id, '', false, reason)
    }
  }
  return out
}

/** 读全部历史（按 (date,bvid) 去重，后来的覆盖先来的） */
export const readHistory = (stateDir) => {
  const p = historyFile(stateDir)
  if (!existsSync(p)) return []
  const map = new Map()
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && e.bvid) map.set(`${e.date}|${e.bvid}`, e)
    } catch { /* 半行，跳过 */ }
  }
  return [...map.values()]
}

/** 追加条目（同 (date,bvid) 的旧行会被后来的覆盖；文件超 2MB 先轮转） */
export const appendHistory = (stateDir, entries) => {
  if (!entries.length) return 0
  const p = historyFile(stateDir)
  let kept = []
  if (existsSync(p)) {
    const size = readFileSync(p).length
    if (size > 2 * 1024 * 1024) {
      try { renameSync(p, p + '.1') } catch { /* 轮转失败不影响写入 */ }
    } else {
      const seen = new Set(entries.map((e) => `${e.date}|${e.bvid}`))
      kept = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => {
        if (!l.trim()) return false
        try { const e = JSON.parse(l); return !seen.has(`${e.date}|${e.bvid}`) } catch { return false }
      })
    }
  }
  const lines = [...kept, ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n'
  writeFileSync(p, lines)
  return entries.length
}

const loadCache = (stateDir) => {
  const p = cacheFile(stateDir)
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) || {} } catch { return {} }
}
const saveCache = (stateDir, cache) => {
  try { writeFileSync(cacheFile(stateDir), JSON.stringify(cache)) } catch { /* 缓存写不了不算错 */ }
}

/**
 * 联网补齐封面/时长/播放量等（老日报里没有的）。
 * 抓不到的**留空**，不编。带本地缓存，不会重复请求。
 */
export const enrich = async (stateDir, entries, { limit = 200, gapMs = 320, log = () => {} } = {}) => {
  const cache = loadCache(stateDir)
  const need = entries.filter((e) => (!e.pic || !e.duration) && !cache[e.bvid])
  let n = 0
  for (const e of need.slice(0, limit)) {
    try {
      const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${e.bvid}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      })
      const j = await r.json()
      if (j.code !== 0) { cache[e.bvid] = { fail: true }; continue }
      const d = j.data || {}
      cache[e.bvid] = {
        title: d.title || '',
        pic: String(d.pic || '').replace(/^http:/, 'https:'),
        owner: d.owner?.name || '',
        ownerMid: d.owner?.mid || 0,
        duration: d.duration || 0,
        pubdate: d.pubdate || 0,
        views: d.stat?.view || 0,
      }
      n++
    } catch { cache[e.bvid] = { fail: true } }
    await new Promise((r) => setTimeout(r, gapMs))
  }
  saveCache(stateDir, cache)
  for (const e of entries) {
    const c = cache[e.bvid]
    if (!c || c.fail) continue
    if (!e.title && c.title) e.title = c.title
    if (!e.pic && c.pic) e.pic = c.pic
    if (!e.owner && c.owner) e.owner = c.owner
    if (!e.duration && c.duration) e.duration = c.duration
    if (!e.pubdate) e.pubdate = c.pubdate || 0
    if (!e.views) e.views = c.views || 0
    if (!e.ownerMid) e.ownerMid = c.ownerMid || 0
  }
  if (n) log(`补齐了 ${n} 条视频的封面/时长`)
  return n
}

/** 把 out/*.md 全部回填一遍（幂等：同 (date,bvid) 覆盖） */
export const backfillReports = (stateDir, { log = () => {} } = {}) => {
  const dir = join(stateDir, 'out')
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
  const all = []
  for (const f of files) {
    try { all.push(...harvestReport(join(dir, f))) } catch (e) { log(`回填 ${f} 失败：${e.message}`) }
  }
  return all
}
