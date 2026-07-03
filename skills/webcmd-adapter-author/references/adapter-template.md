# Adapter Template

Use this after recon, endpoint verification, field decoding, output design, and strategy-note writing are complete.

## Create The File

For private iteration:

```bash
webcmd browser init <site>/<name> --strategy <strategy>
```

Write the working file at:

```text
~/.webcmd/clis/<site>/<name>.js
```

Copy it to the repo only when preparing a PR:

```text
clis/<site>/<name>.js
```

## Minimal Registry Shape

Adapters register commands with `cli` from `@agentrhq/webcmd/registry`.

```js
import { cli } from '@agentrhq/webcmd/registry';

cli({
  site: 'hackernews',
  name: 'top',
  access: 'read',
  description: 'Hacker News top stories',
  domain: 'news.ycombinator.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'Number of rows' },
  ],
  columns: ['rank', 'title', 'url', 'score', 'author', 'commentCount'],
  pipeline: [
    { navigate: 'https://news.ycombinator.com/' },
    {
      evaluate: `(async () => {
        const rows = [...document.querySelectorAll('.athing')].slice(0, \${{ args.limit }});
        return rows.map((row, index) => {
          const subtext = row.nextElementSibling;
          const titleLink = row.querySelector('.titleline a');
          return {
            rank: index + 1,
            title: titleLink?.textContent?.trim() || '',
            url: titleLink?.href || '',
            score: Number((subtext?.querySelector('.score')?.textContent || '').match(/\\d+/)?.[0] || 0),
            author: subtext?.querySelector('.hnuser')?.textContent?.trim() || '',
            commentCount: Number((subtext?.textContent || '').match(/(\\d+)\\s+comments?/)?.[1] || 0),
          };
        });
      })()`,
    },
    {
      map: {
        rank: '${{ item.rank }}',
        title: '${{ item.title }}',
        url: '${{ item.url }}',
        score: '${{ item.score }}',
        author: '${{ item.author }}',
        commentCount: '${{ item.commentCount }}',
      },
    },
    { limit: '${{ args.limit }}' },
  ],
});
```

Treat this as shape guidance, not a universal solution. Prefer the closest existing adapter for the same site or source type.

## Imports

Allowed imports:

```js
import { cli } from '@agentrhq/webcmd/registry';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@agentrhq/webcmd/errors';
```

Rules:

- Do not add third-party dependencies.
- Do not import private repo internals unless an established neighboring adapter already does so.
- Keep helpers local unless there is real duplication in the same site directory.

## Required Fields

| Field | Rule |
| --- | --- |
| `site` | Directory/site id. Keep lowercase and stable. |
| `name` | Command id. Keep lowercase and stable. |
| `access` | Usually `read`; use write-like access only for commands that mutate state. |
| `description` | One clear sentence. |
| `domain` | Primary domain for auth and help output. |
| `args` | Include type, default, and help for every external parameter. |
| `columns` | Must exactly match row keys, including order. |
| `pipeline` or `func` | Use the style already established by nearby adapters. |

## Parameter Safety

- Validate user-facing numbers before use.
- Throw `ArgumentError` for invalid external parameters.
- Do not silently clamp with `Math.max` / `Math.min` unless the user explicitly requested clamping and the output says so.
- Do not let a failed selector or missing field become a valid empty result.

## Row Safety

Before mapping rows:

- Confirm the response contains the expected shape.
- Throw `EmptyResultError` only when the site truly reports no results.
- Throw `CommandExecutionError` when the response shape is wrong, parsing fails, or an endpoint returns HTML instead of expected data.
- Use `AuthRequiredError` when login is required or session expired.
- Use `TimeoutError` when the page or endpoint did not settle in time.

## Column Alignment Checklist

Before verify:

```text
[ ] columns array and row keys match exactly
[ ] no intermediate object key overlaps a column accidentally
[ ] values use documented units
[ ] percentage scale is consistent
[ ] dates are ISO or clearly documented
[ ] URLs are absolute when users need to click them
[ ] one row was compared with the visible page
```

## Verify

Run:

```bash
webcmd browser verify <site>/<name> --trace retain-on-failure
```

After the first passing run, write a fixture:

```bash
webcmd browser verify <site>/<name> --write-fixture
```

Then tighten the fixture manually:

- Add `notEmpty` for essential columns.
- Add `patterns` for URL, ID, date, or slug formats.
- Set realistic `rowCount`.
- Keep `types` narrow.

Run verify again and confirm the fixture matches.
