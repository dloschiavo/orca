---
name: Developer & Operations Scaffolding
description: Environment configuration with validation, health check endpoint, and structured logging framework
type: project
---

# Developer & Operations Scaffolding

This recipe establishes the operational foundation for any application: environment configuration management, health monitoring, and production-grade logging. These are **stack-agnostic** patterns that work across frameworks and languages—the implementation agent consults `stack.md` for technology choices.

---

## 1. Config Module

The config module is the single source of truth for application settings. All runtime configuration flows through it—feature code **never** reads `process.env` directly.

### 1.1 Schema Definition

Define a typed config schema with validation rules:

```
CONFIG_SCHEMA:
  - domain (namespace): string
    - key: string
    - type: enum (string, number, boolean, uri, email, etc.)
    - required: boolean (default: true)
    - default: any (only if not required)
    - example: string
    - validation_rule: optional constraint (e.g., minLength, pattern, enum values)
    - description: string

DOMAIN_STRUCTURE:
  database:
    uri: string, required
    maxConnections: number, default=10
    timeout: number, default=5000

  auth:
    sessionSecret: string, required
    jwtExpiry: number, default=3600
    otpExpiry: number, default=300

  billing:
    stripeSecretKey: string, required
    stripPublishableKey: string, required
    webhookSecret: string, required

  email:
    sesRegion: string, required (if email enabled)
    fromAddress: email, required (if email enabled)
    maxRetries: number, default=3

  logging:
    level: enum (debug, info, warn, error), default=info
    format: enum (json, pretty), default=pretty in dev, json in prod

  server:
    port: number, default=3000
    nodeEnv: enum (development, staging, production), required
    version: string, required (from package metadata)
```

### 1.2 Validation at Startup

Validation runs **before** the application starts. If required vars are missing, the app crashes immediately with a clear error message.

```
STARTUP_VALIDATION_FLOW:
  1. Load all environment variables from process.env
  2. Load .env file (if exists, lower precedence than process.env)
  3. For each key in CONFIG_SCHEMA:
     a. Check if required and missing → ADD to error list
     b. Check if provided but fails validation_rule → ADD to error list
     c. If default exists and missing → USE default
     d. If type is boolean and value is string → COERCE ("true" → true, "false" → false, others → error)
     e. If type is number and value is string → COERCE (parse, fail on NaN)
  4. If errors exist:
     - Format error message: list each missing/invalid var with description and example
     - Include domain grouping for clarity
     - Log to stderr
     - EXIT with code 1
  5. If valid:
     - Log config loaded (redact sensitive values in log)
     - Return validated, typed config object
```

### 1.3 Typed Exports

Config module exports a frozen object with domain-grouped properties:

```
config = {
  database: {
    uri: string,
    maxConnections: number,
    timeout: number,
  },
  auth: {
    sessionSecret: string,
    jwtExpiry: number,
    otpExpiry: number,
  },
  billing: {
    stripeSecretKey: string,
    stripPublishableKey: string,
    webhookSecret: string,
  },
  email: {
    sesRegion: string,
    fromAddress: string,
    maxRetries: number,
  },
  logging: {
    level: string,
    format: string,
  },
  server: {
    port: number,
    nodeEnv: string,
    version: string,
  },
}

// Usage in feature code:
dbUri = config.database.uri
// NOT: dbUri = process.env.DATABASE_URI
```

Domain grouping makes code more readable and provides natural namespacing for configuration. It also enables feature-level config checks (e.g., "is email enabled?").

---

## 2. .env.example Template

This file is **committed to the repository** and serves as documentation. It lists every environment variable with description, example value, and domain grouping.

```
# .env.example
# Copy this to .env and fill in your values.
# Missing required variables will cause the app to crash on startup with a clear error message.

# ============================================================================
# DATABASE
# ============================================================================

# Database connection URI (supports PostgreSQL, MySQL, MongoDB URIs)
# Example: postgresql://user:pass@localhost:5432/appname
DATABASE_URI=postgresql://localhost:5432/local_db

# Maximum number of concurrent database connections
DATABASE_MAX_CONNECTIONS=10

# Database query timeout in milliseconds
DATABASE_TIMEOUT=5000


# ============================================================================
# AUTHENTICATION
# ============================================================================

# Secret key for signing session tokens (use a random 32+ character string)
# Generate with: openssl rand -base64 32
AUTH_SESSION_SECRET=your-random-secret-key-here

# JWT token expiry in seconds (default 1 hour)
AUTH_JWT_EXPIRY=3600

# One-time password (OTP) expiry in seconds (default 5 minutes)
AUTH_OTP_EXPIRY=300


# ============================================================================
# BILLING
# ============================================================================

# Stripe API secret key (starts with sk_)
BILLING_STRIPE_SECRET_KEY=sk_test_xxxxx

# Stripe publishable key (starts with pk_)
BILLING_STRIPE_PUBLISHABLE_KEY=pk_test_xxxxx

# Stripe webhook signing secret (for webhook validation)
BILLING_WEBHOOK_SECRET=whsec_xxxxx


# ============================================================================
# EMAIL
# ============================================================================

# AWS SES region (e.g., us-east-1, eu-west-1)
EMAIL_SES_REGION=us-east-1

# From address for transactional emails
# Example: noreply@example.com
EMAIL_FROM_ADDRESS=noreply@example.com

# Maximum number of retries for failed email sends
EMAIL_MAX_RETRIES=3


# ============================================================================
# LOGGING
# ============================================================================

# Log level: debug, info, warn, error (default: info)
LOGGING_LEVEL=debug

# Log format: json (production), pretty (development)
# In production, always use json for log aggregation compatibility
LOGGING_FORMAT=pretty


# ============================================================================
# SERVER
# ============================================================================

# HTTP server port (default: 3000)
SERVER_PORT=3000

# Environment: development, staging, production
NODE_ENV=development

# Application version (read from package metadata, set during CI)
APP_VERSION=0.1.0
```

Keep .env.example **in sync** with config schema. Any new config variable must be added here with a comment explaining its purpose.

---

## 3. Health Check Endpoint

The health check endpoint is **unauthenticated** and serves load balancers, monitoring systems, and manual status checks. It must respond quickly (< 1 second).

### 3.1 Endpoint Definition

```
GET /health
  - No authentication required
  - No request body
  - Returns 200 OK on healthy state, 503 Service Unavailable if degraded
  - Response timeout: 1 second (if any check exceeds this, return 503)
```

### 3.2 Response Schema

```
HTTP 200 OK:
{
  "status": "healthy" | "degraded",
  "server": {
    "version": string,        // e.g., "0.1.0"
    "commitHash": string,     // e.g., "a1b2c3d" (optional if not in CI)
    "uptime": number,         // seconds since app started
    "nodeEnv": string,        // development, staging, production
  },
  "database": {
    "connected": boolean,
    "latency": number,        // milliseconds for ping query
    "pool": {
      "active": number,       // active connections
      "idle": number,         // idle connections
      "max": number,          // configured max
    }
  },
  "timestamp": ISO8601,       // when this health check was performed
}

HTTP 503 Service Unavailable:
{
  "status": "unhealthy",
  "reason": string,           // e.g., "database unreachable"
  "timestamp": ISO8601,
}
```

### 3.3 Health Check Logic

```
HEALTH_CHECK_PROCEDURE:
  1. Record start time
  2. Gather server info: version, commit hash, uptime, env
  3. Attempt database ping with timeout (500ms max):
     - Send lightweight ping query (SELECT 1, PING, etc. depending on DB)
     - Measure latency
     - Catch timeout/error → mark database.connected = false, set overall status = degraded
  4. Gather connection pool stats (if available from driver)
  5. If any check timed out or failed → status = degraded, HTTP 503
  6. If all checks passed → status = healthy, HTTP 200
  7. If total time exceeded 1 second → timeout, return 503 with reason
  8. Return JSON response with collected data
```

The database ping must **timeout gracefully**. It does not block the app or close connections—it simply marks connectivity as down and returns 503.

---

## 4. Logging Framework

Logging is structured, leveled, and context-aware. In production, logs are JSON-formatted for compatibility with log aggregation systems (CloudWatch, DataDog, Splunk, etc.). In development, logs are pretty-printed for readability.

### 4.1 Logger Interface

```
logger = {
  debug(message, context),
  info(message, context),
  warn(message, context),
  error(message, context, error),
}

// Usage:
logger.info("User signed up", { userId: "123", email: "user@example.com" })
logger.error("Database query failed", { query: "SELECT * FROM users", retries: 3 }, err)
logger.debug("Cache miss", { key: "user:123", ttl: 3600 })
```

All log functions accept:
- `message`: string (required)
- `context`: object (optional, arbitrary key-value pairs for structured logging)
- `error`: Error object (only for error level)

### 4.2 Levels

```
DEBUG: Diagnostic information for developers. Use sparingly in production.
       Example: "Cache query executed", "Request received", "Parsing configuration"

INFO: General informational messages about normal operation.
      Example: "Server started on port 3000", "User signed in", "Email sent"

WARN: Potentially problematic situations that don't prevent operation.
      Example: "Database connection pool low", "Rate limit approaching", "Slow query (>1s)"

ERROR: Error conditions that should be investigated.
       Example: "Failed to send email", "Database connection lost", "Invalid request"
```

The log level is controlled by `LOGGING_LEVEL` env var. Logs below the configured level are **not** written.

### 4.3 Structured Output Format

**Production (JSON):**
```
{
  "timestamp": "2026-03-26T14:23:45.123Z",
  "level": "info",
  "message": "User signed up",
  "requestId": "req-a1b2c3d4",
  "userId": "user-456",
  "email": "user@example.com",
  "duration": 245
}
```

**Development (Pretty-printed):**
```
[14:23:45.123] INFO req-a1b2c3d4 User signed up
  userId: user-456
  email: user@example.com
  duration: 245
```

Every log entry includes:
- `timestamp`: ISO 8601 UTC time
- `level`: debug, info, warn, error
- `message`: the log message
- `requestId`: unique ID for request tracing (propagated through all logs for that request)
- `context`: all fields from the context object passed to the logger

### 4.4 Redaction Rules

**Never log these values:**
- Passwords, API keys, tokens, secrets
- OTP codes, session tokens, JWT tokens
- PII: social security numbers, credit card numbers (full), passport numbers
- Internal IDs that could enable enumeration attacks

**Redaction list (configurable):**
```
REDACTION_PATTERNS = [
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "otpCode",
  "otp_code",
  "creditCard",
  "credit_card",
  "ssn",
  "social_security",
  "passportNumber",
  "passport_number",
]

// Before logging, scan context object keys:
// If key matches any pattern (case-insensitive), replace value with "[REDACTED]"

logger.info("User login", {
  userId: "123",
  sessionToken: "secret-token-xyz",   // ← key matches "token" pattern
})
// Output: { ..., sessionToken: "[REDACTED]", ... }
```

---

## 5. Request Context & Request ID

Every incoming HTTP request gets a unique ID for distributed tracing. This ID is propagated through all log entries and returned to the client for debugging.

### 5.1 Request ID Generation & Propagation

```
INCOMING_REQUEST_MIDDLEWARE:
  1. Check for X-Request-ID header in request
     - If present and valid format → use it
     - If not present → generate new UUID or nanoid (e.g., "req-a1b2c3d4-e5f6g7h8")
  2. Store requestId in request context (req.id, ctx.id, or equivalent)
  3. Store in async-local storage or request-scoped context for access from any function
  4. Add to response header: X-Request-ID: <requestId>
  5. Pass requestId to all log entries within this request
```

Request ID format: `req-` + unique identifier (UUID, nanoid, or timestamp-based). Must be human-readable and URL-safe.

### 5.2 Async Context Propagation

In async operations (database queries, external API calls, etc.), the request context must be preserved:

```
// Pseudo-code for async context

ASYNC_CONTEXT_STORAGE:
  // Use language/framework-specific solution:
  // Node.js: AsyncLocalStorage
  // Python: contextvars
  // Go: context.Context
  // Java: ThreadLocal or virtual threads

REQUEST_SCOPED_GETTER:
  function getRequestId():
    return asyncContext.getRequestId() || "unknown"

// Usage in async database call:
async function queryUsers():
  requestId = getRequestId()   // automatically retrieves from async context
  logger.debug("Querying users", { requestId })
  users = await database.query("SELECT * FROM users")
  logger.info("Query complete", { requestId, count: users.length })
```

This ensures that all logs related to a single incoming request have the same requestId, even across async boundaries.

### 5.3 Response Header

Include the request ID in every response:

```
HTTP/1.1 200 OK
X-Request-ID: req-a1b2c3d4-e5f6g7h8
Content-Type: application/json

{ ... response body ... }
```

Clients and monitoring tools can use this header to correlate logs when debugging issues.

---

## 6. Startup Validation

When the app starts, configuration is validated before any other initialization. If validation fails, the app exits immediately with a helpful error message.

### 6.1 Validation Error Message Format

```
ERROR: Configuration validation failed. The following variables are missing or invalid:

DATABASE_URI
  Required: Yes
  Type: string (URI)
  Description: Database connection URI
  Example: postgresql://user:pass@localhost:5432/appname

AUTH_SESSION_SECRET
  Required: Yes
  Type: string
  Description: Secret key for signing session tokens
  Example: <use 'openssl rand -base64 32' to generate>

BILLING_STRIPE_SECRET_KEY
  Required: Yes
  Type: string
  Description: Stripe API secret key
  Current value: invalid format (should start with 'sk_')

Fix these issues and try again. See .env.example for all available variables.
```

Errors are grouped by domain if applicable. Each error includes:
- The variable name
- Whether it's required
- The expected type
- A description
- An example value (if applicable)
- Why it failed (if it was provided but invalid)

**Exit code: 1** (failure). The app does not start.

### 6.2 Startup Log Entry

On successful startup, log the configuration (redacting sensitive values):

```
logger.info("Application started", {
  nodeEnv: "production",
  version: "0.1.0",
  port: 3000,
  database: { uri: "postgresql://...", maxConnections: 10 },
  logging: { level: "info", format: "json" },
  // auth and billing secrets are redacted automatically
})
```

---

## 7. Gotchas & Best Practices

### 7.1 Environment Variable Type Coercion

Env vars are always strings. Explicit coercion is required for other types.

```
GOTCHA: NODE_ENV=false loads as the string "false", not boolean false
SOLUTION: Use explicit type validation in schema
  type: boolean
  coerce: function(value)
    if value === "true" → return true
    if value === "false" → return false
    throw new Error("Expected 'true' or 'false', got: " + value)

GOTCHA: PORT=8000 loads as string "8000"
SOLUTION: Parse to number explicitly
  type: number
  coerce: function(value)
    parsed = parseInt(value, 10)
    if isNaN(parsed) → throw error
    return parsed
```

### 7.2 Boolean Environment Variables

There's no standard for boolean env vars. Three common conventions:

```
Convention 1: "true" / "false" (RECOMMENDED)
  FEATURE_ENABLED=true

Convention 2: "1" / "0"
  FEATURE_ENABLED=1

Convention 3: presence (var exists = true, missing = false)
  FEATURE_ENABLED=<any value>
```

Choose one convention and document it in .env.example. The config validation must handle the chosen convention consistently.

### 7.3 Missing Variables in CI vs Local

Local development and CI have different concerns:

```
LOCAL DEVELOPMENT:
  - .env file exists and provides defaults
  - Easier to run if you forget a variable
  - Risk: inconsistent config between developers

CI/STAGING/PRODUCTION:
  - No .env file (or it's generated from secrets)
  - Required to explicitly set every variable
  - Fail fast if anything is missing
  - Safer: all environments have consistent config

BEST PRACTICE:
  - In local dev, .env can have fallback values
  - In CI, require all variables to be set (no .env)
  - Use environment-specific config profiles if needed
    config.development, config.staging, config.production
```

### 7.4 Log Volume in Production

Structured logging with JSON output is high-volume in production. Without careful log level management, disk/network can be overwhelmed.

```
GOTCHA: Every debug-level log becomes an entry in the aggregation system
SOLUTION:
  - Set LOGGING_LEVEL=info (not debug) in production
  - Be selective with info logs; reserve for important events
  - Use debug logs liberally in development only
  - Monitor log volume metrics; alert if volume spikes

GOTCHA: Large context objects get JSON-serialized for every log entry
SOLUTION:
  - Keep context objects focused (5-10 fields max)
  - Avoid logging raw request/response bodies
  - Use sampling for high-frequency operations

GOTCHA: Request ID propagation creates a lot of duplicate requestId values
SOLUTION:
  - This is intentional for tracing; it's a feature, not a bug
  - Log aggregation systems can filter/group by requestId
  - The storage overhead is minimal (8-20 bytes per log entry)
```

### 7.5 .env File Precedence

Environment variables should be loaded in this order (highest to lowest precedence):

```
1. process.env (system environment, set before app starts)
2. .env file (local overrides)
3. defaults (hardcoded in config schema)

WRONG:
  Load .env first, then overwrite with process.env

CORRECT:
  Start with empty config
  Merge .env values
  Overwrite with process.env values
  This allows CI/production to override local .env via system env vars
```

---

## 8. Implementation Checklist

The implementation agent (reading `stack.md`) should deliver:

- [ ] **Config module** with schema validation, domain grouping, and typed exports
- [ ] **Startup validation** that crashes on missing/invalid config with clear error messages
- [ ] **.env.example** file committed to repo with all variables documented
- [ ] **Health check endpoint** at `GET /health` returning server/DB status
- [ ] **Logging framework** with debug/info/warn/error levels, structured JSON in prod
- [ ] **Request ID middleware** generating and propagating unique IDs through requests
- [ ] **Redaction rules** preventing sensitive values from being logged
- [ ] **Async context storage** preserving request ID across async operations
- [ ] **Response header** including X-Request-ID on all responses
- [ ] **Startup log entry** confirming successful initialization

---

## Related Recipes

- **Monitoring & Alerting**: Build on the health check endpoint for system monitoring
- **Database Connectivity**: The config module provides the DB URI; see database recipe for connection pooling details
- **API Middleware**: The request ID middleware belongs here; integrate with route handlers
- **Error Handling**: Pair logging with centralized error handling for consistent error responses
