---
name: GitHub Pages Landing Page Hosting
description: Programmatic setup of a GitHub Pages repository for a landing page placeholder, including Pages configuration, custom 404, and domain verification for DNS
type: project
env_vars: GITHUB_ORG, GITHUB_TOKEN, LANDING_PAGE_DOMAIN
---

# GitHub Pages Landing Page Hosting

This recipe covers the **hosting infrastructure** for a landing page placeholder on GitHub Pages: creating the repo, enabling Pages, configuring a custom domain, setting up a custom 404 page, and retrieving the DNS verification records needed for your registrar or Route 53. It does **not** cover page design, marketing copy, or content strategy — see `seo-marketing-templates.md` for that.

---

## 1. Prerequisites

### 1.1 GitHub Authentication

All operations require a GitHub personal access token (classic or fine-grained) with sufficient org-level permissions.

```
REQUIRED SCOPES (classic PAT):
  - repo               (full repo access)
  - admin:org          (org domain verification)
  - workflow           (optional, only if using Actions)

REQUIRED PERMISSIONS (fine-grained PAT):
  - Repository: Administration (read/write)
  - Repository: Pages (read/write)
  - Organization: Administration (read/write)
  - Organization: Custom properties (read, for domain verification)

ENVIRONMENT VARIABLES:
  GITHUB_TOKEN=ghp_xxxxx          # PAT with scopes above
  GITHUB_ORG=your-org-name        # The GitHub organization
  LANDING_PAGE_REPO=landing-page  # Repo name (default: landing-page)
  LANDING_PAGE_DOMAIN=example.com # Custom domain for GitHub Pages
```

Authentication can use either:
- The `gh` CLI (pre-authenticated via `gh auth login`)
- Direct REST API calls with `Authorization: Bearer <GITHUB_TOKEN>`

### 1.2 Tooling

The `gh` CLI is the simplest path. All steps below show both the `gh` CLI form and the equivalent REST API call so the implementation agent can choose based on `stack.md`.

---

## 2. Create the Repository

Create a new public repository under the org. The repo will hold the static landing page files and be the source for GitHub Pages.

```
gh CLI:

  gh repo create {GITHUB_ORG}/{LANDING_PAGE_REPO} \
    --public \
    --description "Landing page for {LANDING_PAGE_DOMAIN}" \
    --clone=false

REST API:

  POST https://api.github.com/orgs/{GITHUB_ORG}/repos
  Headers:
    Authorization: Bearer {GITHUB_TOKEN}
    Accept: application/vnd.github+json
  Body:
    {
      "name": "{LANDING_PAGE_REPO}",
      "description": "Landing page for {LANDING_PAGE_DOMAIN}",
      "visibility": "public",
      "auto_init": true,
      "has_issues": false,
      "has_projects": false,
      "has_wiki": false
    }

NOTES:
  - auto_init: true creates an initial commit with a README so the main branch exists.
  - Public visibility is required for GitHub Pages on free org plans. Private repos
    require GitHub Pro, Team, or Enterprise.
  - has_issues/projects/wiki are disabled since this is a hosting-only repo.
```

---

## 3. Push Placeholder Content

After repo creation, push the minimum viable landing page scaffold. This is the **hosting scaffold only** — actual copy and design come from elsewhere.

```
FILES TO COMMIT:

  index.html      — The landing page entry point (placeholder)
  404.html         — Custom 404 page (see Section 5)
  CNAME            — Custom domain file (see Section 6)
  .nojekyll        — Tells GitHub Pages to skip Jekyll processing

COMMIT PROCEDURE:

  1. Clone the repo (or use the GitHub Contents API to create files)
  2. Add all four files
  3. Commit and push to main

gh CLI (file creation via API, no clone needed):

  # Create index.html
  echo '<html><head><title>Coming Soon</title></head><body><h1>Coming Soon</h1></body></html>' \
    | base64 | gh api repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/contents/index.html \
      --method PUT \
      --field message="Add placeholder index.html" \
      --field branch=main \
      --field content=@-

  # Create .nojekyll (empty file)
  echo -n '' | base64 | gh api repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/contents/.nojekyll \
      --method PUT \
      --field message="Add .nojekyll" \
      --field branch=main \
      --field content=@-

REST API (Contents API):

  PUT https://api.github.com/repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/contents/{path}
  Headers:
    Authorization: Bearer {GITHUB_TOKEN}
    Accept: application/vnd.github+json
  Body:
    {
      "message": "Add {filename}",
      "content": "<base64-encoded file content>",
      "branch": "main"
    }

NOTES:
  - The Contents API accepts base64-encoded content.
  - Each file is a separate API call (each creates a commit).
  - For batching into a single commit, use the Git Trees API:
    1. GET the current commit SHA for main
    2. GET the tree SHA from that commit
    3. POST a new tree with all files
    4. POST a new commit referencing the new tree
    5. PATCH refs/heads/main to point to the new commit
  - .nojekyll prevents Jekyll from ignoring files starting with underscores
    and avoids unnecessary build processing.
```

---

## 4. Enable GitHub Pages on Main Branch

Configure the repository to serve GitHub Pages from the root of the `main` branch.

```
REST API:

  POST https://api.github.com/repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages
  Headers:
    Authorization: Bearer {GITHUB_TOKEN}
    Accept: application/vnd.github+json
  Body:
    {
      "source": {
        "branch": "main",
        "path": "/"
      },
      "build_type": "legacy"
    }

RESPONSE (201 Created):
  {
    "url": "https://api.github.com/repos/{org}/{repo}/pages",
    "html_url": "https://{org}.github.io/{repo}/",
    "source": {
      "branch": "main",
      "path": "/"
    },
    "status": "built",
    "cname": null,
    "custom_404": false,
    ...
  }

gh CLI equivalent:

  gh api repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages \
    --method POST \
    --field source[branch]=main \
    --field source[path]="/" \
    --field build_type=legacy

VERIFY PAGES IS ENABLED:

  gh api repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages

NOTES:
  - build_type "legacy" uses the classic Pages pipeline (no Actions workflow).
    Use "workflow" if you want GitHub Actions-based builds.
  - After enabling, the site is available at https://{GITHUB_ORG}.github.io/{LANDING_PAGE_REPO}/
    within a few minutes.
  - If the repo is named {GITHUB_ORG}.github.io, it serves at the org root domain
    (https://{GITHUB_ORG}.github.io/) with no path prefix.
```

---

## 5. Custom 404 Page

GitHub Pages automatically serves a `404.html` file at the repo root as the custom 404 page. No API configuration is needed — just commit the file.

```
404.html CONTENT (placeholder):

  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Page Not Found</title>
  </head>
  <body>
    <h1>404 — Page Not Found</h1>
    <p>The page you're looking for doesn't exist.</p>
    <p><a href="/">Go to the homepage</a></p>
  </body>
  </html>

COMMIT VIA API:

  PUT https://api.github.com/repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/contents/404.html
  Body:
    {
      "message": "Add custom 404 page",
      "content": "<base64-encoded 404.html>",
      "branch": "main"
    }

NOTES:
  - GitHub Pages looks for 404.html at the root of the published source.
  - No configuration toggle exists — if the file is present, it's used.
  - The 404 page inherits the same custom domain as the rest of the site.
  - For SPA-style routing (all paths → index.html), the 404.html can contain
    a JS redirect to index.html with the path in a query param. But for a
    simple landing page, a real 404 is appropriate.
```

---

## 6. Custom Domain Configuration

### 6.1 Set the Custom Domain on the Repo

```
REST API:

  PUT https://api.github.com/repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages
  Headers:
    Authorization: Bearer {GITHUB_TOKEN}
    Accept: application/vnd.github+json
  Body:
    {
      "cname": "{LANDING_PAGE_DOMAIN}",
      "source": {
        "branch": "main",
        "path": "/"
      }
    }

gh CLI:

  gh api repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages \
    --method PUT \
    --field cname="{LANDING_PAGE_DOMAIN}" \
    --field source[branch]=main \
    --field source[path]="/"

NOTES:
  - This also creates/updates the CNAME file in the repo automatically.
  - If you already committed a CNAME file manually (Section 3), this overwrites it.
  - Either approach works; the API method is cleaner for automation.
```

### 6.2 Enable HTTPS (Enforce HTTPS)

```
REST API:

  PUT https://api.github.com/repos/{GITHUB_ORG}/{LANDING_PAGE_REPO}/pages
  Body:
    {
      "cname": "{LANDING_PAGE_DOMAIN}",
      "https_enforced": true,
      "source": {
        "branch": "main",
        "path": "/"
      }
    }

NOTES:
  - HTTPS enforcement requires DNS to be correctly pointed first.
  - GitHub provisions a Let's Encrypt certificate automatically.
  - Certificate provisioning can take up to 24 hours after DNS propagates.
  - If you call this before DNS is ready, GitHub returns an error.
    Retry after DNS verification succeeds.
```

---

## 7. Domain Verification & DNS Records

This is the most variable step because DNS management depends on whether you use a registrar's built-in DNS, AWS Route 53, Cloudflare, or something else.

### 7.1 Fetch the Verification TXT Record from GitHub

GitHub requires org-level domain verification to prove ownership. This prevents other GitHub users from claiming your domain on their Pages sites.

```
STEP 1: Create a domain verification request

  POST https://api.github.com/orgs/{GITHUB_ORG}/pages/domains
  Headers:
    Authorization: Bearer {GITHUB_TOKEN}
    Accept: application/vnd.github+json
  Body:
    {
      "domain": "{LANDING_PAGE_DOMAIN}"
    }

  RESPONSE:
    {
      "domain": "example.com",
      "state": "pending",
      "txt_record": {
        "host": "_github-pages-challenge-{GITHUB_ORG}",
        "value": "abc123def456..."
      }
    }

STEP 2: Extract the verification values

  TXT_HOST  = response.txt_record.host    (e.g., "_github-pages-challenge-myorg")
  TXT_VALUE = response.txt_record.value   (e.g., "abc123def456...")

gh CLI:

  gh api orgs/{GITHUB_ORG}/pages/domains \
    --method POST \
    --field domain="{LANDING_PAGE_DOMAIN}" \
    --jq '.txt_record'

NOTES:
  - The TXT record host is always "_github-pages-challenge-{GITHUB_ORG}"
    but the value is unique per domain and must be fetched from the API.
  - This endpoint may also be at /orgs/{org}/domains depending on
    GitHub API version. Check the response; if 404, try the alternate.
  - For subdomains (e.g., www.example.com), the process is the same
    but the TXT record host includes the subdomain prefix.
```

### 7.2 DNS Records to Create

Two categories of DNS records are needed: the verification TXT record and the actual A/CNAME records that point traffic to GitHub.

```
REQUIRED DNS RECORDS:

  1. VERIFICATION TXT RECORD:
     Type:  TXT
     Host:  _github-pages-challenge-{GITHUB_ORG}   (or .{LANDING_PAGE_DOMAIN} depending on provider)
     Value: {TXT_VALUE from API response}
     TTL:   3600 (or lowest available)

  2a. FOR APEX DOMAIN (e.g., example.com):
     Type:  A
     Host:  @ (or blank, depending on provider)
     Value: 185.199.108.153
     TTL:   3600

     Type:  A
     Host:  @
     Value: 185.199.109.153

     Type:  A
     Host:  @
     Value: 185.199.110.153

     Type:  A
     Host:  @
     Value: 185.199.111.153

  2b. FOR SUBDOMAIN (e.g., www.example.com):
     Type:  CNAME
     Host:  www
     Value: {GITHUB_ORG}.github.io.
     TTL:   3600

  2c. FOR BOTH (recommended):
     Create all four A records for the apex domain
     AND the www CNAME record
     GitHub handles the redirect between www and non-www

NOTES:
  - The four A record IPs are GitHub's official Pages IPs.
    These are stable but can be verified at:
    https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site
  - Some registrars support ALIAS or ANAME records for apex domains
    as an alternative to A records. If available, point to {GITHUB_ORG}.github.io.
  - AAAA (IPv6) records are also available from GitHub but optional:
    2606:50c0:8000::153, 2606:50c0:8001::153,
    2606:50c0:8002::153, 2606:50c0:8003::153
```

### 7.3 Creating DNS Records on AWS Route 53

```
IF THE HOSTED ZONE ALREADY EXISTS:

  STEP 1: Find the hosted zone ID

    aws route53 list-hosted-zones-by-name \
      --dns-name "{LANDING_PAGE_DOMAIN}" \
      --query "HostedZones[0].Id" \
      --output text

    → returns /hostedzone/Z1234567890ABC
    → extract ZONE_ID = Z1234567890ABC

  STEP 2: Create a change batch JSON

    {
      "Changes": [
        {
          "Action": "UPSERT",
          "ResourceRecordSet": {
            "Name": "_github-pages-challenge-{GITHUB_ORG}.{LANDING_PAGE_DOMAIN}",
            "Type": "TXT",
            "TTL": 3600,
            "ResourceRecords": [
              { "Value": "\"{TXT_VALUE}\"" }
            ]
          }
        },
        {
          "Action": "UPSERT",
          "ResourceRecordSet": {
            "Name": "{LANDING_PAGE_DOMAIN}",
            "Type": "A",
            "TTL": 3600,
            "ResourceRecords": [
              { "Value": "185.199.108.153" },
              { "Value": "185.199.109.153" },
              { "Value": "185.199.110.153" },
              { "Value": "185.199.111.153" }
            ]
          }
        },
        {
          "Action": "UPSERT",
          "ResourceRecordSet": {
            "Name": "www.{LANDING_PAGE_DOMAIN}",
            "Type": "CNAME",
            "TTL": 3600,
            "ResourceRecords": [
              { "Value": "{GITHUB_ORG}.github.io" }
            ]
          }
        }
      ]
    }

  STEP 3: Apply the change batch

    aws route53 change-resource-record-sets \
      --hosted-zone-id {ZONE_ID} \
      --change-batch file://dns-changes.json

  STEP 4: Wait for propagation

    aws route53 get-change --id {CHANGE_ID}
    → poll until Status = "INSYNC"

NOTES:
  - TXT record values in Route 53 MUST be wrapped in escaped double quotes.
  - UPSERT creates the record if it doesn't exist, or updates it if it does.
  - Propagation typically takes 60–300 seconds within Route 53, but global
    DNS propagation can take longer depending on TTL.
  - If the hosted zone doesn't exist yet, create it first with:
    aws route53 create-hosted-zone --name {LANDING_PAGE_DOMAIN} --caller-reference $(date +%s)
    Then update the domain's nameservers at the registrar to point to
    the Route 53 NS records returned in the response.
```

### 7.4 Creating DNS Records on a Registrar

Most registrars (Namecheap, GoDaddy, Google Domains, Porkbun, etc.) have different UIs but the same fields. Some also have APIs.

```
REGISTRAR API EXAMPLES:

  Namecheap:
    POST https://api.namecheap.com/xml.response
      ?ApiUser={user}&ApiKey={key}&UserName={user}&ClientIp={ip}
      &Command=namecheap.domains.dns.setHosts
      &SLD={second-level-domain}&TLD={tld}
      &HostName1=@&RecordType1=A&Address1=185.199.108.153&TTL1=3600
      &HostName2=@&RecordType2=A&Address2=185.199.109.153&TTL2=3600
      ...

  Cloudflare (if DNS is on Cloudflare):
    POST https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records
    Body: { "type": "A", "name": "@", "content": "185.199.108.153", "ttl": 3600 }

  GoDaddy:
    PUT https://api.godaddy.com/v1/domains/{domain}/records/A/@
    Body: [{ "data": "185.199.108.153", "ttl": 3600 }, ...]

NOTES:
  - Each registrar/DNS provider has a different API shape. The implementation
    agent should detect which provider is in use (from env vars or stack.md)
    and use the appropriate API.
  - If the registrar has no API, this step must be done manually. The script
    should output the exact records to create and pause for confirmation.
```

### 7.5 Verify the Domain on GitHub

After DNS records propagate, tell GitHub to verify.

```
REST API:

  POST https://api.github.com/orgs/{GITHUB_ORG}/pages/domains/{DOMAIN_ID}/verify

  or (if using the org domains endpoint):

  POST https://api.github.com/orgs/{GITHUB_ORG}/domains/{DOMAIN_ID}/verify

gh CLI:

  DOMAIN_ID=$(gh api orgs/{GITHUB_ORG}/pages/domains \
    --jq '.domains[] | select(.domain=="{LANDING_PAGE_DOMAIN}") | .id')

  gh api orgs/{GITHUB_ORG}/pages/domains/{DOMAIN_ID}/verify --method POST

POLLING FOR VERIFICATION:

  Verification may not succeed immediately. Poll the domain status:

  gh api orgs/{GITHUB_ORG}/pages/domains/{DOMAIN_ID} --jq '.state'

  States:
    "pending"   — DNS not yet detected; wait and retry
    "verified"  — Domain ownership confirmed
    "failed"    — Verification failed; check DNS records

  Retry strategy: poll every 30 seconds, up to 10 minutes.
  If still pending after 10 minutes, DNS propagation is likely incomplete.
  Wait longer or check records with: dig TXT _github-pages-challenge-{GITHUB_ORG}.{LANDING_PAGE_DOMAIN}
```

---

## 8. End-to-End Automation Sequence

The full setup, in order, with dependencies:

```
STEP 1: Create repo                          (Section 2)
  ↓
STEP 2: Push placeholder files               (Section 3)
  ↓  (index.html, 404.html, .nojekyll)
STEP 3: Enable GitHub Pages on main          (Section 4)
  ↓
STEP 4: Request domain verification          (Section 7.1)
  ↓  (extract TXT record host + value)
STEP 5: Create DNS records                   (Section 7.2–7.4)
  ↓  (TXT verification + A records + CNAME)
STEP 6: Wait for DNS propagation             (60–300s for Route 53, longer for others)
  ↓
STEP 7: Verify domain on GitHub              (Section 7.5)
  ↓
STEP 8: Set custom domain on repo            (Section 6.1)
  ↓
STEP 9: Enable HTTPS enforcement             (Section 6.2)
  ↓  (may need to retry — cert provisioning takes minutes to hours)
STEP 10: Verify site is live                 (curl https://{LANDING_PAGE_DOMAIN})

IDEMPOTENCY:
  - All API calls use UPSERT semantics where possible.
  - Re-running the script should be safe. Check for existing repo, existing
    Pages config, existing DNS records, and existing domain verification
    before creating new ones.
  - Use GET before POST/PUT to detect current state.
```

---

## 9. Gotchas

### 9.1 Repo Naming for Apex Sites

If the repo is named `{GITHUB_ORG}.github.io`, it serves at the org's root GitHub Pages URL with no path prefix. Any other repo name gets a path prefix (`/{repo-name}/`). For a custom domain this doesn't matter — the custom domain always serves at root — but it affects the default `*.github.io` URL during setup before the domain is configured.

### 9.2 Pages API 409 Conflict

If Pages is already enabled, `POST /repos/{owner}/{repo}/pages` returns 409. Use `PUT` to update an existing configuration or check with `GET` first.

### 9.3 CNAME File vs API

Setting the custom domain via the API (`PUT /repos/{owner}/{repo}/pages` with `cname` field) automatically creates or updates the `CNAME` file in the repo. If you also commit a `CNAME` file manually, they can conflict. Pick one approach: either commit the file or set it via API, not both.

### 9.4 HTTPS Enforcement Timing

`https_enforced: true` fails if the DNS isn't pointing to GitHub yet or if the Let's Encrypt certificate hasn't been provisioned. This step should be retried with backoff after the domain is verified and DNS is live.

### 9.5 GitHub Pages IP Addresses

The four A record IPs (`185.199.108–111.153`) are stable and documented by GitHub, but they can theoretically change. The implementation should ideally fetch them from GitHub's meta endpoint:

```
GET https://api.github.com/meta
→ response.pages: ["185.199.108.153/24", ...]
```

### 9.6 Private Repos Require Paid Plan

GitHub Pages for private repos requires GitHub Pro (personal) or GitHub Team/Enterprise (org). If the org is on the free plan, the repo must be public.

### 9.7 Rate Limits

The GitHub API has rate limits (5,000 requests/hour for authenticated users). This workflow uses roughly 10–15 API calls total, so rate limits are not a concern for single runs. But if automating across many domains/repos, add rate limit checking:

```
Check response headers:
  X-RateLimit-Remaining: 4985
  X-RateLimit-Reset: 1679012345 (unix timestamp)
```

### 9.8 DNS Provider Detection

The script cannot automatically detect which DNS provider is authoritative for a domain. Options:
- Require an env var like `DNS_PROVIDER=route53` or `DNS_PROVIDER=cloudflare`
- Query the domain's NS records (`dig NS {LANDING_PAGE_DOMAIN}`) and infer the provider from the nameserver hostnames (e.g., `ns-*.awsdns-*.com` → Route 53)

---

## 10. Implementation Checklist

- [ ] **Auth**: Configure `GITHUB_TOKEN` with required scopes in `.env`
- [ ] **Create repo**: `POST /orgs/{org}/repos` with auto_init
- [ ] **Push files**: Commit `index.html`, `404.html`, `.nojekyll` to main
- [ ] **Enable Pages**: `POST /repos/{owner}/{repo}/pages` with source branch=main
- [ ] **Request domain verification**: `POST /orgs/{org}/pages/domains`
- [ ] **Create DNS records**: TXT verification + A records + www CNAME
- [ ] **Wait for propagation**: Poll or sleep, then verify with `dig`
- [ ] **Verify domain**: `POST /orgs/{org}/pages/domains/{id}/verify`
- [ ] **Set custom domain**: `PUT /repos/{owner}/{repo}/pages` with cname
- [ ] **Enable HTTPS**: `PUT /repos/{owner}/{repo}/pages` with https_enforced=true (retry with backoff)
- [ ] **Smoke test**: `curl -sI https://{LANDING_PAGE_DOMAIN}` returns 200
- [ ] **Idempotency**: Re-running the script does not create duplicates or errors

---

## Related Recipes

- **SEO & Marketing Templates** (`seo-marketing-templates.md`): Landing page content, meta tags, and structured data — the content that goes *into* the hosting scaffold this recipe sets up.
- **Developer & Operations Scaffolding** (`dev-ops.md`): Environment variable patterns and config module — the `GITHUB_TOKEN`, `LANDING_PAGE_DOMAIN`, etc. vars should follow the same config conventions.
- **Analytics** (`analytics.md`): Add tracking scripts to the landing page once it has real content.
