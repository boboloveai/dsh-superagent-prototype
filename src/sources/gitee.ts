/** Gitee Source kind, issue/comment polling, and Cordis plugin entry. Gitee is polled because its API has no repository event feed. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { GiteeError, GiteeTokenError, giteeClient, type GiteeReader } from './gitee-api.ts'
import { giteeAllowed, giteeLink, sendGitee } from './gitee-channel.ts'
import { GiteeCommentSchema, GiteeIssueSchema, commentTrigger, issueTrigger, mentions, type GiteeIssue } from './gitee-trigger.ts'
import { giteeThreadContext } from './gitee-read.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

export const SOURCE = 'gitee'
/** Gitee's issue and comment lists are page-numbered; 100 is the largest page size it accepts. */
const MAX_ISSUES = 2000
const ConfigSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  tokenFile: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type GiteeConfig = z.infer<typeof ConfigSchema>
const OBSERVED = { issues: 'observeIssues', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
const scopeOf = (meta: Record<string, unknown>): Scope | undefined =>
  meta.kind === 'issue' ? 'issues' : meta.kind === 'comment' ? 'comments' : undefined
const threadKey = (repository: string, number: string): string => `${SOURCE}:${repository}:${number}`
const threadAddress = (id: string): { repository: string; number: string } | undefined => {
  const split = id.lastIndexOf(':')
  if (split < 1 || !numberPattern.test(id.slice(split + 1))) return undefined
  const repository = id.slice(0, split)
  return isRepository(repository) ? { repository, number: id.slice(split + 1) } : undefined
}
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const isRepository = (value: string): boolean => repositoryPattern.test(value)
/** Gitee issue numbers are identifiers; use the same conservative shape the trigger parser accepts. */
const numberPattern = /^[A-Za-z0-9_-]+$/
export const giteeKind: SourceKind<GiteeConfig> = {
  kind: SOURCE,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '智能体的 Gitee 账号；接收仓库里发给它的新 Issue、Issue 评论，并轮询已订阅工单的后续评论。',
    en: 'The agent\'s Gitee account; receives new Issues and Issue comments that address it in the repository, and polls later comments on subscribed Tickets.' },
  schema: ConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源接收这个仓库的 Issue 和评论；Gitee 没有仓库事件推送，因此按轮询读取。', en: 'Written owner/name. This Source receives this repository\'s Issues and comments; Gitee has no repository event feed, so it polls.' } },
    { key: 'tokenFile', type: 'text', label: { zh: '访问令牌文件', en: 'Access token file' },
      hint: { zh: '保存 Gitee 私人令牌的绝对路径（不要把令牌本身填在这里）。令牌所属账号就是智能体：它发布评论，它的 Issue 和评论不会被当成请求。', en: 'Absolute path of a file holding a Gitee personal access token (do not paste the token itself). The token\'s account is the agent: it posts comments, and its own Issues and comments are not requests.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive Issue comments in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。已订阅工单的后续评论始终接收。', en: 'Comments that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read. Later comments on subscribed Tickets are always received.' } },
  ],
  scope: ({ meta }, config) => {
    if (!sameName(String(meta.repository ?? ''), config.repository)) return { listened: false, reason: 'repository_not_listed' }
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: [SOURCE],
  channel: { allowed: giteeAllowed, send: sendGitee, link: giteeLink },
  threadContext: giteeThreadContext,
  find: query => {
    const value = query.trim()
    const match = /gitee\.com\/([^/]+\/[^/]+)\/issues\/([A-Za-z0-9_-]+)/i.exec(value)
    return { threads: match ? [threadKey(match[1]!, match[2]!)] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(200) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的 Gitee 机器人账号的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。',
        en: 'A comment of a Gitee bot account on this list becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的 Gitee 账号。', en: 'An account on the list mentions the agent\'s Gitee account in an Issue or a comment.' },
    unnamed: { person: { zh: 'Gitee 用户', en: 'Gitee user' }, bot: { zh: 'Gitee 机器人', en: 'Gitee bot' } },
    rows(stored) {
      const config = ConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEE_REPOSITORY', description: { zh: '这个来源监听的 Gitee 仓库，owner/name', en: 'The Gitee repository this Source watches, as owner/name' } },
      { key: 'DSH_SUPERAGENT_GITEE_NUMBER', description: { zh: '接下工单的 Gitee Issue 编号；工单不是从 Gitee 来的时为空', en: 'Number of the Gitee Issue that started the ticket; empty when the ticket did not start on Gitee' } },
    ],
    values: ({ config, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.number ?? '') : ''
      return { DSH_SUPERAGENT_GITEE_REPOSITORY: config.repository, DSH_SUPERAGENT_GITEE_NUMBER: number }
    },
  },
}
export const name = 'dsh-superagent-gitee'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteeKind), 'gitee: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteeKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** Health for a failure that a later poll cannot fix: a missing or unreadable token, or a rejected one. */
function permanentFailure(error: unknown): Health | undefined {
  if (error instanceof GiteeTokenError) {
    return error.kind === 'unset' ? health('paused', 'giteeTokenUnset') : health('error', 'giteeTokenUnreadable', { file: error.file })
  }
  if (error instanceof GiteeError && (error.status === 401 || error.status === 403)) return health('error', 'giteeAccessDenied')
  return undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteeConfig>(SOURCE)
    try {
      if (!config) {
        for (const key of ctx.state.keys(KV.gitee.stream)) ctx.state.set(key, undefined)
        ctx.report(SOURCE, health('paused', 'sourceOff'))
        failures = 0
      } else if (!isRepository(config.repository)) {
        ctx.report(SOURCE, health('paused', 'giteeRepositoryUnset'))
        failures = 0
      } else {
        const client = giteeClient(config, signal)
        const account = await client.login()
        const round = await pollRound(ctx, client, account, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${round.received} new Gitee messages; next poll ≥ ${round.interval}s`, at: round.started })
        interval = round.interval
      }
    } catch (error) {
      if (signal.aborted) return
      const permanent = permanentFailure(error)
      if (permanent) ctx.report(SOURCE, permanent)
      else {
        failures += 1
        const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
        if (failed) ctx.report(SOURCE, failed)
      }
    }
    await pause(Math.max(interval, ctx.config<GiteeConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; received: number; read: Set<string>; interval: number }
const stopped = (ctx: SourceContext, signal: AbortSignal): boolean => signal.aborted || !ctx.config(SOURCE)
/**
 * One polling round: issues updated since the cursor, the comments each carries, and the comments of subscribed Tickets.
 * Repository-wide reads start when their switch is turned on; later comments on a Ticket are always read.
 */
export async function pollRound(ctx: SourceContext, client: GiteeReader, account: string, signal: AbortSignal): Promise<Round> {
  const round: Round = { started: new Date().toISOString(), received: 0, read: new Set(), interval: ctx.config<GiteeConfig>(SOURCE)?.pollSeconds ?? 60 }
  await pollIssueStream(ctx, client, account, round, signal)
  await pollTickets(ctx, client, account, round, signal)
  return round
}
async function pollIssueStream(ctx: SourceContext, client: GiteeReader, account: string, round: Round, signal: AbortSignal): Promise<void> {
  const config = ctx.config<GiteeConfig>(SOURCE)
  if (!config) return
  const stored = ctx.state.get(KV.gitee.stream(config.repository))
  const issuesStarted = config.observeIssues ? stored?.started.issues ?? round.started : undefined
  const commentsStarted = config.observeComments ? stored?.started.comments ?? round.started : undefined
  const detectStart = stored?.started.detect ?? round.started
  const issueLogStart = issuesStarted ?? detectStart
  const since = new Date(Math.max(Date.parse(stored?.since ?? detectStart), Date.parse(round.started) - POLL_HORIZON_MS)).toISOString()
  const started: { detect: string; issues?: string; comments?: string } = { detect: stored?.started.detect ?? round.started,
    ...issuesStarted ? { issues: issuesStarted } : {}, ...commentsStarted ? { comments: commentsStarted } : {} }
  const issues = (await client.list(GiteeIssueSchema, 'issues', { state: 'all', sort: 'updated', direction: 'asc', since }))
    .sort((a, b) => Date.parse(a.updated_at ?? a.created_at) - Date.parse(b.updated_at ?? b.created_at))
  const batch = issues.slice(0, MAX_ISSUES)
  for (const issue of batch) {
    if (stopped(ctx, signal)) throw new Error('The Gitee Source stopped during the poll')
    if (issue.pull_request) continue
    const number = issue.number
    const thread = ctx.threads.get(threadKey(config.repository, number))
    const subscribed = !!thread?.subscriptions.length
    const fresh = Date.parse(issue.created_at) >= Date.parse(issueLogStart)
    const body = issue.body ?? ''
    if (fresh && (config.observeIssues || mentions(body, account))) {
      const trigger = issueTrigger(issue, account, config.repository)
      if (trigger) { await ctx.receive(trigger); round.received += 1 }
    }
    if (issue.title) nameThread(ctx, issue, config.repository)
    const cursor = commentCursor(ctx, issue, config.repository, since, commentsStarted)
    round.read.add(number)
    round.received += await readComments(ctx, client, issue, cursor, account, config, config.observeComments || subscribed, round, signal)
  }
  // Continue after the last Issue handed to this round; Trigger ids deduplicate the five-second overlap.
  const newest = batch.at(-1)?.updated_at ?? batch.at(-1)?.created_at
  // A complete batch has read everything through this round; a capped batch continues after its last Issue.
  const moved = issues.length <= MAX_ISSUES || !newest ? cursorAt(round.started) : cursorAt(new Date(newest).toISOString())
  ctx.atomic(() => ctx.state.set(KV.gitee.stream(config.repository), { since: moved, started }))
}
/** The timestamp from which this Issue's comments have not been read; a newly observed Issue starts at its own creation. */
function commentCursor(ctx: SourceContext, issue: GiteeIssue, repository: string, since: string, observed: string | undefined): string {
  const stored = ctx.state.get(KV.gitee.issue(repository, issue.number))
  const floor = observed ? Math.max(Date.parse(since), Date.parse(observed)) : Date.parse(since)
  return new Date(Math.max(floor, stored ? Date.parse(stored) : 0, Date.parse(issue.created_at))).toISOString()
}
async function readComments(ctx: SourceContext, client: GiteeReader, issue: GiteeIssue, cursor: string, account: string,
  config: GiteeConfig, all: boolean, round: Round, signal: AbortSignal): Promise<number> {
  const comments = await client.list(GiteeCommentSchema, `issues/${encodeURIComponent(issue.number)}/comments`, { since: cursor })
  let received = 0
  for (const comment of comments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (stopped(ctx, signal)) throw new Error('The Gitee Source stopped during the poll')
    if (Date.parse(comment.created_at) < Date.parse(cursor)) continue
    const trigger = commentTrigger(comment, issue, account, config.repository)
    if (!trigger) continue
    if (!all && !trigger.addressed) continue
    await ctx.receive(trigger)
    received += 1
  }
  ctx.state.set(KV.gitee.issue(config.repository, issue.number), cursorAt(round.started))
  return received
}
/** Polls subscribed Gitee Issues not already read in this round, so a Ticket receives later comments even after it ended. */
async function pollTickets(ctx: SourceContext, client: GiteeReader, account: string, round: Round, signal: AbortSignal): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, signal), async thread => {
    const config = ctx.config<GiteeConfig>(SOURCE)
    if (!config) return
    const address = threadAddress(thread.ref.id)
    if (!address || !sameName(address.repository, config.repository) || round.read.has(address.number)) return
    const { number } = address
    const issue = await client.get(GiteeIssueSchema, `issues/${encodeURIComponent(number)}`)
    if (issue.title) nameThread(ctx, issue, config.repository)
    const cursor = ctx.state.get(KV.gitee.issue(config.repository, number)) ?? thread.createdAt
    round.read.add(number)
    round.received += await readComments(ctx, client, issue, cursor, account, config, true, round, signal)
  }, thread => round.read.has(threadAddress(thread.ref.id)?.number ?? ''))
}
function nameThread(ctx: SourceContext, issue: GiteeIssue, repository: string): void {
  const number = issue.number
  ctx.threads.patch(threadKey(repository, number), { number, url: issue.html_url, title: issue.title })
  ctx.threads.describe(threadKey(repository, number), { label: `#${number} ${issue.title}`, url: issue.html_url,
    facts: { number: { value: `#${number}` } } })
}
