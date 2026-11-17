/** Normalizes Gitee issues and issue comments into domain Triggers, with stable ids and Gitee reply addresses. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitee'
const NUMBER = /^[A-Za-z0-9_-]+$/
/** A Gitee issue number is an identifier such as IKTNFO, not always a number. */
export const GiteeNumberSchema = z.union([z.string(), z.number()]).transform(value => String(value)).refine(value => NUMBER.test(value), 'Gitee issue number')
/** Gitee's user object; `type` is `User` for people and may be `Bot` for an automated account. */
export const GiteeUserSchema = z.looseObject({ login: z.string(), name: z.string().optional(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
export type GiteeUser = z.infer<typeof GiteeUserSchema>
/** An issue as Gitee's issue list and issue endpoint return it. */
export const GiteeIssueSchema = z.looseObject({
  id: z.number().optional(), number: GiteeNumberSchema, title: z.string(), body: z.string().nullish(),
  state: z.string().optional(), created_at: z.string(), updated_at: z.string().nullish(), html_url: z.string(),
  user: GiteeUserSchema, pull_request: z.unknown().nullish(),
})
export type GiteeIssue = z.infer<typeof GiteeIssueSchema>
/** A Gitee issue comment. Gitee comments are flat: they do not name the comment they answer. */
export const GiteeCommentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(value => String(value)), body: z.string().nullish(),
  user: GiteeUserSchema, created_at: z.string(), updated_at: z.string().nullish(),
})
export type GiteeComment = z.infer<typeof GiteeCommentSchema>
/** Gitee reply address: the issue number, and the page or comment URL the reply belongs under. */
export const giteeThread = (repository: string, number: string): string => `${repository}:${number}`
export const giteeChannel = (repository: string, number: string, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${giteeThread(repository, number)}`, address: { repository, number, ...(url ? { url } : {}) } })
export const giteePage = (repository: string, number: string): string => `https://gitee.com/${repository}/issues/${number}`
/** The anchor Gitee gives a comment on an issue page. */
export const commentPage = (issueUrl: string, commentId: string): string => `${issueUrl}#note_${commentId}`
/** Parses a Gitee issue URL in `repository`; other hosts, repositories and URLs are ignored. */
export function giteeAddress(url: string, repository: string): { repository: string; number: string } | undefined {
  const match = /^https:\/\/gitee\.com\/([^/]+\/[^/]+)\/issues\/([A-Za-z0-9_-]+)\/?(?:#.*)?$/i.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { repository: match[1]!, number: match[2]! }
}
/** True unless Gitee identifies the account as a bot; bots can never authorize work on their own. */
export const isHumanGiteeUser = (user: Pick<GiteeUser, 'login' | 'type'>): boolean =>
  !/\[bot\]$/i.test(user.login) && (user.type ?? 'User').toLowerCase() !== 'bot'
/** True when `text` mentions `login` as a Gitee account name, not as part of a longer one. */
export const mentions = (text: string, login: string): boolean =>
  !!login && new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: GiteeUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanGiteeUser(user) && !sameName(user.login, agent) })
/** Builds the Trigger for an issue title and body; the agent's own issues produce none. */
export function issueTrigger(issue: GiteeIssue, agent: string, repository: string): Trigger | undefined {
  if (sameName(issue.user.login, agent)) return undefined
  const body = issue.body ?? ''
  return { id: key('gitee-issue', repository, issue.number), source: SOURCE,
    threads: [{ source: SOURCE, id: giteeThread(repository, issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel(repository, issue.number, issue.html_url), url: issue.html_url,
    meta: { number: issue.number, kind: 'issue', repository, url: issue.html_url } }
}
/** Builds the Trigger for one issue comment; empty comments produce none, and the agent's own comments are skipped by callers. */
export function commentTrigger(comment: GiteeComment, issue: GiteeIssue, agent: string, repository: string): Trigger | undefined {
  if (sameName(comment.user.login, agent)) return undefined
  const text = comment.body ?? ''
  if (!text.trim()) return undefined
  const url = commentPage(issue.html_url, comment.id)
  return { id: key('gitee-comment', repository, issue.number, comment.id, comment.updated_at ?? comment.created_at), source: SOURCE,
    threads: [{ source: SOURCE, id: giteeThread(repository, issue.number) }], ...author(comment.user, agent), at: comment.updated_at ?? comment.created_at,
    text,
    ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel(repository, issue.number, url), url,
    meta: { number: issue.number, kind: 'comment', repository, commentId: comment.id, issueUrl: issue.html_url } }
}
