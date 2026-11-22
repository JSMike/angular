/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {parseCustomElementsManifest} from '../src/manifest_parser';

describe('custom elements manifest parser', () => {
  it('should parse properties, attributes, events, unbindable members, and default exports', () => {
    const manifest = {
      schemaVersion: '2.1.0',
      modules: [
        {
          kind: 'javascript-module',
          path: 'components/button.js',
          declarations: [
            {
              kind: 'class',
              name: 'MyButton',
              customElement: true,
              tagName: 'my-button',
              description: 'A button',
              members: [
                {
                  kind: 'field',
                  name: 'variant',
                  attribute: 'variant',
                  type: {text: "'primary' | 'danger'"},
                },
                {
                  kind: 'field',
                  name: 'disabled',
                  attribute: 'disabled',
                  type: {text: 'boolean'},
                },
                {kind: 'field', name: 'internal', privacy: 'private', type: {text: 'string'}},
                {kind: 'field', name: 'readOnlyProp', readonly: true, type: {text: 'number'}},
                {kind: 'field', name: 'staticProp', static: true, type: {text: 'string'}},
              ],
              attributes: [
                {name: 'variant', fieldName: 'variant', type: {text: "'primary' | 'danger'"}},
                {name: 'disabled', fieldName: 'disabled', type: {text: 'boolean'}},
                {name: 'size', type: {text: "'sm' | 'lg'"}},
              ],
              events: [
                {
                  name: 'my-change',
                  type: {text: 'CustomEvent<boolean>'},
                },
              ],
            },
          ],
          exports: [
            {kind: 'custom-element-definition', name: 'my-button', declaration: {name: 'MyButton'}},
            {kind: 'js', name: 'default', declaration: {name: 'MyButton'}},
          ],
        },
      ],
    };

    const result = parseCustomElementsManifest(
      JSON.stringify(manifest),
      "'@pkg/ui'",
      '@pkg/ui',
      'dist',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.schemas.length).toBe(1);

    const schema = result.schemas[0];
    expect(schema.tagName).toBe('my-button');
    expect(schema.isPackageManifest).toBeTrue();
    expect(schema.classImports).toEqual([
      {specifier: '@pkg/ui/components/button.js', exportName: 'default'},
      {specifier: '@pkg/ui/dist/components/button.js', exportName: 'default'},
    ]);
    expect(schema.properties.map((p) => [p.name, p.checkType])).toEqual([
      ['variant', '"primary" | "danger"'],
      ['disabled', 'boolean'],
    ]);
    expect(schema.unbindableProperties).toEqual(['internal', 'readOnlyProp', 'staticProp']);
    expect(schema.attributes).toEqual([
      {
        name: 'variant',
        typeText: "'primary' | 'danger'",
        checkType: '"primary" | "danger"',
        checkTypeIsLiteralUnion: true,
        stringLiteralValues: ['primary', 'danger'],
      },
      {name: 'disabled', typeText: 'boolean'},
      {
        name: 'size',
        typeText: "'sm' | 'lg'",
        checkType: '"sm" | "lg"',
        checkTypeIsLiteralUnion: true,
        stringLiteralValues: ['sm', 'lg'],
      },
    ]);
    expect(schema.events).toEqual([
      {
        name: 'my-change',
        typeText: 'CustomEvent<boolean>',
        checkType: 'globalThis.CustomEvent<boolean>',
        checkTypeIsExternal: true,
        checkTypeUsesUnreferencedGlobal: true,
      },
    ]);
  });

  it('should report errors on malformed JSON or missing schemaVersion/modules', () => {
    const badJson = parseCustomElementsManifest('{not json', "'bad.json'");
    expect(badJson.errors.length).toBe(1);
    expect(badJson.errors[0]).toContain('is not valid JSON');

    const badShape = parseCustomElementsManifest('{"modules": []}', "'bad.json'");
    expect(badShape.errors.length).toBe(1);
    expect(badShape.errors[0]).toContain('schemaVersion');
  });

  it('should warn on unsupported schema versions, invalid tag names, and unknown fieldName', () => {
    const manifest = {
      schemaVersion: '3.0.0',
      modules: [
        {
          kind: 'javascript-module',
          path: 'el.js',
          declarations: [
            {
              kind: 'class',
              name: 'BadTag',
              customElement: true,
              tagName: 'notcustom',
            },
            {
              kind: 'class',
              name: 'GoodTag',
              customElement: true,
              tagName: 'good-tag',
              members: [{kind: 'field', name: 'x', type: {text: 'SomeUnknownType'}}],
              attributes: [{name: 'orphan', fieldName: 'missingField'}],
            },
          ],
        },
      ],
    };

    const result = parseCustomElementsManifest(JSON.stringify(manifest), "'./el.json'");
    expect(result.errors).toEqual([]);
    expect(result.schemas.map((s) => s.tagName)).toEqual(['good-tag']);
    expect(result.warnings.some((w) => w.includes('schemaVersion'))).toBeTrue();
    expect(
      result.warnings.some((w) => w.includes("invalid custom element tag name 'notcustom'")),
    ).toBeTrue();
    expect(
      result.warnings.some((w) => w.includes("unsupported type on property 'good-tag.x'")),
    ).toBeTrue();
    expect(result.warnings.some((w) => w.includes("unknown fieldName 'missingField'"))).toBeTrue();
  });

  it('should match custom-element-definition exports whose declaration module has a leading slash', () => {
    const manifest = {
      schemaVersion: '2.1.0',
      modules: [
        {
          kind: 'javascript-module',
          path: 'src/Button.js',
          declarations: [
            {
              kind: 'class',
              name: 'Button',
              customElement: true,
              members: [{kind: 'field', name: 'disabled', type: {text: 'boolean'}}],
            },
          ],
          exports: [
            {kind: 'js', name: 'Button', declaration: {name: 'Button', module: 'src/Button.js'}},
          ],
        },
        {
          kind: 'javascript-module',
          path: 'sp-button.js',
          exports: [
            {
              kind: 'custom-element-definition',
              name: 'sp-button',
              declaration: {name: 'Button', module: '/src/Button.js'},
            },
          ],
        },
      ],
    };

    const result = parseCustomElementsManifest(
      JSON.stringify(manifest),
      "'@pkg/button'",
      '@pkg/button',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.schemas.length).toBe(1);
    expect(result.schemas[0].tagName).toBe('sp-button');
    expect(result.schemas[0].properties.map((p) => p.name)).toEqual(['disabled']);
    expect(result.schemas[0].classImports).toEqual([
      {specifier: '@pkg/button/src/Button.js', exportName: 'Button'},
    ]);
  });

  it('should omit checkType for top-level any/unknown properties and primitive event placeholders', () => {
    const manifest = {
      schemaVersion: '2.1.0',
      modules: [
        {
          kind: 'javascript-module',
          path: 'el.js',
          declarations: [
            {
              kind: 'class',
              name: 'LooseEl',
              customElement: true,
              tagName: 'loose-el',
              members: [
                {kind: 'field', name: 'looseAny', type: {text: 'any'}},
                {kind: 'field', name: 'looseUnknown', type: {text: 'unknown'}},
              ],
              events: [
                {name: 'click', type: {text: 'void'}},
                {name: 'change', type: {text: 'boolean'}},
              ],
            },
          ],
        },
      ],
    };

    const result = parseCustomElementsManifest(JSON.stringify(manifest), "'./el.json'");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.schemas[0].properties).toEqual([
      {name: 'looseAny', typeText: 'any'},
      {name: 'looseUnknown', typeText: 'unknown'},
    ]);
    expect(result.schemas[0].events).toEqual([
      {name: 'click', typeText: 'void'},
      {name: 'change', typeText: 'boolean'},
    ]);
  });
});
