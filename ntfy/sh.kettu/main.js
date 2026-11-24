// @ts-check

const SERVER = 'https://ntfy.sh'
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const NONCE_CHARS = 24
const ANSWER = new RegExp(`^(allow|deny) ([a-z0-9]{${NONCE_CHARS}})$`)
// ntfy.sh refills one request per 5 s, so polling stays under that while a reply is likely.
const FAST_MS = 6_000
const SLOW_MS = 20_000
const FAST_FOR_MS = 5 * 60_000
const FORGET_MS = 30 * 60_000

/** @type {Record<string, { priority: number, tag: string }>} */
const KINDS = {
  permission: { priority: 4, tag: 'lock' },
  error: { priority: 4, tag: 'x' },
  turnEnded: { priority: 3, tag: 'white_check_mark' },
  routines: { priority: 3, tag: 'alarm_clock' },
  planLimits: { priority: 3, tag: 'hourglass_flowing_sand' },
}

const TEXT = {
  en: {
    allow: 'Allow once',
    deny: 'Deny',
    testTitle: 'Kettu test notice',
    testMessage: 'If you read this, notices from Kettu reach this topic.',
    sent: 'Sent. Look for it in the ntfy app.',
    regenerated: 'New topic: ',
    viewTitle: 'Your ntfy topic',
    topicLabel: 'Topic',
    openLabel: 'Address',
    generated: 'Made for you. Subscribe to it in the ntfy app.',
    test: 'Send a test notice',
    regenerate: 'Make a new topic',
    regenerateConfirm: 'Your devices stop hearing from Kettu until they subscribe to the new topic.',
    custom: 'The topic is set in the plugin settings.',
  },
  'zh-CN': {
    allow: '允许一次',
    deny: '拒绝',
    testTitle: 'Kettu 测试通知',
    testMessage: '如果你看到这条消息，说明 Kettu 的通知已经送到这个 topic。',
    sent: '已发送，请在 ntfy 应用里查看。',
    regenerated: '新的 topic：',
    viewTitle: '你的 ntfy topic',
    topicLabel: 'Topic',
    openLabel: '地址',
    generated: '为你生成的，在 ntfy 应用里订阅它。',
    test: '发送测试通知',
    regenerate: '换一个新 topic',
    regenerateConfirm: '换了以后，设备要订阅新的 topic 才能继续收到 Kettu 的通知。',
    custom: 'Topic 在插件设置里指定。',
  },
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error))
/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function words() {
  return (await kettu.call('app.locale')) === 'zh-CN' ? TEXT['zh-CN'] : TEXT.en
}

// The sandbox has no cryptographic random source, so this is the best it offers.
/** @param {number} length */
function randomText(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

/** The topic the user set, else the one made and kept for them. */
async function topicName() {
  const set = String(await kettu.call('settings.get', 'topic')).trim()
  if (set !== '') {
    if (!TOPIC.test(set)) {
      throw new Error('The topic may hold only letters, numbers, - and _, up to 64 characters')
    }
    return set
  }
  const kept = await kettu.call('storage.get', 'topic')
  if (typeof kept === 'string' && TOPIC.test(kept)) return kept
  const made = `kettu-${randomText(26)}`
  await kettu.call('storage.set', 'topic', made)
  return made
}

/** A second topic only the notification names, which the buttons post to. */
async function replyTopicFor(/** @type {string} */ topic) {
  const kept = /** @type {{ topic?: string, reply?: string } | null} */ (
    await kettu.call('storage.get', 'reply')
  )
  if (kept && kept.topic === topic && typeof kept.reply === 'string' && TOPIC.test(kept.reply)) {
    return kept.reply
  }
  const reply = `kettu-r-${randomText(26)}`
  await kettu.call('storage.set', 'reply', { topic, reply })
  return reply
}

/** @param {{ status: number, body: string }} response */
function failure(response) {
  if (response.status === 401 || response.status === 403) {
    return new Error('ntfy.sh refused the access token, or the topic is protected for other users')
  }
  if (response.status === 429) {
    return new Error('ntfy.sh is limiting requests from this computer; try again in a minute')
  }
  let detail = ''
  try {
    detail = String(JSON.parse(response.body).error ?? '')
  } catch {
    // Not a JSON answer.
  }
  return new Error(`ntfy.sh answered ${response.status}${detail ? `: ${clip(detail, 200)}` : ''}`)
}

/** @param {string} path @param {{ method?: string, headers?: Record<string, string>, body?: string }} init */
async function ntfy(path, init = {}) {
  const token = await kettu.call('settings.secret', 'token')
  const headers = { ...init.headers }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await kettu.call('network.fetch', `${SERVER}${path}`, { ...init, headers })
  if (response.status < 200 || response.status >= 300) throw failure(response)
  return response
}

/** @param {string} topic @param {Record<string, unknown>} notice */
async function publish(topic, notice) {
  const response = await ntfy('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, ...notice }),
  })
  return /** @type {{ id: string, time: number }} */ (JSON.parse(response.body))
}

// Requests a notice offered buttons for, by the secret each button carries.
/** @type {Map<string, { request: string, reply: string, at: number }>} */
const waiting = new Map()
let since = 0
let timer = /** @type {number | null} */ (null)
let busy = false

function expire() {
  const oldest = Date.now() - FORGET_MS
  for (const [nonce, entry] of waiting) if (entry.at < oldest) waiting.delete(nonce)
}

function schedule() {
  if (timer !== null || busy || waiting.size === 0) return
  const oldest = Math.min(...[...waiting.values()].map((entry) => entry.at))
  const delay = Date.now() - oldest < FAST_FOR_MS ? FAST_MS : SLOW_MS
  timer = setTimeout(poll, delay)
}

/** Relays the answers the buttons posted to the reply topics of the requests that wait. */
async function poll() {
  timer = null
  busy = true
  let slowDown = false
  try {
    expire()
    for (const reply of new Set([...waiting.values()].map((entry) => entry.reply))) {
      const response = await ntfy(`/${reply}/json?poll=1&since=${Math.max(0, since - 1)}`)
      for (const line of response.body.split('\n')) {
        if (line.trim() === '') continue
        /** @type {{ event?: string, topic?: string, time?: number, message?: string }} */
        let item
        try {
          item = JSON.parse(line)
        } catch {
          continue
        }
        if (item.event !== 'message' || item.topic !== reply) continue
        if (typeof item.time === 'number') since = Math.max(since, item.time)
        const found = ANSWER.exec(String(item.message ?? '').trim())
        const entry = found ? waiting.get(/** @type {string} */ (found[2])) : undefined
        // Anything without a secret that a notice carried is ignored.
        if (!found || !entry || entry.reply !== reply) continue
        waiting.delete(/** @type {string} */ (found[2]))
        try {
          await kettu.call('requests.answer', {
            request: entry.request,
            decision: found[1] === 'allow' ? 'allow_once' : 'deny',
            from: 'ntfy',
          })
        } catch (error) {
          console.warn(`An answer from ntfy could not be relayed: ${message(error)}`)
        }
      }
    }
  } catch (error) {
    slowDown = /limiting/.test(message(error))
    console.warn(`Could not read the answers from ntfy: ${message(error)}`)
  } finally {
    busy = false
    expire()
    if (slowDown) {
      timer = waiting.size > 0 ? setTimeout(poll, 60_000) : null
    } else {
      schedule()
    }
  }
}

/** @param {import('../../types/index').ChannelNotice} notice */
async function send(notice) {
  const text = await words()
  const topic = await topicName()
  const kind = KINDS[notice.kind] ?? KINDS.turnEnded
  /** @type {Record<string, unknown>} */
  const out = {
    title: clip(notice.title, 250),
    message: clip(notice.text || notice.title, 1000),
    priority: kind.priority,
    tags: [kind.tag],
  }
  const request = notice.request
  let nonce = ''
  let reply = ''
  if (request) {
    nonce = randomText(NONCE_CHARS)
    reply = await replyTopicFor(topic)
    const what = request.command ? `$ ${request.command}` : request.paths.join('\n')
    out.message = clip([request.tool, what].filter(Boolean).join('\n'), 1000)
    const button = (/** @type {'allow' | 'deny'} */ decision) => ({
      action: 'http',
      label: text[decision],
      url: `${SERVER}/${reply}`,
      method: 'POST',
      body: `${decision} ${nonce}`,
      clear: true,
    })
    out.actions = [button('allow'), button('deny')]
  }
  const sent = await publish(topic, out)
  if (request) {
    waiting.set(nonce, { request: request.id, reply, at: Date.now() })
    if (waiting.size === 1) since = sent.time
    schedule()
  }
}

async function sendTest() {
  const text = await words()
  await publish(await topicName(), {
    title: text.testTitle,
    message: text.testMessage,
    tags: ['white_check_mark'],
  })
}

kettu.on('channel.notice', async (notice) => {
  try {
    await send(notice)
  } catch (error) {
    console.warn(`A notice could not be sent: ${message(error)}`)
  }
})

kettu.on('view.data', async () => {
  const text = await words()
  const custom = String(await kettu.call('settings.get', 'topic')).trim() !== ''
  const topic = await topicName()
  /** @type {import('../../types/index').ViewAction[]} */
  const actions = [{ id: 'test', label: text.test, icon: 'bell', primary: true }]
  if (!custom) {
    actions.push({
      id: 'regenerate',
      label: text.regenerate,
      icon: 'reload',
      destructive: true,
      confirm: text.regenerateConfirm,
    })
  }
  return {
    title: text.viewTitle,
    subtitle: custom ? text.custom : text.generated,
    fields: [
      { label: text.topicLabel, value: topic, mono: true },
      { label: text.openLabel, value: `${SERVER}/${topic}`, mono: true },
    ],
    actions,
  }
})

kettu.on('view.action', async ({ action }) => {
  const text = await words()
  try {
    if (action === 'test') {
      await sendTest()
      return { notice: text.sent }
    }
    if (action === 'regenerate') {
      const made = `kettu-${randomText(26)}`
      await kettu.call('storage.set', 'topic', made)
      return { notice: `${text.regenerated}${made}` }
    }
  } catch (error) {
    return { error: clip(message(error), 300) }
  }
  return { error: `No action ${action}` }
})

kettu.on('action.run', async () => {
  try {
    await sendTest()
    return { notice: (await words()).sent }
  } catch (error) {
    return { error: clip(message(error), 300) }
  }
})
