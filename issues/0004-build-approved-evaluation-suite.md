# P1: Build an institution-approved teaching and safety evaluation suite

Category: Agent quality / Safety

Impact: Backend fallback can change answer quality, academic-integrity behavior,
and refusal consistency without detection.

Acceptance criteria: De-identified golden Q&A, cross-course isolation, prompt
injection, homework refusal, accessibility, bilingual, latency, cost, and
fallback parity evals with release thresholds.

Verification: Versioned eval report required by CI/release policy, with no raw
student production data in the repository.
