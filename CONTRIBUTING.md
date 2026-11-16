# Contributing

How contributing works, with what each kind of contribution needs and a worked example of each kind of evidence:
**https://providers.dev/docs/contributing/**. That page is the reference; this file gives the essentials.

- providers.dev takes no payment for listing, correcting or measuring an entry.
- Every value needs evidence: a link to the provider's own page, the sentence quoted and the day it was read; or a
  measurement with its raw result files. A value with no source is not accepted.
- A value is per provider and access method. An API key and a subscription login are different entries; a value is
  never copied from one to the other.
- Measurements are taken with [groundtruth](https://github.com/ngvoicu/groundtruth) and proposed there.

Two ways in:

- **An issue**, with the form "A value is wrong or missing". It also takes a request for a measurement. A blank
  issue is for a fault in the site itself.
- **A pull request**, one change per request. The files and their format are in the README's
  [Authoring](./README.md#authoring) section. Never edit `data/upstream/`, `data/sources/` or `data/published/`.
  `npm run build && npm run check` must pass; the build fails without evidence.

One maintainer, no promised response time.

Contact: [office@providers.dev](mailto:office@providers.dev), for what does not fit an issue (a provider that wants to
supply documentation or access for a measurement, a correction that cannot be made public, a question about the data).
A wrong or missing value goes in an issue.
