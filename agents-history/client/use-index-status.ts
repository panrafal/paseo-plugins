import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { indexStatus } from "../shared/contracts";

/**
 * Where the search index stands on the selected host. Polled quickly while it is being built so
 * the note under the filters counts up, slowly once it is idle, and not at all in regex mode.
 */

const IDLE_INTERVAL_MS = 30_000;
const BUSY_INTERVAL_MS = 2_000;

export function useIndexStatus(hostId: string, enabled: boolean) {
  const status = useRpc(indexStatus);
  return useQuery({
    queryKey: ["agents-history", "index-status", hostId] as const,
    queryFn: () => status({}),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !data.available) return IDLE_INTERVAL_MS;
      return data.state === "idle" && !data.stale ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS;
    },
  });
}
