/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/** Test fixtures keep the records relevant to a case visible without repeating CEM wrappers. */
export function createManifest<T>(modules: T, schemaVersion = '1.0.0') {
  return {schemaVersion, modules};
}

export function createManifestModule<T extends object>(path: string, metadata: T) {
  return {kind: 'javascript-module', path, ...metadata};
}

export function createManifestElement<T extends object = Record<never, never>>(
  name: string,
  tagName: string,
  metadata: T = {} as T,
) {
  return {kind: 'class', name, customElement: true, tagName, ...metadata};
}

export function createDefinitionExport(name: string, declarationName: string) {
  return {kind: 'custom-element-definition', name, declaration: {name: declarationName}};
}

/** Builds a module whose custom element declarations each have a matching definition export. */
export function createCustomElementModule<T extends {name: string; tagName: string}>(
  path: string,
  declarations: readonly T[],
) {
  return createManifestModule(path, {
    declarations,
    exports: declarations.map(({name, tagName}) => createDefinitionExport(tagName, name)),
  });
}
