import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL || "/";

export const PHOTO_MAP_QUERY_KEY = ["sales", "photos"] as const;

interface PhotosResponse {
  photos?: Record<string, string>;
}

export function usePhotoMap() {
  return useQuery<Record<string, string>>({
    queryKey: PHOTO_MAP_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}api/sales/photos`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch photos (${res.status})`);
      const data: PhotosResponse = await res.json();
      return data.photos ?? {};
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function resolvePhotoUrl(
  photos: Record<string, string> | undefined,
  ...candidateNames: Array<string | null | undefined>
): string | null {
  if (!photos) return null;
  for (const name of candidateNames) {
    if (!name) continue;
    const trimmed = name.trim();
    if (!trimmed) continue;
    const url = photos[trimmed];
    if (url) return `${API_BASE}${url.replace(/^\/api\//, "api/")}`;
  }
  return null;
}
