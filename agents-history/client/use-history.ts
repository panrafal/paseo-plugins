import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listHistory } from "../shared/contracts";

/** The census is re-read on this cadence; the server re-parses only files that changed. */
const REFRESH_INTERVAL_MS = 30_000;

export function historyQueryKey(hostId: string) {
  return ["agents-history", "list", hostId] as const;
}

export function useHistory(hostId: string) {
  const list = useRpc(listHistory);
  return useQuery({
    queryKey: historyQueryKey(hostId),
    queryFn: () => list({}),
    refetchInterval: REFRESH_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
}
