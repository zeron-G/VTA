# ADR 0003: Production authentication and experimental OAuth

Status: Accepted

## Decision

- Use an institution-owned official OpenAI API key or approved enterprise
  Codex access token for production automation.
- Keep `zeron-G/codex_oauth` as an optional development/canary adapter only.
- Do not read or mount a person's `~/.codex/auth.json` in a shared service.
- Keep credentials in separate secret-manager identities and circuit breakers.

## Rationale

The upstream `codex_oauth` repository explicitly describes its ChatGPT backend
bridge as experimental and not a supported production API contract. Official
Codex documentation recommends API-key authentication for programmatic CLI
workflows and provides enterprise access tokens for trusted automation.

## Failover

Transport failover is allowed only before a tool side effect. Authentication,
timeout, rate-limit, and provider-unavailable errors may fail over. Invalid
input, policy rejection, and content-safety failures may not.

References:

- <https://github.com/zeron-G/codex_oauth>
- <https://developers.openai.com/codex/auth/>
- <https://developers.openai.com/codex/noninteractive/>
