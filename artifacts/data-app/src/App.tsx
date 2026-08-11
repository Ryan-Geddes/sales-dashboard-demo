import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import Dashboard, { getImpersonatedUser } from "./pages/Dashboard";
import DemoLogin from "@/components/DemoLogin";
import { Toaster } from "@/components/ui/toaster";
import { isDemoMode } from "@/lib/demo-mode";
import { LogIn } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AuthGate() {
  const { user, isLoading, isAuthenticated, login } = useAuth();

  const continueAsGuest = async () => {
    await fetch("/api/guest-login", {
      method: "POST",
      credentials: "include",
    });
    window.location.reload();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-[14px] text-[#64748b]">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Demo deployments have no Replit OIDC — show the role/name + GitHub-owner
    // login instead. isDemoMode() is false on the live server, so the original
    // screen below is untouched there.
    if (isDemoMode()) return <DemoLogin />;
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a1628] p-6">
        <div className="bg-white rounded-lg shadow-xl p-8 w-[420px] text-center">
          <h1 className="font-bold text-[20px] text-[#0a1628] mb-2">Frontline Sales Dashboard</h1>
          <p className="text-[13px] text-[#64748b] mb-6">Sign in with your Replit account to continue.</p>
          <button
            onClick={login}
            className="w-full h-[40px] bg-[#006AFF] text-white rounded-md text-[14px] font-medium hover:bg-[#005ce6] transition-colors flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" /> Log in
          </button>
          <button
            onClick={continueAsGuest}
            className="mt-3 text-[12px] text-[#64748b] hover:text-[#0a1628] hover:underline"
          >
            Continue without signing in
          </button>
        </div>
      </div>
    );
  }

  // Authenticated, but no role assigned in the hierarchy.
  if (!user?.role) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a1628] p-6">
        <div className="bg-white rounded-lg shadow-xl p-8 w-[460px] text-center">
          <h1 className="font-bold text-[18px] text-[#0a1628] mb-2">Access not yet provisioned</h1>
          <p className="text-[13px] text-[#64748b] mb-4">
            You're signed in as <span className="font-medium text-[#0a1628]">{user?.email ?? "your account"}</span>,
            but your account isn't set up for this dashboard yet. Please contact an admin to be added.
          </p>
          <button
            onClick={continueAsGuest}
            className="w-full h-[40px] bg-[#006AFF] text-white rounded-md text-[14px] font-medium hover:bg-[#005ce6] transition-colors"
          >
            Continue in view-only mode
          </button>
          <a
            href="/api/logout"
            className="inline-block mt-3 text-[12px] text-[#006AFF] hover:underline"
          >
            Log out
          </a>
        </div>
      </div>
    );
  }

  const isViewOnly = user.viewOnly === true;
  const ALLOW_ROLE_OVERRIDE = import.meta.env.DEV || isViewOnly;
  const roleOverride = ALLOW_ROLE_OVERRIDE
    ? new URLSearchParams(window.location.search).get("role")
    : null;
  const validRoles = isViewOnly && !import.meta.env.DEV
    ? new Set(["rep"])
    : new Set(["guest", "rep", "flm", "slm", "exec", "admin", "viewer"]);
  let effectiveUser = roleOverride && validRoles.has(roleOverride)
    ? { ...user, role: roleOverride as typeof user.role }
    : user;
  const allowImpersonate = user.role === "admin" || (isViewOnly && import.meta.env.DEV);
  if (allowImpersonate) {
    const imp = getImpersonatedUser();
    if (imp) {
      effectiveUser = {
        ...effectiveUser,
        id: imp.id,
        email: imp.email,
        firstName: imp.firstName,
        lastName: imp.lastName,
        profileImageUrl: imp.profileImageUrl,
        role: imp.role as typeof user.role,
        hierarchyName: imp.hierarchyName,
        // In dev, when impersonating, inherit the impersonated user's
        // write authorizations (don't carry the guest viewOnly flag).
        // Only safe to flip when the REAL session is also non-viewOnly —
        // otherwise the client claims write access while the server's
        // session-bound viewOnly:true keeps rejecting writes with 403,
        // which surfaced as the "value isn't saved" Task #161 symptom.
        ...(import.meta.env.DEV && !isViewOnly ? { viewOnly: false as any } : {}),
      };
    }
  }
  return <Dashboard authUser={effectiveUser} realUser={user} allowImpersonate={allowImpersonate} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
