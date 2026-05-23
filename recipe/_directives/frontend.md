NEVER tell the user to restart the server, reload the extension, or restart any process/service.  If you do, it means not only did you NOT finish the task, you ALSO didn't test it because you couldn't have tested it if you didn't restart the server.
If anything is stale or down — servers, watch processes, extensions — diagnose it, kill what needs killing,
and bring it back up yourself.  At the end of every modification that requires a restart/reload, output "✅" and then what you restarted/reloaded (extension, server at address:port, etc).

## Background

ALL UX rules and patterns are required to be followed project-wide to maximum consistency, except where explicitly ordered.

This is a **binding checklist**. You do not get to pick which rules apply based on how the feature "feels". You enumerate every guideline below and affirmatively mark each one — even if the answer is "N/A because this feature has no tables". The value of a QA pass is that nothing is silently skipped; the moment you start omitting rules "because they're obviously not relevant", you will miss a real violation sitting right next to an obviously-irrelevant one.

The rules below are mined from real production bugs that shipped because someone eyeballed the feature and decided "looks fine". Every bullet exists because it *already broke something*. Treat the list as load-bearing history, not a style guide.

Marker legend:

- ✅ **PASS** — verified against the code, with a file:line or viewport screenshot as evidence.
- ❌ **FAIL** — the rule is violated. Must include: (a) what violates it, (b) file:line, (c) proposed fix.
- ⚠️ **FAIL WITH EXPLANATION** — the rule is *partially* violated or violated in a way the user has explicitly accepted. Must still include evidence and reasoning.
- 🚫 **N/A** — the rule does not apply to this scope. Must include a one-line justification (e.g. "no tables in this feature"). "N/A" without a reason is a fail.


Forms use one of the two following save patterns -- either (a) automatically save-on-blur, or (b) a single dirty-save button. 
* in the project's CLAUDE.md, it should explicitly state which pattern is in use for this project. if it doesn't, then default to save-on-blur.
* ONLY deviate when explicitly instructed to do so, and only in that particular form.
* IF the project uses save buttons, it must be one button per form (not per field), AND control (command for mac) + S should force a save of the form, AND use the dirty-clean pattern... disable and grey the save button when clean, highlight save button when form is dirty.
* IF the project uses save-on-blur, there should be NO save buttons, as the blur should automatically save that value.

With multi-column designs on wide-screens, column width should be at 700-800-px. Never have any column below 700px truncating unless and until all horizontal/columnar space is taken up. You should never have a 200-300px sidebar getting truncated, 700-800px center column, and then empty right column.

When implementing any date-range filter (e.g., created-between), both the lower-bound and upper-bound <input> elements must be present in the rendered template — not just the state variables and query-param logic. Before marking a filter feature complete, confirm that every filter state variable (e.g., createdAfter, createdBefore) has a visible, labeled input in the filters row.

Whenever implementing, testing, or auditing any that's viewable by the frontend (so this includes any backend changes for a frontend UI even if no frontend changes were made), you must include in your final report each of the actual URLs you used to test your work product so that a human can easily click through and verify your testing.

Context menus, dropdowns, popovers, and tooltips MUST use `position: fixed` with coordinates from `getBoundingClientRect()` on the trigger element. NEVER use `position: absolute` inside any container that has overflow constraints. Always use z-index 9999. Hard rule, no exceptions.

- **[Consistent Headers]** Headers are consistent across the app. No back button lives *inside* the header.
- **[Button Consistency]** Buttons are consistently sized, colored for context, use `cursor: pointer` on web (via `webCursor` helper for every `TouchableOpacity` / `Pressable` used as a button, including hamburger menus), and are in consistent locations (left vs right align). All actions in the same control group use the same component type — if Save is an `ActionButton`, Delete must also be an `ActionButton` with `C.danger`, not a bare text `TouchableOpacity` with an icon. Destructive actions are visually distinct via color (`C.danger`), not by being a lesser component.
- **[Save Disable State]** If a view has a Save button, it is disabled/greyed when nothing in its scope is dirty, and activates (standard color) as soon as an editable attribute changes.
- **[Native Selects]** On `Platform.OS === 'web'`, dropdowns use native `<select>` (or `<Picker>` mapped to native select) styled with app dark-mode tokens. No custom `TouchableOpacity`/`Pressable` dropdown implementations unless native `<select>` literally cannot work (multi-select with checkboxes, rich content in options). Flag any new custom-built selector that a native select would serve better.
- **[Monospace Reservation]** Monospace is only used for actual code, raw data, or machine-readable content (JSON, regex, commit hashes, filter patterns). Human-readable prose — prompt templates, review drafts, notes, descriptions, natural-language content, ASINs and other IDs — uses the default proportional font. Flag every `fontFamily: 'monospace' | 'Courier'` and verify the content is genuinely code/data.
- **[Expo Vector Icons]** Icons use `expo-vector-icons`. No emoji icons.
- **[No Page Flicker]** First render has real data, not mock/test/slop data that later gets replaced. No visible flicker on page load.
- **[Canonical Routes]** Routes make canonical sense. Tabs have their own canonical route (`{parent}/`, `{parent}/{tab1}/`, `{parent}/{tab2}/`). CRUD sections have routes for list, detail (`:id`), add, and edit (`:id`).
- **[Tab Card Unity]** A horizontal tab list is not a separate card from the content below it.
- **[Active Sidebar Match]** Sidebar active state matches the active page and active route. Exactly one item is highlighted. No stale highlights.
- **[Context Menu Z-Index]** Context menus, dropdowns, popovers, and tooltips MUST use `position: fixed` with coordinates calculated from `getBoundingClientRect()` on the trigger element — never `position: absolute` inside any container that has `overflow: hidden`, `overflow-x-auto`, or any overflow constraint. Z-index alone does NOT fix overflow clipping; they are different problems. Use `z-index: 9999` (Tailwind: `z-[9999]`). A `useRef` on the trigger + bounding rect on open is the canonical pattern. Verify the menu is not clipped in any overflow container before marking PASS.
- **[Z-Index Backgrounds]** Anything with a z-index has an affirmative `backgroundColor` — otherwise content underneath bleeds through.
- **[Instant Blackout]** Drawer/modal blackouts are instant full-screen, not animated in sync with the drawer/modal slide.
- **[Badge Consistency]** Badges and buttons may differ in color but share consistent padding, border radius, font, and line height.
- **[Click Outside Close]** Context menus, drawers, and modals close on outside click. Context menus use a full-screen `Pressable` overlay with `backgroundColor: 'rgba(0,0,0,0.01)'` and `onPress` → close. Cross-reference new context menus against the canonical pattern used by orders/reviews.
- **[Top Align Content]** Rows and cards with variable-height content use `alignItems: 'flex-start'`, not center-aligned.
- **[Lazy Load Images]** Images in lists lazy-load after the first visible batch (e.g. first 10 eager, rest lazy).
- **[State Filtered Tabs]** Long mixed-state lists in dashboards/reports are split into tabs by state, with the most actionable tab as the default. Time-sensitive summary cards (e.g. "Today's Deliveries") sit above the tabs.
- **[Controls Co-location]** Search, filter, and compliance-indicator controls are co-located with the view's title/header in the card header's action slot — not isolated in a full-width row below navigation.
- **[Pressable Background]** Transparent `Pressable` overlays in RN Web have an explicit `backgroundColor` (`'transparent'` or `'rgba(0,0,0,0.01)'`) so they actually receive pointer events. When a bug marked DONE says "added overlay", verify live that the overlay receives events.
- **[Error Page Rules]** Design-system rules apply to error pages, 404s (`+not-found.tsx`), loading states, and empty states — not just the routes in the sidebar. Include them in the audit explicitly.
- **[Multi-Property Fix]** When a bug fix addresses multiple properties of the same element (color, background, border, icon), verify *every* property was fixed, not just the ones named in the commit.

## Responsive & Layout

- **[Responsive Breakpoint]** Test at both >768px and ≤768px. App switches between sidebar (wide) and overlays/drawers (narrow) at 768px. Active-state highlighting, route matching, and navigation structure must be correct in *both* modes. Every navigation element in every rendering mode has active-route highlighting.
- **[Empty States]** Lists, tables, and tabs with zero items show a purposeful empty state (icon + message), not a blank void or a never-resolving spinner. Every filterable view distinguishes "no results for this filter" from "no data at all".
- **[Text Truncation]** Long text in table cells and card rows truncates with `numberOfLines={1}`, not wraps and blows out row height. Full text is accessible via tooltip / inspect drawer / expand. Behavior is consistent across all list views.

## State, Loading, Errors

- **[Loading Pattern]** One consistent loading pattern across all data-fetching views (skeleton, spinner, or shimmer — pick one). No infinite spinners. On fetch failure/timeout, show an error state.
- **[Toast Behavior]** Toast stacking and behavior are consistent: toasts stack without obscuring interactive elements, error toasts persist until dismissed, success toasts auto-dismiss after a short delay.
- **[No Content Flash]** Refresh/re-fetch never hides previously valid content. No `{!loading && !error && <Content/>}` patterns — loading/error overlays appear *alongside* existing content, not replacing it.
- **[Empty Warning]** Never show a warning without saying what the warning actually is.

## Tables

- **[Full Width Tables]** Default width for all tables is full width.
- **[Nowrap Table Headers]** Never wrap or truncate a table header.
- **[Table Column Widths]** Column widths minimize truncation/wrapping/overflow — desktop screen first, then mobile.
- **[Table Alignment]** Numeric and currency values are right-aligned; text is left-aligned. Consistent across all tables.
- **[Dark Scrollbars]** In dark mode, every scrollable container has dark-mode scrollbar styling (`::-webkit-scrollbar`, `scrollbar-color`, `scrollbar-width`) derived from app tokens. Includes page body, textareas, modals, sidebars, overflow panels. Scroll every scrollable area and verify.

## Data Visualization

- **[Data Viz Tokens]** Chart/graph/map colors use color tokens when a matching token exists. Rule applies to *all* color assignments — including data-mapping objects, legend entries, and conditional color lookups, not just UI chrome.




- **[Body Guard]** Content scripts guard all `document.body` access — check for existence, defer to `DOMContentLoaded` if null. Applies to `appendChild`, `style`, direct body manipulation.



### React Lifecycle

- **[Effect Cleanup]** Every `useEffect` that creates a subscription, timer, or in-flight fetch returns a cleanup function. `cancelled` flags are only sufficient if the async code *actually checks them* — if the async work is in an external `useCallback`, the flag is invisible. Inline the async work, pass a signal/flag, or use `AbortController`. Verify every `cancelled` flag is referenced by the code that calls `setState`.
- **[Ref Timer Cleanup]** `useRef` debounce timers have a component-level unmount cleanup: `useEffect(() => () => { if (ref.current) clearTimeout(ref.current); }, [])`.
- **[Stale Fetch Guard]** Sequential fetches are guarded against race conditions. Use `AbortController` or a request-ID check before `setState` so only the latest fetch's result is applied.
