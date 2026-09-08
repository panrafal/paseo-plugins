import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UnreadMarks } from "../shared/contracts";
import { listUnreadMarks, setUnreadMark } from "../shared/contracts";

/**
 * The plugin's own "mark as unread" flags, stored per host by the server entry.
 *
 * `activeWorkspaceIds` only tells the server which marks may be pruned, so it is read from a ref
 * at fetch time rather than folded into the query key: the workspace directory changes constantly
 * and every change would otherwise drop the cache and refetch.
 */

const REFETCH_INTERVAL_MS = 30_000;

const EMPTY_MARKS: Readonly<Record<string, string>> = {};

export interface UnreadMarksApi {
  marks: Readonly<Record<string, string>>;
  setUnread(workspaceId: string, unread: boolean): Promise<void>;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not update the unread mark.";
}

export function useUnreadMarks(
  hostId: string,
  activeWorkspaceIds: readonly string[],
): UnreadMarksApi {
  const fetchMarks = useRpc(listUnreadMarks);
  const writeMark = useRpc(setUnreadMark);
  const queryClient = useQueryClient();
  const toast = useToast();

  const activeIdsRef = useRef(activeWorkspaceIds);
  useEffect(() => {
    activeIdsRef.current = activeWorkspaceIds;
  }, [activeWorkspaceIds]);

  // Keyed by host only; react-query hashes the key, and the mutation writes into this entry.
  const queryKey = useMemo(() => ["agents-dash-list", "unread", hostId] as const, [hostId]);

  const query = useQuery({
    queryKey,
    queryFn: () => {
      // The caller passes an empty list until the directory is fully loaded. Sending that would
      // ask the server to prune every mark, so pruning only rides along once ids are known.
      const active = activeIdsRef.current;
      return fetchMarks(active.length > 0 ? { activeWorkspaceIds: [...active] } : {});
    },
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const mutation = useMutation({
    mutationFn: (input: { workspaceId: string; unread: boolean }) => writeMark(input),
    // A poll or focus refetch may already be in flight; without this its older answer would land
    // after the mutation and undo the mark the user just set.
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess(marks: UnreadMarks) {
      queryClient.setQueryData(queryKey, marks);
    },
    onError(cause: unknown) {
      toast.error(errorMessage(cause));
    },
  });

  const mutateAsync = mutation.mutateAsync;
  const setUnread = useCallback(
    async (workspaceId: string, unread: boolean) => {
      try {
        await mutateAsync({ workspaceId, unread });
      } catch {
        // Already surfaced as a toast by `onError`; the dash keeps its current marks.
      }
    },
    [mutateAsync],
  );

  return { marks: query.data?.marks ?? EMPTY_MARKS, setUnread };
}
