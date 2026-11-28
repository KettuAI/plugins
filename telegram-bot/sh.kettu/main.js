// @ts-check

const TELEGRAM_API = 'https://api.telegram.org'
const POLL_TIMEOUT_SEC = 20
const POLL_FETCH_TIMEOUT_MS = 25_000
const TELEGRAM_MAX_CHARS = 3900

/**
 * @typedef {{
 *   id: number
 *   is_bot?: boolean
 *   username?: string
 *   first_name?: string
 *   last_name?: string
 * }} TelegramUser
 * @typedef {{
 *   id: number
 *   type: 'private' | 'group' | 'supergroup' | 'channel'
 *   title?: string
 * }} TelegramChat
 * @typedef {{
 *   message_id: number
 *   message_thread_id?: number
 *   from?: TelegramUser
 *   chat: TelegramChat
 *   text?: string
 *   caption?: string
 *   reply_to_message?: { message_id: number; from?: TelegramUser }
 * }} TelegramMessage
 * @typedef {{ update_id: number; message?: TelegramMessage }} TelegramUpdate
 */

let running = false
let generation = 0
let offset = 0
/** @type {string | null} */
let botUsername = null
let retryDelayMs = 2_000
/** @type {number | null} */
let timerId = null

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readToken() {
  const raw = await kettu.call('settings.secret', 'botToken')
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * @param {string} token
 * @param {string} method
 * @param {Record<string, unknown> | null} body
 * @param {number} [timeoutMs]
 */
async function tgRequest(token, method, body, timeoutMs) {
  const url = `${TELEGRAM_API}/bot${token}/${method}`
  const response = await kettu.call('network.fetch', url, {
    method: body === null ? 'GET' : 'POST',
    headers: body === null ? undefined : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
    timeoutMs: timeoutMs ?? 15_000,
  })
  /** @type {{ ok?: boolean; result?: unknown; description?: string }} */
  let parsed = {}
  try {
    parsed = JSON.parse(response.body)
  } catch {
    // Non-JSON response falls through to status check.
  }
  if (response.status < 200 || response.status >= 300 || parsed.ok !== true) {
    throw new Error(parsed.description ?? `Telegram HTTP ${response.status}`)
  }
  return parsed.result
}

/** @param {string} token */
async function probeMe(token) {
  const result = /** @type {TelegramUser | undefined} */ (await tgRequest(token, 'getMe', null, 10_000))
  if (!result || !result.username) throw new Error('Telegram getMe did not return a bot username')
  return result.username
}

/** @param {'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'} state @param {string | null} [detail] */
async function reportStatus(state, detail = null) {
  try {
    await kettu.call('bots.channelStatus', { channel: 'telegram', state, detail })
  } catch (error) {
    console.warn(`Could not report Telegram status: ${errorMessage(error)}`)
  }
}

function clearTimer() {
  if (timerId !== null) {
    clearTimeout(timerId)
    timerId = null
  }
}

/** @param {number} gen @param {number} delayMs */
function schedulePoll(gen, delayMs) {
  clearTimer()
  timerId = setTimeout(() => {
    timerId = null
    void pollOnce(gen)
  }, delayMs)
}

/** @param {string} token @param {TelegramMessage} msg */
async function handleMessage(token, msg) {
  if (!msg.from || msg.from.is_bot) return
  const rawText = (msg.text ?? msg.caption ?? '').trim()
  if (!rawText) return

  const isDirect = msg.chat.type === 'private'
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  if (!isDirect && !isGroup) return

  let cleanedText = rawText
  if (isGroup) {
    const mentionRe = botUsername ? new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'i') : null
    const repliedToBot =
      botUsername !== null &&
      typeof msg.reply_to_message?.from?.username === 'string' &&
      msg.reply_to_message.from.username.toLowerCase() === botUsername.toLowerCase()
    const isControlCmd = /^\/(pair|status|stop)(?:@[a-z0-9_]+)?\b/i.test(rawText)
    if (!isControlCmd && !repliedToBot && !(mentionRe && mentionRe.test(rawText))) {
      return
    }
    if (mentionRe) cleanedText = rawText.replace(mentionRe, '').trim()
    if (!cleanedText) return
  }

  const fullName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').trim()
  const baseSender = fullName || (msg.from.username ? `@${msg.from.username}` : String(msg.from.id))
  const senderLabel = isGroup && msg.chat.title ? `${baseSender} · ${msg.chat.title}` : baseSender

  const threadId = isDirect
    ? null
    : msg.message_thread_id !== undefined
      ? String(msg.message_thread_id)
      : msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : String(msg.message_id)

  // Fire-and-forget typing indicator before routing to Kettu.
  void tgRequest(token, 'sendChatAction', { chat_id: String(msg.chat.id), action: 'typing' }, 8_000).catch(
    () => {},
  )

  await kettu.call('bots.inbound', {
    channel: 'telegram',
    dedupId: `telegram:${msg.chat.id}:${msg.message_id}`,
    chatId: String(msg.chat.id),
    threadId,
    messageId: String(msg.message_id),
    senderId: String(msg.from.id),
    senderLabel,
    isDirect,
    text: cleanedText,
  })
}

/** @param {number} gen */
async function pollOnce(gen) {
  if (!running || gen !== generation) return
  const token = await readToken()
  if (!token) {
    running = false
    await reportStatus('error', 'Missing Telegram bot token')
    return
  }
  try {
    const query =
      `timeout=${POLL_TIMEOUT_SEC}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}` +
      (offset > 0 ? `&offset=${offset}` : '')
    const updates = /** @type {TelegramUpdate[]} */ (
      await tgRequest(token, `getUpdates?${query}`, null, POLL_FETCH_TIMEOUT_MS)
    )
    if (!running || gen !== generation) return

    if (retryDelayMs > 2_000) {
      retryDelayMs = 2_000
      await reportStatus('connected', botUsername ? `@${botUsername}` : null)
    }

    if (Array.isArray(updates)) {
      let advanced = false
      for (const update of updates) {
        if (typeof update.update_id === 'number' && update.update_id + 1 > offset) {
          offset = update.update_id + 1
          advanced = true
        }
        if (update.message) {
          await handleMessage(token, update.message)
        }
      }
      if (advanced) {
        await kettu.call('storage.set', 'offset', offset).catch(() => {})
      }
    }

    if (running && gen === generation) {
      schedulePoll(gen, 50)
    }
  } catch (error) {
    if (!running || gen !== generation) return
    const msg = errorMessage(error)
    console.warn(`Telegram poll error: ${msg}`)
    await reportStatus('reconnecting', msg)
    const delay = retryDelayMs
    retryDelayMs = Math.min(30_000, retryDelayMs * 2)
    schedulePoll(gen, delay)
  }
}

async function startChannel() {
  const gen = ++generation
  running = true
  retryDelayMs = 2_000
  clearTimer()

  const token = await readToken()
  if (!token) {
    running = false
    await reportStatus('error', 'Missing Telegram bot token')
    return
  }

  await reportStatus('connecting', null)
  const storedOffset = await kettu.call('storage.get', 'offset').catch(() => null)
  if (typeof storedOffset === 'number' && Number.isFinite(storedOffset) && storedOffset > offset) {
    offset = storedOffset
  }

  try {
    const username = await probeMe(token)
    if (!running || gen !== generation) return
    botUsername = username
    await reportStatus('connected', `@${username}`)
    schedulePoll(gen, 20)
  } catch (error) {
    if (!running || gen !== generation) return
    running = false
    await reportStatus('error', errorMessage(error))
  }
}

async function stopChannel() {
  generation++
  running = false
  clearTimer()
  await reportStatus('off', null)
}

kettu.on('botChannel.start', async ({ channel }) => {
  if (channel !== 'telegram') return
  await startChannel()
})

kettu.on('botChannel.stop', async ({ channel }) => {
  if (channel !== 'telegram') return
  await stopChannel()
})

kettu.on('botChannel.test', async ({ channel }) => {
  if (channel !== 'telegram') return undefined
  const token = await readToken()
  if (!token) return { ok: false, error: 'Missing Telegram bot token.' }
  try {
    const username = await probeMe(token)
    botUsername = username
    return { ok: true, label: `@${username}` }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
})

kettu.on('botChannel.reply', async (event) => {
  if (event.channel !== 'telegram') return
  const token = await readToken()
  if (!token) return

  const header = event.payload.title ? `${event.payload.title}\n` : ''
  const footer = event.payload.meta ? `\n\n${event.payload.meta}` : ''
  const full = `${header}${event.payload.body}${footer}`.trim()
  if (!full) return

  const chunks = splitChunks(full, TELEGRAM_MAX_CHARS)
  const replyTo = event.messageId && /^\d+$/.test(event.messageId) ? Number(event.messageId) : undefined
  const threadId = event.threadId && /^\d+$/.test(event.threadId) ? Number(event.threadId) : undefined

  for (let i = 0; i < chunks.length; i++) {
    /** @type {Record<string, unknown>} */
    const body = {
      chat_id: event.chatId,
      text: chunks[i],
      disable_web_page_preview: true,
    }
    if (i === 0 && replyTo !== undefined && Number.isFinite(replyTo)) {
      body.reply_to_message_id = replyTo
    }
    if (threadId !== undefined && Number.isFinite(threadId)) {
      body.message_thread_id = threadId
    }
    await tgRequest(token, 'sendMessage', body, 15_000)
  }
})

kettu.on('settings.changed', async ({ key }) => {
  if (key === 'botToken' && running) {
    await startChannel()
  }
})
