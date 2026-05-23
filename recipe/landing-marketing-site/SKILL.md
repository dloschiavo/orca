---
name: landing-marketing-site
description: >
  Use when building the public marketing surface of a Goliath-stack app — the
  landing pages that sit alongside an Expo Router authenticated app and stay
  public even when the visitor is signed in. Covers the layout-level auth gate
  and route-based shell selection (so admin nav never bleeds into public
  pages), auth-aware Sign In CTAs that route logged-in visitors straight to
  the dash, a responsive landing header with a left-side mobile hamburger
  drawer, a branded footer, hero / feature-grid / showcase page patterns,
  Google Fonts injection on RN Web, top-anchored image cropping (workaround
  for missing `objectPosition`), the `lineHeight` pixel gotcha, asset-module
  vs URL gotchas with `require()`, and the DOM CustomEvent bridge that lets
  header/footer/hero CTAs open the public-contact-chat drawer.
dependencies:
  capabilities:
    auth: otp-auth
provides: [public-page]
---

# Landing Marketing Site

The public-facing marketing pages that live inside an Expo Router app alongside the authenticated product. Not a separate Next.js site, not a separate repo — just a set of routes under `app/` that are *explicitly allowed* through the auth gate and styled with a different shell (landing header + landing footer) from the in-app chrome. The key insight is that React Native Web gives you enough to ship a credible marketing site without a second tech stack, *if* you know the half-dozen gotchas that don't show up in the RN docs.

Reference implementation: `influencer-studio/twp.react/app/`:
- `app/_layout.jsx` — public-route gate + Google Fonts loader
- `app/index.jsx` — homepage with hero + sections
- `app/about.jsx` — content page with team grid (top-anchored image crop)
- `app/luxe-builder.jsx`, `app/influencer-studio.jsx` — product landing pages
- `components/landing/LandingHeader.jsx` — responsive header with mobile drawer
- `components/landing/LandingFooter.jsx` — branded footer with sign-in link

## Public Route Gate (`_layout.jsx`)

Marketing routes must bypass the auth redirect that protects the product. Add an `isPublicMarketing` segment check alongside whatever `isAuthRoute` logic already exists — and fold the root path into the same predicate so the homepage and every other marketing slug share one codepath:

```jsx
const segments = useSegments();
const isLanding = segments.length === 0;
const isPublicMarketing =
  isLanding ||
  segments[0] === 'about' ||
  segments[0] === 'luxe-builder' ||
  segments[0] === 'influencer-studio';

useEffect(() => {
  if (loading) return;
  if (!user && !inAuthGroup && !isPublicMarketing) {
    router.replace('/');
  } else if (user && inAuthGroup) {
    router.replace('/universe/apparel'); // whatever the app's default dash is
  }
}, [user, loading, inAuthGroup, isPublicMarketing, router]);
```

Every marketing path needs an explicit entry in the allowlist. **Why an allowlist, not a denylist:** the product is the default, and any new marketing page should be an intentional choice to leave auth — easy to miss if you inverted the check.

### Public chrome wins over logged-in chrome on marketing routes

The load-bearing rule: **public marketing routes always render with public chrome, regardless of session state.** If a logged-in operator visits `/influencer-studio`, they should see the exact same landing page a stranger would — `LandingHeader`, `LandingFooter`, `PublicChat` — with *no* admin sidebar spliced in. The instinct is to gate the shell on `if (!user) return <PublicShell/>; else return <AdminShell/>;`, which silently mixes admin nav into the public page the moment a teammate signs in. Gate on the *route*, not the *user*:

```jsx
// Public marketing + auth pages: public chrome only. This branch is taken
// whether or not the user is signed in — marketing routes never mix the
// logged-in sidebar into the public layout.
if (!user || isPublicMarketing) {
  return (
    <>
      <Slot />
      <PublicChat />
    </>
  );
}

// Authenticated product shell: sidebar + in-app chat.
return (
  <View style={{ flexDirection: 'row' }}>
    <Sidebar />
    <View style={{ flex: 1 }}><Slot /></View>
    <Chat />
  </View>
);
```

**Why:** marketing pages exist so operators can share them, preview copy changes, or send a link to a prospect from their own logged-in browser. If the page visibly mutates based on who's looking at it, the operator can't trust what the prospect will see, and the admin nav bleeds brand surface area into the public site. Also avoid auto-redirecting logged-in users away from `/` — `isLanding` should be inside `isPublicMarketing`, not a separate "send to dash" trigger, or a signed-in teammate can never reach their own homepage.

The only route that should bounce a logged-in user to the dash is the `/auth/*` group — there's no reason to show the OTP form to someone who already has a session.

## Google Fonts Loader

RN Web has no built-in way to load web fonts, but `<link rel="stylesheet">` still works — you just inject it yourself. Put this in `_layout.jsx` (once per app, at mount) so every page inherits the font stack:

```jsx
function GoogleFontsLoader() {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2' +
      '?family=ADLaM+Display' +
      '&family=Roboto+Slab:wght@400;500;700;900' +
      '&family=Roboto:wght@300;400;500;700' +
      '&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);
  return null;
}
```

Then in text styles reference the families by name:

```jsx
fontFamily: isWeb ? '"Roboto Slab", "Georgia", serif' : 'Georgia'
fontFamily: isWeb ? '"Roboto", "Helvetica", sans-serif' : undefined
fontFamily: isWeb ? '"ADLaM Display", "Georgia", serif' : 'Georgia'
```

Native falls back to bundled system fonts — nobody opens a marketing page in the mobile app, so that fallback is fine.

**Why inject in `useEffect` and not `index.html`:** the Expo Router dev server regenerates `index.html` and hand-edits get clobbered. Injecting from the layout keeps the font config inside the component tree and version-controlled.

## Responsive Header with Mobile Hamburger

One header, two layouts, switched on a width breakpoint. Desktop shows logo + nav links + right-cluster CTAs; mobile shows hamburger + logo + one primary CTA, with the full nav behind a left-side drawer.

```jsx
const MOBILE_BREAKPOINT = 900;
const { width } = useWindowDimensions();
const isMobile = width < MOBILE_BREAKPOINT;
const [drawerOpen, setDrawerOpen] = useState(false);

// Auto-close when resizing back to desktop
useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);

// Lock body scroll while drawer is open
useEffect(() => {
  if (Platform.OS !== 'web' || !drawerOpen) return;
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => { document.body.style.overflow = prev; };
}, [drawerOpen]);
```

### Hit target sizing

The single biggest "why does this feel janky" complaint on marketing headers is tiny click targets. Every nav link and CTA gets a generous Pressable with explicit padding, not a bare `<Text>` with `cursor: pointer`:

```jsx
<Pressable
  style={[webCursor, { paddingHorizontal: 18, paddingVertical: 14, borderRadius: 4 }]}
  onPress={...}
>
  <Text style={{ fontSize: 14, fontWeight: '500' }}>{link.label}</Text>
</Pressable>
```

14px vertical padding on a 14px font gives a comfortable ~42px hit target without looking bulky.

### Sign In routes to the dash when the visitor already has a session

Because public marketing routes render their public chrome for logged-in users too (see "Public chrome wins over logged-in chrome" above), the header/footer Sign In buttons need to be aware of auth state — otherwise a logged-in operator who clicks Sign In gets bounced through `/auth/login`, which the layout then redirects to the dash, producing a visible flicker. Read the auth context in the header and compute the href once:

```jsx
const { user } = useAuth();
// Logged-in visitors drop straight into the dash; everyone else goes to OTP.
const signInHref = user ? '/universe/apparel' : '/auth/login';
```

Mirror the same two-line pattern in the footer (and any in-body "Sign In" link). Don't try to centralize this in a route guard — the header has to make the click decision *before* navigation starts, not after, or the user sees the wrong intermediate page for a frame.

### Sign Up and Log In both route to the internal `/login`

A marketing header almost always wants two buttons — Sign Up and Log In — and the instinct is to point Log In at the "real" logged-in app (`https://product.example.com/login`) while Sign Up goes to the marketing site's own onboarding flow. **Don't.** If the project uses OTP/passwordless auth (see the `otp-auth` skill), the same `/login` route handles both cases silently: existing users sign in, new users get an account created on the fly. Wire both CTAs to the same internal route:

```tsx
<Link href="/login" asChild>
  <Pressable style={navLinkStyle}>
    <Text>Sign Up</Text>
  </Pressable>
</Link>
<Link href="/login" asChild>
  <Pressable style={navLinkStyle}>
    <Text>Log In</Text>
  </Pressable>
</Link>
```

Why not just one button? Users scan header CTAs for the word that matches their current intent — a returning customer looks for "Log In", a first-time visitor looks for "Sign Up" — and showing only one of them leaks a tiny amount of bounce. Two buttons to the same destination is the right move.

Pointing Log In at an external prod URL is a classic rabbit hole in the early phase of a landing site: there was a time when the prod form existed and the new internal one didn't, so it seemed harmless. It isn't — the external link breaks the SPA feel, fires a full page load, loses the marketing-site's chat bridge, and opens a new tab the user has to close to get back. Both buttons stay internal from day one.

### Pushing right-cluster CTAs to the viewport edge

Do **not** wrap the header row in `maxWidth: 1200; alignSelf: 'center'`. If you do, the Sign In / Contact buttons sit in the middle of the viewport and look stranded when a right-rail chat sidebar opens. Instead:

```jsx
<View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 32 }}>
  <View>{/* left cluster: hamburger + logo */}</View>
  {!isMobile && <View style={{ marginLeft: 32 }}>{/* desktop nav links */}</View>}
  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    {/* right cluster: Sign In + Contact */}
  </View>
</View>
```

`marginLeft: 'auto'` on the right cluster pins it to the viewport's right edge regardless of nav width. When a 420px chat sidebar slides in from the right, the CTAs get cleanly covered.

### Mobile drawer from the left

Drawer slides from the **left**, not the right. The right side of the viewport is reserved for the chat sidebar (see `public-contact-chat`). Backdrop is a full-screen Pressable that dismisses on tap:

```jsx
<Pressable
  onPress={() => setDrawerOpen(false)}
  style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 200 }}
/>
<View style={{
  position: 'fixed', top: 0, left: 0, bottom: 0,
  width: 280, maxWidth: '85%',
  backgroundColor: '#fff', zIndex: 201,
}}>
  {/* nav links + Sign In */}
</View>
```

Primary CTA on mobile is **Contact**, not Sign In — Sign In lives inside the drawer, not in the cramped top bar.

## Footer Pattern

Column grid of link groups + long copyright line. Two details that catch you out:

1. **Link colors default to purple** in RN Web (inherited `a` visited color). Override explicitly with the body text color (`#212121`) on every footer `<Text>`.
2. **Copyright string wraps unpredictably** unless you give it `flexShrink: 1` and `textAlign: 'right'` inside a row with `justifyContent: 'space-between'`. Without the shrink, long copyright breaks the footer row layout at narrow widths.

```jsx
<Text style={{ color: '#212121', fontSize: 14 }}>Sign In</Text>
<Text style={{ flexShrink: 1, textAlign: 'right', color: '#6c757d', fontSize: 13 }}>
  Goliath Influence Group is the marketing & advertising services division of Goliath Dynamics, Inc. © 2026, All rights reserved.
</Text>
```

## Hero Pattern

Background image + linear-gradient overlay + serif headline + sans subhead + primary CTA. The only interesting bit is the overlay — a single solid `rgba` is fine, but a 3-stop gradient reads more cinematic:

```jsx
<Image source={heroBg} resizeMode="cover" style={{ position: 'absolute', inset: 0 }} />
<View style={{
  position: 'absolute', inset: 0,
  ...(isWeb ? {
    backgroundImage: 'linear-gradient(135deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.35) 50%, rgba(0,0,0,0.15) 100%)',
  } : {
    backgroundColor: 'rgba(0,0,0,0.35)',
  }),
  pointerEvents: 'none',
}} />
```

Tune the darkest stop until the headline passes WCAG AA against the darkest region of the image — don't eyeball it, sample the underlying pixel. Users will tell you "the blue overlay is too dark" and then "it's still too dark" and then "it's still too dark" — start lighter than you think.

**Primary CTA in the hero should be the chat, not Sign In.** Sign In is for returning customers; the hero is for strangers. Use the DOM CustomEvent bridge (see below) to fire `open-public-chat`.

## Porting Bootstrap Feature Sections — Raw HTML, Not RN

When the prod design is a Bootstrap landing page (`.container > .row > .col-lg-6`) with an `.img-fluid` image on one side and a headline / paragraphs / testimonial on the other, **do not** rebuild the feature row in React Native components. Directly port the markup as raw HTML elements (`<section>`, `<div>`, `<img>`, `<h2>`, `<p>`) wrapped in `if (!isWeb) return null;`. You save a day of spacing debugging.

The reason is subtle but load-bearing: an RN `<Image>` inside a flex row needs an explicit `aspectRatio` (or `height`) to size itself, and if you get any of the numbers wrong (or forget to pass them on one of four feature sections), the image renders at its intrinsic pixel height — 1200+ px — and drags the flex row's cross-axis with it. You see "almost an entire viewport of empty space between features" and chase it through `alignItems`, `flex` tweaks, and aspect-ratio props, none of which are the actual bug. The browser's `<img>` element with `max-width: 100%; height: auto` is *literally what `.img-fluid` is*, and mirroring it verbatim sidesteps the entire class of errors.

```tsx
function FeatureSection({ reverse, headline, paragraphs, testimonial, imageSrc }) {
  if (!isWeb) return null;
  const imgUri = srcOf(imageSrc);

  const imageCol = (
    <div style={{ flex: '0 0 50%', maxWidth: '50%', padding: '0 15px', boxSizing: 'border-box' }}>
      <img src={imgUri} alt="" style={{ maxWidth: '100%', height: 'auto', display: 'block' }} />
    </div>
  );

  const textCol = (
    <div style={{ flex: '0 0 50%', maxWidth: '50%', padding: '0 15px', alignSelf: 'center', boxSizing: 'border-box' }}>
      <h2 style={{ fontSize: 36, fontWeight: 300, marginTop: 0, marginBottom: 25 }}>{headline}</h2>
      {paragraphs.map((p, i) => <p key={i} style={{ fontSize: 16, lineHeight: 1.7, marginBottom: 25 }}>{p}</p>)}
    </div>
  );

  return (
    <section style={{ padding: '0 0 100px' }}>
      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 15px', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', margin: '0 -15px' }}>
          {reverse ? <>{textCol}{imageCol}</> : <>{imageCol}{textCol}</>}
        </div>
      </div>
    </section>
  );
}
```

The native path (`return null`) is fine because nobody opens a marketing landing inside the app shell anyway. If you truly need a native version, build a separate native-only component — don't cross-compile one.

### Matching prod section padding exactly

Don't eyeball the vertical rhythm. Pull the numbers from prod's compiled CSS. For the reference Bootstrap template this skill draws from, features are `.section.pt-0` (padding: 0 0 100px), the gradient hero is `padding: 100px 0 170px`, and the CTA banner is `.section` (100px 0). Any divergence from these exact numbers and the page reads as "close but not right" — the hardest kind of bug to diagnose because nothing's obviously broken.

### `srcOf()` — Metro asset module to URL string

Once you're emitting raw `<img src={...}>`, you need a URL string, and `require('./foo.jpg')` gives you an opaque asset module. Bundlers expose the URL on different shapes depending on the platform and config — handle them all with one helper:

```ts
function srcOf(asset: any): string {
  if (!asset) return '';
  if (typeof asset === 'string') return asset;
  if (typeof asset === 'object' && typeof asset.uri === 'string') return asset.uri;
  if (typeof asset === 'object' && typeof asset.default === 'string') return asset.default;
  return '';
}
```

Use it for every asset that needs to cross the RN → HTML boundary (images, backgrounds, avatars in testimonials).

## `<Link asChild>` Children Cannot Receive Array Styles

This bites the second and third time you try to DRY up a nav link. Expo Router's `<Link asChild>` wraps its child in a `<Slot>` component that **rejects array-form styles** and throws at mount:

```
[expo-router]: You are passing an array of styles to a child of <Slot>.
```

Any style composition pattern you reach for — `style={[base, { paddingVertical: 4 }]}` or `style={[webCursor, hoverStyle]}` — fails the moment that child becomes a `<Link asChild>` descendant. The fix is to merge into a single object via spread:

```tsx
// Bad — throws at render
<Link href="/login" asChild>
  <Pressable style={[webCursor, { paddingHorizontal: 18 }]}>
    <Text>Sign In</Text>
  </Pressable>
</Link>

// Good — single object, no array
<Link href="/login" asChild>
  <Pressable style={{ ...webCursor, paddingHorizontal: 18 }}>
    <Text>Sign In</Text>
  </Pressable>
</Link>
```

Or, if you're reusing the same style across multiple `<Link asChild>` children, hoist the merged object to a const outside the component (`const navLinkStyle = { ...webCursor, paddingHorizontal: 20 };`) and pass it by reference. Don't try to compose it inline — every array you pass is a fresh throw site.

The failure mode is especially sneaky because `<Pressable style={[a, b]}>` is legal React Native everywhere else; you won't see the bug until you wrap a working Pressable in `<Link asChild>` for internal navigation.

## Replicating a Prod Design — Match It Exactly

When the brief is "replicate the existing prod landing page", **do it exactly** — same copy, same headline levels, same section padding, same card aspect ratios, same fonts, same image assets. Do not substitute stock photos "for now", do not rewrite the headline "for clarity", do not collapse two paragraphs into one for brevity. Every substitution becomes a rabbit hole the user has to drag you out of one at a time: first the photos, then the typography, then the spacing, then the copy. Burn the hours once up front — scrape the CSS, download the real assets, port the markup — and the result is right on the first reload. Over-engineering a "cleaner" version of the prod layout is a failure mode with a negative learning curve: the more you polish your interpretation, the further you drift from what was asked for.

## Top-Anchored Image Crop (RN Web gotcha)

React Native Web does **not** honor `objectPosition` on `<Image style={...}>` — it renders Image as a div with a background-image, and background-position is only sometimes plumbed through. This bites hardest on team/bio grids where a vertical portrait gets cropped center-center and chops off the subject's head.

The reliable workaround: a wrapper View with `overflow: hidden` and an absolutely-positioned Image that's taller than the wrapper, anchored at `top: 0`. Compute the scaled height from the source dimensions:

```jsx
function TeamMember({ src, srcW, srcH, name }) {
  const WRAPPER_W = 150;
  const WRAPPER_H = 150;
  const scaledH = Math.round(WRAPPER_W * srcH / srcW); // taller than wrapper for portraits
  return (
    <View style={{ width: WRAPPER_W, height: WRAPPER_H, overflow: 'hidden', borderRadius: 8 }}>
      <Image
        source={src}
        style={{ position: 'absolute', top: 0, left: 0, width: WRAPPER_W, height: scaledH }}
        resizeMode="cover"
      />
    </View>
  );
}
```

Pass `srcW` and `srcH` as data, one entry per team member. **Do NOT use `Image.resolveAssetSource()`** — it doesn't exist on RN Web and throws `_Image.default.resolveAssetSource is not a function`. Hand-measure the source assets once and embed the numbers.

## Asset-Module vs URL Gotchas

`require('../assets/logo.png')` in an Expo project returns an **asset module** (an opaque object), not a URL string. You cannot:

- Pass it to a native `<img src={...}>`
- Concatenate it into a CSS `backgroundImage: url(...)`
- Pass it to `Image.resolveAssetSource()` (doesn't exist on web — see above)

You *can* pass it directly to a React Native `<Image source={...}>`, which is almost always what you want:

```jsx
const logo = require('../../assets/logo.png');
<Image source={logo} style={{ width: 38, height: 38 }} resizeMode="contain" />
```

If you truly need the URL (to inject into a dynamic `<link>` or CSS background), import it as an ES module from a web build config — or just use a stable public path like `/assets/img/logo.png`.

## `lineHeight` Pixel Gotcha

React Native's `lineHeight` is **pixels**, not a CSS-style multiplier. Writing `lineHeight: 1.15` on a 52px headline collapses every line to 1.15 pixels tall — the text literally disappears. Always use absolute pixel values that are proportional to the font size:

```jsx
// For a 52px headline on web, 32px on native:
fontSize: isWeb ? 52 : 32,
lineHeight: isWeb ? 60 : 38,
```

Rule of thumb: `lineHeight ≈ fontSize * 1.15` — compute once and write the literal.

## Flipping Bundled Images

Occasionally a team portrait ships to the marketing site in the wrong horizontal orientation (old asset, mirrored selfie, etc.). Flip in place with the macOS `sips` tool — no need for Photoshop or a re-export:

```bash
sips -f horizontal assets/team-dave.png --out assets/team-dave.png
```

Commit the flipped file directly; don't ship a runtime `scaleX: -1` transform — it also flips any text, initials, or badge overlays on the image.

## DOM CustomEvent Bridge (Header/Footer/Hero → Chat Drawer)

The marketing site has multiple chat entry points: header "Contact" button, hero primary CTA, footer link, maybe an in-body `<Request Demo>` button. None of these should drill `setOpen` through props. Use a DOM CustomEvent dispatched from anywhere and listened to inside `PublicChat`:

```jsx
// Anywhere in the marketing tree
onPress={() => { if (isWeb) window.dispatchEvent(new Event('open-public-chat')); }}

// Inside PublicChat.jsx
useEffect(() => {
  if (Platform.OS !== 'web') return;
  const handler = () => setOpen(true);
  window.addEventListener('open-public-chat', handler);
  return () => window.removeEventListener('open-public-chat', handler);
}, [setOpen]);
```

Web-only. For native, use a module-level event emitter or a Zustand store. This pattern is documented more fully in the `public-contact-chat` skill — cross-reference there when implementing.

## Fit-to-Project

Before implementing, check:

- **Auth gate location.** Where does the app decide whether the user needs to log in? That's the file that needs the `isPublicMarketing` allowlist.
- **Product vs marketing URL collisions.** If the product already uses `/about`, the marketing page needs a different slug (`/company` or similar) — Expo Router picks the first match.
- **Font family.** The reference impl uses ADLaM Display + Roboto Slab + Roboto to match goliathinfluence.com. Match whatever your brand system specifies. Google Fonts is the right default; a brand-licensed font means hosting it yourself and a `@font-face` block inside the same injected stylesheet.
- **Breakpoint.** 900px works for 2-nav-link headers; if you have 4+ links, bump to 1024px or the nav will wrap before the hamburger kicks in.
- **Mobile drawer primary CTA.** Default is Contact (chat). If your marketing site leans on signup instead of chat, swap to Sign Up — but keep exactly one primary CTA on mobile, not two.
- **Footer copyright shape.** One long company-hierarchy sentence (the reference) vs a short `© 2026 Brand` depends on corporate/legal requirements. The `flexShrink` + right-align pattern handles both.
- **Is there a public-contact-chat sidebar?** If yes, the header right cluster must use `marginLeft: 'auto'` (no centered max-width container). If no, either is fine.
- **Team grid source assets.** Do you have the source dimensions, or do you need to measure each image once? Dimensions are per-member data — hard-code them next to the name and role.

## Anti-Patterns

- **`lineHeight: 1.15`** — RN treats this as 1.15 pixels, not a multiplier, and the headline collapses to a thin line of pixels. Use an absolute value (`lineHeight: 60` for a 52px font).
- **`Image.resolveAssetSource(require(...))`** — doesn't exist on RN Web and throws at runtime. Hand-measure source assets and embed the width/height as data, or use intrinsic fallback.
- **`objectPosition: 'center top'` on `<Image style={...}>`** — RN Web renders Image as a div with background-image and silently drops the position. Use the wrapper-div + absolute-taller-Image pattern to top-anchor a crop.
- **Passing `require('./img.png')` as an `<img src>`** — Metro returns an asset module, not a URL. Use `<Image source={...}>` or a stable public path.
- **Hand-editing `index.html` for Google Fonts** — the Expo dev server regenerates it. Inject the `<link>` from a `useEffect` in `_layout.jsx` instead.
- **`maxWidth: 1200; alignSelf: 'center'` on the header row** — the right-cluster CTAs end up stranded in the middle of the viewport when a right-rail chat sidebar opens. Use full width + `marginLeft: 'auto'` on the right cluster.
- **Mobile drawer from the right** — the right side is reserved for the chat sidebar on the same site. Slide from the left.
- **Two primary CTAs in the mobile top bar** — pick one (Contact). Put Sign In inside the drawer.
- **Sign In as the hero primary CTA** — the hero targets strangers, not returning customers. Sign In belongs in the footer and behind the hamburger. The hero CTA should open the chat.
- **Footer link `<Text>` without an explicit color** — inherits browser `a:visited` purple in RN Web. Always set `color: '#212121'` (or your body text color) on footer links.
- **Copyright `<Text>` without `flexShrink: 1`** — long company-hierarchy strings blow up the footer row at narrow widths. Add `flexShrink: 1` + `textAlign: 'right'`.
- **Runtime `transform: [{ scaleX: -1 }]` to flip a team portrait** — also flips any text or badge in the image. Flip the asset on disk with `sips -f horizontal` and commit the result.
- **Denylist-style public route gate** (`if (segments[0] !== 'product') allow`) — any new marketing slug silently escapes auth. Keep it an allowlist.
- **Gating the app shell on `user` instead of the route** (`if (!user) <PublicShell/>; else <AdminShell/>`) — a logged-in operator visiting `/influencer-studio` ends up with the admin sidebar spliced into the public landing page, which mixes brand surfaces, leaks internal nav to any over-the-shoulder observer, and makes it impossible to preview marketing changes from a signed-in browser. Gate on `isPublicMarketing`, so the branch becomes `if (!user || isPublicMarketing) <PublicShell/>`.
- **Auto-redirecting logged-in users off the homepage** (`if (user && isLanding) router.replace('/dash')`) — signed-in teammates can never reach their own `/` to QA landing changes, and shared marketing links become second-class for anyone already authenticated. Only the `/auth/*` group should bounce logged-in users into the dash.
- **Pointing the Sign In button at `/auth/login` unconditionally** — a logged-in visitor who clicks it on a public marketing page flashes through the OTP form before the layout redirect kicks in, producing a visible flicker and a split second of "why is it asking me to log in again?". Read `useAuth()` in the header/footer and compute `signInHref = user ? '/dash' : '/auth/login'` before the click.
- **Tiny Pressable padding on nav links** — 4–6px padding makes the hit target feel janky. 14–18px padding + explicit `borderRadius` gives the header the "real site" feel.
- **Rebuilding Bootstrap feature rows with RN `<View>` + `<Image>` + aspectRatio** — any missing or wrong `aspectRatio` prop on one of several feature sections silently renders the image at its intrinsic pixel height and drags the flex row into a near-viewport-tall empty space. You'll chase it through `alignItems` and `flex` tweaks for hours. Raw HTML `<img>` with `max-width: 100%; height: auto` is what `.img-fluid` actually is — port the markup verbatim.
- **Substituting "placeholder" content when replicating prod** — stock Unsplash photos, reworded headlines, emoji icons "just to start". Every substitution has to be walked back one at a time. Match prod exactly on the first pass: scrape the CSS, download the real assets, port the markup.
- **Eyeballing section padding instead of pulling numbers from prod's CSS** — "almost right" vertical rhythm is the hardest kind of bug to diagnose because nothing looks obviously broken. Read the compiled stylesheet and write the exact numbers.
- **Passing `require(...)` asset modules to raw `<img src>`** — Metro returns an opaque object, not a URL string. Use a `srcOf()` helper that unwraps `string | {uri} | {default}` shapes before hitting the DOM boundary.
- **Array-form styles on any child of `<Link asChild>`** — expo-router's internal `<Slot>` rejects them at mount with `You are passing an array of styles to a child of <Slot>`. Merge into one object with spread, or hoist a const.
- **Header Log In button pointing to an external prod URL** — breaks the SPA feel, fires a full page load, loses the marketing-site chat bridge. Both Sign Up and Log In go to the same internal `/login` route; the OTP form handles sign-up and sign-in transparently.
- **Left-over `useRouter` import after removing navigation** — Expo Router throws an unused-import warning and the CI noise hides real issues. Clean up after refactors.

## Logging

Marketing pages don't log much — they're static-ish. But:

- Log the public-route gate decision once per navigation (`[layout] public=${isPublic} auth=${!!session} path=${segments.join('/')}`) during dev. Helps debug why a marketing route suddenly started redirecting to login when you rename a segment.
- Log Google Fonts load failures. The `<link>` element's `onerror` handler should console.warn with the href so you see it when Google Fonts is blocked (ad blockers, corporate proxies).
- Don't log CTA clicks from here — that belongs in a real analytics integration, not the skill.
