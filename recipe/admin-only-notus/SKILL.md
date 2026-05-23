---
name: admin-only-notus
description: >
  Use when building any internal/admin page in a Goliath React Native + Expo
  Router app. Codifies the Notus React design system as it actually lives in
  the codebase: the blueGray + lightBlue palette (no plain gray, no plain
  blue), the canonical card surface, the canonical form input, the
  primary/secondary/destructive button trio, the paired-color status badge,
  the standard page-layout shell, and the color decision matrix. Includes a
  pre-flight checklist and a list of recurring violations (chat textarea pill
  shape, inline styles in PublicChat, hardcoded hex colors) that this recipe
  exists to stop. Reference implementation: diplomat-app. THIS RECIPE IS FOR
  ADMIN/INTERNAL PAGES ONLY AND MUST NOT SHARE ANY LAYOUT, DESIGN, OR ASSET
  FILES WITH PUBLIC PAGES.
dependencies:
  requires: [admin-routing]
provides: [design-system]
---

# Admin-Only Notus React Styling

## HARD ISOLATION RULE — READ FIRST, NO EXCEPTIONS

**This recipe is for admin/internal pages ONLY. It MUST NOT share ANY common layout, design, or asset files with public-facing pages. When installing this recipe you MUST NOT touch any public files.**

**Why this recipe is called admin-ONLY:** there exist other Goliath sites where Notus is used for *everything* — public marketing pages AND admin pages — and on those sites a single shared set of layout/design/asset files is the correct architecture. **This recipe is not for those sites.** This recipe is specifically for sites where admin and public must be kept disjoint, because past changes to shared layout/design/asset files have repeatedly broken the public side while trying to fix the admin side (and vice versa). The whole point of `admin-only-notus` is to eliminate the shared-file blast radius: the admin side has its own palette entries, its own header, its own footer, its own layout shell, its own components, and its own assets, and nothing an admin-side edit can touch will ever propagate to a public page, because there is no file they both consume.

If the target site uses Notus for public as well and the user wants a shared setup, **do not install this recipe** — it is the wrong tool. Ask the user which mode they want before installing.

Specifically forbidden when installing this recipe:

- **No shared header.** The admin header (`AdminNavbar`) is admin-only. Do not import it into any public page. Do not extract a "common" header that both admin and public consume. Public pages use the header from `landing-marketing-site`; the two headers are separate files that happen to be in the same repo and nothing more.
- **No shared footer.** `FooterAdmin` is admin-only. Public pages have their own footer from `landing-marketing-site`. Never merge them. Never extract a common `<Footer>`.
- **No shared CSS / Tailwind entries / design tokens / palette with public.** The palette and class-string conventions in this recipe are admin-scoped. Do not widen them to accommodate a public page, and do not reach into this recipe's palette from a public page. If public needs colors, public defines its own.
- **No shared layout shell.** The `<ScrollView> → <AdminNavbar /> → content container` shell in § Page Layout Shell is admin-only. Public pages use the layout from `landing-marketing-site` and never wrap themselves in admin primitives, and admin pages never wrap themselves in public primitives.
- **No shared cards, inputs, buttons, badges, tables, or icon conventions with public.** Every canonical component in this recipe is admin-only. If a public page looks similar, that is coincidence, not shared code. Do not extract a "common" version "to DRY things up."
- **No shared asset files** (fonts, images, SVGs, icon sets, global stylesheets, Google Fonts injection) between admin and public. If admin needs an asset, it lives under an admin-only path and is imported only from admin routes.
- **No common layout wrappers above the route group.** If you find yourself editing a root `_layout.tsx`, a provider, a theme context, or any file that both admin and public routes consume, STOP — this recipe has no business there.

**When installing this recipe you MUST NOT touch any public files.** Do not edit `landing-marketing-site` routes, public layouts, public components, public styles, public assets, or any file under a public route group. Do not edit a root layout in a way that affects public. Do not edit `tailwind.config.js` in a way that changes colors public pages already use. If a change you're about to make would modify a public file, stop — it does not belong in this install.

If you find yourself typing the words "shared," "common," "global," "unified," "DRY," or "extract" while installing this recipe, you are about to violate the isolation rule. Back up.

## Notus React Styling for Internal Pages

Goliath internal/admin UIs use the **Notus React** design system (Creative Tim) ported into React Native + NativeWind. This recipe exists because the conventions get ignored on every other page implemented from scratch — somebody reaches for `bg-gray-100` or `border-blue-200` or invents their own button shape, the page ships, and the result is a screen that looks visibly off next to every other admin screen in the app.

This is not a style guide written in the abstract. It is the *exact* class strings, color decisions, and layout shells that already exist in `diplomat-app/components/`. Quote them verbatim. Don't paraphrase, don't "improve," don't substitute the colors you happened to use in another project.

## The One Rule

**Every internal page must use only the `blueGray` and `lightBlue` palettes for neutrals and brand. Status colors (red/emerald/orange/purple/pink) are allowed, but only via `*-100` backgrounds with `*-700` text, never raw `*-500`/`*-600` for text on light surfaces.**

If you find yourself typing `bg-gray-`, `text-gray-`, `border-gray-`, `bg-blue-`, `text-blue-`, or `border-blue-` (without the `lightBlue` or `blueGray` prefix), stop. You are about to ship a page that doesn't match the rest of the app. The Tailwind config below is the authoritative source — anything outside it is wrong.

## Tailwind Config — The Palette

The colors below are the only neutrals + brand allowed on internal pages. Drop them verbatim into `tailwind.config.js`:

```js
module.exports = {
  // ...
  theme: {
    extend: {
      colors: {
        // Notus blueGray — primary neutral. Replaces every use of `gray`.
        blueGray: {
          50:  "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        // Notus lightBlue — primary brand. Replaces every use of `blue`.
        lightBlue: {
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
          700: "#0369a1",
          800: "#075985",
        },
      },
    },
  },
};
```

If `gray` and `blue` are still in scope from Tailwind defaults, you *will* type them by accident at 11pm. Two options:

1. **Preferred:** Override them to alias the Notus palette so accidents are still on-brand:
   ```js
   colors: {
     gray:    require("tailwindcss/colors").slate,  // closest to blueGray
     blue:    require("./palette").lightBlue,
     blueGray: { ... },
     lightBlue: { ... },
   }
   ```
2. **Acceptable:** Leave defaults in scope but enforce via lint — a `tailwindcss/no-custom-classname` rule with an allowlist that excludes `bg-gray-*` / `bg-blue-*`.

## The Canonical Card Surface

Every "card" on every internal page is exactly this:

```tsx
<View className="relative flex flex-col min-w-0 break-words w-full mb-6 shadow-lg rounded-lg bg-white">
  {/* card content */}
</View>
```

Variants — only these are allowed:

| Variant | When to use | Add classes |
|---|---|---|
| **Standard** | Default. Almost every card. | (none — the base above) |
| **With border** | Cards inside dense lists (job queue rows, audit log entries) | `border border-blueGray-100` |
| **Dark surface** | The "alternate" card on a dashboard for visual rhythm | swap `bg-white` → `bg-lightBlue-800` and flip text/borders to `lightBlue-300`/`lightBlue-700` |
| **Heavier shadow** | Modal dialog content, profile hero card | `shadow-xl` instead of `shadow-lg` |

**Forbidden variants:** `shadow-sm`, `shadow-none`, `rounded` (without `-lg`), `bg-blueGray-50` as a card background, `border-2`, custom `borderRadius` inline style. If your card needs one of these, the answer is no — it needs to look like every other card.

The card header (when present) is a row at the top with a bottom border:

```tsx
<View className="flex flex-row items-center justify-between px-6 py-4 border-b border-blueGray-200">
  <Text className="font-semibold text-lg text-blueGray-700">Card Title</Text>
  {/* optional right-side action button */}
</View>
```

`px-6 py-4` for the header, `px-6 py-6` for the body. Don't use `p-4` on a card body — it crowds content against the edge.

## The Canonical Form Input

There is **one** form input style. It is used by login forms, profile forms, settings forms, modals, the prompt manager textarea, the admin user edit form, the admin org create form, and **the chat input** (see § Chat Textarea — Stop Reinventing It).

```tsx
<TextInput
  className="bg-blueGray-50 border border-blueGray-200 rounded px-3 py-2 text-sm text-blueGray-700 w-full"
  placeholderTextColor="#94a3b8"  // blueGray-400
  // multiline + textAlignVertical="top" for textareas
/>
```

Required pieces:

- **Background:** `bg-blueGray-50` (light gray). Never `bg-white` on an input — white inputs disappear inside white cards.
- **Border:** `border border-blueGray-200`. Never borderless. Never `border-2`.
- **Radius:** `rounded` (4px). Never `rounded-full`, never `rounded-lg`, never `rounded-md`.
- **Padding:** `px-3 py-2` for single-line, `px-3 py-3` for textareas (more vertical breathing room when multiline).
- **Text:** `text-sm text-blueGray-700`. Never `text-base`, never `text-blueGray-800` (too dark), never `text-blueGray-500` (too pale — that's placeholder color).
- **Placeholder:** `placeholderTextColor="#94a3b8"` (blueGray-400). Required prop. RN doesn't read placeholder color from className.

For textareas, add:
```tsx
multiline
textAlignVertical="top"
style={{ minHeight: 120, lineHeight: 20, ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}) }}
```

The `outlineStyle: "none"` is the only acceptable inline style on a textarea — it kills the ugly browser focus ring on web. Everything else lives in className.

Labels above inputs:

```tsx
<Text className="uppercase text-blueGray-600 text-xs font-bold mb-2">Display Name</Text>
```

`uppercase`, `text-xs`, `font-bold`, `text-blueGray-600`, `mb-2`. Not `text-sm`, not `text-blueGray-700`, not titlecase. Notus labels are always shouty caps — when in doubt, copy a label from `app/login.tsx`.

### Chat Textarea — Stop Reinventing It

The chat input bar in `components/Chat.tsx` is a TextInput like any other and **must use the canonical form input className above**, not a pill-shaped variant, not a shadowless borderless variant, not anything custom. If the chat looks wrong it is almost always because somebody decided to "make it feel chatty" with `rounded-full px-4 py-2` and no border.

**Wrong** (the version that keeps getting shipped):
```tsx
<TextInput
  className="flex-1 bg-blueGray-50 rounded-full px-4 py-2 text-sm text-blueGray-800"
  multiline
/>
```

**Right** (matches every other input in the app):
```tsx
<TextInput
  className="flex-1 bg-blueGray-50 border border-blueGray-200 rounded px-3 py-3 text-sm text-blueGray-700"
  placeholderTextColor="#94a3b8"
  multiline
  textAlignVertical="top"
/>
```

The send button next to it is a normal primary button (see below) with the FA5 `paper-plane` icon, **not** a circular FAB shape. Reserve circular shapes for the chat *trigger* (the FAB that opens the drawer in the bottom-right corner of the page) — once you're inside the drawer, every control is square-cornered like the rest of the app. See `chat-support/SKILL.md` § Input Bar Styling.

## Buttons

There are exactly three button shapes. Memorize them.

### Primary action — `bg-lightBlue-500`

```tsx
<Pressable className="bg-lightBlue-500 active:bg-lightBlue-600 px-4 py-2 rounded shadow">
  <Text className="text-white font-bold uppercase text-xs">Save Changes</Text>
</Pressable>
```

- Background: `bg-lightBlue-500`. Pressed: `bg-lightBlue-600`.
- Text: white, **bold**, **uppercase**, **text-xs**. Not text-sm. Not titlecase. Not normal weight.
- Padding: `px-4 py-2`.
- Shadow: `shadow` (the small one), not `shadow-lg`.
- Radius: `rounded` (4px).

Use this for: Save, Submit, Create, Send, Confirm, Apply.

### Secondary / Cancel — outline only

```tsx
<Pressable className="px-4 py-2 rounded border border-blueGray-200">
  <Text className="text-sm text-blueGray-600">Cancel</Text>
</Pressable>
```

- No background. Just a border.
- Text: `text-sm text-blueGray-600`. Not uppercase, not bold. Cancel is a *quiet* button — the primary should always be louder.
- Same padding and radius as primary.

Use this for: Cancel, Close, Back, Reset.

### Destructive — `bg-red-500`

```tsx
<Pressable className="bg-red-500 active:bg-red-600 px-4 py-2 rounded">
  <Text className="text-white font-bold uppercase text-xs">Delete</Text>
</Pressable>
```

Same as primary but red instead of lightBlue, and **no shadow** (destructive buttons are weighty enough on color alone — adding shadow makes them shout).

Use this for: Delete, Sign Out, Revoke, Suspend.

**Forbidden:** `bg-red-100` with `text-red-700` for a destructive *button*. That color pair is for **status badges** (see below), not buttons. A badge says "this thing is in a bad state"; a button says "do something irreversible." They look different on purpose.

### Icon-only buttons

```tsx
<Pressable onPress={...} className="p-2">
  <FontAwesome5 name="times" size={16} color="#94a3b8" />
</Pressable>
```

- Use `@expo/vector-icons` `FontAwesome5`. Never emojis. Never inline SVG. Never `<Text>×</Text>`.
- Color: `#94a3b8` (blueGray-400) for neutral icons, `#0ea5e9` (lightBlue-500) for active/selected, `#ef4444` (red-500) for destructive.
- Pad with `p-2` so the touch target is at least 36×36 even when the icon is 16px.

## Status Badges — Paired Colors

A status badge is a small pill that communicates state (Active, Suspended, Bounced, Processing, Failed). The color must always be a *paired* `bg-X-100` + `text-X-700` from the same hue:

```tsx
<View className="rounded-full px-2 py-0.5 self-start bg-emerald-100">
  <Text className="text-xs font-semibold text-emerald-700">Active</Text>
</View>
```

The full palette:

| State | bg | text | Usage |
|---|---|---|---|
| Active / success / completed | `bg-emerald-100` | `text-emerald-700` | "Active", "Completed", positive trend |
| Info / processing | `bg-lightBlue-100` | `text-lightBlue-700` | "Processing", "In progress" |
| Warning / pending | `bg-orange-100` | `text-orange-700` | "Pending", "Suspended", "Unresponsive" |
| Error / destructive state | `bg-red-100` | `text-red-700` | "Failed", "Bounced", "Deleted" |
| Premium / featured | `bg-purple-100` | `text-purple-700` | "Enterprise plan" |
| Neutral / default | `bg-blueGray-100` | `text-blueGray-600` | "Free plan", custom user role, "Queued" |

Badge shape is **always** `rounded-full px-2 py-0.5 self-start`. The `self-start` is critical — without it the badge stretches to fill its parent's cross-axis and you get a weird capsule that spans the whole table cell.

**Anti-pattern:** applying the bg class to *both* the wrapping View *and* the inner Text. This is the bug from earlier in `admin/users/index.tsx` — the inner Text gets its own background and you see two pills overlapping. Always: bg on the View, text color on the Text. Never both.

## Page Layout Shell

Every internal page wraps its content in this shell. No exceptions:

```tsx
import { ScrollView, View } from "react-native";
import { AdminNavbar } from "@/components/navigation";

export default function SomeAdminPage() {
  return (
    <ScrollView className="flex-1">
      <AdminNavbar title="Page Title" />
      <View className="px-4 md:px-10 mx-auto w-full mt-6">
        {/* page content lives here */}
      </View>
    </ScrollView>
  );
}
```

- **`<ScrollView className="flex-1">`** — fills the parent. The `(app)/_layout.tsx` already sets up the sidebar; this scroll view occupies the right pane.
- **`<AdminNavbar title="..." />`** — every internal page has the blue header bar. Pass `title` for the breadcrumb. Skipping the navbar means losing the org switcher and the profile menu, both of which users expect on every page.
- **Content container:** `className="px-4 md:px-10 mx-auto w-full mt-6"`. Responsive horizontal padding (4 on mobile, 10 on md+), centered with `mx-auto`, top margin `mt-6` to clear the navbar.

When a page has `<HeaderStats />` directly under the navbar (dashboard-style), the content container drops `mt-6` and uses `-mt-24` so the first row of cards overlaps the blue header — Notus's signature look.

```tsx
<ScrollView className="flex-1">
  <AdminNavbar title="Dashboard" />
  <HeaderStats stats={DEMO_STATS} />
  <View className="px-4 md:px-10 mx-auto w-full -mt-24">
    {/* cards float up over the navbar's bottom edge */}
  </View>
</ScrollView>
```

Don't reach for `-mt-24` unless `<HeaderStats />` is on the page. On a plain admin page (Users list, Orgs list), it just yanks the content into the navbar and looks broken.

### Multi-column rows

Inside the content container, use a flex-wrap row with proportional widths:

```tsx
<View className="flex flex-row flex-wrap">
  <View className="w-full xl:w-8/12 px-2 mb-4">
    {/* big card */}
  </View>
  <View className="w-full xl:w-4/12 px-2 mb-4">
    {/* small card */}
  </View>
</View>
```

- Column wrappers always have `px-2` (gutter) and `mb-4` (vertical spacing between rows on mobile).
- Use `w-full` as the mobile default, then `md:w-X/12` or `xl:w-X/12` for larger breakpoints.
- 12-column grid: `w-6/12`, `w-8/12`, `w-4/12`, `w-3/12`. Don't invent fractional widths.

### Tables fill their card

This is the bug from the users/orgs admin tables: a horizontal `<ScrollView>` was sizing its inner content to the sum of `minWidth`s, leaving the right half of the card empty. The fix is to use a regular `<View>` and give each column a `flex` weight, not a `minWidth`:

```tsx
<View className="w-full">
  <View className="flex flex-row bg-blueGray-50 border-b border-blueGray-100">
    {COLUMNS.map(col => (
      <View key={col.label} className="px-4 py-3" style={{ flex: col.flex }}>
        <Text className="text-xs uppercase font-semibold text-blueGray-500">{col.label}</Text>
      </View>
    ))}
  </View>
  {rows.map(row => (
    <View key={row.id} className="flex flex-row border-b border-blueGray-100">
      <View className="px-4 py-3" style={{ flex: 5 }}>
        <Text className="text-xs text-blueGray-700">{row.email}</Text>
      </View>
      {/* ...etc */}
    </View>
  ))}
</View>
```

Header cells use `bg-blueGray-50`, `text-xs uppercase font-semibold text-blueGray-500`, `border-b border-blueGray-100`. Body cells use `text-xs text-blueGray-700` (or `text-blueGray-600` for secondary columns). Row borders are `border-b border-blueGray-100` — never `border-blueGray-200` (too dark for table internals).

## Color Decision Matrix

When you reach for a color, the answer is in this table. If it's not in the table, you don't need it.

| Need | Class |
|---|---|
| Page background | `bg-blueGray-100` (RN parent) |
| Card background | `bg-white` |
| Input background | `bg-blueGray-50` |
| Modal backdrop | inline `backgroundColor: "rgba(0,0,0,0.5)"` |
| Body text (primary) | `text-blueGray-700` |
| Body text (secondary) | `text-blueGray-600` |
| Muted text / metadata | `text-blueGray-400` or `text-blueGray-500` |
| Placeholder text | `placeholderTextColor="#94a3b8"` |
| Heavy border | `border-blueGray-200` |
| Subtle border | `border-blueGray-100` |
| Brand action / link | `text-lightBlue-500` or `text-lightBlue-600` |
| Active nav item | `text-lightBlue-500 font-bold` (icon `#0ea5e9`) |
| Inactive nav item | `text-blueGray-700` (icon `#cbd5e1`) |
| Section divider | `h-px bg-blueGray-200 my-4` |
| Header bar (the blue one) | `bg-lightBlue-600` |
| Destructive action | `bg-red-500` button or `text-red-500`/`text-red-600` text |

Anything else — `bg-slate-`, `bg-zinc-`, `bg-cyan-`, `text-sky-` — is wrong.

## Component Patterns (Reference)

The shapes below are the prebuilt components in `components/`. Quote them whenever a new page needs the same affordance — don't roll your own.

### `<AdminNavbar title="..." />`

Blue header bar. `bg-lightBlue-600 pb-32 pt-12 md:pt-6`. Contains:
- Breadcrumb (small white uppercase, 60% opacity)
- Page title (white, lg, semibold, capitalize)
- Search input (transparent, white text)
- Org switcher (white pill, native `<select>` on web)
- Profile dropdown (FA5 user-circle → menu with white bg + shadow)

The header is intentionally tall (`pb-32`) so dashboard-style pages can overlap the bottom edge with their first card row via `-mt-24`.

### `<Sidebar sections={[...]} />`

White sidebar with shadow. `bg-white shadow-xl py-4 px-6`. Each section:
- Section title: `text-blueGray-500 text-xs uppercase font-bold pt-1 pb-2 mt-2`
- Link rows: `py-3 flex flex-row items-center`, with FA5 icon at `#0ea5e9` (active) or `#cbd5e1` (inactive), label `text-xs uppercase font-bold`
- Active link: `text-lightBlue-500`. Inactive: `text-blueGray-700`.

### `<CardStats title="..." value="..." icon="..." iconColor="..." change="..." changeUp />`

The four-up KPI cards on dashboards. Each is the canonical card surface plus:
- Title: `text-blueGray-400 uppercase font-bold text-xs`
- Value: `font-semibold text-xl text-blueGray-700`
- Icon circle: 48×48, `rounded-full shadow-lg`, FA5 icon white on a status color (`bg-red-500` / `bg-orange-500` / `bg-pink-500` / `bg-lightBlue-500`)
- Trend: `text-emerald-500` (up) or `text-red-500` (down) with FA5 arrow

### `<CardTable title="..." columns={...} data={...} color="light" />`

Tabular card. Light variant uses the canon (`bg-white`, `bg-blueGray-50` headers, `text-blueGray-700` rows). Dark variant: `bg-lightBlue-800` card, `text-lightBlue-300` headers, white rows. Use light by default; use dark only for the second card on a row of two for visual rhythm.

### `<CardSettings />` / `<CardProfile />`

Settings form card and profile hero card. Both use the canonical surface. Settings card uses the canonical form input pattern; profile card has a 128×128 round avatar (`bg-blueGray-200`, initials `text-blueGray-500 text-4xl font-bold`).

### `<JobCard job={...} />`

Used by the prompt queue UI. Canonical card with `border border-blueGray-100`, status badge in the top-right (paired colors), monospace prompt body in `bg-blueGray-50` with `border-blueGray-200`.

### `<FooterAdmin />`

`py-4 px-4 md:px-10`. Single line: `text-sm text-blueGray-500 font-semibold`.

## Pre-Flight Checklist

Before you ship a new internal page, run down this list. Every check is a violation that has actually happened on a previous page and produced a "this looks wrong" comment in code review.

- [ ] **Palette.** No `bg-gray-`, `text-gray-`, `border-gray-`, `bg-blue-`, `text-blue-`, `border-blue-`, `bg-slate-`, `bg-zinc-`, `text-sky-`. Only `blueGray` and `lightBlue` for neutrals/brand. (Status colors emerald/orange/red/purple/pink are allowed in the paired-100/700 form.)
- [ ] **Cards.** Every card uses the canonical class string. No `shadow-sm`, no `rounded-md`, no card-as-input-background.
- [ ] **Inputs.** Every TextInput is `bg-blueGray-50 border border-blueGray-200 rounded px-3 py-2 text-sm text-blueGray-700`. No `rounded-full`, no `rounded-lg`, no missing border, no `bg-white` input.
- [ ] **Placeholders.** Every TextInput has `placeholderTextColor="#94a3b8"`. RN won't read it from className.
- [ ] **Labels.** Every form label is `uppercase text-blueGray-600 text-xs font-bold mb-2`. Not titlecase, not text-sm.
- [ ] **Buttons.** Primary is `bg-lightBlue-500` + `text-white font-bold uppercase text-xs px-4 py-2 rounded shadow`. Cancel is the outline pattern. Destructive is `bg-red-500`. No invented shapes.
- [ ] **Status badges.** Every badge is `rounded-full px-2 py-0.5 self-start` with paired `bg-X-100 text-X-700`. Bg on the View, text color on the Text — never both on both.
- [ ] **Icons.** `@expo/vector-icons` FontAwesome5. No emojis (`✓`, `🔍`, `↑`, `☰` etc.) — replace with FA5 `check`, `search`, `arrow-up`, `bars`.
- [ ] **Page shell.** `<ScrollView className="flex-1">` → `<AdminNavbar title="..." />` → `<View className="px-4 md:px-10 mx-auto w-full mt-6">`.
- [ ] **Tables.** Columns use `flex: N` weights, not `minWidth: N`. The wrapper is a plain `<View className="w-full">`, not `<ScrollView horizontal>` (which sizes to intrinsic content and leaves the card half-empty).
- [ ] **No inline styles for visual properties** that have a Tailwind class. Inline styles are reserved for: dynamic `flex` weights, `minHeight` on textareas, `outlineStyle: "none"` on web inputs, `boxShadow` strings on web that NativeWind doesn't translate, and `zIndex` for overlays.
- [ ] **No hex colors in JSX** outside of the small set of allowed inline colors (`#94a3b8` for placeholders, `#0ea5e9` for active icons, `#cbd5e1` for inactive icons, `#ef4444` for destructive icons). All other colors come from className.

If you can't tick every box, the page isn't done.

## Anti-Patterns — The Recurring Violations

Each of these has shipped at least once and triggered a "this is visibly slop" feedback message. They are listed so the next person can recognize their own draft *before* shipping it.

- **Reaching for `bg-gray-100` because muscle memory.** Use `bg-blueGray-100`. The two look almost identical in isolation but cause a discoloration in screenshots side-by-side with the rest of the app.
- **Pill-shaped chat input** (`rounded-full px-4 py-2`). The chat textarea is a TextInput like every other input. Use the canonical form input class. The pill shape is the single most-shipped violation in this codebase — see § Chat Textarea above.
- **Inline styles instead of Tailwind in chat components.** `PublicChat.tsx` is currently a hand-rolled inline-style component and is a known divergence. New chat work must not extend that pattern — if you have to touch PublicChat, migrate the touched section to className.
- **Text + bg on both wrapping View and inner Text.** Causes the badge to render with the text having its own bg, which looks like two overlapping pills. Bg on the View, text color on the Text. Never both on both.
- **`<ScrollView horizontal>` as a table wrapper** — content sizes to intrinsic width, leaving the card half-empty. Use a plain `<View className="w-full">` and `flex` weights for columns.
- **Emojis as icons.** `🔍`, `↑`, `☰`, `✓`, `✗`, `👍`, `👎`, `🌐` — replace with FA5 (`search`, `arrow-up`, `bars`, `check`, `times`, `thumbs-up`, `thumbs-down`, `globe`). Emojis render at different sizes per OS and break visual alignment.
- **`shadow-sm` on cards.** Notus cards are `shadow-lg` or `shadow-xl`. The sm shadow is invisible against `bg-blueGray-100` page backgrounds and makes cards look like they're floating one pixel off the page.
- **`rounded` (4px) on cards.** Cards are `rounded-lg` (12px). The smaller radius is reserved for inputs and buttons.
- **`text-sm` on form labels.** Labels are `text-xs uppercase font-bold`. Larger labels make the form look like a marketing page, not an admin tool.
- **Missing `placeholderTextColor`.** Without it, placeholders render in the OS default (often pure black), which obscures the difference between empty and filled states.
- **Custom button shadows / borderRadius via inline style.** Buttons are `rounded shadow` (primary), outline (cancel), or `rounded` (destructive). Inline overrides break the visual rhythm.
- **`-mt-24` on a page that has no `<HeaderStats />`.** The negative margin only makes sense when there's a stats row to overlap the navbar. On a plain list page, it just shoves the content under the blue header.
- **Forgetting `<AdminNavbar />` because the page is "just a form."** Every internal page has the navbar. Without it, the user loses the org switcher and the profile menu and immediately notices.
- **Sprinkling the org switcher on every page header instead of leaving it in the navbar.** One canonical location. The navbar.
- **`text-blueGray-800` for body text.** Too dark — looks black and breaks the soft Notus palette feel. Body is `text-blueGray-700`. The 800/900 shades are for accent typography only (large dashboard numbers, modal headlines).
- **Replacing the canonical card with a Material/Bootstrap-style card from a different design system.** This is the worst version of the violation: somebody pastes in code from another project and you end up with two cards on the same page that look like they came from different apps. If you find yourself doing this, stop and use the components in `components/cards/` instead.
- **Sharing ANY layout/design/asset file between admin and public.** Common headers, common footers, common CSS, common Tailwind palette entries, common layout shells, common card/input/button components, common fonts, common root layout wrappers — all forbidden. Admin and public are two separate visual systems that happen to live in the same repo. See § HARD ISOLATION RULE.
- **Touching a public file while installing admin-only-notus.** This recipe installs admin surfaces only. Editing anything under `landing-marketing-site`, public route groups, public components, or a root layout that public consumes is out of scope by definition. If the install appears to require a public-file edit, the install is wrong.

## Fit-to-Project / Migration Notes

- **Existing pages that violate the canon.** Don't refactor opportunistically — fix the violation in the same PR as a feature change to that page. Touching unrelated files just to "fix the styling" creates merge conflicts and breaks blame.
- **PublicChat migration.** Out of scope for this skill. Track separately. If you touch PublicChat for a feature change, migrate only the section you touch — don't try to do the whole component in one PR.
- **Custom themes.** A future "white-label customer can change the brand color" requirement should be solved by overriding `lightBlue` in the Tailwind config at build time, not by sprinkling theme variables through components. Keep the className strings stable.
- **Native vs web.** Most class strings work identically on iOS, Android, and web through NativeWind. The exceptions are: `cursor-pointer` (web-only, ignored on native), `boxShadow` inline strings (web-only — wrap in `Platform.OS === "web"` checks), `outlineStyle` (web-only). All other rules in this recipe apply uniformly.
- **The dark `<CardTable color="dark" />` variant.** Use sparingly — at most one dark card per row. A row of two darks looks like an error.

## Integrations

- **`stack`** — this skill assumes the Expo Router + NativeWind setup from `stack/SKILL.md`. The Tailwind config goes in the same `tailwind.config.js` that `stack` already establishes.
- **`landing-marketing-site`** — landing pages do **not** follow this skill. They have their own Notus marketing palette (lighter, more whitespace, hero gradients) and their own header, footer, layout shell, and assets. Don't import the conventions here into a public marketing page, and don't import the public conventions into an admin page. The two systems share nothing — no header, no footer, no CSS, no assets, no layout, no components. See § HARD ISOLATION RULE.
- **`chat-support`** — see § Chat Textarea above. The chat drawer is bound by this recipe; the input must use the canonical form input className.
- **`public-contact-chat`** — known divergent (inline styles). Migrate piecemeal; don't extend the inline-style pattern in new code.
- **`admin-user-crud` / `admin-roles-crud` / `admin-prompt-queue` / `multi-tenant`** — every admin UI surface defined by these recipes must follow this skill verbatim. When in doubt, copy a class string from `diplomat-app/components/`.

## Reference Files (Canonical Implementations)

When you need to copy a pattern, copy from these files. Don't grep elsewhere — half the codebase is older code that predates this skill.

| File | What to copy from it |
|---|---|
| `diplomat-app/tailwind.config.js` | The palette |
| `diplomat-app/components/navigation/AdminNavbar.tsx` | The blue header bar, profile menu, search input |
| `diplomat-app/components/navigation/Sidebar.tsx` | Sidebar shell, section titles, active/inactive nav items |
| `diplomat-app/components/cards/CardStats.tsx` | KPI card with icon circle |
| `diplomat-app/components/cards/CardTable.tsx` | Tabular card (light + dark variants) |
| `diplomat-app/components/cards/CardSettings.tsx` | Settings form card with the canonical input pattern |
| `diplomat-app/components/cards/CardProfile.tsx` | Profile hero card |
| `diplomat-app/components/ui/JobCard.tsx` | List-row card with status badge |
| `diplomat-app/app/login.tsx` | Login form (canonical form layout, primary button, label style) |
| `diplomat-app/app/(app)/admin-prompt-queue.tsx` | Multiline textarea with min-height + outline reset |
| `diplomat-app/app/(app)/admin/orgs/index.tsx` | Modal with form inputs and the cancel/primary button pair |

When you finish a new page, diff your class strings against the equivalent strings in one of these files. If they don't match, yours is wrong.
