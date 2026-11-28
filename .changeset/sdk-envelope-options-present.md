---
"@your-move/sdk": patch
---

`gameEnvelopeSchema` requires `options` to be present (any value, `null` included), as every
envelope the server sends has it. Its type doesn't change; the server's OpenAPI document now marks
the field required, so the generated client's `GameEnvelope` matches the SDK's (02 §7.4).
