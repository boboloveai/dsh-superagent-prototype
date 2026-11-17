/** Minimal Gitee REST v5 client: token loading, repository-scoped calls, pagination, and typed responses. */
import { isAbsolute, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** The public Gitee API; every request path is relative to it. */
export const GITEE_API = 'https://gitee.com/api/v5'
/** The largest number of pages one list call reads, so a runaway repository cannot hold a poll forever. */
const MAX_PAGES = 20
const PAGE_SIZE = 100
/** The part of a Gitee Source configuration a client needs: the repository and where its access token is kept. */
export interface GiteeConnection { repository: string; tokenFile: string }
/** The repository-scoped Gitee reads and writes a poll or reply uses; `GiteeClient` is the production implementation. */
export interface GiteeReader {
  login(): Promise<string>
  get<T>(schema: z.ZodType<T>, path: string, query?: Record<string, string | number | undefined>): Promise<T>
  list<T>(schema: z.ZodType<T>, path: string, query?: Record<string, string | number | undefined>): Promise<T[]>
  post<T>(schema: z.ZodType<T>, path: string, body: Record<string, unknown>): Promise<T>
}
/** A Gitee API failure, with the HTTP status when the response had one. */
export class GiteeError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
/** The access token is missing, points at a file that cannot be read, or is not an absolute path. */
export class GiteeTokenError extends Error {
  constructor(readonly file: string, readonly kind: 'unset' | 'unreadable') {
    super(kind === 'unset' ? 'The Gitee Source has no access token file; set one on the Gitee card' : `The Gitee token file ${file} cannot be read`)
  }
}
/** Reads the token from its configured file; tokens are never kept in Source settings or passed in the process environment. */
export function giteeToken(connection: Pick<GiteeConnection, 'tokenFile'>): string {
  const file = connection.tokenFile.trim()
  if (!file) throw new GiteeTokenError('', 'unset')
  if (!isAbsolute(file)) throw new GiteeTokenError(file, 'unreadable')
  try {
    const token = readFileSync(resolve(file), 'utf8').trim()
    if (token) return token
    throw new GiteeTokenError(file, 'unreadable')
  } catch (error) {
    if (error instanceof GiteeTokenError) throw error
    throw new GiteeTokenError(file, 'unreadable')
  }
}
function fail(status: number, body: unknown, token: string): GiteeError {
  const message = (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
    ? body.message
    : `Gitee returned HTTP ${status}`).split(token).join('[redacted]')
  return new GiteeError(message, status)
}
/**
 * Calls the Gitee API for one repository. The token is sent in both the documented `access_token` query parameter and the
 * Authorization header, because Gitee deployments differ in which one they accept; errors never echo a URL that carries it.
 */
export class GiteeClient implements GiteeReader {
  private readonly base: string
  constructor(connection: Pick<GiteeConnection, 'repository'>, private readonly token: string,
    private readonly signal: AbortSignal) {
    this.base = `repos/${connection.repository.split('/').map(encodeURIComponent).join('/')}`
  }
  /** The account the token belongs to, used to skip the agent's own issues and comments. */
  async login(): Promise<string> {
    const user = await this.absolute(z.looseObject({ login: z.string() }), 'GET', 'user')
    return user.login
  }
  /** Reads one repository-scoped resource, such as `issues/IKTNFO`. */
  async get<T>(schema: z.ZodType<T>, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.absolute(schema, 'GET', `${this.base}/${path.replace(/^\/+/, '')}`, query)
  }
  /** Reads every page of a repository-scoped list, oldest page first. */
  async list<T>(schema: z.ZodType<T>, path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const values = await this.get(z.array(schema), path, { ...query, page, per_page: PAGE_SIZE })
      items.push(...values)
      if (values.length < PAGE_SIZE) break
    }
    return items
  }
  /** Posts JSON to a repository-scoped resource, such as a comment. */
  async post<T>(schema: z.ZodType<T>, path: string, body: Record<string, unknown>): Promise<T> {
    return this.absolute(schema, 'POST', `${this.base}/${path.replace(/^\/+/, '')}`, {}, body)
  }
  private async absolute<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, query: Record<string, string | number | undefined> = {},
    body?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${GITEE_API}/${path.replace(/^\/+/, '')}`)
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(name, String(value))
    url.searchParams.set('access_token', this.token)
    let response: Response
    try {
      response = await fetch(url, { method, signal: AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]),
        headers: { accept: 'application/json', authorization: `token ${this.token}`,
          ...body ? { 'content-type': 'application/json' } : {} },
        ...body ? { body: JSON.stringify(body) } : {} })
    } catch (error) {
      // Do not include the request URL: it carries the token. Redact a token echoed by the transport.
      const message = (error instanceof Error ? error.message : String(error)).split(this.token).join('[redacted]')
      throw new GiteeError(`Gitee request failed: ${message}`)
    }
    const text = await response.text()
    let value: unknown
    try { value = text ? JSON.parse(text) : undefined }
    catch { if (!response.ok) throw new GiteeError(`Gitee returned HTTP ${response.status}`, response.status); throw new GiteeError('Gitee returned invalid JSON') }
    if (!response.ok) throw fail(response.status, value, this.token)
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new GiteeError(`Gitee returned an unexpected ${method} ${path} response`)
    return parsed.data
  }
}
/** Builds a client for one poll or reply, reading the token afresh so a rotated token takes effect on the next call. */
export function giteeClient(connection: GiteeConnection, signal: AbortSignal): GiteeClient {
  return new GiteeClient(connection, giteeToken(connection), signal)
}
