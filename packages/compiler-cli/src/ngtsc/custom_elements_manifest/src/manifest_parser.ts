/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {extractDeclarationSchema, instanceCheckType, readDocs} from './manifest_members';
import {
  CemDeclaration,
  isObject,
  ManifestWarning,
  ParseContext,
  ParsedCustomElementSchema,
} from './schema';

interface TagRegistrationRecord {
  deprecated?: true | string;
  declarationName: string;
  declarationModule: string;
  registrationModule: string;
  source: 'tagName' | 'definition';
}

interface JavaScriptExport {
  name: string;
  module: string;
}

interface ManifestRecords {
  declarations: Map<string, CemDeclaration[]>;
  elements: CemDeclaration[];
  exports: Map<string, JavaScriptExport[]>;
  definitions: Array<{
    tagName: string;
    registration: TagRegistrationRecord;
    externalPackage: string | null;
  }>;
}

/**
 * The result of parsing a Custom Elements Manifest file.
 */
export interface ParsedCustomElementsManifest {
  /** Schemas of the custom elements declared in the manifest. */
  schemas: ParsedCustomElementSchema[];

  /** Human-readable descriptions of fatal problems encountered while parsing. */
  errors: string[];

  /** Non-fatal problems with individual declarations or their type metadata. */
  warnings: ManifestWarning[];
}

/**
 * Reserved hyphenated names that are not valid custom element names, per
 * https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name.
 */
const RESERVED_TAG_NAMES = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

/**
 * Checks the platform's custom element name rules. Names must start with a lowercase ASCII
 * letter, contain a hyphen, and use only `PCENChar` characters. Reserved SVG/MathML names are invalid.
 */
function isValidCustomElementName(tagName: string): boolean {
  // https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name
  const pCenChar =
    /^[a-z][.0-9_a-z\-\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c-\u200d\u203f-\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]*$/u;
  return pCenChar.test(tagName) && tagName.includes('-') && !RESERVED_TAG_NAMES.has(tagName);
}

/** Parses the major component of a complete SemVer 2.0.0 version. */
function parseSemVerMajor(version: string): number | null {
  const identifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
  const match = new RegExp(
    String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
      String.raw`(?:-${identifier}(?:\.${identifier})*)?` +
      String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
  ).exec(version);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

/**
 * Parses a Custom Elements Manifest into schemas for `DomElementSchemaRegistry`.
 *
 * See https://github.com/webcomponents/custom-elements-manifest for the manifest format.
 *
 * Validates the CEM records used for template checking. Invalid records produce warnings and lose
 * only the affected metadata. Invalid JSON or a root that is not a manifest object produces an
 * error. This function does not validate the entire document against the CEM JSON Schema.
 *
 * Supports schema v1 and v2. An invalid or unknown version produces a warning, and parsing
 * continues for supported records. Reads field `readonly` flags and attribute, event, and export
 * `deprecated` flags when present. Mixins without tags produce no schema. Inheritance and mixin
 * references are not expanded.
 *
 * `manifestLabel` identifies the manifest in diagnostics and already includes quotes.
 */
export function parseCustomElementsManifest(
  content: string,
  manifestLabel: string,
  owningPackage: string | null = null,
): ParsedCustomElementsManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content) as unknown;
  } catch (e) {
    return {
      schemas: [],
      errors: [`Failed to parse ${manifestLabel} as JSON: ${(e as Error).message}`],
      warnings: [],
    };
  }

  if (
    !isObject(manifest) ||
    typeof manifest['schemaVersion'] !== 'string' ||
    !Array.isArray(manifest['modules'])
  ) {
    return {
      schemas: [],
      errors: [
        `${manifestLabel} does not appear to be a Custom Elements Manifest: ` +
          `expected an object with a string "schemaVersion" and a "modules" array.`,
      ],
      warnings: [],
    };
  }

  const warnings: ManifestWarning[] = [];
  const context: ParseContext = {
    manifestLabel,
    owningPackage,
    warnings,
  };
  const schemaVersion = manifest['schemaVersion'];
  const schemaMajor = parseSemVerMajor(schemaVersion);
  if (schemaMajor === null || (schemaMajor !== 1 && schemaMajor !== 2)) {
    warnings.push({
      kind: 'invalidStructure',
      subject: 'schemaVersion',
      message:
        `${manifestLabel} declares the Custom Elements Manifest schemaVersion ` +
        `${JSON.stringify(schemaVersion)}, but Angular supports semantic versions with major ` +
        `version 1 or 2. Angular continues by reading its known CEM projection best-effort; ` +
        `metadata whose meaning changed in another version may be ignored.`,
    });
  }
  const records = indexManifest(manifest['modules'], context);
  const {tagsByDeclaration, definitionOnlyTags} = resolveRegistrations(records, context);

  // Validate tag names and extract members. Keep the first declaration of each tag.
  // Invalid names and duplicate tags produce warnings and are skipped.
  const reportedAmbiguousExports = new Set<string>();
  const byTag = new Map<
    string,
    {
      declaration: CemDeclaration;
      registration: TagRegistrationRecord;
      members: Pick<ParsedCustomElementSchema, 'properties' | 'attributes' | 'events'>;
    }
  >();
  for (const [declaration, {tagName, registration}] of tagsByDeclaration) {
    if (!isValidCustomElementName(tagName)) {
      warnings.push({
        kind: 'invalidTagName',
        subject: tagName,
        message:
          `${manifestLabel} declares a custom element '${declaration.name}' with the tag ` +
          `name '${tagName}', which is not a valid custom element name` +
          (tagName.includes('-')
            ? ''
            : ` (custom element names must contain a hyphen; hyphen-free names are ` +
              `reserved for native elements)`) +
          `. The declaration is ignored.`,
      });
      continue;
    }
    const winner = byTag.get(tagName);
    if (winner !== undefined) {
      warnings.push({
        kind: 'duplicateTag',
        subject: tagName,
        message: duplicateRegistrationMessage(
          manifestLabel,
          tagName,
          winner.registration,
          registration,
        ),
      });
      continue;
    }
    const entry = {
      declaration,
      registration,
      members: extractDeclarationSchema(declaration, tagName, context),
    };
    byTag.set(tagName, entry);
  }

  // Tags with unresolved declarations have no custom members. Recognize the tag but continue
  // reporting unknown bindings. Prefer a resolved declaration of the same tag when available.
  const definitionOnlySchemas: ParsedCustomElementSchema[] = [];
  for (const [tagName, {registration, reason}] of definitionOnlyTags) {
    if (byTag.has(tagName)) {
      // A resolved declaration already provides this tag's schema.
      continue;
    }
    if (!isValidCustomElementName(tagName)) {
      warnings.push({
        kind: 'invalidTagName',
        subject: tagName,
        message:
          `${manifestLabel} contains a custom-element-definition export for the tag name ` +
          `'${tagName}', which is not a valid custom element name` +
          (tagName.includes('-')
            ? ''
            : ` (custom element names must contain a hyphen; hyphen-free names are ` +
              `reserved for native elements)`) +
          `. The definition is ignored.`,
      });
      continue;
    }
    warnings.push({
      kind: 'unusableType',
      subject: tagName,
      message:
        `${manifestLabel} registers the custom element tag '${tagName}' through a ` +
        `custom-element-definition export whose declaration '${registration.declarationName}' ${reason}. ` +
        `The tag is recognized, but no custom member metadata is available: unknown bindings ` +
        `remain errors, and local references fall back to HTMLElement.`,
    });
    definitionOnlySchemas.push({
      tagName,
      properties: [],
      attributes: [],
      events: [],
      ...(registration.deprecated !== undefined ? {deprecated: registration.deprecated} : {}),
    });
  }

  const schemas: ParsedCustomElementSchema[] = [];
  for (const [tagName, {declaration, registration, members}] of byTag) {
    const declarationIdentity = declarationKey(declaration.modulePath, declaration.name);
    const declarationExportCandidates = records.exports.get(declarationIdentity);
    const declarationExport = selectJavaScriptExport(
      declarationExportCandidates,
      declaration.name,
      declaration.modulePath,
    );
    if (declarationExport === null && !reportedAmbiguousExports.has(declarationIdentity)) {
      reportedAmbiguousExports.add(declarationIdentity);
      warnings.push({
        kind: 'unusableType',
        subject: `${declaration.modulePath}#${declaration.name}`,
        message:
          `${manifestLabel} maps the custom element declaration '${declaration.name}' in ` +
          `'${declaration.modulePath}' to multiple JavaScript exports ` +
          `(${formatJavaScriptExports(declarationExportCandidates)}), so Angular cannot select ` +
          `a trustworthy element instance type for '${tagName}'. The element schema remains ` +
          `available, but local template references to this element fall back to HTMLElement; ` +
          `other checks are unaffected.`,
      });
    }
    const instanceType =
      declarationExport === null
        ? {}
        : instanceCheckType(
            declarationExport?.name ?? declaration.name,
            declarationExport?.module ?? declaration.modulePath,
            context,
          );
    schemas.push({
      tagName,
      ...members,
      ...instanceType,
      ...readDocs(declaration.node),
      ...(registration.deprecated !== undefined ? {deprecated: registration.deprecated} : {}),
    });
  }
  schemas.push(...definitionOnlySchemas);
  return {schemas, errors: [], warnings};
}

interface DeclarationRegistration {
  tagName: string;
  registration: TagRegistrationRecord;
  hasHomeDefinition: boolean;
}

/** Normalize declaration and export identities once, before resolving their relationships. */
function indexManifest(
  modules: unknown[],
  {manifestLabel, warnings}: ParseContext,
): ManifestRecords {
  const records: ManifestRecords = {
    declarations: new Map(),
    elements: [],
    exports: new Map(),
    definitions: [],
  };
  for (const [index, module] of modules.entries()) {
    if (
      !isObject(module) ||
      module['kind'] !== 'javascript-module' ||
      typeof module['path'] !== 'string'
    ) {
      warnings.push({
        kind: 'invalidStructure',
        subject: `module[${index}]`,
        message:
          `${manifestLabel} contains an invalid module at index ${index}: Angular requires ` +
          `kind "javascript-module" and a string path. The module is ignored; other valid ` +
          `modules remain available.`,
      });
      continue;
    }
    const modulePath = module['path'];
    for (const node of Array.isArray(module['declarations']) ? module['declarations'] : []) {
      if (!isObject(node) || typeof node['name'] !== 'string') {
        continue;
      }
      const declaration: CemDeclaration = {name: node['name'], modulePath, node};
      const key = declarationKey(modulePath, declaration.name);
      if (!records.declarations.has(key)) {
        records.declarations.set(key, []);
      }
      records.declarations.get(key)!.push(declaration);
      if (node['customElement'] === true) {
        records.elements.push(declaration);
      }
    }
    for (const entry of Array.isArray(module['exports']) ? module['exports'] : []) {
      if (
        !isObject(entry) ||
        typeof entry['name'] !== 'string' ||
        !isObject(entry['declaration']) ||
        typeof entry['declaration']['name'] !== 'string'
      ) {
        continue;
      }
      const reference = entry['declaration'];
      const name = reference['name'] as string;
      const target = typeof reference['module'] === 'string' ? reference['module'] : modulePath;
      const externalPackage =
        typeof reference['package'] === 'string' ? reference['package'] : null;
      if (entry['kind'] === 'custom-element-definition') {
        records.definitions.push({
          tagName: entry['name'],
          externalPackage,
          registration: tagRegistration(entry, name, target, modulePath, 'definition'),
        });
      } else if (entry['kind'] === 'js' && externalPackage === null) {
        const key = declarationKey(target, name);
        const candidate = {name: entry['name'], module: modulePath};
        if (!records.exports.has(key)) {
          records.exports.set(key, []);
        }
        const candidates = records.exports.get(key)!;
        if (
          !candidates.some(
            (existing) => existing.name === candidate.name && existing.module === candidate.module,
          )
        ) {
          candidates.push(candidate);
        }
      }
    }
  }
  return records;
}

/**
 * A declaration has one winning registration. One matching home definition may refine its
 * tagName seed. Unresolved definitions are retained separately until resolved schemas are known.
 */
function resolveRegistrations(
  {elements, declarations, definitions}: ManifestRecords,
  {manifestLabel, warnings}: ParseContext,
) {
  const tagsByDeclaration = new Map<CemDeclaration, DeclarationRegistration>();
  const definitionOnlyTags = new Map<
    string,
    {registration: TagRegistrationRecord; reason: string}
  >();
  const duplicate = (
    tagName: string,
    winner: TagRegistrationRecord,
    loser: TagRegistrationRecord,
  ): void => {
    warnings.push({
      kind: 'duplicateTag',
      subject: tagName,
      message: duplicateRegistrationMessage(manifestLabel, tagName, winner, loser),
    });
  };
  for (const declaration of elements) {
    const tagName = declaration.node['tagName'];
    if (typeof tagName === 'string' && tagName.length > 0) {
      tagsByDeclaration.set(declaration, {
        tagName,
        hasHomeDefinition: false,
        registration: tagRegistration(
          declaration.node,
          declaration.name,
          declaration.modulePath,
          declaration.modulePath,
          'tagName',
        ),
      });
    }
  }
  for (const {tagName, registration, externalPackage} of definitions) {
    const referenced =
      externalPackage === null
        ? declarations.get(
            declarationKey(registration.declarationModule, registration.declarationName),
          )
        : undefined;
    if (referenced === undefined) {
      const winner = definitionOnlyTags.get(tagName);
      if (winner !== undefined) {
        duplicate(tagName, winner.registration, registration);
      } else {
        definitionOnlyTags.set(tagName, {
          registration,
          reason:
            externalPackage === null
              ? 'cannot be found in the manifest'
              : `is declared in another package ('${externalPackage}')`,
        });
      }
      continue;
    }
    for (const declaration of referenced) {
      const next = {...registration, declarationModule: declaration.modulePath};
      let tag = tagsByDeclaration.get(declaration);
      if (tag === undefined) {
        tag = {tagName, registration: next, hasHomeDefinition: false};
        tagsByDeclaration.set(declaration, tag);
      } else if (tag.tagName !== tagName) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${registration.declarationName}#${tagName}`,
          message:
            `${manifestLabel} associates ${formatTagRegistration(tag.registration)} with the tag ` +
            `'${tag.tagName}', but ${formatTagRegistration(next)} attempts to ` +
            `register the same declaration as '${tagName}'. A custom element ` +
            `declaration can have only one tag, so the first registration is retained and ` +
            `the conflicting registration is ignored.`,
        });
      } else if (
        tag.registration.source === 'tagName' &&
        next.registrationModule === declaration.modulePath
      ) {
        tag.registration = next;
      } else {
        duplicate(tagName, tag.registration, next);
      }
      if (next.registrationModule === declaration.modulePath && tag.tagName === tagName) {
        tag.hasHomeDefinition = true;
      }
    }
  }
  for (const declaration of elements) {
    const tagName = declaration.node['tagName'];
    if (
      typeof tagName === 'string' &&
      tagName.length > 0 &&
      isValidCustomElementName(tagName) &&
      !tagsByDeclaration.get(declaration)?.hasHomeDefinition
    ) {
      warnings.push({
        kind: 'invalidStructure',
        subject: tagName,
        message:
          `${manifestLabel} declares the self-registering custom element '${tagName}', but its ` +
          `module has no matching custom-element-definition export. The declaration remains ` +
          `available, but the manifest should include the required definition export.`,
      });
    }
  }
  return {tagsByDeclaration, definitionOnlyTags};
}

function declarationKey(modulePath: string, name: string): string {
  return `${modulePath.replace(/^\.\//, '')}\0${name}`;
}

function formatJavaScriptExports(candidates: JavaScriptExport[] | undefined): string {
  return (candidates ?? [])
    .slice(0, 3)
    .map((candidate) => `'${candidate.name}' from '${candidate.module}'`)
    .join(', ');
}

/**
 * Selects a declaration's JavaScript export without depending on manifest order. Prefers the
 * declared name, then a single non-default alias, then a sole default export.
 * For multiple exports of the declared name, selects the one from `homeModule`.
 * Returns `null` when the exports do not identify a unique choice.
 */
function selectJavaScriptExport(
  candidates: JavaScriptExport[] | undefined,
  declarationName: string,
  homeModule: string,
): JavaScriptExport | null | undefined {
  if (candidates === undefined || candidates.length === 0) {
    return undefined;
  }
  const exact = candidates.filter((candidate) => candidate.name === declarationName);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    // The export index deduplicates name/module pairs, so at most one match comes from homeModule.
    const home = exact.filter((candidate) => candidate.module === homeModule);
    return home.length === 1 ? home[0] : null;
  }
  const nonDefault = candidates.filter((candidate) => candidate.name !== 'default');
  if (nonDefault.length === 1) {
    return nonDefault[0];
  }
  if (nonDefault.length > 1) {
    return null;
  }
  const defaults = candidates.filter((candidate) => candidate.name === 'default');
  return defaults.length === 1 ? defaults[0] : null;
}

function tagRegistration(
  entry: {[key: string]: unknown},
  declarationName: string,
  declarationModule: string,
  registrationModule: string,
  source: TagRegistrationRecord['source'],
): TagRegistrationRecord {
  const deprecated = entry['deprecated'];
  return {
    declarationName,
    declarationModule,
    registrationModule,
    source,
    ...(deprecated === true || (typeof deprecated === 'string' && deprecated.length > 0)
      ? {deprecated}
      : {}),
  };
}

function formatTagRegistration(registration: TagRegistrationRecord): string {
  const origin =
    registration.source === 'tagName'
      ? `its tagName in module '${registration.registrationModule}'`
      : `a definition export in module '${registration.registrationModule}'`;
  return (
    `declaration '${registration.declarationName}' in module ` +
    `'${registration.declarationModule}' through ${origin}`
  );
}

function duplicateRegistrationMessage(
  manifestLabel: string,
  tagName: string,
  winner: TagRegistrationRecord,
  loser: TagRegistrationRecord,
): string {
  return (
    `${manifestLabel} registers the custom element tag '${tagName}' more than once: ` +
    `${formatTagRegistration(winner)} is retained, while ${formatTagRegistration(loser)} is ` +
    `ignored. A tag can only be registered once, so the first registration wins.`
  );
}
