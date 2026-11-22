/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

export {
  CustomElementsManifestLoadResult,
  CustomElementsManifestParseCache,
  loadCustomElementsManifests,
} from './src/loader';
export {parseCustomElementsManifest, ParsedCustomElementsManifest} from './src/manifest_parser';
export {
  ManifestResolutionKind,
  ManifestResolutionResult,
  resolveCustomElementsManifest,
} from './src/manifest_resolver';
export {
  buildClassImportCandidates,
  parseManifestType,
  ParsedManifestType,
} from './src/type_grammar';
