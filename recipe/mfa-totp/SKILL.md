---
name: mfa-totp
description: >
  Use when adding optional authenticator-app (TOTP) multi-factor authentication
  on top of email-OTP login in a multi-tenant app. Default is opt-in — no user
  is forced unless an org owner flips a per-org `mfa_required` toggle.
  Covers the policy decision function, the four-state login state machine
  (pending → mfa_enroll | mfa_challenge → active), the org-level "MFA required"
  toggle in organization settings, encrypted secret storage with AES-256-GCM,
  10-code single-use recovery codes, the four-tier admin recovery setup
  (self-service, peer reset, support reset with delayed effect, superadmin
  break-glass), and the trusted-device piggyback onto the existing rolling
  session cookie. Cohort-based forcing (superadmin / host-org / org-owner) is
  documented as an opt-in extension in Fit-to-Project, not the default.
  Skips backup device and SMS by design.
dependencies:
  requires: [otp-auth, multi-tenant]
  capabilities:
    design-system: admin-only-notus
provides: [mfa]
---

# Authenticator-App MFA

A second-factor layer that sits between `otp-auth`'s email-OTP verification and session promotion. Email-OTP proves possession of the inbox; TOTP proves possession of a registered authenticator app. The login flow grows two new transitional session states — `mfa_enroll` for first-time users and `mfa_challenge` for returning users — and a session is not promoted to `active` until the user has cleared whichever applies.

**Status of this recipe:** spec-only. No reference implementation has shipped yet. The anti-patterns below are mined from spec review, not from QA rounds — they will harden once the first install lands and produces real failure modes. Re-extract this recipe after the first production install.

## Policy decision: who must use MFA

There is exactly one function that answers "does this user need MFA right now," and it is the single source of truth for the login state machine, the disable-MFA endpoint, and the org-settings toggle UI. Drift between any of those three callers is how MFA gets silently bypassed.

```ts
// lib/mfa.ts
export function isPolicyRequired(user: IUser, orgs: IOrganization[]): boolean {
  return orgs.some(o => o.mfa_required === true)   // any org explicitly requires it
}
```

**Default is opt-in.** No user is forced. The function returns `true` only when an org the user belongs to has had its `mfa_required` toggle explicitly flipped on by an owner. Two consequences:

1. The login state machine ignores enrollment unless the user has already opted in (`user.mfa_enabled === true`) or some org has flipped the toggle on.
2. The `mfa/disable` endpoint refuses only when `isPolicyRequired` returns true. A user who turned MFA on for their own protection can turn it back off freely.

The recipe ships with this minimal policy on purpose — onboarding friction from forced MFA is the most common reason MFA rollouts get rolled back. Adding cohort-based forcing later is a one-function change. See Fit-to-Project for the canonical superadmin / host-org / org-owner cohorts.

## Data model

### `users` — add MFA fields

```ts
mfa_enabled: boolean                       // false until enrollment completes
mfa_secret_encrypted?: string              // base64, AES-256-GCM with MFA_ENCRYPTION_KEY
mfa_secret_iv?: string                     // base64
mfa_enrolled_at?: Date
mfa_recovery_codes_hashed?: string[]       // single-use; bcrypt or argon2, never plaintext
mfa_last_used_step?: number                // anti-replay: last accepted TOTP step number
```

The secret is encrypted at rest. A DB dump must not yield working second factors — that defeats the entire purpose of MFA. `MFA_ENCRYPTION_KEY` is a 32-byte key, base64-encoded, supplied via env (Secret Manager in prod). Decrypt only inside `lib/mfa.ts`; never expose the plaintext secret in API responses after enrollment.

`mfa_last_used_step` blocks the 30-second replay window: if a code for step N succeeds, store N, and reject any future code with step ≤ N. Without this, a code seen by an attacker (shoulder-surfing, leaked HAR) is reusable for up to 30 seconds.

### `organizations` — add policy field

```ts
mfa_required: boolean                      // default false; only role=owner can change
mfa_policy_updated_at?: Date
mfa_policy_updated_by?: string             // user_id of the owner who flipped it
```

Default is `false` for new orgs; an absent field is also treated as `false`. The toggle is the only path to forced-enrollment in the default recipe.

### `sessions` — extend the status enum

```ts
status: 'pending' | 'mfa_enroll' | 'mfa_challenge' | 'active'
mfa_verified_at?: Date                     // set when promoted to active via MFA
```

`pending` and `active` keep their existing semantics from `otp-auth`. Two new states are introduced. **Critical:** these are intermediate states between email-OTP verification and full activation. Cookies are still set; the client knows it's authenticated-but-gated. The session cannot perform any authorized action while in `mfa_enroll` or `mfa_challenge` — `requireSession` returns 401 with a `mfa_required` marker so the client can route to the right screen.

### `mfa_events` — append-only audit log

```ts
{ user_id, event, by_user_id?, ip, user_agent, created_at, metadata? }
```

Events: `enroll_started`, `enroll_completed`, `verify_success`, `verify_failure`, `recovery_used`, `recovery_regenerated`, `self_disabled`, `peer_reset`, `support_reset_requested`, `support_reset_applied`, `policy_changed`. Never delete rows. This collection is read by `admin-feed-deep`'s `security.notable` producer.

## Login state machine

```
client enters email
  └─ POST /api/auth/request-otp                     status: pending

client enters OTP
  └─ POST /api/auth/verify-otp
       ├─ user.mfa_enabled                          status: mfa_challenge
       ├─ isPolicyRequired(user, orgs)              status: mfa_enroll
       └─ else                                      status: active   (existing behavior)
       └─ Set-Cookie: session cookie                (cookie issued in all three cases)

mfa_challenge:
  POST /api/auth/mfa/verify { code | recovery_code }
                                                   status: active

mfa_enroll:
  POST /api/auth/mfa/setup                         → returns otpauth_uri + qr_png_dataurl
  POST /api/auth/mfa/confirm { code }              status: active
                                                   → returns 10 recovery codes (shown once)
```

The cookie is issued in all three terminal states because the client needs an authenticated channel to call `/mfa/setup`, `/mfa/confirm`, and `/mfa/verify`. The state field on the session, not the presence of the cookie, governs what those routes will accept and what `requireSession` will allow.

`requireSession(request, { requireActive: true })` (the default for any business route) refuses non-active sessions and returns `{ error: 'mfa_required', state: 'mfa_enroll' | 'mfa_challenge' }`. The client uses that to navigate.

## API surface

| Method | Path | Allowed session state | Purpose |
|---|---|---|---|
| POST | `/api/auth/mfa/setup` | `mfa_enroll`, `active` | Generate pending secret. Returns `{ otpauth_uri, qr_png_dataurl, secret_for_manual_entry }`. Does NOT persist `mfa_enabled=true` yet. |
| POST | `/api/auth/mfa/confirm` | `mfa_enroll`, `active` | Body `{ code }`. Verifies the code against the pending secret, persists it encrypted, mints 10 recovery codes, returns them, promotes session if in `mfa_enroll`. |
| POST | `/api/auth/mfa/verify` | `mfa_challenge` | Body `{ code }` or `{ recovery_code }`. Promotes to `active`. Recovery code is consumed (hash removed from array). |
| POST | `/api/auth/mfa/disable` | `active` + recent step-up | Refused if `isPolicyRequired` returns true for this user. Wipes MFA fields. |
| POST | `/api/auth/mfa/regenerate-codes` | `active` + recent step-up | Replaces the hashed-codes array. Returns new codes once. |
| GET | `/api/orgs/[orgId]/mfa-policy` | active member of org | Read current `mfa_required`. |
| PATCH | `/api/orgs/[orgId]/mfa-policy` | active org `owner` + recent step-up | Body `{ mfa_required }`. Writes `mfa_policy_updated_at` + `mfa_policy_updated_by`. |
| POST | `/api/orgs/[orgId]/members/[userId]/mfa-reset` | active org `owner` + recent step-up | Wipes target user's MFA fields. Emails the affected user. Logged as `peer_reset`. |
| POST | `/api/superadmin/users/[userId]/mfa-reset` | `superadmin` + recent step-up | Creates a `support_reset_requested` event with a 24h delayed effect. See Admin Recovery. |

**Recent step-up** = `session.mfa_verified_at` within the last 5 minutes. Otherwise the route returns 401 `{ error: 'step_up_required' }`. The client re-prompts for a TOTP code (or recovery code) via a modal that calls `POST /api/auth/mfa/verify` with a `step_up: true` body field; on success, `mfa_verified_at` is refreshed and the original request is retried. Email-OTP is not re-requested for step-up — that would be theater since email is the channel an attacker would already have if they got this far.

**Rate limiting on `/mfa/verify`:** 5 failed attempts per session triggers a 15-minute lockout for that session; failures across the same `user_id` from any session beyond 10 in an hour locks the user and posts a `security.notable` feed item. Every failed attempt is logged as `verify_failure`.

## Library choice

`otplib` (the `authenticator.*` namespace — `generate`, `verify`, `keyuri`) plus `qrcode` for the data-URL render. Both pure-JS, zero native deps. `verify` is called with `{ window: 1 }` for ±30s clock skew tolerance. Do not use `speakeasy` — unmaintained.

## Trusted devices: piggyback on the existing session cookie

The recipe does NOT introduce a separate "trusted device" concept. The rolling 30-day session cookie from `otp-auth` already IS the trusted-device mechanism — a session that has cleared MFA once is the trusted device for its 30-day rolling lifetime. On every authenticated request, `last_used_at` advances and the cookie's `expires_at` is extended (existing behavior). MFA is re-prompted when the session expires, when the user explicitly logs out, or for step-up on a sensitive action — not on every login.

This is the deliberate choice the user requested: "session timeout is not shortened." The MFA prompt is a session-creation gate, not a per-login gate.

## Enrollment UX

The enrollment screen is reached from two paths:

1. **Forced enrollment after first email-OTP login** (`status: mfa_enroll`). Triggered when an org the user belongs to has flipped `mfa_required: true`. The user cannot proceed past this screen — the policy decision has already determined they must enroll. In the default opt-in posture, no org is required, so this path is dormant until an owner flips a toggle.
2. **Self-service from settings** — the primary path under the default policy. The user opts in from their settings page.

Both paths render the same component:

- QR code (rendered from the `otpauth_uri` returned by `/setup`)
- Manual-entry text (the base32 secret) for users on a device where they can't scan
- Description: "Open Google Authenticator, 1Password, Authy, or any TOTP app and scan."
- 6-digit input that posts to `/confirm`
- On success: a recovery-codes screen with copy / download buttons and a forced "I've saved these somewhere safe" checkbox before the user can proceed.

The recovery-codes screen is the only place the codes are ever shown. Calling `/regenerate-codes` later invalidates the old set entirely; partial views are not allowed.

## Org settings UI

Add a **Security** section to the existing `/orgs/[slug]/settings` page (defined by `multi-tenant`). Only render the toggle to org `owner` members; for `operator`/`viewer`, show the current state as read-only.

When an owner flips it **on**, show a confirmation modal:

> Turning on MFA means everyone in your organization will be required to set up an authenticator app the next time they log in. Members who lose access to their authenticator will need a recovery code or an owner to reset them. Continue?

The toggle PATCH endpoint requires a step-up, so flipping it triggers a TOTP prompt before the change takes effect. This prevents an attacker who hijacked an owner's session cookie from quietly altering MFA policy across the org. (If the owner is enabling for the first time and has no MFA themselves, the step-up routes them through enrollment first.)

## Admin recovery

The hard problem MFA introduces: users lose their phones. The recipe ships four recovery layers, intended to be installed together. None of them is optional — gaps in this layer turn MFA from a security feature into an availability disaster.

### Layer 1: Recovery codes (self-service)

Issued at enrollment, 10 codes, single-use each. Generated as 10 base32 strings of length 10; hashed with bcrypt (cost 10) before storage. Shown to the user exactly once, on a screen with copy / download / print buttons and a forced confirmation checkbox before the user can proceed.

Consumed codes are removed from the hashed array. When fewer than 3 remain, the next login flashes a banner: "You have 2 recovery codes left. Generate new ones." Regenerating invalidates the old set entirely.

Handles ~90% of lost-device cases without involving anyone else.

### Layer 2: Peer reset (another org owner)

Any other `owner` in the same org can clear a member's MFA via `POST /api/orgs/[orgId]/members/[userId]/mfa-reset`. The resetting owner must have completed a step-up within the last 5 minutes (i.e. they themselves just proved possession of their own MFA device). The target user is emailed: "Your MFA was reset by Alice Smith at 12:04 PM. If this wasn't expected, contact security@yourcompany.com immediately." Logged as `peer_reset`.

The target's next login forces re-enrollment.

This is the workhorse layer. Most B2B customers have ≥2 owners; this layer lets them self-serve.

### Layer 3: Support reset with delayed effect (out-of-band identity verification)

For the "sole owner of the org, lost their phone" case. A ticket comes in to `support@`. The support engineer (who must hold platform `superadmin`) runs an identity check:

- The OTP flow already proves possession of the email on file. That's one channel.
- At least one **side-channel** is required on top: a phone callback to a number on file, a video call where they show ID matching the billing record, or a signed declaration. Two channels matter — an attacker who compromised the email otherwise breezes through.

Once verified, the support engineer calls `POST /api/superadmin/users/[userId]/mfa-reset`. The reset does **not** take effect immediately. Instead:

- A `support_reset_requested` event is logged.
- The affected user's email receives an immediate notice: "A support agent has requested an MFA reset on your account. It will take effect in 24 hours. If you did not request this, click here to cancel."
- For 24 hours, daily reminder emails are sent.
- After 24 hours (assuming no cancel click), the reset applies and the next login forces re-enrollment.

The delay is the load-bearing safety mechanism. An attacker who compromised an email inbox can otherwise impersonate the user to support and pass the side-channel check with deepfakes or social engineering. The 24h window gives the legitimate user — who is presumably still trying to log in and finding it broken — a chance to notice and cancel.

### Layer 4: Superadmin break-glass

Platform `superadmin` accounts cannot call their own support. Recovery is operational, not in-app:

- Run at least **two superadmin accounts** at all times — they reset each other via Layer 2 (peer reset, since both are owners of the host org).
- At superadmin enrollment, the recovery codes are printed and stored offline in a company password vault (1Password Business shared vault or equivalent), accessible only to a named list (founders + CTO).
- A documented runbook for "both superadmins simultaneously locked out" — direct DB access to clear `mfa_*` fields, gated on whoever has prod DB credentials. This is an incident-response document, not a feature.

### Recovery paths explicitly NOT supported

- **SMS** as a fallback — well-known SIM-swap risk; introducing a weaker factor as a recovery path defeats the strong factor.
- **Security questions** — easily socially-engineered.
- **Email-only reset with no delay** — collapses MFA back into a single-factor system, since email is also the primary auth channel.

## Rollout posture: opt-in by default

On deploy day, no user is force-enrolled. Every existing user keeps logging in with email-OTP alone. The new surfaces become visible:

- A "Two-factor authentication" card appears in user settings with an "Enable" button.
- A "Require MFA for everyone in this org" toggle appears in org settings, owner-only, defaulted to off.

Force-enrollment is only triggered when an org owner flips the toggle on. From that point, members of that org who log in without `mfa_enabled` enter the `mfa_enroll` state on their next session-creation event. Their existing session cookies remain valid for their normal rolling lifetime — the toggle does not invalidate active sessions, only gates new ones.

This is the deliberate trade-off for "optional for now": low friction at launch in exchange for slower coverage. Layer cohort-forcing in later via Fit-to-Project when the product is ready for the friction.

## Fit-to-Project

Before implementing, decide:

- **Stay opt-in, or layer in cohort forcing?** The default policy is pure opt-in plus per-org owner-controlled toggle. Common cohort extensions, in increasing order of friction:
  - **Superadmins always required** — add `if (user.role === 'superadmin') return true` to `isPolicyRequired`. Defensible from a security audit standpoint; affects very few users.
  - **Host-org members always required** — `if (orgs.some(o => o.slug === hostOrgSlug)) return true`. Treats platform staff like superadmins.
  - **Org owners always required** — `if (orgs.some(o => o.members.find(m => m.user_id === user.user_id)?.role === 'owner')) return true`. Prevents owners from exempting themselves with their own toggle.
  - **Role-based** (e.g., "users with `bar_admissions` populated", "users with `compliance_required: true`") — single predicate change, no architectural impact.
  Each is a single line in one function. Pick the smallest set that satisfies the requirement and resist the urge to layer all four on day one.
- **Encryption key management.** `MFA_ENCRYPTION_KEY` belongs in Secret Manager (or your project's equivalent) and must be present at runtime. A rotation strategy (`key_version` field on the user doc, dual-decrypt during rotation window) is out of scope for the first install — add it the first time you rotate.
- **Recovery code count.** Default 10 is industry standard. Some compliance regimes want 16; some product teams want 6. Don't go below 6.
- **Step-up window.** Default 5 minutes. Tightening to 2 minutes hardens against session-cookie theft but adds friction; loosening past 15 minutes erodes the protection meaningfully.
- **Lockout thresholds.** Default 5 attempts / 15-min session lockout, 10 attempts / 1h user lockout. Tune if you have unusual traffic patterns; record the choice in a comment near the constants.
- **Email templates.** Three new templates: peer-reset notice, support-reset pending (with cancel link), support-reset applied. Match the project's existing transactional-email style.

## Anti-Patterns

- **Multiple sources of truth for "is MFA required."** The policy lives in one function, called from `verify-otp`, `mfa/disable`, and the org-settings UI. Replicating the logic at any of those sites is how MFA gets silently bypassed — the most common failure mode in real audits.
- **Skipping the `mfa_last_used_step` anti-replay check.** A 30-second window where a captured code is replayable is large enough to matter in shoulder-surfing and leaked-HAR scenarios. Always record and reject ≤.
- **Showing recovery codes more than once.** "Forgot to copy them" must route through `/regenerate-codes`, not "show them again." A code visible twice is a code that exists in two places at once.
- **Storing recovery codes in plaintext.** They are passwords. Hash them. The `recovery_used` event records consumption; the hash is what the verifier compares against.
- **Storing the TOTP secret in plaintext.** A DB dump containing plaintext TOTP secrets is equivalent to a DB dump containing valid 2FA codes for every user. Encrypt at rest, decrypt only in `lib/mfa.ts`.
- **Letting `mfa/disable` succeed for force-required users.** The endpoint must call `isPolicyRequired` and refuse with 403 when an org the user belongs to has the toggle on. Otherwise a member of a required org silently exempts themselves.
- **Promoting the session to `active` before MFA verification.** The intermediate states exist precisely so the cookie can be issued (the client needs an authenticated channel for `/setup` and `/verify`) without granting authorization. `requireSession({ requireActive: true })` must refuse `mfa_enroll` and `mfa_challenge`.
- **Re-requesting email-OTP for step-up.** Step-up uses TOTP only. Re-OTP is security theater since email is the channel an attacker would already have at this point in the flow.
- **No delay on the support-reset path.** Immediate-effect support reset is the documented attack vector against TOTP. The 24h delay with cancel link is what makes Layer 3 safe.
- **Shipping without recovery codes.** A working MFA without a recovery layer is an outage waiting to happen. The first time a customer loses their phone with no recovery codes, you'll regret saving the week of work.
- **Per-org session scoping for MFA.** Users in multiple orgs: MFA is a user-level property, not per-org. A user who satisfied MFA does not re-prompt when switching orgs in the navbar. Re-prompting on every switch destroys the trusted-device model.
- **Trusting `tsc` and "the routes exist" as completion signals.** The login state machine has four states and at least six transitions — only manual exercise of every path (new user → enroll → success; new user → enroll → typo → retry; returning user → challenge → success; returning user → challenge → recovery code; step-up → required → success; step-up → required → typo) catches the off-by-one promotions.

## Logging

Log to `mfa_events` (append-only) on every state-changing operation:

- `enroll_started` — `/setup` called, pending secret generated
- `enroll_completed` — `/confirm` succeeded, secret persisted
- `verify_success` — `/verify` succeeded; record whether `code` or `recovery_code` path
- `verify_failure` — `/verify` rejected; record reason (bad code, expired window, replay, lockout)
- `recovery_used` — recovery code consumed; record remaining-count
- `recovery_regenerated` — new code set minted
- `self_disabled` — user disabled their own MFA
- `peer_reset` — owner reset another member's MFA; record `by_user_id`
- `support_reset_requested` — superadmin filed a reset; record `by_user_id` and the 24h-effective-at timestamp
- `support_reset_applied` — 24h elapsed without cancel; reset applied
- `support_reset_cancelled` — user clicked cancel from email
- `policy_changed` — org `mfa_required` toggled; record old and new value

The `security.notable` producer in `admin-feed-deep` reads this collection for: failure bursts (≥10 `verify_failure` in 1h for one user), unusual peer-reset patterns, and any `support_reset_requested` for visibility to the platform team.

Never log the TOTP secret, the plaintext recovery codes, or the submitted code on failure. The submitted-code-on-failure case is tempting for debugging — resist it; the code may be valid and just have failed the replay check, in which case logging it is logging a working second factor.
