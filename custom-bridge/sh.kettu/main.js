// @ts-check

/**
 * Reference Bot channel plugin using `network.custom` to talk to any self-hosted HTTP or
 * WebSocket bridge.
 *
 * @typedef {{
 *   id: string
 *   chatId: string
 *   threadId?: string | null
 *   messageId?: string | null
 *   senderId: string
 *   senderLabel?: string
 *   isDirect?: boolean
 *   text: string
 *   botHandle?: string | null
 *   externalUrl?: string | null
 *   deliveryId?: string | null
 *   scope?: string | null
 * }} BridgeInbound
 */

let running = false
let generation = 0
/** @type {string | null} */
let socketId = null
let connected = false
let retryDelayMs = 2_000
/** @type {number | null} */
let timerId = null
let pollCursor = ''

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} raw */
function normalizeBase(raw) {
  return raw.trim().replace(/\/+$/, '')
}

async function readConfig() {
  const endpoint = normalizeBase(String(await kettu.call('settings.get', 'endpoint')))
  const modeRaw = String(await kettu.call('settings.get', 'mode')).trim()
  const mode = modeRaw === 'poll' ? 'poll' : 'ws'
  const tokenRaw = await kettu.call('settings.secret', 'token')
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : ''
  return { endpoint, mode, token }
}

/** @param {string} token @param {boolean} [json] */
function authHeaders(token, json = false) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (json) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/** @param {'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'} state @param {string | null} [detail] */
async function reportStatus(state, detail = null) {
  try {
    await kettu.call('bots.channelStatus', { channel: 'custom', state, detail })
  } catch (error) {
    console.warn(`Could not report Custom Bridge status: ${errorMessage(error)}`)
  }
}

function clearTimer() {
  if (timerId !== null) {
    clearTimeout(timerId)
    timerId = null
  }
}

async function closeSocket() {
  const id = socketId
  socketId = null
  connected = false
  if (!id) return
  await kettu.call('network.ws.close', { id, code: 1000 }).catch(() => {})
}

/** @param {BridgeInbound} msg */
async function deliverInbound(msg) {
  if (!msg || !msg.id || !msg.chatId || !msg.senderId || typeof msg.text !== 'string') return
  await kettu.call('bots.inbound', {
    channel: 'custom',
    dedupId: `custom:${msg.id}`,
    chatId: String(msg.chatId),
    threadId: msg.threadId ?? null,
    messageId: msg.messageId ?? null,
    senderId: String(msg.senderId),
    senderLabel: msg.senderLabel || String(msg.senderId),
    isDirect: msg.isDirect !== false,
    text: msg.text,
    botHandle: msg.botHandle ?? null,
    externalUrl: msg.externalUrl ?? null,
    deliveryId: msg.deliveryId ?? null,
    scope: msg.scope ?? null,
  })
}

/** @param {number} gen */
async function connectWs(gen) {
  const { endpoint, token } = await readConfig()
  if (!endpoint) {
    running = false
    await reportStatus('error', 'Missing bridge endpoint URL')
    return
  }
  await reportStatus('connecting', null)
  try {
    const wsUrl = `${endpoint.replace(/^http/i, 'ws')}/ws`
    const opened = await kettu.call('network.ws.open', {
      url: wsUrl,
      headers: authHeaders(token),
    })
    if (!running || gen !== generation) {
      await kettu.call('network.ws.close', { id: opened.id, code: 1000 }).catch(() => {})
      return
    }
    socketId = opened.id
  } catch (error) {
    if (!running || gen !== generation) return
    const msg = errorMessage(error)
    await reportStatus('reconnecting', msg)
    const delay = retryDelayMs
    retryDelayMs = Math.min(30_000, retryDelayMs * 2)
    timerId = setTimeout(() => {
      timerId = null
      if (running && gen === generation) void connectWs(gen)
    }, delay)
  }
}

/** @param {number} gen */
async function pollOnce(gen) {
  if (!running || gen !== generation) return
  const { endpoint, token } = await readConfig()
  if (!endpoint) {
    running = false
    await reportStatus('error', 'Missing bridge endpoint URL')
    return
  }
  try {
    const url = pollCursor
      ? `${endpoint}/poll?cursor=${encodeURIComponent(pollCursor)}`
      : `${endpoint}/poll`
    const res = await kettu.call('network.fetch', url, {
      method: 'GET',
      headers: authHeaders(token),
      timeoutMs: 25_000,
    })
    if (!running || gen !== generation) return
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)

    if (retryDelayMs > 2_000 || !connected) {
      retryDelayMs = 2_000
      connected = true
      await reportStatus('connected', endpoint)
    }
    /** @type {{ cursor?: string; messages?: BridgeInbound[] }} */
    const body = res.body ? JSON.parse(res.body) : {}
    if (typeof body.cursor === 'string' && body.cursor !== pollCursor) {
      pollCursor = body.cursor
      await kettu.call('storage.set', 'cursor', pollCursor).catch(() => {})
    }
    if (Array.isArray(body.messages)) {
      for (const item of body.messages) {
        await deliverInbound(item)
      }
    }
    if (running && gen === generation) {
      timerId = setTimeout(() => {
        timerId = null
        void pollOnce(gen)
      }, 200)
    }
  } catch (error) {
    if (!running || gen !== generation) return
    connected = false
    await reportStatus('reconnecting', errorMessage(error))
    const delay = retryDelayMs
    retryDelayMs = Math.min(30_000, retryDelayMs * 2)
    timerId = setTimeout(() => {
      timerId = null
      void pollOnce(gen)
    }, delay)
  }
}

async function startChannel() {
  const gen = ++generation
  running = true
  retryDelayMs = 2_000
  clearTimer()
  await closeSocket()

  const { endpoint, mode } = await readConfig()
  if (!endpoint) {
    running = false
    await reportStatus('error', 'Missing bridge endpoint URL')
    return
  }
  if (mode === 'poll') {
    const saved = await kettu.call('storage.get', 'cursor').catch(() => null)
    if (typeof saved === 'string') pollCursor = saved
    await reportStatus('connecting', null)
    void pollOnce(gen)
  } else {
    await connectWs(gen)
  }
}

kettu.on('network.ws.open', async ({ id }) => {
  if (!running || id !== socketId) return
  const { endpoint } = await readConfig()
  connected = true
  retryDelayMs = 2_000
  await reportStatus('connected', endpoint)
})

kettu.on('network.ws.message', async ({ id, data }) => {
  if (!running || id !== socketId) return
  try {
    const parsed = /** @type {{ type?: string } & Partial<BridgeInbound>} */ (JSON.parse(data))
    if (parsed.type === 'inbound') {
      await deliverInbound(/** @type {BridgeInbound} */ (parsed))
    }
  } catch (error) {
    console.warn(`Custom Bridge message ignored: ${errorMessage(error)}`)
  }
})

kettu.on('network.ws.close', ({ id, reason }) => {
  if (id !== socketId) return
  socketId = null
  connected = false
  if (!running) return
  void reportStatus('reconnecting', reason || 'Connection closed')
  const gen = generation
  const delay = retryDelayMs
  retryDelayMs = Math.min(30_000, retryDelayMs * 2)
  timerId = setTimeout(() => {
    timerId = null
    if (running && gen === generation) void connectWs(gen)
  }, delay)
})

kettu.on('botChannel.start', async ({ channel }) => {
  if (channel !== 'custom') return
  await startChannel()
})

kettu.on('botChannel.stop', async ({ channel }) => {
  if (channel !== 'custom') return
  generation++
  running = false
  clearTimer()
  await closeSocket()
  await reportStatus('off', null)
})

kettu.on('botChannel.test', async ({ channel }) => {
  if (channel !== 'custom') return undefined
  const { endpoint, token } = await readConfig()
  if (!endpoint) return { ok: false, error: 'Missing bridge endpoint URL.' }
  try {
    const res = await kettu.call('network.fetch', `${endpoint}/health`, {
      method: 'GET',
      headers: authHeaders(token),
      timeoutMs: 10_000,
    })
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Bridge /health returned HTTP ${res.status}` }
    }
    return { ok: true, label: endpoint }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
})

kettu.on('botChannel.reply', async (event) => {
  if (event.channel !== 'custom') return
  const replyPayload = {
    type: 'reply',
    botId: event.botId,
    botName: event.botName,
    botHandle: event.botHandle,
    chatId: event.chatId,
    threadId: event.threadId,
    messageId: event.messageId,
    deliveryId: event.deliveryId,
    replyMode: event.replyMode,
    ...event.payload,
  }
  if (socketId && connected) {
    await kettu.call('network.ws.send', { id: socketId, data: JSON.stringify(replyPayload) })
    return
  }
  const { endpoint, token } = await readConfig()
  if (!endpoint) return
  const res = await kettu.call('network.fetch', `${endpoint}/reply`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(replyPayload),
    timeoutMs: 15_000,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Bridge /reply failed with HTTP ${res.status}`)
  }
})

kettu.on('settings.changed', async () => {
  if (running) await startChannel()
})
