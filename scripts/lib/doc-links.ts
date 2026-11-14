import { dirname, posix } from 'node:path'

// The anchor GitHub gives a heading: lowercase, punctuation dropped, spaces to hyphens
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

// A fence may be indented (inside a list) and may be longer than three characters to quote a shorter one
const withoutFences = (text: string): string =>
  text.replace(/^ {0,12}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,12}\1[`~]*[ \t]*$/gm, '')

const withoutCode = (text: string): string => withoutFences(text).replace(/`[^`\n]*`/g, '')

export function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>()
  const anchors = new Set<string>()

  for (const match of withoutFences(text).matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const slug = slugify((match[1] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    anchors.add(count === 0 ? slug : `${slug}-${count}`)
  }
  return anchors
}

// The internal targets of a Markdown file: inline links and images, not the ones in code
export function internalLinks(text: string): string[] {
  return [...withoutCode(text).matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)]
    .map(match => match[1] ?? '')
    .filter(target => target !== '' && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target))
}

export interface LinkReader {
  exists: (path: string) => boolean
  read: (path: string) => string
}

// What is broken in the internal links of one file: a target that is not there, or an anchor that
// the target has no heading for
export function findBrokenLinks(file: string, text: string, fs: LinkReader): string[] {
  const broken: string[] = []

  for (const link of internalLinks(text)) {
    const [rawPath = '', anchor] = link.split('#') as [string, string | undefined]
    let path = file
    let heading: string
    try {
      heading = decodeURIComponent(anchor ?? '').toLowerCase()
      if (rawPath !== '') {
        const target = decodeURI(rawPath)
        // GitHub reads a link that starts with a slash from the root of the repository
        path = posix.normalize(
          target.startsWith('/') ? target.slice(1) : posix.join(dirname(file), target)
        )
      }
    } catch {
      broken.push(`${file}: ${link} is not a valid link`)
      continue
    }
    if (path.startsWith('..') || !fs.exists(path)) {
      broken.push(`${file}: ${link} points to a file that is not there`)
      continue
    }
    if (heading !== '' && path.endsWith('.md') && !anchorsOf(fs.read(path)).has(heading)) {
      broken.push(`${file}: ${link} points to a heading that is not there`)
    }
  }
  return broken
}
