import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread, Trigger } from '../src/core/index.ts'
import { z } from 'zod'
import { GiteeError, GiteeTokenError, giteeClient, giteeToken, type GiteeReader } from '../src/sources/gitee-api.ts'
import { giteeKind, pollRound, type GiteeConfig } from '../src/sources/gitee.ts'
import { giteeChannel, giteePage, commentPage, commentTrigger, giteeAddress, issueTrigger } from '../src/sources/gitee-trigger.ts'
import { giteeLink, sendGitee } from '../src/sources/gitee-channel.ts'
import { giteeThreadContext } from '../src/sources/gitee-read.ts'
import type { SourceContext } from '../src/sources/host.ts'

const NOW = '2026-11-17T01:00:00.000Z'
const ISSUE = { number: 'I1', title: 'Fix the header', body: '@agent please fix', state: 'open', created_at: NOW, updated_at: NOW,
  html_url: 'https://gitee.com/acme/widgets/issues/I1', user: { login: 'alice', type: 'User' } }
const COMMENT = { id: '9', body: 'more detail', user: { login: 'bob', type: 'User' }, created_at: NOW, updated_at: NOW }
const config = (overrides: Partial<GiteeConfig> = {}): GiteeConfig => ({ repository: 'acme/widgets', tokenFile: '/tmp/token',
  pollSeconds: 60, failuresBeforeError: 3, observeIssues: false, observeComments: false, ...overrides })
function context(overrides: Partial<GiteeConfig> = {}, threads: Thread[] = []) {
  const values = new Map<string, unknown>()
  const received: unknown[] = []
  const patched: [string, Record<string, unknown>][] = []
  const described: unknown[] = []
  const current = config(overrides)
  const ctx = {
    config: (id: string) => id === 'gitee' ? current : undefined,
    state: { get: (key: string) => values.get(key) as never, set: (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value) }, keys: () => [] },
    atomic: <T>(work: () => T) => work(),
    receive: async (trigger: unknown) => { received.push(trigger); return 'stored' as const },
    threads: {
      get: (key: string) => threads.find(thread => thread.key === key),
      subscribed: () => threads.filter(thread => thread.subscriptions.length),
      patch: (key: string, meta: Record<string, unknown>) => { patched.push([key, meta]) },
      describe: (key: string, description: unknown) => { described.push([key, description]) },
    },
    tickets: { get: () => undefined },
  } as unknown as SourceContext
  return { ctx, values, received, patched, described, current }
}
const thread = (id: string, createdAt = NOW): Thread =>
  ({ key: `gitee:${id}`, ref: { source: 'gitee', id }, createdAt, subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
const client = (issues: unknown[], comments: unknown[] = [], issue: unknown = ISSUE): GiteeReader => ({
  login: async () => 'agent',
  list: (async (_schema: unknown, path: string) => path === 'issues' ? issues : comments) as GiteeReader['list'],
  get: (async () => issue) as GiteeReader['get'],
  post: (async () => ({})) as GiteeReader['post'],
})

describe('Gitee trigger mapping', () => {
  it('turns an issue and its comment into stable triggers, mentioning the agent and skipping its own messages', () => {
    const issue = issueTrigger(ISSUE, 'agent', 'acme/widgets')!
    expect(issue).toMatchObject({ source: 'gitee', threads: [{ source: 'gitee', id: 'acme/widgets:I1' }], actor: { source: 'gitee', id: 'alice' },
      human: true, addressed: 'mention', text: 'Fix the header\n\n@agent please fix', url: 'https://gitee.com/acme/widgets/issues/I1',
      channel: { source: 'gitee', thread: 'gitee:acme/widgets:I1', address: { repository: 'acme/widgets', number: 'I1', url: 'https://gitee.com/acme/widgets/issues/I1' } },
      meta: { number: 'I1', kind: 'issue', repository: 'acme/widgets' } })
    expect(issueTrigger({ ...ISSUE, user: { login: 'agent' } }, 'agent', 'acme/widgets')).toBeUndefined()
    const comment = commentTrigger(COMMENT, ISSUE, 'agent', 'acme/widgets')!
    expect(comment).toMatchObject({ actor: { id: 'bob' }, text: 'more detail', threads: [{ source: 'gitee', id: 'acme/widgets:I1' }],
      channel: { address: { number: 'I1', url: commentPage(ISSUE.html_url, '9') } }, meta: { kind: 'comment', commentId: '9' } })
    // An edit produces a new trigger id; the same comment read twice does not.
    expect(commentTrigger({ ...COMMENT, updated_at: '2026-11-17T02:00:00.000Z' }, ISSUE, 'agent', 'acme/widgets')!.id).not.toBe(comment.id)
    expect(commentTrigger(COMMENT, ISSUE, 'agent', 'acme/widgets')!.id).toBe(comment.id)
    expect(commentTrigger({ ...COMMENT, user: { login: 'agent' } }, ISSUE, 'agent', 'acme/widgets')).toBeUndefined()
    expect(commentTrigger({ ...COMMENT, body: '   ' }, ISSUE, 'agent', 'acme/widgets')).toBeUndefined()
  })
  it('marks bot accounts as non-human and parses Gitee addresses in the configured repository', () => {
    expect(issueTrigger({ ...ISSUE, user: { login: 'dependabot[bot]', type: 'Bot' } }, 'agent', 'acme/widgets')).toMatchObject({ human: false })
    expect(giteeAddress('https://gitee.com/acme/widgets/issues/I1#note_9', 'acme/widgets')).toEqual({ repository: 'acme/widgets', number: 'I1' })
    expect(giteeAddress('https://gitee.com/other/repo/issues/I1', 'acme/widgets')).toBeUndefined()
    expect(giteePage('acme/widgets', 'I1')).toBe('https://gitee.com/acme/widgets/issues/I1')
    expect(giteeChannel('acme/widgets', 'I1', 'https://gitee.com/acme/widgets/issues/I1')).toEqual({ source: 'gitee', thread: 'gitee:acme/widgets:I1',
      address: { repository: 'acme/widgets', number: 'I1', url: 'https://gitee.com/acme/widgets/issues/I1' } })
  })
  it('scopes issues and comments and offers the matching admission rows and search terms', () => {
    expect(giteeKind.scope!({ meta: { kind: 'issue', repository: 'acme/widgets' } }, config({ observeIssues: true }))).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(giteeKind.scope!({ meta: { kind: 'comment', repository: 'acme/widgets' } }, config())).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(giteeKind.find!('#I1')).toEqual({ threads: [], terms: [] })
    expect(giteeKind.find!('https://gitee.com/acme/widgets/issues/I1#note_9')).toEqual({ threads: ['gitee:acme/widgets:I1'], terms: [] })
    expect(giteeKind.find!('#12')).toEqual({ threads: [], terms: [] })
    expect(giteeKind.scope!({ meta: { kind: 'issue', repository: 'other/repo' } }, config())).toMatchObject({ listened: false })
    expect(giteeKind.policy!.rows!(config({ observeComments: true }))).toEqual([
      { id: 'issues', label: { zh: '新 Issue', en: 'New Issues' }, note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'comments', label: { zh: '评论', en: 'Comments' }, note: { zh: '全部', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
    ])
  })
})

describe('Gitee token and HTTP client', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'gitee-'))
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  it('reads a token file, rejects a missing or unreadable one, and never exposes the token in a URL error', async () => {
    const root = dir()
    try {
      expect(() => giteeToken({ tokenFile: '' })).toThrow(GiteeTokenError)
      expect(() => giteeToken({ tokenFile: join(root, 'missing') })).toThrow(GiteeTokenError)
      const file = join(root, 'token')
      writeFileSync(file, 'secret\n')
      expect(giteeToken({ tokenFile: file })).toBe('secret')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('sends the token to the repository path and reports an HTTP status without echoing the URL', async () => {
    const calls: { url: URL; init: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }))
    expect(() => giteeToken({ tokenFile: '' })).toThrow(GiteeTokenError)
    const tokenDir = dir()
    const tokenFile = join(tokenDir, 'token')
    writeFileSync(tokenFile, 'secret')
    const live = giteeClient({ repository: 'acme/widgets', tokenFile }, new AbortController().signal)
    await expect(live.get(z.unknown(), 'issues', { page: 1 })).rejects.toMatchObject({ status: 404, message: 'Not Found' })
    expect(calls.at(-1)!.url.pathname).toBe('/api/v5/repos/acme/widgets/issues')
    expect(calls.at(-1)!.url.searchParams.get('access_token')).toBe('secret')
    expect(calls.at(-1)!.url.toString()).not.toContain('Not Found')
    rmSync(tokenDir, { recursive: true, force: true })
  })
})

describe('Gitee polling', () => {
  it('receives a fresh issue and its comments, then advances both cursors', async () => {
    const h = context({ observeIssues: true, observeComments: true })
    const old = '2026-11-16T00:00:00.000Z'
    h.ctx.state.set('gitee-stream:acme/widgets', { since: old, started: { detect: old, issues: old, comments: old } })
    const fake = client([ISSUE], [COMMENT])
    const round = await pollRound(h.ctx, fake, 'agent', new AbortController().signal)
    expect(round.received).toBe(2)
    expect(h.received).toEqual([expect.objectContaining({ meta: expect.objectContaining({ kind: 'issue' }) }),
      expect.objectContaining({ meta: expect.objectContaining({ kind: 'comment' }) })])
    expect(h.ctx.state.get('gitee-issue:acme/widgets:I1')).toBeTruthy()
    expect(h.ctx.state.get('gitee-stream:acme/widgets')).toMatchObject({ since: expect.any(String), started: { detect: old } })
    expect(h.patched).toContainEqual(['gitee:acme/widgets:I1', expect.objectContaining({ title: 'Fix the header' })])
  })
  it('does not receive an unaddressed issue or comment while observation is off, and receives an addressed comment', async () => {
    const h = context()
    const old = '2026-11-16T00:00:00.000Z'
    h.ctx.state.set('gitee-stream:acme/widgets', { since: old, started: { detect: old } })
    const quiet = { ...ISSUE, body: 'no request here' }
    const mentioned = { ...COMMENT, body: '@agent please look' }
    await pollRound(h.ctx, client([quiet], [mentioned]), 'agent', new AbortController().signal)
    expect(h.received).toEqual([expect.objectContaining({ meta: expect.objectContaining({ kind: 'comment' }) })])
  })
  it('polls comments on a subscribed issue even when repository-wide comments are off', async () => {
    const h = context({}, [thread('acme/widgets:I1')])
    const fake = client([], [COMMENT], ISSUE)
    await pollRound(h.ctx, fake, 'agent', new AbortController().signal)
    expect(h.received).toEqual([expect.objectContaining({ text: 'more detail' })])
  })
})

describe('Gitee replies and thread context', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'gitee-'))
  afterEach(() => { vi.unstubAllGlobals() })
  it('posts an idempotent comment with a marker and returns gone for a removed issue', async () => {
    const dir = root()
    const file = join(dir, 'token')
    writeFileSync(file, 'secret')
    const bodies: string[] = []
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      if (init.method === 'POST') { posts += 1; bodies.push(String(init.body)); return new Response('{}', { status: 200 }) }
      return new Response(JSON.stringify(url.pathname.endsWith('/comments') ? [] : []), { status: 200 })
    }))
    const message = { id: 'reply-1', channel: giteeChannel('acme/widgets', 'I1'), text: 'done', kind: 'reply' as const }
    expect(await sendGitee({ commands: {}, config: config({ tokenFile: file }) }, message)).toBe('sent')
    expect(posts).toBe(1)
    expect(bodies[0]).toContain('done')
    expect(bodies[0]).toContain('<!-- dsh-superagent:reply-1 -->')
    // The same message read again finds its marker and posts nothing.
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(JSON.stringify(url.pathname.endsWith('/comments')
      ? [{ id: '1', body: bodies[0], user: { login: 'agent' }, created_at: NOW }] : []), { status: 200 })))
    expect(await sendGitee({ commands: {}, config: config({ tokenFile: file }) }, message)).toBe('sent')
    expect(posts).toBe(1)
    // A removed issue is a permanent answer, not a retry loop.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Gone' }), { status: 410 })))
    expect(await sendGitee({ commands: {}, config: config({ tokenFile: file }) }, message)).toBe('gone')
    rmSync(dir, { recursive: true, force: true })
  })
  it('reads an issue description and a page of its comments, and links to a Gitee issue', async () => {
    const dir = root()
    const file = join(dir, 'token')
    writeFileSync(file, 'secret')
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const value = url.pathname.endsWith('/comments') ? [COMMENT] : ISSUE
      return new Response(JSON.stringify(value), { status: 200 })
    }))
    const trigger: Trigger = { id: 't', source: 'gitee', threads: [{ source: 'gitee', id: 'acme/widgets:I1' }], actor: { source: 'gitee', id: 'alice' },
      human: true, at: NOW, text: '', url: ISSUE.html_url, meta: { number: 'I1', kind: 'issue', repository: 'acme/widgets' } }
    const page = await giteeThreadContext.read({} as never, trigger, 'thread', '1', config({ tokenFile: file }))
    expect(page.messages).toEqual([expect.objectContaining({ id: ISSUE.html_url, from: 'alice' }),
      expect.objectContaining({ id: commentPage(ISSUE.html_url, '9'), from: 'bob', text: 'more detail' })])
    expect(giteeLink({ number: 'I1', url: ISSUE.html_url }, {})).toEqual({ url: ISSUE.html_url, label: { zh: 'Gitee #I1', en: 'Gitee #I1' } })
    rmSync(dir, { recursive: true, force: true })
  })
})
