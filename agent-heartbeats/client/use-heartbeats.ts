import { useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listHeartbeats } from "../shared/contracts";

const REFRESH_INTERVAL_MS = 15_000;

export function heartbeatQueryKey(hostId: string, agentId: string) {
  return ["agent-heartbeats", hostId, agentId] as const;
}

export function useHeartbeats(hostId: string, agentId: string) {
  const list = useRpc(listHeartbeats);
  const queryKey = useMemo(() => heartbeatQueryKey(hostId, agentId), [agentId, hostId]);
  const query = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  return { query, queryKey };
}
