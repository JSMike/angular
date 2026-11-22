/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  CustomElementImportCandidate,
  CustomElementsManifestSchema,
  CustomElementTypeExpr,
  normalizeCustomElementTagName,
} from '../../schema/custom_elements_manifest_schema';
import {CemImportReachability} from '../api';
import {TcbExpr} from './codegen';

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type CemHelperName =
  | '_CemTag'
  | '_CemFirst'
  | '_CemUnresolvedElement'
  | '_CemIndexSafe'
  | '_CemEl'
  | '_CemGatedEl'
  | '_CemEvTarget'
  | '_CemPropTarget'
  | '_CemManifestOrClass'
  | '_CemClassOrManifest'
  | '_CemDomPropTarget'
  | '_CemAttrValues'
  | '_CemAttr'
  | '_CemEvDetail'
  | '_CemEv';

/**
 * Helper type aliases emitted lazily (only those actually referenced) inside a type-check file
 * (or locally inside an inline TCB) when checking custom elements from a Custom Elements Manifest.
 * They have no template parse-span comments, so unresolved `import()` diagnostics inside aliases
 * are silently dropped by Angular's diagnostic translator, while `[unknown] extends [T]` detects
 * TypeScript's `errorType` / `any` / `unknown` and degrades cleanly.
 */
export const CEM_TCB_HELPERS: Record<
  CemHelperName,
  {readonly decl: string; readonly deps?: readonly CemHelperName[]}
> = {
  _CemTag: {
    decl: 'type _CemTag<K extends string, F> = globalThis.HTMLElementTagNameMap extends {readonly [P in K]: infer E} ? ([unknown] extends [E] ? F : E) : F',
  },
  _CemFirst: {
    decl: 'type _CemFirst<A, B> = [unknown] extends [A] ? B : [A] extends [never] ? B : A',
  },
  _CemUnresolvedElement: {
    decl: 'interface _CemUnresolvedElement<Tag extends string> extends globalThis.HTMLElement {}',
  },
  _CemIndexSafe: {
    decl: 'type _CemIndexSafe<T, K extends string> = T extends {readonly [k: string]: unknown} ? (string extends keyof T ? (K extends keyof {[P in keyof T as string extends P ? never : P]: any} ? T : K extends keyof T ? ((<U>() => U extends {[k: string]: T[string & keyof T]} ? 1 : 2) extends (<U>() => U extends {[P in keyof T as string extends P ? P : never]: T[P]} ? 1 : 2) ? {[P in K]: T[K]} : {readonly [P in K]: T[K]}) : T) : T) : T',
  },
  _CemEl: {
    decl: 'type _CemEl<T, Tag extends string, K extends string = never, H = globalThis.HTMLElement> = [unknown] extends [T] ? _CemUnresolvedElement<Tag> : [T] extends [never] ? _CemUnresolvedElement<Tag> : [K] extends [never] ? (([T] extends [{readonly nodeType: infer N; readonly tagName: infer G; readonly shadowRoot: infer S}] ? ([unknown] extends [N] ? 0 : [unknown] extends [G] ? 0 : [unknown] extends [S] ? 0 : [N, G] extends [number, string] ? 1 : 0) : 0) extends 1 ? T : T & {[P in keyof H as P extends keyof T ? never : P]: H[P]}) : _CemIndexSafe<_CemEl<T, Tag>, K>',
    deps: ['_CemUnresolvedElement', '_CemIndexSafe'],
  },
  _CemGatedEl: {
    decl: 'type _CemGatedEl<T, Tag extends string, K extends string> = [unknown] extends [T] ? any : [T] extends [never] ? any : _CemEl<T, Tag, K>',
    deps: ['_CemEl'],
  },
  _CemEvTarget: {
    decl: 'type _CemEvTarget<T> = T extends {addEventListener: infer F} ? ([unknown] extends [F] ? globalThis.HTMLElement : [F] extends [(...args: any[]) => any] ? (T extends {readonly [k: string]: unknown} ? (string extends keyof T ? ("addEventListener" extends keyof {[P in keyof T as string extends P ? never : P]: any} ? T : globalThis.HTMLElement) : T) : T) : globalThis.HTMLElement) : globalThis.HTMLElement',
  },
  _CemPropTarget: {
    decl: 'type _CemPropTarget<T, K extends string> = [unknown] extends [T] ? any : [T] extends [never] ? any : K extends keyof T ? _CemIndexSafe<T, K> : any',
    deps: ['_CemIndexSafe'],
  },
  _CemManifestOrClass: {
    decl: 'type _CemManifestOrClass<M, T, K extends string> = [unknown] extends [M] ? _CemPropTarget<T, K> : {[P in K]: M}',
    deps: ['_CemPropTarget'],
  },
  _CemClassOrManifest: {
    decl: 'type _CemClassOrManifest<T, K extends string, M> = [unknown] extends [T] ? ([unknown] extends [M] ? any : {[P in K]: M}) : [T] extends [never] ? ([unknown] extends [M] ? any : {[P in K]: M}) : K extends keyof T ? _CemIndexSafe<T, K> : [unknown] extends [M] ? any : {[P in K]: M}',
    deps: ['_CemIndexSafe'],
  },
  _CemDomPropTarget: {
    decl: 'type _CemDomPropTarget<T, K extends string> = [unknown] extends [T] ? any : [T] extends [never] ? any : K extends keyof T ? (K extends keyof globalThis.HTMLElement ? (globalThis.HTMLElement[K] extends T[K] ? any : _CemIndexSafe<T, K>) : _CemIndexSafe<T, K>) : any',
    deps: ['_CemIndexSafe'],
  },
  _CemAttrValues: {
    decl: 'type _CemAttrValues<V> = [unknown] extends [V] ? string : [V] extends [never] ? string : [V] extends [string] ? (string extends V ? string : `${V}`) : string',
  },
  _CemAttr: {
    decl: 'type _CemAttr<T, K extends string> = [unknown] extends [T] ? string : [T] extends [never] ? string : K extends keyof T ? _CemAttrValues<Exclude<T[K], undefined | null>> : string',
    deps: ['_CemAttrValues'],
  },
  _CemEvDetail: {
    decl: 'type _CemEvDetail<T> = [unknown] extends [T] ? unknown : [T] extends [never] ? unknown : T',
  },
  _CemEv: {
    decl: 'type _CemEv<T> = [unknown] extends [T] ? globalThis.Event : [T] extends [never] ? globalThis.Event : T extends globalThis.Event ? T : globalThis.Event',
  },
};

/**
 * Builds the raw class type expression for a custom element tag purely from manifest data, gating
 * each candidate `import(...)` against `getImportReachability` when provided, and records which
 * `_Cem*` helpers it requires.
 */
export function buildCustomElementRawTypeExpr(
  tagName: string,
  schema: CustomElementsManifestSchema,
  useHelper: (name: CemHelperName) => void,
  getImportReachability?: (specifier: string) => CemImportReachability,
): {readonly expr: string; readonly hasGatedClassImport: boolean} {
  const quotedTag = TcbExpr.quoteAndEscape(normalizeCustomElementTagName(tagName));
  useHelper('_CemTag');
  const candidates = schema.classImports ?? [];
  const imports: CustomElementImportCandidate[] = [];
  let hasGatedCandidate = false;
  for (const candidate of candidates) {
    const reachability =
      getImportReachability === undefined
        ? 'reachable'
        : getImportReachability(candidate.specifier);
    if (reachability === 'reachable') {
      imports.push(candidate);
    } else if (reachability === 'gated') {
      hasGatedCandidate = true;
    }
  }
  if (imports.length === 0) {
    return {
      expr: `_CemTag<${quotedTag}, unknown>`,
      hasGatedClassImport: hasGatedCandidate,
    };
  }
  let fallback = `import(${TcbExpr.quoteAndEscape(imports[imports.length - 1].specifier)}).${imports[imports.length - 1].exportName}`;
  for (let i = imports.length - 2; i >= 0; i--) {
    useHelper('_CemFirst');
    const candidate = `import(${TcbExpr.quoteAndEscape(imports[i].specifier)}).${imports[i].exportName}`;
    fallback = `_CemFirst<${candidate}, ${fallback}>`;
  }
  return {
    expr: `_CemTag<${quotedTag}, ${fallback}>`,
    hasGatedClassImport: false,
  };
}

/**
 * Renders a structured `CustomElementTypeExpr` into TypeScript type text, gating each candidate
 * `import(...)` specifier through `getImportReachability` when provided and queuing any needed
 * `_Cem*` helpers. Unreachable module references degrade to `'unknown'` without emitting
 * `import(...)`.
 */
export function renderCustomElementTypeExpr(
  expr: CustomElementTypeExpr,
  useHelper: (name: CemHelperName) => void,
  getImportReachability?: (specifier: string) => CemImportReachability,
): string {
  const render = (node: CustomElementTypeExpr): {text: string; hadGatedImport: boolean} => {
    if (typeof node === 'string') {
      return {text: node, hadGatedImport: false};
    }
    switch (node.kind) {
      case 'concat': {
        let text = '';
        let hadGatedImport = false;
        for (const part of node.parts) {
          const rendered = render(part);
          text += rendered.text;
          hadGatedImport ||= rendered.hadGatedImport;
        }
        return {text, hadGatedImport};
      }
      case 'customEventDetail': {
        const inner = render(node.inner);
        // When a package is intentionally gated out (not imported in user TS, e.g. CDN or
        // spec-only compilation), fall back to `any` so valid `$event.detail.*` accesses do not
        // produce false TS2571 errors. When the module IS imported (or `global:`) and the detail
        // export/global is missing, `_CemEvDetail` degrades it to `unknown`.
        if (inner.hadGatedImport || inner.text === 'unknown') {
          return {text: 'any', hadGatedImport: inner.hadGatedImport};
        }
        useHelper('_CemEvDetail');
        return {text: `_CemEvDetail<${inner.text}>`, hadGatedImport: false};
      }
      case 'import': {
        const reachable =
          getImportReachability === undefined
            ? node.candidates
            : node.candidates.filter((c) => getImportReachability(c.specifier) === 'reachable');
        if (reachable.length === 0) {
          return {text: 'unknown', hadGatedImport: true};
        }
        let argsSuffix = '';
        let hadGatedImport = false;
        if (node.typeArgs !== undefined && node.typeArgs.length > 0) {
          const renderedArgs: string[] = [];
          for (const arg of node.typeArgs) {
            const rendered = render(arg);
            renderedArgs.push(rendered.text);
            hadGatedImport ||= rendered.hadGatedImport;
          }
          argsSuffix = `<${renderedArgs.join(', ')}>`;
        }
        let text = `import(${TcbExpr.quoteAndEscape(reachable[reachable.length - 1].specifier)}).${reachable[reachable.length - 1].exportName}${argsSuffix}`;
        for (let i = reachable.length - 2; i >= 0; i--) {
          useHelper('_CemFirst');
          const candidate = `import(${TcbExpr.quoteAndEscape(reachable[i].specifier)}).${reachable[i].exportName}${argsSuffix}`;
          text = `_CemFirst<${candidate}, ${text}>`;
        }
        return {text, hadGatedImport};
      }
    }
  };
  return render(expr).text;
}

/** Whether `name` is a plain JavaScript identifier safe for dot property access. */
export function isValidJsIdentifier(name: string): boolean {
  return VALID_JS_IDENTIFIER.test(name);
}

/** Formats a property access using dot notation only for valid JS identifiers. */
export function formatCustomElementPropertyAccess(targetExpr: string, propName: string): string {
  return isValidJsIdentifier(propName)
    ? `${targetExpr}.${propName}`
    : `${targetExpr}[${TcbExpr.quoteAndEscape(propName)}]`;
}
