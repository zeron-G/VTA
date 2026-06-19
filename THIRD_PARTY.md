# Third-Party Software

VTA source does not vendor the OpenClaw runtime or Python dependency source.
The installer resolves them from their official package indexes.

## OpenClaw

- Package: `openclaw@2026.6.8`
- Registry: <https://www.npmjs.com/package/openclaw>
- Source: <https://github.com/openclaw/openclaw>
- License reported by npm: MIT
- Node engine reported by npm: `>=22.19.0`

VTA pins this version in its default configuration. Operators may override
`COURSE_TA_OPENCLAW_VERSION` after reviewing upstream changes.

## Python dependencies

- Requests: <https://github.com/psf/requests> (Apache-2.0)
- Beautiful Soup: <https://www.crummy.com/software/BeautifulSoup/> (MIT)
- python-pptx: <https://github.com/scanny/python-pptx> (MIT)

Installed transitive dependencies retain their upstream licenses. Package
indexes and upstream projects remain the authoritative sources for current
license and security information.
