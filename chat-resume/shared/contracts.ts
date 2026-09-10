import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const AgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Invalid agent ID");

export const inspectUsageRpc = defineRpc({
  name: "chat-resume.inspect",
  input: z.object({
    agentIds: z.array(AgentIdSchema).min(1).max(200),
  }),
  output: z.object({
    inspections: z.array(
      z.object({
        agentId: z.string(),
        exhausted: z.boolean(),
        resetAt: z.string().nullable(),
      }),
    ),
  }),
});

export const scheduleResumeRpc = defineRpc({
  name: "chat-resume.schedule",
  input: z.object({
    agentId: AgentIdSchema,
  }),
  output: z.object({
    scheduleId: z.string(),
    scheduledFor: z.string(),
  }),
});
