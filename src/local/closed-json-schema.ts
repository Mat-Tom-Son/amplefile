/**
 * The closed JSON-Schema subset AmpleFile accepts for a structured model
 * result (bounded inference's output schema). Parsing is data-only and fails
 * closed: an unknown keyword is refused rather than silently ignored.
 */
export interface ClosedJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, ClosedJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ClosedJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * Depth guards the recursive validator's stack; the rest only keep one
 * schema finite.
 */
export const closedJsonSchemaLimits = Object.freeze({
  depth: 32,
  properties: 1_024,
  enumValues: 1_024,
  maxItems: 100_000,
  maxLength: 16 * 1024 * 1024,
  /** Schema descriptions reach the model, so they get room to explain. */
  descriptionCharacters: 16_384,
});

export function parseClosedJsonSchema(value: unknown, label = "JSON schema"): ClosedJsonSchema {
  return parseJsonSchema(value, label, 0);
}

export function validateClosedJsonValue(
  schema: ClosedJsonSchema,
  value: unknown,
  label = "Value",
): void {
  if (!runtimeValueMatchesType(schema.type, value)) throw new Error(`${label} must have type ${schema.type}.`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${label} is not one of the declared values.`);
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw new Error(`${label} is missing required property ${required}.`);
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (!propertySchema) throw new Error(`${label} contains undeclared property ${key}.`);
      validateClosedJsonValue(propertySchema, item, `${label}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) throw new Error(`${label} has too few items.`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems) throw new Error(`${label} has too many items.`);
    const itemSchema = schema.items!;
    items.forEach((item, index) => validateClosedJsonValue(itemSchema, item, `${label}[${index}]`));
    return;
  }
  if (schema.type === "string") {
    const text = value as string;
    if (schema.minLength !== undefined && text.length < schema.minLength) throw new Error(`${label} is too short.`);
    if (schema.maxLength !== undefined && text.length > schema.maxLength) throw new Error(`${label} is too long.`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) throw new Error(`${label} is below the minimum.`);
    if (schema.maximum !== undefined && number > schema.maximum) throw new Error(`${label} is above the maximum.`);
  }
}

function parseJsonSchema(value: unknown, label: string, depth: number): ClosedJsonSchema {
  if (depth > closedJsonSchemaLimits.depth) throw new Error(`${label} exceeds the maximum nesting depth.`);
  const schema = objectValue(value, label, [
    "type", "description", "properties", "required", "additionalProperties", "items", "enum",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
  ]);
  const type = schema.type;
  if (type !== "object" && type !== "array" && type !== "string" && type !== "number"
    && type !== "integer" && type !== "boolean" && type !== "null") {
    throw new Error(`${label} type is unsupported.`);
  }
  const result: ClosedJsonSchema = { type };
  const description = optionalStringValue(schema.description, `${label} description`, closedJsonSchemaLimits.descriptionCharacters);
  if (description) result.description = description;

  if (schema.enum !== undefined) {
    const values = arrayValue(schema.enum, `${label} enum`, 1, closedJsonSchemaLimits.enumValues);
    if (values.some((item) => item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) {
      throw new Error(`${label} enum may contain only primitive JSON values.`);
    }
    const serialized = values.map((item) => JSON.stringify(item));
    assertUnique(serialized, `${label} enum value`);
    if (!values.every((item) => schemaValueMatchesType(item, type))) {
      throw new Error(`${label} enum values must match its declared type.`);
    }
    result.enum = values as ClosedJsonSchema["enum"];
  }

  if (type === "object") {
    if (schema.additionalProperties !== false) throw new Error(`${label} must set additionalProperties to false.`);
    const properties = objectValue(schema.properties ?? {}, `${label} properties`, undefined, closedJsonSchemaLimits.properties);
    const parsedProperties: Record<string, ClosedJsonSchema> = {};
    for (const [name, property] of Object.entries(properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`${label} property name is invalid: ${name}`);
      parsedProperties[name] = parseJsonSchema(property, `${label} property ${name}`, depth + 1);
    }
    const required = schema.required === undefined
      ? []
      : arrayValue(schema.required, `${label} required`, 0, Object.keys(parsedProperties).length).map((name) => {
        if (typeof name !== "string" || !(name in parsedProperties)) throw new Error(`${label} required property is not declared.`);
        return name;
      });
    assertUnique(required, `${label} required property`);
    result.properties = parsedProperties;
    result.required = required;
    result.additionalProperties = false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    throw new Error(`${label} object keywords require type object.`);
  }

  if (type === "array") {
    if (schema.items === undefined) throw new Error(`${label} must declare array items.`);
    result.items = parseJsonSchema(schema.items, `${label} items`, depth + 1);
    const { maxItems } = closedJsonSchemaLimits;
    copyBound(schema, result, "minItems", label, 0, maxItems);
    copyBound(schema, result, "maxItems", label, 0, maxItems);
    if ((result.minItems ?? 0) > (result.maxItems ?? maxItems)) throw new Error(`${label} item bounds are invalid.`);
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    throw new Error(`${label} array keywords require type array.`);
  }

  if (type === "string") {
    const { maxLength } = closedJsonSchemaLimits;
    copyBound(schema, result, "minLength", label, 0, maxLength);
    copyBound(schema, result, "maxLength", label, 0, maxLength);
    if ((result.minLength ?? 0) > (result.maxLength ?? maxLength)) throw new Error(`${label} string bounds are invalid.`);
  } else if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    throw new Error(`${label} string keywords require type string.`);
  }

  if (type === "number" || type === "integer") {
    copyNumber(schema, result, "minimum", label);
    copyNumber(schema, result, "maximum", label);
    if ((result.minimum ?? -Infinity) > (result.maximum ?? Infinity)) throw new Error(`${label} numeric bounds are invalid.`);
  } else if (schema.minimum !== undefined || schema.maximum !== undefined) {
    throw new Error(`${label} numeric keywords require a numeric type.`);
  }
  return result;
}

function objectValue(
  value: unknown,
  label: string,
  allowedKeys?: string[],
  maximumKeys = allowedKeys?.length ?? 64,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > maximumKeys) throw new Error(`${label} has too many fields.`);
  if (allowedKeys) {
    const unknown = keys.find((key) => !allowedKeys.includes(key));
    if (unknown) throw new Error(`${label} contains an unsupported field: ${unknown}`);
  }
  return record;
}

function arrayValue(value: unknown, label: string, minimum: number, maximum: number | null): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || (maximum !== null && value.length > maximum)) {
    throw new Error(maximum === null ? `${label} must be an array with at least ${minimum} items.` : `${label} must contain between ${minimum} and ${maximum} items.`);
  }
  return value;
}

function optionalStringValue(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  return text;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is duplicated.`);
}

function copyBound<K extends "minLength" | "maxLength" | "minItems" | "maxItems">(
  source: Record<string, unknown>,
  target: ClosedJsonSchema,
  key: K,
  label: string,
  minimum: number,
  maximum: number,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} ${key} is invalid.`);
  }
  target[key] = value as ClosedJsonSchema[K];
}

function copyNumber<K extends "minimum" | "maximum">(
  source: Record<string, unknown>,
  target: ClosedJsonSchema,
  key: K,
  label: string,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} ${key} is invalid.`);
  target[key] = value;
}

function schemaValueMatchesType(value: unknown, type: ClosedJsonSchema["type"]): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function runtimeValueMatchesType(type: ClosedJsonSchema["type"], value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
