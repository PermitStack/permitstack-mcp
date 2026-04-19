# PermitStack MCP Server

[![npm version](https://badge.fury.io/js/permitstack-mcp.svg)](https://www.npmjs.com/package/permitstack-mcp)

MCP (Model Context Protocol) server for the [PermitStack](https://permit-stack.com) building permit API.

Lets Claude and other AI agents natively search 15.6M+ U.S. building permits across 54 cities.

## What does this do?

Once installed, you can ask Claude things like:

- "Find solar permits in Austin from the last 30 days"
- "What work has been done at 123 Main St, Boston?"
- "Which contractors pulled the most HVAC permits in Phoenix last year?"
- "Show me new construction permits over $500K in Miami-Dade"

Claude will call the PermitStack API directly and give you structured results.

## Installation

You'll need a free PermitStack API key. [Get one in 2 minutes](https://permit-stack.com/#pricing) — the free tier gives you 1,000 requests per day.

### Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "permitstack": {
      "command": "npx",
      "args": ["-y", "permitstack-mcp"],
      "env": {
        "PERMITSTACK_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the PermitStack tools available.

### Programmatic use

```bash
npm install -g permitstack-mcp
PERMITSTACK_API_KEY=pk_... permitstack-mcp
```

Any MCP-compatible client can connect over stdio.

## Available tools

| Tool | Description |
|------|-------------|
| `search_permits` | Filter by city, category, date, value, contractor |
| `get_permit` | Fetch a single permit by number |
| `get_property_history` | All permits for an address |
| `search_contractors` | Find contractors by name/location |
| `get_contractor_permits` | All permits by a specific contractor |
| `get_coverage` | List supported cities |

## Data

- **15.6M+ permits** across 54 U.S. cities
- **Daily refresh** from official city open-data portals
- **AI-enriched descriptions** for structured category/scope/systems

Full coverage list: https://permit-stack.com/coverage.html

## Pricing

- Free: 1,000 requests/day
- Developer: $49/mo (60 req/min, 10K req/day)
- Startup: $149/mo (+ webhooks, bulk export)
- Growth: $499/mo (+ daily bulk exports)

See https://permit-stack.com/#pricing for details.

## Links

- 🌐 Homepage: https://permit-stack.com
- 📖 API Docs: https://api.permit-stack.com/docs
- 🐍 Python SDK: https://pypi.org/project/permitstack/
- 💬 Support: support@aisaasfactory.io

## License

Apache-2.0. See LICENSE for details.
