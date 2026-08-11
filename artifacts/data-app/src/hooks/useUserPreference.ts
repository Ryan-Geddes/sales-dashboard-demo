import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetUserPreference,
  useSetUserPreference,
  useDeleteUserPreference,
  getGetUserPreferenceQueryKey,
} from "@workspace/api-client-react";

/**
 * useUserPreference - read & write a single per-user preference value
 * stored on the server.
 *
 * Returns:
 *   - value: the current value (`unknown`), or `null` if unset, or
 *     `undefined` while loading.
 *   - setValue(value): persists the new value and updates the cache.
 *   - removeValue(): deletes the preference.
 *   - isLoading: true on first fetch.
 */
export function useUserPreference<T = unknown>(key: string) {
  const queryClient = useQueryClient();

  const query = useGetUserPreference(key, {
    query: {
      queryKey: getGetUserPreferenceQueryKey(key),
      staleTime: 5 * 60 * 1000,
    },
  });

  const setMutation = useSetUserPreference();
  const deleteMutation = useDeleteUserPreference();

  const value = query.data?.value as T | null | undefined;

  const setValue = useCallback(
    async (next: T) => {
      await setMutation.mutateAsync({ key, data: { value: next } });
      queryClient.setQueryData(getGetUserPreferenceQueryKey(key), {
        value: next,
      });
    },
    [setMutation, key, queryClient],
  );

  const removeValue = useCallback(async () => {
    await deleteMutation.mutateAsync({ key });
    queryClient.setQueryData(getGetUserPreferenceQueryKey(key), {
      value: null,
    });
  }, [deleteMutation, key, queryClient]);

  return {
    value,
    setValue,
    removeValue,
    isLoading: query.isLoading,
    error: query.error ?? setMutation.error ?? deleteMutation.error ?? null,
  };
}
