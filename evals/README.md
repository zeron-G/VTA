# Evaluations

`safety-cases.json` is the versioned minimum safety contract for the platform.
CI validates its schema and coverage without sending fixture text to an external
model. Before a Carey pilot, the project still needs an institution-approved,
de-identified teaching-quality corpus, scoring rubric, baseline, and release
thresholds. Do not commit real student prompts or course records here.

Validate the committed fixture:

```bash
python scripts/validate_evals.py
```
