# _recipes

Skill library. Read this index, then load only the relevant SKILL.md.

| Skill | Description | Path |
|---|---|---|
| admin-prompt-queue | Async prompt execution with operator visibility — per-entity editor+history page and universal queue page sharing one data model, worker, and JobCard. | admin-prompt-queue/SKILL.md |
| chat-support | Full in-app authenticated chat system: org-scoped group chat, Ashley AI agent, chat drawer UI, translator dropdown with country flags, per-message translation chips, participant chips, read receipts, push fallback jobs, admin flagged-message page, admin prompt queue, monthly `chat_YYYY_MM` rotation, and inline rate limiting with per-message `rate_limited` stamp. Expo Router + MongoDB. | chat-support/SKILL.md |
| public-contact-chat | Unauthenticated public-facing inbound contact chat widget with a persona-driven AI agent. Monthly `contact_YYYY_MM` collection rotation, fingerprint-based bot detection with no-LLM fallback path, inline rate limiting, 30-second idle re-engagement frames, pre-generated welcome bubbles, typing indicator delay tuning, and lazy prompt seeding. | public-contact-chat/SKILL.md |
| otp-auth | Email OTP / magic-link authentication with a sessions collection, native MongoDB driver, and a LOCALHOST_AUTH_REQUIRED dev bypass. | otp-auth/SKILL.md |
| skill-creator | Use when extracting a QA-validated feature into a portable SKILL.md — what to capture, what to leave out, and how to mine anti-patterns. | skill-creator/SKILL.md |
| visitor-fingerprint | Anonymous visitor IDs via open-source FingerprintJS — client-only, cookie-cached for a year, lazy-imported, SSR-optional, no API keys. | visitor-fingerprint/SKILL.md |
| web-scraping | Reliable scraping for SPAs and anti-bot sites. Two-phase: discovery then extraction. Playwright over Firecrawl. | web-scraping/SKILL.md |
