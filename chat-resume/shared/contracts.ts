import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const scheduleResumeRpc = defineRpc({
  name: "chat-resume.schedule",
  input: z.object({
    agentId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Invalid agent ID"),
  }),
  output: z.object({
    scheduleId: z.string(),
    scheduledFor: z.string(),
  }),
});
