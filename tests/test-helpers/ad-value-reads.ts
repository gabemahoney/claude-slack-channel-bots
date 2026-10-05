/**
 * test-helpers/ad-value-reads.ts — The TypeScript-parser audit of where a
 * file holds an agent-director export as a value, shared by two suites:
 *
 * - `tests/host-safety.test.ts` runs `agentDirectorValueReads` over
 *   `Client` and `resolveSystemBinary` (b.jg5 SRJ-1301, SRJ-121);
 * - `tests/fmk-source-audit.test.ts` runs it, and
 *   `agentDirectorNamespaceArguments`, over the three Phase-1-only error
 *   classes (b.jg5 SRJ-101, SRJ-103), which `src/` takes only as plain named
 *   re-exports.
 *
 * Also exported: the parser primitives both audits are built on. Everything
 * here is pure over a parsed `ts.SourceFile`: no file is read and nothing is
 * loaded, so text in strings, comments, templates and regex literals never
 * counts.
 *
 * SPDX-License-Identifier: MIT
 */

import ts from 'typescript'

/** The client's module specifier. */
export const AGENT_DIRECTOR_MODULE = 'agent-director'

/** Calls `visit` on every node under `root`, depth first. */
export function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
}

/** Whether `node` only wraps its operand (parentheses, `await`, `as`, `!`, `satisfies`). */
export function isWrapper(node: ts.Node): node is ts.ParenthesizedExpression | ts.AwaitExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)
}

/** `expr` without its wrappers. */
export function unwrap(expr: ts.Expression): ts.Expression {
  while (isWrapper(expr)) expr = expr.expression
  return expr
}

/** The outermost wrapper around `node` (itself when unwrapped); its parent is the context `node` is used in. */
export function outermost(node: ts.Node): ts.Node {
  while (node.parent !== undefined && isWrapper(node.parent)) node = node.parent
  return node
}

/** The text of a string literal (or a template with no substitution), else undefined. */
export function stringText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

/** The specifier of a dynamic `import('…')` or `require('…')` call, else undefined. */
export function moduleLoadOf(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined
  const callee = node.expression
  if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && callee.text === 'require')) return undefined
  return stringText(node.arguments[0])
}

/**
 * Whether the dynamic load `node` (see `moduleLoadOf`) is an un-awaited
 * `import()` whose promise is used through a member (`.then(...)`, say): the
 * module's exports are then read where the audit cannot follow.
 */
export function isPromiseMemberUse(node: ts.CallExpression): boolean {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  let at: ts.Node = node
  while (at.parent !== undefined && isWrapper(at.parent)) {
    if (ts.isAwaitExpression(at.parent)) return false
    at = at.parent
  }
  const context = at.parent
  return context !== undefined && (ts.isPropertyAccessExpression(context) || ts.isElementAccessExpression(context)) && context.expression === at
}

/** The name a property or binding element is known by, when it is a plain identifier or string. */
export function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isComputedPropertyName(name)) return stringText(name.expression)
  return stringText(name)
}

/** One place a file holds an agent-director export as a value (see `agentDirectorValueReads`). */
export interface AgentDirectorValueRead {
  /** The export read, or undefined when the audit cannot tell which (a computed read, a load it cannot follow, `export *`). */
  name: string | undefined
  /**
   * Where: the import or export specifier, the binding element, the
   * destructuring-assignment property, the namespace read, or the load or
   * statement the audit cannot follow.
   */
  node: ts.Node
  what: string
}

/**
 * Every place `sf` holds one of `names` from agent-director as a value, and
 * every read the audit cannot name. Flagged: a named value import (aliased or
 * not) or re-export of one, `export *` from agent-director, and a read of one
 * through the module namespace (a static namespace or default import,
 * `import x = require`, a dynamic `import()` or `require()`, or a copy of
 * one: `const x = ns`, `const x = { ...ns }`, a destructuring rest, each
 * through any cast): a property or element read, a computed element read, or
 * destructuring (declaration or assignment). A dynamic load used any other
 * way (e.g. `.then(...)`) is flagged as a form the audit cannot follow.
 * Allowed: type-only imports and re-exports (whole-statement or inline),
 * `import('agent-director').X` in a type, spreading the namespace (into a
 * `mock.module` factory, say), and other names.
 */
export function agentDirectorValueReads(sf: ts.SourceFile, names: readonly string[]): AgentDirectorValueRead[] {
  const findings: AgentDirectorValueRead[] = []
  const flag = (node: ts.Node, what: string, name?: string): void => {
    findings.push({ name, node, what })
  }
  const namespaces = new Set<string>()

  const isNamespace = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr)
    return (ts.isIdentifier(inner) && namespaces.has(inner.text)) || moduleLoadOf(inner) === AGENT_DIRECTOR_MODULE
  }
  const checkBindingPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken !== undefined) continue // a rest copy: collected as a namespace below
      const name = propertyNameText(el.propertyName ?? el.name)
      if (name === undefined && el.propertyName !== undefined) flag(el, 'computed destructuring of agent-director')
      else if (name !== undefined && names.includes(name)) flag(el, `destructuring of ${name} from agent-director`, name)
    }
  }

  // Bindings: static imports and re-exports, and dynamic loads.
  forEachNode(sf, (node) => {
    if (ts.isImportDeclaration(node) && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.importClause
      if (clause === undefined || clause.isTypeOnly) return
      if (clause.name !== undefined) namespaces.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      else if (bindings !== undefined) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue
          const imported = (el.propertyName ?? el.name).text
          if (names.includes(imported)) flag(el, `value import of ${imported} from agent-director`, imported)
          if (imported === 'default') namespaces.add(el.name.text)
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && stringText(node.moduleReference.expression) === AGENT_DIRECTOR_MODULE) {
      namespaces.add(node.name.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.exportClause
      if (clause === undefined || ts.isNamespaceExport(clause)) flag(node, 'value re-export of the whole agent-director module')
      else {
        for (const el of clause.elements) {
          const exported = (el.propertyName ?? el.name).text
          if (!el.isTypeOnly && names.includes(exported)) flag(el, `value re-export of ${exported} from agent-director`, exported)
        }
      }
    } else if (moduleLoadOf(node) === AGENT_DIRECTOR_MODULE) {
      const outer = outermost(node)
      const context = outer.parent
      if (isPromiseMemberUse(node as ts.CallExpression)) flag(node, 'agent-director loaded in a form the audit cannot follow')
      else if (ts.isVariableDeclaration(context) && context.initializer === outer) {
        if (ts.isIdentifier(context.name)) namespaces.add(context.name.text)
        // An object pattern is checked with the other destructurings below.
        else if (!ts.isObjectBindingPattern(context.name)) flag(node, 'agent-director loaded into a pattern the audit cannot follow')
      } else if (!((ts.isPropertyAccessExpression(context) || ts.isElementAccessExpression(context)) && context.expression === outer) && !ts.isSpreadAssignment(context)) {
        flag(node, 'agent-director loaded in a form the audit cannot follow')
      }
    }
  })

  // Copies of a namespace: `const x = ns`, `const x = { ...ns }`, `const { ...x } = ns`.
  for (let grew = true; grew;) {
    grew = false
    forEachNode(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
      const copies: string[] = []
      const init = unwrap(node.initializer)
      if (ts.isIdentifier(node.name) && (isNamespace(init) || (ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isSpreadAssignment(p) && isNamespace(p.expression))))) {
        copies.push(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name) && isNamespace(init)) {
        for (const el of node.name.elements) if (el.dotDotDotToken !== undefined && ts.isIdentifier(el.name)) copies.push(el.name.text)
      }
      for (const name of copies) {
        if (!namespaces.has(name)) {
          namespaces.add(name)
          grew = true
        }
      }
    })
  }

  // Reads through a namespace or one of its copies.
  forEachNode(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression) && names.includes(node.name.text)) {
      flag(node, `read of ${node.name.text} through the agent-director namespace`, node.name.text)
    } else if (ts.isElementAccessExpression(node) && isNamespace(node.expression)) {
      const name = stringText(node.argumentExpression)
      if (name === undefined) flag(node, 'computed read through the agent-director namespace')
      else if (names.includes(name)) flag(node, `read of ${name} through the agent-director namespace`, name)
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isNamespace(node.initializer)) {
      checkBindingPattern(node.name)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isNamespace(node.right)) {
      const left = unwrap(node.left)
      if (!ts.isObjectLiteralExpression(left)) return
      for (const prop of left.properties) {
        const name = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) ? propertyNameText(prop.name) : undefined
        if (name !== undefined && names.includes(name)) flag(prop, `destructuring of ${name} from agent-director`, name)
      }
    }
  })
  return findings
}

/**
 * Every call or `new` argument in `sf` that is the agent-director module
 * namespace (a static namespace or default import, `import x = require`, a
 * dynamic `import()` or `require()`) or a copy of one (`const x = ns`,
 * `const x = { ...ns }`, `const { ...x } = ns`), through any wrapper (a cast,
 * `!`, parentheses, `await`): the callee may read any export.
 */
export function agentDirectorNamespaceArguments(sf: ts.SourceFile): ts.Expression[] {
  const namespaces = new Set<string>()
  const isNamespace = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr)
    return (ts.isIdentifier(inner) && namespaces.has(inner.text)) || moduleLoadOf(inner) === AGENT_DIRECTOR_MODULE
  }
  forEachNode(sf, (node) => {
    if (ts.isImportDeclaration(node) && stringText(node.moduleSpecifier) === AGENT_DIRECTOR_MODULE) {
      const clause = node.importClause
      if (clause === undefined || clause.isTypeOnly) return
      if (clause.name !== undefined) namespaces.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      else if (bindings !== undefined) {
        for (const el of bindings.elements) if (!el.isTypeOnly && (el.propertyName ?? el.name).text === 'default') namespaces.add(el.name.text)
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && stringText(node.moduleReference.expression) === AGENT_DIRECTOR_MODULE) {
      namespaces.add(node.name.text)
    }
  })
  for (let grew = true; grew;) {
    grew = false
    forEachNode(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
      const init = unwrap(node.initializer)
      const copies: string[] = []
      if (ts.isIdentifier(node.name) && (isNamespace(init) || (ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isSpreadAssignment(p) && isNamespace(p.expression))))) {
        copies.push(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name) && isNamespace(init)) {
        for (const el of node.name.elements) if (el.dotDotDotToken !== undefined && ts.isIdentifier(el.name)) copies.push(el.name.text)
      }
      for (const name of copies) {
        if (!namespaces.has(name)) {
          namespaces.add(name)
          grew = true
        }
      }
    })
  }
  const found: ts.Expression[] = []
  forEachNode(sf, (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) found.push(...(node.arguments ?? []).filter(isNamespace))
  })
  return found
}
