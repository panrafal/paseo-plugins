import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export { DEFAULT_TASK_LINK_SETTINGS, type TaskLinkSettings } from "./link";

export const TaskPatternSchema = z.string().min(1, "Enter a regular expression.")
  .max(2_048, "The regular expression is too long.")
  .refine((pattern) => {
    try { new RegExp(pattern, "g"); return true; } catch { return false; }
  }, "Enter a valid JavaScript regular expression without / delimiters or flags.");

export const UrlTemplateSchema = z.string().trim().min(1, "Enter a link.")
  .max(4_096, "The link is too long.")
  .refine((template) => template.includes("{ID}"), "Include {ID} where the task ID belongs.")
  .refine((template) => {
    try {
      const url = new URL(template.replaceAll("{ID}", "CT-1234"));
      return url.protocol === "https:" || url.protocol === "http:";
    } catch { return false; }
  }, "Enter a valid HTTP or HTTPS link.");

export const TaskLinkSettingsSchema = z.object({
  pattern: TaskPatternSchema,
  urlTemplate: UrlTemplateSchema,
});

export const getTaskLinkSettings = defineRpc({
  name: "task-link.settings.get",
  input: z.object({}),
  output: TaskLinkSettingsSchema,
});

export const setTaskLinkSettings = defineRpc({
  name: "task-link.settings.set",
  input: TaskLinkSettingsSchema,
  output: TaskLinkSettingsSchema,
});
