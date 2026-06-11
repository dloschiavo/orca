---
name: SEO & Marketing Page Templates
description: Reusable page scaffolds for landing, pricing, and FAQ pages with SEO-optimized structure
type: project
---

# SEO & Marketing Page Templates

Reusable, stack-agnostic page templates for common marketing surfaces: landing, pricing, and FAQ. All templates prioritize server-side rendering for SEO, semantic HTML, and content injection via config files.

## Overview

These templates provide layout scaffolds only—no hardcoded copy, no framework-specific code. Content is injected from a per-app configuration file, enabling template reuse across multiple products while maintaining SEO best practices.

### Core Principles

1. **Server-Side Rendering (SSR)**: All pages render on the server to produce valid semantic HTML with proper heading hierarchy and structured data.
2. **Content Separation**: Templates define structure; content lives in a per-app config file (`content/pages.yml` or equivalent).
3. **No Duplication**: Pricing plans pull from the subscription billing system (see `recipes/subscription-billing.md`), not from page-specific config.
4. **Semantic HTML**: Proper heading hierarchy, landmark elements (`<main>`, `<header>`, `<footer>`), and valid element nesting.
5. **SEO-First**: Structured data (JSON-LD), Open Graph tags, canonical URLs, and descriptive meta tags built into every template.

---

## Landing Page Template

The landing page is a conversion funnel designed to educate visitors and drive them to signup or a key CTA.

### Page Structure

```
Page (with SEOHead slot)
├── Header (shared, from root layout)
├── Breadcrumbs (optional, for link equity)
├── Main
│   ├── Hero Section
│   │   ├── Headline (H1)
│   │   ├── Subheadline
│   │   ├── Primary CTA Button
│   │   ├── Optional: Hero Image / Video
│   │   └── Optional: Byline / Trust Badge
│   ├── Features Grid
│   │   └── Feature Cards (repeating)
│   │       ├── Icon (or image)
│   │       ├── Feature Title (H3)
│   │       ├── Description (paragraph)
│   │       └── Optional: Link / Learn More
│   ├── Social Proof Section
│   │   ├── Heading (H2)
│   │   ├── Testimonials (carousel or grid)
│   │   │   └── Per Testimonial: Quote, Author, Org, Photo
│   │   └── Optional: Logo Bar (customer logos, no link required)
│   ├── Secondary CTA Block
│   │   ├── Heading (H2)
│   │   ├── Descriptive Copy
│   │   └── CTA Button (Secondary intent)
│   └── Footer (shared, from root layout)
└── Analytics / Tracking Pixels (non-blocking)
```

### Landing Page Content Config Schema

```yaml
# content/pages.yml (excerpt)
landing:
  seo:
    title: "Product Name | Tagline"
    description: "One-sentence value prop. 150-160 chars."
    canonical: "https://example.com"
    og_image: "/og/landing.jpg"
    og_title: "Product Name"
    og_description: "Value prop for social share."

  hero:
    headline: "Main H1 headline. Solve a problem."
    subheadline: "Expanded value prop. 1-2 sentences."
    cta_text: "Get Started"
    cta_link: "/signup"
    image:
      src: "/images/hero.jpg"
      alt: "Descriptive alt text for hero visual"
      width: 1200
      height: 675
    byline: "Optional: Used by X customers."

  features:
    section_title: "Why Choose Us?"
    description: "Optional intro text above grid."
    items:
      - icon: "feature-1"
        title: "Feature One"
        description: "2-3 sentence description of benefit."
        link: { text: "Learn more", href: "/docs/feature-1" }
      - icon: "feature-2"
        title: "Feature Two"
        description: "Describe tangible benefit or use case."
        link: null

  social_proof:
    section_title: "Trusted by Industry Leaders"
    testimonials:
      - quote: "This product changed how we work."
        author: "Jane Doe"
        org: "Company Inc"
        photo: "/testimonials/jane.jpg"
      - quote: "Incredible support and features."
        author: "John Smith"
        org: "Enterprise Corp"
        photo: "/testimonials/john.jpg"
    logos:
      - src: "/logos/customer-1.svg"
        alt: "Customer 1 logo"
      - src: "/logos/customer-2.svg"
        alt: "Customer 2 logo"

  secondary_cta:
    heading: "Ready to Get Started?"
    description: "Join thousands of users improving productivity."
    cta_text: "Start Free Trial"
    cta_link: "/signup?plan=free"
```

### Responsive Behavior

- **Hero**: Full-width on mobile; image/video below headline on mobile, beside on desktop (3:2 ratio desktop, full-width mobile).
- **Features Grid**: 1 column on mobile, 2-3 columns on tablet/desktop (adjust based on content).
- **Testimonials**: Single-column carousel on mobile; grid (2-3 per row) on desktop.
- **Logos**: Horizontal scroll on mobile; wrapping grid on desktop.

---

## Pricing Page Template

The pricing page displays subscription plans, enables billing interval selection, and drives conversion to checkout.

### Page Structure

```
Page (with SEOHead slot)
├── Header (shared)
├── Breadcrumbs (optional)
├── Main
│   ├── Pricing Header
│   │   ├── Headline (H1)
│   │   ├── Subheadline
│   │   └── Billing Interval Toggle (Monthly / Annual)
│   ├── Plan Cards Container
│   │   └── Plan Card (repeating)
│   │       ├── Recommended Badge (optional)
│   │       ├── Plan Name (H3)
│   │       ├── Price Display
│   │       │   ├── Amount (large)
│   │       │   ├── Billing Interval Label
│   │       │   └── Optional: Price per unit (e.g., per user/month)
│   │       ├── Description
│   │       ├── CTA Button
│   │       │   └── Button Text/Link conditional on plan type
│   │       └── Feature List
│   │           └── Feature Item (checkmark + text, repeating)
│   ├── Feature Comparison Table (optional, for complex pricing)
│   │   └── Rows: Features, Columns: Plans
│   ├── FAQ Section (optional, below plans)
│   │   ├── Heading (H2)
│   │   └── Accordion (see FAQ Template)
│   └── Footer (shared)
└── Analytics / Tracking
```

### Plan Card Component Pseudocode

```
COMPONENT PlanCard(plan, billingInterval, isRecommended):
  RENDER:
    <article class="plan-card" data-plan-id="{plan.id}">

      IF isRecommended:
        <div class="recommended-badge">Most Popular</div>
      END IF

      <h3>{plan.name}</h3>
      <p class="description">{plan.description}</p>

      <div class="price-display">
        <span class="amount">${formatPrice(plan.pricing[billingInterval].amount)}</span>
        <span class="interval">/{billingInterval}</span>
        IF plan.pricing[billingInterval].unit_label:
          <span class="unit">{plan.pricing[billingInterval].unit_label}</span>
        END IF
      </div>

      <button class="cta-button"
              onclick="handlePlanCTA(plan, billingInterval)"
              data-plan-id="{plan.id}">
        {getButtonText(plan)}
      </button>

      <ul class="feature-list">
        FOR EACH feature IN plan.features:
          <li>
            <svg class="checkmark"><!-- checkmark icon --></svg>
            <span>{feature.name}</span>
          </li>
        END FOR
      </ul>

    </article>
```

### CTA Logic (Pseudocode)

```
FUNCTION handlePlanCTA(plan, billingInterval):
  IF plan.type == "free":
    NAVIGATE_TO "/signup?plan=free"
  ELSE IF plan.type == "paid":
    session.selected_plan = plan.id
    session.billing_interval = billingInterval
    NAVIGATE_TO "/checkout"
  END IF
```

### Billing Interval Toggle (Pseudocode)

```
COMPONENT BillingToggle(currentInterval):
  RENDER:
    <div class="billing-toggle">
      <label>
        <input type="radio" name="interval" value="monthly"
               checked={currentInterval == "monthly"}
               onchange="updatePricing('monthly')">
        Monthly
      </label>
      <label>
        <input type="radio" name="interval" value="annual"
               checked={currentInterval == "annual"}
               onchange="updatePricing('annual')">
        Annual
        <span class="savings-badge">Save 20%</span>
      </label>
    </div>

  FUNCTION updatePricing(newInterval):
    FOR EACH planCard IN document.querySelectorAll('[data-plan-id]'):
      plan = getPlanData(planCard.dataset.planId)
      priceDisplay = planCard.querySelector('.price-display')
      priceDisplay.textContent = formatPrice(plan.pricing[newInterval].amount)
    END FOR
```

### Feature Comparison Table (Optional, for 4+ Plans)

```
TABLE
├── Header Row: Empty cell + Plan names
├── Rows (one per feature):
│   ├── Feature name
│   └── Per-plan cells: Checkmark, X, or tier label (e.g., "Unlimited")
```

Feature comparison is optional for 2-3 plans; recommended for 4+. Helps users understand differentiation at a glance.

### Pricing Page Content Config Schema

```yaml
# content/pages.yml (excerpt)
pricing:
  seo:
    title: "Pricing | Product Name"
    description: "Flexible pricing plans starting at $X/month. Choose annual to save 20%."
    canonical: "https://example.com/pricing"
    og_image: "/og/pricing.jpg"

  header:
    headline: "Simple, Transparent Pricing"
    subheadline: "Choose the plan that fits your team's needs."

  billing_intervals:
    - key: "monthly"
      label: "Monthly"
      discount_pct: null
    - key: "annual"
      label: "Annual"
      discount_pct: 20

  # Plan data comes from subscription-billing system; config only specifies ordering + recommended plan.
  plan_order: ["free", "starter", "professional", "enterprise"]
  recommended_plan: "professional"

  # Optional: Per-plan overrides for copy or special offers
  plan_overrides:
    free:
      description: "Perfect for individuals and small projects."
      highlight: true
    professional:
      cta_text: "Start Free Trial"
      cta_link: "/signup?plan=professional&trial=14days"

  comparison_table:
    enabled: true
    rows:
      - feature: "API Access"
      - feature: "Custom Branding"
      - feature: "24/7 Support"
      - feature: "SLA Guarantee"

  faq_section:
    enabled: true
    heading: "Pricing FAQs"
    # FAQ items can be embedded or reference faq.yml
```

### Pricing Page Gotchas

1. **Stale Plan Data**: Never cache plan cards longer than 1 hour. Plans and pricing change; billing system is source of truth. Use cache headers + ETags.
2. **Billing Toggle State**: Maintain toggle state in URL param or session state so users don't lose selection on page reload.
3. **Localization**: Prices, currency symbols, and interval labels are locale-aware. Ensure pricing service returns correct locale data.
4. **Annual Discount Logic**: Discount pct is stored in billing config, not pricing page config. Calculate in CTA handler, not hardcoded in UI.

---

## FAQ Page Template

The FAQ page displays Q&A content organized by category in an accordion interface, with structured data for rich snippets.

### Page Structure

```
Page (with SEOHead slot)
├── Header (shared)
├── Breadcrumbs (optional)
├── Main
│   ├── FAQ Header
│   │   ├── Headline (H1)
│   │   └── Optional: Search bar (filters FAQ items)
│   ├── FAQ Accordion Container
│   │   └── Category Group (repeating)
│   │       ├── Category Title (H2)
│   │       └── Accordion Items
│   │           └── Item (repeating)
│   │               ├── Question (button, H3)
│   │               └── Answer (collapsible panel)
│   └── Footer (shared)
└── Structured Data (JSON-LD FAQPage + mainEntity)
```

### Accordion Component Pseudocode

```
COMPONENT Accordion(faqItems, categoryGroups):
  state = {
    expandedItems: {} // { itemId: boolean }
  }

  RENDER:
    <div class="faq-accordion" role="region" aria-label="Frequently Asked Questions">
      FOR EACH category IN categoryGroups:
        <section class="faq-category">
          <h2 id="{category.id}">{category.name}</h2>

          FOR EACH item IN faqItems WHERE item.category == category.id:
            <div class="accordion-item" data-item-id="{item.id}">

              <button class="accordion-button"
                      id="button-{item.id}"
                      aria-expanded="{state.expandedItems[item.id] || false}"
                      aria-controls="panel-{item.id}"
                      onclick="toggleItem('{item.id}')">
                <h3>{item.question}</h3>
                <span class="toggle-icon">
                  <!-- chevron or +/- icon -->
                </span>
              </button>

              <div class="accordion-panel"
                   id="panel-{item.id}"
                   role="region"
                   aria-labelledby="button-{item.id}"
                   hidden="{!state.expandedItems[item.id]}">
                {item.answer}  <!-- HTML allowed: <p>, <ul>, <code>, etc. -->
              </div>

            </div>
          END FOR
        </section>
      END FOR
    </div>

  FUNCTION toggleItem(itemId):
    state.expandedItems[itemId] = !state.expandedItems[itemId]
    button = document.getElementById(`button-${itemId}`)
    panel = document.getElementById(`panel-${itemId}`)
    button.setAttribute('aria-expanded', state.expandedItems[itemId])
    panel.hidden = !state.expandedItems[itemId]

    // Emit analytics event for FAQ interaction
    trackEvent('faq_item_toggled', { item_id: itemId, expanded: state.expandedItems[itemId] })
```

### FAQ Page Content Config Schema

```yaml
# content/pages.yml (excerpt)
faq:
  seo:
    title: "Frequently Asked Questions | Product Name"
    description: "Get answers to common questions about pricing, features, and support."
    canonical: "https://example.com/faq"
    og_image: "/og/faq.jpg"

  header:
    headline: "Frequently Asked Questions"
    subheadline: "Can't find what you're looking for? Contact support."

  search_enabled: true

  categories:
    - id: "general"
      name: "General"
    - id: "pricing"
      name: "Pricing & Billing"
    - id: "technical"
      name: "Technical & Integration"
    - id: "support"
      name: "Support & Troubleshooting"

  items:
    - id: "q-1"
      category: "general"
      question: "What is Product Name?"
      answer: |
        <p>Product Name is a platform that helps teams ...</p>
        <p>Additional context or details.</p>

    - id: "q-2"
      category: "pricing"
      question: "Can I change plans anytime?"
      answer: |
        <p>Yes! You can upgrade or downgrade at any time.</p>
        <ul>
          <li>Upgrades take effect immediately.</li>
          <li>Downgrades take effect at your next billing cycle.</li>
        </ul>

    - id: "q-3"
      category: "technical"
      question: "What APIs are supported?"
      answer: |
        <p>We support REST and GraphQL APIs:</p>
        <ul>
          <li>REST endpoints</li>
          <li>GraphQL schema</li>
          <li>Webhooks for real-time events</li>
        </ul>
        <p><a href="/docs/api">View API documentation →</a></p>
```

### FAQ Structured Data (JSON-LD)

```
SCHEMA FAQPage:
  type: "FAQPage"
  mainEntity: [
    {
      type: "Question"
      name: "What is Product Name?"
      acceptedAnswer: {
        type: "Answer"
        text: "Product Name is a platform that helps teams..."
      }
    },
    ...
  ]

RENDER AS:
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is Product Name?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Product Name is a platform that helps teams..."
      }
    },
    // ... more items
  ]
}
</script>
```

### FAQ Page Gotchas

1. **JS-Toggled Content & SEO**: Accordion answers must be in the DOM (hidden with `hidden` attribute), not injected via JS, so crawlers can index them. Use `aria-expanded` for accessibility, not as a hydration boundary.
2. **Heading Hierarchy**: Questions are H3s under H2 category headings. Never skip heading levels; use `aria-hidden="true"` on decorative headings if needed.
3. **Rich Snippets Rendering**: Ensure JSON-LD FAQPage is server-rendered and valid. Test with Google Rich Results Test before launch.
4. **Search/Filtering**: If implementing client-side search, filter items but keep DOM structure intact (hide with CSS, not remove from DOM).

---

## SEO Requirements

All marketing pages must adhere to these SEO standards.

### Heading Hierarchy

```
<h1>Page Title (one per page, unique per template type)</h1>

<h2>Section headings (Features, Pricing, Social Proof, etc.)</h2>

<h3>Sub-sections or card titles (Feature cards, plan names, FAQ questions)</h3>

<!-- Never skip levels: h1 → h2 → h4 is invalid. -->
```

### Structured Data (JSON-LD)

Every page must include:

```json
{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Page title",
  "description": "Meta description",
  "url": "https://example.com/path",
  "image": {
    "@type": "ImageObject",
    "url": "https://example.com/og-image.jpg",
    "width": 1200,
    "height": 630
  }
}
```

**Landing Page** additionally:
```json
{
  "@type": "Product",
  "name": "Product Name",
  "description": "Tagline / value prop",
  "image": "https://example.com/hero.jpg",
  "brand": {
    "@type": "Brand",
    "name": "Company Name"
  }
}
```

**Pricing Page** additionally:
```json
{
  "@type": "CollectionPage",
  "name": "Pricing",
  "hasPart": [
    {
      "@type": "Offer",
      "name": "Starter Plan",
      "price": "29.00",
      "priceCurrency": "USD",
      "billingDuration": "P1M"
    }
  ]
}
```

**FAQ Page**: Use `FAQPage` schema (see FAQ section above).

### Canonical URLs

Every page must declare a canonical URL:

```html
<link rel="canonical" href="https://example.com/pricing">
```

Prevents duplicate content issues across domains, subdomains, or query params.

### Open Graph Tags

```html
<meta property="og:type" content="website">
<meta property="og:title" content="Page Title">
<meta property="og:description" content="Short description for social share.">
<meta property="og:image" content="https://example.com/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://example.com/path">
```

### SEO Head Component (Reusable Slot)

```
COMPONENT SEOHead(config):
  RENDER:
    <head>
      <title>{config.title}</title>
      <meta name="description" content="{config.description}">
      <meta name="viewport" content="width=device-width, initial-scale=1">

      <!-- Canonical -->
      <link rel="canonical" href="{config.canonical}">

      <!-- Open Graph -->
      <meta property="og:type" content="{config.og_type}">
      <meta property="og:title" content="{config.og_title}">
      <meta property="og:description" content="{config.og_description}">
      <meta property="og:image" content="{config.og_image}">
      <meta property="og:url" content="{config.canonical}">

      <!-- Structured Data -->
      <script type="application/ld+json">
        {config.structured_data}
      </script>
    </head>
```

### Meta Tags & Keywords

- **Title**: 50-60 chars, include primary keyword once, brand name at end.
- **Description**: 150-160 chars, natural language, CTA-friendly.
- **Keywords**: Not indexed by Google, but use for internal organization. Include: primary keyword, secondary variants, brand name.

---

## Content Configuration Schema

Each app provides a per-app config file that populates all three templates. This enables:
- Template reuse without code duplication.
- Easy localization (create `content/pages.fr.yml` for French).
- Non-technical content updates via YAML/JSON.

### Directory Structure

```
app/
├── content/
│   ├── pages.yml           (landing, pricing, faq)
│   ├── pages.fr.yml        (French translations)
│   └── pages.es.yml        (Spanish, etc.)
├── public/
│   ├── images/
│   │   ├── hero.jpg
│   │   ├── features/
│   │   └── testimonials/
│   └── og/                 (OG images)
├── routes/
│   ├── landing/
│   ├── pricing/
│   └── faq/
└── schemas/
    └── pages.schema.json   (validation schema)
```

### Config Validation

Each config file is validated against a schema before rendering:

```
FUNCTION validateConfig(config, schema):
  errors = validateAgainstSchema(config, schema)
  IF errors.length > 0:
    LOG_ERROR "Invalid pages config:"
    FOR EACH error IN errors:
      LOG_ERROR "  - {error.path}: {error.message}"
    END FOR
    THROW ConfigValidationError
  END IF
  RETURN config
```

Missing required fields (e.g., `landing.seo.title`) should block build / deployment.

---

## Responsive Behavior

All templates follow mobile-first design principles.

### Breakpoints

- **Mobile**: < 640px (default)
- **Tablet**: 640px – 1023px
- **Desktop**: ≥ 1024px

### Landing Page Responsive

| Element | Mobile | Tablet | Desktop |
|---------|--------|--------|---------|
| Hero | Full-width, headline 28px, image below | 75/25 split, headline 32px | 50/50 split, headline 40px |
| Features Grid | 1 col | 2 cols | 3 cols |
| Testimonials | Carousel (scroll) | Grid 2 cols | Grid 3 cols |
| Logo Bar | Vertical scroll | Wrapping grid | Wrapping grid |

### Pricing Page Responsive

| Element | Mobile | Desktop |
|---------|--------|---------|
| Plan Cards | 1 col, full width | 2–3 cols, equal width |
| Comparison Table | Horizontal scroll | Fixed, readable |
| Feature List | Visible in card | Card or table row |

### FAQ Page Responsive

- Accordion works identically on all screen sizes.
- Search bar (if present) full-width on mobile, sized on desktop.
- Font size: 16px min on mobile to avoid iOS zoom-on-focus.

---

## Accessibility (a11y)

### Keyboard Navigation

**Accordion**:
- `Tab`: Move between buttons.
- `Enter` / `Space`: Toggle current item.
- `Home` / `End`: Jump to first / last item in category.

```
BUTTON.onkeydown:
  IF key == 'Enter' OR key == ' ':
    toggleItem()
    preventDefault()
  END IF
```

**Pricing Toggle (Radio)**:
- `Tab`: Move between radio options.
- `Arrow keys`: Select adjacent radio.

### ARIA Attributes

```html
<!-- Accordion -->
<button aria-expanded="false" aria-controls="panel-1">
  Question
</button>
<div id="panel-1" role="region" aria-labelledby="button-1" hidden>
  Answer
</div>

<!-- Plan cards -->
<div role="region" aria-label="Pricing plans">
  <article aria-label="Professional plan, $99 per month">
    ...
  </article>
</div>

<!-- CTA buttons -->
<button aria-label="Get started with free plan">Start Free</button>
```

### Focus Management

- Focus visible on all interactive elements (buttons, links, form inputs).
- Focus trap (if modal) or return focus to trigger on modal close.
- Page title updates if AJAX-loading new section.

### Color Contrast

- Text: 4.5:1 ratio for normal text, 3:1 for large text.
- Icons: If used alone as buttons, ensure 3:1 contrast with background.
- Test with tools: WebAIM Contrast Checker, axe DevTools.

### Form Labels & Errors

```html
<label for="email">Email Address</label>
<input id="email" type="email" aria-describedby="email-error">
<span id="email-error" role="alert">Email is required.</span>
```

---

## Gotchas & Anti-Patterns

### 1. Pricing Page: Stale Plan Data

**Problem**: Plans change (price, features, availability), but page cache serves stale HTML.

**Solution**:
- Cache landing & FAQ pages aggressively (1 day+).
- Cache pricing page for ≤ 1 hour, with ETags.
- On every page load, validate plan IDs against live billing system; return 404 if plan removed.

```
ROUTE /pricing:
  plans = fetchPlansFromBillingSystem()
  cachedPage = getFromCache('pricing-page')

  IF cachedPage AND calculateETag(plans) == cachedPage.etag:
    RETURN cachedPage.html, 304
  END IF

  html = renderPricingPage(plans)
  setCache('pricing-page', html, ttl=3600, etag=calculateETag(plans))
  RETURN html
```

### 2. Accordion SEO: JS-Toggled Content

**Problem**: Search crawlers can't see accordion answers if they're not in the DOM.

**Solution**:
- Keep accordion answers in the DOM, hidden with `hidden` attribute (not `display: none`).
- Use CSS to style hidden state; JavaScript toggles `hidden` attr, not CSS class.
- Google crawlers execute JS and will index hidden answers, but hidden content is invisible to users and crawlers that don't execute JS.

```html
<!-- Good -->
<div class="accordion-panel" hidden>Answer text here</div>

<!-- Bad (content not in DOM) -->
<div id="panel-1"></div>
<script>if (clicked) { document.getElementById('panel-1').innerHTML = 'Answer'; }</script>
```

### 3. Image Optimization: Hero

**Problem**: Large hero images bloat page size, harming Core Web Vitals.

**Solution**:
- Serve WebP with JPEG fallback via `<picture>`.
- Use `srcset` for responsive images (1x, 2x, different widths).
- Lazy-load if below-the-fold (though hero is usually above fold).
- Compress: 80–85% quality for JPEG, max 100KB for < 100px width, 200KB for hero.

```html
<picture>
  <source srcset="/images/hero.webp 1200w, /images/hero@2x.webp 2400w" type="image/webp">
  <source srcset="/images/hero.jpg 1200w, /images/hero@2x.jpg 2400w" type="image/jpeg">
  <img src="/images/hero.jpg" alt="Hero description" width="1200" height="675" loading="eager">
</picture>
```

### 4. Billing Interval Toggle: State Loss

**Problem**: User selects "Annual", then page reloads; toggle resets to "Monthly", and monthly prices show.

**Solution**:
- Store selection in URL search param: `/pricing?interval=annual`.
- On page load, check URL param and restore toggle state + prices.
- Update URL on toggle change (no page reload).

```
FUNCTION updatePricing(newInterval):
  window.history.replaceState(null, '', `?interval=${newInterval}`)
  // update prices on page
```

### 5. Pricing Decimals & Rounding

**Problem**: Annual price is $99 * 12 = $1188, but you want to show $999 for marketing. Plan config stores $99/month; don't hardcode $999 on page.

**Solution**:
- Plan config stores base price ($99).
- Pricing page calculates annual: $99 * 12 = $1188.
- If discount needed, add `annual_price_override` to plan config, or apply discount % in toggle handler.

```yaml
plans:
  professional:
    pricing:
      monthly: { amount: 99 }
      annual:
        amount: 999  # Override; typically plan.monthly.amount * 12 * (1 - discount_pct)
        discount_pct: 15
```

### 6. FAQ Search: Maintaining Structure

**Problem**: Client-side FAQ search hides non-matching items, breaking category structure.

**Solution**:
- Filter items via CSS (`display: none`) or hidden attribute, not DOM removal.
- Keep categories visible if any items match.
- Announce search results to screen readers.

```
FUNCTION filterFAQ(query):
  FOR EACH item IN document.querySelectorAll('[data-item-id]'):
    matches = item.question.toLowerCase().includes(query.toLowerCase())
    item.hidden = !matches
  END FOR

  FOR EACH category IN document.querySelectorAll('[data-category-id]'):
    visibleItems = category.querySelectorAll('[data-item-id]:not([hidden])').length
    category.hidden = (visibleItems === 0)
  END FOR

  status = `Found ${visibleCount} FAQs matching "${query}"`
  announceToA11y(status)
```

### 7. Content Injection: XSS Prevention

**Problem**: FAQ answer config contains user-generated content or third-party HTML; XSS risk.

**Solution**:
- Sanitize HTML from config using a library (e.g., DOMPurify, bleach).
- Allowlist only safe tags: `<p>`, `<ul>`, `<li>`, `<a>`, `<strong>`, `<em>`, `<code>`, `<blockquote>`.
- Disallow `<script>`, event handlers, and `javascript:` URLs.

```
FUNCTION renderAnswer(answerHTML):
  sanitized = DOMPurify.sanitize(answerHTML, {
    ALLOWED_TAGS: ['p', 'ul', 'li', 'a', 'strong', 'em', 'code', 'blockquote', 'h4', 'h5'],
    ALLOWED_ATTR: ['href', 'title', 'target']
  })
  RETURN sanitized
```

### 8. Testimonial Photos: Performance & Privacy

**Problem**: High-res testimonial photos slow page load; privacy concerns if using real employee faces.

**Solution**:
- Use low-res thumbnails (100-150px), lazy-loaded.
- Compress to < 20KB per image.
- Obtain explicit consent from testimonial authors before using photos.
- Consider using avatars or initials instead of photos.

```html
<img src="/testimonials/jane-thumb.jpg"
     alt="Jane Doe, CEO at Company Inc"
     width="100" height="100"
     loading="lazy">
```

---

## Summary Checklist

- [ ] Landing page renders with valid semantic HTML and correct heading hierarchy.
- [ ] Pricing page plan data syncs with subscription billing system (no manual entry).
- [ ] All pages include JSON-LD structured data and Open Graph tags.
- [ ] Canonical URLs declared on all pages.
- [ ] FAQ accordion is keyboard-navigable and includes ARIA attributes.
- [ ] Pricing page caches for ≤ 1 hour; landing/FAQ pages cache ≥ 1 day.
- [ ] Accordion answers are in DOM (hidden, not injected via JS).
- [ ] Hero images optimized: WebP + JPEG, srcset, < 200KB.
- [ ] Testimonial images lazy-loaded and < 20KB.
- [ ] HTML sanitized in FAQ content (no XSS).
- [ ] Billing toggle state persists in URL or session.
- [ ] All pages tested with axe DevTools and Google PageSpeed Insights.
- [ ] Config validated against schema before build.
- [ ] Localization: per-locale config files tested (French, Spanish, etc.).

