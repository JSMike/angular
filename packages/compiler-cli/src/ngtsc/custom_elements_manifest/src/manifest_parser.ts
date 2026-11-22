/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  CustomElementAttributeSchema,
  CustomElementCheckTypeMetadata,
  CustomElementEventSchema,
  CustomElementPropertySchema,
  CustomElementsManifestSchema,
} from '@angular/compiler';

import {buildClassImportCandidates, parseManifestType, ParsedManifestType} from './type_grammar';

export interface ParsedCustomElementsManifest {
  readonly schemas: CustomElementsManifestSchema[];
  readonly errors: string[];
  readonly warnings: string[];
}

enum TagRegistrationSource {
  TagName,
  Definition,
}

interface TagRegistrationRecord {
  deprecated?: true | string;
  declarationName: string;
  declarationModule: string;
  registrationModule: string;
  source: TagRegistrationSource;
}

interface ManifestDeclaration {
  readonly name: string;
  readonly modulePath: string;
  readonly node: {[key: string]: unknown};
}

interface JavaScriptExport {
  readonly name: string;
  readonly module: string;
}

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

const PCEN_CHAR =
  /^[a-z][.0-9_a-z\-\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c-\u200d\u203f-\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]*$/u;

function isValidCustomElementName(tagName: string): boolean {
  return PCEN_CHAR.test(tagName) && tagName.includes('-') && !RESERVED_TAG_NAMES.has(tagName);
}

function isObject(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeTextOf(type: unknown): string | undefined {
  return isObject(type) && typeof type['text'] === 'string' ? type['text'] : undefined;
}

function trimmedTypeTextOf(type: unknown): string | undefined {
  const text = typeTextOf(type)?.trim();
  return text !== undefined && text.length > 0 ? text : undefined;
}

function declarationKey(modulePath: string, name: string): string {
  return `${modulePath.replace(/^(?:\.\/|\/)+/, '')}\0${name}`;
}

/**
 * Parses a Custom Elements Manifest JSON string into lightweight element schemas using a closed
 * TypeScript type grammar (no TypeScript program or TypeChecker needed).
 */
export function parseCustomElementsManifest(
  content: string,
  manifestLabel: string,
  owningPackage: string | null = null,
  manifestRelativeDir = '',
): ParsedCustomElementsManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content) as unknown;
  } catch (e) {
    return {
      schemas: [],
      errors: [
        `Custom Elements Manifest ${manifestLabel} is not valid JSON: ${(e as Error).message}`,
      ],
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
        `Custom Elements Manifest ${manifestLabel} is invalid: expected a JSON object with a ` +
          `string "schemaVersion" and a "modules" array.`,
      ],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  if (!/^[12]\./.test(manifest['schemaVersion'])) {
    warnings.push(
      `unsupported "schemaVersion" ${JSON.stringify(manifest['schemaVersion'])} (expected 1.x or 2.x)`,
    );
  }

  const modules: Array<{path: string; [key: string]: unknown}> = [];
  for (const [index, mod] of manifest['modules'].entries()) {
    if (!isObject(mod) || mod['kind'] !== 'javascript-module' || typeof mod['path'] !== 'string') {
      warnings.push(`module[${index}] is missing "kind": "javascript-module" or a string "path"`);
      continue;
    }
    modules.push(mod as {path: string; [key: string]: unknown});
  }

  const declarationsByModuleAndName = new Map<string, ManifestDeclaration[]>();
  const customElementDeclarations: ManifestDeclaration[] = [];
  for (const mod of modules) {
    if (!Array.isArray(mod['declarations'])) {
      continue;
    }
    for (const node of mod['declarations']) {
      if (!isObject(node) || typeof node['name'] !== 'string') {
        continue;
      }
      const declaration: ManifestDeclaration = {name: node['name'], modulePath: mod.path, node};
      if (node['customElement'] === true) {
        customElementDeclarations.push(declaration);
      }
      const key = declarationKey(mod.path, declaration.name);
      const list = declarationsByModuleAndName.get(key);
      if (list !== undefined) {
        list.push(declaration);
      } else {
        declarationsByModuleAndName.set(key, [declaration]);
      }
    }
  }

  // Index `js` exports so we know the exported symbol name (including `default`) for each class.
  const exportsByDecl = new Map<string, JavaScriptExport[]>();
  for (const mod of modules) {
    if (!Array.isArray(mod['exports'])) {
      continue;
    }
    for (const exp of mod['exports']) {
      if (
        !isObject(exp) ||
        exp['kind'] !== 'js' ||
        typeof exp['name'] !== 'string' ||
        !isObject(exp['declaration']) ||
        typeof exp['declaration']['name'] !== 'string' ||
        typeof exp['declaration']['package'] === 'string'
      ) {
        continue;
      }
      const declModule =
        typeof exp['declaration']['module'] === 'string' ? exp['declaration']['module'] : mod.path;
      const key = declarationKey(declModule, exp['declaration']['name']);
      const candidate: JavaScriptExport = {name: exp['name'], module: mod.path};
      const existing = exportsByDecl.get(key);
      if (existing === undefined) {
        exportsByDecl.set(key, [candidate]);
      } else if (
        !existing.some((e) => e.name === candidate.name && e.module === candidate.module)
      ) {
        existing.push(candidate);
      }
    }
  }

  const {tagsByDeclaration, definitionOnlyTags} = resolveRegistrations(
    modules,
    customElementDeclarations,
    declarationsByModuleAndName,
    warnings,
  );

  const byTag = new Map<
    string,
    {
      declaration: ManifestDeclaration;
      registration: TagRegistrationRecord;
      properties: Map<string, CustomElementPropertySchema>;
      attributes: Map<string, CustomElementAttributeSchema>;
      events: Map<string, CustomElementEventSchema>;
      unbindableProperties: Set<string>;
    }
  >();

  for (const [declaration, {tagName, registration}] of tagsByDeclaration) {
    if (!isValidCustomElementName(tagName)) {
      warnings.push(`invalid custom element tag name '${tagName}' on '${declaration.name}'`);
      continue;
    }
    if (byTag.has(tagName)) {
      warnings.push(`duplicate registration for tag '${tagName}'`);
      continue;
    }
    const entry = {
      declaration,
      registration,
      properties: new Map<string, CustomElementPropertySchema>(),
      attributes: new Map<string, CustomElementAttributeSchema>(),
      events: new Map<string, CustomElementEventSchema>(),
      unbindableProperties: new Set<string>(),
    };
    byTag.set(tagName, entry);
    extractMembers(declaration, tagName, entry, owningPackage, manifestRelativeDir, warnings);
  }

  const schemas: CustomElementsManifestSchema[] = [];
  for (const [
    tagName,
    {declaration, registration, properties, attributes, events, unbindableProperties},
  ] of byTag) {
    const declKey = declarationKey(declaration.modulePath, declaration.name);
    const chosenExport = selectJavaScriptExport(
      exportsByDecl.get(declKey),
      declaration.name,
      declaration.modulePath,
    );
    if (chosenExport === null) {
      warnings.push(`ambiguous "js" exports for '${declaration.name}' on '${tagName}'`);
    }
    const classImports =
      chosenExport === null
        ? []
        : buildClassImportCandidates(
            owningPackage,
            manifestRelativeDir,
            chosenExport?.module ?? declaration.modulePath,
            chosenExport?.name ?? declaration.name,
          );
    const unbindable = Array.from(unbindableProperties).filter((name) => !properties.has(name));
    schemas.push({
      tagName,
      properties: Array.from(properties.values()),
      attributes: Array.from(attributes.values()),
      events: Array.from(events.values()),
      ...(unbindable.length > 0 ? {unbindableProperties: unbindable} : {}),
      ...(classImports.length > 0 ? {classImports} : {}),
      ...(owningPackage !== null ? {isPackageManifest: true} : {}),
      ...readDocs(declaration.node),
      ...(registration.deprecated !== undefined ? {deprecated: registration.deprecated} : {}),
    });
  }

  for (const [tagName, registration] of definitionOnlyTags) {
    if (byTag.has(tagName)) {
      continue;
    }
    if (!isValidCustomElementName(tagName)) {
      warnings.push(`invalid custom element tag name '${tagName}' in definition export`);
      continue;
    }
    warnings.push(
      `definition export for '${tagName}' references class '${registration.declarationName}' not found in manifest`,
    );
    schemas.push({
      tagName,
      properties: [],
      attributes: [],
      events: [],
      ...(owningPackage !== null ? {isPackageManifest: true} : {}),
      ...(registration.deprecated !== undefined ? {deprecated: registration.deprecated} : {}),
    });
  }

  return {schemas, errors: [], warnings};
}

function extractMembers(
  {node: declaration, modulePath: containingModule}: ManifestDeclaration,
  tagName: string,
  target: {
    properties: Map<string, CustomElementPropertySchema>;
    attributes: Map<string, CustomElementAttributeSchema>;
    events: Map<string, CustomElementEventSchema>;
    unbindableProperties: Set<string>;
  },
  owningPackage: string | null,
  manifestRelativeDir: string,
  warnings: string[],
): void {
  const membersByName = new Map<string, {[key: string]: unknown}>();
  if (Array.isArray(declaration['members'])) {
    for (const member of declaration['members']) {
      if (isObject(member) && member['kind'] === 'field' && typeof member['name'] === 'string') {
        membersByName.set(member['name'], member);
      }
    }
  }
  const declaredAttributeNames = new Set(
    Array.isArray(declaration['attributes'])
      ? declaration['attributes']
          .filter((attr): attr is {[key: string]: unknown} => isObject(attr))
          .map((attr) => attr['name'])
          .filter((name): name is string => typeof name === 'string')
      : [],
  );

  const memberParsedTypes = new Map<string, ParsedManifestType>();
  const inheritedMemberByAttr = new Map<string, string>();
  if (Array.isArray(declaration['members'])) {
    for (const member of declaration['members']) {
      if (!isObject(member) || member['kind'] !== 'field' || typeof member['name'] !== 'string') {
        continue;
      }
      const memberName = member['name'];
      if (hasInvalidFieldModifier(member)) {
        warnings.push(`property '${memberName}' on '${tagName}' has an invalid modifier`);
        target.unbindableProperties.add(memberName);
        continue;
      }
      const bindable = !(
        member['static'] === true ||
        member['privacy'] === 'private' ||
        member['privacy'] === 'protected' ||
        member['readonly'] === true
      );
      const hasExplicitType = Object.prototype.hasOwnProperty.call(member, 'type');
      const rawTypeText = hasExplicitType ? trimmedTypeTextOf(member['type']) : undefined;
      const parsed = hasExplicitType
        ? parseManifestType(member['type'], owningPackage, manifestRelativeDir, containingModule)
        : ({ok: false} as const);
      if (hasExplicitType && !parsed.ok) {
        warnings.push(`unsupported type on property '${tagName}.${memberName}'`);
      }
      memberParsedTypes.set(memberName, parsed);

      const docs = readDocs(member);
      const defaultVal = typeof member['default'] === 'string' ? {default: member['default']} : {};
      if (typeof member['attribute'] === 'string' && member['attribute'].length > 0) {
        if (declaredAttributeNames.has(member['attribute'])) {
          inheritedMemberByAttr.set(member['attribute'], memberName);
          target.attributes.set(member['attribute'], {
            name: member['attribute'],
            ...attributeTypeFields(parsed, memberName, rawTypeText),
            ...docs,
            ...defaultVal,
          });
        } else {
          warnings.push(
            `property '${tagName}.${memberName}' references unlisted attribute '${member['attribute']}'`,
          );
        }
      }
      if (!bindable) {
        target.unbindableProperties.add(memberName);
        continue;
      }
      target.properties.set(memberName, {
        name: memberName,
        ...propertyCheckTypeMetadata(parsed),
        ...(rawTypeText !== undefined ? {typeText: rawTypeText} : {}),
        ...docs,
        ...defaultVal,
      });
    }
  }

  if (Array.isArray(declaration['attributes'])) {
    for (const attr of declaration['attributes']) {
      if (!isObject(attr) || typeof attr['name'] !== 'string') {
        continue;
      }
      const attrName = attr['name'];
      const inherited = target.attributes.get(attrName);
      const inheritedField = inheritedMemberByAttr.get(attrName);
      const hasExplicitType = Object.prototype.hasOwnProperty.call(attr, 'type');
      const requestedField =
        typeof attr['fieldName'] === 'string' && attr['fieldName'].length > 0
          ? attr['fieldName']
          : undefined;
      const relatedMember =
        requestedField === undefined ? undefined : membersByName.get(requestedField);
      const hasValidField = requestedField === undefined || relatedMember !== undefined;
      if (!hasValidField) {
        warnings.push(
          `attribute '${tagName}.${attrName}' has unknown fieldName '${requestedField}'`,
        );
      }

      const linkedMember =
        relatedMember ??
        (inheritedField === undefined ? undefined : membersByName.get(inheritedField));
      const repeatsLinked =
        hasValidField && hasExplicitType && repeatsMemberType(attr['type'], linkedMember?.['type']);
      const hasOwnType = hasExplicitType && !repeatsLinked;
      const linkedProp = hasOwnType ? undefined : (requestedField ?? inheritedField);

      let typeFields: Partial<CustomElementAttributeSchema> = {};
      if (hasOwnType) {
        const ownTypeText = trimmedTypeTextOf(attr['type']);
        const parsed = parseManifestType(
          attr['type'],
          owningPackage,
          manifestRelativeDir,
          containingModule,
        );
        if (!parsed.ok) {
          warnings.push(`unsupported type on attribute '${tagName}.${attrName}'`);
        }
        typeFields = attributeTypeFields(parsed, undefined, ownTypeText);
      } else if (hasValidField && linkedProp !== undefined) {
        const linkedParsed = memberParsedTypes.get(linkedProp) ?? ({ok: false} as const);
        const linkedTypeText =
          linkedMember !== undefined
            ? trimmedTypeTextOf(linkedMember['type'])
            : inherited?.typeText;
        typeFields = attributeTypeFields(linkedParsed, linkedProp, linkedTypeText);
      }

      const docs = {...(inherited ? stripAttrType(inherited) : {}), ...readDocs(attr)};
      const defaultVal =
        typeof attr['default'] === 'string'
          ? {default: attr['default']}
          : inherited?.default !== undefined
            ? {default: inherited.default}
            : {};

      target.attributes.set(attrName, {
        name: attrName,
        ...docs,
        ...defaultVal,
        ...typeFields,
      });
    }
  }

  if (Array.isArray(declaration['events'])) {
    for (const event of declaration['events']) {
      if (!isObject(event) || typeof event['name'] !== 'string') {
        continue;
      }
      const hasExplicitType = Object.prototype.hasOwnProperty.call(event, 'type');
      const rawTypeText = hasExplicitType ? trimmedTypeTextOf(event['type']) : undefined;
      const parsed = hasExplicitType
        ? parseManifestType(event['type'], owningPackage, manifestRelativeDir, containingModule)
        : ({ok: false} as const);
      if (hasExplicitType && !parsed.ok) {
        warnings.push(`unsupported type on event '${tagName}(${event['name']})'`);
      }
      target.events.set(event['name'], {
        name: event['name'],
        // Only attach manifest event types that reference an external/DOM event type; primitive
        // placeholders like `void` or `boolean` would mask native DOM event inference (e.g.
        // `MouseEvent` for `click`).
        ...(parsed.ok && parsed.isExternal ? checkTypeMetadata(parsed) : {}),
        ...(rawTypeText !== undefined ? {typeText: rawTypeText} : {}),
        ...readDocs(event),
      });
    }
  }
}

function propertyCheckTypeMetadata(parsed: ParsedManifestType): CustomElementCheckTypeMetadata {
  // Treat top-level `any` / `unknown` in a manifest as unusable so template type checking falls
  // back to the real element class property type when available.
  if (!parsed.ok || parsed.checkType === 'any' || parsed.checkType === 'unknown') {
    return {};
  }
  return checkTypeMetadata(parsed);
}

function checkTypeMetadata(parsed: ParsedManifestType): CustomElementCheckTypeMetadata {
  if (!parsed.ok) {
    return {};
  }
  return {
    checkType: parsed.checkType,
    ...(parsed.isExternal ? {checkTypeIsExternal: true} : {}),
    ...(parsed.usesUnreferencedGlobal ? {checkTypeUsesUnreferencedGlobal: true} : {}),
  };
}

/**
 * Computes attribute checkType + property fallback fields.
 * - Pure string literal union: direct checkType + stringLiteralValues (no class fallback needed).
 * - External/imported type: checkType + optional linked property fallback.
 * - Other valid non-string type (e.g. `boolean`, `number`, `string`): omit both (no static check).
 * - Missing/unusable type: keep linked property so TCB infers string literals from the class.
 */
function attributeTypeFields(
  parsed: ParsedManifestType,
  linkedProperty: string | undefined,
  typeText: string | undefined,
): Partial<CustomElementAttributeSchema> {
  const displayType = typeText !== undefined ? {typeText} : {};
  if (parsed.ok) {
    if (parsed.isLiteralUnion && parsed.literalUnionType !== undefined) {
      return {
        ...displayType,
        checkType: parsed.literalUnionType,
        checkTypeIsLiteralUnion: true,
        ...(parsed.stringLiteralValues !== undefined
          ? {stringLiteralValues: parsed.stringLiteralValues}
          : {}),
      };
    }
    if (parsed.isExternal) {
      return {
        ...displayType,
        ...checkTypeMetadata(parsed),
        ...(linkedProperty !== undefined ? {property: linkedProperty} : {}),
      };
    }
    return displayType;
  }
  return {
    ...displayType,
    ...(linkedProperty !== undefined ? {property: linkedProperty} : {}),
  };
}

function stripAttrType(
  attr: CustomElementAttributeSchema,
): Pick<CustomElementAttributeSchema, 'description' | 'deprecated'> {
  return {
    ...(attr.description !== undefined ? {description: attr.description} : {}),
    ...(attr.deprecated !== undefined ? {deprecated: attr.deprecated} : {}),
  };
}

function repeatsMemberType(attributeType: unknown, memberType: unknown): boolean {
  const attrText = typeTextOf(attributeType)?.trim();
  const memberText = typeTextOf(memberType)?.trim();
  if (attrText === undefined || attrText.length === 0 || attrText !== memberText) {
    return false;
  }
  const attrRefs =
    isObject(attributeType) && Array.isArray(attributeType['references'])
      ? attributeType['references']
      : [];
  if (attrRefs.length === 0) {
    return true;
  }
  const memberRefs =
    isObject(memberType) && Array.isArray(memberType['references']) ? memberType['references'] : [];
  return JSON.stringify(attrRefs) === JSON.stringify(memberRefs);
}

function hasInvalidFieldModifier(member: {[key: string]: unknown}): boolean {
  const privacy = member['privacy'];
  if (
    privacy !== undefined &&
    privacy !== 'public' &&
    privacy !== 'private' &&
    privacy !== 'protected'
  ) {
    return true;
  }
  if (member['static'] !== undefined && typeof member['static'] !== 'boolean') {
    return true;
  }
  if (member['readonly'] !== undefined && typeof member['readonly'] !== 'boolean') {
    return true;
  }
  return false;
}

function readDocs(entry: {[key: string]: unknown}): {
  deprecated?: true | string;
  description?: string;
} {
  const docs: {deprecated?: true | string; description?: string} = {};
  const deprecated = entry['deprecated'];
  if (deprecated === true || (typeof deprecated === 'string' && deprecated.length > 0)) {
    docs.deprecated = deprecated;
  }
  const description = entry['description'];
  const summary = entry['summary'];
  if (typeof description === 'string' && description.trim().length > 0) {
    docs.description = description;
  } else if (typeof summary === 'string' && summary.trim().length > 0) {
    docs.description = summary;
  }
  return docs;
}

function resolveRegistrations(
  modules: Array<{path: string; [key: string]: unknown}>,
  customElementDeclarations: ManifestDeclaration[],
  declarationsByModuleAndName: Map<string, ManifestDeclaration[]>,
  warnings: string[],
): {
  tagsByDeclaration: Map<
    ManifestDeclaration,
    {tagName: string; registration: TagRegistrationRecord}
  >;
  definitionOnlyTags: Map<string, TagRegistrationRecord>;
} {
  const tagsByDeclaration = new Map<
    ManifestDeclaration,
    {tagName: string; registration: TagRegistrationRecord}
  >();
  const definitionOnlyTags = new Map<string, TagRegistrationRecord>();

  for (const decl of customElementDeclarations) {
    const tagName = decl.node['tagName'];
    if (typeof tagName === 'string' && tagName.length > 0) {
      tagsByDeclaration.set(decl, {
        tagName,
        registration: makeRegistration(
          decl.node,
          decl.name,
          decl.modulePath,
          decl.modulePath,
          TagRegistrationSource.TagName,
        ),
      });
    }
  }

  for (const mod of modules) {
    if (!Array.isArray(mod['exports'])) {
      continue;
    }
    for (const exp of mod['exports']) {
      if (
        !isObject(exp) ||
        exp['kind'] !== 'custom-element-definition' ||
        typeof exp['name'] !== 'string' ||
        !isObject(exp['declaration']) ||
        typeof exp['declaration']['name'] !== 'string'
      ) {
        continue;
      }
      const defTagName = exp['name'];
      const defDeclName = exp['declaration']['name'];
      const declMod =
        typeof exp['declaration']['module'] === 'string' ? exp['declaration']['module'] : mod.path;
      const registration = makeRegistration(
        exp,
        defDeclName,
        declMod,
        mod.path,
        TagRegistrationSource.Definition,
      );

      if (typeof exp['declaration']['package'] === 'string') {
        if (!definitionOnlyTags.has(defTagName)) {
          definitionOnlyTags.set(defTagName, registration);
        } else {
          warnings.push(`duplicate definition export for tag '${defTagName}'`);
        }
        continue;
      }

      const referenced = declarationsByModuleAndName.get(declarationKey(declMod, defDeclName));
      if (referenced === undefined) {
        if (!definitionOnlyTags.has(defTagName)) {
          definitionOnlyTags.set(defTagName, registration);
        } else {
          warnings.push(`duplicate definition export for tag '${defTagName}'`);
        }
        continue;
      }

      for (const decl of referenced) {
        const existing = tagsByDeclaration.get(decl);
        if (existing === undefined) {
          tagsByDeclaration.set(decl, {tagName: defTagName, registration});
        } else if (existing.tagName !== defTagName) {
          warnings.push(
            `class '${defDeclName}' registered under multiple tags ('${existing.tagName}', '${defTagName}')`,
          );
        } else if (
          existing.registration.source === TagRegistrationSource.TagName &&
          mod.path === decl.modulePath
        ) {
          existing.registration = registration;
        } else {
          warnings.push(`duplicate registration for tag '${defTagName}'`);
        }
      }
    }
  }

  return {tagsByDeclaration, definitionOnlyTags};
}

function makeRegistration(
  entry: {[key: string]: unknown},
  declarationName: string,
  declarationModule: string,
  registrationModule: string,
  source: TagRegistrationSource,
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

function selectJavaScriptExport(
  candidates: JavaScriptExport[] | undefined,
  declarationName: string,
  homeModule: string,
): JavaScriptExport | null | undefined {
  if (candidates === undefined || candidates.length === 0) {
    return undefined;
  }
  const exact = candidates.filter((c) => c.name === declarationName);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    const home = exact.filter((c) => c.module === homeModule);
    return home.length === 1 ? home[0] : null;
  }
  const nonDefault = candidates.filter((c) => c.name !== 'default');
  if (nonDefault.length === 1) {
    return nonDefault[0];
  }
  if (nonDefault.length > 1) {
    return null;
  }
  const defaults = candidates.filter((c) => c.name === 'default');
  return defaults.length === 1 ? defaults[0] : null;
}
