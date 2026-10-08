#!/usr/bin/env node
// Checks every site in sites.json and says what's wrong. Read-only.
//
//   node check.mjs                 all sites
//   node check.mjs launchengine    sites whose name or url contains the word
//
// Optional environment:
//   NETLIFY_AUTH_TOKEN  confirms the published deploy is healthy (state,
//                       and that it matches the repo's branch when 'repo' is set)
//   GH_READ_TOKEN       reads the branch head of private repos
//
// Exit code 1 if any check fails. Writes failures.txt for the Slack step.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import tls from 'node:tls'

const CERT_WARN_DAYS = 14
const TIMEOUT_MS = 20_000
const EDGE_ERROR = 'edge function invocation failed'

const config = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8'))
const filter = (process.argv[2] || '').toLowerCase()
const sites = config.sites.filter(s => !filter || s.name.toLowerCase().includes(filter) || s.url.includes(filter))

const failures = []
const lines = []
const say = (ok, site, what, detail = '') => {
  const line = `  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`
  lines.push(line)
  console.log(line)
  if (!ok) failures.push(`${site.name}: ${what}${detail ? ` (${detail})` : ''}`)
}

async function fetchStatus(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'launchengine-site-monitor' }
    })
    const body = await res.text()
    return { status: res.status, location: res.headers.get('location') || '', body }
  } catch (e) {
    return { status: 0, location: '', body: '', error: e.name === 'AbortError' ? 'timed out' : e.message }
  } finally {
    clearTimeout(t)
  }
}

function certDaysLeft(host) {
  return new Promise(resolve => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate()
      sock.end()
      if (!cert || !cert.valid_to) return resolve({ error: 'no certificate' })
      resolve({ days: Math.floor((new Date(cert.valid_to) - Date.now()) / 86_400_000) })
    })
    sock.on('error', e => resolve({ error: e.message }))
    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timed out' }) })
  })
}

// Netlify: all sites across the teams the token can see, keyed by host.
async function netlifySites() {
  const token = process.env.NETLIFY_AUTH_TOKEN
  if (!token) return null
  const byHost = new Map()
  const byId = new Map()
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`https://api.netlify.com/api/v1/sites?filter=all&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) { console.log(`  warn  Netlify API ${res.status}; skipping deploy checks`); return null }
    const list = await res.json()
    for (const s of list) {
      byId.set(s.id, s)
      for (const h of [s.custom_domain, ...(s.domain_aliases || []), new URL(s.ssl_url || s.url).host]) if (h) byHost.set(h, s)
    }
    if (list.length < 100) break
  }
  return { byHost, byId }
}

async function branchHead(repo, branch) {
  const headers = { 'User-Agent': 'launchengine-site-monitor', Accept: 'application/vnd.github+json' }
  if (process.env.GH_READ_TOKEN) headers.Authorization = `Bearer ${process.env.GH_READ_TOKEN}`
  const res = await fetch(`https://api.github.com/repos/${repo}/branches/${branch}`, { headers })
  if (!res.ok) return null
  return (await res.json()).commit?.sha || null
}

const netlify = await netlifySites()

for (const site of sites) {
  console.log(`\n${site.name}  ${site.url}`)
  const host = new URL(site.url).host

  for (const p of site.pages || ['/']) {
    const page = typeof p === 'string' ? { path: p, status: 200 } : { status: 200, ...p }
    const r = await fetchStatus(site.url + page.path)
    if (r.error) say(false, site, `${page.path} loads`, r.error)
    else if (r.status !== page.status) say(false, site, `${page.path} loads`, `got ${r.status}, expected ${page.status}`)
    else if (r.body.toLowerCase().includes(EDGE_ERROR)) say(false, site, `${page.path} loads`, 'Netlify edge function crashed')
    else say(true, site, `${page.path} loads`)
  }

  for (const rd of site.redirects || []) {
    const r = await fetchStatus(rd.from)
    const ok = r.status === rd.status && r.location === rd.to
    say(ok, site, `${rd.from} redirects to ${rd.to}`, ok ? '' : `got ${r.status} ${r.location || r.error || ''}`.trim())
  }

  const cert = await certDaysLeft(host)
  if (cert.error) say(false, site, 'certificate valid', cert.error)
  else say(cert.days > CERT_WARN_DAYS, site, `certificate valid for ${cert.days} more days`, cert.days > CERT_WARN_DAYS ? '' : 'renew now')

  if (netlify) {
    const ns = site.netlify ? netlify.byId.get(site.netlify) : netlify.byHost.get(host)
    if (!ns) say(true, site, 'no Netlify site found for this host; deploy check skipped')
    else {
      const d = ns.published_deploy || {}
      say(d.state === 'ready', site, 'published Netlify deploy is healthy', d.state ? `state ${d.state}` : 'nothing published')
      if (site.repo && d.commit_ref) {
        const head = await branchHead(site.repo, site.branch || 'main')
        if (!head) say(true, site, `could not read ${site.repo} ${site.branch || 'main'}; drift check skipped`)
        else say(head === d.commit_ref, site, 'live deploy matches the repo', head === d.commit_ref ? '' : `live ${d.commit_ref.slice(0, 7)}, ${site.branch || 'main'} is ${head.slice(0, 7)}. A merge did not deploy; trigger a Netlify build.`)
      }
    }
  }
}

const summary = failures.length ? `${failures.length} problem${failures.length > 1 ? 's' : ''}:\n${failures.map(f => `• ${f}`).join('\n')}` : `All checks passed across ${sites.length} sites.`
console.log(`\n${summary}`)
writeFileSync('failures.txt', failures.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Site monitor\n\n${summary}\n\n<details><summary>Every check</summary>\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n</details>\n`)
process.exit(failures.length ? 1 : 0)
