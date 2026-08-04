# GTM Performance Dashboard — Public Demo

A sales-performance and revenue-attribution dashboard for a mid-size B2B GTM
org: pipeline and funnel analytics, activity tracking, quota attainment,
commission modelling, and a rules engine that decides which revenue counts
toward which rep's number.

**This repository is a fully anonymized demo.** Every name, account, email,
opportunity and dollar figure is synthetic. There are no credentials, no
customer records, and no connection to any production system. It runs entirely
from a bundled fixture set plus a throwaway Postgres database.

---

## Try it

Pick a role on the login screen — no signup, no password:

| Login | What you see |
| --- | --- |
| **Rep** | One person's pipeline, activity, quota and commission. |
| **Front-Line Manager** | A single team: their reps, roll-ups, and coaching views. |
| **Senior Leader** | A multi-team org with drill-down into any FLM or rep. |
| **Executive** | Org-wide attainment, forecast and revenue attribution. |
| **Admin** | Everything above, plus the configuration surfaces (comp rules, roster, goals). |
| **Owner** | GitHub sign-in, restricted to the repo owner. The only login whose edits persist. |

Every non-Owner login runs inside a **per-session database transaction that is
rolled back when the session ends**. You can freely edit comp rules, override
probabilities, reassign the roster — nothing you do affects anyone else's
session, and everything resets when you leave.

The Rep / FLM / Senior Leader dropdowns are populated from the same org
hierarchy the app itself is built from, so role scoping in the demo behaves
exactly the way it does for a real user in that position.

---

## What's in it

**Pipeline & Funnel** — Stage-by-stage conversion, MRR waterfalls, scheduled
modifications, churn, and per-product breakdowns. Every aggregate is clickable
down to the individual opportunity.

**Activity** — Dials, emails, demos, inbound leads and skill-building sessions,
attributed to reps and rolled up through the hierarchy, with drilldowns to the
underlying CRM records.

**Compensation** — A configurable rules engine (conditions on opportunity type,
product, quote type; per-product MRR field selection; multipliers) plus a live
tester that shows exactly which rule fired for any given deal and why.

**Quota & Goals** — Monthly/quarterly targets per rep and per team, attainment
tracking, and pacing.

**Executive** — Attainment and revenue-attribution roll-ups across the whole
org, plus a reconciliation view that diffs CRM-sourced revenue against the
planning system's numbers and explains each gap.

**Roster** — Effective org hierarchy with per-month overrides: reps can be
marked inactive or reassigned for a specific month, and every downstream
aggregate recomputes against that month's shape rather than today's.

**Admin** — Role management, impersonation, product-logic configuration, and
data-refresh controls.

---

## Architecture

```
┌───────────────────────────┐        ┌──────────────────────────────┐
│  data-app (React + Vite)  │  /api  │  api-server (Express + Node) │
│  TanStack Query, Tailwind │ ─────► │  Zod-validated route layer   │
│  Recharts, wouter         │        │  Drizzle ORM ► Postgres      │
└───────────────────────────┘        └──────────────────────────────┘
              ▲                                     │
              │ generated client                    │ demo fixtures
              │                                     ▼
     ┌────────┴─────────┐              ┌──────────────────────────┐
     │  lib/api-spec    │              │  demo-data/snapshot.json │
     │  OpenAPI 3.1     │              │  demo-data/db-seed.json  │
     └──────────────────┘              └──────────────────────────┘
```

A pnpm monorepo:

| Path | What it is |
| --- | --- |
| `artifacts/data-app` | The React frontend. Vite, TypeScript, Tailwind, shadcn/ui, Recharts. |
| `artifacts/api-server` | Express API. Session auth, role-based access control, all business logic. |
| `lib/api-spec` | OpenAPI 3.1 document — the contract both sides are generated from. |
| `lib/api-zod` | Zod schemas generated from the spec; the server validates every request and response against them. |
| `lib/api-client-react` | Typed TanStack Query hooks generated from the spec; the frontend never hand-writes a fetch. |
| `lib/db` | Drizzle schema and the shared connection pool. |

**The OpenAPI document is the single source of truth.** Both the runtime
validators and the frontend's data-fetching hooks are generated from it, so a
contract change that isn't reflected on both sides fails typecheck.

### How the demo runs without any upstream systems

In production this app reads from a data warehouse, a CRM, and a set of
spreadsheets. In demo mode (`DEMO_MODE=1`) every one of those integrations is
replaced at the boundary:

- **`demo-data/snapshot.json`** — a captured, anonymized response for every
  upstream query the app makes. Warehouse and spreadsheet calls are served from
  here; no network call is ever attempted.
- **`demo-data/db-seed.json`** — the mutable state (comp rules, goals, roster
  overrides, preferences) seeded into Postgres on first boot, idempotently.
- **Auth** — the OIDC provider is swapped for the role picker described above.
- **Outbound side effects** — email and chat notifications are no-ops.

The upstream clients are never even constructed in demo mode, so there is no
credential to leak and no way for a misconfiguration to reach a real system.

---

## Data model

The core object graph the dashboard is built on:

```
Organization hierarchy          Revenue
─────────────────────           ───────
VP                              Account
 └─ Senior Leader (SLM)          └─ Opportunity ──── Line Item (product, MRR)
     └─ Front-Line Mgr (FLM)          │                    │
         └─ Rep ──────────────────────┘                    │
             │                                             ▼
             │                              Compensable MRR (rules engine)
             ├─ Activity (dials, emails, demos, sessions)
             ├─ Quota / Goal (per month, per product)
             └─ Roster Override (per month: active flag, reassignment)
```

Two ideas do most of the work:

**Effective hierarchy.** The org chart is not a static tree — it is recomputed
per month from the base roster plus that month's overrides. Ask for March and
you get March's org: people who left are gone, people who moved are under their
March manager, and every roll-up follows. This is what makes historical numbers
stay correct after a reorg.

**Compensable MRR.** Raw opportunity revenue is not what a rep is paid on. A
configurable rule set maps each line item to a compensable amount based on
opportunity type, product, quote type and a set of multipliers. The rules are
data, editable in the UI, and the Compensation Tester replays any deal through
them and shows the matched rule and the arithmetic.

---

## Running it locally

**Requirements:** Node 20+, pnpm 10+, and a Postgres database (any empty one —
it gets seeded automatically).

```bash
pnpm install

# Point at any empty Postgres database.
export DATABASE_URL="postgresql://user:pass@localhost:5432/demo"

# Create the tables.
pnpm --filter @workspace/db run push

# Terminal 1 — API + demo fixtures on :3000
cd artifacts/api-server
DEMO_MODE=1 PORT=3000 SESSION_SECRET=local-dev-secret pnpm run demo

# Terminal 2 — frontend on :5173
cd artifacts/data-app
PORT=5173 pnpm run dev
```

Open <http://localhost:5173>. The first data request parses the 55 MB snapshot
and takes a few seconds; everything after that is served from memory.

### Single-process mode

The API server can also serve the built frontend itself, which is how the
hosted demo runs:

```bash
pnpm --filter @workspace/data-app run build
cd artifacts/api-server
DEMO_MODE=1 PORT=3000 SESSION_SECRET=local-dev-secret pnpm run dev
```

Now <http://localhost:3000> serves both the UI and the API. Static serving is
enabled automatically by `DEMO_MODE`, or explicitly with `SERVE_STATIC=1`.

### Useful commands

```bash
pnpm run typecheck                        # every package
pnpm --filter @workspace/api-server test  # server test suite
pnpm run build                            # typecheck + build all packages
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `PORT` | yes | Port for the API server. |
| `SESSION_SECRET` | yes | Signs session cookies. Any random string locally. |
| `DEMO_MODE` | yes for the demo | `1` enables fixtures + the role-picker login. |
| `SERVE_STATIC` | no | `1` to serve the built frontend from the API process. Implied by `DEMO_MODE`. |
| `DEMO_DATA_DIR` | no | Override the fixture directory. |
| `STATIC_DIR` | no | Override the built-frontend directory. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Enables the Owner login. |
| `GITHUB_ALLOWED_LOGIN` | no | GitHub username permitted to sign in as Owner. |

---

## Owner sign-in (GitHub OAuth)

Optional. Without it, the Owner button reports that it isn't configured and the
six role logins work as normal.

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL**: your deployment's URL (e.g. `https://your-app.onrender.com`).
3. **Authorization callback URL**: that URL plus `/api/auth/demo/github/callback`.
4. Copy the Client ID, generate a Client Secret.
5. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_ALLOWED_LOGIN`
   (your GitHub username) on the deployment.

Only the username in `GITHUB_ALLOWED_LOGIN` is accepted; every other GitHub
account is rejected at the callback. Owner is the one login whose writes are
committed rather than rolled back at session end.

---

## Deploying for free

Two free accounts: **Neon** for Postgres, **Render** for the web service.

### 1. Database (Neon)

1. Create a free project at <https://neon.tech>.
2. Copy the pooled connection string (it ends in `?sslmode=require`).
3. Create the tables from your machine:

   ```bash
   DATABASE_URL="<neon-connection-string>" pnpm --filter @workspace/db run push
   ```

### 2. Web service (Render)

This repo includes `render.yaml`, so Render can configure the service itself:

1. Push this repo to your GitHub account.
2. At <https://render.com>: **New + → Blueprint**, select the repo.
3. Render reads `render.yaml` and prompts for the values marked as secrets.
   Paste the Neon connection string into `DATABASE_URL`; leave the GitHub OAuth
   variables blank unless you want the Owner login.
4. Deploy. First build takes a few minutes.

`SESSION_SECRET` is generated automatically. The service builds the frontend
and the API and runs both from one Node process on the free plan.

**Free-tier caveat:** the instance sleeps after ~15 minutes of inactivity, and
the first request after a sleep waits for a cold boot plus the snapshot parse —
roughly a minute. Subsequent requests are fast.

### Deploying anywhere else

Any Node host works. Build with:

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/data-app run build
pnpm --filter @workspace/api-server run build
```

then run `node artifacts/api-server/dist/index.cjs` with `DEMO_MODE=1`,
`DATABASE_URL`, `SESSION_SECRET` and `PORT` set. Make sure `demo-data/` ships
alongside the bundle, or point `DEMO_DATA_DIR` at wherever it lands.

---

## Notes on the anonymization

The demo fixtures were produced by a one-way transform of a production
snapshot: names, companies, emails and record identifiers were replaced with
generated equivalents, and monetary values were perturbed. The mapping is not
retained and the transform is not reversible. Relationships, distributions and
volumes are preserved so the dashboard exercises realistic shapes — but no
figure in this demo describes any real business.

External links (CRM record and report URLs) point at a placeholder host and are
configured via `VITE_SF_BASE_URL`, `VITE_SF_CLASSIC_BASE_URL` and
`VITE_SF_REPORTS`. They are intentionally dead in the demo.
