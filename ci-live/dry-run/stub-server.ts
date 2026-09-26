/**
 * stub-server.ts — the dry run's local Slack: the Web API (`/api/<method>`),
 * the human session API (`/human-api/<method>`) and fixture HTML pages for
 * the browser flows (sign-in, the emailed-code prompt, install and consent,
 * OAuth & Permissions, Basic Information with App-Level Tokens, and a
 * web-client conversation with a prompt message); and the test mailbox's
 * mail.tm API (`/mailtm/token`, `/mailtm/messages[/<id>]`,
 * `/mailtm/sources/<id>`), on 127.0.0.1 only.
 *
 * The fixture pages use the same roles, names and attributes the flows look
 * for on the real pages, so Playwright drives headless Chrome through the
 * flow code and its selectors. It logs nothing.
 */

import type { SlackUrls } from '../lib/browser-types.ts'
import { STUB_TEAM_ID, StubWorkspace } from './stub-state.ts'

export interface StubServer {
  workspace: StubWorkspace
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

function conversationPage(ws: StubWorkspace, conv: string): Response {
  const channel = ws.channels.get(conv)
  const items = (channel?.messages ?? [])
    .map((m) => {
      const buttons = m.blocks
        ? `<button type="button" onclick="click_('${esc(m.ts)}','Allow')">Allow</button><button type="button" onclick="click_('${esc(m.ts)}','Deny')">Deny</button>`
        : ''
      return `<div data-item-key="${esc(m.ts)}"><span>${esc(m.text)}</span>${buttons}</div>`
    })
    .join('')
  return page(
    'Stub client',
    `<div id="messages">${items}</div><script>
async function click_(ts, b) { await fetch('/fixture/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conv: ${JSON.stringify(conv)}, ts, button: b }) }); }
</script>`,
  )
}

export function startStubServer(options: { domain: string; email: string; password: string }): StubServer {
  const ws = new StubWorkspace(options.domain, options.email, options.password)
  const signedIn = (req: Request) => cookieOf(req) === ws.cookie

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
        const body = m ? conversationPage(ws, m[2] as string) : page('Stub client', '<p>Signed in.</p>')
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
  }
  return { workspace: ws, baseUrl, apiBase: `${baseUrl}/api/`, mailApiBase: `${baseUrl}/mailtm`, urls, stop: () => server.stop(true) }
}

