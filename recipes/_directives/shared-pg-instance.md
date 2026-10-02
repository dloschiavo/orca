# Shared Postgres instance — `goliath-pg`

Onboarding + connection procedure for the shared Cloud SQL Postgres instance
that lower-demand GDI projects share. Binding whenever you provision a
datastore, pick where a project's Postgres DB should live, or wire a Goliath
service to Postgres.

## The convention (state-independent — this is the operative rule)

- **Lower-demand GDI projects share ONE Postgres instance; do NOT spin up a
  new Cloud SQL instance per project.** New instances cost a full box's
  baseline each — pile low-traffic projects onto the shared instance instead.
- **One database + one dedicated user per project** on the shared instance.
  Never reuse another project's DB or user.
- **The shared instance is explicitly NOT SOC-2 scoped.** Anything with a
  compliance, PII-isolation, or heavy-load requirement gets its **own**
  dedicated instance (that's why `diplomat` has its own `diplomat-pg`, separate
  from this shared box) — do not put it on the shared instance.
- Default datastore for new Goliath projects is Postgres (`pg` driver), not
  Mongo/Firestore-compat. See [[firestore-scan-audit]] for why the Mongo-compat
  path is a billing trap.

## Instance identity (current state — reverify with `gcloud sql instances describe`)

_As of 2026-07-03:_

| | |
|---|---|
| Connection name | `goliathdynamics-com:us-east4:goliath-pg` |
| GCP project | `goliathdynamics-com` |
| Region / version | us-east4 · Postgres 17 |
| Tier / edition | `db-g1-small` · enterprise (1 shared vCPU, ~1.7 GB, zonal, no HA) |
| Public IP | `34.182.178.62` (proxy/connector only — no authorized networks) |

The instance lives in the `goliathdynamics-com` project but is shared by
services in OTHER projects — hence the cross-project IAM grant below.

## Onboarding a new project `foo`

```bash
# 1. dedicated database + user with its own password
PW=$(openssl rand -hex 24)
gcloud sql databases create foo --instance=goliath-pg --project=goliathdynamics-com
gcloud sql users create foo --instance=goliath-pg --project=goliathdynamics-com --password="$PW"

# 2. store the connection string as a secret IN foo's OWN gcp project
printf 'postgresql://foo:%s@/foo?host=/cloudsql/goliathdynamics-com:us-east4:goliath-pg' "$PW" \
  | gcloud secrets create database-url --project=<foo-project> --data-file=-
gcloud secrets add-iam-policy-binding database-url --project=<foo-project> \
  --member="serviceAccount:<foo-runtime-sa>" --role="roles/secretmanager.secretAccessor"

# 3. the instance is in goliathdynamics-com; foo's Cloud Run runtime SA needs
#    cloudsql.client ON goliathdynamics-com (cross-project grant)
gcloud projects add-iam-policy-binding goliathdynamics-com \
  --member="serviceAccount:<foo-runtime-sa>" --role="roles/cloudsql.client"

# 4. attach the instance + secret to foo's Cloud Run service
gcloud run services update <foo-svc> --project=<foo-project> --region=<region> \
  --add-cloudsql-instances=goliathdynamics-com:us-east4:goliath-pg \
  --set-secrets=DATABASE_URL=database-url:latest
```

Deploys still go through the push→Cloud Build trigger (never `gcloud builds
submit`); the `gcloud run services update` above is a one-time env/mount wiring,
not a deploy. Re-running `--set-secrets` REPLACES the whole secret-env set —
always list every secret env var the service already has, or you'll silently
drop the others (learned the hard way: dropping `GEMINI_API_KEY`/SES on a
`--remove-env-vars` call).

## Connection-string shapes

**Cloud Run (unix socket via the connector):**
```
postgresql://<user>:<pw>@/<db>?host=/cloudsql/goliathdynamics-com:us-east4:goliath-pg
```

**Local dev (through the auth proxy):**
```bash
cloud-sql-proxy --port 5433 goliathdynamics-com:us-east4:goliath-pg
# → postgresql://<user>:<pw>@127.0.0.1:5433/<db>
```

The proxy authenticates via **Application Default Credentials**, which are
separate from the gcloud CLI creds: `gcloud auth login` refreshes only the CLI
creds, NOT ADC. Refresh ADC with `gcloud auth application-default login`
(+ `... set-quota-project goliathdynamics-com`). If ADC throws `invalid_rapt`,
either rerun that, or bypass ADC entirely with the CLI token:
`cloud-sql-proxy --port 5433 --token "$(gcloud auth print-access-token)" <conn>`.

## Caveats before piling on more projects

- **`db-g1-small` is a small shared box.** Fine for several low-traffic apps;
  a write-heavy or latency-sensitive workload needs a tier bump
  (`gcloud sql instances patch goliath-pg --tier=…`) or its own instance.
- **Per-project users default to broad rights** (can see the whole cluster).
  For real isolation between projects on the shared box, restrict each user to
  its own database with explicit grants (`REVOKE`/`GRANT`) — do this before the
  instance holds anything sensitive from more than one project.
