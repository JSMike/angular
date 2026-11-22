/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {CustomElementImportCandidate, CustomElementTypeExpr} from '@angular/compiler';

export const MAX_TYPE_TEXT_LENGTH = 2048;
export const MAX_EMITTED_TYPE_LENGTH = 4096;
const MAX_DEPTH = 16;
const MAX_FIRST_EXPANSIONS = 8;

export type ParsedManifestType =
  | {
      readonly ok: true;
      readonly checkType: CustomElementTypeExpr;
      readonly isLiteralUnion: boolean;
      readonly literalUnionType?: string;
      readonly stringLiteralValues?: readonly string[];
      readonly isExternal: boolean;
      readonly usesUnreferencedGlobal: boolean;
    }
  | {readonly ok: false};

const PRIMITIVE_KEYWORDS = new Set<string>(
  'string number boolean bigint symbol void undefined null never unknown any object true false'.split(
    ' ',
  ),
);

/**
 * Fixed allowlist of standard JS, TS utility, and exact `lib.dom.d.ts` global types that may appear
 * in CEM type text without a `type.references` entry. Uses exact names (never an open regex) so
 * imaginary `HTML*Element` names are rejected instead of triggering expensive TS typo suggestions.
 */
const STDLIB_GLOBAL_TYPES = new Set<string>(
  (
    'Array ArrayBuffer ArrayBufferLike ArrayBufferView ArrayLike Awaited BigInt BigInt64Array ' +
    'BigUint64Array Capitalize ConstructorParameters DataView Date Error Exclude Extract ' +
    'Float32Array Float64Array Function InstanceType Int8Array Int16Array Int32Array Iterable ' +
    'IterableIterator Lowercase Map NonNullable Omit Parameters Partial Pick Promise PromiseLike ' +
    'PropertyKey Readonly ReadonlyArray ReadonlyMap ReadonlySet Record RegExp Required ReturnType ' +
    'Set Symbol Uint8Array Uint8ClampedArray Uint16Array Uint32Array Uncapitalize Uppercase ' +
    'WeakMap WeakSet AbortController AbortSignal Animation AnimationEvent AutoFill Blob BlobPart ' +
    'BodyInit BufferSource CanvasRenderingContext2D ClipboardEvent CompositionEvent CSSNumberish ' +
    'CSSStyleDeclaration CustomEvent CustomEventInit Document DocumentFragment DOMMatrix ' +
    'DOMMatrixReadOnly DOMPoint DOMPointReadOnly DOMRect DOMRectReadOnly DOMStringMap ' +
    'DOMTokenList DragEvent Element ElementInternals ErrorEvent Event EventInit EventListener ' +
    'EventListenerObject EventListenerOrEventListenerObject EventTarget File FileList FillMode ' +
    'FocusEvent FormData HashChangeEvent Headers HeadersInit HTMLCollection HTMLCollectionOf ' +
    'HTMLElement ImageData InputEvent InsertPosition IntersectionObserverEntry KeyboardEvent ' +
    'Keyframe MathMLElement MediaQueryList MessageEvent MouseEvent MutationObserver ' +
    'MutationRecord Node NodeList NodeListOf PageTransitionEvent PlaybackDirection PointerEvent ' +
    'PopStateEvent ProgressEvent PromiseRejectionEvent Range Request RequestInfo RequestInit ' +
    'ResizeObserverEntry Response ScrollBehavior Selection SelectionMode ShadowRoot ' +
    'ShadowRootMode StorageEvent SubmitEvent SVGElement ToggleEvent Touch TouchEvent TouchList ' +
    'TransitionEvent UIEvent URL URLSearchParams ValidityState WheelEvent Window ' +
    'HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBRElement HTMLBaseElement ' +
    'HTMLBodyElement HTMLButtonElement HTMLCanvasElement HTMLDListElement HTMLDataElement ' +
    'HTMLDataListElement HTMLDetailsElement HTMLDialogElement HTMLDirectoryElement ' +
    'HTMLDivElement HTMLEmbedElement HTMLFieldSetElement HTMLFontElement HTMLFormElement ' +
    'HTMLFrameElement HTMLFrameSetElement HTMLHRElement HTMLHeadElement HTMLHeadingElement ' +
    'HTMLHtmlElement HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLLIElement ' +
    'HTMLLabelElement HTMLLegendElement HTMLLinkElement HTMLMapElement HTMLMarqueeElement ' +
    'HTMLMediaElement HTMLMenuElement HTMLMetaElement HTMLMeterElement HTMLModElement ' +
    'HTMLOListElement HTMLObjectElement HTMLOptGroupElement HTMLOptionElement HTMLOrSVGElement ' +
    'HTMLOutputElement HTMLParagraphElement HTMLParamElement HTMLPictureElement HTMLPreElement ' +
    'HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSlotElement ' +
    'HTMLSourceElement HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement ' +
    'HTMLTableCellElement HTMLTableColElement HTMLTableDataCellElement HTMLTableElement ' +
    'HTMLTableHeaderCellElement HTMLTableRowElement HTMLTableSectionElement HTMLTemplateElement ' +
    'HTMLTextAreaElement HTMLTimeElement HTMLTitleElement HTMLTrackElement HTMLUListElement ' +
    'HTMLUnknownElement HTMLVideoElement SVGAElement SVGAnimateElement SVGAnimateMotionElement ' +
    'SVGAnimateTransformElement SVGAnimationElement SVGCircleElement SVGClipPathElement ' +
    'SVGComponentTransferFunctionElement SVGDefsElement SVGDescElement SVGEllipseElement ' +
    'SVGFEBlendElement SVGFEColorMatrixElement SVGFEComponentTransferElement ' +
    'SVGFECompositeElement SVGFEConvolveMatrixElement SVGFEDiffuseLightingElement ' +
    'SVGFEDisplacementMapElement SVGFEDistantLightElement SVGFEDropShadowElement ' +
    'SVGFEFloodElement SVGFEFuncAElement SVGFEFuncBElement SVGFEFuncGElement SVGFEFuncRElement ' +
    'SVGFEGaussianBlurElement SVGFEImageElement SVGFEMergeElement SVGFEMergeNodeElement ' +
    'SVGFEMorphologyElement SVGFEOffsetElement SVGFEPointLightElement ' +
    'SVGFESpecularLightingElement SVGFESpotLightElement SVGFETileElement SVGFETurbulenceElement ' +
    'SVGFilterElement SVGForeignObjectElement SVGGElement SVGGeometryElement SVGGradientElement ' +
    'SVGGraphicsElement SVGImageElement SVGLineElement SVGLinearGradientElement SVGMPathElement ' +
    'SVGMarkerElement SVGMaskElement SVGMetadataElement SVGPathElement SVGPatternElement ' +
    'SVGPolygonElement SVGPolylineElement SVGRadialGradientElement SVGRectElement SVGSVGElement ' +
    'SVGScriptElement SVGSetElement SVGStopElement SVGStyleElement SVGSwitchElement ' +
    'SVGSymbolElement SVGTSpanElement SVGTextContentElement SVGTextElement SVGTextPathElement ' +
    'SVGTextPositioningElement SVGTitleElement SVGUseElement SVGViewElement'
  ).split(' '),
);

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VALID_PACKAGE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TYPESCRIPT_EXTENSION = /\.[mc]?tsx?$/;

function isValidPackageName(pkg: string): boolean {
  if (pkg.startsWith('@')) {
    const parts = pkg.split('/');
    return (
      parts.length === 2 &&
      parts[0].length > 1 &&
      VALID_PACKAGE_SEGMENT.test(parts[0].slice(1)) &&
      VALID_PACKAGE_SEGMENT.test(parts[1]) &&
      parts[1] !== '.' &&
      parts[1] !== '..'
    );
  }
  return VALID_PACKAGE_SEGMENT.test(pkg) && pkg !== '.' && pkg !== '..';
}

/** Normalizes a relative POSIX module path inside a package; returns `null` if it escapes root or is `.ts`. */
function normalizePackageModulePath(modulePath: string): string | null {
  const cleaned = modulePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.length === 0) {
    return '';
  }
  if (TYPESCRIPT_EXTENSION.test(cleaned)) {
    return null;
  }
  const resolved: string[] = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (resolved.length === 0) {
        return null;
      }
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join('/');
}

/**
 * Builds ordered TypeScript module specifier candidates for a declaration in a package.
 * Includes a manifest-directory-relative fallback (e.g. `@shoelace-style/shoelace/dist/...`)
 * when the manifest lives in a package subdirectory such as `dist/`.
 */
export function buildModuleSpecifiers(
  packageName: string | null,
  owningPackage: string | null,
  manifestRelativeDir: string,
  modulePath: string | null,
): string[] {
  if (packageName === null || !isValidPackageName(packageName)) {
    return [];
  }
  if (modulePath === null || modulePath.trim().length === 0) {
    return [packageName];
  }
  const normalized = normalizePackageModulePath(modulePath);
  if (normalized === null) {
    return [];
  }
  const primary = normalized.length === 0 ? packageName : `${packageName}/${normalized}`;
  const candidates = [primary];
  if (
    packageName === owningPackage &&
    manifestRelativeDir.length > 0 &&
    normalized.length > 0 &&
    normalized !== manifestRelativeDir &&
    !normalized.startsWith(`${manifestRelativeDir}/`)
  ) {
    candidates.push(`${packageName}/${manifestRelativeDir}/${normalized}`);
  }
  return candidates;
}

/** Builds candidate `import()` locations for a custom element class. */
export function buildClassImportCandidates(
  owningPackage: string | null,
  manifestRelativeDir: string,
  modulePath: string,
  exportName: string,
): CustomElementImportCandidate[] {
  if (owningPackage === null || !VALID_IDENTIFIER.test(exportName)) {
    return [];
  }
  return buildModuleSpecifiers(owningPackage, owningPackage, manifestRelativeDir, modulePath).map(
    (specifier) => ({specifier, exportName}),
  );
}

interface RawReference {
  readonly name: string;
  readonly package?: string;
  readonly module?: string;
  readonly start?: number;
  readonly end?: number;
}

function extractReferences(type: unknown): RawReference[] {
  if (
    typeof type !== 'object' ||
    type === null ||
    !Array.isArray((type as {references?: unknown}).references)
  ) {
    return [];
  }
  const result: RawReference[] = [];
  for (const entry of (type as {references: unknown[]}).references) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const obj = entry as {[key: string]: unknown};
    if (typeof obj['name'] !== 'string' || !VALID_IDENTIFIER.test(obj['name'])) {
      continue;
    }
    result.push({
      name: obj['name'],
      ...(typeof obj['package'] === 'string' ? {package: obj['package']} : {}),
      ...(typeof obj['module'] === 'string' ? {module: obj['module']} : {}),
      ...(typeof obj['start'] === 'number' ? {start: obj['start']} : {}),
      ...(typeof obj['end'] === 'number' ? {end: obj['end']} : {}),
    });
  }
  return result;
}

type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value?: string;
  readonly start: number;
  readonly end: number;
}

const SINGLE_CHAR_PUNCT = new Set([
  '|',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '?',
  '-',
]);

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      let value = '';
      let closed = false;
      while (i < len) {
        const c = source[i++];
        if (c === '\n' || c === '\r') {
          return null;
        }
        if (c === '\\') {
          if (i >= len) {
            return null;
          }
          const esc = source[i++];
          if (esc === 'n') value += '\n';
          else if (esc === 'r') value += '\r';
          else if (esc === 't') value += '\t';
          else if (esc === '\\' || esc === "'" || esc === '"') value += esc;
          else return null;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        value += c;
      }
      if (!closed) {
        return null;
      }
      tokens.push({kind: 'string', text: source.slice(start, i), value, start, end: i});
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < len && source[i] >= '0' && source[i] <= '9') i++;
      if (
        i < len &&
        source[i] === '.' &&
        i + 1 < len &&
        source[i + 1] >= '0' &&
        source[i + 1] <= '9'
      ) {
        i++;
        while (i < len && source[i] >= '0' && source[i] <= '9') i++;
      }
      tokens.push({kind: 'number', text: source.slice(start, i), start, end: i});
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$') {
      const start = i++;
      while (
        i < len &&
        ((source[i] >= 'A' && source[i] <= 'Z') ||
          (source[i] >= 'a' && source[i] <= 'z') ||
          (source[i] >= '0' && source[i] <= '9') ||
          source[i] === '_' ||
          source[i] === '$')
      ) {
        i++;
      }
      tokens.push({kind: 'ident', text: source.slice(start, i), start, end: i});
      continue;
    }
    if (SINGLE_CHAR_PUNCT.has(ch)) {
      tokens.push({kind: 'punct', text: ch, start: i, end: i + 1});
      i++;
      continue;
    }
    return null;
  }
  tokens.push({kind: 'eof', text: '', start: len, end: len});
  return tokens;
}

interface TypeAstNode {
  readonly kind: 'stringLiteral' | 'nullish' | 'union' | 'paren' | 'other';
  readonly expr: CustomElementTypeExpr;
  readonly estimatedLength: number;
  readonly hasExternalRef: boolean;
  readonly stringValue?: string;
  readonly members?: TypeAstNode[];
  readonly inner?: TypeAstNode;
}

function appendExprPart(flat: CustomElementTypeExpr[], part: CustomElementTypeExpr): void {
  if (typeof part === 'string') {
    if (part.length === 0) {
      return;
    }
    if (flat.length > 0 && typeof flat[flat.length - 1] === 'string') {
      flat[flat.length - 1] = (flat[flat.length - 1] as string) + part;
    } else {
      flat.push(part);
    }
    return;
  }
  if (part.kind === 'concat') {
    for (const nested of part.parts) {
      appendExprPart(flat, nested);
    }
    return;
  }
  flat.push(part);
}

function concatTypeExprs(parts: readonly CustomElementTypeExpr[]): CustomElementTypeExpr {
  const flat: CustomElementTypeExpr[] = [];
  for (const part of parts) {
    appendExprPart(flat, part);
  }
  if (flat.length === 0) {
    return '';
  }
  return flat.length === 1 ? flat[0] : {kind: 'concat', parts: flat};
}

function buildGlobalTypeExpr(name: string, typeArgs: readonly TypeAstNode[] | null): TypeAstNode {
  const prefix = `globalThis.${name}`;
  if (typeArgs === null || typeArgs.length === 0) {
    return {
      kind: 'other',
      expr: prefix,
      estimatedLength: prefix.length,
      hasExternalRef: true,
    };
  }
  const parts: CustomElementTypeExpr[] = [`${prefix}<`];
  let estimatedLength = prefix.length + 2;
  for (let i = 0; i < typeArgs.length; i++) {
    if (i > 0) {
      parts.push(', ');
      estimatedLength += 2;
    }
    const arg = typeArgs[i];
    // For global `CustomEvent<ExternalDetail>` (where the detail arg references an imported or
    // global type rather than bare `CustomEvent` or literal `CustomEvent<any>`), wrap the detail
    // argument so an unresolved detail degrades to `CustomEvent<unknown>` instead of leaking `any`.
    if (name === 'CustomEvent' && typeArgs.length === 1 && arg.hasExternalRef) {
      parts.push({kind: 'customEventDetail', inner: arg.expr});
      estimatedLength += arg.estimatedLength + 14;
    } else {
      parts.push(arg.expr);
      estimatedLength += arg.estimatedLength;
    }
  }
  parts.push('>');
  return {
    kind: 'other',
    expr: concatTypeExprs(parts),
    estimatedLength,
    hasExternalRef: true,
  };
}

/**
 * Parses a CEM `type` object using a closed recursive-descent TypeScript type grammar and returns
 * a canonical, injection-safe structured TypeScript type expression with explicit metadata flags.
 */
export function parseManifestType(
  type: unknown,
  owningPackage: string | null,
  manifestRelativeDir: string,
  containingModule: string | null,
): ParsedManifestType {
  if (typeof type !== 'object' || type === null) {
    return {ok: false};
  }
  const rawText = (type as {text?: unknown}).text;
  if (
    typeof rawText !== 'string' ||
    rawText.trim().length === 0 ||
    rawText.length > MAX_TYPE_TEXT_LENGTH
  ) {
    return {ok: false};
  }
  const tokens = tokenize(rawText);
  if (tokens === null) {
    return {ok: false};
  }
  const references = extractReferences(type);
  let pos = 0;
  let depth = 0;
  let firstExpansions = 0;
  let isExternal = false;
  let usesUnreferencedGlobal = false;

  const peek = (): Token => tokens[pos];
  const consume = (): Token => tokens[pos++];
  const matchPunct = (text: string): boolean => {
    if (peek().kind === 'punct' && peek().text === text) {
      pos++;
      return true;
    }
    return false;
  };
  const checked = (node: TypeAstNode | null): TypeAstNode | null =>
    node !== null && node.estimatedLength <= MAX_EMITTED_TYPE_LENGTH ? node : null;

  const resolveIdentifier = (
    tok: Token,
    typeArgs: readonly TypeAstNode[] | null,
  ): TypeAstNode | null => {
    const exactMatches = references.filter(
      (ref) =>
        ref.start === tok.start &&
        ref.end === tok.end &&
        ref.name === tok.text &&
        rawText.slice(ref.start, ref.end) === tok.text,
    );
    let chosen: RawReference | null = null;
    if (exactMatches.length === 1) {
      chosen = exactMatches[0];
    } else if (exactMatches.length > 1) {
      return null;
    } else {
      const hasOffsetEntry = references.some(
        (ref) => ref.name === tok.text && (ref.start !== undefined || ref.end !== undefined),
      );
      if (hasOffsetEntry) {
        return null;
      }
      const offsetless = references.filter(
        (ref) => ref.name === tok.text && ref.start === undefined && ref.end === undefined,
      );
      if (offsetless.length > 0) {
        const first = offsetless[0];
        if (
          offsetless.some((ref) => ref.package !== first.package || ref.module !== first.module)
        ) {
          return null;
        }
        chosen = first;
      }
    }

    if (chosen !== null) {
      isExternal = true;
      if (chosen.package === 'global:') {
        return checked(buildGlobalTypeExpr(tok.text, typeArgs));
      }
      const pkg = chosen.package ?? owningPackage;
      const mod = chosen.module ?? (chosen.package === undefined ? containingModule : null);
      const specifiers = buildModuleSpecifiers(pkg, owningPackage, manifestRelativeDir, mod);
      if (specifiers.length === 0) {
        return null;
      }
      if (specifiers.length > 1 && ++firstExpansions > MAX_FIRST_EXPANSIONS) {
        return null;
      }
      const argsLen =
        typeArgs === null || typeArgs.length === 0
          ? 0
          : 2 +
            typeArgs.reduce((sum, arg) => sum + arg.estimatedLength, 0) +
            (typeArgs.length - 1) * 2;
      let estimatedLength = 0;
      for (let i = 0; i < specifiers.length; i++) {
        // `import("<spec>").<Name><args>` plus `_CemFirst<..., ...>` overhead for fallbacks.
        const candidateLen = 10 + specifiers[i].length + tok.text.length + argsLen;
        estimatedLength = i === 0 ? candidateLen : estimatedLength + candidateLen + 13;
        if (estimatedLength > MAX_EMITTED_TYPE_LENGTH) {
          return null;
        }
      }
      const candidates: CustomElementImportCandidate[] = specifiers.map((specifier) => ({
        specifier,
        exportName: tok.text,
      }));
      return checked({
        kind: 'other',
        expr: {
          kind: 'import',
          candidates,
          ...(typeArgs !== null && typeArgs.length > 0
            ? {typeArgs: typeArgs.map((arg) => arg.expr)}
            : {}),
        },
        estimatedLength,
        hasExternalRef: true,
      });
    }

    if (STDLIB_GLOBAL_TYPES.has(tok.text)) {
      isExternal = true;
      usesUnreferencedGlobal = true;
      return checked(buildGlobalTypeExpr(tok.text, typeArgs));
    }
    return null;
  };

  const parseType = (): TypeAstNode | null => {
    if (++depth > MAX_DEPTH) {
      return null;
    }
    try {
      matchPunct('|');
      return parseUnion();
    } finally {
      depth--;
    }
  };

  const parseUnion = (): TypeAstNode | null => {
    const first = parseArray();
    if (first === null) {
      return null;
    }
    if (!(peek().kind === 'punct' && peek().text === '|')) {
      return first;
    }
    const members: TypeAstNode[] = [first];
    while (matchPunct('|')) {
      const next = parseArray();
      if (next === null) {
        return null;
      }
      members.push(next);
    }
    const parts: CustomElementTypeExpr[] = [];
    let estimatedLength = 0;
    let hasExternalRef = false;
    for (let i = 0; i < members.length; i++) {
      if (i > 0) {
        parts.push(' | ');
        estimatedLength += 3;
      }
      parts.push(members[i].expr);
      estimatedLength += members[i].estimatedLength;
      hasExternalRef ||= members[i].hasExternalRef;
    }
    return checked({
      kind: 'union',
      members,
      expr: concatTypeExprs(parts),
      estimatedLength,
      hasExternalRef,
    });
  };

  const parseArray = (): TypeAstNode | null => {
    const base = parsePrimary();
    if (base === null) {
      return null;
    }
    let suffix = '';
    while (peek().kind === 'punct' && peek().text === '[') {
      consume();
      if (!matchPunct(']')) {
        return null;
      }
      suffix += '[]';
    }
    return suffix.length > 0
      ? checked({
          kind: 'other',
          expr: concatTypeExprs([base.expr, suffix]),
          estimatedLength: base.estimatedLength + suffix.length,
          hasExternalRef: base.hasExternalRef,
        })
      : base;
  };

  const parsePrimary = (): TypeAstNode | null => {
    const tok = peek();
    if (tok.kind === 'string') {
      consume();
      const code = JSON.stringify(tok.value!);
      return {
        kind: 'stringLiteral',
        expr: code,
        estimatedLength: code.length,
        hasExternalRef: false,
        stringValue: tok.value!,
      };
    }
    if (tok.kind === 'number') {
      consume();
      return {
        kind: 'other',
        expr: tok.text,
        estimatedLength: tok.text.length,
        hasExternalRef: false,
      };
    }
    if (tok.kind === 'punct' && tok.text === '-') {
      consume();
      const num = peek();
      if (num.kind !== 'number') {
        return null;
      }
      consume();
      const code = `-${num.text}`;
      return {
        kind: 'other',
        expr: code,
        estimatedLength: code.length,
        hasExternalRef: false,
      };
    }
    if (tok.kind === 'punct' && tok.text === '(') {
      consume();
      const inner = parseType();
      if (inner === null || !matchPunct(')')) {
        return null;
      }
      return checked({
        kind: 'paren',
        inner,
        expr: concatTypeExprs(['(', inner.expr, ')']),
        estimatedLength: inner.estimatedLength + 2,
        hasExternalRef: inner.hasExternalRef,
      });
    }
    if (tok.kind === 'punct' && tok.text === '{') {
      consume();
      const parts: CustomElementTypeExpr[] = [];
      let memberCount = 0;
      let estimatedLength = 4;
      let hasExternalRef = false;
      while (!(peek().kind === 'punct' && peek().text === '}')) {
        const propName = peek();
        let propKey: string;
        if (propName.kind === 'ident' || propName.kind === 'number') {
          consume();
          propKey = propName.text;
        } else if (propName.kind === 'string') {
          consume();
          propKey = JSON.stringify(propName.value!);
        } else {
          return null;
        }
        const optional = matchPunct('?');
        if (!matchPunct(':')) {
          return null;
        }
        const propType = parseType();
        if (propType === null) {
          return null;
        }
        if (memberCount > 0) {
          parts.push('; ');
          estimatedLength += 2;
        }
        const prefix = `${propKey}${optional ? '?' : ''}: `;
        parts.push(prefix, propType.expr);
        estimatedLength += prefix.length + propType.estimatedLength;
        hasExternalRef ||= propType.hasExternalRef;
        memberCount++;
        if (
          !matchPunct(';') &&
          !matchPunct(',') &&
          !(peek().kind === 'punct' && peek().text === '}')
        ) {
          return null;
        }
      }
      consume();
      return checked({
        kind: 'other',
        expr: memberCount === 0 ? '{}' : concatTypeExprs(['{ ', ...parts, ' }']),
        estimatedLength: memberCount === 0 ? 2 : estimatedLength,
        hasExternalRef,
      });
    }
    if (tok.kind === 'ident') {
      consume();
      if (PRIMITIVE_KEYWORDS.has(tok.text)) {
        if (peek().kind === 'punct' && peek().text === '<') {
          return null;
        }
        return {
          kind: tok.text === 'null' || tok.text === 'undefined' ? 'nullish' : 'other',
          expr: tok.text,
          estimatedLength: tok.text.length,
          hasExternalRef: false,
        };
      }
      let typeArgs: TypeAstNode[] | null = null;
      if (matchPunct('<')) {
        typeArgs = [];
        while (true) {
          const arg = parseType();
          if (arg === null) {
            return null;
          }
          typeArgs.push(arg);
          if (!matchPunct(',')) {
            break;
          }
        }
        if (!matchPunct('>')) {
          return null;
        }
      }
      return resolveIdentifier(tok, typeArgs);
    }
    return null;
  };

  const ast = parseType();
  if (ast === null || peek().kind !== 'eof') {
    return {ok: false};
  }

  const literalValues = extractStringLiteralUnion(ast);
  const dedupedLiterals = literalValues !== null ? Array.from(new Set(literalValues)) : null;
  return {
    ok: true,
    checkType: ast.expr,
    isLiteralUnion: dedupedLiterals !== null,
    ...(dedupedLiterals !== null
      ? {
          literalUnionType: dedupedLiterals.map((v) => JSON.stringify(v)).join(' | '),
          stringLiteralValues: dedupedLiterals,
        }
      : {}),
    isExternal,
    usesUnreferencedGlobal,
  };
}

/**
 * Extracts string literal values when `node` is a union of string literals (optionally including
 * `null` or `undefined`). Returns `null` if any non-nullish branch is not a string literal.
 */
function extractStringLiteralUnion(node: TypeAstNode): string[] | null {
  const values: string[] = [];
  const visit = (current: TypeAstNode): boolean => {
    switch (current.kind) {
      case 'paren':
        return visit(current.inner!);
      case 'union':
        return current.members!.every(visit);
      case 'nullish':
        return true;
      case 'stringLiteral':
        values.push(current.stringValue!);
        return true;
      case 'other':
        return false;
    }
  };
  return visit(node) && values.length > 0 ? values : null;
}
