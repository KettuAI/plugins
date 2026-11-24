// How Kettu reads a link pattern, as its documentation states it: the host is a name or `*.name`,
// each path segment is a literal, `*`, `{name}` or a last `**` for whatever follows, nothing included.

function covers(domain, host) {
  if (!domain.startsWith('*.')) return host === domain
  return host.endsWith(domain.slice(1)) && host.length > domain.length - 1
}

/** What the `{name}` parts of `pattern` matched in `address`, or null when it does not name it. */
export function matchPattern(pattern, address) {
  const rest = pattern.slice('https://'.length)
  const slash = rest.indexOf('/')
  const host = slash < 0 ? rest : rest.slice(0, slash)
  const parts = slash < 0 ? [] : rest.slice(slash + 1).split('/')
  const tail = parts.at(-1) === '**'
  const segments = tail ? parts.slice(0, -1) : parts
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.port || !covers(host, url.hostname)) return null
  const path = url.pathname === '/' ? [] : url.pathname.slice(1).split('/')
  if (path.length > 1 && path.at(-1) === '') path.pop()
  if (path.length < segments.length || (!tail && path.length !== segments.length)) return null
  const match = {}
  for (const [index, segment] of segments.entries()) {
    if (path[index] === '') return null
    if (segment.startsWith('{')) match[segment.slice(1, -1)] = decodeURIComponent(path[index])
    else if (segment !== '*' && segment !== path[index]) return null
  }
  return match
}

/** The first of a plugin's link kinds that names the address, with what its pattern matched. */
export function matchLink(links, address) {
  for (const link of links) {
    for (const pattern of link.patterns) {
      const match = matchPattern(pattern, address)
      if (match) return { link: link.id, match }
    }
  }
  return null
}
