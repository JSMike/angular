/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {CheckTypeFailure, computeCheckType} from './check_type';
import {
  AttributeRecord,
  CemDeclaration,
  EventRecord,
  isObject,
  ManifestCheckType,
  MAX_TYPE_TEXT_LENGTH,
  ParseContext,
  PropertyRecord,
  ParsedCustomElementSchema,
  typeTextOf,
} from './schema';

/**
 * The validated element instance type for a declaration exported as `importedName` from
 * `modulePath` of the owning package, when the manifest identifies its package.
 */
export function instanceCheckType(
  importedName: string,
  modulePath: string,
  context: ParseContext,
): {instanceCheckType?: ManifestCheckType} {
  if (context.owningPackage === null) {
    return {};
  }
  const result = computeCheckType(
    {text: importedName, references: [{name: importedName, module: modulePath}]},
    context.owningPackage,
  );
  if (result.checkType === null) {
    return {};
  }
  return {
    instanceCheckType: {
      ...result,
      originalText: importedName,
      subject: `element class '${importedName}' in '${modulePath}'`,
    },
  };
}

export function extractDeclarationSchema(
  {node: declaration, modulePath: containingModule}: CemDeclaration,
  tagName: string,
  context: ParseContext,
): Pick<ParsedCustomElementSchema, 'properties' | 'attributes' | 'events'> {
  const properties = new Map<string, PropertyRecord>();
  const attributes = new Map<string, AttributeRecord>();
  const events = new Map<string, EventRecord>();
  const {manifestLabel, warnings} = context;
  const memberNames = new Set<string>();
  const declaredAttributeNames = new Set(
    Array.isArray(declaration['attributes'])
      ? declaration['attributes']
          .filter((attribute): attribute is {[key: string]: unknown} => isObject(attribute))
          .map((attribute) => attribute['name'])
          .filter((name): name is string => typeof name === 'string')
      : [],
  );
  if (Array.isArray(declaration['members'])) {
    for (const member of declaration['members']) {
      if (!isObject(member) || member['kind'] !== 'field' || typeof member['name'] !== 'string') {
        continue;
      }
      const memberName = member['name'];
      memberNames.add(memberName);
      const invalidModifier = invalidFieldModifier(member);
      if (invalidModifier !== null) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${tagName}.${memberName}`,
          message:
            `${manifestLabel} declares the member '${memberName}' on '${tagName}' with invalid ` +
            `${invalidModifier.name} metadata (${JSON.stringify(invalidModifier.value)}). The ` +
            `member is excluded from Angular's property projection so malformed metadata cannot ` +
            `authorize a property binding.`,
        });
        continue;
      }
      const attribute =
        typeof member['attribute'] === 'string' && member['attribute'].length > 0
          ? member['attribute']
          : null;
      const hasAttribute = attribute !== null && declaredAttributeNames.has(attribute);
      if (attribute !== null && !hasAttribute) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${tagName}.${memberName}`,
          message:
            `${manifestLabel} associates the member '${memberName}' on '${tagName}' with the ` +
            `attribute '${attribute}', but that attribute is missing from the ` +
            `declaration's attributes array. The member remains available, but Angular does ` +
            `not synthesize the missing attribute declaration.`,
        });
      }
      if (member['reflects'] === true && attribute === null) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${tagName}.${memberName}`,
          message:
            `${manifestLabel} declares the member '${memberName}' on '${tagName}' with ` +
            `reflects: true but without the required attribute relationship. The member remains ` +
            `available as a property, but Angular does not synthesize an attribute.`,
        });
      }
      const isBindable =
        member['static'] !== true &&
        member['privacy'] !== 'private' &&
        member['privacy'] !== 'protected' &&
        // Exclude readonly fields so the schema checker rejects bindings that assign to them.
        member['readonly'] !== true;
      if (!isBindable && !hasAttribute) {
        continue;
      }
      const record = {
        ...toTypeRecord(member, containingModule, {
          context,
          tagName,
          declarationKind: 'member',
          declarationName: memberName,
        }),
        ...readDocs(member),
      };
      if (hasAttribute) {
        attributes.set(attribute, record);
      }
      if (isBindable) {
        properties.set(memberName, record);
      }
    }
  }

  if (Array.isArray(declaration['attributes'])) {
    for (const attribute of declaration['attributes']) {
      if (!isObject(attribute) || typeof attribute['name'] !== 'string') {
        continue;
      }
      const hasExplicitType = Object.prototype.hasOwnProperty.call(attribute, 'type');
      const requestedFieldName =
        typeof attribute['fieldName'] === 'string' && attribute['fieldName'].length > 0
          ? attribute['fieldName']
          : undefined;
      const hasValidFieldRelationship =
        requestedFieldName === undefined || memberNames.has(requestedFieldName);
      if (!hasValidFieldRelationship) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${tagName}.${attribute['name']}`,
          message:
            `${manifestLabel} associates the attribute '${attribute['name']}' on '${tagName}' ` +
            `with the field '${requestedFieldName}', but that field is missing from the ` +
            `declaration. The attribute remains available, but the invalid field relationship ` +
            `and any inherited member type are ignored.`,
        });
      }
      let inheritedAttribute = hasValidFieldRelationship
        ? attributes.get(attribute['name'])
        : undefined;
      if (hasExplicitType && inheritedAttribute !== undefined) {
        const {checkType: _checkType, typeText: _typeText, ...metadata} = inheritedAttribute;
        inheritedAttribute = metadata;
      }
      attributes.set(attribute['name'], {
        ...inheritedAttribute,
        ...toTypeRecord(attribute, containingModule, {
          context,
          tagName,
          declarationKind: 'attribute',
          declarationName: attribute['name'],
        }),
        ...readDocs(attribute),
      });
    }
  }

  if (Array.isArray(declaration['events'])) {
    for (const event of declaration['events']) {
      if (!isObject(event) || typeof event['name'] !== 'string') {
        continue;
      }
      if (typeTextOf(event['type']) === undefined) {
        warnings.push({
          kind: 'invalidStructure',
          subject: `${tagName}.${event['name']}`,
          message:
            `${manifestLabel} declares the event '${event['name']}' on '${tagName}' without ` +
            `the required type metadata. The event remains available and uses the normal Event ` +
            `fallback.`,
        });
      }
      const checkType = validateManifestType(event['type'], containingModule, {
        context,
        tagName,
        declarationKind: 'event',
        declarationName: event['name'],
      });
      events.set(event['name'], {
        ...(checkType !== null ? {checkType} : {}),
        ...readTypeText(event['type']),
        ...readDocs(event),
      });
    }
  }
  return {
    properties: Array.from(properties, ([name, record]) => ({name, ...record})),
    attributes: Array.from(attributes, ([name, record]) => ({name, ...record})),
    events: Array.from(events, ([name, record]) => ({name, ...record})),
  };
}

function invalidFieldModifier(member: {
  [key: string]: unknown;
}): {name: 'privacy' | 'static' | 'readonly'; value: unknown} | null {
  const privacy = member['privacy'];
  if (
    privacy !== undefined &&
    privacy !== 'public' &&
    privacy !== 'private' &&
    privacy !== 'protected'
  ) {
    return {name: 'privacy', value: privacy};
  }
  const isStatic = member['static'];
  if (isStatic !== undefined && typeof isStatic !== 'boolean') {
    return {name: 'static', value: isStatic};
  }
  const readonly = member['readonly'];
  if (readonly !== undefined && typeof readonly !== 'boolean') {
    return {name: 'readonly', value: readonly};
  }
  return null;
}

/** Extracts a declaration's check type and display metadata. */
function toTypeRecord(
  entry: {[key: string]: unknown},
  containingModule: string | null,
  warningContext: TypeWarningContext,
): {
  checkType?: ManifestCheckType;
  typeText?: string;
  default?: string;
} {
  const type = entry['type'];
  const checkType = validateManifestType(
    type,
    containingModule,
    warningContext,
    Object.prototype.hasOwnProperty.call(entry, 'type'),
  );
  const defaultValue = entry['default'];
  return {
    ...(checkType !== null ? {checkType} : {}),
    ...readTypeText(type),
    ...(typeof defaultValue === 'string' ? {default: defaultValue} : {}),
  };
}

interface TypeWarningContext {
  context: ParseContext;
  tagName: string;
  declarationKind: 'member' | 'attribute' | 'event';
  declarationName: string;
}

/**
 * Validates a CEM type and records its references for the loader. Rejected types produce an
 * `unusableType` warning. Missing type metadata produces a warning only for an explicit `type` field.
 */
function validateManifestType(
  type: unknown,
  containingModule: string | null,
  {context, tagName, declarationKind, declarationName}: TypeWarningContext,
  explicitlyDeclared = false,
): ManifestCheckType | null {
  const result = computeCheckType(type, context.owningPackage, containingModule);
  if (result.checkType !== null) {
    return {
      ...result,
      originalText: typeTextOf(type)!.trim(),
      subject: `${declarationKind} '${declarationName}' on '${tagName}'`,
    };
  }
  if (result.failure === 'missingTypeText' && !explicitlyDeclared) {
    return null;
  }
  const text = typeTextOf(type);
  const typeDescription =
    text !== undefined
      ? formatTypeText(text)
      : `type metadata without the required string "text" field`;
  context.warnings.push({
    kind: 'unusableType',
    subject: `${tagName}.${declarationName}`,
    message:
      `${context.manifestLabel} declares ${typeDescription} for the ${declarationKind} ` +
      `'${declarationName}' on '${tagName}', but ` +
      `${checkTypeFailureReason(result.failure)}. The declaration remains available, but template ` +
      `checks that depend on this type use a safe fallback; other checks are unaffected.`,
  });
  return null;
}

function checkTypeFailureReason(failure: CheckTypeFailure): string {
  switch (failure) {
    case 'emptyTypeText':
      return `the declared type text is empty`;
    case 'typeTextTooLong':
      return `the declared type text exceeds Angular's ${MAX_TYPE_TEXT_LENGTH}-character safety limit`;
    case 'unusableTypeReference':
      return `one or more named type occurrences do not have usable type.references metadata`;
    case 'unsupportedTypeText':
      return `the type uses syntax or characters outside Angular's supported safe subset`;
    case 'missingTypeText':
      return `the type text or its references are not in a form Angular can safely use`;
  }
}

function formatTypeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'empty type text';
  }
  const bounded = trimmed.length <= 100 ? trimmed : `${trimmed.slice(0, 99)}…`;
  return `type text ${JSON.stringify(bounded)}`;
}

/** Retains type text within the size limit for display. The compiler does not emit this text. */
function readTypeText(type: unknown): {typeText?: string} {
  const text = typeTextOf(type)?.trim();
  return text !== undefined && text.length > 0 && text.length <= MAX_TYPE_TEXT_LENGTH
    ? {typeText: text}
    : {};
}

/**
 * Reads `deprecated` and `description` from declarations, members, attributes, and events.
 * Deprecation may be `true` or a reason string. Uses `summary` when no description is present.
 */
export function readDocs(entry: {[key: string]: unknown}): {
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
