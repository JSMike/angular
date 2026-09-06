/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {isObject, MAX_TYPE_TEXT_LENGTH} from './schema';

/** An `import("<specifier>").<Name>` type query within a check type. */
export interface CheckTypeImport {
  specifier: string;
  name: string;
  /** Start of the module specifier contents, excluding quotes, within the check type. */
  start: number;
  /** End of the module specifier contents, excluding quotes, within the check type. */
  end: number;
}

/** A syntax-validated type and its references, which the loader must check against TypeScript. */
export interface ValidatedCheckType {
  /** Text that passed the character, reference-span, and syntax checks in `computeCheckType`. */
  checkType: string;
  /** `import()` type queries substituted for package-local type references. */
  imports: CheckTypeImport[];
  /** Global type names, from `global:` references. */
  globals: string[];
}

export type CheckTypeFailure =
  | 'missingTypeText'
  | 'emptyTypeText'
  | 'typeTextTooLong'
  | 'unsupportedTypeText'
  | 'unusableTypeReference';

export type CheckTypeResult = ValidatedCheckType | {checkType: null; failure: CheckTypeFailure};

/**
 * Converts a CEM type object to a TypeScript check type, or returns the reason it cannot be used.
 * The compiler emits the result verbatim into type-check blocks. All characters and identifiers
 * must pass validation. Relaxing these rules requires a security review.
 *
 * Built-in type keywords, literals, and object property names need no references. Other type
 * names require a `type.references` entry that covers the identifier. References within compound
 * types require exact `start` and `end` offsets. A reference without offsets must name the entire
 * type string. Package references become `import("<package>").<Name>` types. Global references
 * keep their names and appear in `globals`.
 *
 * Unsupported syntax or missing references prevent value checking. The property remains known
 * to the schema checker.
 */
export function computeCheckType(
  cemType: unknown,
  owningPackage: string | null,
  containingModule: string | null = null,
): CheckTypeResult {
  if (!isObject(cemType) || typeof cemType['text'] !== 'string') {
    return {checkType: null, failure: 'missingTypeText'};
  }
  const text = cemType['text'];
  if (text.trim().length === 0) {
    return {checkType: null, failure: 'emptyTypeText'};
  }
  if (text.length > MAX_TYPE_TEXT_LENGTH) {
    return {checkType: null, failure: 'typeTextTooLong'};
  }

  const namedIdentifiers = typeReferenceIdentifiers(text);
  if (namedIdentifiers === null) {
    return {checkType: null, failure: 'unsupportedTypeText'};
  }

  // Each named type requires a reference that covers the identifier's full span.
  const references = Array.isArray(cemType['references']) ? cemType['references'] : [];
  const substitutions: Array<IdentifierOccurrence & {specifier: string | null}> = [];
  for (const identifier of namedIdentifiers) {
    const replacement = findCoveringReferenceReplacement(
      references,
      identifier,
      text,
      owningPackage,
      containingModule,
    );
    if (replacement === undefined) {
      return {checkType: null, failure: 'unusableTypeReference'};
    }
    substitutions.push({...identifier, specifier: replacement});
  }

  // Apply substitutions in source order and record the resulting import specifier spans.
  substitutions.sort((a, b) => a.start - b.start);
  const imports: CheckTypeImport[] = [];
  const globals = new Set<string>();
  let result = '';
  let cursor = 0;
  for (const {start, end, text: name, specifier} of substitutions) {
    result += text.slice(cursor, start);
    if (specifier === null) {
      globals.add(name);
      result += name;
    } else {
      const specifierStart = result.length + 'import("'.length;
      imports.push({
        specifier,
        name,
        start: specifierStart,
        end: specifierStart + specifier.length,
      });
      result += `import("${specifier}").${name}`;
    }
    cursor = end;
  }
  result += text.slice(cursor);
  const leadingWhitespace = result.length - result.trimStart().length;
  result = result.trim();
  for (const reference of imports) {
    reference.start -= leadingWhitespace;
    reference.end -= leadingWhitespace;
  }

  return {checkType: result, imports, globals: Array.from(globals)};
}

interface IdentifierOccurrence {
  text: string;
  start: number;
  end: number;
}

// Syntax depends only on the author text. Keep its compact result, so repeated types need
// neither an AST traversal nor retained SourceFiles. Package references are resolved per use.
const typeIdentifiers = new Map<string, readonly IdentifierOccurrence[] | null>();
const MAX_CACHED_TYPES = 2048;

function typeReferenceIdentifiers(text: string): readonly IdentifierOccurrence[] | null {
  let result = typeIdentifiers.get(text);
  if (result === undefined) {
    result = parseTypeReferenceIdentifiers(text);
    if (typeIdentifiers.size >= MAX_CACHED_TYPES) {
      typeIdentifiers.clear();
    }
    typeIdentifiers.set(text, result);
  }
  return result;
}

/**
 * Validate the supported type AST and collect only names in type-reference positions. The
 * parser owns syntax and delimiter validation; lexical checks retain the existing restricted
 * character set, including rejecting comments and escapes. No second parse is needed after
 * replacing these identifiers with validated import types.
 */
function parseTypeReferenceIdentifiers(text: string): IdentifierOccurrence[] | null {
  const prefix = 'type __CustomElementsManifestTypeText = (';
  const source = ts.createSourceFile(
    'custom-elements-manifest-type-text.ts',
    `${prefix}${text});`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const diagnostics = (source as ts.SourceFile & {parseDiagnostics?: readonly ts.Diagnostic[]})
    .parseDiagnostics;
  if (
    diagnostics?.length ||
    source.statements.length !== 1 ||
    !ts.isTypeAliasDeclaration(source.statements[0]) ||
    // The input must stay inside the parser's wrapper, rather than close and reopen it.
    !ts.isParenthesizedTypeNode(source.statements[0].type)
  ) {
    return null;
  }
  const identifiers: IdentifierOccurrence[] = [];
  let outsideLiterals = '';
  let cursor = 0;
  const literal = (node: ts.Node): boolean => {
    const start = node.getStart(source) - prefix.length;
    const end = node.getEnd() - prefix.length;
    const raw = text.slice(start, end);
    if (/[\\\u0000-\u001f\u2028\u2029]/.test(raw)) {
      return false;
    }
    outsideLiterals += text.slice(cursor, start);
    cursor = end;
    return true;
  };
  const visit = (node: ts.Node): boolean => {
    switch (node.kind) {
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.NeverKeyword:
      case ts.SyntaxKind.StringKeyword:
      case ts.SyntaxKind.NumberKeyword:
      case ts.SyntaxKind.BooleanKeyword:
      case ts.SyntaxKind.BigIntKeyword:
      case ts.SyntaxKind.ObjectKeyword:
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.NumericLiteral:
        return true;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return literal(node);
    }
    if (ts.isTypeReferenceNode(node)) {
      if (!ts.isIdentifier(node.typeName) || node.typeArguments?.length === 0) {
        return false;
      }
      identifiers.push({
        text: node.typeName.text,
        start: node.typeName.getStart(source) - prefix.length,
        end: node.typeName.getEnd() - prefix.length,
      });
      return node.typeArguments?.every(visit) ?? true;
    }
    if (ts.isTypeLiteralNode(node)) {
      return node.members.every(
        (member) =>
          ts.isPropertySignature(member) &&
          (ts.isIdentifier(member.name) ||
            (ts.isStringLiteral(member.name) && literal(member.name)) ||
            ts.isNumericLiteral(member.name)) &&
          (member.modifiers?.every((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ??
            true) &&
          (member.type === undefined || visit(member.type)),
      );
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      return node.types.every(visit);
    }
    if (ts.isTupleTypeNode(node)) {
      return node.elements.every(visit);
    }
    if (ts.isArrayTypeNode(node)) {
      return visit(node.elementType);
    }
    if (
      ts.isParenthesizedTypeNode(node) ||
      ts.isOptionalTypeNode(node) ||
      ts.isRestTypeNode(node)
    ) {
      return visit(node.type);
    }
    if (ts.isTypeOperatorNode(node)) {
      return node.operator === ts.SyntaxKind.ReadonlyKeyword && visit(node.type);
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      return visit(node.objectType) && visit(node.indexType);
    }
    if (ts.isLiteralTypeNode(node)) {
      return visit(node.literal);
    }
    return (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    );
  };
  if (!visit(source.statements[0].type)) {
    return null;
  }
  outsideLiterals += text.slice(cursor);
  return /[^A-Za-z0-9_$[\](){}<>|&,.:? \t\r\n-]/.test(outsideLiterals) ? null : identifiers;
}

/**
 * Finds the reference for an identifier and returns its import specifier. Returns `null` for a
 * global reference, which keeps the identifier, or `undefined` when no usable reference exists.
 * CEM references require both `start` and `end` offsets unless the name matches the entire type
 * string. References to names within compound types must include both offsets.
 */
function findCoveringReferenceReplacement(
  references: unknown[],
  identifier: IdentifierOccurrence,
  text: string,
  owningPackage: string | null,
  containingModule: string | null,
): string | null | undefined {
  for (const reference of references) {
    if (!isObject(reference) || reference['name'] !== identifier.text) {
      continue;
    }
    const hasOffsets = reference['start'] !== undefined || reference['end'] !== undefined;
    if (
      hasOffsets
        ? reference['start'] !== identifier.start || reference['end'] !== identifier.end
        : text.trim() !== identifier.text
    ) {
      continue;
    }
    if (reference['package'] === 'global:') {
      return null;
    }
    const specifier = referenceModuleSpecifier(reference, owningPackage, containingModule);
    if (specifier === null) {
      continue;
    }
    return specifier;
  }
  return undefined;
}

function referenceModuleSpecifier(
  reference: {[key: string]: unknown},
  owningPackage: string | null,
  containingModule: string | null,
): string | null {
  const hasExplicitPackage = typeof reference['package'] === 'string';
  const packageName = hasExplicitPackage ? (reference['package'] as string) : owningPackage;
  if (packageName === null || !isBarePackageSpecifier(packageName)) {
    return null;
  }
  if (reference['module'] === undefined) {
    if (hasExplicitPackage || containingModule === null) {
      return packageName;
    }
    return packageModuleSpecifier(packageName, containingModule);
  }
  if (typeof reference['module'] !== 'string') {
    return null;
  }
  const modulePath = reference['module'].replace(/^\.\//, '');
  if (
    modulePath.length === 0 ||
    modulePath.includes('\\') ||
    modulePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    !/^[A-Za-z0-9._@/-]+$/.test(modulePath)
  ) {
    return null;
  }
  return packageModuleSpecifier(packageName, modulePath);
}

/**
 * Checks whether a specifier names an npm package. Rejects relative paths and package subpaths,
 * including `.` and `..`, which TypeScript would interpret as relative imports in a TCB.
 */
function isBarePackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith('@')) {
    const segments = specifier.slice(1).split('/');
    return segments.length === 2 && segments.every(isPackageNameSegment);
  }
  return !specifier.includes('/') && isPackageNameSegment(specifier);
}

function isPackageNameSegment(segment: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(segment) &&
    !segment.startsWith('.') &&
    !segment.startsWith('_') &&
    !segment.endsWith('.') &&
    /[A-Za-z0-9]/.test(segment)
  );
}

function packageModuleSpecifier(packageName: string, modulePath: string): string {
  const normalizedModulePath = modulePath.replace(/^\.\//, '');
  return normalizedModulePath === packageName || normalizedModulePath.startsWith(`${packageName}/`)
    ? normalizedModulePath
    : `${packageName}/${normalizedModulePath}`;
}
