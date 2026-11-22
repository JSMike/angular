/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  buildClassImportCandidates,
  buildModuleSpecifiers,
  MAX_TYPE_TEXT_LENGTH,
  parseManifestType,
} from '../src/type_grammar';

describe('custom elements manifest type grammar', () => {
  it('should parse primitives, literals, unions, arrays, and simple object literals', () => {
    expect(parseManifestType({text: 'string | number | boolean'}, null, '', null)).toEqual({
      ok: true,
      checkType: 'string | number | boolean',
      isLiteralUnion: false,
      isExternal: false,
      usesUnreferencedGlobal: false,
    });

    expect(
      parseManifestType({text: '| \'primary\' | "danger" | undefined'}, null, '', null),
    ).toEqual({
      ok: true,
      checkType: '"primary" | "danger" | undefined',
      isLiteralUnion: true,
      literalUnionType: '"primary" | "danger"',
      isExternal: false,
      usesUnreferencedGlobal: false,
    });

    expect(parseManifestType({text: '(-1 | 0 | 2.5)[]'}, null, '', null)).toEqual({
      ok: true,
      checkType: '(-1 | 0 | 2.5)[]',
      isLiteralUnion: false,
      isExternal: false,
      usesUnreferencedGlobal: false,
    });

    expect(parseManifestType({text: '{ id: string; count?: number }'}, null, '', null)).toEqual({
      ok: true,
      checkType: '{ id: string; count?: number }',
      isLiteralUnion: false,
      isExternal: false,
      usesUnreferencedGlobal: false,
    });
  });

  it('should resolve exact lib.dom globals, guard external CustomEvent detail args, and reject imaginary HTML*Element names', () => {
    expect(
      parseManifestType({text: 'CustomEvent<HTMLButtonElement | null>'}, null, '', null),
    ).toEqual({
      ok: true,
      checkType: {
        kind: 'concat',
        parts: [
          'globalThis.CustomEvent<',
          {kind: 'customEventDetail', inner: 'globalThis.HTMLButtonElement | null'},
          '>',
        ],
      },
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: true,
    });

    // Bare CustomEvent and literal CustomEvent<any>/CustomEvent<number> stay unguarded.
    expect(parseManifestType({text: 'CustomEvent'}, null, '', null)).toEqual({
      ok: true,
      checkType: 'globalThis.CustomEvent',
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: true,
    });
    expect(parseManifestType({text: 'CustomEvent<any>'}, null, '', null)).toEqual({
      ok: true,
      checkType: 'globalThis.CustomEvent<any>',
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: true,
    });
    expect(parseManifestType({text: 'CustomEvent<number>'}, null, '', null)).toEqual({
      ok: true,
      checkType: 'globalThis.CustomEvent<number>',
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: true,
    });

    expect(parseManifestType({text: 'HTMLFakeCustomElement'}, null, '', null)).toEqual({ok: false});
  });

  it('should resolve explicit type.references including global:, package imports, and dist fallback', () => {
    expect(
      parseManifestType(
        {
          text: 'GlobalCustomPayload',
          references: [{name: 'GlobalCustomPayload', package: 'global:'}],
        },
        null,
        '',
        null,
      ),
    ).toEqual({
      ok: true,
      checkType: 'globalThis.GlobalCustomPayload',
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: false,
    });

    expect(
      parseManifestType(
        {
          text: 'ButtonVariant',
          references: [{name: 'ButtonVariant', module: 'components/button.js', start: 0, end: 13}],
        },
        '@shoelace/lib',
        'dist',
        'components/button.js',
      ),
    ).toEqual({
      ok: true,
      checkType: {
        kind: 'import',
        candidates: [
          {specifier: '@shoelace/lib/components/button.js', exportName: 'ButtonVariant'},
          {specifier: '@shoelace/lib/dist/components/button.js', exportName: 'ButtonVariant'},
        ],
      },
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: false,
    });

    expect(
      parseManifestType(
        {
          text: 'CustomEvent<DetailPayload>',
          references: [{name: 'DetailPayload', module: 'events.js'}],
        },
        '@shoelace/lib',
        '',
        'components/button.js',
      ),
    ).toEqual({
      ok: true,
      checkType: {
        kind: 'concat',
        parts: [
          'globalThis.CustomEvent<',
          {
            kind: 'customEventDetail',
            inner: {
              kind: 'import',
              candidates: [{specifier: '@shoelace/lib/events.js', exportName: 'DetailPayload'}],
            },
          },
          '>',
        ],
      },
      isLiteralUnion: false,
      isExternal: true,
      usesUnreferencedGlobal: true,
    });
  });

  it('should cap nested generic _CemFirst expansion to prevent exponential blowup', () => {
    const depth = 20;
    const text = 'A<'.repeat(depth) + 'string' + '>'.repeat(depth);
    const start = performance.now();
    const result = parseManifestType(
      {text, references: [{name: 'A', module: 'components/a.js'}]},
      '@lib/el',
      'dist',
      'components/a.js',
    );
    const elapsedMs = performance.now() - start;
    expect(result).toEqual({ok: false});
    expect(elapsedMs).toBeLessThan(50);
  });

  it('should reject unreferenced unknown identifiers, unsupported syntax, and injection attempts', () => {
    const rejected = [
      '',
      '   ',
      'UnknownLocalType',
      'string; console.log(1)',
      'typeof window',
      'import("fs").ReadStream',
      '(a: string) => void',
      '[string, number]',
      'string & number',
      '{ [k: string]: string }',
      'readonly string[]',
      'string<number>',
      'a'.repeat(MAX_TYPE_TEXT_LENGTH + 1),
      '"unterminated',
      '{"a": "b\\x41"}',
    ];
    for (const text of rejected) {
      expect(parseManifestType({text}, '@pkg/a', '', 'index.js'))
        .withContext(`expected rejection for ${JSON.stringify(text)}`)
        .toEqual({ok: false});
    }
  });

  it('should reject invalid package paths, traversal, and .ts extensions in module specifiers', () => {
    expect(buildModuleSpecifiers('@pkg/lib', '@pkg/lib', 'dist', 'src/btn.ts')).toEqual([]);
    expect(buildModuleSpecifiers('@pkg/lib', '@pkg/lib', 'dist', '../outside.js')).toEqual([]);
    expect(buildModuleSpecifiers('../evil', '@pkg/lib', '', 'btn.js')).toEqual([]);
    expect(buildClassImportCandidates('@pkg/lib', 'dist', 'btn.js', 'MyBtn')).toEqual([
      {specifier: '@pkg/lib/btn.js', exportName: 'MyBtn'},
      {specifier: '@pkg/lib/dist/btn.js', exportName: 'MyBtn'},
    ]);
  });
});
