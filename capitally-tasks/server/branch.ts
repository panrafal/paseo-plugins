import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { getBranch } from "../shared/task";

const GIT_TIMEOUT_MS = 5_000;

/**
 * Resolves the branch checked out in `directory`, or `null` when the directory
 * is not a git checkout, is in detached HEAD state, or git is unavailable.
 * Failures are reported as `null` rather than thrown: a missing branch simply
 * means no pill.
 */
export function readBranch({
  directory,
}: RpcInput<typeof getBranch>): Promise<{ branch: string | null }> {
  if (!isAbsolute(directory)) return Promise.resolve({ branch: null });
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ branch: null });
          return;
        }
        const branch = stdout.trim();
        resolve({ branch: branch && branch !== "HEAD" ? branch : null });
      },
    );
  });
}
