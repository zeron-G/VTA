# Third-Party Software

VirtualTeachingAssistant does not vendor these runtimes. Operators must pin,
scan, and review them through the institution's software-supply-chain process.

## Agent runtimes

- OpenClaw source: <https://github.com/openclaw/openclaw>
- OpenClaw npm: <https://www.npmjs.com/package/openclaw>
- Codex CLI source: <https://github.com/openai/codex>
- Codex documentation: <https://developers.openai.com/codex/>
- Experimental OAuth bridge: <https://github.com/zeron-G/codex_oauth>

The legacy deployer currently pins `openclaw@2026.6.8`. The OAuth bridge uses
an unsupported ChatGPT backend and is development-only; it is not a production
availability mechanism.

## Python dependencies

- OpenAI Python: <https://github.com/openai/openai-python> (Apache-2.0)
- Requests: <https://github.com/psf/requests> (Apache-2.0)
- Beautiful Soup: <https://www.crummy.com/software/BeautifulSoup/> (MIT)
- python-pptx: <https://github.com/scanny/python-pptx> (MIT)

Installed transitive dependencies retain their upstream licenses. Package
indexes and upstream repositories are authoritative for current license and
security information.
