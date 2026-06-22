#!/usr/bin/env node
/**
 * PermitStack MCP Server
 *
 * Exposes the PermitStack building permit API as MCP tools
 * that Claude (and other AI agents) can call natively.
 *
 * Requires PERMITSTACK_API_KEY environment variable.
 * Get a free key at https://permit-stack.com
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "1.1.0";
const API_BASE = process.env.PERMITSTACK_API_URL || "https://api.permit-stack.com";
const API_KEY = process.env.PERMITSTACK_API_KEY;

if (!API_KEY) {
  console.error("Error: PERMITSTACK_API_KEY environment variable is required.");
  console.error("Get a free key at https://permit-stack.com");
  process.exit(1);
}

/**
 * Perform an authenticated request to the PermitStack API.
 */
async function apiRequest(
  path: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      "X-API-Key": API_KEY!,
      "Accept": "application/json",
      "User-Agent": `permitstack-mcp/${VERSION}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new McpError(
      ErrorCode.InternalError,
      `PermitStack API error ${response.status}: ${body || response.statusText}`
    );
  }

  return response.json();
}

/**
 * Tool definitions. Each tool maps an MCP call to a PermitStack API endpoint.
 *
 * Optional per-tool wiring:
 *   - paramMap:    rename an input arg to the backend query-param name
 *                  (e.g. { permit_number: "q" }).
 *   - fixedParams: query params always sent (e.g. { per_page: 1 }).
 *   - endpoint:    may contain `{name}` path placeholders, filled from args
 *                  (e.g. /v1/contractors/{contractor_id}/permits).
 */
const TOOLS = [
  {
    name: "search_permits",
    description:
      "Search building permits by location, category, status, date range, and value. " +
      "Use this to find recent permits of a specific type in a city (e.g., 'solar permits in Austin, TX from last month') " +
      "or to filter by contractor work, renovation scope, or property value. " +
      "Returns a paginated list with addresses, dates, values, contractors, and descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name, e.g. 'Austin', 'Boston', 'Miami-Dade County'",
        },
        state: {
          type: "string",
          description: "Two-letter US state code, e.g. 'TX', 'MA', 'FL'",
        },
        zip_code: {
          type: "string",
          description: "5-digit ZIP code",
        },
        category: {
          type: "string",
          description:
            "Permit category (case-insensitive). Common values: SOLAR, ROOFING, HVAC, NEW_CONSTRUCTION, POOL, ELECTRICAL, PLUMBING, DEMOLITION, MECHANICAL, RENOVATION",
        },
        status: {
          type: "string",
          description: "Permit status, e.g. 'ISSUED', 'FINAL', 'EXPIRED', 'FILED'",
        },
        property_type: {
          type: "string",
          description: "Property type, e.g. 'RESIDENTIAL', 'COMMERCIAL'",
        },
        filed_after: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) — only permits filed on or after this date",
        },
        filed_before: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) — only permits filed on or before this date",
        },
        issued_after: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) — only permits issued on or after this date",
        },
        issued_before: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) — only permits issued on or before this date",
        },
        min_value: {
          type: "number",
          description: "Minimum estimated project value in dollars",
        },
        max_value: {
          type: "number",
          description: "Maximum estimated project value in dollars",
        },
        lat: {
          type: "number",
          description: "Latitude for radius search (use with lng)",
        },
        lng: {
          type: "number",
          description: "Longitude for radius search (use with lat)",
        },
        radius_miles: {
          type: "number",
          description: "Radius in miles for lat/lng search (max 50, default 5)",
        },
        q: {
          type: "string",
          description: "Free-text search over description, address, and permit number",
        },
        contractor_name: {
          type: "string",
          description: "Filter by contractor name (partial match supported)",
        },
        per_page: {
          type: "integer",
          description: "Results per page (default 25, max 100)",
          default: 25,
        },
        page: {
          type: "integer",
          description: "Page number, 1-based (default 1)",
          default: 1,
        },
      },
    },
    endpoint: "/v1/permits/search",
  },
  {
    name: "get_permit",
    description:
      "Look up a permit by its issuing-jurisdiction permit number. Optionally narrow by city/state. " +
      "Returns the best-matching permit with full details including classified fields and contractor info.",
    inputSchema: {
      type: "object",
      properties: {
        permit_number: {
          type: "string",
          description: "The permit number from the issuing jurisdiction",
        },
        city: {
          type: "string",
          description: "City where the permit was issued (optional, narrows the match)",
        },
        state: {
          type: "string",
          description: "Two-letter state code (optional, narrows the match)",
        },
      },
      required: ["permit_number"],
    },
    // No single lookup-by-number route exists; resolve via full-text search (q),
    // returning the top match.
    endpoint: "/v1/permits/search",
    paramMap: { permit_number: "q" },
    fixedParams: { per_page: 5 },
  },
  {
    name: "get_property_history",
    description:
      "Get the full permit history for a property street address. Useful for understanding what work has been done " +
      "on a building — renovations, additions, systems replacements, solar, roofing. Covers all permit categories. " +
      "Pass only the street address (e.g. '123 Main St'); do not append city/state.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Street address only, e.g. '123 Main St' (min 3 characters)",
        },
      },
      required: ["address"],
    },
    endpoint: "/v1/property/history",
  },
  {
    name: "search_contractors",
    description:
      "Search contractors by name, location, or specialty. Returns contractor names, " +
      "permit counts, total/average project value, and where they work. Sort is by activity (most permits first).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Contractor name (partial match)",
        },
        city: {
          type: "string",
          description: "City where the contractor has worked",
        },
        state: {
          type: "string",
          description: "Two-letter state code",
        },
        specialty: {
          type: "string",
          description: "Specialty/trade to filter by, e.g. 'solar', 'roofing', 'hvac'",
        },
        min_permits: {
          type: "integer",
          description: "Only contractors with at least this many permits",
        },
        per_page: {
          type: "integer",
          description: "Results per page (default 25, max 100)",
          default: 25,
        },
        page: {
          type: "integer",
          description: "Page number, 1-based (default 1)",
          default: 1,
        },
      },
    },
    endpoint: "/v1/contractors/search",
  },
  {
    name: "get_contractor_permits",
    description:
      "Get all permits pulled by a specific contractor (by their UUID from search_contractors). " +
      "Useful for analyzing a contractor's work history, specializations, and typical project values.",
    inputSchema: {
      type: "object",
      properties: {
        contractor_id: {
          type: "string",
          description: "Contractor UUID from search_contractors results",
        },
        per_page: {
          type: "integer",
          description: "Results per page (default 25, max 100)",
          default: 25,
        },
        page: {
          type: "integer",
          description: "Page number, 1-based (default 1)",
          default: 1,
        },
      },
      required: ["contractor_id"],
    },
    endpoint: "/v1/contractors/{contractor_id}/permits",
  },
  {
    name: "get_coverage",
    description:
      "List the jurisdictions PermitStack covers, with permit counts and data-freshness per jurisdiction. " +
      "Use this first if you're unsure whether a specific city/county is supported.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    endpoint: "/v1/permits/stats/coverage",
  },
] as const;

type ToolDef = (typeof TOOLS)[number];

/**
 * Build the concrete request (path + query params) for a tool call,
 * applying fixedParams, paramMap renames, and `{placeholder}` path substitution.
 */
function buildRequest(
  tool: ToolDef,
  args: Record<string, unknown>
): { path: string; params: Record<string, unknown> } {
  const fixed = "fixedParams" in tool ? (tool.fixedParams as Record<string, unknown>) : {};
  const params: Record<string, unknown> = { ...fixed, ...args };

  // Rename input args to backend query-param names.
  if ("paramMap" in tool && tool.paramMap) {
    for (const [from, to] of Object.entries(tool.paramMap as Record<string, string>)) {
      if (params[from] !== undefined) {
        params[to] = params[from];
        delete params[from];
      }
    }
  }

  // Fill `{name}` path placeholders from params, then drop them from the query.
  const path = tool.endpoint.replace(/\{(\w+)\}/g, (_m: string, key: string) => {
    const value = params[key];
    delete params[key];
    return encodeURIComponent(String(value ?? ""));
  });

  return { path, params };
}

/**
 * Initialize the MCP server.
 */
const server = new Server(
  {
    name: "permitstack",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS.find((t) => t.name === name);

  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  const { path, params } = buildRequest(tool, (args ?? {}) as Record<string, unknown>);
  const result = await apiRequest(path, params);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

/**
 * Run the server over stdio. Claude Desktop and most MCP clients speak this protocol.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`PermitStack MCP server v${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
