import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'
import { matchLink } from '../test-support/links.mjs'

// Shaped by Linear's public GraphQL schema, whose queries were also validated against it.
const issue = (over = {}) => ({
  id: '8c1f0d7e-0000-4000-8000-000000000001',
  identifier: 'ENG-123',
  title: 'Login fails on Safari',
  url: 'https://linear.app/acme/issue/ENG-123/login-fails-on-safari',
  priority: 2,
  priorityLabel: 'High',
  updatedAt: '2026-11-22T12:00:00.000Z',
  createdAt: '2026-11-01T09:00:00.000Z',
  state: { name: 'In Progress', type: 'started' },
  team: { key: 'ENG', name: 'Engineering' },
  assignee: { name: 'Ada Lovelace', displayName: 'ada' },
  description: 'Users on Safari 18 see a blank page after the redirect.',
  labels: { nodes: [{ name: 'bug' }, { name: 'auth' }] },
  project: { name: 'Web' },
  comments: {
    nodes: [
      { body: 'Newest comment', createdAt: '2026-11-22T10:00:00.000Z', user: { name: 'Bob', displayName: 'bob' } },
      { body: 'First comment', createdAt: '2026-11-20T10:00:00.000Z', user: null },
    ],
  },
  ...over,
})

function fakeLinear(over = {}) {
  const log = []
  const handler = ({ body }) => {
    log.push(body)
    const q = body.query
    const answer = (data) => ({ status: 200, body: { data } })
    if (over.respond) {
      const reply = over.respond(body)
      if (reply) return reply
    }
    if (q.includes('teams(filter')) {
      const known = body.variables.key.toLowerCase() === 'eng'
      return answer({ teams: { nodes: known ? [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] : [] } })
    }
    if (q.includes('teams(first')) return answer({ teams: { nodes: [{ key: 'ENG', name: 'Engineering' }, { key: 'WEB', name: 'Web' }] } })
    if (q.includes('viewer')) return answer({ viewer: { assignedIssues: { nodes: [issue(), issue({ identifier: 'ENG-9', title: 'Other' })] } } })
    if (q.includes('searchIssues')) return answer({ searchIssues: { nodes: [issue()] } })
    if (q.includes('issueCreate')) return answer({ issueCreate: { success: true, issue: issue({ identifier: 'ENG-200', title: body.variables.input.title }) } })
    if (q.includes('commentCreate')) return answer({ commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/acme/issue/ENG-123#comment-c1' } } })
    if (q.includes('issue(id')) {
      return body.variables.id === 'ENG-404'
        ? { status: 200, body: { errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT' } }] } }
        : answer({ issue: issue() })
    }
    return { status: 400, body: { errors: [{ message: 'unexpected query' }] } }
  }
  return { log, handler }
}

function setup(over = {}, keys = { apiKey: 'lin_api_secret' }, settings = {}) {
  const server = fakeLinear(over)
  const plugin = loadPlugin('linear', { secrets: keys, settings, fetch: server.handler })
  return { plugin, server }
}

test('a personal key is sent as it is and an OAuth token as a bearer token', async () => {
  const personal = setup()
  await personal.plugin.tool('read_issue', { id: 'ENG-123' })
  assert.equal(personal.plugin.requests[0].url, 'https://api.linear.app/graphql')
  assert.equal(personal.plugin.requests[0].headers.authorization, 'lin_api_secret')
  const oauth = setup({}, { apiKey: 'lin_oauth_token' })
  await oauth.plugin.tool('read_issue', { id: 'ENG-123' })
  assert.equal(oauth.plugin.requests[0].headers.authorization, 'Bearer lin_oauth_token')
})

test('without a key every use says where to put it', async () => {
  const { plugin } = setup({}, {})
  await assert.rejects(plugin.tool('read_issue', { id: 'ENG-1' }), /Add your Linear API key/)
  assert.equal(plugin.requests.length, 0)
})

test('errors from Linear are told plainly and never carry the key', async () => {
  const bad = setup({ respond: () => ({ status: 401, body: { errors: [{ message: 'x', extensions: { code: 'AUTHENTICATION_ERROR' } }] } }) })
  await assert.rejects(bad.plugin.tool('read_issue', { id: 'ENG-1' }), /did not accept the API key/)
  const limited = setup({ respond: () => ({ status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } }) })
  await assert.rejects(limited.plugin.tool('read_issue', { id: 'ENG-1' }), /rate limit is reached/)
  const other = setup({ respond: () => ({ status: 200, body: { errors: [{ message: 'Argument Validation Error' }] } }) })
  await assert.rejects(other.plugin.tool('read_issue', { id: 'ENG-1' }), /Argument Validation Error/)
  for (const { plugin } of [bad, limited, other]) assert.ok(!JSON.stringify(plugin.logs).includes('lin_api_secret'))
})

test('search_issues searches words, or looks an identifier up', async () => {
  const { plugin, server } = setup()
  const text = await plugin.tool('search_issues', { query: 'login safari', limit: 5 })
  assert.equal(text, 'ENG-123  [In Progress] Login fails on Safari  (ENG, ada)')
  assert.deepEqual(server.log[0].variables, { term: 'login safari', first: 5 })
  await plugin.tool('search_issues', { query: 'eng-123' })
  assert.deepEqual(server.log[1].variables, { id: 'ENG-123' })
  const missing = await plugin.tool('search_issues', { query: 'ENG-404' })
  assert.match(server.log.at(-1).query, /searchIssues/)
  assert.match(missing, /^ENG-123/)
})

test('read_issue gives the facts, the description and the comments oldest first', async () => {
  const { plugin } = setup()
  const text = await plugin.tool('read_issue', { id: 'https://linear.app/acme/issue/ENG-123/login-fails-on-safari' })
  assert.match(text, /^ENG-123: Login fails on Safari\nAddress: https:\/\/linear\.app\/acme\/issue\/ENG-123\//)
  assert.match(text, /State: In Progress\nPriority: High\nTeam: Engineering \(ENG\)\nAssignee: ada/)
  assert.match(text, /Labels: bug, auth\nProject: Web/)
  assert.match(text, /Description:\nUsers on Safari 18/)
  assert.ok(text.indexOf('First comment') < text.indexOf('Newest comment'))
  assert.match(text, /- Someone, 2026-11-20:/)
  await assert.rejects(plugin.tool('read_issue', { id: 'not an issue' }), /such as ENG-123/)
})

test('create_issue finds the team by its key and sends the input', async () => {
  const { plugin, server } = setup({}, { apiKey: 'k' }, { defaultTeam: 'eng' })
  const text = await plugin.tool('create_issue', { title: ' Fix it ', description: 'Details', priority: 1 })
  assert.deepEqual(server.log[0].variables, { key: 'eng' })
  assert.deepEqual(server.log[1].variables.input, { teamId: 'team-1', title: 'Fix it', description: 'Details', priority: 1 })
  assert.equal(text, 'Created ENG-200: Fix it\nhttps://linear.app/acme/issue/ENG-123/login-fails-on-safari')
  await plugin.tool('create_issue', { title: 'Plain', team: 'ENG' })
  assert.deepEqual(server.log.at(-1).variables.input, { teamId: 'team-1', title: 'Plain' })
})

test('create_issue says which teams exist when none is named or known', async () => {
  const { plugin, server } = setup()
  await assert.rejects(plugin.tool('create_issue', { title: 'x' }), /set a default team.*Teams: ENG, WEB/)
  await assert.rejects(plugin.tool('create_issue', { title: 'x', team: 'NOPE' }), /No team has the key "NOPE". Teams: ENG, WEB/)
  assert.ok(!server.log.some((q) => q.query.includes('issueCreate')))
})

test('add_comment resolves the issue first, then comments', async () => {
  const { plugin, server } = setup()
  const text = await plugin.tool('add_comment', { id: 'ENG-123', body: 'On it' })
  assert.deepEqual(server.log[0].variables, { id: 'ENG-123' })
  assert.deepEqual(server.log[1].variables, { input: { issueId: '8c1f0d7e-0000-4000-8000-000000000001', body: 'On it' } })
  assert.equal(text, 'Commented on ENG-123\nhttps://linear.app/acme/issue/ENG-123#comment-c1')
  await assert.rejects(plugin.tool('add_comment', { id: 'ENG-123', body: '  ' }), /needs some text/)
})

test('the @ source lists your issues, or searches', async () => {
  const { plugin, server } = setup()
  const empty = await plugin.hook('mention.search', { source: 'issues', query: '', locale: 'en' })
  assert.match(server.log[0].query, /assignedIssues/)
  assert.deepEqual(empty.items[0], {
    id: 'ENG-123',
    title: 'Login fails on Safari',
    subtitle: 'ENG-123 · ENG',
    end: 'In Progress',
    icon: 'tag',
    word: 'ENG-123',
  })
  const found = await plugin.hook('mention.search', { source: 'issues', query: 'safari', locale: 'en' })
  assert.match(server.log[1].query, /searchIssues/)
  assert.equal(found.items.length, 1)
})

test('a mentioned issue adds its title, state and description', async () => {
  const { plugin } = setup()
  const content = await plugin.hook('mention.content', { source: 'issues', item: 'ENG-123', locale: 'en' })
  assert.equal(content.title, 'ENG-123 Login fails on Safari')
  assert.match(content.text, /^ENG-123: Login fails on Safari\n/)
  assert.match(content.text, /State: In Progress/)
  assert.match(content.text, /Description:\nUsers on Safari 18 see a blank page/)
  const long = setup({ respond: () => ({ status: 200, body: { data: { issue: issue({ description: 'x'.repeat(30_000) }) } } }) })
  const big = await long.plugin.hook('mention.content', { source: 'issues', item: 'ENG-123', locale: 'en' })
  assert.ok(big.text.length <= 16_000)
})

test('links to an issue are recognised and drawn with their state', async () => {
  const { plugin, server } = setup()
  const { links } = plugin.entry
  for (const address of [
    'https://linear.app/acme/issue/ENG-123',
    'https://linear.app/acme/issue/ENG-123/',
    'https://linear.app/acme/issue/ENG-123/login-fails-on-safari',
    'https://linear.app/acme/issue/ENG-123/login-fails-on-safari#comment-1',
  ]) {
    assert.deepEqual(matchLink(links, address), { link: 'issue', match: { identifier: 'ENG-123' } }, address)
  }
  for (const address of [
    'https://linear.app/acme/project/web',
    'https://linear.app/acme/issues',
    'https://linear.app/issue/ENG-123',
    'http://linear.app/acme/issue/ENG-123',
    'https://evil.example.com/acme/issue/ENG-123',
    'https://notlinear.app/acme/issue/ENG-123',
  ]) {
    assert.equal(matchLink(links, address), null, address)
  }
  const card = await plugin.hook('link.card', { link: 'issue', url: 'https://linear.app/acme/issue/ENG-123/x', match: { identifier: 'ENG-123' }, locale: 'en' })
  assert.equal(card.label, 'ENG-123')
  assert.equal(card.title, 'Login fails on Safari')
  assert.deepEqual(card.badges, [{ text: 'In Progress', tone: 'info' }, { text: 'High', tone: 'warning' }])
  assert.equal(card.subtitle, 'Engineering · ada')
  assert.ok(card.badges.length <= 3 && card.fields.length <= 4 && card.body.length <= 400)
  await plugin.hook('link.card', { link: 'issue', url: 'https://linear.app/acme/issue/ENG-123/x', match: { identifier: 'ENG-123' }, locale: 'en' })
  assert.equal(server.log.length, 1, 'a second card for the same issue comes from memory')
  await plugin.advance(61_000)
  await plugin.hook('link.card', { link: 'issue', url: 'https://linear.app/acme/issue/ENG-123', match: { identifier: 'ENG-123' }, locale: 'en' })
  assert.equal(server.log.length, 2)
})

test('state colors follow the state’s type', async () => {
  const states = [['completed', 'success'], ['canceled', 'neutral'], ['backlog', 'neutral'], ['started', 'info']]
  for (const [type, tone] of states) {
    const { plugin } = setup({ respond: () => ({ status: 200, body: { data: { issue: issue({ priority: 0, priorityLabel: 'No priority', state: { name: 'S', type } }) } } }) })
    const card = await plugin.hook('link.card', { link: 'issue', url: 'https://linear.app/a/issue/ENG-5', match: { identifier: 'ENG-5' }, locale: 'en' })
    assert.deepEqual(card.badges, [{ text: 'S', tone }])
  }
})

test('an issue that cannot be read leaves the link as it was', async () => {
  const { plugin } = setup()
  const card = await plugin.hook('link.card', { link: 'issue', url: 'https://linear.app/other/issue/ENG-404', match: { identifier: 'ENG-404' }, locale: 'en' })
  assert.equal(card, undefined)
  assert.match(plugin.logs.at(-1).text, /No card for ENG-404: Entity not found/)
})

test('the list shows your open issues and opens one', async () => {
  const { plugin, server } = setup()
  const list = await plugin.hook('view.data', { view: 'assigned', params: {}, locale: 'en' })
  assert.match(server.log[0].query, /nin: \["completed", "canceled", "duplicate"\]/)
  assert.equal(list.rows.length, 2)
  assert.deepEqual(list.rows[0].actions[0].open, { view: 'issue', params: { id: 'ENG-123' } })
  assert.equal(list.rows[0].badges[0].text, 'In Progress')
  assert.ok(new Set(list.rows.map((r) => r.id)).size === list.rows.length)
  const opened = await plugin.hook('action.run', { action: 'show-assigned', locale: 'en' })
  assert.deepEqual(opened, { open: { view: 'assigned' } })
})

test('the list without a key explains what to do instead of failing', async () => {
  const { plugin } = setup({}, {})
  const list = await plugin.hook('view.data', { view: 'assigned', params: {}, locale: 'en' })
  assert.deepEqual(list.rows, [])
  assert.match(list.empty.title, /Add your Linear API key/)
  assert.equal(plugin.requests.length, 0)
})

test('a view that cannot load says why in the view instead of failing', async () => {
  const unauthorized = () => ({ status: 401, body: { errors: [{ message: 'Authentication required' }] } })
  const { plugin } = setup({ respond: unauthorized })
  const list = await plugin.hook('view.data', { view: 'assigned', params: {}, locale: 'en' })
  assert.deepEqual(list.rows, [])
  assert.equal(list.empty.title, 'Linear could not be read')
  assert.match(list.empty.description, /did not accept the API key/)
  const detail = await plugin.hook('view.data', { view: 'issue', params: { id: 'ENG-123' }, locale: 'en' })
  assert.equal(detail.title, 'This issue could not be shown')
  assert.match(detail.body, /did not accept the API key/)
  const bad = await plugin.hook('view.data', { view: 'issue', params: { id: 'not an issue' }, locale: 'en' })
  assert.equal(bad.title, 'This issue could not be shown')
})

test('the detail view has fields, the description and the comments', async () => {
  const { plugin } = setup()
  const detail = await plugin.hook('view.data', { view: 'issue', params: { id: 'ENG-123' }, locale: 'en' })
  assert.equal(detail.title, 'Login fails on Safari')
  assert.equal(detail.subtitle, 'ENG-123')
  assert.deepEqual(detail.fields.map((f) => f.label), ['Team', 'Assignee', 'Priority', 'Project', 'Labels', 'Updated', 'Address'])
  assert.match(detail.body, /^Users on Safari 18/)
  assert.ok(detail.body.indexOf('First comment') < detail.body.indexOf('Newest comment'))
  assert.ok(detail.body.length <= 20_000)
})

test('the plugin asks only for Linear’s two hosts, tools and the @ menu', () => {
  const { entry } = setup().plugin
  assert.deepEqual(entry.permissions, ['network:api.linear.app', 'network:linear.app', 'tools', 'prompt.attach'])
})
