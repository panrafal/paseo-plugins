import { useRpc } from "@getpaseo/plugin";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DecorationProjectInput, Decorations } from "../shared/contracts";
import { getDecorations } from "../shared/contracts";

/**
 * Project icons and the workspace-label catalog live on the daemon's disk, so they arrive through
 * the plugin's own RPC. Both change rarely: the query is keyed by a signature of the projects it
 * covers, held stale for five minutes, and the previous answer keeps rendering while a new set of
 * projects is fetched so icons do not blink away on every directory update.
 */

const STALE_TIME_MS = 5 * 60_000;

const EMPTY_DECORATIONS: Decorations = { icons: {}, labels: [] };

/** Identity of a decoration request: the icon depends on all three fields. */
function projectSignature(projects: readonly DecorationProjectInput[]): string {
  return projects
    .map(
      (project) =>
        `${project.projectId}|${project.customIconRevision ?? "auto"}|${project.rootPath}`,
    )
    .sort()
    .join("\n");
}

export function useDecorations(
  hostId: string,
  projects: readonly DecorationProjectInput[],
): Decorations {
  const fetchDecorations = useRpc(getDecorations);
  const signature = useMemo(() => projectSignature(projects), [projects]);

  const query = useQuery({
    queryKey: ["agents-dash-list", "decorations", hostId, signature],
    queryFn: () => fetchDecorations({ projects: [...projects] }),
    enabled: projects.length > 0,
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });

  return query.data ?? EMPTY_DECORATIONS;
}
