import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installSnapshotFetchInterceptor } from "./lib/snapshot";
import { loadAuthMode } from "./lib/demo-mode";

installSnapshotFetchInterceptor();

// Resolve the runtime auth/config flags BEFORE the first render so synchronous
// consumers (notably getTodayPST(), which the demo pins to the snapshot date)
// never see a half-initialized value. The request is a tiny JSON payload served
// straight from memory, and any failure resolves to live defaults, so the live
// app's startup behavior is unchanged.
void loadAuthMode().finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
