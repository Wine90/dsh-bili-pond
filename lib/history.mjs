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
const TOKEN_RE = /BV[0-9A-Za-z]{10}/
export const isBvid = (s) => /^BV[0-9A-Za-z]{10}$/.test(String(s || ''))
const entryKey = (e) => `${e.date || ''}|${e.bvid || ''}`

const viewCount = (n, wan) => Math.round((Number(n) || 0) * (wan ? 10000 : 1))
const skipReasonOf = (line, fallback = '') => (
  /超.{0,4}时长|窗口/.test(line) ? '超出时长窗口'
    : /seen|已看过|判重/.test(line) ? '已看过'
      : /短于|低于时长/.test(line) ? '短于时长下限'
        : (fallback || '其他搜索结果')
)

/**
 * 解析一份日报 markdown → 历史条目（不含封面等需要联网的字段）。
 *
 * 同时兼容两类真实格式：
 *  1. 章程规定的 `### BV号`，下一行用 `- **标题**：…` / `- **UP**：…` 交代字段；
 *  2. 模型实际写出的 `### 1. 标题 — UP — 1.5万播放`，下一行才出现 BV。
 *
 * ⚠️ 分组只由 H2 / 明确的小节标题决定，绝不从视频标题里猜「跳过 / 推荐」。
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
  const byBvid = new Map()
  let section = 'other'
  let sectionReason = ''
  let cur = null // `### BV号` 小节里的当前视频
  let pending = null // 新格式：标题行已出现，等下一非空行给 BV
  const mk = (bvid) => ({
    ts, date, bvid, source,
    title: '', owner: '', duration: 0, views: 0,
    picked: false, skipReason: '', note: '',
    replyCount: 0, keywords: [...keywords], reportRef: file,
  })
  const firstBv = (line) => (String(line || '').match(TOKEN_RE) || [])[0] || ''
  const headingMeta = (valueText) => {
    const value = clean(valueText)
    const parts = value.split(/\s+[—–-]\s+/).map(clean).filter(Boolean)
    const last = parts[parts.length - 1] || ''
    const stat = last.match(/([\d.]+)\s*(万)?\s*播放/)
    const views = stat ? viewCount(stat[1], stat[2]) : 0
    let title = value
    let owner = ''
    if (stat && parts.length >= 3) {
      title = parts.slice(0, -2).join(' — ')
      owner = parts[parts.length - 2]
    } else if (stat && parts.length === 2) {
      title = parts[0]
    } else if (!stat && parts.length >= 2) {
      title = parts.slice(0, -1).join(' — ')
      owner = parts[parts.length - 1]
    }
    return { title: title || value, owner, views }
  }
  const remember = (entry) => {
    const old = byBvid.get(entry.bvid)
    if (!old) {
      byBvid.set(entry.bvid, entry)
      out.push(entry)
      return entry
    }
    if (!old.title && entry.title) old.title = entry.title
    if (!old.owner && entry.owner) old.owner = entry.owner
    if (!old.duration && entry.duration) old.duration = entry.duration
    if (!old.views && entry.views) old.views = entry.views
    if (!old.note && entry.note) old.note = entry.note
    old.replyCount = Math.max(old.replyCount || 0, entry.replyCount || 0)
    // 同一 BV 只可能出现一个最终状态：挑中优先，并且不能带着旧的跳过原因。
    if (entry.picked) {
      old.picked = true
      old.skipReason = ''
    } else if (!old.picked && !old.skipReason && entry.skipReason) {
      old.skipReason = entry.skipReason
    }
    return old
  }
  const pushBullet = (line, ids, picked) => {
    const bvid = ids[0]
    const after = clean(line.slice(line.indexOf(bvid) + bvid.length).replace(/^[`*\s·—–-]+/, ''))
    const parts = after.split('·').map(clean).filter(Boolean)
    const e = mk(bvid)
    if (parts.length >= 2) {
      e.title = parts[0] || ''
      e.owner = parts[1] || ''
      e.duration = toSeconds(parts[2] || '')
      e.note = picked ? (parts[3] || '') : ''
    } else if (parts.length === 1) {
      // 备选常用 `- BV号 标题（UP，播放量）`，标题字段不可靠；先记作备注，让 enrich 补官方标题。
      e.note = parts[0]
    }
    e.picked = picked
    e.skipReason = picked ? '' : skipReasonOf(line, sectionReason)
    return remember(e)
  }
  const setH2Section = (line) => {
    section = 'other'
    sectionReason = ''
    if (/挑中|推荐/.test(line)) section = 'picked'
    else if (/备选/.test(line)) { section = 'skipped'; sectionReason = '备选' }
    else if (/跳过|其他搜索结果|没碰|过滤|取舍/.test(line)) { section = 'skipped'; sectionReason = '其他搜索结果' }
  }
  const setH3Section = (label) => {
    // 只认完整的小节名；不能把「推荐系统入门」「跳过这个坑」这类视频标题当分组。
    const key = clean(label).replace(/[：:（(].*$/, '').trim()
    if (/^(?:挑中|这一轮挑中|推荐)$/.test(key)) { section = 'picked'; sectionReason = ''; return true }
    if (key === '备选') { section = 'skipped'; sectionReason = '备选'; return true }
    if (/^(?:看过但跳过|跳过|其他搜索结果(?:处理)?|这轮没碰|过滤掉?)$/.test(key)) {
      section = 'skipped'
      sectionReason = /^其他搜索结果/.test(key) ? '其他搜索结果' : '跳过'
      return true
    }
    if (/^(?:评论复核|评论记录|私信|总结|这轮总结)$/.test(key)) {
      section = 'other'
      sectionReason = ''
      return true
    }
    return false
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (/^##\s/.test(line)) {
      setH2Section(line)
      cur = null
      pending = null
      continue
    }

    if (/^###\s/.test(line)) {
      const h3bv = line.match(/^###\s+(?:BV([0-9A-Za-z]{10})|(?:\d+[.、]\s*)?BV([0-9A-Za-z]{10}))\s*[·—–-]?\s*(.*)$/)
      if (h3bv) {
        const bvid = `BV${h3bv[1] || h3bv[2]}`
        const meta = h3bv[3] ? headingMeta(h3bv[3]) : { title: '', owner: '', views: 0 }
        const e = mk(bvid)
        e.picked = section !== 'skipped'
        e.skipReason = e.picked ? '' : (sectionReason || '跳过')
        e.title = meta.title
        e.owner = meta.owner
        e.views = meta.views
        cur = remember(e)
        pending = null
        continue
      }

      const label = clean(line.replace(/^###\s+/, ''))
      const looksVideo = /^\d+[.、]\s+/.test(label) || /\s+[—–-]\s+/.test(label) || /播放/.test(label)
      if (!looksVideo && setH3Section(label)) {
        cur = null
        pending = null
        continue
      }

      // 只有像视频标题的 H3 才进入 pending；普通说明性小标题不改变分组。
      const titleLabel = label.replace(/^\d+[.、]\s*/, '')
      pending = looksVideo ? headingMeta(titleLabel) : null
      cur = null
      continue
    }

    // 新格式：标题在上一行，BV 在这一行。
    if (pending) {
      const bvid = firstBv(line)
      if (bvid) {
        const e = mk(bvid)
        e.picked = section === 'picked'
        e.skipReason = e.picked ? '' : (sectionReason || '跳过')
        e.title = pending.title
        e.owner = pending.owner
        e.views = pending.views
        cur = remember(e)
        pending = null
        continue
      }
      // pending 只在紧邻的下一非空行有效，避免后面某个无关 BV 被挂到错误标题上。
      pending = null
    }

    if (cur) {
      const body = clean(line.replace(/^[-*]\s+/, ''))
      let m = body.match(/^标题[：:]\s*(.+)$/)
      if (m) { cur.title = clean(m[1]); continue }
      m = body.match(/^UP(?:主)?[：:]\s*(.*)$/)
      if (m) {
        const [ownerPart, ...rest] = m[1].split(/[｜|]/).map(clean)
        cur.owner = clean(ownerPart || '')
        const tail = rest.join(' ')
        const vm = tail.match(/播放(?:量)?[：:]\s*([\d.]+)\s*(万)?/)
        if (vm) cur.views = viewCount(vm[1], vm[2])
        const dm = tail.match(/时长[：:]\s*([0-9:]+)/)
        if (dm) cur.duration = toSeconds(dm[1])
        continue
      }
      m = body.match(/^播放(?:量)?[：:]\s*([\d.]+)\s*(万)?/)
      if (m) { cur.views = viewCount(m[1], m[2]); continue }
      m = body.match(/^时长[：:]\s*([0-9:]+)/)
      if (m) { cur.duration = toSeconds(m[1]); continue }
      m = body.match(/^内容[：:]\s*(.*)$/)
      if (m) { cur.note = clean(m[1]); continue }
      m = body.match(/^为什么值得[^：:]*[：:]\s*(.*)$/)
      if (m) { if (!cur.note) cur.note = clean(m[1]); continue }
      if (/^已评论/.test(body)) cur.replyCount += 1
      continue
    }

    if (/^[-*]/.test(line) && section !== 'other') {
      const ids = line.match(BV_RE)
      if (!ids) continue
      for (const id of ids) pushBullet(line, [id], section === 'picked')
    }
  }
  return out
}

/** 读全部历史（按 (date,bvid) 去重，按日期从新到旧） */
export const readHistory = (stateDir) => {
  const p = historyFile(stateDir)
  if (!existsSync(p)) return []
  const map = new Map()
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && isBvid(e.bvid)) map.set(entryKey(e), e)
    } catch { /* 半行 / 旧坏行，跳过 */ }
  }
  return [...map.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
}

/** 追加条目（同 (date,bvid) 的旧行会被后来的覆盖；非法 BVID 不落盘） */
export const appendHistory = (stateDir, entries) => {
  const freshMap = new Map()
  for (const e of entries || []) {
    if (e && isBvid(e.bvid)) freshMap.set(entryKey(e), e)
  }
  const fresh = [...freshMap.values()]
  if (!fresh.length) return 0
  const p = historyFile(stateDir)
  let kept = []
  if (existsSync(p)) {
    const size = readFileSync(p).length
    if (size > 2 * 1024 * 1024) {
      try { renameSync(p, p + '.1') } catch { /* 轮转失败不影响写入 */ }
    } else {
      const seen = new Set(fresh.map(entryKey))
      kept = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => {
        if (!l.trim()) return false
        try {
          const e = JSON.parse(l)
          return isBvid(e?.bvid) && !seen.has(entryKey(e))
        } catch { return false }
      })
    }
  }
  const lines = [...kept, ...fresh.map((e) => JSON.stringify(e))].join('\n') + '\n'
  writeFileSync(p, lines)
  return fresh.length
}

/** 用一份完整集合重写历史（回填 / 修复旧坏行时用） */
export const replaceHistory = (stateDir, entries) => {
  const map = new Map()
  for (const e of entries || []) {
    if (e && isBvid(e.bvid)) map.set(entryKey(e), e)
  }
  const list = [...map.values()]
  writeFileSync(historyFile(stateDir), list.length ? list.map((e) => JSON.stringify(e)).join('\n') + '\n' : '')
  return list.length
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
export const enrich = async (stateDir, entries, { limit = 200, gapMs = 320, timeoutMs = 5000, log = () => {} } = {}) => {
  const cache = loadCache(stateDir)
  const need = entries.filter((e) => (!e.pic || !e.duration) && !cache[e.bvid])
  let n = 0
  for (const e of need.slice(0, limit)) {
    try {
      const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${e.bvid}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 5000)),
      })
      const j = await r.json()
      if (j.code !== 0) throw new Error(`bilibili code ${j.code}`)
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
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
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
