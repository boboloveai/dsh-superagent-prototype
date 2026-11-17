/** Gitee thread context: an issue description and its comments as model-facing messages, by page. */
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { giteeClient, type GiteeConnection } from './gitee-api.ts'
import { GiteeCommentSchema, GiteeIssueSchema, commentPage, isHumanGiteeUser, type GiteeComment, type GiteeIssue } from './gitee-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const PER_PAGE = 100
function issueMessage(issue: GiteeIssue): ContextMessage {
  return { id: issue.html_url, from: issue.user.login, at: issue.created_at, text: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
    ...!isHumanGiteeUser(issue.user) ? { bot: true as const } : {}, url: issue.html_url }
}
function commentMessage(comment: GiteeComment, issue: GiteeIssue): ContextMessage {
  const url = commentPage(issue.html_url, comment.id)
  return { id: url, from: comment.user.login, at: comment.updated_at ?? comment.created_at, text: comment.body ?? '',
    ...!isHumanGiteeUser(comment.user) ? { bot: true as const } : {}, url }
}
/**
 * Reads an issue and one page of its comments. Gitee comments are flat, so the issue description is the root and the parent
 * of every comment; `thread` page 1 contains the description followed by the first comments.
 */
export const giteeThreadContext: ThreadContext<GiteeConnection> = {
  messageId: trigger => trigger.url ?? '',
  read: async (_commands, trigger, part, cursor, config) => {
    const number = String(trigger.meta.number ?? '')
    if (!number) throw new Error('The Gitee Trigger has no issue number')
    if (!sameName(String(trigger.meta.repository ?? ''), config.repository)) throw new Error('The Gitee Trigger belongs to another repository')
    const client = giteeClient(config, AbortSignal.timeout(60_000))
    const issue = await client.get(GiteeIssueSchema, `issues/${encodeURIComponent(number)}`)
    if (part !== 'thread') {
      const messages = [issueMessage(issue)]
      return { messages, body: { messages } }
    }
    const page = Math.max(1, Number(cursor ?? '1') || 1)
    const comments = await client.get(z.array(GiteeCommentSchema), `issues/${encodeURIComponent(number)}/comments`,
      { page, per_page: PER_PAGE })
    const messages = [...page === 1 ? [issueMessage(issue)] : [], ...comments.map(comment => commentMessage(comment, issue))]
    return { messages, body: { messages }, ...comments.length === PER_PAGE ? { next: String(page + 1) } : {} }
  },
}
