// Runs a plugin's script the way the plugin host does, against a fake `kettu`. Only the script
// sees the fake: a new context holds the language's own builtins and nothing from Node or the web,
// like the host's engine, and a value crosses the boundary as JSON text.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(import.meta.dirname, '..')

const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const macrotask = () => new Promise((resolve) => setImmediate(resolve))

function covers(domain, host) {
  if (!domain.startsWith('*.')) return host === domain
  return host.endsWith(domain.slice(1)) && host.length > domain.length - 1
}

/**
 * Loads `<root>/<name>/<script>` as the manifest names it.
 *
 * options.settings and options.secrets are the user's values by key, options.fetch answers
 * `network.fetch` with `{ status, headers?, body }` (an object body is sent as JSON), and
 * options.answer answers `requests.answer`.
 */
export function loadPlugin(name, options = {}) {
  const dir = path.join(ROOT, name)
  const manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
  const entry = manifest.extensions['sh.kettu']
  const source = readFileSync(path.join(dir, entry.script), 'utf8')
  const permissions = entry.permissions ?? []
  const domains = permissions.filter((p) => p.startsWith('network:')).map((p) => p.slice(8))
  const declared = new Map((entry.settings ?? []).map((setting) => [setting.key, setting]))

  const settings = { ...options.settings }
  const secrets = { ...options.secrets }
  const storage = new Map()
  const listeners = new Map()
  const requests = []
  const answers = []
  const logs = []
  const clock = { now: options.now ?? Date.UTC(2026, 10, 24, 12, 0, 0), timers: [], next: 1 }

  const need = (permission) => {
    if (!permissions.includes(permission)) throw new Error(`This call needs the permission "${permission}"`)
  }

  const calls = {
    'api.version': () => 1,
    'app.locale': () => options.locale ?? 'en',
    'app.colorMode': () => 'light',
    'settings.get': (key) => {
      const setting = declared.get(key)
      if (!setting || setting.type === 'secret') throw new Error(`No setting "${key}"`)
      if (key in settings) return settings[key]
      return setting.default ?? (setting.type === 'boolean' ? false : setting.options?.[0]?.value ?? '')
    },
    'settings.secret': (key) => {
      if (declared.get(key)?.type !== 'secret') throw new Error(`No secret "${key}"`)
      return secrets[key] ?? null
    },
    'storage.get': (key) => (storage.has(key) ? json(storage.get(key)) : null),
    'storage.set': (key, value) => (storage.set(key, json(value ?? null)), null),
    'storage.delete': (key) => (storage.delete(key), null),
    'storage.keys': () => [...storage.keys()].sort(),
    'network.fetch': async (target, init = {}) => {
      if (!target.startsWith('https://')) throw new Error('Only https addresses can be reached')
      const url = new URL(target)
      if (url.port !== '' || url.username !== '') throw new Error('Only the default https port can be reached')
      if (!domains.some((domain) => covers(domain, url.hostname))) {
        throw new Error(`${url.hostname} is not among the domains this plugin may reach (${domains.join(', ')})`)
      }
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      )
      let body = init.body
      try {
        body = body === undefined ? undefined : JSON.parse(body)
      } catch {
        // A form or text body stays as sent.
      }
      const sent = { url: target, method: init.method ?? 'GET', headers, body, raw: init.body }
      requests.push(sent)
      const reply = await options.fetch?.(sent)
      if (!reply) throw new Error(`No fake answer for ${sent.method} ${target}`)
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
      return json({ status: reply.status ?? 200, headers: reply.headers ?? {}, body: text })
    },
    'random.bytes': (length) => {
      if (!Number.isInteger(length) || length < 1 || length > 256) {
        throw new Error('random.bytes takes 1 to 256 bytes')
      }
      return randomBytes(length).toString('hex')
    },
    'requests.answer': async (input) => {
      need('requests.answer')
      answers.push(json(input))
      await options.answer?.(input)
      return { request: input.request, decision: input.decision }
    },
  }

  const sandbox = vm.createContext({})
  const kettu = {
    call: async (call, ...args) => {
      if (!Object.hasOwn(calls, call)) throw new Error(`The plugin API has no call "${call}"`)
      return json(await calls[call](...json(args)))
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event).delete(listener)
    },
  }
  const timers = {
    setTimeout(callback, ms = 0) {
      const id = clock.next++
      clock.timers.push({ id, at: clock.now + Math.max(1, Number(ms) || 0), callback })
      return id
    },
    clearTimeout(id) {
      clock.timers = clock.timers.filter((timer) => timer.id !== id)
    },
  }
  const log = (level) => (...args) => logs.push({ level, text: args.map(String).join(' ') })
  const module = { exports: {} }
  Object.assign(sandbox, {
    kettu,
    module,
    exports: module.exports,
    console: Object.freeze({ log: log('info'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }),
    ...timers,
  })
  vm.runInContext('delete globalThis.Intl; delete globalThis.WebAssembly', sandbox)
  vm.runInContext('(function (now) { Date.now = now })', sandbox)(() => clock.now)
  vm.runInContext(source, sandbox, { filename: `${name}/${entry.script}` })

  const plugin = {
    manifest,
    entry,
    exports: module.exports,
    requests,
    answers,
    logs,
    storage,
    clock,
    setSetting: (key, value) => void (settings[key] = value),
    setSecret: (key, value) => void (secrets[key] = value),
    /** The listeners' answers for an event, in the order they were added. */
    async emit(event, payload) {
      const out = []
      for (const listener of [...(listeners.get(event) ?? [])]) {
        out.push(json(await listener(json(payload))))
      }
      return out
    },
    /** The first listener's answer, as a hook is answered. */
    async hook(event, payload) {
      const answers = await plugin.emit(event, payload)
      return answers.find((answer) => answer !== null && answer !== undefined)
    },
    /** What a tool the script exports answers with. */
    async tool(toolName, args) {
      const declaredTool = entry.tools?.find((tool) => tool.name === toolName)
      if (!declaredTool) throw new Error(`The manifest declares no tool "${toolName}"`)
      return json(await module.exports[toolName](json(args)))
    },
    /** Moves the clock on, running the timers that fall due and the work they start. */
    async advance(ms) {
      const target = clock.now + ms
      for (;;) {
        await macrotask()
        const due = clock.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        clock.timers = clock.timers.filter((timer) => timer !== due)
        clock.now = Math.max(clock.now, due.at)
        due.callback()
      }
      clock.now = target
      await macrotask()
    },
    pendingTimers: () => clock.timers.length,
  }
  return plugin
}
