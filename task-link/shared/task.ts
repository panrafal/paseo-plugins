import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Reads the checked-out branch of a directory on the daemon machine. The client
 * never sees the filesystem, so the lookup has to run beside the daemon.
 */
export const getBranch = defineRpc({
  name: "task-link.branch",
  input: z.object({ directory: z.string().min(1) }),
  output: z.object({ branch: z.string().nullable() }),
});
