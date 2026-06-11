---
name: admin-design-system
description: >
  Use when building any internal/admin page in a Goliath app. The rule is
  simple: reuse the project's existing design schema and patterns where
  available — match the established palette, card surface, form input, button
  variants, status badges, page-layout shell, and icon conventions verbatim
  rather than inventing new ones. If the project has no prior designs to
  reuse, build a typical admin backend with conventional controls (nav +
  content shell, cards, tables, labeled forms, primary/secondary/destructive
  buttons, status badges, a standard icon set — not emojis). Includes a
  pre-flight consistency checklist and the recurring violations this recipe
  exists to stop. THIS RECIPE IS FOR ADMIN/INTERNAL PAGES ONLY AND MUST NOT
  SHARE ANY LAYOUT, DESIGN, OR ASSET FILES WITH PUBLIC PAGES.
dependencies:
  requires: [admin-routing]
provides: [design-system]
---

# Admin Design System

## HARD ISOLATION RULE — READ FIRST, NO EXCEPTIONS

**This recipe is for admin/internal pages ONLY. It MUST NOT share ANY common layout, design, or asset files with public-facing pages. When installing this recipe you MUST NOT touch any public files.**

**Why this recipe is called admin-ONLY:** there exist Goliath sites where one design system is used for *everything* — public marketing pages AND admin pages — and on those sites a single shared set of layout/design/asset files is the correct architecture. **This recipe is not for those sites.** This recipe is specifically for sites where admin and public must be kept disjoint, because past changes to shared layout/design/asset files have repeatedly broken the public side while trying to fix the admin side (and vice versa). The whole point of this recipe is to eliminate the shared-file blast radius: the admin side has its own palette entries, its own header, its own footer, its own layout shell, its own components, and its own assets, and nothing an admin-side edit can touch will ever propagate to a public page, because there is no file they both consume.

If the target site uses one design system for public as well and the user wants a shared setup, **do not install this recipe** — it is the wrong tool. Ask the user which mode they want before installing.

Specifically forbidden when installing this recipe:

- **No shared header.** The admin header is admin-only. Do not import it into any public page. Do not extract a "common" header that both admin and public consume. Public pages use the header from `landing-marketing-site`; the two headers are separate files that happen to be in the same repo and nothing more.
- **No shared footer.** The admin footer is admin-only. Public pages have their own footer from `landing-marketing-site`. Never merge them. Never extract a common `<Footer>`.
- **No shared CSS / Tailwind entries / design tokens / palette with public.** The palette and class-string conventions on the admin side are admin-scoped. Do not widen them to accommodate a public page, and do not reach into the admin palette from a public page. If public needs colors, public defines its own.
- **No shared layout shell.** The admin page shell (nav + content container) is admin-only. Public pages use the layout from `landing-marketing-site` and never wrap themselves in admin primitives, and admin pages never wrap themselves in public primitives.
- **No shared cards, inputs, buttons, badges, tables, or icon conventions with public.** Every canonical admin component is admin-only. If a public page looks similar, that is coincidence, not shared code. Do not extract a "common" version "to DRY things up."
- **No shared asset files** (fonts, images, SVGs, icon sets, global stylesheets, Google Fonts injection) between admin and public. If admin needs an asset, it lives under an admin-only path and is imported only from admin routes.
- **No common layout wrappers above the route group.** If you find yourself editing a root `_layout.tsx`, a provider, a theme context, or any file that both admin and public routes consume, STOP — this recipe has no business there.

**When installing this recipe you MUST NOT touch any public files.** Do not edit `landing-marketing-site` routes, public layouts, public components, public styles, public assets, or any file under a public route group. Do not edit a root layout in a way that affects public. Do not edit `tailwind.config.js` in a way that changes colors public pages already use. If a change you're about to make would modify a public file, stop — it does not belong in this install.

If you find yourself typing the words "shared," "common," "global," "unified," "DRY," or "extract" while installing this recipe, you are about to violate the isolation rule. Back up.

## The Core Rule

**Use the existing design schema and patterns where available. If no prior designs are available, build a typical admin backend with conventional controls.**

Internal/admin pages must look like they belong to one app. The way you guarantee that is by *reusing what the project already has* instead of inventing a new look on every page — the failure mode this recipe exists to stop is somebody reaching for their own colors, their own button shape, or their own card style, shipping it, and producing a screen that looks visibly off next to every other admin screen.

### When the project already has a design system

This is the common case. Before writing a single new component:

1. **Find the canonical implementations.** Locate the project's existing design tokens / theme (e.g. `tailwind.config.js`, a theme file, a component library, a `components/` directory) and the admin pages already built against them.
2. **Reuse them verbatim.** Match the established conventions exactly — the palette (neutrals + brand), the card surface, the form input, the button variants (primary / secondary / destructive), the status badge style, the page-layout shell, the icon set. Quote the existing class strings or component imports; don't paraphrase, don't "improve," don't substitute colors or shapes you happened to use in another project.
3. **Copy the closest existing page.** When you need a new affordance, copy the pattern from the nearest equivalent page already in the codebase rather than rolling your own. Diff your output against it — if the strings don't match, yours is wrong.

There is exactly one of each canonical element per project (one card surface, one form input, one primary button, one badge style, one page shell). Find it and reuse it. Do not introduce a second.

### When there are no prior designs to reuse

If the project genuinely has no established admin design system, build a **typical admin backend with conventional controls** — nothing exotic, nothing bespoke:

- **Page shell:** a top nav bar and/or sidebar plus a centered, responsively-padded content container. Every admin page uses the same shell.
- **Cards:** a single consistent card surface (rounded corners, subtle shadow, white/neutral surface, optional header row with a bottom border) for grouping content.
- **Tables:** header row + body rows that fill their container width (use flex weights per column, not fixed min-widths that leave the container half-empty).
- **Forms:** labeled inputs with a single consistent input style (visible border, consistent radius and padding, a real placeholder color), labels above inputs.
- **Buttons:** exactly three variants — a loud **primary** (brand color) for Save/Submit/Create/Confirm, a quiet **secondary/cancel** (outline) for Cancel/Close/Back, and a **destructive** (red) for Delete/Revoke/Suspend. Don't invent extra shapes.
- **Status badges:** small pills that communicate state, using a consistent paired background/text color per state (success / info / warning / error / neutral). Pick the colors once and reuse them.
- **Icons:** a single proper icon set (e.g. FontAwesome, Lucide, Material Icons). **Never emojis** — they render at different sizes per OS and break alignment.

Pick these once, keep them stable, and apply them to every admin page so the whole surface stays coherent. Once chosen, treat them exactly like an existing design system: reuse, don't reinvent per page.

## Pre-Flight Checklist

Before you ship a new internal page, run down this list. Every check is a violation that has actually happened on a previous page and produced a "this looks wrong" comment in code review.

- [ ] **Reuse.** You located the project's existing design tokens/components and admin pages, and matched them verbatim. (Or, if none exist, you established one consistent typical-admin convention and applied it.)
- [ ] **Palette.** Neutrals and brand colors come from the project's established palette. No ad-hoc colors invented for this page; no mixing in a second neutral/brand family.
- [ ] **Cards.** Every card uses the project's one canonical card surface. No second card style pasted in from another project or design system.
- [ ] **Inputs.** Every input uses the one canonical form input style — consistent border, radius, padding, text color, and a real placeholder color. No bespoke per-page input shapes.
- [ ] **Labels.** Form labels follow the project's one label convention consistently.
- [ ] **Buttons.** Primary / secondary-cancel / destructive only, each matching the established shape. No invented variants.
- [ ] **Status badges.** Every badge uses the one consistent paired-color style. Background on the wrapper, text color on the text — never both on both.
- [ ] **Icons.** A proper icon set, used consistently. No emojis as icons.
- [ ] **Page shell.** The page uses the same admin shell (nav/sidebar + content container) as every other admin page.
- [ ] **Tables.** Columns fill the container (flex weights), not fixed min-widths that leave the card half-empty.
- [ ] **Isolation.** No admin↔public file sharing was introduced (see § HARD ISOLATION RULE).

If you can't tick every box, the page isn't done.

## Anti-Patterns — The Recurring Violations

Each of these has shipped at least once and triggered a "this is visibly slop" feedback message.

- **Inventing a new look instead of reusing the existing one.** The most common failure: a page ships with its own colors / button shape / card style because the author didn't look for the project's existing convention first. Find the canonical implementation and copy it.
- **Two design systems on one screen.** Pasting in a Material/Bootstrap-style card (or any component from a different project) next to the project's native components, so one page looks like it came from two different apps. Use the project's existing components.
- **A second card / input / button shape.** There is exactly one of each per project. Introducing a near-duplicate "because it's slightly different here" makes the surface look stitched together.
- **Emojis as icons.** `🔍`, `↑`, `☰`, `✓`, `✗`, `👍`, `👎`, `🌐` — replace with the project's icon set (`search`, `arrow-up`, `bars`, `check`, `times`, `thumbs-up`, `thumbs-down`, `globe`). Emojis render at different sizes per OS and break visual alignment.
- **Reinventing the chat input.** The chat input is an input like every other input and must use the project's canonical form input style — not a pill-shaped (`rounded-full`), borderless, or otherwise custom variant. Reserve any circular shape for the chat *trigger* FAB; once inside the drawer, every control matches the rest of the app. See `chat-support/SKILL.md` § Input Bar Styling.
- **Inline styles instead of the project's styling convention.** Hand-rolled inline-style components diverge from the rest of the app. Stick to the project's styling approach; if you must touch a divergent component, migrate only the section you touch.
- **Status badge with background on both the wrapper and the inner text** — renders as two overlapping pills. Background on the wrapper, text color on the text. Never both on both.
- **Tables that don't fill their card** — content sized to intrinsic width leaves the card half-empty. Use flex weights per column and a full-width wrapper.
- **Forgetting the admin nav/shell because the page is "just a form."** Every internal page uses the same shell so users keep the navigation, org switcher, and profile menu everywhere.
- **Sharing ANY layout/design/asset file between admin and public.** Common headers, footers, CSS, palette entries, layout shells, card/input/button components, fonts, or root layout wrappers — all forbidden. Admin and public are two separate visual systems that happen to live in the same repo. See § HARD ISOLATION RULE.
- **Touching a public file while installing this recipe.** This recipe installs admin surfaces only. Editing anything under `landing-marketing-site`, public route groups, public components, or a root layout that public consumes is out of scope by definition. If the install appears to require a public-file edit, the install is wrong.

## Fit-to-Project / Migration Notes

- **Existing pages that violate the canon.** Don't refactor opportunistically — fix the violation in the same PR as a feature change to that page. Touching unrelated files just to "fix the styling" creates merge conflicts and breaks blame.
- **Divergent components (e.g. hand-rolled inline-style chat).** Track separately. If you touch one for a feature change, migrate only the section you touch — don't try to do the whole component in one PR.
- **Custom themes / white-label.** A "customer can change the brand color" requirement should be solved by overriding the brand color in the central theme/config at build time, not by sprinkling theme variables through components. Keep the component styling stable.

## Integrations

- **`stack`** — this skill assumes the app setup from `stack/SKILL.md`. Any theme/design tokens go in the config that `stack` already establishes.
- **`landing-marketing-site`** — landing pages do **not** follow this skill. They have their own public design system and their own header, footer, layout shell, and assets. Don't import the admin conventions into a public marketing page, and don't import the public conventions into an admin page. The two systems share nothing — no header, no footer, no CSS, no assets, no layout, no components. See § HARD ISOLATION RULE.
- **`chat-support`** — see the chat-input anti-pattern above. The chat drawer is bound by this recipe; its input must use the project's canonical form input style.
- **`public-contact-chat`** — may be a known-divergent surface. Migrate piecemeal; don't extend a divergent inline-style pattern in new code.
- **`admin-user-crud` / `admin-roles-crud` / `admin-prompt-queue` / `admin-routing`** — every admin UI surface defined by these recipes must follow this skill. When in doubt, copy a pattern from an existing admin page in the project.
