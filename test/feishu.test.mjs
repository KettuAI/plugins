import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'

const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789'
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789'

function setup({ webhook = FEISHU, signSecret, keyword, answer } = {}) {
  return loadPlugin('feishu', {
    settings: keyword === undefined ? {} : { keyword },
    secrets: { webhook, signSecret },
    fetch: () => answer ?? { status: 200, body: { code: 0, msg: 'success', data: {} } },
  })
}

/** The notice listeners wait a short gap between posts, which the plugin's clock runs. */
async function notice(plugin, payload) {
  const done = plugin.emit('channel.notice', { channel: 'feishu', ...payload })
  await plugin.advance(1_000)
  return done
}

test('the signature is the documented one, for any secret', async () => {
  const reference = (timestamp, secret) =>
    createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
  // "demo" is the documentation's own example secret; the others cross the hash's block sizes.
  for (const secret of ['demo', 'a', 'x'.repeat(40), 'y'.repeat(53), 'z'.repeat(54), 'k'.repeat(200), '密钥🔑secret', '€'.repeat(30)]) {
    const plugin = setup({ signSecret: secret })
    await notice(plugin, { kind: 'error', title: 'x' })
    const { body } = plugin.requests[0]
    assert.equal(body.sign, reference(body.timestamp, secret), secret)
  }
})

test('a notice is posted as an interactive card with plain text', async () => {
  const plugin = setup()
  await notice(plugin, {
    kind: 'permission',
    title: 'Fix login',
    text: 'Allow `rm -rf build` <at id=all></at> **now**',
  })
  assert.equal(plugin.requests.length, 1)
  const [sent] = plugin.requests
  assert.equal(sent.url, FEISHU)
  assert.equal(sent.method, 'POST')
  assert.equal(sent.headers['content-type'], 'application/json')
  assert.deepEqual(sent.body, {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: 'Fix login' },
        subtitle: { tag: 'plain_text', content: 'Kettu · A request needs your answer' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'plain_text', content: 'Allow `rm -rf build` <at id=all></at> **now**' },
        },
      ],
    },
  })
  assert.ok(sent.raw.length < 20 * 1024)
})

test('each kind has a color and the interface language names it', async () => {
  const plugin = loadPlugin('feishu', {
    locale: 'zh-CN',
    secrets: { webhook: LARK },
    fetch: () => ({ status: 200, body: { code: 0 } }),
  })
  const colors = {}
  for (const kind of ['permission', 'turnEnded', 'error', 'routines', 'planLimits']) {
    await notice(plugin, { kind, title: kind })
    colors[kind] = plugin.requests.at(-1).body.card.header.template
  }
  assert.deepEqual(colors, { permission: 'orange', turnEnded: 'green', error: 'red', routines: 'blue', planLimits: 'yellow' })
  assert.equal(plugin.requests[1].body.card.header.subtitle.content, 'Kettu · 一轮对话结束了')
  assert.ok(plugin.requests.every((r) => r.url === LARK))
})

test('with a secret the body carries the timestamp and the signature', async () => {
  const plugin = setup({ signSecret: 'demo' })
  await notice(plugin, { kind: 'error', title: 'Boom' })
  const { body } = plugin.requests[0]
  const timestamp = Math.floor(plugin.clock.now / 1000) - 1
  assert.equal(typeof body.timestamp, 'string')
  assert.ok(Math.abs(Number(body.timestamp) - timestamp) <= 2)
  assert.equal(body.sign, createHmac('sha256', `${body.timestamp}\ndemo`).update('').digest('base64'))
  const unsigned = setup()
  await notice(unsigned, { kind: 'error', title: 'Boom' })
  assert.ok(!('sign' in unsigned.requests[0].body) && !('timestamp' in unsigned.requests[0].body))
})

test('the keyword goes in front of a title that lacks it', async () => {
  const plugin = setup({ keyword: 'Kettu' })
  await notice(plugin, { kind: 'error', title: 'Boom' })
  await notice(plugin, { kind: 'error', title: 'Kettu says boom' })
  assert.deepEqual(
    plugin.requests.map((r) => r.body.card.header.title.content),
    ['Kettu Boom', 'Kettu says boom'],
  )
})

test('only the two services’ bot addresses are used', async () => {
  for (const webhook of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d4e5f',
    'https://evil.example.com/open-apis/bot/v2/hook/0a1b2c3d4e5f',
    'https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/0a1b2c3d4e5f',
    'https://open.feishu.cn/open-apis/bot/v2/hook/',
    'https://open.feishu.cn/open-apis/im/v1/messages',
    'https://open.feishu.cn:8443/open-apis/bot/v2/hook/0a1b2c3d4e5f',
  ]) {
    const plugin = setup({ webhook })
    await notice(plugin, { kind: 'error', title: 'x' })
    assert.equal(plugin.requests.length, 0, webhook)
    assert.match(plugin.logs.at(-1).text, /could not be sent: The webhook address must look like/)
  }
})

test('no address set: nothing is sent', async () => {
  const plugin = setup({ webhook: null })
  await notice(plugin, { kind: 'error', title: 'x' })
  assert.equal(plugin.requests.length, 0)
  assert.match(plugin.logs.at(-1).text, /no webhook address/)
})

test('the documented error codes are explained', async () => {
  for (const [code, words] of [
    [19021, /signature is wrong/],
    [19022, /allowed list/],
    [19024, /requires a keyword/],
    [11232, /rate limited/],
    [9499, /not accepted/],
  ]) {
    const plugin = setup({ answer: { status: 200, body: { code, msg: 'x' } } })
    const result = await plugin.hook('action.run', { action: 'test', locale: 'en' })
    assert.match(result.error, new RegExp(`answered ${code}`))
    assert.match(result.error, words)
  }
  const plugin = setup({ answer: { status: 400, body: { code: 9499, msg: 'Bad Request' } } })
  assert.match((await plugin.hook('action.run', {})).error, /9499/)
})

test('a burst of notices is spread out under the bot’s rate limit', async () => {
  const plugin = setup()
  const sends = [1, 2, 3, 4].map((n) => plugin.emit('channel.notice', { channel: 'feishu', kind: 'error', title: `n${n}` }))
  await plugin.advance(0)
  assert.equal(plugin.requests.length, 1)
  await plugin.advance(250)
  assert.equal(plugin.requests.length, 2)
  await plugin.advance(2_000)
  await Promise.all(sends)
  assert.deepEqual(plugin.requests.map((r) => r.body.card.header.title.content), ['n1', 'n2', 'n3', 'n4'])
})

test('the view and the Search action send a test card', async () => {
  const plugin = setup()
  const view = await plugin.hook('view.data', { view: 'status', params: {}, locale: 'en' })
  assert.equal(view.text, 'Posting to Feishu.')
  assert.equal(view.actions[0].id, 'test')
  assert.equal(view.actions[0].disabled, false)
  const done = plugin.hook('view.action', { view: 'status', action: 'test', params: {}, locale: 'en' })
  await plugin.advance(1_000)
  assert.match((await done).notice, /Sent/)
  assert.equal(plugin.requests[0].body.card.header.title.content, 'Kettu test card')
  const lark = setup({ webhook: LARK })
  assert.equal((await lark.hook('view.data', { view: 'status', params: {}, locale: 'en' })).text, 'Posting to Lark.')
  const none = setup({ webhook: null })
  const empty = await none.hook('view.data', { view: 'status', params: {}, locale: 'en' })
  assert.equal(empty.actions[0].disabled, true)
})

test('the plugin asks for the two services and the words of a notice, and cannot answer requests', () => {
  const { entry } = setup()
  assert.deepEqual(entry.permissions, ['network:open.feishu.cn', 'network:open.larksuite.com', 'sessions.content'])
})
