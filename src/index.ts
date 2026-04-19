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
      "User-Agent": "permitstack-mcp/1.0.0",
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
        category: {
          type: "string",
          description:
            "Permit category. Common values: SOLAR, ROOFING, HVAC, NEW_CONSTRUCTION, POOL, ELECTRICAL, PLUMBING, DEMOLITION, MECHANICAL, RENOVATION",
        },
        status: {
          type: "string",
          description: "Permit status, e.g. 'ISSUED', 'FINAL', 'EXPIRED'",
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
        contractor_name: {
          type: "string",
          description: "Filter by contractor name (partial match supported)",
        },
        limit: {
          type: "integer",
          description: "Results per page (default 25, max 100)",
          default: 25,
        },
        offset: {
          type: "integer",
          description: "Pagination offset",
          default: 0,
        },
      },
    },
    endpoint: "/v1/permits/search",
    method: "GET",
  },
  {
    name: "get_permit",
    description:
      "Fetch a single permit by its unique permit_number and jurisdiction. " +
      "Returns full details including all classified fields (scope, subcategory, affected systems) and contractor info.",
    inputSchema: {
      type: "object",
      properties: {
        permit_number: {
          type: "string",
          description: "The permit number from the issuing jurisdiction",
        },
        city: {
          type: "string",
          description: "City where the permit was issued",
        },
        state: {
          type: "string",
          description: "Two-letter state code",
        },
      },
      required: ["permit_number", "city", "state"],
    },
    endpoint: "/v1/permits/lookup",
    method: "GET",
  },
  {
    name: "get_property_history",
    description:
      "Get the full permit history for a property address. Useful for understanding what work has been done " +
      "on a building — renovations, additions, systems replacements. Covers all permit categories.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Street address, e.g. '123 Main St'",
        },
        city: {
          type: "string",
          description: "City name",
        },
        state: {
          type: "string",
          description: "Two-letter state code",
        },
      },
      required: ["address", "city", "state"],
    },
    endpoint: "/v1/properties/history",
    method: "GET",
  },
  {
    name: "search_contractors",
    description:
      "Search licensed contractors by name, city, or work category. Returns contractor names, " +
      "number of permits pulled, total project value, and jurisdictions they work in.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Contractor name (partial match)",
        },
        city: {
          type: "string",
          description: "City where contractor has worked",
        },
        state: {
          type: "string",
          description: "Two-letter state code",
        },
        category: {
          type: "string",
          description: "Work category to filter by (SOLAR, HVAC, etc.)",
        },
        limit: {
          type: "integer",
          default: 25,
        },
      },
    },
    endpoint: "/v1/contractors/search",
    method: "GET",
  },
  {
    name: "get_contractor_permits",
    description:
      "Get all permits pulled by a specific contractor. Useful for analyzing a contractor's work history, " +
      "specializations, and typical project values.",
    inputSchema: {
      type: "object",
      properties: {
        contractor_id: {
          type: "string",
          description: "Contractor UUID from search_contractors results",
        },
        limit: {
          type: "integer",
          default: 25,
        },
      },
      required: ["contractor_id"],
    },
    endpoint: "/v1/contractors/permits",
    method: "GET",
  },
  {
    name: "get_coverage",
    description:
      "List all cities and jurisdictions currently covered by PermitStack, with permit counts per city. " +
      "Use this first if you're unsure whether a specific city is supported.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    endpoint: "/v1/coverage",
    method: "GET",
  },
] as const;

/**
 * Initialize the MCP server.
 */
const server = new Server(
  {
    name: "permitstack",
    version: "1.0.0",
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

  const result = await apiRequest(tool.endpoint, args ?? {});

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
  console.error("PermitStack MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
