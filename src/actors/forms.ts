import { isDeepStrictEqual } from "node:util";
import { BUILTINS, type Form } from "@agentorg/cli/contract";
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { z } from "zod";
import { Fault } from "../management/schema.js";
import { requestReview, responseFor } from "./requests.js";

const Questions = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  isBlocking: z.boolean(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      isOther: z.boolean().default(false),
      isSecret: z.boolean().default(false),
      options: z
        .array(z.object({ label: z.string(), description: z.string() }))
        .nullable()
        .optional(),
    }),
  ),
});
const unsupported = (limit: string): never => {
  throw new Fault(
    "REQUEST_UNREPRESENTABLE",
    `${limit} This request remains pending for its native input owner.`,
  );
};
const invalid = (): never => {
  throw new Fault(
    "ANSWER_INVALID",
    "Revise the Form response to match the requested values and constraints.",
  );
};
const absentOptions = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== null || !keys.includes(key)));

/** A bounded projection of native questions and flat MCP primitives into ordinary Form values. */
export function nativeForm(method: string, params: any, reference: string) {
  const name = (index: number) => `field_${reference}_${index}`;
  const finish = (fields: Form["fields"], respond: (answers: Record<string, string>) => object) => {
    const parsed = BUILTINS.form_create.request.shape.fields.safeParse(fields);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return unsupported(`Form.fields.${issue.path.join(".")}: ${issue.message}.`);
    }
    return {
      fields: parsed.data,
      response: (answers: Record<string, string>) => {
        if (Object.keys(answers).some((key) => !parsed.data.some((field) => field.name === key)))
          invalid();
        return respond(answers);
      },
    };
  };
  const choices = (labels: string[], values: string[], path: string) => {
    const display = labels.map((label) => label.trim());
    if (
      !display.length ||
      labels.length !== values.length ||
      display.some((label) => !label) ||
      new Set(display).size !== display.length ||
      new Set(values).size !== values.length
    )
      return unsupported(
        `${path}: choices require equal title/value counts and distinct, nonempty display labels.`,
      );
    return {
      display,
      value: (answer: string) => {
        const index = display.indexOf(answer);
        if (index < 0 || values[index] === undefined) return invalid();
        return values[index];
      },
    };
  };
  if (method === "item/tool/requestUserInput") {
    const parsed = Questions.safeParse(params);
    if (!parsed.success)
      return unsupported(
        `${parsed.error.issues[0].path.join(".")}: the native question shape is not supported.`,
      );
    const native = parsed.data;
    if (new Set(native.questions.map((q) => q.id)).size !== native.questions.length)
      return unsupported("The native question identities are ambiguous.");
    const secret = native.questions.findIndex((q) => q.isSecret);
    if (secret >= 0)
      return unsupported(
        `questions.${secret}.isSecret: shared organization Forms cannot preserve secret-input privacy.`,
      );
    const fields: Form["fields"] = [];
    const rows = native.questions.map((q, index) => {
      const selection =
        !q.isOther && q.options?.length
          ? choices(
              q.options.map((o) => o.label),
              q.options.map((o) => o.label),
              `questions.${index}.options`,
            )
          : undefined;
      const primary = name(index);
      fields.push({
        name: primary,
        label: [
          q.header,
          q.question,
          ...(q.options ?? []).map((o) => `${o.label}: ${o.description}`),
          q.isOther && q.options?.length ? "Enter a choice label or your own answer." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        required: false,
        ...(selection ? { options: selection.display } : {}),
      });
      return {
        id: q.id,
        value: (answers: Record<string, string>) => {
          const value = answers[primary];
          return !Object.hasOwn(answers, primary) || (selection && !value.trim())
            ? []
            : [selection?.value(value) ?? value];
        },
      };
    });
    return finish(fields, (answers) =>
      responseFor(method, native, "accept", {
        answers: Object.fromEntries(rows.map((row) => [row.id, { answers: row.value(answers) }])),
      }),
    );
  }
  if (method === "mcpServer/elicitation/request") {
    if (!["form", "openai/form", "openaiForm"].includes(params.mode))
      return unsupported(
        "URL-based and unknown elicitation modes cannot be represented by these Forms.",
      );
    const raw = params.requestedSchema;
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !raw.properties ||
      typeof raw.properties !== "object" ||
      Array.isArray(raw.properties)
    )
      return unsupported(
        "requestedSchema.properties: only flat MCP primitive fields are supported.",
      );
    const properties = Object.fromEntries(
      Object.entries(raw.properties).map(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return unsupported(
            `requestedSchema.properties.${key}: a typed primitive field is required.`,
          );
        const field = value as Record<string, unknown>;
        // Native form-mode Option fields use null for absence; arbitrary schemas retain every key.
        const nullable =
          params.mode !== "form"
            ? []
            : [
                "title",
                "description",
                "default",
                ...(field.type === "string"
                  ? "enum" in field
                    ? ["enumNames"]
                    : "oneOf" in field
                      ? []
                      : ["minLength", "maxLength", "format"]
                  : field.type === "number" || field.type === "integer"
                    ? ["minimum", "maximum"]
                    : []),
              ];
        return [key, absentOptions(field, nullable)];
      }),
    );
    const normalized = {
      ...absentOptions(raw, params.mode === "form" ? ["$schema", "required"] : []),
      properties,
    };
    const parsed = ElicitRequestFormParamsSchema.safeParse({
      mode: "form",
      message: params.message,
      requestedSchema: normalized,
    });
    if (!parsed.success)
      return unsupported(
        `${parsed.error.issues[0].path.join(".")}: only flat MCP primitives and single-choice enums are supported.`,
      );
    const extra = Object.keys(normalized).find(
      (key) => !["$schema", "type", "properties", "required"].includes(key),
    );
    if (extra)
      return unsupported(
        `requestedSchema.${extra}: this constraint is outside the typed flat MCP form contract.`,
      );
    const schema = parsed.data.requestedSchema;
    const missing = Object.keys(properties).find((key) => !Object.hasOwn(schema.properties, key));
    if (missing)
      return unsupported(
        `requestedSchema.properties.${missing}: the typed MCP parser did not preserve this field.`,
      );
    if (schema.required?.some((key) => !Object.hasOwn(schema.properties, key)))
      return unsupported("requestedSchema.required: a required field has no primitive definition.");
    if (schema.required?.length)
      return unsupported(
        `requestedSchema.required.0 (${schema.required[0]}): Forms cannot require values only for Accept while allowing Decline and Cancel without them.`,
      );
    const rows = Object.entries(schema.properties).map(([key, property], index) => {
      if (property.type === "array")
        return unsupported(
          `requestedSchema.properties.${key}: a multi-select value cannot fit one string field.`,
        );
      const rawProperty = properties[key];
      if (!isDeepStrictEqual(rawProperty, property)) {
        const dropped = Object.keys(rawProperty).find(
          (k) => !isDeepStrictEqual(rawProperty[k], (property as any)[k]),
        );
        return unsupported(
          `requestedSchema.properties.${key}${dropped ? `.${dropped}` : ""}: the typed MCP parser does not preserve these constraints.`,
        );
      }
      if (property.type === "number" || property.type === "integer")
        return unsupported(
          `requestedSchema.properties.${key}.type: Forms cannot validate numeric text before accepting a response.`,
        );
      const selection =
        "oneOf" in property
          ? choices(
              property.oneOf.map((o) => o.title),
              property.oneOf.map((o) => o.const),
              `requestedSchema.properties.${key}.oneOf`,
            )
          : "enum" in property
            ? choices(
                ("enumNames" in property && property.enumNames) || property.enum,
                property.enum,
                `requestedSchema.properties.${key}.${"enumNames" in property && property.enumNames ? "enumNames" : "enum"}`,
              )
            : undefined;
      const maximumAnswerLength = BUILTINS.form_respond.request.shape.answers.valueType.maxLength;
      if (
        "minLength" in property &&
        property.minLength !== undefined &&
        maximumAnswerLength !== null &&
        property.minLength > maximumAnswerLength
      )
        return unsupported(
          `requestedSchema.properties.${key}.minLength: exceeds the Form answer maximum ${maximumAnswerLength}.`,
        );
      const unvalidated =
        "format" in property && property.format
          ? "format"
          : "minLength" in property && property.minLength
            ? "minLength"
            : "maxLength" in property &&
                property.maxLength !== undefined &&
                (maximumAnswerLength === null || property.maxLength < maximumAnswerLength)
              ? "maxLength"
              : undefined;
      if (unvalidated)
        return unsupported(
          `requestedSchema.properties.${key}.${unvalidated}: Forms cannot enforce this constraint before accepting a response.`,
        );
      const field = {
        name: name(index + 1),
        required: false,
        label: [params.message, property.title ?? key, property.description]
          .filter(Boolean)
          .join("\n"),
        ...(selection
          ? { options: selection.display }
          : property.type === "boolean"
            ? { options: ["Yes", "No"] }
            : {}),
      };
      return {
        key,
        field,
        omitBlank: !!selection || property.type === "boolean",
        value: (answer: string): unknown => {
          if (selection) return selection.value(answer);
          if (property.type === "boolean") {
            if (answer !== "Yes" && answer !== "No") return invalid();
            return answer === "Yes";
          }
          return answer;
        },
      };
    });
    const validationSchema = { ...schema, ...(raw.$schema ? { $schema: raw.$schema } : {}) };
    try {
      new AjvJsonSchemaValidator().getValidator(validationSchema);
    } catch {
      return unsupported(
        "requestedSchema: the native schema cannot be validated by the installed MCP SDK.",
      );
    }
    return finish(
      [
        {
          name: name(0),
          label: `${params.message}\nChoose Accept to submit values, Decline to refuse, or Cancel to stop.`,
          required: true,
          options: ["Accept", "Decline", "Cancel"],
        },
        ...rows.map((row) => row.field),
      ],
      (answers) => {
        const decisions: Record<string, string> = {
          Accept: "accept",
          Decline: "decline",
          Cancel: "cancel",
        };
        const choice = decisions[answers[name(0)]];
        if (!choice) return invalid();
        if (choice !== "accept") return responseFor(method, params, choice, null);
        return responseFor(
          method,
          { ...params, requestedSchema: validationSchema },
          "accept",
          Object.fromEntries(
            rows
              .filter(
                (row) =>
                  Object.hasOwn(answers, row.field.name) &&
                  !(row.omitBlank && !answers[row.field.name].trim()),
              )
              .map((row) => [row.key, row.value(answers[row.field.name])]),
          ),
        );
      },
    );
  }
  return finish(
    [
      {
        name: name(0),
        label: requestReview(method, params),
        required: true,
        options: ["Approve", "Decline", "Cancel"],
      },
    ],
    (answers) => {
      const decisions: Record<string, string> = {
        Approve: "accept",
        Decline: "decline",
        Cancel: "cancel",
      };
      const choice = decisions[answers[name(0)]];
      if (!choice) return invalid();
      return responseFor(method, params, choice, null);
    },
  );
}
