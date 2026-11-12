// JSON Schema tool parameters, turned into the Schema message Gemini accepts.
//
// Gemini's function declarations take an OpenAPI-flavoured subset of JSON Schema, and
// the differences are each a 400 that names a field nobody typed:
//
//   * `type` is a scalar enum there, not JSON Schema's array of allowed types. A
//     nullable string is `{ type: "string", nullable: true }`.
//   * There is no `const`. A literal is a one-value enum — dropping it instead leaves
//     the model a bare `{ type: "string" }` that accepts (and invents) any value.
//   * `enum` is repeated *string*: a numeric or boolean literal is refused outright
//     (`enum[0] (TYPE_STRING), 1`). The constraint goes, the scalar type stays, and the
//     allowed values move into the description so the model still sees them.
//   * Unknown keywords (`$schema`, `additionalProperties`, ...) are refused, not ignored.
//
// Only schema *positions* are visited: a property named `type` is still a user property.
// The caller's schema is left untouched for the other providers and for tool validation.

const KEYS = new Set([
  "type", "description", "properties", "required", "items", "enum", "nullable", "format",
  "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "title",
  "default", "anyOf", "minProperties", "maxProperties", "propertyOrdering", "example",
]);

export function sanitizeGeminiFunctionParameters(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const src = schema;
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "const") {
      if (!Array.isArray(src.enum)) out.enum = [value];
      continue;
    }
    if (!KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, sanitizeGeminiFunctionParameters(child)]),
      );
    } else if (key === "items") {
      out.items = sanitizeGeminiFunctionParameters(value);
    } else if (key === "anyOf" && Array.isArray(value)) {
      const branches = value.map(sanitizeGeminiFunctionParameters);
      const merged = mergeLiteralUnion(branches);
      if (merged) Object.assign(out, merged);
      else out.anyOf = branches;
    } else {
      out[key] = value;
    }
  }
  if (Array.isArray(src.type)) {
    const types = [...new Set(src.type.filter((t) => typeof t === "string"))];
    const nonNull = types.filter((t) => t.toLowerCase() !== "null");
    if (nonNull.length !== types.length) out.nullable = true;
    if (nonNull.length === 1) out.type = nonNull[0];
    else if (nonNull.length > 1) {
      delete out.type;
      // Keep every alternative rather than silently selecting the first type.
      const common = { ...out };
      out.anyOf = nonNull.map((type) => ({ ...common, type }));
    } else out.type = "null";
  }
  if (!out.type && !out.anyOf && (out.properties || out.required)) out.type = "object";
  if (Array.isArray(out.enum) && out.enum.some((v) => typeof v !== "string")) {
    const allowed = out.enum;
    delete out.enum;
    const note = `Allowed value(s): ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
    out.description = typeof out.description === "string" ? `${out.description} ${note}` : note;
    if (!out.type) {
      out.type = allowed.every((v) => typeof v === "boolean")
        ? "boolean"
        : allowed.every((v) => typeof v === "number")
          ? (Number.isInteger(allowed[0]) ? "integer" : "number")
          : "string";
    }
  }
  return out;
}

/**
 * A union of literals arrives as `anyOf` of single-value enums. Gemini handles that
 * badly, and a union of literals is just an enum, so collapse it to `{ type, enum }`.
 * Null when the branches are anything else.
 */
function mergeLiteralUnion(branches) {
  if (branches.length === 0) return null;
  const values = [];
  let type;
  for (const b of branches) {
    if (!Array.isArray(b.enum) || b.anyOf) return null;
    if (type !== undefined && b.type !== type) return null;
    type = b.type;
    values.push(...b.enum);
  }
  return { ...(type !== undefined ? { type } : {}), enum: [...new Set(values)] };
}
