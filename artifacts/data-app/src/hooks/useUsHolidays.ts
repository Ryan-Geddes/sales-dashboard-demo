import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL || "/";

interface UsHoliday {
  date: string;
  name: string;
}

interface UsHolidaysResponse {
  holidays: UsHoliday[];
  fetchError: boolean;
  fetchErrorMessage?: string;
}

export interface UsHolidaysResult {
  holidays: UsHoliday[];
  holidaySet: Set<string>;
  holidayNameMap: Map<string, string>;
  fetchError: boolean;
  fetchErrorMessage?: string;
  isLoading: boolean;
}

export function useUsHolidays(): UsHolidaysResult {
  const query = useQuery<UsHolidaysResponse>({
    queryKey: ["/api/sales/us-holidays"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}api/sales/us-holidays`, { credentials: "include" });
      if (!res.ok) {
        return { holidays: [], fetchError: true, fetchErrorMessage: `HTTP ${res.status}` };
      }
      return res.json();
    },
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return useMemo(() => {
    const holidays = query.data?.holidays ?? [];
    const holidaySet = new Set<string>();
    const holidayNameMap = new Map<string, string>();
    for (const h of holidays) {
      holidaySet.add(h.date);
      holidayNameMap.set(h.date, h.name);
    }
    return {
      holidays,
      holidaySet,
      holidayNameMap,
      fetchError: !!query.data?.fetchError || query.isError,
      fetchErrorMessage: query.data?.fetchErrorMessage,
      isLoading: query.isLoading,
    };
  }, [query.data, query.isError, query.isLoading]);
}
