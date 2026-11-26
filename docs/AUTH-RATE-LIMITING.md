# Authentication rate limiting

The former middleware was `express-rate-limit` in `backend/services/vehicles/auth-routes.js`. It used the default key generator (`req.ip`) and `MemoryStore`, with 20 requests per 15 minutes in production. Floci forwards API Gateway requests to Lambda from a shared proxy address, so unrelated users, Admins, sessions and browser origins consumed one bucket. MemoryStore was also isolated to each warm Lambda instance.

Motorlog now uses `auth-rate-limit.js`, backed by atomic conditional updates in `CMLAuthRateLimits`. Keys are an HMAC of normalized email identity and route. Raw email addresses, tokens, passwords, OTPs, and IP headers are not stored. Client-controlled `Forwarded` and `X-Forwarded-For` values are deliberately ignored.

Policies are 20 attempts per aligned 15-minute window for login/general authentication, 10 per 15 minutes for OTP verification, and one per minute for confirmation-code resend. A 500-request/15-minute global circuit breaker bounds distributed abuse. Separate account identities do not collide. The same account intentionally shares its bucket between CloudFront, S3 and localhost origins and between sessions, because switching browser origin must not bypass brute-force protection.

Blocked responses contain `Retry-After`, `RateLimit`, `RateLimit-Policy`, JSON `error.retryAfter`, and exact-origin CORS headers. The frontend shows both minutes and the server-provided seconds. DynamoDB TTL on `expiresAt` removes stale windows; expired keys are inert even if an emulator delays physical deletion.

The limiter cannot safely enforce a per-network quota because Floci does not provide a cryptographically trusted original client IP. The high global circuit breaker is therefore the only shared protection in addition to per-account limits and Cognito's own throttling. Fixed windows can permit a burst across a window boundary; DynamoDB conditional writes still make each window consistent across concurrent Lambda instances.
