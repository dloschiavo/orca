---
name: App Configuration & Theming
description: App manifest/config system and theme engine (colors, typography, spacing) with per-app overrides
type: project
---

# App Configuration & Theming

## Overview

Every app built from the kit needs a way to be configured: branding, colors, fonts, which features are enabled, logo paths. Rather than baking these decisions into code across multiple files, we centralize them in a single **app.config** file that becomes the source of truth. The config system includes a **theme engine** that provides design tokens (colors, typography, spacing) that are available everywhere—components, pages, emails, native config.

The key insight: one **app.config** file per app, one **theme system** inherited by all apps, per-app overrides when needed.

---

## App Config Schema

The app.config file (YAML or JSON) contains the complete manifest for an app. It is validated at startup and read at both build time and runtime.

### Full Schema Definition

```yaml
# app.config.yaml — ALL fields, types, defaults

app:
  name: string                    # Required. Display name: "Acme Portal"
  bundleId: string                # Required. Reverse-domain: "com.acme.portal"
  appId: string                   # Required. Slug for internal use: "acme-portal"
  domain: string                  # Required. Primary domain: "portal.acme.com"
  description: string             # Optional. Short description for app store/info
  version: string                 # Required. Semantic version: "1.0.0"

assets:
  logo:
    light: string                 # Path to light-mode logo (SVG or PNG). Relative to /assets/logos
    dark: string                  # Path to dark-mode logo (SVG or PNG). Optional if light suffices.
    favicon: string               # Path to favicon.ico or favicon.svg
    appleTouchIcon: string        # Path to apple-touch-icon.png for iOS home screen
    ogImage: string               # Path to og:image for social sharing (1200x630px recommended)
  splash:
    light: string                 # Path to splash screen for native apps (light mode)
    dark: string                  # Path to splash screen for native apps (dark mode)
    backgroundColor: string       # Fallback color during app launch (hex or token ref)

theme:
  extends: string                 # Which base theme to inherit: "light", "dark", or default theme name
  # Color overrides
  colors:
    primary: string               # Hex or semantic ref to base theme token
    secondary: string
    success: string
    danger: string
    warning: string
    info: string
    background: string
    surface: string
    textPrimary: string
    textSecondary: string
    textTertiary: string
    # Any semantic color token from theme system can be overridden
  # Typography overrides
  typography:
    fontFamilyBase: string        # Font family name: "Inter", "Roboto", etc.
    fontFamilyMono: string        # Monospace font family
    # Font size scale overrides (xs, sm, base, lg, xl, 2xl, 3xl, 4xl, 5xl, 6xl)
    # Font weight scale overrides (light: 300, normal: 400, semibold: 600, bold: 700)
    # Line height overrides (tight: 1.2, normal: 1.5, relaxed: 1.75)
  # Spacing scale overrides (xs, sm, md, lg, xl, 2xl, 3xl)
  spacing:
    xs: string                    # e.g., "0.25rem" or "4px"
    sm: string
    md: string
    lg: string
    xl: string
    2xl: string
    3xl: string
  # Border radius overrides (none, sm, md, lg, full)
  radii:
    none: string
    sm: string
    md: string
    lg: string
    full: string
  # Shadow/elevation overrides (sm, md, lg, xl)
  shadows:
    sm: string                    # e.g., "0 1px 2px 0 rgba(0,0,0,0.05)"
    md: string
    lg: string
    xl: string

features:
  # Feature toggles control which kit features are enabled for this app
  billing:
    enabled: boolean              # Default: true. Enables billing/payment features
  onboarding:
    enabled: boolean              # Default: true. Enables onboarding flow
  documentation:
    enabled: boolean              # Default: true. Shows documentation/help links
  faq:
    enabled: boolean              # Default: false. Shows FAQ page
  support:
    enabled: boolean              # Default: true. Shows support/contact links
  analytics:
    enabled: boolean              # Default: true. Enables analytics tracking
  darkMode:
    enabled: boolean              # Default: false. Toggle for dark mode UI
  # Custom features (app-specific toggles)
  customFeature:
    enabled: boolean

# Runtime configuration
runtime:
  environment: string             # "development", "staging", "production"
  logLevel: string                # "debug", "info", "warn", "error"
  apiBaseUrl: string              # Base URL for API calls (can differ from domain)

  # Feature flag overrides (can override top-level features per environment)
  featureOverrides: {}            # e.g., { billing.enabled: false }

# Build-time configuration
build:
  outputFormat: string            # "web", "native-ios", "native-android", "web-and-native"
  nativeConfig:
    displayName: string           # iOS/Android display name
    packageName: string           # Android package name (usually same as bundleId)
    versionCode: integer          # Android internal version number
    minSdkVersion: integer        # Android minimum SDK version
    iosMinVersion: string         # iOS minimum version, e.g., "13.0"
  cssNamespace: string            # CSS class prefix to avoid collisions, e.g., "acme-"
  sourceMaps: boolean             # Include source maps in build

# Localization
i18n:
  defaultLocale: string           # e.g., "en-US"
  supportedLocales:
    - string                      # List of supported locales
  translationPath: string         # Path to translation files relative to source root
```

### Defaults

If a field is not specified in app.config, the kit provides a default:
- Theme inherits from the kit's **base theme** (defined once, reused by all apps)
- Feature toggles default to `true` unless explicitly set to `false`
- Runtime environment defaults to `"production"`
- Build output format defaults to `"web"`

---

## Theme Token System

The theme system provides a set of **tokens** that represent design decisions. Tokens have semantic names (not palette names) and resolve to concrete values.

### Theme Tokens (Base Theme — The Kit's Defaults)

#### Colors

All colors use semantic naming. Each app inherits these; overrides replace specific tokens.

```
Primary colors:
  primary: #0066CC             (brand primary, buttons, links)
  primary-hover: #0052A3       (darken on hover)
  primary-active: #003D7A      (darken on active/press)
  primary-disabled: #B3D9F2    (lighten when disabled)

Secondary colors:
  secondary: #6B7280           (alternate accent color)
  secondary-hover: #4B5563
  secondary-active: #2D3142

Semantic colors (signal & feedback):
  success: #10B981             (positive action, validation pass)
  success-hover: #059669
  danger: #EF4444              (destructive action, errors)
  danger-hover: #DC2626
  warning: #F59E0B             (caution, non-critical alerts)
  warning-hover: #D97706
  info: #3B82F6                (informational, neutral alerts)
  info-hover: #2563EB

Neutral colors (backgrounds & text):
  background: #FFFFFF          (page/app background)
  surface: #F9FAFB             (cards, panels, elevated surfaces)
  surface-secondary: #F3F4F6   (secondary surfaces, unused by default)
  border: #E5E7EB              (dividers, borders, outlines)

  text-primary: #111827         (main text, high contrast)
  text-secondary: #6B7280       (secondary text, lower contrast)
  text-tertiary: #9CA3AF        (tertiary text, lowest contrast)
  text-inverse: #FFFFFF         (text on dark/colored backgrounds)
```

#### Typography

Semantic font scale (rem-based, 16px = 1rem):

```
Font families:
  fontFamilyBase: "Inter"       (sans-serif, body and headers)
  fontFamilyMono: "Inconsolata" (monospace, code blocks)

Font sizes (scale):
  xs:  0.75rem   (12px)         (tiny labels, captions)
  sm:  0.875rem  (14px)         (small text, helper text)
  base: 1rem     (16px)         (body text, default)
  lg:  1.125rem  (18px)         (slightly large)
  xl:  1.25rem   (20px)         (larger, subheadings)
  2xl: 1.5rem    (24px)         (h4, larger subheadings)
  3xl: 1.875rem  (30px)         (h3, section headers)
  4xl: 2.25rem   (36px)         (h2, page headers)
  5xl: 3rem      (48px)         (h1, major headers)
  6xl: 3.75rem   (60px)         (massive, hero headers)

Font weights:
  light: 300                    (de-emphasized text)
  normal: 400                   (body text)
  semibold: 600                 (emphasis, labels)
  bold: 700                     (strong emphasis, headers)

Line heights:
  tight: 1.2                    (condensed, headlines)
  normal: 1.5                   (body text)
  relaxed: 1.75                 (open, accessibility)
```

#### Spacing

Semantic spacing scale (rem-based, incremental):

```
xs:  0.25rem   (4px)
sm:  0.5rem    (8px)
md:  1rem      (16px)
lg:  1.5rem    (24px)
xl:  2rem      (32px)
2xl: 3rem      (48px)
3xl: 4rem      (64px)
```

Usage: padding, margin, gaps. E.g., padding: `md sm` (16px vertical, 8px horizontal).

#### Border Radius

```
none:  0px
sm:    0.25rem  (4px)    — subtle rounding
md:    0.5rem   (8px)    — standard rounding
lg:    1rem     (16px)   — more rounded
full:  9999px            — pill/circle shapes
```

#### Shadows (Elevation)

```
sm:   0 1px 2px 0 rgba(0, 0, 0, 0.05)        (subtle, cards)
md:   0 4px 6px -1px rgba(0, 0, 0, 0.1),     (standard, dialogs)
      0 2px 4px -1px rgba(0, 0, 0, 0.06)
lg:   0 10px 15px -3px rgba(0, 0, 0, 0.1),   (pronounced, overlays)
      0 4px 6px -2px rgba(0, 0, 0, 0.05)
xl:   0 20px 25px -5px rgba(0, 0, 0, 0.1),   (strong, modals)
      0 10px 10px -5px rgba(0, 0, 0, 0.04)
```

---

## Theme Override Mechanism

When an app specifies theme overrides in app.config, those overrides are **merged with the base theme** at initialization time.

### Merge Strategy

```
1. Start with kit's base theme (all tokens defined)
2. Apply per-app overrides from app.config > theme section
3. Result: complete resolved theme available everywhere

Example:
  Base theme has:   primary: #0066CC
  App overrides:    primary: #FF6B35  (custom brand color)
  Resolved:         primary: #FF6B35  (override wins)

  Base has:         success: #10B981  (not overridden)
  Resolved:         success: #10B981  (unchanged)
```

### No Inheritance Between Apps

Each app starts fresh with base theme + its own overrides. Apps do not inherit theme tokens from each other.

---

## Theme Consumption

Components and pages access theme tokens via a **theme provider** pattern. The specific implementation depends on your framework (CSS-in-JS, CSS vars, etc.), but the pattern is consistent.

### Pseudocode: Theme Provider (Context/Runtime)

```
# At app startup, load app.config and resolve theme
theme = loadAppConfig()        # Returns { colors, typography, spacing, ... }
themeProvider = createTheme(theme)

# Wrap your app with theme provider
<ThemeProvider value={themeProvider}>
  <App />
</ThemeProvider>
```

### Pseudocode: Component Access

Components consume theme tokens from context/provider:

```
# Style a button component
Button:
  background = getThemeToken("colors.primary")
  padding = getThemeToken("spacing.md")
  fontSize = getThemeToken("typography.base")
  borderRadius = getThemeToken("radii.md")

  # If dark mode is enabled and active
  IF theme.isDarkMode():
    background = getThemeToken("colors.primary-dark-mode")  # See: Dark Mode Preparation

# Reference theme in inline styles
<button style={
  backgroundColor: theme.colors.primary,
  padding: `${theme.spacing.md} ${theme.spacing.lg}`,
  borderRadius: theme.radii.md,
  fontSize: theme.typography.base
}>
  Click me
</button>

# Or use theme-aware component library
<Button variant="primary" size="md" />
# Button component internally:
#   background = theme.colors.primary
#   padding = theme.spacing[size]
```

### Pseudocode: SSR/Email Rendering

Theme is available during server-side rendering and email template rendering:

```
# On server, when rendering HTML
theme = loadAppConfig()  # Same as client
htmlString = renderComponent(<Page />, { theme })

# Email template can reference theme
<EmailTemplate>
  <Button style={
    backgroundColor: theme.colors.primary,
    padding: theme.spacing.md
  }>
    Verify Email
  </Button>
</EmailTemplate>

# Result: emails are themed consistently with app
```

---

## Feature Toggles

Feature toggles are boolean flags in app.config that control which kit features are enabled for a specific app. They influence:
- Route registration (disabled routes are not available)
- Navigation menus (disabled features don't appear)
- Component rendering (disabled features are not rendered, reducing bundle size)

### Feature Toggle List

```
billing:          Enable/disable billing, payments, subscription management
onboarding:       Enable/disable new user onboarding flow
documentation:    Enable/disable documentation links and help
faq:              Enable/disable FAQ page and FAQ navigation
support:          Enable/disable support/contact features
analytics:        Enable/disable analytics event tracking
darkMode:         Enable/disable dark mode toggle in UI
[customFeature]:  App-specific toggles
```

### Pseudocode: Using Feature Toggles

```
# In routing setup
IF isFeatureEnabled("billing"):
  registerRoute("/billing", BillingPage)
  registerRoute("/invoices", InvoicesPage)

# In navigation menu
navItems = [
  { label: "Dashboard", href: "/" },
  { label: "Docs", href: "/docs", visible: isFeatureEnabled("documentation") },
  { label: "FAQ", href: "/faq", visible: isFeatureEnabled("faq") },
  { label: "Support", href: "/support", visible: isFeatureEnabled("support") },
]

# In component rendering
IF isFeatureEnabled("darkMode"):
  <ThemeToggle />  # Show dark/light mode switcher

# In analytics
IF isFeatureEnabled("analytics"):
  trackEvent("user_signup", { /* data */ })

# In feature-specific code
IF NOT isFeatureEnabled("billing"):
  SKIP billing initialization
  EXCLUDE billing components from build
```

### Feature Overrides by Environment

```yaml
# Base config
features:
  billing:
    enabled: true
  faq:
    enabled: false

# Runtime overrides (e.g., staging disables billing for testing)
runtime:
  environment: staging
  featureOverrides:
    billing.enabled: false  # Disabled in staging only
    faq.enabled: true       # Enabled in staging for testing
```

At runtime, overrides are merged: if a feature override exists for the current environment, it takes precedence.

---

## Logo and Branding Assets

Logos and branding assets are referenced in app.config and served from a consistent location.

### Directory Structure

```
/assets
  /logos
    /light
      logo-app-name.svg
      logo-app-name.png
    /dark
      logo-app-name.svg
      logo-app-name.png
    favicon.ico
    favicon.svg
    apple-touch-icon.png
  /splash
    splash-light.png
    splash-dark.png
  /social
    og-image.png
```

### Asset Naming Convention

- **Light mode logo**: `logo-{appId}.svg` or `logo-{appId}.png`
- **Dark mode logo**: `logo-{appId}-dark.svg` or `logo-{appId}-dark.png`
- **Favicon**: `favicon.ico` or `favicon.svg` (one per app, symlinked or duplicated)
- **Apple touch icon**: `apple-touch-icon.png` (180x180px)
- **OG image**: `og-image-{appId}.png` (1200x630px)
- **Splash screens**: `splash-light.png`, `splash-dark.png` (native app sizes vary)

### App Config Reference

```yaml
assets:
  logo:
    light: "light/logo-acme-portal.svg"
    dark: "dark/logo-acme-portal-dark.svg"
    favicon: "favicon.svg"
    appleTouchIcon: "apple-touch-icon.png"
    ogImage: "social/og-image-acme-portal.png"
  splash:
    light: "splash-light.png"
    dark: "splash-dark.png"
    backgroundColor: "#FFFFFF"
```

### Path Resolution

- Paths in app.config are relative to the `/assets` directory
- At build time, resolve paths to absolute URLs (for web) or file paths (for native)
- At runtime, serve assets from a CDN or static file server
- Test on native platforms (iOS, Android) to ensure splash screens display correctly

### Required Sizes (Web)

- **Favicon**: 32x32px (SVG preferred for scalability)
- **Apple touch icon**: 180x180px (PNG)
- **OG image**: 1200x630px (PNG or JPG)
- **Logo (light)**: 200-500px wide SVG (scalable)
- **Logo (dark)**: Same as light
- **Splash (native)**: Platform-specific (iOS: 1242x2208 for iPhone X; Android: 1080x1920 for mdpi)

---

## Build-Time vs Runtime Config

Some parts of app.config are read at **build time** (to generate native app packages, set bundle IDs, etc.), while others are read at **runtime** (to toggle features, apply theme overrides).

### Build-Time Config

```
app.name                (used in iOS app name, Android display name)
app.bundleId            (iOS Bundle Identifier)
app.version             (native app version)
assets.logo             (bundled with native app, referenced in app.json)
assets.splash           (bundled with native app)
build.outputFormat      (determines which platform configs are generated)
build.nativeConfig      (iOS/Android specific settings)

These are read once at build time and embedded in the build output.
Changing these requires a rebuild.
```

### Runtime Config

```
features.*              (read at app startup, can be toggled)
theme                   (read at app startup, applied to UI)
runtime.environment     (read at startup)
runtime.logLevel        (read at startup)
runtime.apiBaseUrl      (read at startup)
runtime.featureOverrides (read at startup)
i18n                    (read at startup for locale setup)

These are read at app startup and can be changed via environment
variables, config server, or feature flag service without rebuilding.
```

### Pseudocode: Config Loading

```
# Build time
func generateNativeBuild(appConfig):
  bundleId = appConfig.app.bundleId
  appName = appConfig.app.name
  logoPath = resolveAssetPath(appConfig.assets.logo.light)
  splashPath = resolveAssetPath(appConfig.assets.splash.light)

  # Generate iOS/Android config files with these values
  writeIOSConfig(bundleId, appName, logoPath, splashPath)
  writeAndroidConfig(bundleId, appName, logoPath, splashPath)

  # Embed app.config in the built app for runtime use
  embedInBuild(appConfig)

# Runtime (on app startup)
func initializeApp():
  appConfig = loadAppConfig()  # From bundled file or config server

  # Apply runtime config
  theme = resolveTheme(appConfig.theme)
  features = resolveFeatures(appConfig.features, appConfig.runtime.featureOverrides)
  locale = appConfig.i18n.defaultLocale
  logLevel = appConfig.runtime.logLevel

  # Make available to app
  setGlobalConfig(appConfig)
  setGlobalTheme(theme)
  setGlobalFeatures(features)
```

---

## Dark Mode Preparation

Dark mode is not (yet) required, but the token structure must be **ready for it** without restructuring later.

### Token Structure for Light/Dark Support

Rather than storing tokens as `{ "color-primary": "#0066CC" }`, which requires renaming for dark mode, structure them to support mode variants:

```
# Each color token can have a light and dark variant
colors:
  primary:
    light: "#0066CC"      (when in light mode)
    dark: "#5B9EFF"       (when in dark mode)

  success:
    light: "#10B981"
    dark: "#6EE7B7"

  background:
    light: "#FFFFFF"
    dark: "#1F2937"

  textPrimary:
    light: "#111827"
    dark: "#F3F4F6"

# Or use a flatter structure with mode inference
colors:
  primary-light: "#0066CC"
  primary-dark: "#5B9EFF"
  background-light: "#FFFFFF"
  background-dark: "#1F2937"
```

### Resolution at Runtime

```
# When resolving a color token at runtime
func getColorToken(tokenName):
  currentMode = getCurrentMode()  # "light" or "dark"

  IF variant structure:
    return tokens.colors[tokenName][currentMode]

  IF suffixed structure:
    return tokens.colors[tokenName + "-" + currentMode]

# Example
getColorToken("primary")  # returns "#0066CC" (light) or "#5B9EFF" (dark)
```

### Per-App Dark Mode Overrides

Apps can override dark mode colors in app.config:

```yaml
theme:
  colors:
    primary:
      light: "#FF6B35"    # Custom light primary
      dark: "#FF9066"     # Custom dark primary
```

### Migration Path

If dark mode is added later:
1. No token restructuring needed — your naming is already ready
2. Add a `darkMode.enabled` feature toggle
3. Add dark variants to the base theme
4. Let apps override dark variants in app.config
5. Toggle dark mode via theme context

---

## Validation

App.config is validated at startup to catch misconfigurations early.

### Validation Rules

```
REQUIRED fields (fail startup if missing):
  app.name
  app.bundleId
  app.appId
  app.domain
  app.version
  assets.logo.light
  assets.logo.favicon

TYPE validation:
  app.version must match semantic versioning (X.Y.Z)
  bundleId must match reverse-domain format (com.company.app)
  appId must be lowercase alphanumeric + hyphens
  domain must be a valid FQDN
  colors must be valid hex colors or token references
  spacing must be valid CSS values (rem, px, etc.)
  boolean fields must be true or false

REFERENCE validation:
  logo.light asset must exist
  logo.dark asset must exist (if specified)
  favicon must exist
  ogImage must exist (if specified)
  splash assets must exist (for native builds)

SEMANTIC validation:
  Feature toggle names must be recognized (billing, onboarding, etc.)
  Theme overrides must reference valid tokens
  i18n locales must be valid BCP 47 tags (en-US, fr-FR, etc.)
  logLevel must be one of: debug, info, warn, error
  environment must be one of: development, staging, production

Validation result:
  IF all checks pass:
    App initializes successfully
  IF any check fails:
    Log validation error with details
    Exit with non-zero code
    DO NOT start app with invalid config
```

### Validation Timing

- **Build time**: Validate presence of required assets, version format, bundle ID format
- **Startup time**: Validate all fields, type checking, reference checking, semantic validation
- **Dev mode**: Verbose error messages with suggestions for fixes
- **Prod mode**: Log errors, fail fast

---

## Example app.config File

Here's a complete example for a fictional SaaS app called "Acme Portal":

```yaml
# app.config.yaml — Acme Portal

app:
  name: "Acme Portal"
  bundleId: "com.acme.portal"
  appId: "acme-portal"
  domain: "portal.acme.com"
  description: "Customer dashboard for Acme services"
  version: "1.2.0"

assets:
  logo:
    light: "light/logo-acme-portal.svg"
    dark: "dark/logo-acme-portal-dark.svg"
    favicon: "favicon.svg"
    appleTouchIcon: "apple-touch-icon.png"
    ogImage: "social/og-image-acme-portal.png"
  splash:
    light: "splash-light.png"
    dark: "splash-dark.png"
    backgroundColor: "#FFFFFF"

theme:
  extends: "light"
  colors:
    primary: "#FF6B35"           # Acme brand orange
    secondary: "#004E89"         # Acme brand navy
    success: "#06D6A0"
    danger: "#EF476F"
    warning: "#FFD166"
    info: "#118AB2"
    background: "#FFFFFF"
    surface: "#F8F9FA"
    textPrimary: "#222222"
    textSecondary: "#666666"
    textTertiary: "#999999"
  typography:
    fontFamilyBase: "Inter"
    fontFamilyMono: "Inconsolata"
  spacing:
    xs: "0.25rem"
    sm: "0.5rem"
    md: "1rem"
    lg: "1.5rem"
    xl: "2rem"
    2xl: "3rem"
    3xl: "4rem"
  radii:
    none: "0px"
    sm: "0.25rem"
    md: "0.5rem"
    lg: "1rem"
    full: "9999px"

features:
  billing:
    enabled: true
  onboarding:
    enabled: true
  documentation:
    enabled: true
  faq:
    enabled: true
  support:
    enabled: true
  analytics:
    enabled: true
  darkMode:
    enabled: false

runtime:
  environment: "production"
  logLevel: "info"
  apiBaseUrl: "https://api.acme.com"
  featureOverrides: {}

build:
  outputFormat: "web-and-native"
  nativeConfig:
    displayName: "Acme Portal"
    packageName: "com.acme.portal"
    versionCode: 120
    minSdkVersion: 21
    iosMinVersion: "13.0"
  cssNamespace: "acme-"
  sourceMaps: false

i18n:
  defaultLocale: "en-US"
  supportedLocales:
    - "en-US"
    - "es-ES"
    - "fr-FR"
    - "de-DE"
  translationPath: "src/i18n"
```

---

## Gotchas

Common pitfalls and how to avoid them.

### 1. Theme Token Naming Collisions with CSS

**Problem**: If theme tokens have names like `primary` and your CSS selectors also use `primary`, you can get naming collisions in CSS-in-JS or global scopes.

**Solution**:
- Use a **CSS namespace** (configured in `build.cssNamespace`, e.g., `"acme-"`)
- Prefix all generated CSS class names: `.acme-primary`, `.acme-btn-primary`
- Use BEM or similar naming conventions for your own CSS to avoid conflicts
- If using CSS variables, prefix them: `--acme-primary`, `--acme-spacing-md`

### 2. SSR Theme Hydration Mismatch

**Problem**: On the server, you render HTML with one theme; on the client, the theme loads differently, causing hydration mismatch and flash of unstyled content.

**Solution**:
- Load app.config **before rendering** on both server and client
- Serialize the resolved theme to a script tag in HTML
- On client, hydrate from the serialized theme, not from a fresh load
- Ensure theme loading is synchronous on startup (not async), so it's ready before first render

```
# Server
theme = loadAndResolveAppConfig()
html = renderApp(theme)
html += <script>window.__THEME__ = ${JSON.stringify(theme)}</script>

# Client
theme = window.__THEME__ || loadAndResolveAppConfig()
renderApp(theme)  # Now server and client agree on theme
```

### 3. Feature Toggle Race Conditions

**Problem**: If features are toggled dynamically (via a config server), routes might be registered/unregistered mid-flight, causing users to hit 404s or see inconsistent navigation.

**Solution**:
- Load feature toggles **once at startup**, before routing is set up
- Do not re-load feature toggles at runtime unless you can guarantee:
  - No active users are navigating
  - Routing is not mid-render
- If you need dynamic feature toggles, use a flag service (e.g., LaunchDarkly) that handles consistency
- In development, warn if feature toggles change; in production, only allow changes on deploy

### 4. Image Path Resolution Across Platforms

**Problem**: Asset paths in app.config (e.g., `"light/logo-acme-portal.svg"`) need to resolve differently on web vs native:
- **Web**: URLs (`/assets/logos/light/logo-acme-portal.svg` or CDN URL)
- **Native iOS**: File paths or bundled resources
- **Native Android**: Asset references

**Solution**:
- Store relative paths in app.config
- At build time, **resolve paths to the correct format for the platform**:
  ```
  Web:   /assets/logos/{path}
         or https://cdn.acme.com/assets/logos/{path}
  iOS:   file:///.../{bundlePath}/Assets.xcassets/{assetName}
  Android: content://com.acme.portal.assets/logos/{path}
  ```
- Create a helper function to get the correct path:
  ```
  getAssetPath(relativeLogosPath):
    IF platform == "web":
      return "/assets/logos/" + relativeLogosPath
    ELSE IF platform == "ios":
      return iOSAssetPath(relativeLogosPath)
    ELSE IF platform == "android":
      return androidAssetPath(relativeLogosPath)
  ```

### 5. Per-App Theme Overrides Falling Back to Base Theme

**Problem**: An app specifies a partial theme override (e.g., only `primary` color), but forgets to check that all other tokens exist. If a component tries to access a token that was not overridden and is not in the base theme, it fails.

**Solution**:
- The merge always starts with the base theme; missing tokens are **not an error**
- Ensure the base theme is **complete** — every token has a value
- Document the full set of tokens so apps know what they can override
- In validation, check that overridden tokens reference existing base tokens

### 6. Dark Mode Token Duplication Overhead

**Problem**: If every color token has a light and dark variant, the token set doubles in size, adding bloat.

**Solution**:
- For neutral colors (backgrounds, text) and semantic colors (success, danger), define light/dark variants
- For accent colors, only define variants if they look significantly different in dark mode
- Use CSS filters or opacity adjustments for slight variations instead of separate tokens
- Document which tokens actually change in dark mode vs which don't (e.g., `secondary` might not change)

### 7. Feature Toggle Naming Conventions

**Problem**: Apps use feature toggle names like `billing`, `billing-ui`, `BILLING`, `billing-feature`, making them inconsistent and hard to remember.

**Solution**:
- Define an exhaustive list of recognized feature toggles in the kit docs
- Use **lowercase, hyphenated names**: `billing`, `onboarding`, `dark-mode`, `advanced-analytics`
- Do not allow arbitrary custom toggles; define custom toggles upfront or add them to the base kit
- Validate toggle names at startup and warn/fail if unknown toggles are used

### 8. Asset Path Typos

**Problem**: An app specifies `assets.logo.light: "logos/light/acme.svg"` but the actual file is at `"light/acme-logo.svg"`, causing 404s at build time.

**Solution**:
- Validate all asset paths at build time
- Run a check: `for each path in app.config, verify file exists`
- In dev mode, fail with a clear error message pointing to the missing file
- In CI/CD, add a pre-build step that validates all assets before bundling

### 9. Theme Context Leaking Across App Instances

**Problem**: If your test suite or multi-tenant system runs multiple app instances, and theme is stored globally, one app's theme can leak into another's.

**Solution**:
- **Never use global variables** for theme; always use context/provider
- Pass theme as a parameter or via context, never as a module-level export
- In tests, wrap each app instance with its own ThemeProvider
- In multi-tenant systems, ensure each request/session loads its own app.config and theme

### 10. Feature Toggle Conditional Code Elimination

**Problem**: You write `IF isFeatureEnabled("billing")` in your code, but the `billing` code is still bundled, increasing bundle size.

**Solution**:
- Use a **build-time variable** or constant for feature toggles
- Build tools can tree-shake dead code if the conditional is known at build time:
  ```
  // At build time, BILLING_ENABLED = true or false
  if (BILLING_ENABLED) {
    // This code is eliminated if BILLING_ENABLED is false
    import BillingModule from './billing'
  }
  ```
- Use a build plugin to replace feature toggle checks with constants before tree-shaking
- For runtime toggles (feature flag service), accept that code is bundled but not executed

---

## Summary: The Single Source of Truth

Every app built from the kit has a **single app.config file** that defines:
1. **App identity**: name, bundle ID, domain, version
2. **Branding assets**: logos, splash screens, icons
3. **Theme overrides**: colors, typography, spacing — merged with the kit's base theme
4. **Feature toggles**: which kit features are enabled for this app
5. **Runtime config**: environment, API base URL, locale, feature overrides
6. **Build config**: output format, native settings, CSS namespace

Edit **one file**, and your app is branded, themed, and configured. No scattered config across multiple files, no hardcoded theme values, no prop-drilling theme to components. The theme system is available everywhere (components, SSR, emails), and the feature toggles control what's available without code changes.

The base theme provides sensible defaults; every app inherits them and overrides what it needs. Dark mode is ready (tokens are structured to support light/dark); apps can opt in when ready.
