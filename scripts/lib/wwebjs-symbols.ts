import { readFileSync } from 'node:fs'

import {
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isClassDeclaration,
  isEnumDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isStringLiteral,
  type Node,
  type PropertyName,
  type SourceFile
} from 'typescript'

export const WWEBJS_DECLARATIONS_PATH = 'node_modules/whatsapp-web.js/index.d.ts'

// A quoted member ('a-b') is listed without its quotes
const memberName = (name: PropertyName, file: SourceFile): string =>
  isIdentifier(name) || isStringLiteral(name) ? name.text : name.getText(file)

// The classes and interfaces of the library are listed as `Owner.member`; its events as
// `Events.<wire name>` (several constants share a wire name, `call` is one of them)
export function listWwebjsSymbols(source: string): string[] {
  const file = createSourceFile('index.d.ts', source, ScriptTarget.ES2023, true)
  const symbols = new Set<string>()

  const visit = (node: Node): void => {
    if (isClassDeclaration(node) || isInterfaceDeclaration(node)) {
      const owner = node.name?.text
      if (owner !== undefined) {
        for (const member of node.members) {
          // Constructors and index signatures have no name to match against
          if (member.name !== undefined) symbols.add(`${owner}.${memberName(member.name, file)}`)
        }
      }
    } else if (isEnumDeclaration(node) && node.name.text === 'Events') {
      for (const member of node.members) {
        if (member.initializer !== undefined && isStringLiteral(member.initializer)) {
          symbols.add(`Events.${member.initializer.text}`)
        }
      }
    }
    forEachChild(node, visit)
  }
  visit(file)

  return [...symbols].sort()
}

export function readWwebjsSymbols(): string[] {
  return listWwebjsSymbols(readFileSync(WWEBJS_DECLARATIONS_PATH, 'utf8'))
}
