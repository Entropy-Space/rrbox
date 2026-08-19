import type { Context } from "@deepseek-ai/cordis";
import {
  snapshotJsonValue,
  type JsonValue,
} from "@deepseek-ai/dsh-session";
import {
  type JsonSchemaNode,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAgentPluginTools,
  type AgentPlugin,
  type AgentPluginContext,
} from "@researchbox/agent-core";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export type DshrboxAgentPluginAdapterConfig = {
  plugins: readonly AgentPlugin[];
  context: AgentPluginContext;
};

type AdaptedToolOutput = {
  content: Array<{ type: "text"; text: string }>;
  details: JsonValue;
};

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", const: "text" },
          text: { type: "string" },
        },
        required: ["type", "text"],
      },
    },
    details: {},
  },
  required: ["content", "details"],
} as const satisfies JsonSchemaNode;

const copiedKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
  "anyOf",
  "oneOf",
]);

const validationOnlyKeywords = new Set([
  "$id",
  "$schema",
  "deprecated",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "readOnly",
  "uniqueItems",
  "writeOnly",
]);

/** Register legacy application plugins as ordinary global DSH tools. */
export function DshrboxAgentPluginAdapter(
  ctx: Context,
  config: DshrboxAgentPluginAdapterConfig,
): void {
  assertAdapterConfig(config);
  for (const tool of createDshrboxAgentToolDefinitions(
    config.plugins,
    config.context,
  )) {
    ctx.tools.register(tool);
  }
}

DshrboxAgentPluginAdapter.inject = ["tools"];

export default DshrboxAgentPluginAdapter;

/** Convert one snapshot of legacy plugins into registry-ready DSH tools. */
export function createDshrboxAgentToolDefinitions(
  plugins: readonly AgentPlugin[],
  context: AgentPluginContext,
): readonly ToolDefinition[] {
  return createAgentPluginTools(plugins, context, []).map(adaptAgentTool);
}

function adaptAgentTool(tool: AgentTool): ToolDefinition {
  const parameters = projectParameterSchema(tool.name, tool.parameters);
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => requireAdaptedOutput(tool.name, value).content,
      presentationMeta: (_args, value) =>
        requireAdaptedOutput(tool.name, value).details,
    },
    ...(tool.executionMode === "parallel"
      ? { isConcurrencySafe: () => true }
      : {}),
    async execute(args, exec) {
      const prepared = tool.prepareArguments?.(args) ?? args;
      assertLegacyArguments(tool.name, tool.parameters, prepared);
      const result = await tool.execute(
        String(exec.callId),
        prepared,
        exec.signal,
      );
      if (result.terminate === true) {
        throw new Error(
          `Legacy tool ${tool.name} returned unsupported terminate=true.`,
        );
      }
      return {
        content: result.content.map((block) => {
          if (block.type !== "text") {
            throw new Error(
              `Legacy tool ${tool.name} returned unsupported inline image content.`,
            );
          }
          return { type: "text" as const, text: block.text };
        }),
        details: snapshotLegacyDetails(tool.name, result.details),
      } satisfies AdaptedToolOutput;
    },
  };
}

function projectParameterSchema(
  toolName: string,
  schema: TSchema,
): Record<string, unknown> {
  const projected = projectSchemaNode(schema, `${toolName}.parameters`);
  if (projected.type !== "object") {
    throw new Error(
      `Legacy tool ${toolName} parameters must have an object schema root.`,
    );
  }
  return projected as Record<string, unknown>;
}

function projectSchemaNode(
  value: unknown,
  path: string,
): JsonSchemaNode {
  if (!isRecord(value)) {
    throw new Error(`Legacy tool schema ${path} must be an object.`);
  }
  assertKnownKeywords(value, path);

  const annotations = projectAnnotations(value, path);
  const alternatives = value.anyOf ?? value.oneOf;
  if (alternatives !== undefined) {
    if (!Array.isArray(alternatives) || alternatives.length < 2) {
      throw new Error(
        `Legacy tool schema ${path} union must have at least two branches.`,
      );
    }
    const branches = alternatives.map((branch, index) =>
      projectSchemaNode(branch, `${path}.union[${index}]`)
    );
    assertExclusiveUnion(branches, path);
    return { ...annotations, oneOf: branches };
  }

  if (value.type === undefined) return annotations;
  if (!isJsonSchemaType(value.type)) {
    throw new Error(
      `Legacy tool schema ${path} has unsupported type ${String(value.type)}.`,
    );
  }

  const projected: JsonSchemaNode = {
    ...annotations,
    type: value.type,
  };
  projectScalarConstraints(value, projected, path);

  if (value.type === "object") {
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) {
        throw new Error(
          `Legacy tool schema ${path}.properties must be an object.`,
        );
      }
      projected.properties = Object.fromEntries(
        Object.entries(value.properties).map(([name, property]) => [
          name,
          projectSchemaNode(property, `${path}.properties.${name}`),
        ]),
      );
    }
    if (value.required !== undefined) {
      if (!isStringArray(value.required)) {
        throw new Error(
          `Legacy tool schema ${path}.required must contain strings.`,
        );
      }
      projected.required = [...value.required];
    }
    if (typeof value.additionalProperties === "boolean") {
      projected.additionalProperties = value.additionalProperties;
    }
  }

  if (value.type === "array" && value.items !== undefined) {
    if (Array.isArray(value.items)) {
      throw new Error(
        `Legacy tool schema ${path} uses an unsupported tuple schema.`,
      );
    }
    projected.items = projectSchemaNode(value.items, `${path}.items`);
  }

  return projected;
}

function projectAnnotations(
  value: Record<string, unknown>,
  path: string,
): JsonSchemaNode {
  const annotations: JsonSchemaNode = {};
  for (const key of ["description", "title"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") {
      throw new Error(`Legacy tool schema ${path}.${key} must be a string.`);
    }
    annotations[key] = value[key];
  }
  for (const key of ["default", "examples"] as const) {
    if (value[key] === undefined) continue;
    const snapshot = snapshotJsonValue(value[key]);
    if (snapshot === undefined) {
      throw new Error(
        `Legacy tool schema ${path}.${key} must be lossless JSON.`,
      );
    }
    annotations[key] = snapshot as JsonValue;
  }
  return annotations;
}

function projectScalarConstraints(
  source: Record<string, unknown>,
  target: JsonSchemaNode,
  path: string,
): void {
  if (source.const !== undefined) {
    if (!isJsonScalar(source.const)) {
      throw new Error(`Legacy tool schema ${path}.const must be scalar JSON.`);
    }
    target.const = source.const;
  }
  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum) || !source.enum.every(isJsonScalar)) {
      throw new Error(
        `Legacy tool schema ${path}.enum must contain scalar JSON values.`,
      );
    }
    target.enum = [...source.enum];
  }
}

function assertKnownKeywords(
  value: Record<string, unknown>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (copiedKeywords.has(key) || validationOnlyKeywords.has(key)) continue;
    throw new Error(
      `Legacy tool schema ${path} uses unsupported keyword ${key}.`,
    );
  }
}

function assertExclusiveUnion(
  branches: readonly JsonSchemaNode[],
  path: string,
): void {
  for (let left = 0; left < branches.length; left += 1) {
    for (let right = left + 1; right < branches.length; right += 1) {
      if (schemasAreExclusive(branches[left], branches[right])) continue;
      throw new Error(
        `Legacy tool schema ${path} has union branches that cannot be safely projected to DSH oneOf.`,
      );
    }
  }
}

function schemasAreExclusive(
  left: JsonSchemaNode,
  right: JsonSchemaNode,
): boolean {
  const leftValues = scalarValues(left);
  const rightValues = scalarValues(right);
  if (leftValues !== null && rightValues !== null) {
    return leftValues.every(
      (leftValue) =>
        rightValues.every((rightValue) => !Object.is(leftValue, rightValue)),
    );
  }
  if (left.type === undefined || right.type === undefined) return false;
  if (left.type === right.type) return false;
  return !(
    (left.type === "integer" && right.type === "number") ||
    (left.type === "number" && right.type === "integer")
  );
}

function scalarValues(
  schema: JsonSchemaNode,
): Array<string | number | boolean | null> | null {
  if (schema.const !== undefined) return [schema.const];
  return schema.enum === undefined ? null : [...schema.enum];
}

function assertLegacyArguments(
  toolName: string,
  schema: TSchema,
  value: unknown,
): void {
  if (Check(schema, value)) return;
  const details = Errors(schema, value)
    .slice(0, 4)
    .map((error) =>
      `${error.instancePath || "/"}: ${error.message}`
    )
    .join("; ");
  throw new Error(
    `Invalid arguments for legacy tool ${toolName}${
      details.length === 0 ? "." : `: ${details}`
    }`,
  );
}

function snapshotLegacyDetails(toolName: string, value: unknown): JsonValue {
  if (value === undefined) return null;
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) {
    throw new Error(
      `Legacy tool ${toolName} returned details that are not lossless JSON.`,
    );
  }
  return snapshot as JsonValue;
}

function requireAdaptedOutput(
  toolName: string,
  value: JsonValue,
): AdaptedToolOutput {
  if (
    !isRecord(value) ||
    !Array.isArray(value.content) ||
    !("details" in value)
  ) {
    throw new Error(`Invalid canonical output for legacy tool ${toolName}.`);
  }
  return value as AdaptedToolOutput;
}

function assertAdapterConfig(
  config: DshrboxAgentPluginAdapterConfig,
): void {
  if (
    config === null ||
    typeof config !== "object" ||
    !Array.isArray(config.plugins) ||
    config.context === null ||
    typeof config.context !== "object"
  ) {
    throw new TypeError(
      "dshrbox agent plugin adapter requires plugins and context",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isJsonScalar(
  value: unknown,
): value is string | number | boolean | null {
  return value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0));
}

function isJsonSchemaType(
  value: unknown,
): value is NonNullable<JsonSchemaNode["type"]> {
  return value === "object" ||
    value === "array" ||
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "null";
}
