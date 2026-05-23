---
name: Theming Enhancements
description: Dark mode support, system preference detection, and white-label / multi-tenant branding configuration
type: enhancement
requires: recipes/app-config-theming.md, recipes/rendering-routing.md
env_vars: THEME_SYSTEM_PREFERENCE_DETECTION (default true), THEME_STORAGE_BACKEND (db|localStorage), MULTI_TENANT_ENABLED (default false), TENANT_DETECTION_METHOD (subdomain|config)
---

# Theming Enhancements

Production-ready dark mode with system preference detection, manual toggle, and per-user persistence. White-label branding configuration for multi-tenant and licensable products.

---

## 1. Dark Mode Support

System preference detection with manual override. Three states: light, dark, system (default). Persisted per user with no flash on page load.

### Data Model

```
UserPreference {
  id:              string (UUID)
  user_id:         string
  theme_preference: enum ['light', 'dark', 'system']
    // 'system': Follow OS preference (prefers-color-scheme)
    // 'light': Always light
    // 'dark': Always dark
  updated_at:      datetime
}
```

Guest (unauthenticated) users: Store in localStorage as JSON.

### Environment Configuration

```env
# Theme system
THEME_SYSTEM_PREFERENCE_DETECTION=true
THEME_DEFAULT_MODE=system         # Default: 'system', 'light', or 'dark'
THEME_STORAGE_BACKEND=db          # 'db' for auth users, 'localStorage' for guests
THEME_TRANSITION_DURATION_MS=300   # Fade animation duration
THEME_CUSTOM_PROPERTIES_ENABLED=true
```

### CSS Custom Properties (Design Tokens)

Define all theme tokens as CSS variables:

```css
/* src/styles/theme.css */

/* Light theme (default) */
:root,
[data-theme="light"] {
  /* Colors */
  --color-primary: #0066cc;
  --color-primary-light: #e6f0ff;
  --color-primary-dark: #004080;

  --color-secondary: #6c757d;
  --color-success: #28a745;
  --color-danger: #dc3545;
  --color-warning: #ffc107;
  --color-info: #17a2b8;

  --color-background: #ffffff;
  --color-surface: #f8f9fa;
  --color-border: #dee2e6;

  --color-text-primary: #212529;
  --color-text-secondary: #6c757d;
  --color-text-tertiary: #999999;

  --color-shadow: rgba(0, 0, 0, 0.1);
  --color-shadow-dark: rgba(0, 0, 0, 0.2);

  /* Typography */
  --font-family-base: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-family-mono: 'Monaco', 'Courier New', monospace;

  --font-size-xs: 0.75rem;    /* 12px */
  --font-size-sm: 0.875rem;   /* 14px */
  --font-size-base: 1rem;     /* 16px */
  --font-size-lg: 1.125rem;   /* 18px */
  --font-size-xl: 1.25rem;    /* 20px */
  --font-size-2xl: 1.5rem;    /* 24px */
  --font-size-3xl: 1.875rem;  /* 30px */

  --font-weight-light: 300;
  --font-weight-normal: 400;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;

  /* Spacing */
  --space-xs: 0.25rem;   /* 4px */
  --space-sm: 0.5rem;    /* 8px */
  --space-md: 1rem;      /* 16px */
  --space-lg: 1.5rem;    /* 24px */
  --space-xl: 2rem;      /* 32px */
  --space-2xl: 3rem;     /* 48px */
  --space-3xl: 4rem;     /* 64px */

  /* Border radius */
  --radius-none: 0;
  --radius-sm: 0.25rem;   /* 4px */
  --radius-md: 0.5rem;    /* 8px */
  --radius-lg: 1rem;      /* 16px */
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1);

  /* Transitions */
  --transition-fast: 150ms ease-in-out;
  --transition-normal: 300ms ease-in-out;
  --transition-slow: 500ms ease-in-out;
}

/* Dark theme */
[data-theme="dark"] {
  --color-primary: #4d94ff;
  --color-primary-light: #1a3a5c;
  --color-primary-dark: #99bbff;

  --color-secondary: #adb5bd;
  --color-success: #51cf66;
  --color-danger: #ff6b6b;
  --color-warning: #ffd43b;
  --color-info: #4dabf7;

  --color-background: #1a1a1a;
  --color-surface: #2d2d2d;
  --color-border: #404040;

  --color-text-primary: #f0f0f0;
  --color-text-secondary: #adb5bd;
  --color-text-tertiary: #666666;

  --color-shadow: rgba(0, 0, 0, 0.3);
  --color-shadow-dark: rgba(0, 0, 0, 0.5);

  /* Typography same as light */
  --font-family-base: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-family-mono: 'Monaco', 'Courier New', monospace;

  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.25rem;
  --font-size-2xl: 1.5rem;
  --font-size-3xl: 1.875rem;

  --font-weight-light: 300;
  --font-weight-normal: 400;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;

  /* Spacing same as light */
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --space-2xl: 3rem;
  --space-3xl: 4rem;

  --radius-none: 0;
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 1rem;
  --radius-full: 9999px;

  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
  --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.6);

  --transition-fast: 150ms ease-in-out;
  --transition-normal: 300ms ease-in-out;
  --transition-slow: 500ms ease-in-out;
}
```

### Component Usage

Components use CSS variables, not hardcoded colors:

```css
/* src/components/Button.css */

.button {
  background-color: var(--color-primary);
  color: var(--color-background);
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  font-family: var(--font-family-base);
  font-size: var(--font-size-base);
  border: none;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.button:hover {
  background-color: var(--color-primary-dark);
}

.button-secondary {
  background-color: var(--color-secondary);
  color: var(--color-text-primary);
}

.button-secondary:hover {
  opacity: 0.9;
}
```

All existing components must support both themes — verify by using CSS variables everywhere.

### Theme Provider

Pseudocode for theme system:

```pseudocode
class ThemeProvider {
  constructor():
    this.currentTheme = 'light'
    this.listeners = []
    this.init()

  init():
    // 1. Get stored preference (user setting)
    storedPreference = this.getStoredPreference()

    // 2. Resolve actual theme
    if storedPreference == 'system':
      this.currentTheme = this.getSystemPreference()
    else if storedPreference:
      this.currentTheme = storedPreference
    else:
      this.currentTheme = THEME_DEFAULT_MODE

    // 3. Apply theme (without flash)
    this.applyTheme(this.currentTheme)

    // 4. Listen for system preference changes
    if (storedPreference == 'system' or not storedPreference):
      this.watchSystemPreference()

  getSystemPreference():
    if (window.matchMedia('(prefers-color-scheme: dark)').matches):
      return 'dark'
    return 'light'

  watchSystemPreference():
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', (event) => {
      if (this.currentTheme == 'system'):
        newTheme = event.matches ? 'dark' : 'light'
        this.applyTheme(newTheme)
        this.notifyListeners(newTheme)
    })

  setTheme(theme):
    // theme: 'light', 'dark', or 'system'
    if (theme == 'system'):
      this.currentTheme = this.getSystemPreference()
    else:
      this.currentTheme = theme

    this.savePreference(theme)
    this.applyTheme(this.currentTheme)
    this.notifyListeners(this.currentTheme)

  applyTheme(theme):
    // Add class to root element
    document.documentElement.setAttribute('data-theme', theme)

    // Update meta tag for address bar color (mobile)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor):
      metaThemeColor.content = theme == 'dark' ? '#1a1a1a' : '#ffffff'

  getStoredPreference():
    if (isAuthenticated()):
      // Load from database
      return db.user_preferences.findOne({ user_id }).theme_preference
    else:
      // Load from localStorage
      return localStorage.getItem('theme_preference') || THEME_DEFAULT_MODE

  savePreference(theme):
    if (isAuthenticated()):
      // Save to database
      db.user_preferences.update(
        { user_id: getCurrentUserId() },
        { theme_preference: theme }
      )
    else:
      // Save to localStorage
      localStorage.setItem('theme_preference', theme)

  notifyListeners(theme):
    for listener in this.listeners:
      listener(theme)

  subscribe(listener):
    this.listeners.push(listener)
    return () => { this.listeners.remove(listener) }
}
```

### No Flash on Page Load

Critical: Prevent flash of wrong theme on SSR.

Server renders HTML with theme class:

```pseudocode
// Server-side rendering
function renderHTML(request):
  user_id = request.auth?.user_id

  // Get user's theme preference
  if user_id:
    preference = db.user_preferences.findOne({ user_id })
    theme = preference?.theme_preference || THEME_DEFAULT_MODE
  else:
    theme = THEME_DEFAULT_MODE

  // Resolve actual theme
  if theme == 'system':
    // Can't detect system preference server-side reliably
    // Default to 'light', client will fix if needed
    actualTheme = 'light'
  else:
    actualTheme = theme

  // Inject theme class in HTML
  html = `
    <!DOCTYPE html>
    <html data-theme="${actualTheme}">
    <head>
      <style>
        html { display: none; }  /* Hide until theme applied */
      </style>
      <script>
        // Inline script: apply theme BEFORE rendering
        const storedTheme = localStorage.getItem('theme_preference') || '${THEME_DEFAULT_MODE}';
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        const theme = storedTheme === 'system' ? systemTheme : storedTheme;
        document.documentElement.setAttribute('data-theme', theme);
      </script>
    </head>
    <body>
      <div id="root"></div>
      <script src="/app.js"></script>
    </body>
    </html>
  `

  return html
```

This inline script runs before DOM renders, preventing flash.

### Toggle Component

UI for theme selection:

```html
<!-- Theme Toggle -->
<div class="theme-selector">
  <label for="theme-select">Theme:</label>
  <select id="theme-select" class="theme-select">
    <option value="light">Light</option>
    <option value="dark">Dark</option>
    <option value="system">System</option>
  </select>
</div>

<style>
  .theme-selector {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .theme-select {
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background-color: var(--color-surface);
    color: var(--color-text-primary);
    font-family: var(--font-family-base);
    cursor: pointer;
  }

  .theme-select:hover {
    border-color: var(--color-primary);
  }
</style>

<script>
  const select = document.getElementById('theme-select');
  const themeProvider = window.__themeProvider;  // Global instance

  // Set current value
  select.value = themeProvider.currentTheme;

  // Listen for changes
  select.addEventListener('change', (event) => {
    themeProvider.setTheme(event.target.value);
  });

  // Update select when theme changes externally
  themeProvider.subscribe((newTheme) => {
    select.value = newTheme;
  });
</script>
```

### Transition Animation

Smooth fade when toggling:

```css
/* Fade transition on theme change */
html {
  transition: background-color var(--transition-normal), color var(--transition-normal);
}

/* Also fade major containers */
body,
.app-container {
  transition: background-color var(--transition-normal), color var(--transition-normal);
}
```

### Media Query Integration

Use system preference as fallback:

```css
/* Primary: explicit theme */
[data-theme="dark"] { ... }

/* Fallback: system preference (if no data-theme set) */
@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #1a1a1a;
    /* ... dark tokens ... */
  }
}
```

### Testing Both Themes

```javascript
// Test utility for checking both themes
describe('Button component', () => {
  it('renders in light theme', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    // ...test assertions...
  });

  it('renders in dark theme', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    // ...test assertions...
  });
});
```

### Security & Gotchas

1. **localStorage XSS vulnerability**: If localStorage is compromised, attacker can set wrong theme. This is low-severity (only UI), but avoid storing secrets in localStorage.

2. **System preference privacy**: Detecting system preference reveals user's OS settings. Some privacy-focused users may want to hide this. Respect their preference.

3. **Color contrast in dark mode**: Ensure text is readable in both themes. Test with accessibility tools:
   - Light text on dark background: use `--color-text-primary` (high contrast)
   - Check WCAG AA compliance (4.5:1 ratio for body text)

4. **Image brightness in dark mode**: Some images look wrong in dark mode (white background, hard to see). Consider:
   ```css
   /* Invert images in dark mode if needed */
   [data-theme="dark"] img {
     filter: invert(0.1);  /* Slight invert to prevent glow */
   }
   ```

5. **Print style**: Dark mode backgrounds are bad for printing. Override in print media:
   ```css
   @media print {
     :root,
     [data-theme="dark"] {
       --color-background: #ffffff;
       --color-text-primary: #000000;
     }
   }
   ```

---

## 2. White-Label / Multi-Tenant Branding

Extended theming for multi-tenant or licensable products. Per-tenant configuration for app name, logo, colors, CSS, and email branding.

### Data Model

```
Tenant {
  id:                   string (UUID)
  name:                 string ("Acme Corp")
  slug:                 string ("acme", used in subdomain/URL)
  domain:               string ("acme.example.com")
  branding: {
    app_name:           string ("Acme Portal")
    app_name_short:     string ("Acme")
    favicon:            string (URL to favicon.ico)
    logo_light:         string (URL to logo for light theme)
    logo_dark:          string (URL to logo for dark theme)
    logo_height_px:     number (40)
    favicon_url:        string (URL to favicon)
    apple_touch_icon:   string (URL to apple-touch-icon.png)

    primary_color:      string (hex "#0066cc")
    primary_color_light: string (hex "#e6f0ff")
    primary_color_dark:  string (hex "#004080")
    secondary_color:    string (hex "#6c757d")
    accent_color:       string (hex "#ffc107")
    success_color:      string (hex "#28a745")
    danger_color:       string (hex "#dc3545")
    warning_color:      string (hex "#ffc107")

    custom_css:         string (CSS overrides)
    support_email:      string ("support@acme.com")
    support_url:        string ("https://acme-support.com")
    privacy_policy_url: string ("https://acme.com/privacy")
    terms_url:          string ("https://acme.com/terms")
  }

  // Email branding
  email_config: {
    from_email:         string ("noreply@acme.com")
    from_name:          string ("Acme Support")
    logo_url:           string (URL to logo)
    primary_color:      string (hex)
    footer_text:        string ("© 2025 Acme Corp")
  }

  // Login page branding
  login_config: {
    background_image:   string (URL to background)
    logo_url:           string (URL to logo)
    heading_text:       string ("Welcome to Acme Portal")
    subheading_text:    string ("Manage your account")
  }

  created_at:           datetime
  updated_at:           datetime
}
```

### Tenant Detection

```pseudocode
function detectTenant(request):
  // Option 1: Subdomain-based
  if (TENANT_DETECTION_METHOD == 'subdomain'):
    host = request.getHeader('Host')
    // host = "acme.example.com" or "example.com"

    if (host == 'example.com'):
      return getDefaultTenant()  // Public site

    subdomain = host.split('.')[0]
    // subdomain = "acme"

    tenant = db.tenants.findOne({ slug: subdomain })
    if (tenant):
      return tenant
    else:
      return notFound('Tenant not found')

  // Option 2: Config-file based
  if (TENANT_DETECTION_METHOD == 'config'):
    tenantId = request.body.tenant_id or request.query.tenant_id
    tenant = db.tenants.findOne({ id: tenantId })
    return tenant or notFound('Tenant not found')
```

### Middleware

```pseudocode
middleware tenantMiddleware(request, response, next):
  if not MULTI_TENANT_ENABLED:
    // Single-tenant mode, use default branding
    request.tenant = getDefaultTenant()
    next()
    return

  // Multi-tenant mode, detect tenant
  try:
    tenant = detectTenant(request)
    request.tenant = tenant

    // Make available to templates/handlers
    response.locals.tenant = tenant
    response.locals.branding = tenant.branding

    next()
  catch error:
    return response.status(404).send('Tenant not found')
```

### Admin API for Branding

```
GET /admin/api/tenant
  Returns current tenant's branding config

POST /admin/api/tenant/branding
  {
    app_name: string,
    primary_color: hex,
    secondary_color: hex,
    logo_light: url,
    logo_dark: url,
    custom_css: string
  }

  Response: updated branding config
```

### Pseudocode Handler

```pseudocode
endpoint POST /admin/api/tenant/branding:
  tenant_id = request.auth.tenant_id
  branding_updates = request.body

  // Validate colors
  for color in [primary_color, secondary_color, accent_color, success_color, danger_color]:
    if branding_updates[color]:
      if not isValidHexColor(branding_updates[color]):
        return 400, { error: 'Invalid color format for ' + color }

  // Validate URLs
  if branding_updates.logo_light:
    if not isValidURL(branding_updates.logo_light):
      return 400, { error: 'Invalid URL for logo_light' }

  // Update tenant branding
  tenant = db.tenants.findOne({ id: tenant_id })
  tenant.branding = { ...tenant.branding, ...branding_updates }
  tenant.updated_at = getCurrentTime()
  db.tenants.update({ id: tenant_id }, tenant)

  // Audit log
  auditLog(admin_id, 'admin', 'branding.updated', 'tenant', tenant_id, {
    changes: branding_updates
  })

  // Clear cache (if using)
  cache.invalidate('tenant:' + tenant_id)

  return 200, { branding: tenant.branding }
```

### Logo Component

Component that reads from branding config:

```html
<!-- Logo.html -->
<img
  src="<%= getCurrentTheme() == 'dark' ? tenant.branding.logo_dark : tenant.branding.logo_light %>"
  alt="<%= tenant.branding.app_name %>"
  height="<%= tenant.branding.logo_height_px %>"
  class="logo"
/>

<style>
  .logo {
    max-width: 200px;
    height: auto;
  }
</style>
```

Or React:

```jsx
export function Logo({ size = 'normal' }) {
  const { tenant } = useContext(TenantContext);
  const { isDarkMode } = useContext(ThemeContext);

  const logoUrl = isDarkMode ? tenant.branding.logo_dark : tenant.branding.logo_light;
  const height = size === 'small' ? '32px' : size === 'large' ? '64px' : '40px';

  return (
    <img
      src={logoUrl}
      alt={tenant.branding.app_name}
      height={height}
      className="logo"
    />
  );
}
```

### Email Template Branding

```html
<!-- Email template -->
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      padding: 20px;
      margin: 20px auto;
      max-width: 600px;
      border-radius: 8px;
    }
    .logo {
      height: 40px;
      margin-bottom: 20px;
    }
    .primary-btn {
      background-color: <%= tenant.email_config.primary_color %>;
      color: white;
      padding: 10px 20px;
      border-radius: 4px;
      text-decoration: none;
    }
    .footer {
      border-top: 1px solid #ddd;
      margin-top: 20px;
      padding-top: 20px;
      font-size: 12px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="<%= tenant.email_config.logo_url %>" alt="<%= tenant.branding.app_name %>" class="logo" />

    <h1>Welcome to <%= tenant.branding.app_name %>!</h1>
    <p>Hello {{ user_name }},</p>

    <p>You've been invited to join our platform.</p>

    <a href="{{ invite_link }}" class="primary-btn">Accept Invitation</a>

    <div class="footer">
      <p><%= tenant.email_config.footer_text %></p>
      <p>
        <a href="<%= tenant.branding.support_url %>">Support</a> |
        <a href="<%= tenant.branding.privacy_policy_url %>">Privacy</a> |
        <a href="<%= tenant.branding.terms_url %>">Terms</a>
      </p>
    </div>
  </div>
</body>
</html>
```

### Login Page Branding

```html
<!-- Login page -->
<div class="login-container" style="background-image: url('<%= tenant.login_config.background_image %>')">
  <div class="login-box">
    <img src="<%= tenant.login_config.logo_url %>" alt="<%= tenant.branding.app_name %>" />

    <h1><%= tenant.login_config.heading_text %></h1>
    <p><%= tenant.login_config.subheading_text %></p>

    <form>
      <input type="email" placeholder="Email" required />
      <input type="password" placeholder="Password" required />
      <button type="submit" style="background-color: <%= tenant.branding.primary_color %>">
        Sign In
      </button>
    </form>

    <div class="footer">
      <a href="<%= tenant.branding.privacy_policy_url %>">Privacy</a> |
      <a href="<%= tenant.branding.terms_url %>">Terms</a>
    </div>
  </div>
</div>

<style>
  .login-container {
    background-size: cover;
    background-position: center;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }

  .login-box {
    background-color: white;
    padding: 40px;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    max-width: 400px;
    width: 90%;
  }

  .login-box img {
    height: 50px;
    margin-bottom: 20px;
    display: block;
  }

  .login-box button {
    width: 100%;
    padding: 12px;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    margin-top: 20px;
  }

  .login-box button:hover {
    opacity: 0.9;
  }
</style>
```

### CSS Overrides

Allow tenants to inject custom CSS:

```pseudocode
function applyCustomCSS(tenant):
  if (tenant.branding.custom_css):
    styleEl = document.createElement('style')
    styleEl.textContent = tenant.branding.custom_css
    styleEl.setAttribute('data-tenant', tenant.id)
    document.head.appendChild(styleEl)
```

The custom CSS can override any built-in styles:

```css
/* Example custom CSS from tenant */
:root {
  --color-primary: #ff6600;
  --color-secondary: #0066cc;
}

.app-header {
  border-bottom: 3px solid var(--color-primary);
}

.button-primary {
  background-color: var(--color-primary);
  border-radius: 20px;  /* More rounded */
}
```

### Build-Time vs Runtime Branding

Single-tenant (build-time):
```pseudocode
// Build process
tenant = getTenantConfig()  // Read from config file
branding = tenant.branding

// Inline branding into built app
for file in buildFiles:
  content = file.content
  content = content.replace(/{{ APP_NAME }}/g, branding.app_name)
  content = content.replace(/{{ PRIMARY_COLOR }}/g, branding.primary_color)
  file.write(content)
```

Multi-tenant (runtime):
```pseudocode
// Every request, inject tenant data
function renderHTML(request):
  tenant = request.tenant
  branding = tenant.branding

  html = template.render({
    app_name: branding.app_name,
    logo_url: branding.logo_light,
    primary_color: branding.primary_color,
    custom_css: branding.custom_css
  })

  return html
```

### Configuration

```env
# White-label branding
MULTI_TENANT_ENABLED=true
TENANT_DETECTION_METHOD=subdomain  # or 'config'
TENANT_CACHE_TTL_SECONDS=3600
BRANDING_CUSTOM_CSS_MAX_SIZE_BYTES=50000

# Default tenant (fallback)
DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000000
DEFAULT_TENANT_SLUG=default
```

### Security & Gotchas

1. **CSS injection**: Custom CSS can break layout or cause XSS. Sanitize:
   ```pseudocode
   function validateCustomCSS(css_string):
     // Block dangerous selectors/properties
     dangerous_patterns = [
       '@import',  // Can load external resources
       'expression(',  // IE eval
       'javascript:',  // JS protocol
       'behavior:',  // IE behaviors
     ]

     for pattern in dangerous_patterns:
       if css_string.contains(pattern):
         throw Error('Forbidden CSS pattern: ' + pattern)

     return true
   ```

2. **Logo URL injection**: Validate logo URLs are from trusted CDN:
   ```pseudocode
   function validateLogoURL(url):
     if not url.startsWith(CDN_BASE_URL):
       return false
     return true
   ```

3. **Color format validation**: Ensure colors are valid hex:
   ```pseudocode
   function isValidHexColor(color):
     return /^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(color)
   ```

4. **Subdomain squatting**: In multi-tenant, prevent admins from claiming domains that conflict:
   ```pseudocode
   reserved_slugs = ['admin', 'api', 'www', 'mail', 'example', 'test']

   function isReservedSlug(slug):
     return reserved_slugs.includes(slug)
   ```

5. **Cache invalidation**: When branding changes, clear all caches:
   ```pseudocode
   function updateBranding(tenant_id, branding):
     // Update DB
     db.tenants.update({ id: tenant_id }, { branding })

     // Clear caches
     cache.invalidate('tenant:' + tenant_id)
     cache.invalidate('branding:' + tenant_id)

     // If tenant has many users, also consider:
     // - CDN cache purge for affected URLs
     // - User sessions: consider logout to refresh branding
   ```

6. **Email sender verification**: When changing email branding, verify the new sender address is valid:
   ```pseudocode
   function updateEmailConfig(tenant_id, email_config):
     // Verify DKIM/SPF for from_email
     if not verifyEmailSender(email_config.from_email):
       return 400, { error: 'Email sender not verified' }

     db.tenants.update({ id: tenant_id }, { email_config })
   ```

