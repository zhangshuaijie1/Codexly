import { Type, type Static } from "@sinclair/typebox";

export const AntigravitySessionIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const AntigravitySessionPageSchema = Type.Object({
  data: Type.Array(
    Type.Object({
      id: AntigravitySessionIdSchema,
      cwd: Type.String(),
      title: Type.String(),
      updatedAt: Type.String(),
    }),
  ),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type AntigravitySessionPage = Static<typeof AntigravitySessionPageSchema>;
