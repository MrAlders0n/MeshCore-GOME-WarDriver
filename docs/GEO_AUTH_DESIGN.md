# Geo Auth Design

## Goals

- Provide a secure authentication mechanism for wardrive post submissions.
- Prevent accidental token leakage via URLs, logs, or referrers.
- Keep the client implementation simple and standards-based.

## Confirmed Decisions

- **Token transport for wardrive posts MUST use the HTTP `Authorization: Bearer <token>` header.**
- **Tokens MUST NEVER be accepted via query string parameters.**
- Tokens are treated as sensitive secrets and must be stored securely on device.
- If a token is compromised, it can be rotated/revoked without requiring a client app update.

## Open Items

- Ensure server and reverse-proxy logging does **not** record `Authorization` headers (or otherwise redact them), especially for wardrive endpoints.

## Notes

### Rationale

Using the `Authorization: Bearer` header:

- Aligns with standard HTTP auth practices.
- Avoids token exposure in shared links, browser history, referrer headers, and many default access logs.

Query string tokens are explicitly forbidden because they are commonly logged and leaked.
