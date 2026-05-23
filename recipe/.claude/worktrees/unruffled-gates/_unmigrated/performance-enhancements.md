---
name: Performance Enhancements
description: CDN configuration, image optimization pipeline, and bundle splitting strategy
type: enhancement
requires: recipes/deployment.md, recipes/assets.md, recipes/build-config.md
env_vars: CDN_BASE_URL, FILE_STORAGE_PROVIDER (s3|gcs|local), IMAGE_OPTIMIZATION_ENABLED (default true), BUNDLE_ANALYSIS (default false)
---

# Performance Enhancements

Production-ready CDN configuration, image optimization pipeline with lazy loading, and intelligent bundle splitting for fast page loads and minimal initial payload.

---

## 1. CDN Configuration Template

Cache rules per asset type with smart invalidation strategies. Works with Vercel Edge Network, Cloudflare, or any CDN.

### Environment Configuration

```env
# CDN configuration
CDN_BASE_URL=https://cdn.example.com
CDN_PROVIDER=vercel|cloudflare|custom
CDN_PURGE_ENABLED=true
CDN_PURGE_TOKEN=<token>

# Cache control
CACHE_STATIC_MAX_AGE=31536000      # 1 year (immutable assets)
CACHE_HTML_MAX_AGE=3600             # 1 hour (HTML pages)
CACHE_API_MAX_AGE=0                 # No cache (API responses)
CACHE_API_STALE_WHILE_REVALIDATE=86400  # 24 hours
```

### Cache Rules by Asset Type

```pseudocode
function getCacheHeaders(assetPath, assetType):

  // Static assets (images, fonts, JS, CSS) — immutable, cache forever
  if (isStaticAsset(assetPath)):
    return {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'CDN-Cache-Control': 'max-age=31536000',
      'ETag': getAssetHash(assetPath)  // content-based hash
    }

  // HTML pages — cache short, stale-while-revalidate
  if (assetPath.endsWith('.html') or isHtmlRequest()):
    return {
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'CDN-Cache-Control': 'max-age=3600, stale-while-revalidate=86400',
      'ETag': getPageHash(assetPath)
    }

  // SSR pages — stale-while-revalidate, but shorter max-age
  if (isSSRPage()):
    return {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      'CDN-Cache-Control': 'max-age=300, stale-while-revalidate=3600'
    }

  // API responses — no cache or conditional cache
  if (isApiRequest()):
    return {
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Pragma': 'no-cache'
    }

  // Default fallback
  return {
    'Cache-Control': 'public, max-age=3600'
  }
```

### Middleware Implementation

Inject cache headers in response:

```pseudocode
middleware cacheHeadersMiddleware(request, response, next):

  // Get original send() function
  originalSend = response.send

  // Override send() to add cache headers
  response.send = function(body):
    assetType = detectAssetType(request.path, request.headers)
    cacheHeaders = getCacheHeaders(request.path, assetType)

    for (header, value) in cacheHeaders:
      response.setHeader(header, value)

    return originalSend.call(response, body)

  next()
```

### Conditional Caching with Query Parameters

Versioned assets use query params:

```
/assets/app.js?v=abc123def456

When v= changes, cache is invalidated (new URL = different cache key)
```

Serve these with long cache TTL:

```pseudocode
if (request.query.v):
  // Versioned asset, cache forever
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
else:
  // Non-versioned asset, cache short
  response.setHeader('Cache-Control', 'public, max-age=3600')
```

### CDN Purge Strategy

#### Deploy-Triggered Full Purge

After deployment, purge all CDN cache:

```pseudocode
function deployAndPurge(version):
  // Deploy new version
  deployApp(version)

  // Wait for deployment to stabilize
  sleep(10 seconds)

  // Purge all CDN cache
  if (CDN_PURGE_ENABLED):
    response = purgeCDN({
      pattern: '/*',  // All paths
      token: CDN_PURGE_TOKEN
    })

    if (response.status != 200):
      log('CDN purge failed', { status: response.status })
      // Don't fail deploy, but alert ops
      sendAlert('CDN purge failed for deployment ' + version)
    else:
      log('CDN purged successfully', { version: version })
```

#### API-Triggered Selective Purge

Admins can manually purge specific paths:

```
POST /admin/api/cache/purge
{
  pattern: "/api/users/*",  // Purge specific paths
  include_html: false       // Also purge related HTML pages
}

POST /admin/api/cache/purge-all
  // Full cache clear (for emergencies)
```

Pseudocode:

```pseudocode
endpoint POST /admin/api/cache/purge:
  pattern = request.body.pattern
  include_html = request.body.include_html || false

  if not pattern or pattern == '/*':
    // Require confirmation for full purge
    if not request.body.confirm:
      return 400, { error: 'Full purge requires confirmation' }

  response = purgeCDN({
    pattern: pattern,
    token: CDN_PURGE_TOKEN,
    include_html: include_html
  })

  if (response.status == 200):
    auditLog(admin_id, 'admin', 'cache.purged', 'cache', pattern, {
      pattern: pattern
    }, request)
    return 200, { status: 'purge_initiated', pattern: pattern }
  else:
    return 500, { error: 'CDN purge failed' }
```

### Asset URL Rewriting

When CDN is configured, rewrite asset URLs:

```pseudocode
function getAssetURL(path):
  if not CDN_BASE_URL:
    return path  // No CDN, use local path

  // Remove leading slash
  cleanPath = path.replace(/^\//, '')

  // Build CDN URL
  return CDN_BASE_URL + '/' + cleanPath
```

Usage in templates:

```html
<!-- Server template (SSR) -->
<script src="<%= getAssetURL('/assets/app.js') %>"></script>
<!-- Output: <script src="https://cdn.example.com/assets/app.js"></script> -->

<!-- HTML static asset -->
<img src="<%= getAssetURL('/images/logo.svg') %>" />
```

Or in build process (static site generation):

```pseudocode
function buildAssets():
  for assetFile in allAssets:
    content = readFile(assetFile)

    // Replace asset URLs
    content = content.replace(/\/assets\/(\S+)/g, (match, path) => {
      return getAssetURL('/assets/' + path)
    })

    writeFile(assetFile, content)
```

### CDN Health Check

Monitor CDN status:

```
GET /admin/api/cdn/health

{
  status: 'healthy' | 'degraded' | 'down',
  provider: 'vercel',
  cache_hit_rate: 0.87,  // 87% of requests served from cache
  average_latency_ms: 45,
  last_purge: '2025-03-26T10:30:00Z',
  regions: {
    us-east: 'healthy',
    us-west: 'healthy',
    eu-west: 'degraded',
    ap-southeast: 'healthy'
  }
}
```

### Vercel Edge Network Configuration

If using Vercel:

```json
{
  "vercelCdn": {
    "enabled": true,
    "cacheRules": [
      {
        "source": "/assets/**",
        "maxAge": 31536000,
        "sMaxAge": 31536000,
        "staleWhileRevalidate": null
      },
      {
        "source": "/:path*.html",
        "maxAge": 3600,
        "sMaxAge": 3600,
        "staleWhileRevalidate": 86400
      },
      {
        "source": "/api/**",
        "maxAge": 0,
        "sMaxAge": 0
      }
    ]
  }
}
```

### Cloudflare Configuration

If using Cloudflare:

```
// Cloudflare Workers (edge computing)
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  const cacheKey = new Request(url.toString(), { method: 'GET' })

  // Check cache first
  let response = await caches.default.match(cacheKey)
  if (response) {
    return response
  }

  // Fetch from origin
  response = await fetch(request)

  // Cache based on path
  if (url.pathname.startsWith('/assets/')) {
    response = new Response(response.body, {
      ...response,
      headers: {
        ...response.headers,
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
    event.waitUntil(caches.default.put(cacheKey, response.clone()))
  }

  return response
}
```

---

## 2. Image Optimization Pipeline

On-upload processing with automatic resizing, format conversion, lazy loading, and responsive srcsets.

### Data Model

```
Image {
  id:                string (UUID)
  original_filename: string
  source_url:        string (original file in storage)
  file_size:         number (bytes)
  dimensions:        { width, height }
  mime_type:         string

  // Processed variants
  variants: {
    thumbnail: {
      url: string,
      width: 150,
      height: 150,
      file_size: number,
      format: 'webp' | 'jpeg'
    },
    medium: {
      url: string,
      width: 600,
      height: 600,
      file_size: number,
      format: 'webp' | 'jpeg'
    },
    large: {
      url: string,
      width: 1200,
      height: 1200,
      file_size: number,
      format: 'webp' | 'jpeg'
    },
    original: {
      url: string,
      width: number,
      height: number,
      file_size: number,
      format: original format
    }
  }

  // Lazy loading
  blur_placeholder: string (tiny base64 image)

  metadata: {
    alt_text: string
    title: string
    description: string
    tags: array
    credit: string
  }

  storage_path:  string (internal path in FILE_STORAGE_PROVIDER)
  uploaded_by:   string (user_id)
  uploaded_at:   datetime
  updated_at:    datetime
}
```

### Upload Endpoint

```
POST /api/images/upload
Content-Type: multipart/form-data

Fields:
  file: <binary>
  alt_text?: string
  title?: string
  tags?: array

Response:
{
  id: "img-abc123",
  original_filename: "photo.jpg",
  variants: {
    thumbnail: { url: "https://cdn.../img-abc123-150.webp", width: 150, height: 150 },
    medium: { url: "https://cdn.../img-abc123-600.webp", width: 600, height: 600 },
    large: { url: "https://cdn.../img-abc123-1200.webp", width: 1200, height: 1200 },
    original: { url: "https://cdn.../img-abc123-original.jpg", width: 3840, height: 2160 }
  },
  blur_placeholder: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAZABkAAD...",
  dimensions: { width: 3840, height: 2160 },
  file_size: 2048000
}
```

### Upload Handler

Pseudocode:

```pseudocode
endpoint POST /api/images/upload:
  file = request.files.file

  // Validate file
  if not file or not isSupportedFormat(file.mime_type):
    return 400, { error: 'Invalid file format' }

  if file.size > MAX_FILE_SIZE (default 10MB):
    return 413, { error: 'File too large. Max 10MB.' }

  user_id = request.auth.user_id

  try:
    // Store original file
    original_path = uploadToStorage(file, user_id)

    // Process image variants
    variants = processImageVariants(file, {
      sizes: [150, 600, 1200],
      formats: ['webp', 'jpeg'],
      quality: 80
    })

    // Generate blur placeholder
    blur = generateBlurPlaceholder(file)

    // Create image record
    image = {
      id: generateUUID(),
      original_filename: file.filename,
      source_url: original_path,
      file_size: file.size,
      dimensions: getImageDimensions(file),
      mime_type: file.mime_type,
      variants: variants,
      blur_placeholder: blur,
      metadata: {
        alt_text: request.body.alt_text || '',
        title: request.body.title || '',
        tags: request.body.tags || []
      },
      uploaded_by: user_id,
      uploaded_at: getCurrentTime()
    }

    db.images.insert(image)

    return 200, {
      id: image.id,
      variants: image.variants,
      blur_placeholder: image.blur_placeholder,
      dimensions: image.dimensions
    }

  catch error:
    log('image_upload_failed', { error: error.message, user_id: user_id })
    return 500, { error: 'Image processing failed' }
```

### Image Processing

```pseudocode
function processImageVariants(file, options):
  breakpoints = options.sizes || [150, 600, 1200]
  formats = options.formats || ['webp', 'jpeg']
  quality = options.quality || 80

  variants = {}

  for size in breakpoints:
    for format in formats:
      resized = resizeImage(file, size)
      converted = convertFormat(resized, format, quality)
      url = uploadToStorage(converted, 'images/variants/')

      variant_key = size + 'px'
      if variant_key not in variants:
        variants[variant_key] = {}

      variants[variant_key][format] = {
        url: url,
        width: size,
        height: calculateHeight(file.dimensions, size),
        file_size: converted.size,
        format: format
      }

  return variants
```

### Lazy Loading Component

HTML component with responsive srcset:

```html
<!-- Lazy Loading Image Component -->
<figure class="image-container">
  <picture>
    <!-- WebP format (modern browsers) -->
    <source
      srcset="
        <%= image.variants.medium.webp.url %> 600w,
        <%= image.variants.large.webp.url %> 1200w
      "
      type="image/webp"
      sizes="(max-width: 768px) 100vw, (max-width: 1024px) 75vw, 50vw"
    />

    <!-- JPEG fallback -->
    <source
      srcset="
        <%= image.variants.medium.jpeg.url %> 600w,
        <%= image.variants.large.jpeg.url %> 1200w
      "
      type="image/jpeg"
      sizes="(max-width: 768px) 100vw, (max-width: 1024px) 75vw, 50vw"
    />

    <!-- Actual image -->
    <img
      src="<%= image.variants.large.webp.url %>"
      alt="<%= image.metadata.alt_text %>"
      loading="lazy"
      decoding="async"
      width="<%= image.dimensions.width %>"
      height="<%= image.dimensions.height %>"
      style="background-image: url('<%= image.blur_placeholder %>'); background-size: cover; background-position: center;"
      class="lazy-image"
      data-src="<%= image.variants.large.webp.url %>"
    />
  </picture>

  <% if (image.metadata.title): %>
    <figcaption><%= image.metadata.title %></figcaption>
  <% endif %>
</figure>

<style>
  .image-container {
    margin: 0;
    overflow: hidden;
  }

  .lazy-image {
    display: block;
    width: 100%;
    height: auto;
    background-size: cover;
    animation: fadeIn 0.3s ease-in-out;
  }

  @keyframes fadeIn {
    from { opacity: 0.5; }
    to { opacity: 1; }
  }
</style>
```

### Blur Placeholder Generation

Tiny base64 preview for LQIP (Low Quality Image Placeholder):

```pseudocode
function generateBlurPlaceholder(file):
  // Resize to tiny 10x10 pixels
  tiny = resizeImage(file, 10)

  // Convert to JPEG with low quality
  blurred = convertFormat(tiny, 'jpeg', quality=20)

  // Convert to base64
  base64 = encodeBase64(blurred)

  return 'data:image/jpeg;base64,' + base64
```

### Conditional Optimization

Only enable if configured:

```pseudocode
middleware imageOptimization(request, response, next):
  if not IMAGE_OPTIMIZATION_ENABLED:
    next()
    return

  // Handle image optimization...
  next()
```

### CDN-Aware URLs

When CDN is configured, serve from CDN:

```pseudocode
function getImageURL(image_id, variant_size, format):
  if not CDN_BASE_URL:
    return '/images/' + image_id + '-' + variant_size + '.' + format

  return CDN_BASE_URL + '/images/' + image_id + '-' + variant_size + '.' + format
```

### Configuration

```env
# Image optimization
IMAGE_OPTIMIZATION_ENABLED=true
IMAGE_MAX_FILE_SIZE=10485760  # 10 MB
IMAGE_QUALITY=80              # JPEG/WebP quality (1-100)
IMAGE_BREAKPOINTS=150,600,1200
IMAGE_FORMATS=webp,jpeg

# Storage
FILE_STORAGE_PROVIDER=s3      # s3, gcs, local
S3_BUCKET=app-images
S3_REGION=us-east-1
GCS_BUCKET=app-images
```

---

## 3. Bundle Splitting Defaults

Intelligent code splitting strategy: route-level chunks, vendor chunk, common chunk, and dynamic imports for heavy features.

### Bundle Configuration

```javascript
// webpack.config.js or build config
module.exports = {
  optimization: {
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        // Vendor dependencies (e.g., react, lodash)
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          priority: 10,
          minSize: 50000,  // Only create if 50KB+
          reuseExistingChunk: true,
        },

        // Common code used by 2+ chunks
        common: {
          minChunks: 2,
          priority: 5,
          reuseExistingChunk: true,
          name: 'common',
        },

        // React + ReactDOM (heavy, shared by all)
        react: {
          test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
          name: 'react-vendors',
          priority: 15,
          minSize: 0,  // Always create separate chunk
          reuseExistingChunk: true,
        },
      },
    },
    runtimeChunk: 'single',  // Webpack runtime in separate file
  },

  // Route-level splitting (each page is separate chunk)
  entry: {
    main: './src/index.js',
    // Pages are loaded dynamically via dynamic import()
  },
}
```

### Dynamic Imports

Lazy-load heavy features:

```javascript
// src/features/billing/index.js
export { default as BillingPage } from './pages/BillingPage';
export { default as BillingModal } from './components/BillingModal';

// In main app code
import React, { lazy, Suspense } from 'react';

// Heavy features loaded on-demand
const BillingPage = lazy(() => import('./features/billing'));
const AdminPanel = lazy(() => import('./features/admin'));
const RichTextEditor = lazy(() => import('./features/rich-text-editor'));

export function App() {
  return (
    <Routes>
      <Route
        path="/billing"
        element={
          <Suspense fallback={<LoadingSpinner />}>
            <BillingPage />
          </Suspense>
        }
      />
      <Route
        path="/admin"
        element={
          <Suspense fallback={<LoadingSpinner />}>
            <AdminPanel />
          </Suspense>
        }
      />
    </Routes>
  );
}
```

### Route-Level Splitting

Each page becomes a separate chunk:

```javascript
// src/pages/HomePage.js
export default function HomePage() {
  return <div>Home</div>;
}

// src/pages/UsersPage.js
export default function UsersPage() {
  return <div>Users</div>;
}

// src/routes.js
import { lazy } from 'react';

export const routes = [
  {
    path: '/',
    component: lazy(() => import('./pages/HomePage')),
  },
  {
    path: '/users',
    component: lazy(() => import('./pages/UsersPage')),
  },
  {
    path: '/billing',
    component: lazy(() => import('./pages/BillingPage')),
  },
];
```

Build output:
```
dist/
  ├── main.js          (~50KB - core app)
  ├── vendors.js       (~200KB - node_modules)
  ├── react-vendors.js (~100KB - react + react-dom)
  ├── common.js        (~30KB - shared utilities)
  ├── HomePage.js      (~15KB)
  ├── UsersPage.js     (~20KB)
  ├── BillingPage.js   (~40KB)
  └── AdminPanel.js    (~60KB)
```

Only the user's current page chunk is loaded, not all routes.

### Preload Hints

Hint browser to preload likely-next pages:

```html
<!-- index.html -->
<!-- Preload vendor chunks (needed immediately) -->
<link rel="preload" href="/vendors.js" as="script" />
<link rel="preload" href="/react-vendors.js" as="script" />

<!-- Prefetch chunks for pages user might visit -->
<link rel="prefetch" href="/HomePage.js" as="script" />
<link rel="prefetch" href="/UsersPage.js" as="script" />
<link rel="prefetch" href="/BillingPage.js" as="script" />
```

Or programmatically:

```javascript
function prefetchPage(pageName) {
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'script';
  link.href = `/${pageName}.js`;
  document.head.appendChild(link);
}

// Prefetch on user interaction
document.getElementById('nav-billing').addEventListener('mouseenter', () => {
  prefetchPage('BillingPage');
});
```

### Bundle Analysis

Generate size report on build:

```bash
npm run build:analyze
```

Creates HTML report:

```html
bundle-report.html
  Shows chunk sizes, dependencies, can identify bloat
```

Configuration:

```javascript
// webpack.config.js
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

module.exports = {
  plugins: [
    process.env.ANALYZE && new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      reportFilename: 'bundle-report.html',
    }),
  ].filter(Boolean),
};
```

### Size Budget Alerts

Fail CI if chunks exceed threshold:

```javascript
// size-budget.js
const fs = require('fs');
const path = require('path');

const budgets = {
  'main.js': 100,        // 100KB
  'vendors.js': 200,     // 200KB
  'react-vendors.js': 120, // 120KB
  'common.js': 50,       // 50KB
  'any-route.js': 80,    // Any route max 80KB
};

function checkBudget() {
  const distDir = path.join(__dirname, 'dist');
  let failed = false;

  Object.entries(budgets).forEach(([filename, maxSize]) => {
    const filepath = path.join(distDir, filename);

    if (!fs.existsSync(filepath)) {
      console.warn(`Bundle file not found: ${filename}`);
      return;
    }

    const size = fs.statSync(filepath).size / 1024; // KB

    if (size > maxSize) {
      console.error(
        `❌ Bundle size exceeded: ${filename} is ${size.toFixed(1)}KB (max ${maxSize}KB)`
      );
      failed = true;
    } else {
      console.log(
        `✓ ${filename}: ${size.toFixed(1)}KB / ${maxSize}KB`
      );
    }
  });

  if (failed) {
    process.exit(1);
  }
}

checkBudget();
```

Run in CI:

```yaml
# .github/workflows/ci.yml
- name: Check bundle size
  run: npm run build && node size-budget.js
```

### Tree-Shaking Verification

Ensure unused code is removed:

```javascript
// Bad: Not tree-shakeable
export function usedFunction() { }
export function unusedFunction() { }

// Good: Tree-shakeable with named exports
export const usedFunction = () => {};
export const unusedFunction = () => {};
```

Verify in bundle-report.html — unused exports should not appear in bundle.

### Compression

Gzip/Brotli compression for small bundle size:

```javascript
// webpack.config.js
const CompressionPlugin = require('compression-webpack-plugin');

module.exports = {
  plugins: [
    new CompressionPlugin({
      algorithm: 'gzip',
      test: /\.(js|css|html|svg)$/,
      threshold: 10240,  // Only files > 10KB
      minRatio: 0.8,
      deleteOriginalAssets: false,  // Keep original alongside gzip
    }),
  ],
};
```

Serve gzip automatically:

```pseudocode
middleware serveCompressed(request, response, next):
  // Check if client accepts gzip
  acceptEncoding = request.getHeader('Accept-Encoding') || ''

  if acceptEncoding.includes('gzip'):
    gzipPath = request.path + '.gz'
    if fileExists(gzipPath):
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('Content-Type', getContentType(request.path))
      return response.send(readFile(gzipPath))

  // Fallback to uncompressed
  next()
```

### Configuration Example

```env
# Bundle config
BUNDLE_ANALYSIS=false
ENABLE_COMPRESSION=true
SIZE_BUDGET_STRICT=true  # Fail build if budget exceeded
```

### Gotchas

1. **Duplication in chunks**: If vendor chunk is not set up correctly, same dependency can appear in multiple chunks. Use `reuseExistingChunk: true`.

2. **Async chunk loading**: If chunk fails to load (network error), app breaks. Implement retry:
   ```javascript
   window.__chunk_retry_count = {};

   window.addEventListener('error', (event) => {
     if (event.message?.includes('Loading chunk')) {
       const chunk = event.message.match(/chunk (\d+)/)?.[1];
       window.__chunk_retry_count[chunk] ||= 0;

       if (window.__chunk_retry_count[chunk] < 3) {
         window.__chunk_retry_count[chunk]++;
         location.reload();
       }
     }
   });
   ```

3. **Shared code bloat**: Common chunk can grow large if not monitored. Regularly audit what's in it.

4. **Circular dependencies**: Can prevent optimal splitting. Use tools to detect:
   ```bash
   npm install --save-dev circular-dependency-plugin
   ```

5. **Dynamic import overhead**: Each dynamic import adds overhead. Don't over-split (not every component should be lazy-loaded).

