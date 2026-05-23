---
name: Avatar Upload
description: User profile picture upload with resizing and storage
type: enhancement
requires: recipes/otp.md
env_vars: FILE_STORAGE_PROVIDER, FILE_STORAGE_S3_BUCKET
---

# Avatar Upload

User profile picture upload with client-side cropping, server-side resizing, and multi-resolution storage. Supports configurable file storage backends (S3, local, etc.). Falls back to initials avatar if no upload.

---

## Overview

Allow authenticated users to upload and crop a profile picture. Flow:

1. User selects an image file from device
2. Client-side crop/resize preview (canvas-based)
3. Upload cropped image to server
4. Server validates (format, size), generates multiple resolutions (32x32, 64x64, 128x128, 256x256)
5. Store all sizes to file storage backend
6. Save avatar URL to user profile; display across app

Falls back to auto-generated initials avatar (e.g., "JD" for John Doe) if user hasn't uploaded.

---

## Data Model

Extend `User` table from `otp.md`:

```
User {
  // ... all fields from otp.md ...

  avatar_url:      string | null  // URL to user's 256x256 avatar
  avatar_storage_key: string | null  // internal reference for deletion
  avatar_uploaded_at: datetime | null
}
```

Avatar URLs are CDN-friendly, keyed by user_id:

```
s3://bucket/avatars/users/{user_id}/avatar-256.png
s3://bucket/avatars/users/{user_id}/avatar-128.png
s3://bucket/avatars/users/{user_id}/avatar-64.png
s3://bucket/avatars/users/{user_id}/avatar-32.png
```

---

## API Routes

### POST `/api/user/avatar`

Upload and store user avatar.

**Request:** multipart/form-data

```
{
  file: File (image/jpeg, image/png, image/webp)
  crop?: {
    x: number (pixels)
    y: number (pixels)
    width: number (pixels)
    height: number (pixels)
  }
}
```

**Validation:**
- File must be authenticated user (via session cookie)
- File size max 2 MB
- File type must be image: `image/jpeg`, `image/png`, `image/webp` only
- MIME type must match file extension (prevent content-type spoofing)
- Image dimensions must be at least 100x100 px (before crop)

**Response:**
```
{
  status: 'avatar_uploaded',
  avatar_url: string,  // full CDN URL to 256x256 version
  avatar_urls: {
    '32': string,
    '64': string,
    '128': string,
    '256': string
  }
}
```

**Side effects:**
- Delete old avatar files (if any) from storage
- Generate 4 resized versions (32, 64, 128, 256 px)
- Upload all versions to file storage
- Update `users.avatar_url` and `avatar_storage_key`
- Return new avatar URLs

### DELETE `/api/user/avatar`

Remove user avatar; revert to initials.

**Response:**
```
{
  status: 'avatar_deleted',
  avatar_url: null
}
```

**Side effects:**
- Delete avatar files from storage
- Clear `users.avatar_url` and `avatar_storage_key`
- Return null avatar_url

### GET `/api/user/avatar/:user_id?size=256`

Fetch avatar for a user (public endpoint, no auth required).

**Query params:**
- `size`: enum(32, 64, 128, 256) — defaults to 256

**Response:**
- Redirect to CDN URL (301 or 302)
- If no avatar, return initials SVG (see fallback below)

---

## File Storage Backend (Abstraction)

Define a backend-agnostic interface:

```pseudocode
interface FileStorageBackend:
  upload(key: string, buffer: Buffer, mimeType: string, metadata?: object) → Promise<{
    url: string
    key: string
  }>

  delete(key: string) → Promise<void>

  getUrl(key: string) → string
```

Implementations:
- **S3:** Store in S3 bucket, return HTTPS URL or CloudFront distribution URL
- **Local:** Store in `/public/avatars/` or similar, return relative URL
- **GCS:** Google Cloud Storage equivalent

Conditional loading based on `FILE_STORAGE_PROVIDER`:

```pseudocode
if (env.FILE_STORAGE_PROVIDER == 's3'):
  backend = new S3Backend(env.FILE_STORAGE_S3_BUCKET, ...)
else if (env.FILE_STORAGE_PROVIDER == 'local'):
  backend = new LocalBackend(env.FILE_STORAGE_LOCAL_PATH)
else:
  throw Error('FILE_STORAGE_PROVIDER not configured')
```

---

## Resizing & Image Processing

Server-side image resizing (required for consistent sizing and optimization):

```pseudocode
async function processAvatar(fileBuffer, cropRect?, targetSizes = [32, 64, 128, 256]):
  // 1. Decode image
  image = decodeImage(fileBuffer)  // using sharp, ImageMagick, Pillow, etc.

  // 2. Apply crop if provided
  if (cropRect):
    image = image.crop({
      left: cropRect.x,
      top: cropRect.y,
      width: cropRect.width,
      height: cropRect.height
    })

  // 3. Generate resized versions
  results = {}
  for size in targetSizes:
    resized = image.resize(size, size, {
      fit: 'cover',          // cover entire size, crop if needed
      position: 'center'     // center the crop
    })
    optimized = resized.toFormat('png', { quality: 80 })
    results[size] = optimized.buffer
    results[size + '_webp'] = optimized.toFormat('webp', { quality: 75 }).buffer

  return results
```

Libraries:
- **Node.js:** `sharp` (fast, supports WebP, AVIF)
- **Python:** `Pillow` or `wand`
- **Rust:** `image` crate

### Output Format

Store PNG by default; optionally offer WebP for modern browsers.

---

## UI Spec

### Avatar Upload Component

```
[Current avatar circle (128x128)]

[Upload new photo button]

[After selecting file:]
[Crop editor modal]
  [Image preview with crop handles]
  [Crop dimensions display]
  [Zoom slider]
  [Save crop button] [Cancel button]

[After upload success:]
[New avatar displayed]
[File size indicator] "156 KB"
[Delete avatar button]
```

### Initials Avatar Fallback

If user has no avatar, display auto-generated initials:

```
[Circle with initials: "JD"]
[Style: background color deterministic from user_id hash]
[Font: bold, white text, 50% of circle size]
```

Initials avatar on server side:

```pseudocode
function getInitialsAvatar(user):
  initials = extractInitials(user.display_name)  // first letter of each name
  color = hashToColor(user.user_id)  // deterministic color from user_id
  svgUrl = createInitialsSvg(initials, color, size)
  return svgUrl
```

Return as SVG (lightweight, no file storage needed):

```
GET /api/user/avatar/123?size=256&fallback=initials
→ <svg><circle fill="#5E8DEE"/><text>JD</text></svg>
```

---

## Client-Side Crop Preview

Before upload, allow user to crop/position avatar:

```pseudocode
// Pseudocode for React component
function AvatarUpload():
  [file, setFile] = useState(null)
  [crop, setCrop] = useState({ x: 0, y: 0, width: 100, height: 100 })

  onFileSelect(event):
    file = event.target.files[0]
    setFile(file)
    showCropModal()

  onCropSave():
    // Send to server with crop coordinates
    formData = new FormData()
    formData.append('file', file)
    formData.append('crop', JSON.stringify(crop))
    fetch('/api/user/avatar', { method: 'POST', body: formData })

  return JSX
```

Libraries:
- **React:** `react-image-crop`, `react-easy-crop`
- **Vue:** `vue-crop-kit`
- **Vanilla:** `Croppie` (lightweight)

---

## CDN & Caching

### Avatar URLs

Store avatars with immutable cache headers:

```pseudocode
GET /avatars/users/{user_id}/avatar-256.png
Response headers:
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: image/png
```

If user uploads a new avatar, change the storage key or add versioning:

```
/avatars/users/{user_id}/avatar-256.png?v=2
```

Or use unique keys:

```
/avatars/users/{user_id}/avatar-256-{timestamp}.png
```

### Cloudflare / CDN Configuration

- Enable image optimization: automatic WebP, AVIF, responsive sizing
- Cache 30 days for immutable avatars
- Purge old avatars when new ones are uploaded

---

## Security Notes

### 1. File Type Validation

Validate both MIME type (from `Content-Type` header) and actual file signature:

```pseudocode
function validateImageFile(buffer, contentType):
  // Check Content-Type
  if (contentType not in ['image/jpeg', 'image/png', 'image/webp']):
    throw Error('Invalid MIME type')

  // Check magic bytes (file signature)
  signature = buffer.slice(0, 12)
  if (signature.startsWith(0xFFD8FF)):  // JPEG
    return 'image/jpeg'
  if (signature.startsWith(0x89504E47)):  // PNG
    return 'image/png'
  if (signature.startsWith(0x52494646) and buffer.includes(0x57454250)):  // WebP
    return 'image/webp'

  throw Error('File signature does not match MIME type')
```

### 2. EXIF Data Removal

Images may contain sensitive metadata (camera GPS, timestamps, etc.). Strip all EXIF data during resizing:

```pseudocode
image = decodeImage(fileBuffer)
image = image.withoutEXIF()  // or .withoutMetadata()
```

### 3. File Size Limits

Enforce upload limits to prevent abuse:
- Max 2 MB per file
- Max 10 MB total per user (quota)
- Rate limit: 1 upload per 10 seconds per user

### 4. Storage Key Predictability

Do NOT expose sequential or predictable storage keys (e.g., `/avatars/1.png`, `/avatars/2.png`). Use user_id or hash:

```
/avatars/users/{user_id}/avatar-{timestamp}.png
```

This prevents enumeration attacks (scanning for avatars by ID).

---

## Gotchas

### 1. Crop Coordinates Client vs Server

Client sends crop coordinates from the preview image. If preview was scaled (e.g., displayed at 300x300 but actual uploaded image is 800x800), crop coordinates must be scaled accordingly:

```pseudocode
// Client preview: 300x300
// Actual image: 800x800
// Client sends crop: { x: 50, y: 50, width: 200, height: 200 }

// Server must scale:
scale = actualImageSize / previewSize  // 800 / 300 = 2.67
serverCrop = {
  x: crop.x * scale,         // 50 * 2.67 = 133
  y: crop.y * scale,
  width: crop.width * scale,
  height: crop.height * scale
}
```

### 2. Race Conditions with Multiple Uploads

User uploads avatar, then immediately uploads another before first completes. Both requests are processed concurrently. Both might update `users.avatar_url`, but the second finishes first → first request's avatar wins.

**Mitigation:** Use a per-user avatar upload lock or increment an `avatar_version` counter:

```pseudocode
POST /api/user/avatar:
  user = getAuthenticatedUser()

  // Lock: only one avatar upload per user at a time
  if (not acquireLock('avatar:' + user.user_id, 60 seconds)):
    return 409 { message: 'Upload in progress; please wait' }

  try:
    processAndStore()
    releaseLock()
  catch:
    releaseLock()
    rethrow
```

### 3. WebP Browser Support

WebP is not supported in older browsers. Always provide fallback (PNG).

Serve WebP to modern browsers, PNG to older ones:

```pseudocode
GET /api/user/avatar?size=256&format=auto
Accept: image/webp, image/png

if (request.acceptsWebP and hasWebP):
  serve webp
else:
  serve png
```

Or use `<picture>` tag in HTML:

```html
<picture>
  <source srcset="avatar.webp" type="image/webp">
  <img src="avatar.png" alt="User avatar">
</picture>
```

### 4. Malformed Crop Coordinates

Client sends invalid crop (e.g., negative width, crop outside image bounds):

```pseudocode
function validateCropRect(crop, imageWidth, imageHeight):
  if (crop.width <= 0 or crop.height <= 0):
    throw Error('Invalid crop dimensions')
  if (crop.x < 0 or crop.y < 0):
    throw Error('Crop outside image bounds')
  if (crop.x + crop.width > imageWidth):
    throw Error('Crop width exceeds image bounds')
  if (crop.y + crop.height > imageHeight):
    throw Error('Crop height exceeds image bounds')

  return true
```

### 5. Storage Key Not Cleared on Failed Upload

If avatar upload fails partway through, old avatar URL might be orphaned in storage. Clean up with a background job or during delete:

```pseudocode
POST /api/user/avatar:
  oldStorageKey = user.avatar_storage_key

  try:
    newKey = uploadNewAvatar()
    user.avatar_storage_key = newKey
    user.save()
  catch:
    // Upload failed; delete partially uploaded files
    deleteFromStorage(newKey)
    rethrow

  // Upload succeeded; clean up old avatar in background
  deleteFromStorageAsync(oldStorageKey)
```

