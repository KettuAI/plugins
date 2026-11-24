// @ts-check

// A custom bot's address is on one of the two services' own domains, with a token as its last part.
const WEBHOOK = /^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,}$/
// The service allows 5 requests a second and 100 a minute for one bot.
const GAP_MS = 250

/** @type {Record<string, { template: string, en: string, 'zh-CN': string }>} */
const KINDS = {
  permission: { template: 'orange', en: 'A request needs your answer', 'zh-CN': '有请求等你回复' },
  turnEnded: { template: 'green', en: 'A turn ended', 'zh-CN': '一轮对话结束了' },
  error: { template: 'red', en: 'A session failed', 'zh-CN': '有会话出错了' },
  routines: { template: 'blue', en: 'A routine needs a look', 'zh-CN': '有定时任务需要看一下' },
  planLimits: { template: 'yellow', en: 'A plan limit changed', 'zh-CN': '套餐限额有变化' },
}

/** What the service says for the codes its documentation lists. */
const CODES = {
  9499: 'the request was not accepted as written',
  11232: 'the bot is being rate limited; try again later',
  19021: 'the signature is wrong, or this computer’s clock is more than an hour off',
  19022: 'this computer’s address is not on the bot’s allowed list',
  19024: 'the bot requires a keyword; set it in the plugin settings',
}

const TEXT = {
  en: {
    testTitle: 'Kettu test card',
    testText: 'If you read this, notices from Kettu reach this group.',
    sent: 'Sent. Look for it in the group.',
    test: 'Send a test card',
    notSet: 'No webhook address is set yet. Add it in the plugin settings.',
    feishu: 'Posting to Feishu.',
    lark: 'Posting to Lark.',
  },
  'zh-CN': {
    testTitle: 'Kettu 测试卡片',
    testText: '如果你看到这张卡片，说明 Kettu 的通知已经送到这个群。',
    sent: '已发送，请在群里查看。',
    test: '发送测试卡片',
    notSet: '还没有设置 webhook 地址，请在插件设置里填写。',
    feishu: '发送到飞书。',
    lark: '发送到 Lark。',
  },
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error))
/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function words() {
  return (await kettu.call('app.locale')) === 'zh-CN' ? TEXT['zh-CN'] : TEXT.en
}

// The sandbox has no crypto, text encoding or base64, so the signature is worked out here.

/** @param {string} text */
function utf8(text) {
  /** @type {number[]} */
  const bytes = []
  for (const char of text) {
    const code = /** @type {number} */ (char.codePointAt(0))
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
    }
  }
  return bytes
}

// prettier-ignore
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** @param {number[]} bytes */
function sha256(bytes) {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const data = [...bytes, 0x80]
  while (data.length % 64 !== 56) data.push(0)
  const bits = bytes.length * 8
  const high = Math.floor(bits / 0x100000000)
  for (const word of [high, bits >>> 0]) {
    data.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255)
  }
  const w = new Array(64).fill(0)
  const rotr = (/** @type {number} */ x, /** @type {number} */ n) => (x >>> n) | (x << (32 - n))
  for (let start = 0; start < data.length; start += 64) {
    for (let i = 0; i < 16; i++) {
      const at = start + i * 4
      w[i] = ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + choice + K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const sum = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i] + sum[i]) >>> 0
  }
  /** @type {number[]} */
  const out = []
  for (const word of h) out.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255)
  return out
}

/** @param {number[]} key @param {number[]} data */
function hmacSha256(key, data) {
  const block = key.length > 64 ? sha256(key) : [...key]
  while (block.length < 64) block.push(0)
  const inner = sha256([...block.map((b) => b ^ 0x36), ...data])
  return sha256([...block.map((b) => b ^ 0x5c), ...inner])
}

/** @param {number[]} bytes */
function base64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63]
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? chars[n & 63] : '='
  }
  return out
}

/** The service signs `timestamp\nsecret` as the HMAC key over an empty message. */
/** @param {number} timestamp @param {string} secret */
function sign(timestamp, secret) {
  return base64(hmacSha256(utf8(`${timestamp}\n${secret}`), []))
}

async function webhook() {
  const url = String((await kettu.call('settings.secret', 'webhook')) ?? '').trim()
  if (url === '') return null
  if (!WEBHOOK.test(url)) {
    throw new Error(
      'The webhook address must look like https://open.feishu.cn/open-apis/bot/v2/hook/… or the same on open.larksuite.com',
    )
  }
  return url
}

/**
 * @param {string} url
 * @param {{ title: string, subtitle: string, text: string, template: string }} card
 */
async function post(url, card) {
  const keyword = String(await kettu.call('settings.get', 'keyword')).trim()
  const secret = await kettu.call('settings.secret', 'signSecret')
  const title = keyword !== '' && !card.title.includes(keyword) ? `${keyword} ${card.title}` : card.title
  /** @type {Record<string, unknown>} */
  const body = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: clip(title, 200) },
        subtitle: { tag: 'plain_text', content: clip(card.subtitle, 100) },
        template: card.template,
      },
      // Plain text, so what a notice says is never read as Markdown or as an @ mention.
      elements:
        card.text === ''
          ? []
          : [{ tag: 'div', text: { tag: 'plain_text', content: clip(card.text, 4000) } }],
    },
  }
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000)
    body.timestamp = String(timestamp)
    body.sign = sign(timestamp, secret)
  }
  const response = await kettu.call('network.fetch', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  /** @type {{ code?: number, StatusCode?: number, msg?: string }} */
  let answer = {}
  try {
    answer = JSON.parse(response.body)
  } catch {
    // Not a JSON answer.
  }
  const code = answer.code ?? answer.StatusCode ?? (response.status === 200 ? 0 : response.status)
  if (response.status === 200 && code === 0) return
  const known = /** @type {Record<number, string>} */ (CODES)[code]
  throw new Error(
    `The bot answered ${code}${known ? `: ${known}` : answer.msg ? `: ${clip(answer.msg, 200)}` : ''}`,
  )
}

let queue = Promise.resolve()

/** One at a time with a short gap, so a burst of notices stays under the bot's rate limit. */
/** @param {() => Promise<void>} job */
function inTurn(job) {
  const run = queue.then(job)
  queue = run.then(
    () => new Promise((resolve) => setTimeout(resolve, GAP_MS)),
    () => new Promise((resolve) => setTimeout(resolve, GAP_MS)),
  )
  return run
}

kettu.on('channel.notice', async (notice) => {
  try {
    const url = await webhook()
    if (url === null) {
      console.warn('A notice was not sent: no webhook address is set')
      return
    }
    const locale = (await kettu.call('app.locale')) === 'zh-CN' ? 'zh-CN' : 'en'
    const kind = KINDS[notice.kind] ?? KINDS.turnEnded
    await inTurn(() =>
      post(url, {
        title: notice.title,
        subtitle: `Kettu · ${kind[locale]}`,
        text: notice.text ?? '',
        template: kind.template,
      }),
    )
  } catch (error) {
    console.warn(`A notice could not be sent: ${message(error)}`)
  }
})

async function sendTest() {
  const url = await webhook()
  if (url === null) throw new Error((await words()).notSet)
  const text = await words()
  await inTurn(() =>
    post(url, { title: text.testTitle, subtitle: 'Kettu', text: text.testText, template: 'blue' }),
  )
}

kettu.on('view.data', async () => {
  const text = await words()
  const url = await webhook()
  return {
    text: url === null ? text.notSet : url.includes('larksuite.com') ? text.lark : text.feishu,
    actions: [{ id: 'test', label: text.test, icon: 'bell', primary: true, disabled: url === null }],
  }
})

kettu.on('view.action', async ({ action }) => {
  if (action !== 'test') return { error: `No action ${action}` }
  try {
    await sendTest()
    return { notice: (await words()).sent }
  } catch (error) {
    return { error: clip(message(error), 300) }
  }
})

kettu.on('action.run', async () => {
  try {
    await sendTest()
    return { notice: (await words()).sent }
  } catch (error) {
    return { error: clip(message(error), 300) }
  }
})
