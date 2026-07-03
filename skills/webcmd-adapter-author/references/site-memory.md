# Site Memory

Site memory prevents every adapter run from starting cold. It has two layers:

1. In-repo public seeds under `references/site-memory/<site>.md`, when a seed exists.
2. Local working memory under `~/.webcmd/sites/<site>/`.

Local memory is the main write target. Do not write private cookies, tokens, or user data into the repo.

## Directory Layout

```text
~/.webcmd/sites/<site>/
  endpoints.json
  field-map.json
  notes.md
  verify/
    <cmd>.json
  fixtures/
    <cmd>-<YYYYMMDDHHMM>.json
```

## `endpoints.json`

Short endpoint name as key:

```json
{
  "search": {
    "url": "https://example.com/api/search",
    "method": "GET",
    "params": {
      "required": ["q"],
      "optional": ["page", "sort"]
    },
    "response": {
      "rowsPath": "data.items",
      "sampleFields": ["title", "url", "score"]
    },
    "verified_at": "YYYY-MM-DD",
    "notes": "What was checked and what can drift."
  }
}
```

Rules:

- Re-verify memory hits before using them.
- Treat entries older than 30 days as stale.
- Mark changed endpoints stale instead of deleting evidence silently.
- Never store cookies, bearer tokens, CSRF tokens, or private user data.

## `field-map.json`

Map source codes or unclear keys to meanings:

```json
{
  "num_comments": {
    "meaning": "commentCount",
    "verified_at": "YYYY-MM-DD",
    "source": "visible page comparison"
  }
}
```

Rules:

- Append new mappings.
- Do not overwrite existing keys without visible-page proof.
- If a conflict appears, compare against the visible page and record the decision in `notes.md`.

## `notes.md`

Prepend a dated note for each run:

```md
## YYYY-MM-DD by <agent/user>

- What changed:
- New endpoint evidence:
- Field decoding evidence:
- Pitfalls:
- Follow-up:
```

Notes should capture decisions that future agents would otherwise rediscover.

## `verify/<cmd>.json`

This is the `webcmd browser verify` fixture.

It should include:

- args
- rowCount
- columns
- types
- patterns
- notEmpty

Write it after the first passing run, then tighten it manually and verify again.

## `fixtures/<cmd>-<YYYYMMDDHHMM>.json`

Store a sanitized response sample for field decoding and offline replay.

Rules:

- Remove cookies, tokens, account identifiers, private messages, emails, and private user data.
- Keep enough response shape to decode fields later.
- Prefer local memory for raw samples; commit repo fixtures only when they are intentional tests.

## In-Repo Seeds

In-repo seeds are public knowledge only. They may contain:

- public domains
- known endpoint shapes
- non-secret header requirements
- field-code conventions
- adapter references
- pitfalls that apply to any user

They must not contain:

- private credentials
- tokens
- cookies
- user-specific IDs
- scraped private content

If `references/site-memory/<site>.md` is absent, proceed with local memory only.
