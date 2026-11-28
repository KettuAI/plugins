// @ts-check

/**
 * @typedef {{
 *   type: 'delivery'
 *   deliveryId: string
 *   channel: 'github'
 *   botId: string
 *   handle: string
 *   repo: string
 *   eventKind: string
 *   number: number
 *   commentId: number | null
 *   authorId: string
 *   authorLogin: string
 *   text: string
 *   url: string
 * }} ConnectorDelivery
 */

const TEXT = {
  en: {
    signIn: 'Sign in to your Kettu account in Settings > Account to connect GitHub.',
    linked: 'Linked GitHub account:',
    unlinked: 'No GitHub account linked yet.',
    installs: 'GitHub App installations:',
    refresh: 'Test connection',
    ok: 'GitHub Connector reachable.',
  },
  'zh-CN': {
    signIn: '请先在「设置 > 账号」登录 Kettu 账号以连接 GitHub。',
    linked: '已绑定 GitHub 账号：',
    unlinked: '尚未绑定 GitHub 账号。',
    installs: '已安装的 GitHub App 数量：',
    refresh: '测试连接',
    ok: 'GitHub Connector 连接正常。',
  },
}

let running = false
let generation = 0
/** @type {string | null} */
let socketId = null
let connected = false
let retryDelayMs = 2_000
/** @type {number | null} */
let pingTimer = null
/** @type {number | null} */
let reconnectTimer = null
/** @type {string} */
let currentHostId = ''

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} url */
function trimSlash(url) {
  return url.replace(/\/+$/, '')
}

async function resolveSession() {
  const session = await kettu.call('connector.session')
  const custom = String(await kettu.call('settings.get', 'connectorUrl')).trim()
  const baseUrl = trimSlash(custom || session.connectorUrl || 'https://connectors.kettu.sh')
  return { ...session, baseUrl }
}

/** @param {'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'} state @param {string | null} [detail] */
async function reportStatus(state, detail = null) {
  try {
    await kettu.call('bots.channelStatus', { channel: 'github', state, detail })
  } catch (error) {
    console.warn(`Could not report GitHub status: ${errorMessage(error)}`)
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
  connected = false
  if (!id) return
  await kettu.call('network.ws.close', { id, code: 1000 }).catch(() => {})
}

/** @param {number} gen */
function schedulePing(gen) {
  if (pingTimer !== null) clearTimeout(pingTimer)
  pingTimer = setTimeout(() => {
    pingTimer = null
    if (!running || gen !== generation || !socketId || !connected) return
    void kettu
      .call('network.ws.send', { id: socketId, data: JSON.stringify({ type: 'ping' }) })
      .catch(() => {})
    schedulePing(gen)
  }, 30_000)
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

async function sendHello() {
  if (!socketId || !connected) return
  const listed = await kettu.call('bots.list', { channel: 'github' })
  const bots = listed.bots.map((bot) => ({
    botId: bot.id,
    handle: bot.handle,
    name: bot.name,
    repos: bot.scope,
    defaultRepos: bot.isDefault ? bot.scope : [],
  }))
  await kettu.call('network.ws.send', {
    id: socketId,
    data: JSON.stringify({ type: 'hello', hostId: currentHostId, bots }),
  })
}

/** @param {number} gen */
async function connect(gen) {
  if (!running || gen !== generation) return
  await closeSocket()
  clearTimers()

  const session = await resolveSession()
  if (!session.signedIn || !session.accessToken) {
    await reportStatus('error', 'Sign in to Kettu account to connect GitHub')
    return
  }
  currentHostId = session.hostId
  await reportStatus('connecting', null)

  try {
    const wsBase = session.baseUrl.replace(/^http/i, 'ws')
    const url = `${wsBase}/v1/host?hostId=${encodeURIComponent(session.hostId)}`
    const opened = await kettu.call('network.ws.open', {
      url,
      headers: { authorization: `Bearer ${session.accessToken}` },
    })
    if (!running || gen !== generation) {
      await kettu.call('network.ws.close', { id: opened.id, code: 1000 }).catch(() => {})
      return
    }
    socketId = opened.id
  } catch (error) {
    if (!running || gen !== generation) return
    const msg = errorMessage(error)
    console.warn(`GitHub connector connect failed: ${msg}`)
    scheduleReconnect(gen, msg)
  }
}

async function fetchConnectorState() {
  const session = await resolveSession()
  if (!session.signedIn || !session.accessToken) {
    return { ok: false, signedIn: false, baseUrl: session.baseUrl, error: 'Sign in to your Kettu account first.' }
  }
  const res = await kettu.call('network.fetch', `${session.baseUrl}/v1/github/state`, {
    method: 'GET',
    headers: { authorization: `Bearer ${session.accessToken}` },
    timeoutMs: 10_000,
  })
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, signedIn: true, baseUrl: session.baseUrl, error: `Connector returned HTTP ${res.status}` }
  }
  /** @type {{ account?: { login?: string } | null; installations?: unknown[] }} */
  const data = JSON.parse(res.body)
  return {
    ok: true,
    signedIn: true,
    baseUrl: session.baseUrl,
    login: data.account?.login ?? null,
    installations: Array.isArray(data.installations) ? data.installations.length : 0,
  }
}

kettu.on('network.ws.open', async ({ id }) => {
  if (!running || id !== socketId) return
  connected = true
  retryDelayMs = 2_000
  await sendHello().catch((error) => console.warn(`GitHub hello failed: ${errorMessage(error)}`))
  await reportStatus('connected', 'Cloud WS')
  schedulePing(generation)
})

kettu.on('network.ws.message', async ({ id, data }) => {
  if (!running || id !== socketId) return
  /** @type {{ type?: string } & Partial<ConnectorDelivery>} */
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (parsed.type !== 'delivery' || !parsed.deliveryId || !parsed.repo) return
  const delivery = /** @type {ConnectorDelivery} */ (parsed)
  try {
    const result = await kettu.call('bots.inbound', {
      channel: 'github',
      dedupId: `github:${delivery.deliveryId}`,
      chatId: delivery.repo,
      threadId: `${delivery.repo}#${delivery.number}`,
      messageId: delivery.commentId !== null && delivery.commentId !== undefined ? String(delivery.commentId) : null,
      senderId: delivery.authorId,
      senderLabel: `@${delivery.authorLogin} · ${delivery.repo}#${delivery.number}`,
      isDirect: false,
      text: delivery.text,
      botHandle: delivery.handle || null,
      externalUrl: delivery.url,
      deliveryId: delivery.deliveryId,
      scope: delivery.repo,
    })
    if (socketId === id && connected) {
      await kettu
        .call('network.ws.send', {
          id,
          data: JSON.stringify({
            type: 'ack',
            deliveryId: delivery.deliveryId,
            status: result.accepted ? 'accepted' : 'rejected',
            ...(result.reason ? { reason: result.reason } : {}),
          }),
        })
        .catch(() => {})
    }
  } catch (error) {
    if (socketId === id && connected) {
      await kettu
        .call('network.ws.send', {
          id,
          data: JSON.stringify({
            type: 'ack',
            deliveryId: delivery.deliveryId,
            status: 'rejected',
            reason: errorMessage(error),
          }),
        })
        .catch(() => {})
    }
  }
})

kettu.on('network.ws.close', ({ id, reason }) => {
  if (id !== socketId) return
  socketId = null
  connected = false
  clearTimers()
  if (running) {
    scheduleReconnect(generation, reason || 'Connector socket closed')
  }
})

kettu.on('network.ws.error', ({ id, message }) => {
  if (id !== socketId) return
  console.warn(`GitHub connector WS error: ${message}`)
})

kettu.on('botChannel.start', async ({ channel }) => {
  if (channel !== 'github') return
  const gen = ++generation
  running = true
  retryDelayMs = 2_000
  await connect(gen)
})

kettu.on('botChannel.stop', async ({ channel }) => {
  if (channel !== 'github') return
  generation++
  running = false
  clearTimers()
  await closeSocket()
  await reportStatus('off', null)
})

kettu.on('botChannel.test', async ({ channel }) => {
  if (channel !== 'github') return undefined
  try {
    const state = await fetchConnectorState()
    if (!state.ok) return { ok: false, error: state.error ?? 'Connection failed' }
    const label = state.login ? `@${state.login}` : state.baseUrl
    return { ok: true, label }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
})

kettu.on('botChannel.reply', async (event) => {
  if (event.channel !== 'github') return
  if (event.replyMode === 'kettu_only') return
  if (!event.deliveryId || !socketId || !connected) return
  const header = event.payload.title ? `**${event.payload.title}**\n\n` : ''
  const footer = event.payload.meta ? `\n\n_${event.payload.meta}_` : ''
  const body = `${header}${event.payload.body}${footer}`.trim()
  if (!body) return
  await kettu.call('network.ws.send', {
    id: socketId,
    data: JSON.stringify({
      type: 'reply',
      deliveryId: event.deliveryId,
      body,
    }),
  })
})

kettu.on('view.data', async ({ locale }) => {
  const words = locale === 'zh-CN' ? TEXT['zh-CN'] : TEXT.en
  try {
    const state = await fetchConnectorState()
    if (!state.signedIn) {
      return { text: words.signIn, actions: [] }
    }
    if (!state.ok) {
      return {
        text: `${state.baseUrl}\n${state.error ?? ''}`,
        actions: [{ id: 'test', label: words.refresh, icon: 'reload', primary: true }],
      }
    }
    const accountLine = state.login ? `${words.linked} @${state.login}` : words.unlinked
    return {
      text: `${accountLine}\n${words.installs} ${state.installations}\n${state.baseUrl}`,
      actions: [{ id: 'test', label: words.refresh, icon: 'reload', primary: true }],
    }
  } catch (error) {
    return {
      text: errorMessage(error),
      actions: [{ id: 'test', label: words.refresh, icon: 'reload', primary: true }],
    }
  }
})

kettu.on('view.action', async ({ action, locale }) => {
  if (action !== 'test') return { error: `Unknown action ${action}` }
  const words = locale === 'zh-CN' ? TEXT['zh-CN'] : TEXT.en
  try {
    const state = await fetchConnectorState()
    if (!state.ok) return { error: state.error ?? 'Connection failed' }
    return { notice: state.login ? `${words.ok} (@${state.login})` : words.ok }
  } catch (error) {
    return { error: errorMessage(error) }
  }
})

kettu.on('settings.changed', async ({ key }) => {
  if (key === 'connectorUrl' && running) {
    const gen = ++generation
    await connect(gen)
  }
})
