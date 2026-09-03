# Model reasoning capabilities

Effort IDs are opaque, case-sensitive strings supplied by a model catalog, not an application-wide enum. New IDs do not require an rrbox release.

The canonical `reasoning_efforts` field is an ordered array:

```json
[
  {
    "id": "vendor:adaptive-v2",
    "display_name": "Adaptive",
    "description": "Provider-supplied explanation."
  }
]
```

Discovery (including `x_tokn_router.capabilities.reasoning_efforts`), manual provider settings, and the UI protocol share this shape. Older string arrays are accepted at input boundaries and normalized with a capitalized fallback label. No choices are inferred from reasoning capability booleans or model names. Missing capability metadata means Auto only.

IDs must be unique, non-empty text of at most 128 UTF-8 bytes. Labels are required (256 bytes maximum); descriptions are optional (1024 bytes maximum). Text cannot contain surrounding whitespace or control characters. A model may advertise at most 64 options. These are structural bounds, not a vocabulary restriction.

The existing saved selection `"default"` is reserved for Auto and cannot be advertised as a provider ID. rrbox omits Auto from requests. Every other selection must match an advertised ID for the selected model, including when sending a saved selection after a catalog refresh. AI SDK forwards the exact ID as `reasoning_effort`; Tokn owns provider-specific mapping and support metadata.

Rust native settings implement the same normalization and validation in `provider/reasoning.rs`. Tests cover legacy inputs, unfamiliar IDs, provider labels, persistence, worker protocols, DSH, and outgoing requests.
