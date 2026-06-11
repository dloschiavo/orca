---
name: user-profile
description: >
  Use when building the self-service "My Profile" and "Account" screens where a
  logged-in user views and edits their OWN account — profile photo, display
  name, and personal preferences (chat-translation language, push
  notifications). Layers on top of otp-auth, which already owns the `users`
  collection, `useAuth`, and the base `/api/auth/me` GET/PATCH. This recipe adds
  the GCS-backed avatar subsystem (`/api/auth/avatar` upload + serve, plus the
  drag / paste / click `ProfileAvatar` component with optimistic preview and
  cache-busting), the `avatar_url` extension on the `/api/auth/me` response, the
  My Profile screen (avatar + read-only email + save-on-blur display name), the
  Account preferences screen (chat-language chip grid + the `chatFlags`
  flag/label helper), and the ENTRY POINT — the top-right navbar avatar that
  opens a click-outside context menu (Profile / Switch User / Sign Out), with an
  initials fallback and a mobile-drawer variant. The two-factor block on the
  Account screen is delegated to `mfa-totp` and only present when that recipe is
  installed. Reach for this whenever a user needs to manage their own
  identity/preferences or you need the account/avatar menu in the header —
  "profile page", "account settings", "let users upload an avatar", "edit
  display name", "change my language", "avatar dropdown in the top right",
  "user menu with log out" — even if the user doesn't say "profile" explicitly.
  Deliberately EXCLUDES attorney-of-record and bar-admission/credential
  features; those belong to a separate AoR recipe.
dependencies:
  requires: [otp-auth]
---

# Self-Service User Profile

The screens a logged-in user uses to manage **their own** account: a profile photo, their display name, and personal preferences. This is the user-facing complement to `admin-user-crud` (which is staff editing *other* people's accounts). Everything here is scoped to `session.user_id` — there is no way to edit someone else's profile through these surfaces.

This recipe **builds on `otp-auth`**, which already ships:

- the `users` collection and the `IUser` interface,
- `useAuth()` (`lib/useAuth.ts`) and the `AuthSession` type,
- `getSession` / `requireSession`,
- the base `/api/auth/me` route, whose `PATCH` already accepts `display_name`, `chat_language`, and `push_notifications_enabled`.

So the recipe does **not** re-define those. It *extends* them: it adds the avatar fields and avatar route, adds the `avatar_url` field to the `/api/auth/me` response, and adds the two screens that drive all of it. Where this recipe shows `/api/auth/me`, treat it as the deltas to the otp-auth route, not a replacement.

## Scope boundary — what this recipe is NOT

docpost's live profile screen also has a **Bar Certifications** section and an **Attorney of Record** per-org toggle. Those are **out of scope by design** and must not appear in an install of this recipe:

- no `bar_admissions` field, `IBarAdmission` interface, or its `/api/auth/me` validation,
- no jurisdictions list / `JurisdictionCombobox`,
- no Attorney-of-Record section or `/api/orgs/[orgId]/attorney-of-record` endpoint,
- no `useOrgs` usage inside the profile screen.

The bar-certification UI exists *only* to feed Attorney-of-Record, so it comes out with it. If a project needs AoR, install the dedicated AoR recipe on top of this one — do not smuggle credential fields back into this screen.

## Prerequisites beyond dependencies

The avatar subsystem needs a **blob-storage helper** at `lib/storage` exposing this minimal async interface (GCS-backed in docpost, but any object store works):

```ts
// lib/storage.ts — assumed to already exist in the target project
export const storage: {
  get(key: string): Promise<Buffer>          // throws a NotFoundError-shaped error if absent
  put(key: string, bytes: Buffer, opts: { contentType: string }): Promise<void>
}
```

If the project has no such helper, add the thinnest GCS wrapper that satisfies this shape before installing — don't inline bucket calls into the route handler. The route depends on `get` rejecting with an error whose `.name === 'NotFoundError'` for the "no avatar yet" case; match that.

## Data model — extend `users`

Add two fields to the existing `IUser` interface (`models/User.ts`). Everything else profile-related (`display_name`, `chat_language`, `push_notifications_enabled`) already lives there from otp-auth.

```ts
// Profile picture — GCS storage key and MIME type
avatar_key?: string   // e.g. "avatars/<user_id>"; absent until first upload
avatar_mime?: string  // e.g. "image/png"; served back as the Content-Type
```

The image bytes live in blob storage, **not** in the document — the doc only holds the key + MIME. This keeps user documents small (they're read on every authenticated request via `getSession`) and lets the image be served with its own cache headers.

## API: avatar upload + serve

`app/api/auth/avatar+api.ts`. One route, three behaviors: serve your own avatar, serve anyone's avatar (still authenticated), upload/replace your own. The GCS key schema is `avatars/{user_id}` with **no extension** — the MIME type rides in `avatar_mime` on the doc, not in the key. That makes "replace my avatar" a plain overwrite at a stable key, so no orphan cleanup and the public URL never changes.

```ts
/**
 * GET  /api/auth/avatar         — serve the caller's own avatar bytes
 * GET  /api/auth/avatar?uid=... — serve any user's avatar (still authenticated)
 * POST /api/auth/avatar         — upload / replace the caller's avatar
 *
 * GCS key schema: avatars/{user_id}   (no extension; mime stored in IUser.avatar_mime)
 * Size limit: 5 MB
 * Accepted types: image/jpeg, image/png, image/gif, image/webp
 */
import { requireSession, getSession, authError } from '../../../lib/auth'
import { getDb } from '../../../lib/db'
import { storage } from '../../../lib/storage'
import { logRequest } from '../../../lib/request-log'
import type { IUser } from '../../../models/User'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function avatarKey(userId: string): string {
  return `avatars/${userId}`
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireSession(request)
    logRequest(request, session)

    // Optionally serve another user's avatar (same session required, any uid)
    const url = new URL(request.url)
    const targetUid = url.searchParams.get('uid') ?? session.user_id

    const db = await getDb()
    const user = await db.collection<IUser>('users').findOne({ user_id: targetUid })
    if (!user?.avatar_key) {
      return new Response(null, { status: 204 })
    }

    const buf = await storage.get(user.avatar_key)
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': user.avatar_mime ?? 'image/jpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (err: any) {
    if (err?.name === 'NotFoundError') {
      return new Response(null, { status: 204 })
    }
    return authError(err)
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSession(request)
    logRequest(request, session)

    const contentType = request.headers.get('content-type') ?? ''

    let imageBuffer: Buffer
    let mimeType: string

    if (contentType.startsWith('multipart/form-data')) {
      // Standard file-upload via <input type="file"> or FormData
      const form = await request.formData()
      const file = form.get('file') as File | null
      if (!file) {
        return Response.json({ error: 'No file provided' }, { status: 400 })
      }
      mimeType = file.type || 'image/jpeg'
      const ab = await file.arrayBuffer()
      imageBuffer = Buffer.from(ab)
    } else if (ALLOWED_MIME.has(contentType.split(';')[0].trim())) {
      // Raw binary upload with explicit Content-Type
      mimeType = contentType.split(';')[0].trim()
      const ab = await request.arrayBuffer()
      imageBuffer = Buffer.from(ab)
    } else {
      return Response.json(
        { error: 'Content-Type must be multipart/form-data or an image type (jpeg/png/gif/webp)' },
        { status: 415 },
      )
    }

    const normalizedMime = mimeType.toLowerCase()
    if (!ALLOWED_MIME.has(normalizedMime)) {
      return Response.json({ error: 'Only JPEG, PNG, GIF and WebP images are accepted' }, { status: 415 })
    }

    if (imageBuffer.length > MAX_BYTES) {
      return Response.json({ error: 'Image must be 5 MB or smaller' }, { status: 413 })
    }

    // Store under avatars/{user_id}
    const key = avatarKey(session.user_id)
    await storage.put(key, imageBuffer, { contentType: normalizedMime })

    // Persist key + mime on the user document
    const db = await getDb()
    await db.collection<IUser>('users').updateOne(
      { user_id: session.user_id },
      { $set: { avatar_key: key, avatar_mime: normalizedMime, updated_at: new Date() } },
    )

    return Response.json({
      avatar_url: `/api/auth/avatar`,
      avatar_key: key,
    })
  } catch (err) {
    return authError(err)
  }
}
```

Two validation gates that matter: MIME is checked **twice** (the raw-binary branch gates on entry, then a normalized re-check covers the multipart branch where the browser supplies the type), and size is checked **after** the bytes are in memory — there's no streaming size guard, so `MAX_BYTES` is the real ceiling. Keep both.

`?uid=` exists so other surfaces (chat, member lists, the navbar) can render any user's avatar with one stable URL while still requiring a session — avatars are not public. The `uid` path is intentionally not scoped to "users you can see"; it's a low-sensitivity image read behind auth. If your project treats avatars as sensitive, tighten it, but don't make it public.

## API: `/api/auth/me` — add `avatar_url` to the response

otp-auth's `/api/auth/me` already returns the session plus `chat_language`, `push_notifications_enabled`, etc. This recipe adds **one derived field** to both the `GET` and the `PATCH` response: `avatar_url`, set to the constant route `/api/auth/avatar` when the user has an `avatar_key`, else `null`. The client never sees the GCS key.

```ts
// inside the GET handler's Response.json({ user: { ... } }), add:
avatar_url: user?.avatar_key ? `/api/auth/avatar` : null,

// inside the PATCH handler's Response.json({ user: { ... } }), add:
avatar_url: updated?.avatar_key ? `/api/auth/avatar` : null,
```

It's a constant string, not a signed/keyed URL, because the bytes are served by the authenticated route above and cache-busting is the client's job (see the component). Don't build a per-request signed URL here — that would defeat the browser cache and the `Cache-Control` header the avatar route sets.

## The avatar component

`ProfileAvatar` is the load-bearing piece — three upload affordances (click, drag-anywhere, paste-anywhere), an **optimistic local preview** so the new image shows instantly, and **cache-busting** so the stable `/api/auth/avatar` URL re-fetches after a replace. All three affordances and both the preview and the bust are why this is copied verbatim rather than re-derived; a from-scratch avatar uploader almost always drops the cache-bust (replace silently shows the old image) or the drag/paste handlers.

```tsx
// ── Avatar upload component ────────────────────────────────────────────────────
function ProfileAvatar({
  avatarUrl,
  onUploaded,
}: {
  avatarUrl: string | null
  onUploaded: (newUrl: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  // Local preview URL (object URL while uploading / after success)
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  // Drag-over highlight state
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<any>(null)

  // Cache-bust the server URL to force re-fetch after a new upload
  const [bust, setBust] = useState(() => Date.now())

  const displayUrl = localUrl ?? (avatarUrl ? `${avatarUrl}?v=${bust}` : null)

  const uploadFile = useCallback(
    async (file: File) => {
      setError('')
      const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      if (!ALLOWED.includes(file.type)) {
        setError('Only JPEG, PNG, GIF and WebP images are accepted')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        setError('Image must be 5 MB or smaller')
        return
      }
      // Show local preview immediately
      const objectUrl = URL.createObjectURL(file)
      setLocalUrl(objectUrl)
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/auth/avatar', { method: 'POST', body: fd })
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          throw new Error(json.error ?? `Upload failed (${res.status})`)
        }
        const json = await res.json()
        setBust(Date.now())
        onUploaded(json.avatar_url)
      } catch (e: any) {
        setError(e.message ?? 'Upload failed')
        setLocalUrl(null)
      } finally {
        setUploading(false)
      }
    },
    [onUploaded],
  )

  // ── Drag-and-drop on the whole viewport (web only) ─────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(true)
    }
    const handleDragLeave = (e: DragEvent) => {
      // Only clear when leaving the window entirely
      if ((e as any).relatedTarget == null) setDragging(false)
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) uploadFile(file)
    }
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [uploadFile])

  // ── Paste anywhere on the page (web only) ──────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handlePaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItem = items.find((item) => item.type.startsWith('image/'))
      if (!imageItem) return
      const file = imageItem.getAsFile()
      if (file) uploadFile(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [uploadFile])

  const handleFileChange = (e: any) => {
    const file = e.target?.files?.[0]
    if (file) uploadFile(file)
    // Reset so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openPicker = () => {
    if (Platform.OS === 'web' && fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  return (
    <View style={avatarStyles.wrapper}>
      {/* Full-viewport drag overlay */}
      {dragging && Platform.OS === 'web' && (
        <View style={avatarStyles.dragOverlay} pointerEvents="none">
          <View style={avatarStyles.dragOverlayInner}>
            <FontAwesome5 name="image" size={40} color="#fff" />
            <Text style={avatarStyles.dragOverlayText}>Drop image to set profile picture</Text>
          </View>
        </View>
      )}

      <TouchableOpacity
        onPress={openPicker}
        style={[avatarStyles.circle, uploading && avatarStyles.circleUploading]}
        activeOpacity={0.8}
        {...(Platform.OS === 'web' ? ({ style: [avatarStyles.circle, uploading && avatarStyles.circleUploading, { cursor: 'pointer' } as any] }) : {})}
      >
        {displayUrl ? (
          <Image
            source={{ uri: displayUrl }}
            style={avatarStyles.image}
            resizeMode="cover"
          />
        ) : (
          <View style={avatarStyles.placeholder}>
            <FontAwesome5 name="user" size={32} color="#8a8275" />
          </View>
        )}
        {/* Camera badge */}
        <View style={avatarStyles.badge}>
          {uploading
            ? <ActivityIndicator size="small" color="#fff" />
            : <FontAwesome5 name="camera" size={11} color="#fff" />
          }
        </View>
      </TouchableOpacity>

      <View style={avatarStyles.hints}>
        <Text style={avatarStyles.hintText}>Click to upload · drag anywhere · paste</Text>
        {!!error && <Text style={avatarStyles.errorText}>{error}</Text>}
      </View>

      {/* Hidden native file input — web only */}
      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      )}
    </View>
  )
}

const avatarStyles = StyleSheet.create({
  wrapper: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 16 },
  circle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#f4efe6', borderWidth: 2, borderColor: '#dfd7c5',
    overflow: 'hidden', position: 'relative', justifyContent: 'center', alignItems: 'center',
  },
  circleUploading: { opacity: 0.6 },
  image: { width: 80, height: 80, borderRadius: 40 },
  placeholder: { justifyContent: 'center', alignItems: 'center' },
  badge: {
    position: 'absolute', bottom: 4, right: 4, width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#1a1714', justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  hints: { flex: 1, gap: 4 },
  hintText: { fontSize: 12, color: '#5a534a' },
  errorText: { fontSize: 12, color: '#7a1f24' },
  dragOverlay: {
    position: 'fixed' as any, top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(15,23,42,0.65)', zIndex: 9999,
    justifyContent: 'center', alignItems: 'center',
  },
  dragOverlayInner: { alignItems: 'center', gap: 12 },
  dragOverlayText: { color: '#fff', fontSize: 20, fontWeight: '700' },
})
```

Notes that are easy to get wrong:
- **`displayUrl = localUrl ?? (avatarUrl ? \`${avatarUrl}?v=${bust}\` : null)`** — the local object URL wins while uploading (instant feedback); once the server URL is in play, `?v=<timestamp>` is what defeats the browser cache after a replace. Drop the `bust` and replacing your photo shows the old one until a hard reload.
- The drag/paste/overlay handlers are **web-only** (`Platform.OS !== 'web'` early-returns). On native the circle is tap-to-open-picker only; wiring `expo-image-picker` for native is a Fit-to-Project decision, not a default.
- `URL.createObjectURL` leaks if you churn uploads; for a single avatar it's negligible, but if you generalize this component, revoke the old object URL.

## Screen: My Profile (`app/(app)/profile.tsx`)

One card: avatar, read-only email, and a **save-on-blur** display name. Save-on-blur (not a Save button) is deliberate — a single editable field with an explicit button is friction; blurring the field is the natural "I'm done" signal, and the inline spinner confirms the write. After a successful save the SWR auth cache is updated **without** revalidating (`{ revalidate: false }`) since the server already echoed the new value; after an avatar upload it **does** revalidate so every other consumer (navbar, sidebar) picks up the new image.

```tsx
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet, Platform, Image,
} from 'react-native'
import { useAuth } from '../../lib/useAuth'
import FontAwesome5 from '@expo/vector-icons/FontAwesome5'

// ── ProfileAvatar + avatarStyles go here (see "The avatar component" above) ──

export default function ProfileScreen() {
  const { user, mutate: mutateAuth } = useAuth()

  // Avatar
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  // Display name edit (save-on-blur)
  const [displayName, setDisplayName] = useState('')
  const [displayNameOriginal, setDisplayNameOriginal] = useState('')
  const [savingName, setSavingName] = useState(false)

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name ?? '')
      setDisplayNameOriginal(user.display_name ?? '')
      setAvatarUrl((user as any).avatar_url ?? null)
    }
  }, [user])

  // ── Display name save-on-blur ──────────────────────────────────────────
  const saveName = async () => {
    if (displayName === displayNameOriginal) return
    setSavingName(true)
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      })
      if (res.ok) {
        const json = await res.json()
        mutateAuth(json.user, { revalidate: false })
        setDisplayNameOriginal(displayName)
      }
    } finally {
      setSavingName(false)
    }
  }

  if (!user) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#7a1f24" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.pageTitle}>My Profile</Text>

      {/* ── Account info ─────────────────────────────────────────────────── */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Account</Text>

        <ProfileAvatar
          avatarUrl={avatarUrl}
          onUploaded={(url) => {
            setAvatarUrl(url)
            // Refresh the auth cache so other consumers (sidebar, etc.) see the new avatar
            mutateAuth(undefined, { revalidate: true })
          }}
        />

        <Text style={styles.label}>Email</Text>
        <Text style={styles.readOnly}>{user.email}</Text>

        <Text style={styles.label}>Display Name</Text>
        <View>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            onBlur={saveName}
            placeholder="Your name"
            placeholderTextColor="#8a8275"
          />
          {savingName && (
            <ActivityIndicator size="small" color="#7a1f24" style={{ position: 'absolute', right: 10, top: 12 }} />
          )}
        </View>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fbf8f1' },
  content: { padding: 24, paddingBottom: 60, maxWidth: 720, alignSelf: 'center', width: '100%' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  pageTitle: { fontSize: 26, fontWeight: '700', color: '#1a1714', marginBottom: 24 },
  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 20, marginBottom: 20,
    borderWidth: 1, borderColor: '#dfd7c5',
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.07)' } as any,
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 3, elevation: 2 },
    }),
  },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: '#1a1714', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '600', color: '#5a534a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, marginTop: 12 },
  readOnly: { fontSize: 15, color: '#1a1714', marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#dfd7c5', borderRadius: 7, padding: 11, fontSize: 15, color: '#1a1714', backgroundColor: '#fbf8f1' },
})
```

Email is **read-only here**. Email is the identity key (otp-auth derives `user_id` from it); changing it is an admin/identity operation, not a self-service profile edit. Render it, don't make it editable.

## Screen: Account preferences (`app/(app)/account.tsx`)

Personal preferences that aren't identity. The canonical one is **Chat Language** — the language incoming chat messages are auto-translated into. It's a chip grid plus a "No translation" escape hatch; selecting a chip `PATCH`es `chat_language` (or `null`) to `/api/auth/me` and re-fetches. This recipe owns the *preference-editing UI*; the actual translation that consumes `chat_language` is a separate chat feature and out of scope — the profile just stores the choice.

The flag/label helper lives in `lib/chatFlags.ts`:

```ts
// lib/chatFlags.ts — flag emoji + "Translated" label per supported language.
// Detect visitor timezone once at module load to pick en/pt regional flags.
const _tz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { return '' }
})()
function isAmericas(): boolean {
  return _tz.startsWith('America/') || _tz.startsWith('US/') || _tz.startsWith('Canada/')
}
const FLAG_MAP: Record<string, string> = {
  es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', zh: '🇨🇳', ja: '🇯🇵',
  ko: '🇰🇷', ar: '🇸🇦', hi: '🇮🇳', ru: '🇷🇺', vi: '🇻🇳', tl: '🇵🇭',
}
export function flagForLang(code: string): string {
  if (code === 'en') return isAmericas() ? '🇺🇸' : '🇬🇧'
  if (code === 'pt') return isAmericas() ? '🇧🇷' : '🇵🇹'
  return FLAG_MAP[code] ?? '🌐'
}
/** "Translated" label in each supported target language. */
export const TRANSLATED_LABEL: Record<string, string> = {
  en: 'Translated', es: 'Traducido', fr: 'Traduit', de: 'Übersetzt', pt: 'Traduzido',
  it: 'Tradotto', zh: '已翻译', ja: '翻訳済み', ko: '번역됨', ar: 'مترجم',
  hi: 'अनुवादित', ru: 'Переведено', vi: 'Đã dịch', tl: 'Isinalin',
}
/** All supported language codes. */
export const SUPPORTED_LANG_CODES = Object.keys(TRANSLATED_LABEL)
```

The screen (language section only — see the next subsection for the optional 2FA block):

```tsx
/** Account settings page — personal preferences. */
import React, { useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native'
import { useAuth } from '../../lib/useAuth'
import { flagForLang, TRANSLATED_LABEL, SUPPORTED_LANG_CODES } from '../../lib/chatFlags'

export default function AccountPage() {
  const { user, mutate } = useAuth()
  const [saving, setSaving] = useState(false)
  const currentLang: string | null = (user as any)?.chat_language ?? null

  async function selectLang(code: string | null) {
    if (saving) return
    setSaving(true)
    try {
      await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_language: code }),
      })
      mutate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fbf8f1' }}>
      <View style={{ padding: 24 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#1a1714', marginBottom: 4 }}>Account</Text>
        <Text style={{ fontSize: 14, color: '#5a534a', marginBottom: 24 }}>Manage your personal preferences.</Text>

        {/* Language preference section */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#dfd7c5', padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a1714', marginBottom: 4 }}>Chat Language</Text>
          <Text style={{ fontSize: 13, color: '#5a534a', marginBottom: 16 }}>
            Chat messages from others will be automatically translated to your preferred language.
          </Text>

          {saving && (
            <ActivityIndicator size="small" color="#7a1f24" style={{ marginBottom: 12, alignSelf: 'flex-start' }} />
          )}

          {/* No translation option */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <TouchableOpacity onPress={() => selectLang(null)} style={[chip.base, currentLang === null && chip.active]}>
              <Text style={[chip.label, currentLang === null && chip.labelActive]}>🌐 No translation</Text>
            </TouchableOpacity>
          </View>

          {/* Language chip grid */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {SUPPORTED_LANG_CODES.map((code) => {
              const isSelected = currentLang === code
              return (
                <TouchableOpacity key={code} onPress={() => selectLang(code)} style={[chip.base, isSelected && chip.active]}>
                  <Text style={[chip.label, isSelected && chip.labelActive]}>
                    {flagForLang(code)} {TRANSLATED_LABEL[code]}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {currentLang && (
            <Text style={{ fontSize: 12, color: '#5a534a', marginTop: 12 }}>
              Chat messages will be translated to {TRANSLATED_LABEL[currentLang] ?? currentLang}.
            </Text>
          )}
        </View>

        {/* Two-factor authentication section slots in here — see mfa-totp (optional). */}
      </View>
    </ScrollView>
  )
}

const chip = {
  base: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: '#dfd7c5', backgroundColor: '#f4efe6' } as any,
  active: { borderColor: '#7a1f24', backgroundColor: 'rgba(122,31,36,0.08)' } as any,
  label: { fontSize: 13, color: '#5a534a', fontWeight: '500' } as any,
  labelActive: { color: '#5e1518', fontWeight: '700' } as any,
}
```

### Optional: the two-factor block

If `mfa-totp` is installed, the Account screen is also where the user enables/disables 2FA and regenerates recovery codes — that block (the `MfaEnroll` / `MfaChallenge` modals, the `performWithStepUp` handler, the enabled/disabled card) is **owned by `mfa-totp`, not this recipe**. Slot it into the screen at the marked comment. If `mfa-totp` is not installed, omit it entirely — do not stub it. Keeping the boundary clean here is what lets the two recipes compose without either one half-defining the other.

`push_notifications_enabled` is the other user-doc preference otp-auth already accepts via `PATCH /api/auth/me`; surface it as a single `Switch` in this preferences screen if/when the project ships push. It's a one-field addition with the same `selectLang`-style handler.

## Entry point: the top-right avatar menu

The way a user *reaches* their profile is the small avatar in the top-right of the navbar: clicking it opens a context-menu dropdown. This is the canonical first consumer of the `avatar_url` field added above — the same `useAuth()` user object, the same `/api/auth/avatar` URL, with an initials circle as the fallback when there's no photo. It closes the loop: upload a photo on `/profile`, and (because that screen revalidates the auth cache on upload) this avatar updates everywhere without a reload.

**This is an integration fragment, not a standalone file.** It splices into the authenticated app shell's navbar — in docpost that's `app/(app)/_layout.tsx`, which is owned by the app-shell / routing layer, not by this recipe. Add the state, the initials helper, the button, and the dropdown into the existing navbar's right cluster; do **not** create a parallel layout. The styles reference docpost's `legal` theme tokens (`lib/legalTheme.ts`) — map them to the project's palette (the values are the same warm-paper hexes the screens above use: `paper #f4efe6`, `card #fbf8f1`, `ink #1a1714`, `inkSoft #5a534a`, `inkFaint #8a8275`, `rule #cdc4b1`, `ruleSoft #dfd7c5`, `oxblood #7a1f24`).

State and the initials fallback (inside the layout component):

```tsx
const router = useRouter()
const { user, logout } = useAuth()

const [showProfileMenu, setShowProfileMenu] = React.useState(false)
const profileBtnRef = useRef<View>(null)
const [profileMenuPos, setProfileMenuPos] = useState<{ top: number; right: number } | null>(null)

// Initials shown when the user has no avatar photo
const userInitials = (user.display_name || user.email || '?')
  .split(/\s+/)
  .map((p) => p[0])
  .join('')
  .slice(0, 2)
  .toUpperCase()
```

The desktop avatar button + dropdown (in the navbar's right cluster):

```tsx
<TouchableOpacity
  ref={profileBtnRef}
  style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
  onPress={() => {
    const next = !showProfileMenu
    if (next && Platform.OS === 'web' && profileBtnRef.current) {
      profileBtnRef.current.measureInWindow((x, y, w, h) => {
        setProfileMenuPos({ top: y + h + 8, right: window.innerWidth - x - w })
        setShowProfileMenu(true)
      })
    } else {
      setShowProfileMenu(next)
    }
  }}
>
  <View style={{ alignItems: 'flex-end' }}>
    <Text style={s.topbarUser}>
      {user.display_name || user.email.split('@')[0]}
    </Text>
    <Text style={s.topbarRole}>{user.role}</Text>
  </View>
  {user.avatar_url ? (
    <Image
      source={{ uri: user.avatar_url }}
      style={{ width: 30, height: 30, borderRadius: 15 }}
    />
  ) : (
    <View style={s.topbarAvatar}>
      <Text style={s.userAvatarText}>{userInitials || '·'}</Text>
    </View>
  )}
</TouchableOpacity>

{showProfileMenu && (
  <>
    {/* Full-screen transparent overlay to catch outside clicks */}
    <TouchableOpacity
      style={{
        position: 'fixed' as any,
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 9998,
        backgroundColor: 'rgba(0,0,0,0.01)',
      }}
      onPress={() => setShowProfileMenu(false)}
      activeOpacity={1}
    />
    <View style={{
      ...s.contextMenu,
      ...(Platform.OS === 'web' && profileMenuPos
        ? { position: 'fixed' as any, top: profileMenuPos.top, right: profileMenuPos.right }
        : { position: 'absolute', top: 56, right: 0 }),
    }}>
      <TouchableOpacity style={s.menuItem} onPress={() => { setShowProfileMenu(false); router.push('/profile' as any) }}>
        <FontAwesome5 name="user" size={11} color={legal.inkSoft} style={{ width: 16 }} />
        <Text style={s.menuItemText}>Profile</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.menuItem} onPress={() => { setShowProfileMenu(false); logout(); router.replace('/login' as any) }}>
        <FontAwesome5 name="exchange-alt" size={11} color={legal.inkSoft} style={{ width: 16 }} />
        <Text style={s.menuItemText}>Switch User</Text>
      </TouchableOpacity>
      <View style={s.menuDivider} />
      <TouchableOpacity style={s.menuItem} onPress={() => { setShowProfileMenu(false); logout(); router.replace('/' as any) }}>
        <FontAwesome5 name="sign-out-alt" size={11} color={legal.oxblood} style={{ width: 16 }} />
        <Text style={[s.menuItemText, { color: legal.oxblood }]}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  </>
)}
```

Three load-bearing details:
- **Positioning via `measureInWindow` + `position: fixed`.** On web the dropdown is `position: fixed` anchored to coordinates measured from the button at click time, so it escapes any `overflow: hidden` / transformed ancestor in the navbar (a plain absolutely-positioned menu gets clipped by the topbar). The navbar itself sets `overflow: 'visible'` on web for the same reason. Native falls back to `position: absolute, top: 56, right: 0`.
- **Click-outside via a full-screen transparent overlay** (`rgba(0,0,0,0.01)`, `zIndex: 9998`) sitting just under the menu (`zIndex: 9999`). This is the cross-platform way to get click-outside-to-close in React Native without DOM listeners — every tap that isn't on the menu hits the overlay and closes it. Each menu item also closes the menu before navigating.
- **The two logout flavors are intentional.** "Switch User" logs out and goes to `/login` (you're handing the machine to someone else). "Sign Out" logs out and goes to `/` (the public landing). Both call otp-auth's `logout()` from `useAuth()`, which clears the session cookie and resets the SWR cache.

On narrow viewports the topbar avatar is replaced by a profile block at the bottom of the mobile drawer — same identity + same three actions, laid out vertically (no dropdown, no overlay):

```tsx
{/* Mobile-only: profile identity + actions at the bottom of the drawer */}
{!isWide && (
  <View style={s.drawerProfileBlock}>
    <View style={s.drawerProfileIdentity}>
      {user.avatar_url ? (
        <Image source={{ uri: user.avatar_url }} style={{ width: 34, height: 34, borderRadius: 17 }} />
      ) : (
        <View style={[s.topbarAvatar, { width: 34, height: 34, borderRadius: 17 }]}>
          <Text style={s.userAvatarText}>{userInitials || '·'}</Text>
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.topbarUser} numberOfLines={1}>
          {user.display_name || user.email.split('@')[0]}
        </Text>
        <Text style={s.topbarRole} numberOfLines={1}>{user.role}</Text>
      </View>
    </View>
    <TouchableOpacity style={s.drawerProfileItem} onPress={() => router.push('/profile' as any)}>
      <FontAwesome5 name="user" size={13} color={legal.inkSoft} style={s.navIcon} />
      <Text style={s.navLabel}>Profile</Text>
    </TouchableOpacity>
    <TouchableOpacity style={s.drawerProfileItem} onPress={() => { logout(); router.replace('/login' as any) }}>
      <FontAwesome5 name="exchange-alt" size={13} color={legal.inkSoft} style={s.navIcon} />
      <Text style={s.navLabel}>Switch User</Text>
    </TouchableOpacity>
    <TouchableOpacity style={s.drawerProfileItem} onPress={() => { logout(); router.replace('/' as any) }}>
      <FontAwesome5 name="sign-out-alt" size={13} color={legal.oxblood} style={s.navIcon} />
      <Text style={[s.navLabel, { color: legal.oxblood, fontWeight: '600' }]}>Sign Out</Text>
    </TouchableOpacity>
  </View>
)}
```

Styles for both (merge into the layout's existing `StyleSheet`):

```tsx
topbarUser: { fontSize: 12, fontWeight: '600', color: legal.ink },
topbarRole: { fontSize: 10, fontWeight: '600', color: legal.inkFaint, letterSpacing: 1.8, textTransform: 'uppercase', marginTop: 1 },
topbarAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: legal.ink, justifyContent: 'center', alignItems: 'center' },
userAvatarText: { fontSize: 11, fontWeight: '600', color: legal.paper, letterSpacing: 0.4 },

contextMenu: {
  backgroundColor: legal.card, borderRadius: 2, borderWidth: 1, borderColor: legal.rule, width: 180,
  ...(Platform.OS === 'web' ? { boxShadow: legal.paperShadow } : { elevation: 8 }) as any,
  paddingVertical: 4, zIndex: 9999,
},
menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 9, gap: 10 },
menuItemText: { fontSize: 12, color: legal.ink, fontWeight: '500' },
menuDivider: { height: 1, backgroundColor: legal.ruleSoft, marginVertical: 4 },

// mobile drawer profile block
drawerProfileBlock: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: legal.rule },
drawerProfileIdentity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingBottom: 10 },
drawerProfileItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 8 },
// navIcon / navLabel are the shell's existing sidebar-row styles, reused here.
```

The navbar that hosts this must set `overflow: 'visible'` on web (so the `position: fixed` dropdown isn't clipped) and a `zIndex` above the page content. In docpost: `navbar: { ..., zIndex: 40, ...(Platform.OS === 'web' ? { overflow: 'visible' } : {}) }`.

> **Menu contents are faithful to docpost:** Profile · Switch User · Sign Out. There is intentionally **no "Account" item** in the live menu — `/account` is reached elsewhere. If your project wants it in the menu, add one `menuItem` routing to `/account` above the divider; that's a Fit-to-Project choice, not part of the captured spec.

## Wiring

- Add `/profile` and `/account` to the authenticated route group (`app/(app)/`). They sit behind the same auth gate as the rest of the app group — `useAuth()` returning `null` renders the spinner, and the layout's auth guard handles redirect-to-login.
- The **entry point** is the top-right avatar menu above — splice it into the existing app-shell navbar (and the mobile drawer). Don't invent a separate nav surface for it.
- The avatar route is the canonical place other surfaces read avatars from: render `<Image source={{ uri: \`/api/auth/avatar?uid=${someUserId}\` }} />` anywhere you show a user's photo, rather than re-deriving GCS URLs.

## Fit-to-Project

Before implementing, decide:

- **Palette.** The colors here are docpost's warm paper theme (`#fbf8f1` bg, `#7a1f24` accent, `#1a1714` ink). If the target project has a design system or token set, map these to it instead of pasting hex — but keep the *structure* (card, save-on-blur, chip grid). Don't import `admin-design-system`; that's a web-admin system and these are Expo React Native screens.
- **Native upload.** Drag/paste/click are web-only. If the app ships to iOS/Android, wire `expo-image-picker` into `openPicker` for native and feed the result through the same `uploadFile`. The route already accepts raw-binary uploads with an explicit `Content-Type`, which is the easier native path than multipart.
- **Which preferences belong on `/account`.** Chat language is the canonical one because docpost has translation. A project without translation should drop it and surface whatever user-doc preferences it does have (theme, notifications, timezone) with the same chip/switch pattern. Don't ship an empty preferences screen.
- **Avatar sensitivity.** `GET /api/auth/avatar?uid=` lets any authenticated user fetch any user's avatar. That's right for a collaborative app (you see who you're chatting with). If avatars must be tenant-scoped or private, gate the `uid` branch on a visibility check — but accept the cost: every avatar render becomes a permission check.
- **Storage backend.** docpost uses GCS via `lib/storage`. Any blob store works as long as it satisfies the `get`/`put` shape and `get` rejects with a `NotFoundError`-named error for missing keys.

## Anti-Patterns

- **Re-defining what otp-auth owns.** `useAuth`, `AuthSession`, the `users` collection, `getSession`/`requireSession`, and the base `/api/auth/me` PATCH come from otp-auth. This recipe *extends* them (avatar fields, `avatar_url` in the response, the screens). Re-declaring `IUser` or rewriting `/api/auth/me` from scratch is how the two drift — add fields and the `avatar_url` line, don't fork the route.
- **Dropping the cache-bust on the avatar URL.** The server URL is a constant (`/api/auth/avatar`). Without the `?v=<timestamp>` query the browser serves the cached old image after a replace, and the user thinks the upload failed. The `bust` state and `displayUrl` derivation are not optional polish.
- **Smuggling Attorney-of-Record / bar-admission fields back in.** This recipe is the *non-AoR* profile by explicit decision. No `bar_admissions`, no jurisdictions combobox, no AoR toggle, no `useOrgs` in the profile screen. If you find yourself importing `useOrgs` here, you've left the scope.
- **Putting the image bytes in the user document.** The doc holds `avatar_key` + `avatar_mime`; bytes live in blob storage. User docs are read on every authenticated request — a base64 image in there bloats every `getSession`.
- **Storing the avatar with a file extension in the key.** The key is `avatars/{user_id}` with no extension so "replace" is a stable-key overwrite (no orphans, URL never changes). The MIME rides in `avatar_mime`. Extension-in-key forces orphan cleanup and a changing URL.
- **A signed/per-request avatar URL.** The bytes are served by an authenticated route with its own `Cache-Control`. A signed URL per request defeats the browser cache and the 24h cache header. Keep the constant `/api/auth/avatar`.
- **Making email editable on the profile screen.** Email is the identity key (`user_id` derives from it in otp-auth). Self-service email change is an identity operation, not a profile edit — render it read-only here.
- **Save buttons on single-field edits.** Display name saves on blur; language saves on chip tap. Adding "Save" buttons re-introduces the friction the save-on-blur / save-on-select pattern exists to remove. Match the existing interaction.
- **Half-defining the 2FA block.** Either `mfa-totp` is installed and owns the 2FA section verbatim, or it's omitted. A stubbed/placeholder 2FA card that does nothing is worse than no card.
- **A clipped or no-close avatar dropdown.** The top-right menu is `position: fixed` anchored to a `measureInWindow` reading precisely so the navbar's `overflow`/transform doesn't clip it — a plain `position: absolute` menu gets cut off by the topbar. And it needs the full-screen transparent overlay for click-outside-to-close; without it the menu only closes on item tap and feels broken. Don't drop either, and make sure the host navbar is `overflow: 'visible'` on web.
- **Building a parallel layout for the avatar menu.** The menu splices into the *existing* authenticated app-shell navbar (and mobile drawer). Creating a new header/layout component to host it duplicates the shell and fights whatever recipe owns routing. It's a fragment, not a file.
- **Trusting `tsc` + "the routes exist" as done.** Exercise it: upload via click, drag, and paste; replace the photo and confirm it updates without a hard reload (the cache-bust); edit the display name and blur to confirm the inline spinner + persistence; switch language and reload to confirm it stuck. The cache-bust and the optimistic-preview bugs only show up when you actually run it.

## Verification checklist

Run the dev server and exercise each:

1. Logged in, look at the top-right navbar → the avatar (photo, or initials circle) shows with display name + role. Click it → the context menu opens below it (not clipped by the topbar) with Profile · Switch User · Sign Out. Click outside it → it closes. Click "Profile" → navigates to `/profile`. ("Switch User" → logout then `/login`; "Sign Out" → logout then `/`.) On a narrow viewport the same identity + actions appear at the bottom of the mobile drawer instead.
2. Visit `/profile` logged in → Account card renders with email (read-only), current display name, and avatar (or placeholder).
3. Click the avatar circle → file picker opens → choose an image → it previews instantly and persists; reload → still there.
4. Drag an image anywhere on the window → drop overlay appears → drop → uploads. Paste an image (Cmd/Ctrl+V) → uploads.
5. Replace the avatar with a different image → it changes **without** a hard reload (cache-bust working).
6. Upload a >5 MB file or a non-image → inline error, no write.
7. Edit display name, blur the field → inline spinner → reload → new name persists; the top-right navbar avatar+name reflect it (auth cache revalidated).
8. Visit `/account` → pick a language chip → confirmation line updates → reload → selection persists. Pick "No translation" → clears.
9. (If mfa-totp installed) the 2FA section renders and its own flows work — verify per that recipe, not this one.
