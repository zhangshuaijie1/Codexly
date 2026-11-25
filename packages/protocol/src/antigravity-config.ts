import { Type, type Static } from "@sinclair/typebox";

export const AntigravityConfigSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal("inherit"),
      Type.Literal("default"),
      Type.Literal("accept-edits"),
      Type.Literal("auto"),
      Type.Literal("plan"),
    ]),
    instructions: Type.String({ maxLength: 32000 }),
    instructionsPath: Type.Optional(Type.String()),
    revision: Type.String(),
  },
  { additionalProperties: false },
);
export type AntigravityConfig = Static<typeof AntigravityConfigSchema>;
