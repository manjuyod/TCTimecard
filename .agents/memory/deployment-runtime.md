---
name: Deployment runtime compatibility
description: Production startup can fail before app code runs due to platform-injected Node options.
---

Production logs showed Replit injecting `--network-family-autoselection-attempt-timeout` into `NODE_OPTIONS`; Node 18 rejected it and exited before application startup.

**Why:** This caused repeated startup failures and HTTP 502 responses despite a successful deployment build.

**How to apply:** For deployment reachability failures, inspect runtime logs rather than treating successful builds as proof of health. Use a supported modern Node runtime that accepts the platform-injected option.
