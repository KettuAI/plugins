import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'
import { matchLink } from '../test-support/links.mjs'

// Answers recorded in Sentry's published API reference.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const ISSUES = fixture('sentry-issues')
const ISSUE = fixture('sentry-issue')
const EVENT = fixture('sentry-event')

function fakeSentry(over = {}) {
  return (sent) => {
    if (over.respond) {
      const reply = over.respond(sent)
      if (reply) return reply
    }
    const url = new URL(sent.url)
    const path = url.pathname
    if (sent.method === 'GET' && path === '/api/0/organizations/acme/issues/') return { status: 200, body: ISSUES }
    if (sent.method === 'GET' && /^\/api\/0\/organizations\/acme\/issues\/\d+\/events\/latest\/$/.test(path)) return { status: 200, body: EVENT }
    if (sent.method === 'GET' && /^\/api\/0\/organizations\/acme\/issues\/\d+\/$/.test(path)) return { status: 200, body: ISSUE }
    if (sent.method === 'PUT' && /^\/api\/0\/organizations\/acme\/issues\/\d+\/$/.test(path)) return { status: 200, body: { ...ISSUE, status: sent.body.status } }
    return { status: 404, body: { detail: 'The requested resource does not exist' } }
  }
}

function setup(over = {}, settings = {}, secrets = { token: 'sntrys_secret' }) {
  return loadPlugin('sentry', {
    settings: { organization: 'acme', ...settings },
    secrets,
    fetch: fakeSentry(over),
  })
}

const queryOf = (sent) => Object.fromEntries(new URL(sent.url).searchParams.entries())

test('requests go to the region’s host with the token as a bearer token', async () => {
  const us = setup()
  await us.tool('list_issues', {})
  assert.equal(new URL(us.requests[0].url).host, 'us.sentry.io')
  assert.equal(us.requests[0].headers.authorization, 'Bearer sntrys_secret')
  const eu = setup({}, { region: 'de' })
  await eu.tool('list_issues', {})
  assert.equal(new URL(eu.requests[0].url).host, 'de.sentry.io')
})

test('list_issues asks for unresolved issues of a project', async () => {
  const plugin = setup({}, { project: 'pump-station' })
  const text = await plugin.tool('list_issues', { limit: 5 })
  assert.deepEqual(queryOf(plugin.requests[0]), {
    query: 'is:unresolved',
    project: 'pump-station',
    sort: 'date',
    limit: '5',
    collapse: 'stats',
  })
  assert.equal(
    text,
    'PUMP-STATION-1  [error] This is an example Python exception  (150 events, last seen 2018-12-06, id 1)',
  )
  await plugin.tool('list_issues', { project: 'other', query: 'is:unresolved level:error' })
  assert.deepEqual(
    [queryOf(plugin.requests[1]).project, queryOf(plugin.requests[1]).query],
    ['other', 'is:unresolved level:error'],
  )
})

test('read_issue gives the facts and the latest stack trace, oldest call first', async () => {
  const plugin = setup()
  const text = await plugin.tool('read_issue', { id: '1' })
  assert.deepEqual(plugin.requests.map((r) => new URL(r.url).pathname), [
    '/api/0/organizations/acme/issues/1/',
    '/api/0/organizations/acme/issues/1/events/latest/',
  ])
  assert.match(text, /^PUMP-STATION-1: This is an example Python exception\nAddress: https:\/\/sentry\.io\/the-interstellar-jurisdiction\/pump-station\/issues\/1\//)
  assert.match(text, /Project: pump-station\nLevel: error {3}Status: unresolved\nEvents: 150 {3}Users: 12\nFirst seen: 2018-11-06 {3}Last seen: 2018-12-06/)
  assert.match(text, /Assigned to: John Doe/)
  assert.match(text, /environment: prod/)
  assert.match(text, /\nForbiddenError: GET \/organizations\/hellboy-meowmeow\/users\/ 403\n {2}most recent call last:\n/)
  assert.match(text, / {2}at ignoreOnError \(\/usr\/src\/getsentry\/src\/sentry\/node_modules\/@sentry\/browser\/esm\/helpers\.js:71:23\)\n {2}at apply \(/)
})

test('only the frames of the application show their source line', async () => {
  const frames = [
    { filename: 'lib.js', function: 'dep', lineNo: 5, colNo: 1, inApp: false, context: [[5, 'library();']] },
    { filename: 'app.js', function: 'main', lineNo: 9, colNo: 3, inApp: true, context: [[8, 'a'], [9, '  boom();']] },
  ]
  const plugin = setup({
    respond: (sent) =>
      sent.url.includes('/events/latest/')
        ? { status: 200, body: { title: 'T', entries: [{ type: 'exception', data: { values: [{ type: 'Error', value: 'boom', stacktrace: { frames } }] } }] } }
        : undefined,
  })
  const text = await plugin.tool('read_issue', { id: '1' })
  assert.match(text, /Error: boom\n {2}most recent call last:\n {2}at dep \(lib\.js:5:1\)\n {2}at main \(app\.js:9:3\) \[app\]\n {6}9 \| boom\(\);/)
  assert.ok(!text.includes('library();'))
})

test('a long trace keeps the last frames and says how many it left out', async () => {
  const frames = Array.from({ length: 60 }, (_, n) => ({ filename: `f${n}.js`, function: `fn${n}`, lineNo: n + 1, inApp: false }))
  const plugin = setup({
    respond: (sent) =>
      sent.url.includes('/events/latest/')
        ? { status: 200, body: { title: 'T', entries: [{ type: 'exception', data: { values: [{ type: 'E', value: 'v', stacktrace: { frames } }] } }] } }
        : undefined,
  })
  const text = await plugin.tool('read_issue', { id: '1' })
  assert.match(text, /\(40 earlier frames left out\)/)
  assert.ok(text.includes('fn59') && text.includes('fn40') && !text.includes('fn39 '))
})

test('an issue is found by short id or by its address', async () => {
  const plugin = setup()
  await plugin.tool('read_issue', { id: 'pump-station-1' })
  assert.deepEqual(queryOf(plugin.requests[0]), { query: 'pump-station-1', shortIdLookup: '1', limit: '5', collapse: 'stats' })
  assert.equal(new URL(plugin.requests[1].url).pathname, '/api/0/organizations/acme/issues/1/')
  const byAddress = setup()
  await byAddress.tool('read_issue', { id: 'https://acme.sentry.io/issues/1/?project=2' })
  assert.equal(new URL(byAddress.requests[0].url).pathname, '/api/0/organizations/acme/issues/1/')
  await assert.rejects(setup().tool('read_issue', { id: 'NOPE-9' }), /No issue has the short id NOPE-9/)
  await assert.rejects(setup().tool('read_issue', { id: '../../x' }), /Give an issue’s id/)
})

test('resolve_issue sets the status to resolved', async () => {
  const plugin = setup()
  const text = await plugin.tool('resolve_issue', { id: '1' })
  assert.equal(plugin.requests[0].method, 'PUT')
  assert.deepEqual(plugin.requests[0].body, { status: 'resolved' })
  assert.equal(text, 'Resolved PUMP-STATION-1: This is an example Python exception')
})

test('errors say what to do and never carry the token', async () => {
  const cases = [
    [401, {}, /did not accept the auth token/],
    [403, { detail: 'You do not have permission' }, /scopes event:read, project:read and, to resolve, event:write/],
    [404, {}, /no such organization, project or issue/],
    [500, { detail: 'oops' }, /Sentry answered 500: oops/],
  ]
  for (const [status, body, words] of cases) {
    const plugin = setup({ respond: () => ({ status, body }) })
    await assert.rejects(plugin.tool('list_issues', {}), words)
    assert.ok(!JSON.stringify(plugin.logs).includes('sntrys_secret'))
  }
  const limited = setup({ respond: () => ({ status: 429, headers: { 'retry-after': '12' }, body: {} }) })
  await assert.rejects(limited.tool('list_issues', {}), /try again in 12 s/)
  await assert.rejects(setup({}, { organization: '' }).tool('list_issues', {}), /Set your organization/)
  await assert.rejects(setup({}, {}, {}).tool('list_issues', {}), /Add your Sentry auth token/)
  await assert.rejects(setup({}, { organization: '../evil' }).tool('list_issues', {}), /may hold only letters/)
})

test('the @ source lists unresolved issues, or searches with short ids allowed', async () => {
  const plugin = setup()
  const empty = await plugin.hook('mention.search', { source: 'issues', query: '', locale: 'en' })
  assert.equal(queryOf(plugin.requests[0]).query, 'is:unresolved')
  assert.deepEqual(empty.items[0], {
    id: '1',
    title: 'This is an example Python exception',
    subtitle: 'PUMP-STATION-1 · pump-station',
    end: 'error',
    icon: 'bug',
    word: 'PUMP-STATION-1',
  })
  await plugin.hook('mention.search', { source: 'issues', query: 'TypeError', locale: 'en' })
  assert.deepEqual([queryOf(plugin.requests[1]).query, queryOf(plugin.requests[1]).shortIdLookup], ['TypeError', '1'])
})

test('a mentioned issue adds its facts and trace within the limit', async () => {
  const plugin = setup()
  const content = await plugin.hook('mention.content', { source: 'issues', item: '1', locale: 'en' })
  assert.equal(content.title, 'PUMP-STATION-1 This is an example Python exception')
  assert.match(content.text, /Culprit: raven\.scripts\.runner in main/)
  assert.match(content.text, /most recent call last/)
  assert.ok(content.text.length <= 16_000)
})

test('links to an issue are recognised on every address form', () => {
  const { links } = setup().entry
  for (const address of [
    'https://sentry.io/organizations/acme/issues/12345/',
    'https://sentry.io/organizations/acme/issues/12345/events/latest/?project=2',
    'https://us.sentry.io/organizations/acme/issues/12345/',
    'https://de.sentry.io/organizations/acme/issues/12345',
    'https://acme.sentry.io/issues/12345/',
    'https://acme.sentry.io/issues/PUMP-STATION-1/events/abc/',
  ]) {
    assert.equal(matchLink(links, address)?.link, 'issue', address)
  }
  assert.deepEqual(matchLink(links, 'https://sentry.io/organizations/acme/issues/12345/').match, { org: 'acme', issueId: '12345' })
  assert.deepEqual(matchLink(links, 'https://acme.sentry.io/issues/12345/').match, { issueId: '12345' })
  for (const address of [
    'https://acme.sentry.io/issues/',
    'https://acme.sentry.io/projects/web/',
    'https://sentry.io/organizations/acme/issues/',
    'http://acme.sentry.io/issues/12345/',
    'https://acme.notsentry.io/issues/12345/',
    'https://sentry.io.evil.com/organizations/acme/issues/1/',
    'https://evil.com/organizations/acme/issues/1/',
  ]) {
    assert.equal(matchLink(links, address), null, address)
  }
})

test('a link’s card is read from the region’s host, never from the link’s own', async () => {
  const plugin = setup({}, { organization: 'mine' })
  const card = await plugin.hook('link.card', { link: 'issue', url: 'https://acme.sentry.io/issues/1/', match: { issueId: '1' }, locale: 'en' })
  assert.equal(new URL(plugin.requests[0].url).hostname, 'us.sentry.io')
  assert.equal(new URL(plugin.requests[0].url).pathname, '/api/0/organizations/acme/issues/1/')
  assert.equal(card.label, 'PUMP-STATION-1')
  assert.equal(card.title, 'This is an example Python exception')
  assert.deepEqual(card.badges, [{ text: 'unresolved', tone: 'warning' }, { text: 'error', tone: 'danger' }])
  assert.deepEqual(card.fields.map((f) => f.value), ['150', '12', '2018-12-06'])
  assert.ok(card.badges.length <= 3 && card.fields.length <= 4)
  const eu = setup()
  await eu.hook('link.card', { link: 'issue', url: 'https://de.sentry.io/organizations/acme/issues/1/', match: { org: 'acme', issueId: '1' }, locale: 'en' })
  assert.equal(new URL(eu.requests[0].url).hostname, 'de.sentry.io')
  const old = setup()
  await old.hook('link.card', { link: 'issue', url: 'https://sentry.io/organizations/acme/issues/1/', match: { org: 'acme', issueId: '1' }, locale: 'en' })
  assert.equal(new URL(old.requests[0].url).hostname, 'us.sentry.io')
})

test('a link card is kept for a minute, and an unreadable issue leaves the link alone', async () => {
  const plugin = setup()
  const ask = () => plugin.hook('link.card', { link: 'issue', url: 'https://acme.sentry.io/issues/1/', match: { issueId: '1' }, locale: 'en' })
  await ask()
  await ask()
  assert.equal(plugin.requests.length, 1)
  await plugin.advance(61_000)
  await ask()
  assert.equal(plugin.requests.length, 2)
  const lost = setup()
  const card = await lost.hook('link.card', { link: 'issue', url: 'https://other.sentry.io/issues/9/', match: { issueId: '9' }, locale: 'en' })
  assert.equal(card, undefined)
  assert.match(lost.logs.at(-1).text, /No card for https:\/\/other\.sentry\.io/)
})

test('the list view shows unresolved issues and opens one', async () => {
  const plugin = setup()
  const list = await plugin.hook('view.data', { view: 'issues', params: {}, locale: 'en' })
  assert.deepEqual(list.scope, ['acme', 'Unresolved'])
  assert.equal(list.rows[0].id, '1')
  assert.equal(list.rows[0].end, '150 events')
  assert.deepEqual(list.rows[0].actions[0].open, { view: 'issue', params: { id: '1' } })
  assert.deepEqual(await plugin.hook('action.run', { action: 'show-issues', locale: 'en' }), { open: { view: 'issues' } })
})

test('the list view without a token or an organization explains what to do', async () => {
  for (const plugin of [setup({}, {}, {}), setup({}, { organization: '' })]) {
    const list = await plugin.hook('view.data', { view: 'issues', params: {}, locale: 'en' })
    assert.deepEqual(list.rows, [])
    assert.equal(list.empty.title, 'Connect Sentry')
    assert.equal(plugin.requests.length, 0)
  }
})

test('the detail view shows the facts and the stack trace in a code block', async () => {
  const plugin = setup()
  const detail = await plugin.hook('view.data', { view: 'issue', params: { id: '1' }, locale: 'en' })
  assert.equal(detail.title, 'This is an example Python exception')
  assert.equal(detail.subtitle, 'PUMP-STATION-1')
  assert.deepEqual(detail.fields.map((f) => f.label), ['Project', 'Events', 'Users', 'First seen', 'Last seen', 'Assigned to', 'Address'])
  assert.match(detail.body, /```\nLatest event/)
  assert.ok(detail.body.endsWith('\n```') && detail.body.length <= 20_000)
})

test('a view that cannot load says why in the view instead of failing', async () => {
  const refused = { respond: () => ({ status: 401, body: { detail: 'Invalid token' } }) }
  const list = await setup(refused).hook('view.data', { view: 'issues', params: {}, locale: 'en' })
  assert.deepEqual(list.rows, [])
  assert.equal(list.empty.title, 'Sentry could not be read')
  assert.match(list.empty.description, /401|refused|token/i)
  const detail = await setup(refused).hook('view.data', { view: 'issue', params: { id: '1' }, locale: 'en' })
  assert.equal(detail.title, 'This issue could not be shown')
  assert.match(detail.body, /401|refused|token/i)
})

test('the plugin asks only for Sentry’s hosts, tools and the @ menu', () => {
  assert.deepEqual(setup().entry.permissions, ['network:sentry.io', 'network:*.sentry.io', 'tools', 'prompt.attach'])
})
