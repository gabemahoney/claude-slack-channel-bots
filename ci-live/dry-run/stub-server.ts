/**
 * stub-server.ts — the dry run's local Slack: the Web API (`/api/<method>`),
 * the human session API (`/human-api/<method>`) and fixture HTML pages for
 * the browser flows (sign-in, the emailed-code prompt, install and consent,
 * OAuth & Permissions, Basic Information with App-Level Tokens, the apps
 * list with each app's workspace, and a web-client conversation with a
 * prompt message, whose first load lands on a default channel as the real
 * client's does); and the test mailbox's
 * mail.tm API (`/mailtm/token`, `/mailtm/messages[/<id>]`,
 * `/mailtm/sources/<id>`), on 127.0.0.1 only.
 *
 * The fixture pages use the same roles, names and attributes the flows look
 * for on the real pages, so Playwright drives headless Chrome through the
 * flow code and its selectors. It logs nothing.
 */

import type { SlackUrls } from '../lib/browser-types.ts'
import { blockButtons, STUB_OTHER_TEAM_NAME, STUB_TEAM_ID, STUB_TEAM_NAME, StubWorkspace } from './stub-state.ts'

/** What the fixture web client served (the dry run's self-test reads it). */
export interface StubClientStats {
  /** Conversation pages served. */
  conversationLoads: number
  /** Conversation loads the client sent to its default channel instead. */
  defaultChannelRedirects: number
}

export interface StubServer {
  workspace: StubWorkspace
  /** The fixture web client's counters. */
  client: StubClientStats
  baseUrl: string
  apiBase: string
  /** The stub mailbox's API base (mailbox.json's `api` in a dry run). */
  mailApiBase: string
  urls: SlackUrls
  stop(): void
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(title: string, body: string): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } })
}

function cookieOf(req: Request): string | null {
  const header = req.headers.get('cookie') ?? ''
  const m = /(?:^|;\s*)d=([^;]+)/.exec(header)
  return m ? decodeURIComponent(m[1] as string) : null
}

async function formOf(req: Request): Promise<Record<string, string>> {
  const text = await req.text()
  return Object.fromEntries(new URLSearchParams(text))
}

function signInPage(error = ''): Response {
  return page(
    'Sign in',
    `<h1>Sign in to the stub workspace</h1>${error ? `<p role="alert">${esc(error)}</p>` : ''}
<form method="post"><label>Email address <input type="email" name="email" id="email"></label>
<label>Password <input type="password" name="password" id="password"></label>
<button type="submit" id="signin_btn">Sign In</button></form>`,
  )
}

/**
 * How long the stub takes to answer a typed code. The prompt stays as it
 * was meanwhile, with any refusal it showed: the runner must not take that
 * stale refusal for the answer.
 */
const CODE_CHECK_MS = 1_500

const CODE_REFUSED_TEXT = "That code didn't work. Check the code and try again."

/**
 * The prompt's script, as a client-side app answers a code: it posts the
 * code, leaves the page as it is until the answer comes (a refusal still
 * shown stays shown), then goes to the client, or redraws the refusal (a new
 * element) and leaves what was typed in the field, which the runner must
 * clear before typing the next code.
 */
const CODE_SCRIPT = `
document.getElementById('code-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = e.target.elements.code.value;
  const r = await fetch('/fixture/confirm_code', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }) });
  const j = await r.json();
  if (j.ok) { location.assign(j.next); return; }
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = j.error;
  document.getElementById('code-error').replaceChildren(p);
};`

/** The new-device prompt: Slack emailed a code; type it. */
function codePage(): Response {
  return page(
    'Check your email',
    `<h1>Check your email for a code</h1><p>We have sent a 6-character code to your email address. The code expires shortly, so please enter it soon.</p>
<div id="code-error"></div><form id="code-form"><label>Confirmation code <input type="text" name="code" autocomplete="one-time-code" maxlength="7"></label>
<button type="submit">Continue</button></form><script>${CODE_SCRIPT}</script>`,
  )
}

function bearerOf(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

/** The stub mailbox's mail.tm API; `null` for another path. */
async function mailTm(ws: StubWorkspace, req: Request, path: string): Promise<Response | null> {
  const box = ws.mailbox
  const unauthorized = (): Response => Response.json({ code: 401, message: 'JWT Token not found' }, { status: 401 })
  if (path === '/mailtm/token' && req.method === 'POST') {
    let body: Record<string, unknown> = {}
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      /* an empty or broken body is refused below */
    }
    const token = box.issueToken(body.address, body.password)
    return token ? Response.json({ id: box.accountId, token }) : Response.json({ code: 401, message: 'Invalid credentials.' }, { status: 401 })
  }
  if (path === '/mailtm/messages' && req.method === 'GET') {
    if (!box.authorized(bearerOf(req))) return unauthorized()
    if (box.takeRateLimit()) return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
    const items = box.visible(Date.now()).map((m) => box.summary(m))
    return Response.json({ 'hydra:member': items, 'hydra:totalItems': items.length })
  }
  const m = /^\/mailtm\/messages\/([A-Za-z0-9]+)$/.exec(path)
  if (m && req.method === 'GET') {
    if (!box.authorized(bearerOf(req))) return unauthorized()
    const mail = box.visible(Date.now()).find((x) => x.id === m[1])
    return mail ? Response.json(box.full(mail)) : Response.json({ code: 404, message: 'Not Found' }, { status: 404 })
  }
  const src = /^\/mailtm\/sources\/([A-Za-z0-9]+)$/.exec(path)
  if (src && req.method === 'GET') {
    if (!box.authorized(bearerOf(req))) return unauthorized()
    const mail = box.visible(Date.now()).find((x) => x.id === src[1])
    if (!mail) return Response.json({ code: 404, message: 'Not Found' }, { status: 404 })
    return Response.json({ '@id': `/sources/${mail.id}`, '@type': 'Source', id: mail.id, downloadUrl: `/sources/${mail.id}/download`, data: box.source(mail) })
  }
  return null
}

const GENERAL_SCRIPT = `
const appId = document.body.dataset.app;
function show(id, on) { document.getElementById(id).hidden = !on; }
document.getElementById('gen').onclick = () => show('gen-dialog', true);
document.getElementById('add-scope').onclick = () => show('scope-picker', true);
document.getElementById('do-generate').onclick = async () => {
  const name = document.getElementById('token-name').value;
  const scope = document.getElementById('scope').value;
  const r = await fetch('/fixture/apps/' + appId + '/app-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scope }) });
  const j = await r.json();
  document.getElementById('token-value').value = j.token || '';
  show('token-out', true);
};
document.getElementById('done').onclick = () => location.reload();
for (const b of document.querySelectorAll('[data-token-name]')) {
  b.onclick = () => { document.getElementById('revoke-name').textContent = b.dataset.tokenName; show('revoke-dialog', true); };
}
document.getElementById('revoke').onclick = () => show('revoke-confirm', true);
document.getElementById('revoke-yes').onclick = async () => {
  await fetch('/fixture/apps/' + appId + '/app-tokens/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('revoke-name').textContent }) });
  location.reload();
};`

function generalPage(ws: StubWorkspace, appId: string): Response {
  const app = ws.apps.get(appId)
  if (!app) return new Response('not found', { status: 404 })
  const tokens = app.appTokens.map((t) => `<li><button type="button" data-token-name="${esc(t.name)}">${esc(t.name)}</button></li>`).join('')
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Basic Information</title></head><body data-app="${esc(appId)}">
<h1>Basic Information</h1><h2>App-Level Tokens</h2><ul>${tokens}</ul>
<button type="button" id="gen">Generate Token and Scopes</button>
<div role="dialog" id="gen-dialog" hidden><label>Token Name <input type="text" id="token-name"></label>
<button type="button" id="add-scope">Add Scope</button>
<div id="scope-picker" hidden><select id="scope"><option value="">Choose</option><option value="connections:write">connections:write</option><option value="authorizations:read">authorizations:read</option></select></div>
<button type="button" id="do-generate">Generate</button>
<div id="token-out" hidden><label>Token <input type="text" readonly id="token-value"></label><button type="button" id="done">Done</button></div></div>
<div role="dialog" id="revoke-dialog" hidden><p id="revoke-name"></p><button type="button" id="revoke">Revoke</button>
<div id="revoke-confirm" hidden><button type="button" id="revoke-yes">Yes, Revoke</button></div></div>
<script>${GENERAL_SCRIPT}</script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
}

/** The apps list (api.slack.com/apps): a row per app, an icon link and a name link, and the app's workspace. */
function appsListPage(ws: StubWorkspace): Response {
  const rows = [...ws.apps.values()]
    .map((app) => {
      const name = String((app.manifest.display_information as { name?: unknown } | undefined)?.name ?? app.id)
      const href = `/fixture/apps/${esc(app.id)}/general`
      const team = app.foreign ? STUB_OTHER_TEAM_NAME : STUB_TEAM_NAME
      return `<tr><td><a href="${href}" aria-hidden="true"><span class="icon"></span></a> <a href="${href}">${esc(name)}</a></td><td>${esc(team)}</td></tr>`
    })
    .join('')
  return page(
    'Your Apps',
    `<h1>Your Apps</h1><a href="/fixture/apps/new" role="button">Create New App</a>
<table><thead><tr><th>App Name</th><th>Workspace</th></tr></thead><tbody>${rows}</tbody></table>`,
  )
}

/**
 * The fixture web client's default channel: its first load of a
 * conversation lands there instead, as the real client's first load in a
 * page does (it sends the page to the workspace's default channel).
 */
const DEFAULT_CHANNEL = {
  id: 'C0DRYGENERAL',
  name: 'general',
  messages: [
    { ts: '1700000000.000100', text: 'Welcome to #general.', buttons: [] },
    { ts: '1700000000.000200', text: 'This is the default channel.', buttons: [] },
  ],
}
/** How long the fixture client takes to boot before it shows a conversation. */
const CLIENT_BOOT_MS = 1_000
/** When the cookie banner shows over the fixture client (unless dismissed before). */
const COOKIE_BANNER_MS = 300
/** Messages the fixture's message list renders at a time (the real one is a virtual list). */
const CLIENT_WINDOW = 10

/**
 * The fixture client: boots (the message pane is hidden meanwhile), then
 * shows the conversation, or, when told to redirect, replaces the URL with
 * the default channel's and shows that. Messages carry the real client's
 * attributes (`data-item-key` / `id="message-list_<ts>"`), Block Kit buttons
 * theirs (`data-qa="bk_button-element"`, `id="<ts>-<action id>"`,
 * `data-qa-action-id`). The list renders the newest CLIENT_WINDOW messages
 * and prepends older ones when scrolled to its top. A OneTrust-style cookie
 * banner covers the page (intercepting clicks) until accepted.
 */
const CLIENT_SCRIPT = `
const F = JSON.parse(document.getElementById('fixture-data').textContent);
async function click_(ts, button) {
  await fetch('/fixture/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conv: F.conv, ts, button }) });
}
function item(m) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.setAttribute('role', 'listitem');
  el.setAttribute('data-item-key', m.ts);
  el.id = 'message-list_' + m.ts;
  const text = document.createElement('span');
  text.textContent = m.text;
  el.append(text);
  for (const b of m.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-qa', 'bk_button-element');
    btn.id = m.ts + '-' + b.actionId;
    btn.setAttribute('data-qa-action-id', b.actionId);
    btn.textContent = b.text;
    btn.onclick = () => click_(m.ts, b.text);
    el.append(btn);
  }
  return el;
}
function show(view) {
  document.title = view.name + ' (Channel) - Stub client';
  const list = document.getElementById('message-list');
  let start = Math.max(0, view.messages.length - F.window);
  list.replaceChildren(...view.messages.slice(start).map(item));
  document.getElementById('pane').hidden = false;
  list.scrollTop = list.scrollHeight;
  list.onscroll = () => {
    if (start === 0 || list.scrollTop > 40) return;
    const from = Math.max(0, start - F.window);
    const height = list.scrollHeight;
    list.prepend(...view.messages.slice(from, start).map(item));
    start = from;
    list.scrollTop += list.scrollHeight - height;
  };
}
setTimeout(() => {
  if (F.redirect) { history.replaceState(null, '', F.redirect.path); show(F.redirect); } else show(F.view);
}, F.bootMs);
if (!document.cookie.split('; ').some((c) => c.startsWith('OptanonAlertBoxClosed='))) {
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.id = 'onetrust-banner-sdk';
    banner.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.3)';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.id = 'accept-recommended-btn-handler';
    accept.textContent = 'Accept All Cookies';
    accept.onclick = () => { document.cookie = 'OptanonAlertBoxClosed=1; path=/'; banner.remove(); };
    banner.append(accept);
    document.body.append(banner);
  }, F.bannerMs);
}`

/** JSON for an inline `<script type="application/json">` (no `</script>` can end it early). */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function conversationPage(ws: StubWorkspace, teamId: string, conv: string, toDefault: boolean): Response {
  const messages = (ws.channels.get(conv)?.messages ?? []).map((m) => ({ ts: m.ts, text: m.text, buttons: blockButtons(m.blocks) }))
  const name = ws.channels.get(conv)?.name ?? conv
  const data = {
    conv,
    window: CLIENT_WINDOW,
    bootMs: CLIENT_BOOT_MS,
    bannerMs: COOKIE_BANNER_MS,
    view: { name, messages },
    redirect: toDefault ? { path: `/fixture/client/${teamId}/${DEFAULT_CHANNEL.id}`, name: DEFAULT_CHANNEL.name, messages: DEFAULT_CHANNEL.messages } : null,
  }
  // The sidebar's channel items carry `data-item-key` (channel ids), as the real client's do.
  const sidebar = [...ws.channels.values(), DEFAULT_CHANNEL]
    .map((c) => `<div role="treeitem" data-item-key="${esc(c.id)}">#${esc(c.name)}</div>`)
    .join('')
  return page(
    'Stub client',
    `<style>#message-list{height:400px;overflow-y:auto;overflow-anchor:none}.msg{min-height:56px}</style>
<nav aria-label="Channels"><div role="tree">${sidebar}</div></nav>
<main id="pane" data-qa="message_pane" hidden><div id="message-list" role="list"></div></main>
<script type="application/json" id="fixture-data">${inlineJson(data)}</script><script>${CLIENT_SCRIPT}</script>`,
  )
}

export function startStubServer(options: { domain: string; email: string; password: string }): StubServer {
  const ws = new StubWorkspace(options.domain, options.email, options.password)
  const signedIn = (req: Request) => cookieOf(req) === ws.cookie
  const client: StubClientStats = { conversationLoads: 0, defaultChannelRedirects: 0 }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      let m: RegExpExecArray | null

      if (path.startsWith('/mailtm/')) return (await mailTm(ws, req, path)) ?? new Response('not found', { status: 404 })
      if ((m = /^\/api\/([a-zA-Z.]+)$/.exec(path)) && req.method === 'POST') {
        const auth = req.headers.get('authorization') ?? ''
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null
        return Response.json(ws.api(m[1] as string, bearer, await formOf(req)))
      }
      if ((m = /^\/human-api\/([a-zA-Z.]+)$/.exec(path)) && req.method === 'POST') {
        return Response.json(ws.human(m[1] as string, await formOf(req), cookieOf(req)))
      }
      if (path === '/fixture/sign_in_with_password') {
        if (req.method === 'GET') return signInPage()
        const form = await formOf(req)
        if (form.email !== ws.email || form.password !== ws.password) {
          return signInPage('Sorry, you entered an incorrect email address or password.')
        }
        if (ws.startEmailCode(Date.now())) return redirect('/fixture/confirm_code')
        return redirect('/fixture/client', { 'Set-Cookie': `d=${encodeURIComponent(ws.cookie)}; Path=/; HttpOnly; SameSite=Lax` })
      }
      if (path === '/fixture/confirm_code') {
        if (!ws.hasPendingCode()) return redirect('/fixture/sign_in_with_password')
        if (req.method === 'GET') return codePage()
        const typed = (await formOf(req)).code ?? ''
        await Bun.sleep(CODE_CHECK_MS)
        if (!ws.submitCode(typed)) return Response.json({ ok: false, error: CODE_REFUSED_TEXT })
        return Response.json({ ok: true, next: '/fixture/client' }, { headers: { 'Set-Cookie': `d=${encodeURIComponent(ws.cookie)}; Path=/; HttpOnly; SameSite=Lax` } })
      }
      if (path === '/fixture/client' || (m = /^\/fixture\/client\/([A-Z0-9]+)\/([A-Z0-9]+)$/.exec(path))) {
        if (!signedIn(req)) return redirect('/fixture/sign_in_with_password')
        const config = JSON.stringify({ teams: { [STUB_TEAM_ID]: { token: ws.sessionToken, domain: ws.domain } } })
        let body = page('Stub client', '<p>Signed in.</p>')
        if (m) {
          // The first conversation load lands on the default channel; the ones after stay.
          client.conversationLoads += 1
          const toDefault = client.conversationLoads === 1
          if (toDefault) client.defaultChannelRedirects += 1
          body = conversationPage(ws, m[1] as string, m[2] as string, toDefault)
        }
        const html = (await body.text()).replace('<body>', `<body><script>localStorage.setItem('localConfig_v2', ${JSON.stringify(config)});</script>`)
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      }
      if (path === '/fixture/click' && req.method === 'POST') {
        if (!signedIn(req)) return new Response('no', { status: 403 })
        const body = (await req.json()) as { conv: string; ts: string; button: string }
        return Response.json({ ok: ws.click(body.conv, body.ts, body.button) })
      }
      if (!path.startsWith('/fixture/')) return new Response('not found', { status: 404 })
      if (!signedIn(req)) return redirect('/fixture/sign_in_with_password')

      if (path === '/fixture/apps') return appsListPage(ws)
      if ((m = /^\/fixture\/apps\/([A-Z0-9]+)\/install-on-team$/.exec(path))) {
        return page('Install App', `<h1>Install App</h1><a href="/fixture/oauth/authorize?app=${esc(m[1] as string)}" role="button">Install to CSCB CI Test</a>`)
      }
      if (path === '/fixture/oauth/authorize') {
        const appId = url.searchParams.get('app') ?? ''
        if (req.method === 'GET') {
          return page('Authorize', `<p>The app is requesting permission.</p><form method="post"><button type="submit">Allow</button></form>`)
        }
        if (!ws.install(appId)) return new Response('not found', { status: 404 })
        return redirect(`/fixture/apps/${appId}/oauth?success=1`)
      }
      if ((m = /^\/fixture\/apps\/([A-Z0-9]+)\/oauth$/.exec(path))) {
        const app = ws.apps.get(m[1] as string)
        const token = app?.installed && app.botToken ? app.botToken : ''
        return page('OAuth & Permissions', `<h1>OAuth &amp; Permissions</h1><label>Bot User OAuth Token <input type="text" readonly value="${esc(token)}"></label>`)
      }
      if ((m = /^\/fixture\/apps\/([A-Z0-9]+)\/general$/.exec(path))) return generalPage(ws, m[1] as string)
      if ((m = /^\/fixture\/apps\/([A-Z0-9]+)\/app-tokens(\/revoke)?$/.exec(path)) && req.method === 'POST') {
        const body = (await req.json()) as { name?: string; scope?: string }
        if (m[2]) return Response.json({ ok: ws.revokeAppToken(m[1] as string, body.name ?? '') })
        if (body.scope !== 'connections:write' || !body.name) return Response.json({ ok: false })
        return Response.json({ ok: true, token: ws.generateAppToken(m[1] as string, body.name) })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const baseUrl = `http://127.0.0.1:${server.port}`
  const urls: SlackUrls = {
    signIn: () => `${baseUrl}/fixture/sign_in_with_password`,
    humanApiBase: () => `${baseUrl}/human-api/`,
    clientHome: () => `${baseUrl}/fixture/client`,
    installApp: (appId) => `${baseUrl}/fixture/apps/${appId}/install-on-team`,
    oauthPage: (appId) => `${baseUrl}/fixture/apps/${appId}/oauth`,
    basicInfoPage: (appId) => `${baseUrl}/fixture/apps/${appId}/general`,
    conversation: (teamId, conversationId) => `${baseUrl}/fixture/client/${teamId}/${conversationId}`,
    appsList: () => `${baseUrl}/fixture/apps`,
  }
  return { workspace: ws, client, baseUrl, apiBase: `${baseUrl}/api/`, mailApiBase: `${baseUrl}/mailtm`, urls, stop: () => server.stop(true) }
}

