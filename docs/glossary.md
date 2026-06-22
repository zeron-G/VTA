# Glossary

## Action proposal

A typed description of an intended external mutation. It is agent output, not
authorization and not proof that an action occurred.

## Agent backend

An implementation of `AgentBackend` that produces a bounded `AgentResult` under
an immutable capability envelope. Native, Codex, and OpenClaw are backend tiers.

## Agent tier

Fallback priority: native, Codex, then OpenClaw. It does not mean that later
tiers have more authority or access.

## Capability

A named operation class such as reasoning, course read, response draft, or
Canvas write. Capabilities are intersected across role, mode, request, and
backend; they are never inferred from prompt text.

## Capability envelope

The immutable capability set, data ceiling, and side-effect flag passed to one
agent invocation. Fallback can only preserve or reduce it.

## Channel adapter

The edge integration that verifies provider input, normalizes it into a
`TeachingRequest`, and delivers a `TeachingResponse`. Discord is a channel, not
the platform architecture.

## Compatibility layer

The original `course_ta_deployer` package and OpenClaw integration preserved for
migration and sandbox use. It is distinct from the V2 platform runtime.

## Contract only

A typed port, model, registry, or wrapper exists, but the repository does not
ship a complete production implementation or composition for it.

## Data classification

The platform sensitivity level: public, internal, restricted, or highly
restricted. It determines policy and backend/transport eligibility.

## Degraded response

A response produced by a later eligible backend after an earlier backend was
skipped or failed. Degraded does not mean less policy enforcement.

## Idempotency key

A stable reference used to prevent replay or duplicate external effects. The
domain carries one; durable ingress/outbox enforcement is still planned.

## LLM transport

The provider/authentication boundary that turns an `LLMRequest` into an
`LLMResult`. It is separate from the agent backend that plans or composes the
request.

## Native agent

The planned Python-native teaching engine. Its protocol and adapter exist; the
engine itself is not implemented.

## OpenClaw backend

The emergency/compatibility agent tier. V2 contains a safe client boundary;
the legacy deployer separately installs and configures the OpenClaw runtime.

## Policy engine

The deterministic component that maps trusted role, teaching mode, requested
capabilities, and data class into an immutable reasoning-only envelope or denial.

## Side effect

An externally observable mutation such as sending a message, writing Canvas, or
changing configuration. Agents cannot execute side effects in the V2 design.

## Skill

Versioned teaching instructions and declared modes/capabilities. Skills shape
pedagogy and evidence use but cannot override platform policy.

## Teaching request

The normalized, immutable domain input containing tenant, course, actor, mode,
content, data class, identifiers, time, and bounded metadata.

## Tenant

The top-level isolation scope for institution/organization data and policy. A
tenant reference alone is not proof of authorization.

## V2

The `virtual_teaching_assistant` Python platform foundation introduced in
package version 2.0.0, distinct from the original deployment compatibility path.
