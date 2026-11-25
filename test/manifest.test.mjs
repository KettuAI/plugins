import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadPlugin } from '../test-support/harness.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const NAMES = ['ntfy', 'feishu', 'linear', 'sentry']
const LISTENERS = {
  mentions: 'mention.search',
  links: 'link.card',
  channels: 'channel.notice',
  views: 'view.data',
  actions: 'action.run',
}

const read = (name) => JSON.parse(readFileSync(path.join(ROOT, name, 'plugin.json'), 'utf8'))
const entryOf = (name) => read(name).extensions['sh.kettu']
const permission = /^(?:sessions\.summary|sessions\.content|sessions\.start|tools|prompt\.attach|requests\.check|requests\.answer|network:(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/

test('the folders are the plugins the README lists', () => {
  const folders = readdirSync(ROOT).filter((name) => existsSync(path.join(ROOT, name, 'plugin.json')))
  assert.deepEqual(folders.sort(), [...NAMES].sort())
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  for (const name of NAMES) assert.ok(readme.includes(`(${name}/README.md)`), name)
})

for (const name of NAMES) {
  test(`${name}: the manifest is the format Kettu reads`, () => {
    const manifest = read(name)
    const entry = manifest.extensions['sh.kettu']
    assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    assert.equal(manifest.name, name)
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
    assert.ok(manifest.description.length > 0 && manifest.license === 'MIT')
    assert.deepEqual([entry.format, entry.api, entry.script], [1, 1, './sh.kettu/main.js'])
    assert.ok(entry.permissions.every((p) => permission.test(p)), entry.permissions.join())
    for (const text of [entry.title, entry.description]) assert.deepEqual(Object.keys(text).sort(), ['en', 'zh-CN'])
    for (const group of ['views', 'actions', 'mentions', 'channels']) {
      for (const item of entry[group] ?? []) {
        assert.deepEqual(Object.keys(item.title).sort(), ['en', 'zh-CN'], `${group} ${item.id}`)
        if (item.description) assert.deepEqual(Object.keys(item.description).sort(), ['en', 'zh-CN'])
      }
    }
    const keys = (entry.settings ?? []).map((s) => s.key)
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.every((key) => /^[a-z][a-zA-Z0-9_]{0,63}$/.test(key)))
  })

  test(`${name}: the script is checked, small and listens to what the manifest declares`, () => {
    const entry = entryOf(name)
    const file = path.join(ROOT, name, entry.script)
    const source = readFileSync(file, 'utf8')
    assert.ok(source.startsWith('// @ts-check\n'))
    assert.ok(statSync(file).size < 64 * 1024)
    const plugin = loadPlugin(name)
    for (const [group, event] of Object.entries(LISTENERS)) {
      if ((entry[group] ?? []).length > 0) assert.match(source, new RegExp(`kettu\\.on\\('${event.replace('.', '\\.')}'`), `${group} need ${event}`)
    }
    for (const tool of entry.tools ?? []) {
      assert.equal(typeof plugin.exports[tool.name], 'function', `tool ${tool.name}`)
      assert.match(tool.name, /^[a-z][a-z0-9_]{0,23}$/)
      assert.ok(tool.description.length <= 1000)
      for (const argument of tool.inputSchema.required ?? []) assert.ok(argument in tool.inputSchema.properties)
    }
    if ((entry.tools ?? []).length > 0) assert.ok(entry.permissions.includes('tools'))
    if ((entry.mentions ?? []).length > 0) assert.ok(entry.permissions.includes('prompt.attach'))
    assert.deepEqual(Object.keys(plugin.exports).sort(), (entry.tools ?? []).map((tool) => tool.name).sort())
  })

  test(`${name}: the icon is a square PNG the Marketplace shows`, () => {
    const file = path.join(ROOT, name, 'assets', 'icon.png')
    const data = readFileSync(file)
    assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(data.toString('latin1', 12, 16), 'IHDR')
    const [width, height] = [data.readUInt32BE(16), data.readUInt32BE(20)]
    assert.ok(width === height && width >= 256 && width <= 1024, `${width} x ${height}`)
    assert.ok(statSync(file).size <= 512 * 1024)
  })

  test(`${name}: the README is plain text for the listing`, () => {
    const text = readFileSync(path.join(ROOT, name, 'README.md'), 'utf8')
    assert.ok(text.length > 200 && text.length <= 4000)
    assert.ok(!/^#{1,6} /m.test(text) && !text.includes('```') && !/\*\*|\]\(/.test(text))
  })
}
