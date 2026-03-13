# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x (latest) | Yes |

Only the latest release on the `0.x` line receives security fixes. Upgrade to the latest version before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/piyushgupta344/ai-sdk-rate-limiter/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The affected versions
- Any suggested mitigations you are aware of

You will receive an acknowledgement within 48 hours and a resolution timeline within 7 days of triage.

## Scope

This library is middleware that runs in your Node.js process. It:

- Makes no outbound network connections of its own
- Stores no credentials or secrets
- The optional Redis integration uses whatever connection you pass in — securing that connection is your responsibility

Out of scope: vulnerabilities in peer dependencies (`ioredis`, `@opentelemetry/api`, `@ai-sdk/provider`) should be reported to those projects directly.
