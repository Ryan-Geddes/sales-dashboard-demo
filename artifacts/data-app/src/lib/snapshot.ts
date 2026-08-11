// Task #393: per-user / per-browser data snapshot selection.
//
// The dashboard can be re-rendered from a captured upstream snapshot
// (nightly date or the most recent "good" refresh) instead of live data.
// The selection is per-user and persists in localStorage. A global
// window.fetch interceptor stamps the chosen snapshot onto every
// /api/sales request via the X-Data-Snapshot header; the server replays
// that snapshot with live DB overrides on top. The server echoes the
// snapshot capture time in X-Snapshot-Captured-At so the header can show
// "Last Refresh SNAPSHOT: <pacific>".

const SELECTOR_KEY = "data_snapshot_selector";
const CAPTURED_AT_HEADER = "x-snapshot-captured-at";

export const LIVE_SELECTOR = "live";

let capturedAt: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshotSelector(): string {
  try {
    return localStorage.getItem(SELECTOR_KEY) || LIVE_SELECTOR;
  } catch {
    return LIVE_SELECTOR;
  }
}

export function setSnapshotSelector(selector: string): void {
  try {
    if (!selector || selector === LIVE_SELECTOR) {
      localStorage.removeItem(SELECTOR_KEY);
    } else {
      localStorage.setItem(SELECTOR_KEY, selector);
    }
  } catch {
    /* ignore */
  }
  if (!selector || selector === LIVE_SELECTOR) {
    capturedAt = null;
  }
  notify();
}

export function isSnapshotMode(): boolean {
  return getSnapshotSelector() !== LIVE_SELECTOR;
}

export function getSnapshotCapturedAt(): string | null {
  return capturedAt;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
  return (input as Request).url;
}

export function installSnapshotFetchInterceptor(): void {
  const w = window as unknown as { __snapshotFetchInstalled?: boolean };
  if (w.__snapshotFetchInstalled) return;
  w.__snapshotFetchInstalled = true;

  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = "";
    try {
      url = urlOf(input);
    } catch {
      return original(input, init);
    }

    const selector = getSnapshotSelector();
    if (!url.includes("/api/sales") || selector === LIVE_SELECTOR) {
      return original(input, init);
    }

    const headers = new Headers(
      init?.headers ??
        (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
    );
    headers.set("X-Data-Snapshot", selector);
    const nextInit: RequestInit = { ...init, headers };

    const response = await original(input, nextInit);
    const ca = response.headers.get(CAPTURED_AT_HEADER);
    if (ca && ca !== capturedAt) {
      capturedAt = ca;
      notify();
    }
    return response;
  };
}
