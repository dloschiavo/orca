---
name: DevOps Enhancements
description: Audit trail system, CI/CD pipeline templates, database migrations, and API versioning
type: enhancement
requires: recipes/dev-ops.md, recipes/database.md, recipes/routing.md
env_vars: AUDIT_LOG_RETENTION_DAYS (default 365), CI_PROVIDER (github|gitlab|circleci), DB_MIGRATION_LOCK_TIMEOUT_SECONDS (default 30)
---

# DevOps Enhancements

Production-ready audit logging, standardized CI/CD pipelines, database migration framework, and API versioning system. Designed to be stack-agnostic and database-agnostic.

---

## 1. Audit Trail System

Immutable append-only event log of all significant system events. Every user action, role change, login, setting update, and admin action is recorded with full context.

### Data Model

```
AuditLog {
  id:              string (UUID)
  timestamp:       datetime (UTC, immutable)
  actor_id:        string (user_id, admin_id, or "system")
  actor_type:      enum ['user', 'admin', 'system', 'service']
  action:          enum [
    'user.created', 'user.updated', 'user.deleted',
    'user.login', 'user.logout',
    'user.password_changed', 'user.email_changed',
    'role.assigned', 'role.removed', 'role.updated',
    'permission.granted', 'permission.revoked',
    'setting.changed',
    'billing.plan_changed', 'billing.payment_received', 'billing.invoice_created',
    'admin.login', 'admin.logout',
    'admin.user_impersonate', 'admin.user_unimpersonate',
    'admin.config_changed',
    'data.exported', 'data.deleted',
    'api.key_created', 'api.key_revoked',
    'session.created', 'session.revoked',
    'custom.any_other_action'  // For app-specific events
  ]
  resource_type:   enum ['user', 'role', 'permission', 'setting', 'billing', 'api_key', 'session', 'data', 'custom']
  resource_id:     string (ID of affected resource)
  details:         object (JSON, context-specific data)
  ip_address:      string (source IP, can be null for system events)
  user_agent:      string (client user agent, can be null)
  created_at:      datetime (UTC, auto-populated)
  ttl:             datetime or null (auto-calculated from retention policy)
}
```

### Indexes

```
// Lookup by actor
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, timestamp DESC);

// Lookup by action
CREATE INDEX idx_audit_logs_action ON audit_logs(action, timestamp DESC);

// Lookup by resource
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id, timestamp DESC);

// Lookup by timestamp (for retention cleanup)
CREATE INDEX idx_audit_logs_ttl ON audit_logs(ttl) WHERE ttl IS NOT NULL;

// Composite: actor + action
CREATE INDEX idx_audit_logs_actor_action ON audit_logs(actor_id, action, timestamp DESC);
```

### Environment Configuration

```env
# Audit log retention policy
AUDIT_LOG_RETENTION_DAYS=365

# TTL cleanup job frequency (cron)
AUDIT_LOG_CLEANUP_SCHEDULE="0 2 * * *"  # 2 AM daily

# Audit log storage (optional: write to separate service)
AUDIT_LOG_STORAGE_PROVIDER="database"  # or "elasticsearch", "datadog", etc.
AUDIT_LOG_INDEX_NAME="audit_logs"

# Sampling (if volume is high, sample events)
AUDIT_LOG_SAMPLE_RATE=1.0  # 1.0 = all events, 0.5 = 50% of events
```

### Helper Function

Pseudocode for logging:

```pseudocode
function auditLog(
  actor_id: string,
  actor_type: enum,
  action: string,
  resource_type: string,
  resource_id: string,
  details: object,
  request: HttpRequest  // optional, for ip_address and user_agent
):

  // Check sampling rate
  if (random() > AUDIT_LOG_SAMPLE_RATE):
    return  // Skip this event

  log_entry = {
    id: generateUUID(),
    timestamp: getCurrentTimeUTC(),
    actor_id: actor_id,
    actor_type: actor_type,
    action: action,
    resource_type: resource_type,
    resource_id: resource_id,
    details: details || {},
    ip_address: request?.getClientIP() || null,
    user_agent: request?.getHeader('user-agent') || null,
    created_at: getCurrentTimeUTC(),
    ttl: getCurrentTimeUTC() + (AUDIT_LOG_RETENTION_DAYS * 24 * 3600)
  }

  // Validate action is in enum
  if (!isValidAction(log_entry.action)):
    throw Error('Invalid audit action: ' + log_entry.action)

  // Write to database (fire and forget, don't block request)
  db.audit_logs.insert(log_entry).background()  // async write

  // Optionally send to external service
  if (AUDIT_LOG_STORAGE_PROVIDER != 'database'):
    sendToAuditService(log_entry).background()
```

### Integration Points

Inject `auditLog()` calls at these points:

```pseudocode
// User CRUD
POST /admin/api/users:
  user = createUser(request.body)
  auditLog(admin_id, 'admin', 'user.created', 'user', user.id, {
    email: user.email,
    role: user.role
  }, request)

DELETE /admin/api/users/:user_id:
  user = deleteUser(user_id)
  auditLog(admin_id, 'admin', 'user.deleted', 'user', user_id, {
    email: user.email,
    reason: request.body.reason
  }, request)

// Login/Logout
POST /api/auth/login:
  session = authenticate(request.body)
  auditLog(session.user_id, 'user', 'user.login', 'session', session.id, {
    method: 'password'  // or 'oauth', 'sso', etc.
  }, request)

POST /api/auth/logout:
  auditLog(user_id, 'user', 'user.logout', 'session', session.id, {}, request)

// Role changes
POST /admin/api/users/:user_id/roles:
  assignRole(user_id, request.body.role)
  auditLog(admin_id, 'admin', 'role.assigned', 'role', request.body.role, {
    user_id: user_id
  }, request)

// Billing events
webhook POST /webhooks/billing/payment:
  payment = processBillingEvent(request.body)
  auditLog('system', 'system', 'billing.payment_received', 'billing', payment.id, {
    amount: payment.amount,
    currency: payment.currency,
    user_id: payment.user_id
  })

// Settings changes
POST /admin/api/settings:
  old_settings = getCurrentSettings()
  new_settings = updateSettings(request.body)
  auditLog(admin_id, 'admin', 'setting.changed', 'setting', setting_id, {
    changes: diff(old_settings, new_settings)
  }, request)

// Admin impersonation
POST /admin/api/users/:user_id/impersonate:
  auditLog(admin_id, 'admin', 'admin.user_impersonate', 'user', user_id, {
    duration_minutes: request.body.duration || null
  }, request)
```

### Admin Audit Log Viewer

API endpoint to query audit logs:

```
GET /admin/api/audit-logs?actor_id=&action=&resource_type=&limit=100&offset=0
  - Paginated, returns most recent events first
  - Filter by actor, action, resource type
  - Sensitive fields (like passwords) are never in details

GET /admin/api/audit-logs/:log_id
  - View single audit log entry in full

GET /admin/api/audit-logs/export?format=csv&filters=...
  - Export audit logs (useful for compliance/SOC 2)
```

### Cleanup Job

Pseudocode for TTL-based cleanup:

```pseudocode
job cleanupExpiredAuditLogs():
  // This job runs on AUDIT_LOG_CLEANUP_SCHEDULE (e.g., daily)

  expired_logs = db.audit_logs.find({
    ttl: { $lte: getCurrentTimeUTC() }
  }).limit(10000)  // Batch delete to avoid locking

  for log in expired_logs:
    db.audit_logs.delete({ id: log.id })

  log('audit_cleanup_complete', { count: expired_logs.count() })
```

### Security & Gotchas

1. **Audit logs are immutable**: Never update or delete logs except via TTL cleanup. If you need to correct an entry, create a new audit log entry describing the correction.

2. **High volume**: In active systems, audit logs can grow very large (millions of entries). Use sampling or archival:
   - Sampling: `AUDIT_LOG_SAMPLE_RATE=0.1` logs 10% of events
   - Archival: Move old logs to cold storage after N days

3. **PII in details**: Be careful not to log sensitive data (passwords, API keys, credit card numbers) in the `details` field. Implement redaction:
   ```pseudocode
   function redactSensitiveData(details):
     if (details.password):
       details.password = '***'
     if (details.api_key):
       details.api_key = 'key_***' + details.api_key.slice(-4)
     return details
   ```

4. **Async write failures**: If the database write fails (network issue, full disk), the request still succeeds. Consider a fallback:
   - Write to local queue on write failure
   - Async worker retries
   - Alert if queue grows too large

5. **Timezone in logs**: Always store timestamps in UTC. Display in user's timezone on the UI.

---

## 2. CI/CD Pipeline Template

Standardized CI/CD configuration for GitHub Actions (primary), with notes for GitLab CI and CircleCI. Covers all stages: lint, type-check, test, build, deploy-staging, deploy-production.

### GitHub Actions Workflow Structure

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  NODE_ENV: production
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint code
        run: npm run lint
        # ESLint, Prettier, etc.

      - name: Lint commit messages
        run: npm run lint:commits
        # commitlint to enforce conventional commits

      - name: Check package.json
        run: npm run lint:package
        # Ensure deps are properly declared

  type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run type-check
        # TypeScript, Flow, etc.

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --coverage
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/test_db
          REDIS_URL: redis://localhost:6379

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
          flags: unittests

  build:
    runs-on: ubuntu-latest
    needs: [lint, type-check, test]
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Check bundle size
        run: npm run build:analyze
        # Warn if any chunk exceeds size budget

      - name: Upload build artifact
        uses: actions/upload-artifact@v3
        with:
          name: build
          path: dist/
          retention-days: 1

  deploy-staging:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/develop'
    environment: staging
    steps:
      - uses: actions/checkout@v3

      - name: Download build
        uses: actions/download-artifact@v3
        with:
          name: build
          path: dist/

      - name: Deploy to staging
        env:
          STAGING_DEPLOY_TOKEN: ${{ secrets.STAGING_DEPLOY_TOKEN }}
        run: |
          npm run deploy:staging -- \
            --token=$STAGING_DEPLOY_TOKEN

      - name: Run smoke tests
        run: npm run test:smoke
        env:
          APP_URL: https://staging.example.com

      - name: Health check
        run: |
          curl -f https://staging.example.com/health || exit 1
          sleep 5
          curl -f https://staging.example.com/health || exit 1

  deploy-production:
    runs-on: ubuntu-latest
    needs: build
    if: startsWith(github.ref, 'refs/tags/v')
    environment: production
    steps:
      - uses: actions/checkout@v3

      - name: Download build
        uses: actions/download-artifact@v3
        with:
          name: build
          path: dist/

      - name: Verify version tag
        run: |
          VERSION=$(node -p "require('./package.json').version")
          TAG=${GITHUB_REF#refs/tags/}
          if [ "v$VERSION" != "$TAG" ]; then
            echo "Tag $TAG does not match package.json version $VERSION"
            exit 1
          fi

      - name: Deploy to production
        env:
          PROD_DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}
        run: |
          npm run deploy:production -- \
            --token=$PROD_DEPLOY_TOKEN \
            --region=us-east-1

      - name: Health check (5 retries)
        run: |
          for i in {1..5}; do
            echo "Health check attempt $i"
            if curl -f https://example.com/health; then
              echo "Health check passed"
              exit 0
            fi
            sleep 10
          done
          echo "Health check failed after 5 attempts"
          exit 1

      - name: Rollback on failure
        if: failure()
        env:
          PROD_DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}
        run: npm run rollback:production -- --token=$PROD_DEPLOY_TOKEN

      - name: Notify deployment
        if: success()
        run: |
          curl -X POST https://hooks.slack.com/services/... \
            -d '{"text": "Production deployment successful: '${{ env.GITHUB_REF }}'}'

  docker-build:
    runs-on: ubuntu-latest
    needs: [lint, type-check, test]
    if: github.event_name == 'push'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to Container Registry
        uses: docker/login-action@v2
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix={{branch}}-

      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache
          cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache,mode=max
```

### PR Preview Deploys

```yaml
# .github/workflows/preview-deploy.yml
name: Preview Deploy

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Build
        run: npm ci && npm run build

      - name: Deploy preview
        id: deploy
        env:
          PREVIEW_TOKEN: ${{ secrets.PREVIEW_DEPLOY_TOKEN }}
        run: |
          PREVIEW_URL=$(npm run deploy:preview -- --token=$PREVIEW_TOKEN)
          echo "preview_url=$PREVIEW_URL" >> $GITHUB_OUTPUT

      - name: Comment on PR
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '✅ Preview deployed to: ${{ steps.deploy.outputs.preview_url }}'
            })
```

### Caching Strategy

```yaml
# Caching node_modules
- uses: actions/setup-node@v3
  with:
    node-version: '18'
    cache: 'npm'
    cache-dependency-path: 'package-lock.json'

# Cache build artifacts (between build and deploy jobs)
- name: Cache build
  uses: actions/cache@v3
  with:
    path: dist/
    key: build-${{ github.sha }}
    restore-keys: build-
```

### GitLab CI Equivalent

```yaml
# .gitlab-ci.yml
stages:
  - lint
  - type-check
  - test
  - build
  - deploy-staging
  - deploy-production

lint:
  stage: lint
  image: node:18
  script:
    - npm ci
    - npm run lint

type-check:
  stage: type-check
  image: node:18
  script:
    - npm ci
    - npm run type-check

test:
  stage: test
  image: node:18
  services:
    - postgres:15
    - redis:7
  variables:
    POSTGRES_PASSWORD: postgres
    DATABASE_URL: postgres://postgres:postgres@postgres:5432/test_db
    REDIS_URL: redis://redis:6379
  script:
    - npm ci
    - npm test -- --coverage
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'

build:
  stage: build
  image: node:18
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 day

deploy-staging:
  stage: deploy-staging
  script:
    - npm run deploy:staging
  only:
    - develop
  environment:
    name: staging
    url: https://staging.example.com

deploy-production:
  stage: deploy-production
  script:
    - npm run deploy:production
  only:
    - tags
  environment:
    name: production
    url: https://example.com
  when: manual
```

### Environment-Specific Configuration

```pseudocode
// deploy.js (pseudocode)
function getDeploymentConfig(environment):
  if environment == 'staging':
    return {
      api_endpoint: 'https://api-staging.example.com',
      cdn_url: 'https://cdn-staging.example.com',
      db_pool_size: 10,
      log_level: 'debug',
      sentry_environment: 'staging'
    }

  if environment == 'production':
    return {
      api_endpoint: 'https://api.example.com',
      cdn_url: 'https://cdn.example.com',
      db_pool_size: 50,
      log_level: 'warn',
      sentry_environment: 'production'
    }
```

### Secrets Management

Never commit secrets. Use CI/CD secret storage:

```yaml
# GitHub Actions
env:
  API_KEY: ${{ secrets.API_KEY }}
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}
```

Create these in repo settings → Secrets and variables → Actions.

### Health Check After Deploy

```pseudocode
function healthCheck(url, maxRetries = 5):
  for attempt in 1..maxRetries:
    try:
      response = GET url + '/health'
      if response.status == 200:
        health_data = JSON.parse(response.body)
        if health_data.status == 'ok':
          return true
      log('health_check_failed', {
        attempt: attempt,
        status: response.status,
        body: response.body
      })
    catch error:
      log('health_check_error', { attempt: attempt, error: error.message })

    if attempt < maxRetries:
      sleep(10 seconds)

  return false
```

### Rollback Trigger

```pseudocode
// Deploy script with rollback
function deployProduction(version):
  // Deploy new version
  deployToServer(version)

  // Health check
  if not healthCheck('https://example.com'):
    log('health_check_failed, triggering rollback')

    // Rollback to previous version
    previousVersion = getPreviousVersion()
    deployToServer(previousVersion)

    // Verify rollback
    if not healthCheck('https://example.com'):
      sendAlert('CRITICAL: Rollback failed, manual intervention required')
    else:
      sendAlert('Rollback successful, investigating issue')

    return false

  return true
```

---

## 3. Database Migration Framework

Schema change framework with timestamped migration files, up/down functions, migration runner, and CLI commands.

### Migration File Structure

```
migrations/
  ├── 20250320_100000_create_users_table.sql
  ├── 20250320_110000_create_roles_table.sql
  ├── 20250321_140000_add_email_verified_column.sql
  ├── 20250322_090000_create_audit_logs_table.sql
  └── 20250325_120000_add_indexes.sql
```

Migration file format (SQL):

```sql
-- migrations/20250320_100000_create_users_table.sql

-- +migrate Up
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);

-- +migrate Down
DROP TABLE users;
```

Or in JavaScript (for more complex logic):

```javascript
// migrations/20250320_100000_create_users_table.js

exports.up = async (knex) => {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.timestamps(true, true);
  });

  await knex.schema.raw('CREATE INDEX idx_users_email ON users(email)');
};

exports.down = async (knex) => {
  await knex.schema.dropTable('users');
};
```

### Migration Runner & Tracking

Migrations table:

```
_migrations {
  id:              bigint, primary key
  name:            string,  // e.g., "20250320_100000_create_users_table"
  applied_at:      datetime,
  duration_ms:     bigint,
  checksum:        string   // hash of migration file, detect modifications
}
```

Migration runner pseudocode:

```pseudocode
function runMigrations(direction = 'up'):

  // Acquire lock to prevent concurrent migrations
  lock = acquireMigrationLock(timeout = DB_MIGRATION_LOCK_TIMEOUT_SECONDS)
  if not lock:
    throw Error('Migration lock acquired by another process')

  try:
    pending_migrations = getPendingMigrations(direction)

    if pending_migrations.length == 0:
      log('No pending migrations')
      return

    for migration in pending_migrations:
      log('Applying migration', { name: migration.name })

      // Verify migration file hasn't been modified
      if migration.checksum != calculateChecksum(migration.file_path):
        throw Error('Migration file modified after application: ' + migration.name)

      start_time = getCurrentTime()

      try:
        if direction == 'up':
          executeUp(migration.file_path)
        else:
          executeDown(migration.file_path)

        duration_ms = getCurrentTime() - start_time

        // Record in migrations table
        if direction == 'up':
          recordAppliedMigration(migration.name, duration_ms)
        else:
          recordRolledBackMigration(migration.name)

        log('Migration applied successfully', {
          name: migration.name,
          duration_ms: duration_ms
        })

      catch error:
        log('Migration failed', { name: migration.name, error: error.message })
        throw Error('Migration failed: ' + migration.name + ' - ' + error.message)

  finally:
    releaseMigrationLock(lock)
```

### CLI Commands

```bash
# Create new migration
npm run create-migration "add_email_verified_column"
# Output: migrations/20250326_143022_add_email_verified_column.js

# Apply pending migrations
npm run migrate-up
# Output: Applying migration 20250320_100000_create_users_table...
#         Migration applied successfully (45ms)

# Rollback last migration
npm run migrate-down
# Output: Rolling back migration 20250320_100000_create_users_table...
#         Migration rolled back successfully (22ms)

# Rollback specific number of migrations
npm run migrate-down --count=3
# Rolls back last 3 migrations

# Check migration status
npm run migration-status
# Output: Applied migrations:
#         ✓ 20250320_100000_create_users_table
#         ✓ 20250320_110000_create_roles_table
#
#         Pending migrations:
#         - 20250321_140000_add_email_verified_column
#         - 20250322_090000_create_audit_logs_table
```

### Lock Mechanism

Pseudocode for distributed migration locking:

```pseudocode
function acquireMigrationLock(timeout_seconds):

  // Use database row-level lock (works across servers)
  lock_row = db.execute(
    'SELECT * FROM _migration_lock FOR UPDATE NOWAIT TIMEOUT ?',
    [timeout_seconds * 1000]
  )

  if not lock_row:
    return null  // Lock acquired by another process

  // Update lock row with this process's ID and timestamp
  db.execute(
    'UPDATE _migration_lock SET locked_by = ?, locked_at = ? WHERE id = 1',
    [getCurrentProcessId(), getCurrentTime()]
  )

  return lock_row.id

function releaseMigrationLock(lock_id):
  db.execute('UPDATE _migration_lock SET locked_by = NULL WHERE id = ?', [lock_id])
```

### Idempotent Operations

Migration should be safe to run multiple times:

```sql
-- Create table if it doesn't exist
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

-- Add column if it doesn't exist
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

-- Create index if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

### CI/CD Integration

Run migrations before deploy:

```yaml
# .github/workflows/deploy.yml
deploy:
  steps:
    - name: Run migrations
      run: npm run migrate-up

    - name: Verify migration status
      run: npm run migration-status

    - name: Deploy app
      run: npm run deploy:production
```

### Seed Data

Separate from migrations. Seed files are per-app, migrations are kit-level:

```
seeds/
  ├── 00_roles.js
  ├── 01_permissions.js
  └── 02_admin_user.js
```

```javascript
// seeds/00_roles.js
exports.seed = async (knex) => {
  // Delete existing roles (only in dev/test)
  await knex('roles').del();

  // Insert default roles
  await knex('roles').insert([
    { id: 'admin', name: 'Administrator', created_at: new Date() },
    { id: 'user', name: 'User', created_at: new Date() },
    { id: 'guest', name: 'Guest', created_at: new Date() }
  ]);
};
```

Run with:
```bash
npm run seed
```

### Security & Gotchas

1. **Production migrations must be reversible**: Always include `DOWN` function. Test rollback locally before pushing.

2. **Data loss in DOWN migrations**: Be careful with `DROP TABLE` or `DELETE`. Consider safe alternatives:
   ```sql
   -- RISKY: This deletes data
   DROP TABLE old_table;

   -- SAFER: Rename, so data is preserved
   ALTER TABLE old_table RENAME TO old_table_backup_20250326;
   ```

3. **Long-running migrations**: Lock tables during migrations. On large tables (millions of rows), consider:
   - Add index in background (PostgreSQL: `CREATE INDEX CONCURRENTLY`)
   - Add column in multiple steps (add nullable, populate, make NOT NULL)

4. **Concurrent writes during migration**: If app is still running while migrating, inconsistencies can occur. Always enable maintenance mode during production migrations.

5. **Foreign key constraints**: When adding columns that reference other tables, ensure referential integrity:
   ```sql
   -- Add column
   ALTER TABLE users ADD COLUMN role_id UUID;

   -- Add constraint (may fail if orphaned rows exist)
   ALTER TABLE users ADD CONSTRAINT fk_users_role_id
     FOREIGN KEY (role_id) REFERENCES roles(id);
   ```

6. **Default values**: When adding non-nullable column to existing table, provide default or backfill data:
   ```sql
   -- Add with default
   ALTER TABLE users ADD COLUMN status VARCHAR(50) DEFAULT 'active' NOT NULL;

   -- Or backfill before adding constraint
   ALTER TABLE users ADD COLUMN status VARCHAR(50);
   UPDATE users SET status = 'active';
   ALTER TABLE users ALTER COLUMN status SET NOT NULL;
   ```

---

## 4. API Versioning Convention

URL-based versioning with deprecation headers. Breaking changes require new version; non-breaking changes go to existing version.

### Versioning Scheme

```
/api/v1/users          <- Version 1
/api/v2/users          <- Version 2 (breaking change)
/api/v3/users          <- Version 3 (breaking change)
```

Never in headers:
```
❌ NOT: GET /api/users
     Accept-Version: v1
```

### Version Routing

Pseudocode:

```pseudocode
router = createRouter()

// Version detection middleware
middleware versionMiddleware(request, response, next):
  version = extractVersionFromPath(request.path)
  // e.g., /api/v2/users -> version = '2'

  if not version:
    version = getDefaultVersion()  // e.g., 'latest' or '1'

  request.apiVersion = version
  response.setHeader('API-Version', version)

  next()

// Register routes per version
router.get('/api/v1/users', handleListUsersV1)
router.get('/api/v2/users', handleListUsersV2)
router.get('/api/v3/users', handleListUsersV3)

// OR use version-aware handler
router.get('/api/v:version/users', (request, response) => {
  version = request.params.version

  switch(version):
    case '1': handleListUsersV1(request, response)
    case '2': handleListUsersV2(request, response)
    case '3': handleListUsersV3(request, response)
    default: handleListUsersLatest(request, response)
})
```

### Breaking vs Non-Breaking Changes

**Non-breaking** — add to existing version:
- New optional parameter
- New optional response field
- New endpoint
- Bug fix (doesn't change behavior users depend on)

**Breaking** — requires new version:
- Required parameter changes
- Response field removed or type changes
- Endpoint URL changes
- Behavior change that breaks existing clients

Examples:

```javascript
// v1 handler
GET /api/v1/users/:id
{
  id: "user-123",
  name: "John Doe",
  email: "john@example.com"
}

// Non-breaking: Add new field
GET /api/v1/users/:id
{
  id: "user-123",
  name: "John Doe",
  email: "john@example.com",
  created_at: "2025-03-26T10:00:00Z"  // NEW
}

// Non-breaking: Add optional parameter
GET /api/v1/users?fields=id,name,email  // optional

// Breaking: Remove field → requires v2
GET /api/v2/users/:id
{
  id: "user-123",
  name: "John Doe"
  // email removed
}

// Breaking: Change field type → requires v2
GET /api/v2/users/:id
{
  id: "user-123",
  name: "John Doe",
  email: "john@example.com",
  created_at: 1711005600  // CHANGED from ISO string to timestamp
}
```

### Deprecation Headers

When old version is deprecated:

```
GET /api/v1/users

HTTP/1.1 200 OK
Deprecation: true
Sunset: Wed, 26 Mar 2026 00:00:00 GMT
Link: </api/v2/users>; rel="successor-version"
API-Warn: "API v1 is deprecated. Use /api/v2 instead."

{
  "data": [...]
}
```

### Admin Config for Active Versions

Allow admins to control which versions are active:

```
SystemSettings {
  api_versions_active: {
    v1: {
      active: true,
      deprecated: true,
      sunset_date: "2026-03-26",
      warn_clients: true
    },
    v2: {
      active: true,
      deprecated: false,
      sunset_date: null,
      warn_clients: false
    },
    v3: {
      active: true,
      deprecated: false,
      sunset_date: null,
      warn_clients: false
    }
  },
  default_api_version: 'latest'  // or explicit version like 'v3'
}
```

API to manage:

```
GET /admin/api/versions
  Returns list of all API versions and their status

POST /admin/api/versions/:version/deprecate
  {
    sunset_date: "2026-03-26",
    warn_clients: true
  }

POST /admin/api/versions/:version/activate
  Reactivate a deprecated version

GET /admin/api/versions/migration-guide
  Returns guide for clients to upgrade versions
```

### Version Response Metadata

Include version info in every response:

```json
{
  "apiVersion": "2",
  "data": {
    "id": "user-123",
    "name": "John Doe"
  },
  "_meta": {
    "version": "2",
    "deprecated": false,
    "latestVersion": "3",
    "sunsetting": null
  }
}
```

### Client Library Support

If you publish client libraries:

```javascript
// JavaScript client
const client = new APIClient({
  baseURL: 'https://example.com/api',
  version: 'v2',  // Explicit version
  // OR
  version: 'latest'  // Always use latest
});

// Automatic deprecation warnings
client.on('deprecation', (warning) => {
  console.warn('API Deprecation', warning);
  // Suggest upgrade to newer version
});
```

### Security & Gotchas

1. **Version string injection**: Validate version format:
   ```pseudocode
   function extractVersionFromPath(path):
     match = path.match(/\/api\/(v\d+)\//)
     if not match:
       return null

     version = match[1]
     if not ACTIVE_VERSIONS.includes(version):
       throw Error('Invalid API version: ' + version)

     return version
   ```

2. **Default version confusion**: Make it explicit:
   ```pseudocode
   // Bad: What is "latest"?
   DEFAULT_VERSION = 'latest'

   // Good: Explicit
   DEFAULT_VERSION = 'v1'
   // Document: "If no version in URL, defaults to v1. Clients should explicitly specify version."
   ```

3. **Sunset date in past**: When deprecating, ensure sunset is at least 3-6 months in future. Give clients time to upgrade.

4. **Orphaned endpoints**: Don't leave unmaintained versions. When sunsetting, migrating all clients.

5. **Database schema in multiple versions**: If database schema changed between versions, ensure each version handler can work with current schema:
   ```pseudocode
   // v1 handler, but DB schema changed
   handleListUsersV1(request, response):
     users = db.users.find({})

     // Map DB schema to v1 format (if schema changed in v2)
     return users.map(user => ({
       id: user.id,
       name: user.full_name,  // DB changed this column
       email: user.email_address  // DB changed this column
     }))
   ```

