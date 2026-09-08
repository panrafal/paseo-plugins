import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listScheduleRuns } from "../shared/contracts";

/** The daemon rewrites a schedule file on every run transition; this is how often we look. */
const REFRESH_INTERVAL_MS = 15_000;

export function scheduleRunsQueryKey(hostId: string, includeHeartbeats: boolean) {
  return ["schedule-runs", hostId, includeHeartbeats] as const;
}

/**
 * Polls the server entry for the run feed. Toggling heartbeats changes the key, so the two
 * views are cached separately; `keepPreviousData` keeps the list on screen across the switch
 * and across every refetch instead of flashing a spinner.
 */
export function useScheduleRuns(hostId: string, includeHeartbeats: boolean) {
  const list = useRpc(listScheduleRuns);
  return useQuery({
    queryKey: scheduleRunsQueryKey(hostId, includeHeartbeats),
    queryFn: () => list({ includeHeartbeats }),
    refetchInterval: REFRESH_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
}
