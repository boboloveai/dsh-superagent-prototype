/** Gitee outbound channel: posts issue comments under the configured access token, idempotently. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { GiteeError, giteeClient, type GiteeConnection } from './gitee-api.ts'
import { GiteeCommentSchema, GiteeNumberSchema } from './gitee-trigger.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { sameName } from '../infra/text.ts'

/** Gitee reports a removed resource as 410; 404 is retried because it can mean the token lost access to a repository. */
const gone = (error: unknown): boolean => error instanceof GiteeError && error.status === 410
/**
 * Posts a comment on an issue. Gitee has no idempotency key, so the body carries an HTML marker derived from the message id;
 * an earlier comment with the marker means the message already arrived, and a retry posts nothing.
 */
export async function sendGitee(host: { commands: unknown; config: GiteeConnection }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const number = GiteeNumberSchema.safeParse(message.channel.address.number)
  const repository = message.channel.address.repository
  if (!number.success || !repository || !sameName(repository, host.config.repository)) throw new Error('Missing or outdated Gitee reply target')
  const client = giteeClient(host.config, AbortSignal.timeout(90_000))
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const path = `issues/${encodeURIComponent(number.data)}/comments`
  try {
    const comments = await client.list(GiteeCommentSchema, path)
    if (comments.some(comment => (comment.body ?? '').includes(marker))) return 'sent'
    await client.post(z.unknown(), path, { body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The panel's link to a Gitee issue; comments keep the anchor of the message they answer. */
export function giteeLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  return { url: address.url ?? '', label: { zh: `Gitee #${number}`, en: `Gitee #${number}` } }
}
/** A reply may go only to an issue of the configured repository. */
export function giteeAllowed(address: Record<string, string>, config: GiteeConnection): boolean {
  return !!config.repository && !!address.repository && sameName(address.repository, config.repository)
    && GiteeNumberSchema.safeParse(address.number).success
}
