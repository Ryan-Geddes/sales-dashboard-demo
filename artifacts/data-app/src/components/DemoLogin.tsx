// Demo-mode sign-in screen.
//
// Rendered instead of the Replit "Log in" button when the server reports
// DEMO_MODE (see lib/demo-mode.ts). Two ways in:
//   * pick a Role, then a Name (populated from /api/auth/demo/users, which is
//     derived from the same anonymized hierarchy the dashboard renders), or
//   * "Owner sign-in with GitHub" — restricted to the repo owner.
//
// Styling mirrors the existing auth screen in App.tsx (deep navy backdrop, one
// white card) and uses the repo's shadcn Button/Select primitives.

import { useEffect, useMemo, useState } from "react";
import { LogIn, Loader2, ShieldCheck } from "lucide-react";
import { SiGithub } from "react-icons/si";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAuthMode } from "@/lib/demo-mode";

const API_BASE = import.meta.env.BASE_URL || "/";

interface DemoRoleOption {
  id: string;
  label: string;
  kind: "people" | "fixed" | "github";
  description: string;
  users: string[];
}

interface DemoUsersResponse {
  roles: DemoRoleOption[];
  githubConfigured: boolean;
}

export default function DemoLogin() {
  const mode = getAuthMode();
  const [roles, setRoles] = useState<DemoRoleOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}api/auth/demo/users`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<DemoUsersResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setRoles(data.roles ?? []);
        // Default to the first selectable (non-GitHub) role.
        const first = (data.roles ?? []).find((r) => r.kind !== "github");
        if (first) {
          setRoleId(first.id);
          setName(first.users.length === 1 ? first.users[0] : "");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectableRoles = useMemo(
    () => (roles ?? []).filter((r) => r.kind !== "github"),
    [roles],
  );
  const selectedRole = useMemo(
    () => selectableRoles.find((r) => r.id === roleId) ?? null,
    [selectableRoles, roleId],
  );
  const needsName = selectedRole?.kind === "people";
  const canSubmit = !!selectedRole && !!name && !submitting;

  const onRoleChange = (next: string) => {
    setRoleId(next);
    setError(null);
    const role = selectableRoles.find((r) => r.id === next);
    // Executive / Admin have exactly one identity — preselect it so the user
    // only has to press Sign in.
    setName(role && role.users.length === 1 ? role.users[0] : "");
  };

  const signIn = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}api/auth/demo/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: roleId, name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Sign-in failed (${res.status})`);
      }
      window.location.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const githubHref = `${API_BASE}api/auth/demo/github`;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a1628] p-6">
      <div className="bg-white rounded-lg shadow-xl p-8 w-[440px]">
        <div className="text-center mb-6">
          <h1 className="font-bold text-[20px] text-[#0a1628] mb-1">
            Frontline Sales Dashboard
          </h1>
          <p className="text-[13px] text-[#64748b]">
            Interactive demo — all names, accounts and numbers are anonymized.
          </p>
        </div>

        {loadError && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700">
            Couldn't load the demo users ({loadError}). Try reloading the page.
          </div>
        )}

        {!roles && !loadError && (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-[#64748b]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading demo users…
          </div>
        )}

        {roles && (
          <>
            <label className="block text-[12px] font-medium text-[#0a1628] mb-1">
              Role
            </label>
            <Select value={roleId} onValueChange={onRoleChange}>
              <SelectTrigger className="w-full mb-1" data-testid="select-demo-role">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {selectableRoles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRole && (
              <p className="text-[11px] text-[#64748b] mb-4">
                {selectedRole.description}
              </p>
            )}

            {needsName && (
              <>
                <label className="block text-[12px] font-medium text-[#0a1628] mb-1">
                  Name
                </label>
                <Select value={name} onValueChange={setName}>
                  <SelectTrigger
                    className="w-full mb-4"
                    data-testid="select-demo-name"
                  >
                    <SelectValue placeholder={`Choose a ${selectedRole?.label}`} />
                  </SelectTrigger>
                  <SelectContent className="max-h-[320px]">
                    {selectedRole?.users.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}

            {error && (
              <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700">
                {error}
              </div>
            )}

            <Button
              className="w-full"
              onClick={signIn}
              disabled={!canSubmit}
              data-testid="button-demo-signin"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
              Sign in
            </Button>

            <div className="flex items-center gap-3 my-5">
              <div className="h-px flex-1 bg-[#e2e8f0]" />
              <span className="text-[11px] uppercase tracking-wide text-[#94a3b8]">
                or
              </span>
              <div className="h-px flex-1 bg-[#e2e8f0]" />
            </div>

            <Button
              variant="outline"
              className="w-full"
              asChild
              data-testid="button-demo-github"
            >
              <a href={githubHref}>
                <SiGithub className="w-4 h-4" />
                Owner sign-in with GitHub
              </a>
            </Button>
            <p className="mt-2 text-[11px] text-[#64748b] text-center">
              {mode.githubConfigured === false
                ? "Not configured on this deployment."
                : `Restricted to @${mode.githubOwnerLogin ?? "the repo owner"}.`}
            </p>

            <p className="mt-6 flex items-start gap-2 text-[11px] text-[#64748b]">
              <ShieldCheck className="w-3.5 h-3.5 mt-[1px] shrink-0" />
              <span>
                Demo edits are private to your session and are discarded when you
                sign out — everyone else keeps seeing the original data.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
