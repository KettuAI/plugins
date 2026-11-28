import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'

/** Minimal Feishu pbbp2 frame encoder for simulating server-pushed binary frames in tests. */
function encodeVarint(out, value) {
  let v = BigInt(value)
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
}

function encodeBytes(out, field, bytes) {
  encodeVarint(out, (field << 3) | 2)
  encodeVarint(out, bytes.length)
  for (const b of bytes) out.push(b)
}

function buildFeishuEventFrame(eventPayload) {
  const out = []
  encodeVarint(out, (1 << 3) | 0)
  encodeVarint(out, 7)
  encodeVarint(out, (2 << 3) | 0)
  encodeVarint(out, 9)
  encodeVarint(out, (3 << 3) | 0)
  encodeVarint(out, 42)
  encodeVarint(out, (4 << 3) | 0)
  encodeVarint(out, 1) // method=1 (data)
  const header = []
  encodeBytes(header, 1, Buffer.from('type', 'utf8'))
  encodeBytes(header, 2, Buffer.from('event', 'utf8'))
  encodeBytes(out, 5, header)
  encodeBytes(out, 8, Buffer.from(JSON.stringify(eventPayload), 'utf8'))
  return Buffer.from(out).toString('base64')
}

test('telegram-bot: tests token, polls inbound DM, and splits long replies', async () => {
  let pollCalls = 0
  const plugin = loadPlugin('telegram-bot', {
    secrets: { botToken: '123:test-token' },
    fetch: (req) => {
      if (req.url.endsWith('/getMe')) {
        return { body: { ok: true, result: { id: 99, username: 'kettu_demo_bot' } } }
      }
      if (req.url.includes('/getUpdates')) {
        pollCalls++
        if (pollCalls === 1) {
          return {
            body: {
              ok: true,
              result: [
                {
                  update_id: 500,
                  message: {
                    message_id: 11,
                    from: { id: 777, first_name: 'Alice', username: 'alice' },
                    chat: { id: 777, type: 'private' },
                    text: '@dev check build status',
                  },
                },
              ],
            },
          }
        }
        return { body: { ok: true, result: [] } }
      }
      if (req.url.endsWith('/sendChatAction') || req.url.endsWith('/sendMessage')) {
        return { body: { ok: true, result: {} } }
      }
      return { status: 404, body: { ok: false, description: 'not found' } }
    },
  })

  const tested = await plugin.hook('botChannel.test', { channel: 'telegram' })
  assert.deepEqual(tested, { ok: true, label: '@kettu_demo_bot' })

  await plugin.emit('botChannel.start', { channel: 'telegram' })
  await plugin.advance(30)

  assert.equal(plugin.inbounds.length, 1)
  assert.equal(plugin.inbounds[0].dedupId, 'telegram:777:11')
  assert.equal(plugin.inbounds[0].text, '@dev check build status')
  assert.equal(plugin.storage.get('offset'), 501)
  assert.equal(plugin.channelStatuses.at(-1)?.state, 'connected')
  assert.equal(plugin.channelStatuses.at(-1)?.detail, '@kettu_demo_bot')

  await plugin.emit('botChannel.reply', {
    channel: 'telegram',
    botId: 'bot-1',
    botName: 'Dev',
    botHandle: 'dev',
    chatId: '777',
    threadId: null,
    messageId: '11',
    deliveryId: null,
    replyMode: 'summary',
    payload: { title: 'Done', body: 'All checks green.', status: 'done' },
  })
  const sent = plugin.requests.find((r) => r.url.endsWith('/sendMessage'))
  assert.ok(sent)
  assert.equal(sent.body.chat_id, '777')
  assert.equal(sent.body.reply_to_message_id, 11)
  assert.match(sent.body.text, /All checks green/)

  await plugin.emit('botChannel.stop', { channel: 'telegram' })
  assert.equal(plugin.pendingTimers(), 0)
  assert.equal(plugin.channelStatuses.at(-1)?.state, 'off')
})

test('feishu-bot: handshakes WS, decodes binary pbbp2 events, acks and replies with Card 2.0', async () => {
  const plugin = loadPlugin('feishu-bot', {
    settings: { domain: 'feishu', appId: 'cli_demo123' },
    secrets: { appSecret: 'sec_demo456' },
    fetch: (req) => {
      if (req.url.endsWith('/tenant_access_token/internal')) {
        return { body: { code: 0, tenant_access_token: 't-token-1', expire: 7200 } }
      }
      if (req.url.endsWith('/callback/ws/endpoint')) {
        return {
          body: {
            code: 0,
            data: {
              URL: 'wss://msg-frontier.feishu.cn/ws/v2?service_id=42',
              ClientConfig: { PingInterval: 60 },
            },
          },
        }
      }
      if (req.url.includes('/open-apis/im/v1/messages/')) {
        return { body: { code: 0, data: {} } }
      }
      return { status: 404, body: { code: 404 } }
    },
  })

  const tested = await plugin.hook('botChannel.test', { channel: 'feishu' })
  assert.deepEqual(tested, { ok: true, label: 'Feishu · cli_demo123' })

  await plugin.emit('botChannel.start', { channel: 'feishu' })
  const wsId = [...plugin.wsSockets.keys()][0]
  assert.ok(wsId)
  await plugin.emit('network.ws.open', { id: wsId })
  assert.equal(plugin.channelStatuses.at(-1)?.state, 'connected')

  const frameB64 = buildFeishuEventFrame({
    header: { event_id: 'evt-99', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner123456' } },
      message: {
        message_id: 'om_msg1',
        chat_id: 'oc_chat1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/dev run tests' }),
      },
    },
  })
  await plugin.emit('network.ws.message', { id: wsId, data: frameB64, encoding: 'base64' })

  assert.equal(plugin.inbounds.length, 1)
  assert.equal(plugin.inbounds[0].dedupId, 'feishu:evt-99')
  assert.equal(plugin.inbounds[0].text, '/dev run tests')
  assert.equal(plugin.wsSent.length, 1)
  assert.equal(plugin.wsSent[0].encoding, 'base64')

  await plugin.emit('botChannel.reply', {
    channel: 'feishu',
    botId: 'bot-1',
    botName: 'Dev',
    botHandle: 'dev',
    chatId: 'oc_chat1',
    threadId: null,
    messageId: 'om_msg1',
    deliveryId: null,
    replyMode: 'summary',
    payload: { title: 'Test report', body: 'All 42 specs passed.', status: 'done' },
  })
  const replyReq = plugin.requests.find((r) => r.url.includes('/im/v1/messages/om_msg1/reply'))
  assert.ok(replyReq)
  assert.equal(replyReq.body.msg_type, 'interactive')
  const card = JSON.parse(replyReq.body.content)
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'green')

  await plugin.emit('botChannel.stop', { channel: 'feishu' })
  assert.equal(plugin.pendingTimers(), 0)
})

test('github-bot: connects via connector.session, acks deliveries and sends WS replies', async () => {
  const plugin = loadPlugin('github-bot', {
    fetch: (req) => {
      if (req.url.endsWith('/v1/github/state')) {
        return { body: { account: { login: 'octocat' }, installations: [{ installationId: '1' }] } }
      }
      return { status: 404, body: {} }
    },
  })

  const tested = await plugin.hook('botChannel.test', { channel: 'github' })
  assert.deepEqual(tested, { ok: true, label: '@octocat' })

  const view = await plugin.hook('view.data', { view: 'status', params: {}, locale: 'en' })
  assert.match(view.text, /@octocat/)

  await plugin.emit('botChannel.start', { channel: 'github' })
  const wsId = [...plugin.wsSockets.keys()][0]
  assert.ok(wsId)
  await plugin.emit('network.ws.open', { id: wsId })

  const hello = JSON.parse(plugin.wsSent[0].data)
  assert.equal(hello.type, 'hello')
  assert.equal(hello.hostId, 'host-test-1')

  await plugin.emit('network.ws.message', {
    id: wsId,
    encoding: 'text',
    data: JSON.stringify({
      type: 'delivery',
      deliveryId: 'del-77',
      channel: 'github',
      botId: 'bot-1',
      handle: 'dev',
      repo: 'KettuAI/Kettu',
      eventKind: 'pr_comment',
      number: 42,
      commentId: 9001,
      authorId: 'gh-u-1',
      authorLogin: 'octocat',
      text: 'review this PR',
      url: 'https://github.com/KettuAI/Kettu/pull/42#issuecomment-9001',
    }),
  })
  assert.equal(plugin.inbounds.length, 1)
  assert.equal(plugin.inbounds[0].scope, 'KettuAI/Kettu')
  assert.equal(plugin.inbounds[0].deliveryId, 'del-77')
  const ack = JSON.parse(plugin.wsSent[1].data)
  assert.deepEqual(ack, { type: 'ack', deliveryId: 'del-77', status: 'accepted' })

  await plugin.emit('botChannel.reply', {
    channel: 'github',
    botId: 'bot-1',
    botName: 'Dev',
    botHandle: 'dev',
    chatId: 'KettuAI/Kettu',
    threadId: 'KettuAI/Kettu#42',
    messageId: '9001',
    deliveryId: 'del-77',
    replyMode: 'auto',
    payload: { title: 'Review', body: 'Looks good to ship.', status: 'done' },
  })
  const reply = JSON.parse(plugin.wsSent[2].data)
  assert.equal(reply.type, 'reply')
  assert.equal(reply.deliveryId, 'del-77')
  assert.match(reply.body, /Looks good to ship/)

  await plugin.emit('botChannel.stop', { channel: 'github' })
})

test('custom-bridge: locks network.custom to configured endpoint in WS and HTTP poll modes', async () => {
  const plugin = loadPlugin('custom-bridge', {
    settings: { endpoint: 'http://127.0.0.1:8787', mode: 'ws' },
    secrets: { token: 'local-secret' },
    fetch: (req) => {
      if (req.url === 'http://127.0.0.1:8787/health') return { status: 200, body: { ok: true } }
      if (req.url === 'http://127.0.0.1:8787/reply') return { status: 200, body: { ok: true } }
      return { status: 404, body: {} }
    },
  })

  const tested = await plugin.hook('botChannel.test', { channel: 'custom' })
  assert.deepEqual(tested, { ok: true, label: 'http://127.0.0.1:8787' })
  assert.equal(plugin.requests[0].headers.authorization, 'Bearer local-secret')

  await plugin.emit('botChannel.start', { channel: 'custom' })
  const wsId = [...plugin.wsSockets.keys()][0]
  assert.ok(wsId)
  await plugin.emit('network.ws.open', { id: wsId })
  await plugin.emit('network.ws.message', {
    id: wsId,
    encoding: 'text',
    data: JSON.stringify({
      type: 'inbound',
      id: 'c-1',
      chatId: 'ops-room',
      senderId: 'emp-1',
      senderLabel: 'Ops Alice',
      isDirect: false,
      text: '@dev restart staging',
    }),
  })
  assert.equal(plugin.inbounds.length, 1)
  assert.equal(plugin.inbounds[0].dedupId, 'custom:c-1')

  await plugin.emit('botChannel.reply', {
    channel: 'custom',
    botId: 'bot-1',
    botName: 'Dev',
    botHandle: 'dev',
    chatId: 'ops-room',
    threadId: null,
    messageId: null,
    deliveryId: null,
    replyMode: 'auto',
    payload: { body: 'Staging restarted.', status: 'done' },
  })
  assert.equal(plugin.wsSent.length, 1)
  assert.equal(JSON.parse(plugin.wsSent[0].data).body, 'Staging restarted.')

  await plugin.emit('botChannel.stop', { channel: 'custom' })
})
