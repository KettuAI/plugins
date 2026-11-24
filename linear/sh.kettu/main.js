// @ts-check

const ENDPOINT = 'https://api.linear.app/graphql'
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/
const ISSUE_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})(?:[/?#]|$)/
const OPEN = '{ state: { type: { nin: ["completed", "canceled", "duplicate"] } } }'
const FIELDS = `id identifier title url priority priorityLabel updatedAt
  state { name type } team { key name } assignee { name displayName }`
const DETAIL = `${FIELDS} description createdAt
  labels { nodes { name } } project { name }
  comments(first: 20) { nodes { body createdAt user { name displayName } } }`
const CARD_CACHE_MS = 60_000

/**
 * @typedef {{ id: string, identifier: string, title: string, url: string, priority: number,
 *   priorityLabel: string, updatedAt: string, state: { name: string, type: string },
 *   team: { key: string, name: string }, assignee: { name: string, displayName: string } | null,
 *   description?: string | null, createdAt?: string, labels?: { nodes: { name: string }[] },
 *   project?: { name: string } | null,
 *   comments?: { nodes: { body: string, createdAt: string, user: { name: string, displayName: string } | null }[] } }} Issue
 */

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error))
/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
/** @param {{ name: string, displayName: string } | null | undefined} user */
const who = (user) => (user ? user.displayName || user.name : null)

/** @param {string} query @param {Record<string, unknown>} [variables] */
async function linear(query, variables = {}) {
  const stored = await kettu.call('settings.secret', 'apiKey')
  const key = (stored ?? '').trim().replace(/^Bearer\s+/i, '')
  if (key === '') throw new Error('Add your Linear API key in the plugin settings')
  const response = await kettu.call('network.fetch', ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A personal API key is sent as it is; only an OAuth token takes the prefix.
      authorization: key.startsWith('lin_oauth_') ? `Bearer ${key}` : key,
    },
    body: JSON.stringify({ query, variables }),
  })
  /** @type {{ data?: any, errors?: { message: string, extensions?: { code?: string } }[] } | null} */
  let body = null
  try {
    body = JSON.parse(response.body)
  } catch {
    // Not a JSON answer.
  }
  const errors = body?.errors ?? []
  const first = errors[0]
  if (response.status === 401 || first?.extensions?.code === 'AUTHENTICATION_ERROR') {
    throw new Error('Linear did not accept the API key')
  }
  if (first?.extensions?.code === 'RATELIMITED' || response.status === 429) {
    throw new Error('Linear’s rate limit is reached; try again in a few minutes')
  }
  if (first) throw new Error(clip(errors.map((e) => e.message).join('; '), 300))
  if (response.status !== 200 || !body?.data) throw new Error(`Linear answered ${response.status}`)
  return body.data
}

/** An issue's identifier from an identifier or an address of an issue; null when it is neither. */
/** @param {string} text */
function identifierOf(text) {
  const trimmed = text.trim()
  if (IDENTIFIER.test(trimmed)) return trimmed.toUpperCase()
  const found = ISSUE_URL.exec(trimmed)
  return found ? /** @type {string} */ (found[1]).toUpperCase() : null
}

/** @param {string} text */
function needIdentifier(text) {
  const id = identifierOf(text)
  if (id === null) throw new Error('Give an issue identifier such as ENG-123, or the address of the issue')
  return id
}

/** @param {string} id @param {string} fields */
async function readIssue(id, fields = DETAIL) {
  const data = await linear(`query($id: String!) { issue(id: $id) { ${fields} } }`, { id })
  return /** @type {Issue} */ (data.issue)
}

/** @param {string} term @param {number} first */
async function search(term, first) {
  const id = identifierOf(term)
  if (id !== null) {
    try {
      return [await readIssue(id, FIELDS)]
    } catch {
      // Not an issue of this workspace; search for the words.
    }
  }
  const data = await linear(
    `query($term: String!, $first: Int) { searchIssues(term: $term, first: $first) { nodes { ${FIELDS} } } }`,
    { term: term.slice(0, 1024), first },
  )
  return /** @type {Issue[]} */ (data.searchIssues.nodes)
}

/** @param {number} first */
async function assigned(first) {
  const data = await linear(
    `query($first: Int) { viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: ${OPEN}) { nodes { ${FIELDS} } } } }`,
    { first },
  )
  return /** @type {Issue[]} */ (data.viewer.assignedIssues.nodes)
}

/** @param {string} iso */
function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 86_400 * 60) return `${Math.floor(seconds / 86_400)}d`
  return `${Math.floor(seconds / (86_400 * 30))}mo`
}

/** @param {string} type @returns {'neutral' | 'info' | 'success'} */
function stateTone(type) {
  if (type === 'completed') return 'success'
  if (type === 'started') return 'info'
  return 'neutral'
}

/** @param {Issue} issue */
function badges(issue) {
  /** @type {{ text: string, tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }[]} */
  const out = [{ text: issue.state.name, tone: stateTone(issue.state.type) }]
  if (issue.priority === 1) out.push({ text: issue.priorityLabel, tone: 'danger' })
  else if (issue.priority === 2) out.push({ text: issue.priorityLabel, tone: 'warning' })
  return out
}

/** @param {Issue} issue */
function head(issue) {
  return [
    `${issue.identifier}: ${issue.title}`,
    `Address: ${issue.url}`,
    `State: ${issue.state.name}`,
    `Priority: ${issue.priorityLabel}`,
    `Team: ${issue.team.name} (${issue.team.key})`,
    `Assignee: ${who(issue.assignee) ?? 'Unassigned'}`,
  ]
}

/** What an agent reads of an issue: its facts, description and the newest comments. */
/** @param {Issue} issue */
function issueText(issue) {
  const lines = head(issue)
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name)
  if (labels.length > 0) lines.push(`Labels: ${labels.join(', ')}`)
  if (issue.project) lines.push(`Project: ${issue.project.name}`)
  lines.push('', 'Description:', issue.description?.trim() || '(none)')
  const comments = [...(issue.comments?.nodes ?? [])].reverse()
  if (comments.length > 0) {
    lines.push('', `Comments (${comments.length}, oldest first):`)
    for (const comment of comments) {
      lines.push(`- ${who(comment.user) ?? 'Someone'}, ${comment.createdAt.slice(0, 10)}:`, comment.body.trim())
    }
  }
  return lines.join('\n')
}

// Tools

exports.search_issues = async (/** @type {{ query: string, limit?: number }} */ { query, limit }) => {
  if (query.trim() === '') throw new Error('Give some words to search for, or an issue identifier')
  const issues = await search(query, Math.min(Math.max(limit ?? 10, 1), 25))
  if (issues.length === 0) return `No Linear issue matches "${clip(query, 100)}".`
  return issues
    .map((i) => `${i.identifier}  [${i.state.name}] ${i.title}  (${i.team.key}, ${who(i.assignee) ?? 'unassigned'})`)
    .join('\n')
}

exports.read_issue = async (/** @type {{ id: string }} */ { id }) =>
  issueText(await readIssue(needIdentifier(id)))

/** @param {string} id */
async function issueUuid(id) {
  return /** @type {string} */ ((await readIssue(needIdentifier(id), 'id')).id)
}

exports.create_issue = async (
  /** @type {{ title: string, description?: string, team?: string, priority?: number }} */ {
    title,
    description,
    team,
    priority,
  },
) => {
  if (title.trim() === '') throw new Error('The issue needs a title')
  const key = (team ?? String(await kettu.call('settings.get', 'defaultTeam'))).trim()
  const teams = await linear(
    'query($key: String!) { teams(filter: { key: { eqIgnoreCase: $key } }, first: 1) { nodes { id key name } } }',
    { key },
  )
  const found = teams.teams.nodes[0]
  if (!found) {
    const all = await linear('query { teams(first: 25) { nodes { key name } } }')
    const names = all.teams.nodes.map((/** @type {{ key: string }} */ t) => t.key).join(', ')
    throw new Error(
      key === ''
        ? `Give the key of the team to create it in, or set a default team in the plugin settings. Teams: ${names}`
        : `No team has the key "${clip(key, 20)}". Teams: ${names}`,
    )
  }
  /** @type {Record<string, unknown>} */
  const input = { teamId: found.id, title: title.trim() }
  if (description?.trim()) input.description = description
  if (priority !== undefined) input.priority = priority
  const data = await linear(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${FIELDS} } } }`,
    { input },
  )
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('Linear did not create the issue')
  const issue = /** @type {Issue} */ (data.issueCreate.issue)
  return `Created ${issue.identifier}: ${issue.title}\n${issue.url}`
}

exports.add_comment = async (/** @type {{ id: string, body: string }} */ { id, body }) => {
  if (body.trim() === '') throw new Error('The comment needs some text')
  const identifier = needIdentifier(id)
  const data = await linear(
    'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }',
    { input: { issueId: await issueUuid(identifier), body } },
  )
  if (!data.commentCreate.success) throw new Error('Linear did not add the comment')
  return `Commented on ${identifier}\n${data.commentCreate.comment.url}`
}

// @ mentions

kettu.on('mention.search', async ({ query }) => {
  const text = query.trim()
  const issues = text === '' ? await assigned(10) : await search(text, 10)
  return {
    items: issues.map((issue) => ({
      id: issue.identifier,
      title: issue.title,
      subtitle: `${issue.identifier} · ${issue.team.key}`,
      end: issue.state.name,
      icon: /** @type {'tag'} */ ('tag'),
      word: issue.identifier,
    })),
  }
})

kettu.on('mention.content', async ({ item }) => {
  const issue = await readIssue(needIdentifier(item), `${FIELDS} description`)
  const lines = head(issue)
  lines.push('', 'Description:', clip(issue.description?.trim() || '(none)', 14_000))
  return { title: `${issue.identifier} ${clip(issue.title, 120)}`, text: lines.join('\n') }
})

// Links

/** @type {Map<string, { at: number, card: any }>} */
const cards = new Map()

kettu.on('link.card', async ({ match, url }) => {
  const id = identifierOf(match.identifier ?? '') ?? identifierOf(url)
  if (id === null) return
  const cached = cards.get(id)
  if (cached && Date.now() - cached.at < CARD_CACHE_MS) return cached.card
  /** @type {Issue} */
  let issue
  try {
    issue = await readIssue(id, `${FIELDS} description`)
  } catch (error) {
    // An issue of another workspace, or one the key cannot see: the link stays as it was.
    console.warn(`No card for ${id}: ${message(error)}`)
    return
  }
  const body = (issue.description ?? '').replace(/\s+/g, ' ').trim()
  const card = {
    label: issue.identifier,
    title: issue.title,
    subtitle: `${issue.team.name} · ${who(issue.assignee) ?? 'Unassigned'}`,
    icon: 'tag',
    badges: badges(issue),
    fields: [
      { label: 'Priority', value: issue.priorityLabel },
      { label: 'Updated', value: `${ago(issue.updatedAt)} ago` },
    ],
    ...(body === '' ? {} : { body: clip(body, 400) }),
  }
  cards.set(id, { at: Date.now(), card })
  return card
})

// Views: the issues assigned to you, and one issue.

/**
 * @param {import('../../types/index').ViewRequest} request
 * @returns {Promise<import('../../types/index').ViewData>}
 */
async function viewData({ view, params }) {
  if (view === 'assigned') {
    const stored = await kettu.call('settings.secret', 'apiKey')
    if (!stored || stored.trim() === '') {
      return {
        rows: [],
        empty: {
          title: 'Add your Linear API key',
          description: 'Open Settings › Plugins › Linear and paste a personal API key.',
        },
      }
    }
    const issues = await assigned(50)
    return {
      scope: ['Assigned to you', 'Open'],
      rows: issues.map((issue) => ({
        id: issue.identifier,
        title: issue.title,
        subtitle: `${issue.identifier} · ${issue.team.name}`,
        badges: badges(issue),
        end: ago(issue.updatedAt),
        actions: [
          {
            id: 'open',
            label: 'Details',
            icon: /** @type {'info'} */ ('info'),
            open: { view: 'issue', params: { id: issue.identifier } },
          },
        ],
      })),
      empty: { title: 'Nothing is assigned to you', description: 'Open issues assigned to you show here.' },
    }
  }
  const issue = await readIssue(needIdentifier(params.id ?? ''))
  const comments = [...(issue.comments?.nodes ?? [])].reverse()
  const body = [
    issue.description?.trim() || '_No description._',
    ...(comments.length > 0
      ? [
          '',
          `### Comments (${comments.length})`,
          ...comments.map((c) => `**${who(c.user) ?? 'Someone'}** · ${c.createdAt.slice(0, 10)}\n\n${c.body.trim()}`),
        ]
      : []),
  ].join('\n\n')
  return {
    title: issue.title,
    subtitle: issue.identifier,
    icon: 'tag',
    badges: badges(issue),
    fields: [
      { label: 'Team', value: `${issue.team.name} (${issue.team.key})` },
      { label: 'Assignee', value: who(issue.assignee) ?? 'Unassigned' },
      { label: 'Priority', value: issue.priorityLabel },
      ...(issue.project ? [{ label: 'Project', value: issue.project.name }] : []),
      ...((issue.labels?.nodes.length ?? 0) > 0
        ? [{ label: 'Labels', value: (issue.labels?.nodes ?? []).map((l) => l.name).join(', ') }]
        : []),
      { label: 'Updated', value: `${ago(issue.updatedAt)} ago` },
      { label: 'Address', value: issue.url, mono: true },
    ],
    body: clip(body, 19_000),
  }
}

kettu.on('view.data', async (request) => {
  try {
    return await viewData(request)
  } catch (error) {
    // A thrown error shows only as a generic failure, so say what went wrong in the view itself.
    return request.view === 'assigned'
      ? { rows: [], empty: { title: 'Linear could not be read', description: clip(message(error), 280) } }
      : { title: 'This issue could not be shown', body: clip(message(error), 1000) }
  }
})

kettu.on('action.run', async ({ action }) =>
  action === 'show-assigned' ? { open: { view: 'assigned' } } : { error: `No action ${action}` },
)
