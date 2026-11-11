#!/usr/bin/env node
// Google indexing watch for every site in sites.json that has a 'searchConsole' block.
//
//   node indexing.mjs                  sitemap check; inspection too when the last one is 20+ hours old
//   node indexing.mjs --inspect        force the inspection pass
//   node indexing.mjs --dry-run        read-only: no sitemap submit, no Slack (prints the
//                                      message instead), state file left as it was
//   node indexing.mjs launchengine     only sites whose name or url contains the word
//
// What it does, per site:
//   1. Fetches the live sitemap (follows sitemap index files), hashes the URL list
//      and lastmods, and calls Search Console sitemaps.submit when the hash changed
//      (only when searchConsole.submit is true). Reads Search Console's own report
//      on that sitemap and flags errors.
//   2. Inspection pass (daily): every sitemap URL must answer 200 (a redirect or 404
//      is a sitemap bug), then the URL Inspection API says whether Google indexed it.
//      Pages first seen 7+ days ago and still not indexed are reported.
//   3. One Slack message per run for everything new. The same page is not reported
//      again for 7 days.
//
// Google has no API for Search Console's "Request indexing" button, and the
// Indexing API is only for job posting and livestream pages, so it is not used.
//
// Environment:
//   GSC_SERVICE_ACCOUNT_JSON   the service account key file's full JSON. Missing:
//                              warns and exits 0, so nothing goes red.
//   GSC_SERVICE_ACCOUNT_FILE   local alternative: path to the key file
//   SLACK_ALERT_WEBHOOK_URL    where the report goes. Missing with something to
//                              report: exits 1 so GitHub's failure email is the alert.
//   INDEXING_STATE             state file path (default indexing-state.json)
//   STUCK_AFTER_DAYS           days a page may wait before it's reported (default 7)

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { createSign, createHash } from 'node:crypto'

const DAY = 86_400_000
const STUCK_AFTER_DAYS = Number(process.env.STUCK_AFTER_DAYS ?? 7)
const REALERT_DAYS = 7
const SITE_REALERT_DAYS = 1
const INSPECT_EVERY_HOURS = 20
const INSPECT_CAP = 500
const INSPECT_PARALLEL = 5
const TIMEOUT_MS = 20_000
const UA = 'launchengine-site-monitor'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const forceInspect = args.includes('--inspect')
const filter = (args.find(a => !a.startsWith('--')) || '').toLowerCase()

const statePath = process.env.INDEXING_STATE || 'indexing-state.json'
const config = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8'))
const sites = config.sites.filter(s => s.searchConsole?.property)
  .filter(s => !filter || s.name.toLowerCase().includes(filter) || s.url.includes(filter))

const now = Date.now()
const today = new Date(now).toISOString().slice(0, 10)
const daysSince = iso => iso ? Math.floor((now - Date.parse(iso)) / DAY) : Infinity

// ---------- Google auth (service account JWT, RS256, no dependencies) ----------

function loadKey() {
  if (process.env.GSC_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON)
  if (process.env.GSC_SERVICE_ACCOUNT_FILE) return JSON.parse(readFileSync(process.env.GSC_SERVICE_ACCOUNT_FILE, 'utf8'))
  return null
}

const b64url = buf => Buffer.from(buf).toString('base64url')

async function accessToken(key) {
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600
  }))
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` })
  })
  // Never print the response body here: on success it holds the token.
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`)
  return (await res.json()).access_token
}

let token
async function google(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 200)
    try { msg = JSON.parse(text).error?.message || msg } catch {}
    const e = new Error(`${res.status} ${msg}`)
    e.status = res.status
    throw e
  }
  return text ? JSON.parse(text) : {}
}

const enc = encodeURIComponent
const sitemapsApi = (property, feed) => `https://www.googleapis.com/webmasters/v3/sites/${enc(property)}/sitemaps/${enc(feed)}`
const inspectLink = (property, url) => `https://search.google.com/search-console/inspect?resource_id=${enc(property)}&id=${enc(url)}`

// ---------- Sitemap ----------

async function get(url, redirect = 'follow') {
  const res = await fetch(url, { redirect, headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, location: res.headers.get('location') || '', body: redirect === 'follow' ? await res.text() : (await res.body?.cancel(), '') }
}

const decode = s => s.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : '' }

// Returns [{ loc, lastmod }] across a sitemap or sitemap index (one level of nesting).
async function readSitemap(url, depth = 0) {
  const r = await get(url)
  if (r.status !== 200) throw new Error(`${url} answered ${r.status}`)
  if (/<sitemapindex[\s>]/.test(r.body)) {
    if (depth > 1) throw new Error(`${url}: sitemap index nested too deep`)
    const out = []
    for (const block of r.body.match(/<sitemap>[\s\S]*?<\/sitemap>/g) || []) out.push(...await readSitemap(tag(block, 'loc'), depth + 1))
    return out
  }
  if (!/<urlset[\s>]/.test(r.body)) throw new Error(`${url} is not a sitemap`)
  return (r.body.match(/<url>[\s\S]*?<\/url>/g) || []).map(b => ({ loc: tag(b, 'loc'), lastmod: tag(b, 'lastmod') })).filter(u => u.loc)
}

// ---------- Plain words for Google's coverage states ----------

const PLAIN = {
  'discovered - currently not indexed': "Google found it but hasn't crawled it yet",
  'crawled - currently not indexed': 'Google crawled it but chose not to index it (yet)',
  'url is unknown to google': "Google hasn't found it yet",
  "excluded by 'noindex' tag": 'the page tells Google not to index it (noindex)',
  'blocked by robots.txt': 'robots.txt blocks Google from crawling it',
  'page with redirect': 'Google sees a redirect here',
  'not found (404)': 'Google got a 404',
  'soft 404': 'Google thinks the page is empty (soft 404)',
  'server error (5xx)': 'Google got a server error',
  'duplicate, google chose different canonical than user': 'Google treats it as a copy of another page',
  'duplicate without user-selected canonical': 'Google treats it as a copy of another page (no canonical set)',
  'alternate page with proper canonical tag': 'its canonical tag points at another URL, so Google indexes that one. List the canonical URL in the sitemap instead',
  'blocked due to unauthorized request (401)': 'Google got a 401 (login wall)',
  'blocked due to access forbidden (403)': 'Google got a 403'
}
const plain = state => PLAIN[(state || '').toLowerCase()] || (state ? `Google says: ${state}` : 'Google gave no coverage state')

// ---------- State ----------

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
state.sites ||= {}

const alerts = []                 // { site, lines: [] }
const notes = []                  // console only
const report = (site, key, text, realertDays) => {
  const s = state.sites[site.name]
  s.alerted ||= {}
  if (daysSince(s.alerted[key]) < realertDays) return notes.push(`${site.name}: already reported ${daysSince(s.alerted[key])}d ago: ${key}`)
  s.alerted[key] = new Date(now).toISOString()
  let a = alerts.find(x => x.site === site)
  if (!a) alerts.push(a = { site, lines: [] })
  a.lines.push(text)
}

// ---------- Main ----------

const key = loadKey()
if (!key) {
  const msg = 'GSC_SERVICE_ACCOUNT_JSON is not set; indexing check skipped. Add it as a repo secret (see README).'
  console.log(process.env.CI ? `::warning::${msg}` : msg)
  process.exit(0)
}
token = await accessToken(key)

const inspectDue = forceInspect || (now - Date.parse(state.lastInspection || 0)) / 3_600_000 >= INSPECT_EVERY_HOURS
console.log(`Indexing check for ${sites.length} site(s); inspection ${inspectDue ? 'runs' : 'not due'} this time.`)

for (const site of sites) {
  const sc = site.searchConsole
  const property = sc.property
  const feed = sc.sitemap || new URL('/sitemap.xml', site.url).href
  const s = state.sites[site.name] ||= { urls: {} }
  const first = !s.sitemapHash
  console.log(`\n${site.name}  ${feed}  (${property}, ${sc.submit ? 'submit' : 'watch only'})`)

  let entries
  try {
    entries = await readSitemap(feed)
    console.log(`  sitemap: ${entries.length} URLs`)
  } catch (e) {
    report(site, 'sitemap-fetch', `Couldn't read the sitemap: ${e.message}`, SITE_REALERT_DAYS)
    continue
  }

  // First-seen dates. On the very first run a site has no history, so an older
  // lastmod stands in (the page existed at least since then).
  for (const { loc, lastmod } of entries) {
    if (s.urls[loc]) continue
    const lm = Date.parse(lastmod)
    s.urls[loc] = { firstSeen: first && lm && lm < now ? new Date(lm).toISOString().slice(0, 10) : today }
  }
  const live = new Set(entries.map(e => e.loc))
  for (const u of Object.keys(s.urls)) if (!live.has(u)) delete s.urls[u]

  const hash = createHash('sha256').update(entries.map(e => `${e.loc} ${e.lastmod}`).sort().join('\n')).digest('hex')
  if (hash !== s.sitemapHash) {
    if (sc.submit && dryRun) console.log('  sitemap changed: would submit to Google (dry run)')
    else if (sc.submit) {
      try {
        await google('PUT', sitemapsApi(property, feed))
        console.log('  sitemap changed: submitted to Google')
        s.sitemapHash = hash
        s.lastSubmitted = new Date(now).toISOString()
      } catch (e) {
        report(site, 'sitemap-submit', `Couldn't resubmit the sitemap to Google: ${e.message}`, SITE_REALERT_DAYS)
      }
    } else {
      console.log('  sitemap changed (watch only, not submitted)')
      s.sitemapHash = hash
    }
  } else console.log('  sitemap unchanged')

  try {
    const sm = await google('GET', sitemapsApi(property, feed))
    const errs = Number(sm.errors || 0), warns = Number(sm.warnings || 0)
    console.log(`  Search Console: last read ${sm.lastDownloaded || 'never'}, ${errs} errors, ${warns} warnings`)
    if (errs) report(site, `sitemap-errors-${errs}`, `Search Console reports ${errs} error${errs > 1 ? 's' : ''} in the sitemap. <https://search.google.com/search-console/sitemaps?resource_id=${enc(property)}|Open Sitemaps>`, SITE_REALERT_DAYS)
  } catch (e) {
    if (e.status === 404) notes.push(`${site.name}: Search Console has no record of ${feed} yet`)
    else notes.push(`${site.name}: couldn't read Search Console's sitemap report (${e.message})`)
  }

  if (!inspectDue) continue

  // Rotate: least recently inspected first, capped per run.
  const queue = [...live].sort((a, b) => (s.urls[a].inspected || '').localeCompare(s.urls[b].inspected || '')).slice(0, INSPECT_CAP)
  // Each inspection takes a few seconds, so a few run at once (well under the
  // 600 per minute limit). Results are reported in sitemap order afterwards.
  let stop = null
  const check = async url => {
    let r
    try { r = await get(url, 'manual') } catch (e) { r = { status: 0, error: e.message } }
    if (r.status !== 200 || stop) return { url, page: r }
    try {
      const res = await google('POST', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: property, languageCode: 'en-US' })
      return { url, page: r, ix: res.inspectionResult?.indexStatusResult || {} }
    } catch (e) {
      if (e.status === 429 || e.status === 403) stop ||= e
      return { url, page: r, error: e }
    }
  }
  const results = []
  for (let i = 0; i < queue.length; i += INSPECT_PARALLEL) results.push(...await Promise.all(queue.slice(i, i + INSPECT_PARALLEL).map(check)))

  let inspected = 0, indexed = 0
  for (const { url, page: r, ix, error } of results) {
    const u = s.urls[url]
    const path = new URL(url).pathname || '/'
    if (r.status >= 300 && r.status < 400) {
      console.log(`  BUG   ${path}  (redirects to ${r.location})`)
      report(site, `redirect ${url}`, `<${url}|${path}>: in the sitemap but redirects to ${r.location || '(no location)'}. Take it out of the sitemap.`, REALERT_DAYS)
    } else if (r.status === 404 || r.status === 410) {
      console.log(`  BUG   ${path}  (${r.status})`)
      report(site, `gone ${url}`, `<${url}|${path}>: in the sitemap but answers ${r.status}. Take it out of the sitemap.`, REALERT_DAYS)
    } else if (r.status !== 200) {
      console.log(`  BUG   ${path}  (${r.error || r.status})`)
      report(site, `status ${url}`, `<${url}|${path}>: answers ${r.error || r.status}`, REALERT_DAYS)
    } else if (error) {
      if (error.status !== 429 && error.status !== 403) notes.push(`${site.name}: couldn't inspect ${path} (${error.message})`)
    } else if (ix) {
      Object.assign(u, { inspected: new Date(now).toISOString(), verdict: ix.verdict, coverage: ix.coverageState, lastCrawl: ix.lastCrawlTime })
      inspected++
      console.log(`  ${ix.verdict === 'PASS' ? 'ok  ' : 'NOT '}  ${path}  (${ix.coverageState || ix.verdict})`)
      if (ix.verdict === 'PASS') { indexed++; delete s.alerted?.[`stuck ${url}`]; continue }
      const age = daysSince(u.firstSeen)
      if (age < STUCK_AFTER_DAYS) { notes.push(`${site.name}: ${path} not indexed yet (${ix.coverageState}), first seen ${age}d ago, waiting`); continue }
      const crawled = ix.lastCrawlTime ? `, last crawled ${ix.lastCrawlTime.slice(0, 10)}` : ''
      report(site, `stuck ${url}`, `<${url}|${path}>: ${plain(ix.coverageState)}. First seen ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}${crawled}. <${inspectLink(property, url)}|Inspect>`, REALERT_DAYS)
    }
  }
  if (stop?.status === 429) notes.push(`${site.name}: inspection quota reached, the rest wait for the next run`)
  if (stop?.status === 403) report(site, 'inspect-denied', `Google won't let the monitor inspect ${property} pages (${stop.message}). Check the service account's access.`, SITE_REALERT_DAYS)
  console.log(`  inspected ${inspected} of ${live.size}: ${indexed} indexed`)
}

if (inspectDue && !filter) state.lastInspection = new Date(now).toISOString()
for (const n of notes) console.log(`  note: ${n}`)

let exit = 0
if (alerts.length) {
  const count = alerts.reduce((n, a) => n + a.lines.length, 0)
  const run = process.env.GITHUB_RUN_ID ? `\n<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}|Details>` : ''
  const text = `:mag: *Indexing: ${count} thing${count > 1 ? 's' : ''} Google needs a hand with*\n` +
    alerts.map(a => `*${a.site.name}*\n${a.lines.map(l => `• ${l}`).join('\n')}`).join('\n\n') + run
  const hook = process.env.SLACK_ALERT_WEBHOOK_URL
  if (dryRun) console.log(`\n--- Slack message (dry run, not posted) ---\n${text}\n---`)
  else if (!hook) { console.log(`\n${text}\n\nNo Slack webhook set; failing so GitHub's failure email is the alert.`); exit = 1 }
  else {
    const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    console.log(res.ok ? `\nPosted ${count} item(s) to Slack.` : `\nSlack answered ${res.status}`)
    if (!res.ok) exit = 1
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Indexing\n\n${text}\n`)
} else console.log('\nNothing new to report.')

if (!dryRun) writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
process.exit(exit)
