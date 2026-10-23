#!/usr/bin/env node
// Does every form on every site in forms.json reach where it must? See FORMS.md.
//
//   node forms.mjs [site]           setup: every live form has a route, Netlify
//                                   collects it, someone is emailed, monday and
//                                   the workspace are set up. Sends nothing.
//   node forms.mjs --test [site]    also sends one signed test through each form:
//                                   email in SendGrid's sandbox, lead as a dry run,
//                                   then deletes the test. Never reaches a person.
//   node forms.mjs --count [site]   also checks every real submission of the last
//                                   26 hours was emailed and every lead reached the
//                                   workspace and monday.
//
// Environment: NETLIFY_AUTH_TOKEN, FORM_CHECK_SECRET (required); FORMS_URL (optional, a preview).
// Exit code 1 when anything fails; failures.txt feeds the Slack step.
// Nothing people typed is printed: addresses are masked.

import { readFileSync, writeFileSync } from 'node:fs'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const TEST = args.includes('--test')
const COUNT = args.includes('--count')
const filter = (args.find(a => !a.startsWith('--')) || '').toLowerCase()
const config = JSON.parse(readFileSync(new URL('./forms.json', import.meta.url), 'utf8'))
const sites = config.sites.filter(s => !filter || s.name.toLowerCase().includes(filter))
// FORMS_URL checks one site's deploy preview instead of its live address.
if (process.env.FORMS_URL) sites.forEach(s => { s.url = process.env.FORMS_URL.replace(/\/$/, '') })
const TOKEN = process.env.NETLIFY_AUTH_TOKEN
const SECRET = process.env.FORM_CHECK_SECRET
const CHECK_NAME = 'LaunchEngine form check'

const failures = []
const say = (ok, site, what, detail = '') => {
  const tag = ok === 'warn' ? 'warn' : ok ? 'ok  ' : 'FAIL'
  console.log(`  ${tag}  ${what}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(`${site.name}: ${what}${detail ? ` (${detail})` : ''}`)
}
const mask = (email) => String(email || '').replace(/^(.).*?(@.*)$/, '$1***$2') || 'no address'
const sha = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function checkEmail() {
  const s = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', SECRET).update(String(s)).digest('hex').slice(0, 16)
  return `forms-check+${s}.${sig}@launchengine.com`
}
const isCheck = (email) => /^forms-check\+\d+\.[0-9a-f]{16}@launchengine\.com$/i.test(String(email || ''))

async function netlify(path, init = {}) {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } })
  if (!res.ok) throw new Error(`Netlify ${path} answered ${res.status}`)
  return res.status === 204 ? null : res.json()
}

async function status(site, query = '', init = {}) {
  const res = await fetch(`${site.url}/.netlify/functions/form-status${query}`, {
    ...init, headers: { 'X-Form-Check-Secret': SECRET, 'Content-Type': 'application/json', ...(init.headers || {}) }
  })
  if (res.status === 401) throw new Error("the site doesn't have this repo's FORM_CHECK_SECRET")
  if (res.status === 404) throw new Error('form-status is not deployed on the site')
  if (!res.ok) throw new Error(`form-status answered ${res.status}`)
  return res.json()
}

// The forms people can actually send today: every POST form Netlify collects
// on the sitemap's pages and the pages listed in forms.json.
async function liveForms(site) {
  const pages = new Set(site.pages || [])
  try {
    const xml = await (await fetch(`${site.url}/sitemap.xml`)).text()
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) pages.add(new URL(m[1]).pathname)
  } catch { /* the listed pages still get checked */ }
  const forms = {}
  for (const path of [...pages].slice(0, 150)) {
    const res = await fetch(`${site.url}${path}`).catch(() => null)
    if (!res || !res.ok) continue
    const html = await res.text()
    for (const m of html.matchAll(/<form\b([\s\S]*?)>([\s\S]*?)<\/form>/g)) {
      const attrs = m[1]
      const name = (/name="form-name" value="([^"]+)"/.exec(m[2]) || /\bname="([^"]+)"/.exec(attrs) || [])[1]
      if (!name || !/data-netlify="true"|name="form-name"/.test(attrs + m[2])) continue
      if (!forms[name]) forms[name] = { page: path, fields: fieldsOf(m[2]) }
    }
  }
  return forms
}

// What a person would fill in: every named field, required ones answered.
function fieldsOf(html) {
  const fields = {}
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const [, tag, attrs] = m
    // Only a select reads ahead (to its options); an input must not swallow
    // the fields up to the next </select>.
    const options = tag === 'select' ? html.slice(m.index, html.indexOf('</select>', m.index)) : ''
    const name = (/\bname="([^"]+)"/.exec(attrs) || [])[1]
    if (!name || name === 'form-name' || name === 'bot-field' || name.startsWith('cf-turnstile')) continue
    const type = ((/\btype="([^"]+)"/.exec(attrs) || [])[1] || tag).toLowerCase()
    if (['submit', 'button', 'hidden', 'file'].includes(type)) continue
    let value = ''
    if (type === 'email') value = '__EMAIL__'
    else if (/name/i.test(name) && type === 'text') value = CHECK_NAME
    else if (type === 'tel' || /phone/i.test(name)) value = '719-555-0100'
    else if (tag === 'select') value = ([...(options || '').matchAll(/<option[^>]*value="([^"]+)"/g)].map(o => o[1])[0]) || ''
    else if (type === 'checkbox' || type === 'radio') value = /\brequired\b/.test(attrs) ? ((/\bvalue="([^"]+)"/.exec(attrs) || [])[1] || 'on') : ''
    else if (/\brequired\b/.test(attrs) || tag === 'textarea') value = type === 'number' ? '1' : 'Automated form check by LaunchEngine. Safe to ignore.'
    if (value && !(name in fields)) fields[name] = value
  }
  return fields
}

async function checkSite(site) {
  console.log(`\n${site.name}  ${site.url}`)
  let setup
  try {
    setup = await status(site, '?setup=1')
  } catch (e) {
    return say(false, site, 'form status answers', e.message)
  }
  const live = await liveForms(site)
  const netlifyForms = await netlify(`/sites/${site.netlify}/forms`)
  const hooks = (await netlify(`/hooks?site_id=${site.netlify}`)).filter(h => h.type === 'email' && h.event === 'submission_created' && !h.disabled)
  say(Object.keys(live).length > 0, site, `found the live forms`, Object.keys(live).join(', ') || 'none')

  for (const [name, form] of Object.entries(live)) {
    const route = setup.routes[name]
    say(!!route, site, `${name} (${form.page}) has a route`, route ? '' : 'add it to netlify/functions/lib/forms.json')
    const collected = netlifyForms.find(f => f.name === name)
    say(!!collected, site, `${name}: Netlify collects it`, collected ? '' : 'Netlify Forms has no form by this name; submissions would be lost')
    if (!route) continue
    if (setup.sender) {
      const doubles = hooks.filter(h => !h.form_id || h.form_id === collected?.id)
      if (doubles.length) say('warn', site, `${name}: Netlify notifications still on too`, `remove ${doubles.map(h => h.data.email).join(', ')} or people get two emails`)
      else say(true, site, `${name}: emailed by our sender`, route.email.join(', '))
    } else {
      const covered = new Set(hooks.filter(h => !h.form_id || h.form_id === collected?.id).map(h => h.data.email.toLowerCase()))
      const missing = route.email.filter(e => !covered.has(e.toLowerCase()))
      say(!missing.length, site, `${name}: Netlify emails ${route.email.join(', ') || 'nobody'}`, missing.length ? `nobody emails ${missing.join(', ')}` : 'our sender not set up yet')
    }
    if (route.leads) {
      if (route.leads.monday) say(setup.monday === 'ok', site, `${name}: monday lead board ready`, setup.monday)
      if (route.leads.workspace) say(setup.workspace === 'set up', site, `${name}: workspace intake set up`, setup.workspace)
    }
  }
  // Between nightly counts: any real email that failed or had no route lately.
  const recent = await status(site, `?since=${encodeURIComponent(new Date(Date.now() - 2 * 3600e3).toISOString())}`).catch(() => ({ deliveries: [] }))
  const bad = recent.deliveries.filter(d => !d.check && ['failed', 'no_route'].includes(d.status))
  say(!bad.length, site, 'no failed form emails in the last 2 hours', bad.map(d => `${d.form} ${d.status}${d.error ? `: ${d.error}` : ''}`).join('; '))

  for (const name of Object.keys(setup.routes)) {
    if (!live[name]) say('warn', site, `${name} has a route but isn't on any page`, 'remove the route, or the page lost its form')
  }

  if (TEST) await testSite(site, setup, live, netlifyForms)
  if (COUNT) await countSite(site, setup, netlifyForms)
}

async function testSite(site, setup, live, netlifyForms) {
  if (!setup.sender) {
    return say('warn', site, 'test submissions skipped', "our sender isn't set up, so a test would email real people through Netlify's notifications")
  }
  for (const [name, form] of Object.entries(live)) {
    const route = setup.routes[name]
    const collected = netlifyForms.find(f => f.name === name)
    if (!route || !collected) continue
    // Netlify's own notifications can't tell a test from a person: while one
    // still emails someone outside LaunchEngine, this form isn't tested.
    const outside = (await netlify(`/hooks?site_id=${site.netlify}`))
      .filter(h => h.type === 'email' && h.event === 'submission_created' && !h.disabled && (!h.form_id || h.form_id === collected.id))
      .map(h => h.data.email).filter(e => !/@launchengine\.com$/i.test(e))
    if (outside.length) { say('warn', site, `${name}: test skipped`, `Netlify still emails ${outside.join(', ')} directly; remove that notification first`); continue }
    const email = checkEmail()
    const started = new Date(Date.now() - 5000).toISOString()
    const fields = Object.fromEntries(Object.entries(form.fields).map(([k, v]) => [k, v === '__EMAIL__' ? email : v]))
    const res = await fetch(`${site.url}${form.page}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'form-name': name, ...fields }).toString()
    })
    if (res.status >= 400) { say(false, site, `${name}: test accepted`, `the site answered ${res.status}`); continue }

    let submission = null
    for (let i = 0; i < 12 && !submission; i++) {
      await sleep(5000)
      submission = (await netlify(`/forms/${collected.id}/submissions?per_page=20`)).find(s => s.email === email || s.data?.email === email)
    }
    if (!submission) {
      const spam = (await netlify(`/forms/${collected.id}/submissions?state=spam&per_page=20`)).find(s => s.email === email || s.data?.email === email)
      say(false, site, `${name}: test saved in Netlify Forms`, spam ? 'Netlify marked it as spam' : 'not there after a minute')
      if (spam) await netlify(`/submissions/${spam.id}`, { method: 'DELETE' }).catch(() => {})
      continue
    }
    say(true, site, `${name}: test saved in Netlify Forms`)

    let delivery = null
    for (let i = 0; i < 12 && !delivery; i++) {
      delivery = (await status(site, `?since=${encodeURIComponent(started)}`)).deliveries.find(d => d.id === submission.id)
      if (!delivery) await sleep(5000)
    }
    const good = delivery && (delivery.status === 'checked' || (delivery.status === 'no_email' && !route.email.length))
    say(!!good, site, `${name}: email sent (sandbox) to ${route.email.join(', ')}`, delivery ? delivery.status + (delivery.error ? `: ${delivery.error}` : '') : 'no delivery line after a minute')

    if (route.leads) {
      const lead = await fetch(`${site.url}/.netlify/functions/create-lead`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: CHECK_NAME, email, phone: '719-555-0100', source: route.leads.source, message: 'Automated form check' })
      }).then(r => r.json()).catch(e => ({ error: e.message }))
      if (route.leads.workspace) say(lead.check === 'ok', site, `${name}: workspace would save the lead (dry run)`, lead.check === 'ok' ? '' : JSON.stringify(lead))
    }
    await netlify(`/submissions/${submission.id}`, { method: 'DELETE' }).then(() => say(true, site, `${name}: test deleted from Netlify Forms`), e => say(false, site, `${name}: test deleted`, e.message))
  }
}

async function countSite(site, setup, netlifyForms) {
  const since = new Date(Date.now() - 26 * 3600e3).toISOString()
  const { deliveries } = await status(site, `?since=${encodeURIComponent(since)}`)
  const byId = Object.fromEntries(deliveries.map(d => [d.id, d]))
  const firstLogged = deliveries.map(d => d.created_at).sort()[0]
  let real = 0
  const leadEmails = {}
  for (const form of netlifyForms) {
    const route = setup.routes[form.name]
    const subs = (await netlify(`/forms/${form.id}/submissions?per_page=100`)).filter(s => s.created_at >= since && !isCheck(s.email || s.data?.email))
    for (const s of subs) {
      real++
      const when = new Date(s.created_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const who = `${form.name} at ${when} (${mask(s.email || s.data?.email)})`
      const d = byId[s.id]
      if (!route) say(false, site, `${who}: no route`, 'it is in Netlify Forms; nobody was told')
      else if (!d) {
        if (firstLogged && s.created_at >= firstLogged) say(false, site, `${who}: never reached our sender`, 'it is in Netlify Forms; check submission-created')
      } else if (!['sent', 'no_email', 'netlify_emails'].includes(d.status)) say(false, site, `${who}: email ${d.status}`, d.error || '')
      if (route?.leads && (s.email || s.data?.email)) leadEmails[sha(s.email || s.data.email)] = { who, leads: route.leads }
    }
  }
  const hashes = Object.keys(leadEmails)
  if (hashes.length) {
    const found = await status(site, '', { method: 'POST', body: JSON.stringify({ since: new Date(Date.parse(since) - 3600e3).toISOString(), emails_sha256: hashes }) })
    for (const [h, { who, leads }] of Object.entries(leadEmails)) {
      if (leads.workspace) say(Array.isArray(found.workspace) && found.workspace.includes(h), site, `${who}: lead in the workspace`, Array.isArray(found.workspace) ? '' : found.workspace)
      if (leads.monday) say(Array.isArray(found.monday) && found.monday.includes(h), site, `${who}: lead in monday`, Array.isArray(found.monday) ? '' : found.monday)
    }
  }
  say(true, site, `counted ${real} real submission${real === 1 ? '' : 's'} in the last 26 hours`)
}

if (!TOKEN || !SECRET) {
  console.error('NETLIFY_AUTH_TOKEN and FORM_CHECK_SECRET are both needed.')
  writeFileSync('failures.txt', 'Form checks could not run: NETLIFY_AUTH_TOKEN or FORM_CHECK_SECRET is missing\n')
  process.exit(1)
}
for (const site of sites) {
  try { await checkSite(site) } catch (e) { say(false, site, 'form checks ran', e.message) }
}
writeFileSync('failures.txt', failures.join('\n') + (failures.length ? '\n' : ''))
console.log(failures.length ? `\n${failures.length} problem${failures.length === 1 ? '' : 's'}` : '\nAll forms OK')
process.exit(failures.length ? 1 : 0)
