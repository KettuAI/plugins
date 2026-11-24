import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'

/** A small ntfy.sh: publishing as JSON at the root, and reading a topic with `poll=1`. */
function fakeNtfy(clock) {
  const topics = new Map()
  let next = 1
  const store = (topic, message) => {
    const stored = { id: `m${next++}`, time: Math.floor(clock.now / 1000), event: 'message', topic, ...message }
    topics.set(topic, [...(topics.get(topic) ?? []), stored])
    return stored
  }
  return {
    topics,
    /** What a phone does when a button is tapped. */
    post: (topic, text) => store(topic, { message: text }),
    fetch: (sent) => {
      const url = new URL(sent.url)
      if (sent.method === 'POST' && url.pathname === '/') {
        const { topic, ...rest } = sent.body
        return { status: 200, body: store(topic, rest) }
      }
      const poll = /^\/([^/]+)\/json$/.exec(url.pathname)
      if (sent.method === 'GET' && poll && url.searchParams.get('poll') === '1') {
        const since = Number(url.searchParams.get('since'))
        const lines = (topics.get(poll[1]) ?? []).filter((m) => m.time >= since).map((m) => JSON.stringify(m))
        return { status: 200, body: lines.join('\n') }
      }
      return { status: 404, body: { error: 'not found' } }
    },
  }
}

function setup(options = {}) {
  const clockRef = { now: Date.UTC(2026, 10, 24, 12, 0, 0) }
  const ntfy = fakeNtfy(clockRef)
  const plugin = loadPlugin('ntfy', {
    now: clockRef.now,
    fetch: (sent) => options.fetch?.(sent) ?? ntfy.fetch(sent),
    answer: options.answer,
    settings: options.settings,
    secrets: options.secrets,
    locale: options.locale,
  })
  // The fake server reads the plugin's clock.
  Object.defineProperty(clockRef, 'now', { get: () => plugin.clock.now })
  return { plugin, ntfy }
}

const request = (id = 'req-1') => ({
  id,
  tool: 'Run command',
  kind: 'execute',
  command: 'rm -rf build',
  paths: [],
})

test('a notice goes to the generated topic, which is kept', async () => {
  const { plugin, ntfy } = setup()
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'turnEnded', title: 'Fix login', text: 'Done in 4 min' })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'error', title: 'Boom' })
  assert.equal(ntfy.topics.size, 1)
  const [topic, messages] = [...ntfy.topics][0]
  assert.match(topic, /^kettu-[0-9a-f]{26}$/)
  assert.equal(plugin.storage.get('topic'), topic)
  assert.deepEqual(
    messages.map((m) => [m.title, m.message, m.priority, m.tags, m.actions]),
    [
      ['Fix login', 'Done in 4 min', 3, ['white_check_mark'], undefined],
      ['Boom', 'Boom', 4, ['x'], undefined],
    ],
  )
})

test('the topic setting wins and is checked', async () => {
  const { plugin, ntfy } = setup({ settings: { topic: ' my_topic-1 ' } })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'routines', title: 'Routine paused' })
  assert.deepEqual([...ntfy.topics.keys()], ['my_topic-1'])
  const bad = setup({ settings: { topic: 'has space' } })
  await bad.plugin.emit('channel.notice', { channel: 'ntfy', kind: 'routines', title: 'x' })
  assert.equal(bad.plugin.requests.length, 0)
  assert.match(bad.plugin.logs.at(-1).text, /only letters, numbers/)
})

test('the access token is sent as a bearer token to ntfy.sh only', async () => {
  const { plugin } = setup({ secrets: { token: 'tk_secret123' } })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'error', title: 'Boom' })
  assert.equal(plugin.requests[0].headers.authorization, 'Bearer tk_secret123')
  assert.ok(plugin.requests.every((r) => new URL(r.url).hostname === 'ntfy.sh'))
  assert.ok(!JSON.stringify(plugin.logs).includes('tk_secret123'))
})

test('a permission request carries buttons that post a secret to a separate topic', async () => {
  const { plugin, ntfy } = setup()
  await plugin.emit('channel.notice', {
    channel: 'ntfy',
    kind: 'permission',
    title: 'Fix login',
    request: request(),
  })
  const [[topic, [sent]]] = [...ntfy.topics]
  assert.equal(sent.priority, 4)
  assert.equal(sent.message, 'Run command\n$ rm -rf build')
  const [allow, deny] = sent.actions
  assert.deepEqual([allow.label, deny.label], ['Allow once', 'Deny'])
  assert.equal(allow.method, 'POST')
  assert.equal(allow.clear, true)
  const replyTopic = new URL(allow.url).pathname.slice(1)
  assert.notEqual(replyTopic, topic)
  assert.equal(deny.url, allow.url)
  const nonce = allow.body.split(' ')[1]
  assert.match(allow.body, /^allow [0-9a-f]{24}$/)
  assert.equal(deny.body, `deny ${nonce}`)
  assert.ok(!sent.message.includes(nonce))
})

test('buttons use the interface language', async () => {
  const { plugin, ntfy } = setup({ locale: 'zh-CN' })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'permission', title: 't', request: request() })
  const [[, [sent]]] = [...ntfy.topics]
  assert.deepEqual(sent.actions.map((a) => a.label), ['允许一次', '拒绝'])
})

async function ask(plugin, ntfy) {
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'permission', title: 't', request: request() })
  const [, [sent]] = [...ntfy.topics][0]
  const [allow, deny] = sent.actions
  return { reply: new URL(allow.url).pathname.slice(1), allow: allow.body, deny: deny.body }
}

test('a tapped button is relayed once, from ntfy, and polling stops', async () => {
  const answered = []
  const { plugin, ntfy } = setup({ answer: (input) => answered.push(input) })
  const { reply, allow } = await ask(plugin, ntfy)
  await plugin.advance(6_000)
  assert.equal(answered.length, 0)
  await plugin.advance(1_000)
  ntfy.post(reply, allow)
  await plugin.advance(6_000)
  assert.deepEqual(answered, [{ request: 'req-1', decision: 'allow_once', from: 'ntfy' }])
  assert.equal(plugin.pendingTimers(), 0)
  const polls = plugin.requests.length
  await plugin.advance(60_000)
  assert.equal(plugin.requests.length, polls)
})

test('deny is relayed as a denial', async () => {
  const answered = []
  const { plugin, ntfy } = setup({ answer: (input) => answered.push(input) })
  const { reply, deny } = await ask(plugin, ntfy)
  ntfy.post(reply, deny)
  await plugin.advance(6_000)
  assert.equal(answered[0].decision, 'deny')
})

test('a message without the secret the notice carried is ignored', async () => {
  const answered = []
  const { plugin, ntfy } = setup({ answer: (input) => answered.push(input) })
  const { reply, allow } = await ask(plugin, ntfy)
  const wrong = 'allow ' + 'a'.repeat(24)
  for (const text of ['allow', wrong, 'allow x', `${allow} extra`, 'ALLOW ' + allow.slice(6), 'always ' + allow.slice(6), '']) {
    ntfy.post(reply, text)
  }
  // Right text on another topic, which nothing reads.
  ntfy.post('kettu-r-elsewhere', allow)
  await plugin.advance(6_000)
  assert.equal(answered.length, 0)
  assert.equal(plugin.pendingTimers(), 1)
})

test('a secret works once', async () => {
  const answered = []
  const { plugin, ntfy } = setup({ answer: (input) => answered.push(input) })
  const first = await ask(plugin, ntfy)
  ntfy.post(first.reply, first.allow)
  await plugin.advance(6_000)
  // A second request that waits keeps the poll going; the old secret does nothing.
  await plugin.emit('channel.notice', {
    channel: 'ntfy',
    kind: 'permission',
    title: 't',
    request: request('req-2'),
  })
  ntfy.post(first.reply, first.allow)
  await plugin.advance(6_000)
  assert.deepEqual(answered.map((a) => a.request), ['req-1'])
})

test('each request is answered by its own secret', async () => {
  const answered = []
  const { plugin, ntfy } = setup({ answer: (input) => answered.push(input) })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'permission', title: 'a', request: request('req-1') })
  await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'permission', title: 'b', request: request('req-2') })
  const [, [one, two]] = [...ntfy.topics][0]
  const reply = new URL(one.actions[0].url).pathname.slice(1)
  assert.equal(reply, new URL(two.actions[0].url).pathname.slice(1))
  ntfy.post(reply, two.actions[0].body)
  await plugin.advance(6_000)
  assert.deepEqual(answered.map((a) => a.request), ['req-2'])
  ntfy.post(reply, one.actions[1].body)
  await plugin.advance(6_000)
  assert.deepEqual(answered.map((a) => [a.request, a.decision]), [['req-2', 'allow_once'], ['req-1', 'deny']])
})

test('a request that no longer waits is dropped without a retry', async () => {
  const { plugin, ntfy } = setup({
    answer: () => {
      throw new Error('That request no longer waits')
    },
  })
  const { reply, allow } = await ask(plugin, ntfy)
  ntfy.post(reply, allow)
  await plugin.advance(6_000)
  assert.equal(plugin.pendingTimers(), 0)
  assert.match(plugin.logs.at(-1).text, /could not be relayed/)
})

test('polling slows down, and a request is forgotten after half an hour', async () => {
  const { plugin, ntfy } = setup()
  await ask(plugin, ntfy)
  const count = () => plugin.requests.filter((r) => r.method === 'GET').length
  await plugin.advance(5 * 60_000)
  const fast = count()
  assert.ok(fast >= 45 && fast <= 51, `fast polls: ${fast}`)
  await plugin.advance(5 * 60_000)
  const slow = count() - fast
  assert.ok(slow >= 14 && slow <= 16, `slow polls in 5 minutes: ${slow}`)
  await plugin.advance(30 * 60_000)
  const total = count()
  await plugin.advance(10 * 60_000)
  assert.equal(count(), total)
  assert.equal(plugin.pendingTimers(), 0)
})

test('a rate limit backs off for a minute', async () => {
  let limited = true
  const { plugin, ntfy } = setup({
    fetch: (sent) => (sent.method === 'GET' && limited ? { status: 429, body: { error: 'limit' } } : undefined),
  })
  await ask(plugin, ntfy)
  await plugin.advance(6_000)
  const first = plugin.requests.filter((r) => r.method === 'GET').length
  assert.equal(first, 1)
  await plugin.advance(50_000)
  assert.equal(plugin.requests.filter((r) => r.method === 'GET').length, 1)
  limited = false
  await plugin.advance(10_000)
  assert.equal(plugin.requests.filter((r) => r.method === 'GET').length, 2)
})

test('a failing server is logged and never throws into Kettu', async () => {
  const { plugin } = setup({ fetch: () => ({ status: 500, body: { error: 'down' } }) })
  const answers = await plugin.emit('channel.notice', { channel: 'ntfy', kind: 'error', title: 'x' })
  assert.deepEqual(answers, [undefined])
  assert.match(plugin.logs.at(-1).text, /ntfy\.sh answered 500: down/)
})

test('the view shows the topic and its actions send a test and change the topic', async () => {
  const { plugin, ntfy } = setup()
  const view = await plugin.hook('view.data', { view: 'status', params: {}, locale: 'en' })
  const topic = plugin.storage.get('topic')
  assert.deepEqual(view.fields, [
    { label: 'Topic', value: topic, mono: true },
    { label: 'Address', value: `https://ntfy.sh/${topic}`, mono: true },
  ])
  assert.equal(view.text, undefined)
  assert.deepEqual(view.actions.map((a) => a.id), ['test', 'regenerate'])
  const sent = await plugin.hook('view.action', { view: 'status', action: 'test', params: {}, locale: 'en' })
  assert.match(sent.notice, /Sent/)
  assert.equal(ntfy.topics.get(topic).length, 1)
  const changed = await plugin.hook('view.action', { view: 'status', action: 'regenerate', params: {}, locale: 'en' })
  assert.notEqual(plugin.storage.get('topic'), topic)
  assert.ok(changed.notice.includes(plugin.storage.get('topic')))
  const search = await plugin.hook('action.run', { action: 'test', locale: 'en' })
  assert.match(search.notice, /Sent/)
})

test('a topic from the settings cannot be regenerated', async () => {
  const { plugin } = setup({ settings: { topic: 'mine' } })
  const view = await plugin.hook('view.data', { view: 'status', params: {}, locale: 'en' })
  assert.deepEqual(view.actions.map((a) => a.id), ['test'])
  assert.equal(view.fields[0].value, 'mine')
})

test('the manifest asks for what the script uses', () => {
  const { plugin } = setup()
  assert.deepEqual(plugin.entry.permissions, ['network:ntfy.sh', 'sessions.content', 'requests.answer'])
})
