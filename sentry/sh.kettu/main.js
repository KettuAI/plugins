// @ts-check

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/i
const NUMERIC = /^\d{1,20}$/
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-[A-Za-z0-9]+$/
// An issue's address: on sentry.io or an organization's own host, with the organization in the path
// or in the host name.
const ISSUE_URL = /^https:\/\/([a-z0-9.-]+\.sentry\.io|sentry\.io)\/(?:organizations\/([^/?#]+)\/)?issues\/([^/?#]+)/i
const REGION_HOST = /^(us|de)\.sentry\.io$/i
const CARD_CACHE_MS = 60_000
const FRAMES = 20

/**
 * @typedef {{ id: string, shortId: string, title: string, culprit?: string | null, permalink?: string,
 *   level?: string, status?: string, count?: string, userCount?: number, firstSeen?: string,
 *   lastSeen?: string, project?: { slug: string, name?: string },
 *   metadata?: { value?: string, type?: string },
 *   assignedTo?: { name?: string, email?: string } | null }} Issue
 * @typedef {{ filename?: string, function?: string | null, lineNo?: number | null, colNo?: number | null,
 *   inApp?: boolean, context?: [number, string][] | null }} Frame
 * @typedef {{ title?: string, message?: string | null, dateCreated?: string,
 *   tags?: { key: string, value: string }[],
 *   entries?: { type: string, data?: any }[] }} SentryEvent
 */

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error))
/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** @param {Record<string, string | number | string[] | undefined>} params */
function queryString(params) {
  /** @type {string[]} */
  const parts = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    for (const one of Array.isArray(value) ? value : [value]) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(one))}`)
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

async function organization() {
  const slug = String(await kettu.call('settings.get', 'organization')).trim()
  if (slug === '') throw new Error('Set your organization’s slug in the plugin settings')
  if (!SLUG.test(slug)) throw new Error('The organization slug may hold only letters, numbers, - _ and .')
  return slug
}

/** The API is on the region's own host, whatever address a link had. */
async function base(/** @type {string | null} */ region = null) {
  const set = String(await kettu.call('settings.get', 'region'))
  return `https://${region ?? (set === 'de' ? 'de' : 'us')}.sentry.io/api/0`
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ query?: Record<string, string | number | string[] | undefined>, body?: unknown, region?: string | null }} [options]
 */
async function sentry(method, path, options = {}) {
  const token = ((await kettu.call('settings.secret', 'token')) ?? '').trim()
  if (token === '') throw new Error('Add your Sentry auth token in the plugin settings')
  const response = await kettu.call(
    'network.fetch',
    `${await base(options.region)}${path}${queryString(options.query ?? {})}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  )
  /** @type {any} */
  let body = null
  try {
    body = JSON.parse(response.body)
  } catch {
    // Not a JSON answer.
  }
  if (response.status >= 200 && response.status < 300) return body
  const detail = typeof body?.detail === 'string' ? clip(body.detail, 200) : ''
  if (response.status === 401) throw new Error('Sentry did not accept the auth token')
  if (response.status === 403) {
    throw new Error(`The token may not do this${detail ? ` (${detail})` : ''}; it needs the scopes event:read, project:read and, to resolve, event:write`)
  }
  if (response.status === 404) throw new Error('Sentry found no such organization, project or issue')
  if (response.status === 429) {
    const wait = response.headers['retry-after']
    throw new Error(`Sentry’s rate limit is reached; try again${wait ? ` in ${wait} s` : ' in a minute'}`)
  }
  throw new Error(`Sentry answered ${response.status}${detail ? `: ${detail}` : ''}`)
}

/**
 * The issue a tool or a mention names: its numeric id, a short id such as PROJ-1A, or its address.
 * @param {string} text
 * @param {string} org
 * @param {string | null} [region]
 */
async function issueId(text, org, region = null) {
  const trimmed = text.trim()
  const found = ISSUE_URL.exec(trimmed)
  const wanted = found ? decodeURIComponent(/** @type {string} */ (found[3])) : trimmed
  if (NUMERIC.test(wanted)) return wanted
  if (!SHORT_ID.test(wanted)) {
    throw new Error('Give an issue’s id, its short id such as PROJ-1A, or its address')
  }
  const list = /** @type {Issue[]} */ (
    await sentry('GET', `/organizations/${encodeURIComponent(org)}/issues/`, {
      query: { query: wanted, shortIdLookup: '1', limit: 5, collapse: ['stats'] },
      region,
    })
  )
  const same = list.find((issue) => issue.shortId.toUpperCase() === wanted.toUpperCase())
  if (!same) throw new Error(`No issue has the short id ${clip(wanted, 60)}`)
  return same.id
}

/** @param {string} org @param {string} id @param {string | null} [region] */
async function readIssue(org, id, region = null) {
  return /** @type {Issue} */ (
    await sentry('GET', `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(id)}/`, { region })
  )
}

/** The newest event of an issue; null when there is none or it cannot be read. */
/** @param {string} org @param {string} id */
async function latestEvent(org, id) {
  try {
    return /** @type {SentryEvent} */ (
      await sentry('GET', `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(id)}/events/latest/`)
    )
  } catch (error) {
    console.warn(`No latest event for issue ${id}: ${message(error)}`)
    return null
  }
}

/**
 * @param {string} org
 * @param {{ project?: string, query?: string, limit?: number, shortIds?: boolean }} options
 */
async function listIssues(org, { project, query, limit = 25, shortIds = false }) {
  return /** @type {Issue[]} */ (
    await sentry('GET', `/organizations/${encodeURIComponent(org)}/issues/`, {
      query: {
        query: query ?? 'is:unresolved',
        project: project === undefined || project === '' ? undefined : project,
        sort: 'date',
        shortIdLookup: shortIds ? '1' : undefined,
        limit: Math.min(Math.max(limit, 1), 50),
        collapse: ['stats'],
      },
    })
  )
}

/** @param {string | null | undefined} iso */
const day = (iso) => (iso ? iso.slice(0, 10) : '')

/** The facts of an issue, one per line. */
/** @param {Issue} issue */
function head(issue) {
  const lines = [`${issue.shortId}: ${issue.title}`]
  if (issue.permalink) lines.push(`Address: ${issue.permalink}`)
  if (issue.project) lines.push(`Project: ${issue.project.slug}`)
  lines.push(
    `Level: ${issue.level ?? 'unknown'}   Status: ${issue.status ?? 'unknown'}`,
    `Events: ${issue.count ?? '?'}   Users: ${issue.userCount ?? '?'}`,
    `First seen: ${day(issue.firstSeen)}   Last seen: ${day(issue.lastSeen)}`,
  )
  if (issue.culprit) lines.push(`Culprit: ${issue.culprit}`)
  if (issue.assignedTo) lines.push(`Assigned to: ${issue.assignedTo.name ?? issue.assignedTo.email ?? 'someone'}`)
  return lines
}

/** @param {Frame} frame @param {boolean} source */
function frameLines(frame, source) {
  const where = `${frame.filename ?? '?'}${frame.lineNo ? `:${frame.lineNo}` : ''}${frame.colNo ? `:${frame.colNo}` : ''}`
  const out = [`  at ${frame.function || '<anonymous>'} (${where})${frame.inApp ? ' [app]' : ''}`]
  const line = source && frame.lineNo ? frame.context?.find(([n]) => n === frame.lineNo) : undefined
  if (line) out.push(`      ${line[0]} | ${clip(line[1].trim(), 160)}`)
  return out
}

/**
 * The exceptions of an event with their stack traces, oldest call first as Sentry stores them, so
 * the last frame is where it was raised; a message when the event has no exception.
 * @param {SentryEvent | null} event
 */
function traceText(event) {
  if (!event) return 'No event could be read for this issue.'
  const exception = event.entries?.find((entry) => entry.type === 'exception')
  /** @type {{ type?: string, value?: string, stacktrace?: { frames?: Frame[] } | null }[]} */
  const values = exception?.data?.values ?? []
  const lines = [`Latest event${event.dateCreated ? ` (${event.dateCreated})` : ''}: ${event.title ?? ''}`.trim()]
  const tags = new Map((event.tags ?? []).map((tag) => [tag.key, tag.value]))
  for (const key of ['environment', 'release']) if (tags.has(key)) lines.push(`${key}: ${tags.get(key)}`)
  if (values.length === 0) {
    if (event.message) lines.push('', clip(event.message, 2000))
    return lines.join('\n')
  }
  for (const value of values) {
    lines.push('', `${value.type ?? 'Error'}: ${clip(value.value ?? '', 500)}`)
    const frames = value.stacktrace?.frames ?? []
    if (frames.length === 0) continue
    if (frames.length > FRAMES) lines.push(`  (${frames.length - FRAMES} earlier frames left out)`)
    lines.push('  most recent call last:')
    for (const frame of frames.slice(-FRAMES)) lines.push(...frameLines(frame, frame.inApp === true))
  }
  return lines.join('\n')
}

// Tools

exports.list_issues = async (/** @type {{ project?: string, query?: string, limit?: number }} */ args) => {
  const org = await organization()
  const project = (args.project ?? String(await kettu.call('settings.get', 'project'))).trim()
  const issues = await listIssues(org, { project, ...(args.query ? { query: args.query } : {}), limit: args.limit ?? 10 })
  if (issues.length === 0) return `No ${args.query ? 'matching' : 'unresolved'} issues${project ? ` in ${project}` : ''}.`
  return issues
    .map(
      (i) =>
        `${i.shortId}  [${i.level ?? '?'}] ${i.title}  (${i.count ?? '?'} events, last seen ${day(i.lastSeen)}, id ${i.id})`,
    )
    .join('\n')
}

exports.read_issue = async (/** @type {{ id: string }} */ { id }) => {
  const org = await organization()
  const issue = await readIssue(org, await issueId(id, org))
  return [...head(issue), '', traceText(await latestEvent(org, issue.id))].join('\n')
}

exports.resolve_issue = async (/** @type {{ id: string }} */ { id }) => {
  const org = await organization()
  const found = await issueId(id, org)
  const issue = /** @type {Issue} */ (
    await sentry('PUT', `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(found)}/`, {
      body: { status: 'resolved' },
    })
  )
  return `Resolved ${issue.shortId}: ${issue.title}`
}

// @ mentions

/** @param {string} level @returns {'danger' | 'warning' | 'info' | 'neutral'} */
function levelTone(level) {
  if (level === 'fatal' || level === 'error') return 'danger'
  if (level === 'warning') return 'warning'
  if (level === 'info') return 'info'
  return 'neutral'
}

/** The status and the level, which the card and the detail view both show. */
/** @param {Issue} issue @returns {import('../../types/index').ViewBadge[]} */
function badgesOf(issue) {
  /** @type {import('../../types/index').ViewBadge[]} */
  const out = []
  if (issue.status) {
    const tone = issue.status === 'resolved' ? 'success' : issue.status === 'unresolved' ? 'warning' : 'neutral'
    out.push({ text: issue.status, tone })
  }
  if (issue.level) out.push({ text: issue.level, tone: levelTone(issue.level) })
  return out
}

kettu.on('mention.search', async ({ query }) => {
  const org = await organization()
  const text = query.trim()
  const issues = await listIssues(org, {
    limit: 10,
    query: text === '' ? 'is:unresolved' : text,
    shortIds: true,
  })
  return {
    items: issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      subtitle: `${issue.shortId} · ${issue.project?.slug ?? ''}`,
      end: issue.level ?? '',
      icon: /** @type {'bug'} */ ('bug'),
      word: issue.shortId,
    })),
  }
})

kettu.on('mention.content', async ({ item }) => {
  const org = await organization()
  const issue = await readIssue(org, await issueId(item, org))
  const text = [...head(issue), '', traceText(await latestEvent(org, issue.id))].join('\n')
  return { title: `${issue.shortId} ${clip(issue.title, 120)}`, text: clip(text, 15_500) }
})

// Links

/** @type {Map<string, { at: number, card: any }>} */
const cards = new Map()

kettu.on('link.card', async ({ url }) => {
  const found = ISSUE_URL.exec(url)
  if (!found) return
  const host = /** @type {string} */ (found[1]).toLowerCase()
  const region = REGION_HOST.exec(host)?.[1]?.toLowerCase() ?? null
  const fromHost = host === 'sentry.io' || region ? null : host.split('.')[0]
  const org = found[2] ?? fromHost ?? (await organization())
  if (!SLUG.test(org)) return
  const key = `${region ?? ''}/${org}/${found[3]}`
  const cached = cards.get(key)
  if (cached && Date.now() - cached.at < CARD_CACHE_MS) return cached.card
  /** @type {Issue} */
  let issue
  try {
    issue = await readIssue(org, await issueId(/** @type {string} */ (found[3]), org, region), region)
  } catch (error) {
    // An organization the token cannot see: the link stays as it was.
    console.warn(`No card for ${url}: ${message(error)}`)
    return
  }
  const note = issue.metadata?.value ?? issue.culprit ?? ''
  const card = {
    label: issue.shortId,
    title: issue.title,
    subtitle: [issue.project?.name ?? issue.project?.slug, issue.culprit].filter(Boolean).join(' · '),
    icon: 'bug',
    badges: badgesOf(issue),
    fields: [
      { label: 'Events', value: String(issue.count ?? '?') },
      { label: 'Users', value: String(issue.userCount ?? '?') },
      { label: 'Last seen', value: day(issue.lastSeen) },
    ],
    ...(note === '' ? {} : { body: clip(note, 400) }),
  }
  cards.set(key, { at: Date.now(), card })
  return card
})

// Views: the unresolved issues, and one issue with its latest stack trace.

/**
 * @param {import('../../types/index').ViewRequest} request
 * @returns {Promise<import('../../types/index').ViewData>}
 */
async function viewData({ view, params }) {
  const token = ((await kettu.call('settings.secret', 'token')) ?? '').trim()
  const slug = String(await kettu.call('settings.get', 'organization')).trim()
  if (view === 'issues') {
    if (token === '' || slug === '') {
      return {
        rows: [],
        empty: {
          title: 'Connect Sentry',
          description: 'Open Settings › Plugins › Sentry and add your organization’s slug and an auth token.',
        },
      }
    }
    const project = String(await kettu.call('settings.get', 'project')).trim()
    const issues = await listIssues(await organization(), { project, limit: 50 })
    return {
      scope: [slug, ...(project === '' ? [] : [project]), 'Unresolved'],
      rows: issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        subtitle: `${issue.shortId} · ${issue.culprit ?? issue.project?.slug ?? ''}`,
        badges: issue.level ? [{ text: issue.level, tone: levelTone(issue.level) }] : [],
        end: `${issue.count ?? '?'} events`,
        actions: [
          {
            id: 'open',
            label: 'Details',
            icon: /** @type {'info'} */ ('info'),
            open: { view: 'issue', params: { id: issue.id } },
          },
        ],
      })),
      empty: { title: 'No unresolved issues', description: 'Nothing unresolved matches.' },
    }
  }
  const org = await organization()
  const issue = await readIssue(org, await issueId(params.id ?? '', org))
  const trace = traceText(await latestEvent(org, issue.id))
  return {
    title: issue.title,
    subtitle: issue.shortId,
    icon: 'bug',
    badges: badgesOf(issue),
    fields: [
      ...(issue.project ? [{ label: 'Project', value: issue.project.slug }] : []),
      { label: 'Events', value: String(issue.count ?? '?') },
      { label: 'Users', value: String(issue.userCount ?? '?') },
      { label: 'First seen', value: day(issue.firstSeen) },
      { label: 'Last seen', value: day(issue.lastSeen) },
      ...(issue.assignedTo ? [{ label: 'Assigned to', value: issue.assignedTo.name ?? issue.assignedTo.email ?? '' }] : []),
      ...(issue.permalink ? [{ label: 'Address', value: issue.permalink, mono: true }] : []),
    ],
    body: `${issue.metadata?.value ? `${clip(issue.metadata.value, 500)}\n\n` : ''}\`\`\`\n${clip(trace, 18_000)}\n\`\`\``,
  }
}

kettu.on('view.data', async (request) => {
  try {
    return await viewData(request)
  } catch (error) {
    // A thrown error shows only as a generic failure, so say what went wrong in the view itself.
    return request.view === 'issues'
      ? { rows: [], empty: { title: 'Sentry could not be read', description: clip(message(error), 280) } }
      : { title: 'This issue could not be shown', body: clip(message(error), 1000) }
  }
})

kettu.on('action.run', async ({ action }) =>
  action === 'show-issues' ? { open: { view: 'issues' } } : { error: `No action ${action}` },
)
