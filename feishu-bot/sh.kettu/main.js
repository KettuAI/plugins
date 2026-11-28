// @ts-check

const OPEN_ORIGIN = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}
const MAX_CARD_CHARS = 3600
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * @typedef {{
 *   seqId: bigint
 *   logId: bigint
 *   service: number
 *   method: number
 *   headers: { key: string; value: string }[]
 *   payloadEncoding?: string
 *   payloadType?: string
 *   payload?: Uint8Array
 *   logIdNew?: string
 * }} FeishuFrame
 * @typedef {{
 *   header?: { event_id?: string; event_type?: string }
 *   event?: {
 *     sender?: { sender_type?: string; sender_id?: { open_id?: string; user_id?: string } }
 *     message?: {
 *       message_id?: string
 *       root_id?: string
 *       parent_id?: string
 *       chat_id?: string
 *       chat_type?: string
 *       message_type?: string
 *       content?: string
 *       mentions?: { key?: string; id?: { open_id?: string }; name?: string }[]
 *     }
 *   }
 * }} FeishuReceiveEvent
 */

// Pure-JS UTF-8, Base64, query parsing and pbbp2 protobuf framing (QuickJS sandbox has no Web APIs).

/** @param {string} text */
function utf8Encode(text) {
  /** @type {number[]} */
  const out = []
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0))
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
    }
  }
  return new Uint8Array(out)
}

/** @param {Uint8Array} bytes */
function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i++]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
    } else if ((b0 & 0xe0) === 0xc0 && i < bytes.length) {
      const b1 = bytes[i++]
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f))
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b1 = bytes[i++]
      const b2 = bytes[i++]
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f))
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++]
      const b2 = bytes[i++]
      const b3 = bytes[i++]
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
      out += String.fromCodePoint(cp)
    } else {
      out += '\ufffd'
    }
  }
  return out
}

/** @param {Uint8Array} bytes */
function base64Encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64_CHARS[n & 63] : '='
  }
  return out
}

/** @param {string} b64 */
function base64Decode(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  /** @type {number[]} */
  const out = []
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i])
    const c1 = B64_CHARS.indexOf(clean[i + 1])
    const c2 = clean[i + 2] === '=' ? -1 : B64_CHARS.indexOf(clean[i + 2])
    const c3 = clean[i + 3] === '=' ? -1 : B64_CHARS.indexOf(clean[i + 3])
    if (c0 < 0 || c1 < 0) break
    out.push((c0 << 2) | (c1 >> 4))
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2))
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3)
  }
  return new Uint8Array(out)
}

/** @param {string} url @param {string} key */
function queryParam(url, key) {
  const qIndex = url.indexOf('?')
  if (qIndex < 0) return null
  const query = url.slice(qIndex + 1).split('#')[0]
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    const k = eq >= 0 ? pair.slice(0, eq) : pair
    if (k === key) return eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : ''
  }
  return null
}

/** @param {number[]} out @param {bigint} value */
function writeVarint(out, value) {
  let v = value < 0n ? BigInt.asUintN(64, value) : value
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
}

/** @param {Uint8Array} buf @param {number} offset */
function readVarint(buf, offset) {
  let result = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: result, next: pos }
    shift += 7n
    if (shift > 63n) throw new Error('Protobuf varint overflow')
  }
  throw new Error('Unexpected EOF reading varint')
}

/** @param {number[]} out @param {number} fieldNumber @param {Uint8Array} bytes */
function writeBytes(out, fieldNumber, bytes) {
  writeVarint(out, BigInt((fieldNumber << 3) | 2))
  writeVarint(out, BigInt(bytes.length))
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

/** @param {number[]} out @param {number} fieldNumber @param {string} text */
function writeString(out, fieldNumber, text) {
  writeBytes(out, fieldNumber, utf8Encode(text))
}

/** @param {FeishuFrame} frame */
function encodeFrame(frame) {
  /** @type {number[]} */
  const out = []
  writeVarint(out, BigInt((1 << 3) | 0))
  writeVarint(out, frame.seqId)
  writeVarint(out, BigInt((2 << 3) | 0))
  writeVarint(out, frame.logId)
  writeVarint(out, BigInt((3 << 3) | 0))
  writeVarint(out, BigInt(frame.service))
  writeVarint(out, BigInt((4 << 3) | 0))
  writeVarint(out, BigInt(frame.method))
  for (const h of frame.headers) {
    /** @type {number[]} */
    const hBuf = []
    writeString(hBuf, 1, h.key)
    writeString(hBuf, 2, h.value)
    writeBytes(out, 5, new Uint8Array(hBuf))
  }
  if (frame.payloadEncoding) writeString(out, 6, frame.payloadEncoding)
  if (frame.payloadType) writeString(out, 7, frame.payloadType)
  if (frame.payload && frame.payload.length > 0) writeBytes(out, 8, frame.payload)
  if (frame.logIdNew) writeString(out, 9, frame.logIdNew)
  return new Uint8Array(out)
}

/** @param {Uint8Array} buf */
function decodeHeader(buf) {
  let pos = 0
  let key = ''
  let value = ''
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 2) {
      const len = readVarint(buf, pos)
      pos = len.next
      const end = pos + Number(len.value)
      const slice = buf.subarray(pos, end)
      pos = end
      if (field === 1) key = utf8Decode(slice)
      else if (field === 2) value = utf8Decode(slice)
    } else if (wire === 0) {
      pos = readVarint(buf, pos).next
    } else {
      break
    }
  }
  return { key, value }
}

/** @param {Uint8Array} buf @returns {FeishuFrame} */
function decodeFrame(buf) {
  /** @type {FeishuFrame} */
  const frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 0) {
      const val = readVarint(buf, pos)
      pos = val.next
      if (field === 1) frame.seqId = val.value
      else if (field === 2) frame.logId = val.value
      else if (field === 3) frame.service = Number(val.value)
      else if (field === 4) frame.method = Number(val.value)
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      pos = len.next
      const end = pos + Number(len.value)
      const slice = buf.subarray(pos, end)
      pos = end
      if (field === 5) frame.headers.push(decodeHeader(slice))
      else if (field === 6) frame.payloadEncoding = utf8Decode(slice)
      else if (field === 7) frame.payloadType = utf8Decode(slice)
      else if (field === 8) frame.payload = slice
      else if (field === 9) frame.logIdNew = utf8Decode(slice)
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else {
      break
    }
  }
  return frame
}

/** @param {string} messageType @param {string} contentJson */
function extractMessageText(messageType, contentJson) {
  try {
    const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(contentJson))
    if (messageType === 'text' && typeof parsed.text === 'string') {
      return parsed.text.replace(/@_user_\d+/g, '').trim()
    }
    if (messageType === 'post') {
      /** @type {string[]} */
      const lines = []
      if (typeof parsed.title === 'string' && parsed.title.trim()) lines.push(parsed.title.trim())
      const rows = Array.isArray(parsed.content) ? parsed.content : []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        /** @type {string[]} */
        const parts = []
        for (const node of row) {
          if (typeof node === 'object' && node !== null && typeof node.text === 'string') {
            parts.push(node.text)
          }
        }
        const line = parts.join('').replace(/@_user_\d+/g, '').trim()
        if (line) lines.push(line)
      }
      return lines.join('\n').trim()
    }
  } catch {
    // Ignore malformed content payloads.
  }
  return ''
}

/** @param {string} text @param {number} maxChars */
function splitChunks(text, maxChars) {
  if (text.length <= maxChars) return [text]
  /** @type {string[]} */
  const chunks = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars)
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.4) cut = maxChars
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

let running = false
let generation = 0
/** @type {string | null} */
let socketId = null
/** @type {number | null} */
let pingTimer = null
/** @type {number | null} */
let reconnectTimer = null
let pingIntervalMs = 120_000
let retryDelayMs = 2_000
let serviceId = 0
let seq = 1n
/** @type {{ value: string; expiresAt: number } | null} */
let cachedToken = null

async function readCredentials() {
  const domainRaw = String(await kettu.call('settings.get', 'domain')).trim()
  const domain = domainRaw === 'lark' ? 'lark' : 'feishu'
  const appId = String(await kettu.call('settings.get', 'appId')).trim()
  const secretRaw = await kettu.call('settings.secret', 'appSecret')
  const appSecret = typeof secretRaw === 'string' ? secretRaw.trim() : ''
  return { domain, origin: OPEN_ORIGIN[domain], appId, appSecret }
}

/** @param {'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'} state @param {string | null} [detail] */
async function reportStatus(state, detail = null) {
  try {
    await kettu.call('bots.channelStatus', { channel: 'feishu', state, detail })
  } catch (error) {
    console.warn(`Could not report Feishu status: ${errorMessage(error)}`)
  }
}

function clearTimers() {
  if (pingTimer !== null) {
    clearTimeout(pingTimer)
    pingTimer = null
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

async function closeSocket() {
  const id = socketId
  socketId = null
  if (!id) return
  await kettu.call('network.ws.close', { id, code: 1000 }).catch(() => {})
}

async function tenantAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value
  }
  const { origin, appId, appSecret } = await readCredentials()
  if (!appId || !appSecret) throw new Error('Missing Feishu App ID or App Secret')
  const res = await kettu.call('network.fetch', `${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    timeoutMs: 10_000,
  })
  /** @type {{ code?: number; msg?: string; tenant_access_token?: string; expire?: number }} */
  const json = JSON.parse(res.body)
  if (res.status < 200 || res.status >= 300 || json.code !== 0 || !json.tenant_access_token) {
    throw new Error(json.msg ?? `Feishu auth failed (HTTP ${res.status})`)
  }
  cachedToken = {
    value: json.tenant_access_token,
    expiresAt: Date.now() + (json.expire ?? 7200) * 1000,
  }
  return cachedToken.value
}

/** @param {number} gen */
function schedulePing(gen) {
  if (pingTimer !== null) clearTimeout(pingTimer)
  pingTimer = setTimeout(() => {
    pingTimer = null
    if (!running || gen !== generation || !socketId) return
    const frame = encodeFrame({
      seqId: seq++,
      logId: 0n,
      service: serviceId,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    })
    void kettu
      .call('network.ws.send', { id: socketId, data: base64Encode(frame), encoding: 'base64' })
      .catch(() => {})
    schedulePing(gen)
  }, pingIntervalMs)
}

/** @param {number} gen @param {string} detail */
function scheduleReconnect(gen, detail) {
  clearTimers()
  void reportStatus('reconnecting', detail)
  const delay = retryDelayMs
  retryDelayMs = Math.min(30_000, retryDelayMs * 2)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!running || gen !== generation) return
    void connect(gen)
  }, delay)
}

/** @param {number} gen */
async function connect(gen) {
  if (!running || gen !== generation) return
  await closeSocket()
  clearTimers()

  const { domain, origin, appId, appSecret } = await readCredentials()
  if (!appId || !appSecret) {
    running = false
    await reportStatus('error', 'Missing Feishu App ID or App Secret')
    return
  }

  await reportStatus('connecting', null)
  try {
    const res = await kettu.call('network.fetch', `${origin}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
      timeoutMs: 12_000,
    })
    /** @type {{ code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } }} */
    const json = JSON.parse(res.body)
    if (res.status < 200 || res.status >= 300 || json.code !== 0 || !json.data?.URL) {
      throw new Error(json.msg ?? `Feishu WS endpoint error (HTTP ${res.status})`)
    }
    if (!running || gen !== generation) return

    const wsUrl = json.data.URL
    serviceId = Number(queryParam(wsUrl, 'service_id') ?? '0') || 0
    pingIntervalMs = Math.max(15, json.data.ClientConfig?.PingInterval ?? 120) * 1000

    const opened = await kettu.call('network.ws.open', { url: wsUrl })
    if (!running || gen !== generation) {
      await kettu.call('network.ws.close', { id: opened.id, code: 1000 }).catch(() => {})
      return
    }
    socketId = opened.id
    void domain
  } catch (error) {
    if (!running || gen !== generation) return
    const msg = errorMessage(error)
    console.warn(`Feishu connect failed: ${msg}`)
    scheduleReconnect(gen, msg)
  }
}

/** @param {FeishuReceiveEvent} envelope */
async function handleReceiveEvent(envelope) {
  if (envelope.header?.event_type !== 'im.message.receive_v1') return
  const msg = envelope.event?.message
  const sender = envelope.event?.sender
  if (!msg?.chat_id || !msg.message_id || !msg.content || !sender?.sender_id?.open_id) return
  if (sender.sender_type === 'app' || sender.sender_type === 'bot') return

  const isDirect = msg.chat_type === 'p2p'
  const isGroup = msg.chat_type === 'group'
  if (!isDirect && !isGroup) return

  const text = extractMessageText(msg.message_type ?? 'text', msg.content)
  if (!text) return

  if (isGroup) {
    const hasMention = Array.isArray(msg.mentions) && msg.mentions.length > 0
    const isControl = /^\/(pair|status|stop)\b/i.test(text)
    if (!hasMention && !isControl) return
  }

  const eventId = envelope.header.event_id ?? msg.message_id
  const threadId = isDirect ? null : msg.root_id || msg.parent_id || msg.message_id

  await kettu.call('bots.inbound', {
    channel: 'feishu',
    dedupId: `feishu:${eventId}`,
    chatId: msg.chat_id,
    threadId,
    messageId: msg.message_id,
    senderId: sender.sender_id.open_id,
    senderLabel: sender.sender_id.open_id.slice(0, 12),
    isDirect,
    text,
  })
}

kettu.on('network.ws.open', async ({ id }) => {
  if (!running || id !== socketId) return
  const { domain } = await readCredentials()
  retryDelayMs = 2_000
  await reportStatus('connected', `${domain === 'lark' ? 'Lark' : 'Feishu'} WS`)
  schedulePing(generation)
})

kettu.on('network.ws.message', async ({ id, data, encoding }) => {
  if (!running || id !== socketId) return
  try {
    const bytes = encoding === 'base64' ? base64Decode(data) : utf8Encode(data)
    const frame = decodeFrame(bytes)
    if (frame.method === 0) return

    let frameType = ''
    for (const h of frame.headers) {
      if (h.key === 'type') {
        frameType = h.value
        break
      }
    }
    if (frame.method === 1 && frameType === 'event' && frame.payload) {
      const ackFrame = encodeFrame({
        ...frame,
        payload: utf8Encode(JSON.stringify({ code: 200 })),
      })
      await kettu
        .call('network.ws.send', { id, data: base64Encode(ackFrame), encoding: 'base64' })
        .catch(() => {})

      const parsed = /** @type {FeishuReceiveEvent} */ (JSON.parse(utf8Decode(frame.payload)))
      await handleReceiveEvent(parsed)
    }
  } catch (error) {
    console.warn(`Feishu frame decode failed: ${errorMessage(error)}`)
  }
})

kettu.on('network.ws.close', ({ id, reason }) => {
  if (id !== socketId) return
  socketId = null
  clearTimers()
  if (running) {
    scheduleReconnect(generation, reason || 'Connection closed')
  }
})

kettu.on('network.ws.error', ({ id, message }) => {
  if (id !== socketId) return
  console.warn(`Feishu WS error: ${message}`)
})

kettu.on('botChannel.start', async ({ channel }) => {
  if (channel !== 'feishu') return
  const gen = ++generation
  running = true
  retryDelayMs = 2_000
  cachedToken = null
  await connect(gen)
})

kettu.on('botChannel.stop', async ({ channel }) => {
  if (channel !== 'feishu') return
  generation++
  running = false
  clearTimers()
  await closeSocket()
  await reportStatus('off', null)
})

kettu.on('botChannel.test', async ({ channel }) => {
  if (channel !== 'feishu') return undefined
  const { domain, origin, appId, appSecret } = await readCredentials()
  if (!appId || !appSecret) return { ok: false, error: 'Missing Feishu App ID or App Secret.' }
  try {
    const res = await kettu.call('network.fetch', `${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: 10_000,
    })
    /** @type {{ code?: number; msg?: string; tenant_access_token?: string }} */
    const json = JSON.parse(res.body)
    if (res.status < 200 || res.status >= 300 || json.code !== 0 || !json.tenant_access_token) {
      return { ok: false, error: json.msg ?? `HTTP ${res.status}` }
    }
    return { ok: true, label: `${domain === 'lark' ? 'Lark' : 'Feishu'} · ${appId}` }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
})

kettu.on('botChannel.reply', async (event) => {
  if (event.channel !== 'feishu') return
  const token = await tenantAccessToken()
  const { origin } = await readCredentials()
  const chunks = splitChunks(event.payload.body, MAX_CARD_CHARS)

  for (let i = 0; i < chunks.length; i++) {
    const template =
      event.payload.status === 'failed'
        ? 'red'
        : event.payload.status === 'waiting_user'
          ? 'orange'
          : event.payload.status === 'done'
            ? 'green'
            : 'blue'
    /** @type {Record<string, unknown>} */
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        elements: [
          { tag: 'markdown', content: chunks[i] },
          ...(i === chunks.length - 1 && event.payload.meta
            ? [{ tag: 'markdown', content: `*${event.payload.meta}*` }]
            : []),
        ],
      },
    }
    if (i === 0 && event.payload.title) {
      card.header = {
        title: { tag: 'plain_text', content: event.payload.title.slice(0, 120) },
        template,
      }
    }

    const useReplyApi = i === 0 && typeof event.messageId === 'string' && event.messageId.length > 0
    const url = useReplyApi
      ? `${origin}/open-apis/im/v1/messages/${encodeURIComponent(/** @type {string} */ (event.messageId))}/reply`
      : `${origin}/open-apis/im/v1/messages?receive_id_type=chat_id`
    const cardBody = useReplyApi
      ? { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: Boolean(event.threadId) }
      : { receive_id: event.chatId, msg_type: 'interactive', content: JSON.stringify(card) }

    const res = await kettu.call('network.fetch', url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(cardBody),
      timeoutMs: 15_000,
    })
    if (res.status >= 200 && res.status < 300) {
      try {
        const parsed = /** @type {{ code?: number }} */ (JSON.parse(res.body))
        if (parsed.code === 0) continue
      } catch {
        // Fall through to text fallback.
      }
    }

    const fallbackText = `${event.payload.title ? `${event.payload.title}\n` : ''}${chunks[i]}${event.payload.meta ? `\n${event.payload.meta}` : ''}`
    const textBody = useReplyApi
      ? { msg_type: 'text', content: JSON.stringify({ text: fallbackText }) }
      : { receive_id: event.chatId, msg_type: 'text', content: JSON.stringify({ text: fallbackText }) }
    const fallback = await kettu.call('network.fetch', url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(textBody),
      timeoutMs: 15_000,
    })
    if (fallback.status < 200 || fallback.status >= 300) {
      throw new Error(`Feishu reply failed with HTTP ${fallback.status}`)
    }
  }
})

kettu.on('settings.changed', async ({ key }) => {
  if (key === 'domain' || key === 'appId' || key === 'appSecret') {
    cachedToken = null
    if (running) {
      const gen = ++generation
      await connect(gen)
    }
  }
})
