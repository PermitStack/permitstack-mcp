#!/usr/bin/env node
/**
 * PermitStack MCP Server
 *
 * Exposes the PermitStack building permit API as MCP tools
 * that Claude (and other AI agents) can call natively.
 *
 * Requires PERMITSTACK_API_KEY environment variable.
 * Get a free key at https://permit-stack.com
 *
 * FREE-TIER WINDOW. A free key can only see the last 30 days. A request for older dates is
 * not refused -- it is clamped to that window and the response says so via
 * account_window_clamped / account_window_days / account_window_from. An agent that ignores those
 * fields will report "no permits" for a property we hold years of history on, which is a
 * confidently wrong answer rather than a missing one. Paid plans have no date limit.
 */

import { sanitizeOutput, neutralError } from "./output.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "1.3.0";
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
    throw new McpError(
      ErrorCode.InternalError,
      neutralError(response.status)
    );
  }

  return sanitizeOutput(await response.json());
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
  "name": "search_violations",
  "description": "Search agency findings by place, case number, status, category and date. record_kind defaults to violation; complaint returns reports, not established violations. total_capped means total is a lower bound; total_unknown means total is unknown. Source metadata states data_through, coverage_window and count_unit.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "address": {
        "type": "string",
        "description": "Street address, partial, case-insensitive"
      },
      "parcel": {
        "type": "string",
        "description": "Parcel / APN / folio / BBL (formatting ignored)"
      },
      "city": {
        "type": "string",
        "description": "City name (matches the address city or the issuing jurisdiction)"
      },
      "state": {
        "type": "string",
        "description": "2-letter state code"
      },
      "zip_code": {
        "type": "string",
        "description": "5-digit ZIP"
      },
      "jurisdiction_id": {
        "type": "string",
        "format": "uuid",
        "description": "A jurisdiction id from /v1/jurisdictions"
      },
      "lat": {
        "type": "number"
      },
      "lng": {
        "type": "number"
      },
      "radius_miles": {
        "type": "number",
        "maximum": 50,
        "exclusiveMinimum": 0,
        "description": "Radius in miles around lat/lng (default 1)"
      },
      "date_after": {
        "type": "string",
        "format": "date",
        "description": "record_date on or after (undated records never match)"
      },
      "date_before": {
        "type": "string",
        "format": "date",
        "description": "record_date on or before"
      },
      "status": {
        "enum": [
          "OPEN",
          "CLOSED",
          "COMPLIED",
          "ABATED",
          "CITED",
          "DISMISSED",
          "UNKNOWN"
        ],
        "type": "string",
        "description": "OPEN, CLOSED, COMPLIED, ABATED, CITED, DISMISSED or UNKNOWN"
      },
      "open_only": {
        "type": "boolean",
        "description": "Only OPEN records (a citation or judgment is not open)",
        "default": false
      },
      "category": {
        "enum": [
          "STRUCTURAL",
          "HOUSING",
          "ZONING",
          "PROPERTY_MAINTENANCE",
          "NUISANCE",
          "UNSAFE",
          "VACANT",
          "FIRE",
          "SIGN",
          "WORK_WITHOUT_PERMIT",
          "ENVIRONMENTAL",
          "OTHER"
        ],
        "type": "string",
        "description": "Normalised category, e.g. HOUSING, UNSAFE, WORK_WITHOUT_PERMIT"
      },
      "record_kind": {
        "enum": [
          "violation",
          "complaint",
          "all"
        ],
        "type": "string",
        "description": "'violation' (default): violations, citations and orders the agency found. 'complaint': reports it received, and cases with no evidence a violation was found. 'all': both. Complaints are never counted as violations.",
        "default": "violation"
      },
      "case_number": {
        "type": "string",
        "description": "The agency's case / complaint number"
      },
      "include_uncounted": {
        "type": "boolean",
        "description": "Also return records stored but never counted: voided, withdrawn, rescinded or issued in error, and process steps",
        "default": false
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "default": 1
      },
      "per_page": {
        "type": "integer",
        "minimum": 1,
        "default": 25,
        "maximum": 25
      }
    }
  },
  "endpoint": "/v1/violations/search"
},
{
  "name": "get_violation",
  "description": "Retrieve one record by the UUID returned by search_violations, including source status and related copies. A complaint is not an established violation. Coverage and fines depend on the source.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "violation_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "violation_id"
    ]
  },
  "endpoint": "/v1/violations/{violation_id}"
},
{
  "name": "get_violation_coverage",
  "description": "List source and place coverage for code violations and complaints, optionally within a state. Reports measured data_through, history window, count_unit and separate violation and complaint counts. Requires a connected account.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "state": {
        "type": "string",
        "description": "2-letter state code"
      }
    }
  },
  "endpoint": "/v1/violations/coverage"
},
{
  "name": "search_pipeline_cases",
  "description": "Search planning and zoning cases by place, case type, status, case number and filing, hearing or decision dates. Undated cases do not match date filters. total_capped marks a lower bound; total_unknown marks an unknown count. Sources carry measured data_through.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "city": {
        "type": "string",
        "description": "City name (matches the address city or the issuing jurisdiction)"
      },
      "state": {
        "type": "string",
        "description": "2-letter state code"
      },
      "zip_code": {
        "type": "string",
        "description": "5-digit ZIP"
      },
      "jurisdiction_id": {
        "type": "string",
        "format": "uuid",
        "description": "A jurisdiction id from /v1/jurisdictions"
      },
      "address": {
        "type": "string",
        "description": "Street address, partial, case-insensitive"
      },
      "parcel": {
        "type": "string",
        "description": "Parcel / APN / folio (formatting ignored)"
      },
      "lat": {
        "type": "number"
      },
      "lng": {
        "type": "number"
      },
      "radius_miles": {
        "type": "number",
        "maximum": 50,
        "exclusiveMinimum": 0,
        "description": "Radius in miles around lat/lng (default 1)"
      },
      "case_type": {
        "enum": [
          "REZONING",
          "SITE_PLAN",
          "SUBDIVISION_PLAT",
          "VARIANCE",
          "CONDITIONAL_USE",
          "ANNEXATION",
          "PUD",
          "COMPREHENSIVE_PLAN",
          "DEMOLITION_REVIEW",
          "HISTORIC_REVIEW",
          "OTHER"
        ],
        "type": "string",
        "description": "REZONING, SITE_PLAN, SUBDIVISION_PLAT, VARIANCE, CONDITIONAL_USE, ..."
      },
      "status": {
        "enum": [
          "FILED",
          "UNDER_REVIEW",
          "HEARING_SCHEDULED",
          "APPROVED",
          "APPROVED_WITH_CONDITIONS",
          "DENIED",
          "WITHDRAWN",
          "TABLED",
          "APPEALED",
          "CLOSED",
          "UNKNOWN"
        ],
        "type": "string",
        "description": "Normalised case status"
      },
      "case_number": {
        "type": "string",
        "description": "The case number as published (formatting ignored)"
      },
      "filed_after": {
        "type": "string",
        "format": "date"
      },
      "filed_before": {
        "type": "string",
        "format": "date"
      },
      "hearing_after": {
        "type": "string",
        "format": "date",
        "description": "Hearing on or after (may be in the future)"
      },
      "hearing_before": {
        "type": "string",
        "format": "date"
      },
      "decided_after": {
        "type": "string",
        "format": "date"
      },
      "decided_before": {
        "type": "string",
        "format": "date"
      },
      "min_units": {
        "type": "integer",
        "minimum": 0,
        "description": "Dwelling units proposed, at least (the source's structured unit count)"
      },
      "min_acres": {
        "type": "number",
        "minimum": 0
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "default": 1
      },
      "per_page": {
        "type": "integer",
        "minimum": 1,
        "default": 25,
        "maximum": 25
      }
    }
  },
  "endpoint": "/v1/pipeline/cases/search"
},
{
  "name": "get_pipeline_case",
  "description": "Retrieve one case by the UUID returned by search_pipeline_cases, with linked meeting decisions and permits. A permit link is a match by site and time, not proof the permit was issued under this case. link_method and confidence describe the match.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "case_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "case_id"
    ]
  },
  "endpoint": "/v1/pipeline/cases/{case_id}"
},
{
  "name": "search_pipeline_decisions",
  "description": "Search council, commission and zoning-board decisions by place, body, outcome and meeting date. land_use defaults to only. A decision is distinct from a filed case and an issued permit. total_capped marks a lower bound; total_unknown marks an unknown count.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "city": {
        "type": "string",
        "description": "City name (matches the address city or the deciding jurisdiction)"
      },
      "state": {
        "type": "string",
        "description": "2-letter state code"
      },
      "jurisdiction_id": {
        "type": "string",
        "format": "uuid"
      },
      "address": {
        "type": "string",
        "description": "Street address named in the item, partial"
      },
      "body": {
        "type": "string",
        "description": "Deciding body, partial ('Planning Commission', 'Zoning')"
      },
      "outcome": {
        "enum": [
          "APPROVED",
          "APPROVED_WITH_CONDITIONS",
          "DENIED",
          "RECOMMENDED_APPROVAL",
          "RECOMMENDED_DENIAL",
          "TABLED",
          "WITHDRAWN",
          "REFERRED",
          "FIRST_READING",
          "RECEIVED",
          "NO_ACTION",
          "OTHER",
          "UNKNOWN"
        ],
        "type": "string",
        "description": "Normalised action: APPROVED, DENIED, RECOMMENDED_APPROVAL, TABLED, ..."
      },
      "land_use": {
        "enum": [
          "only",
          "all"
        ],
        "type": "string",
        "description": "'only' (default): land-use items; 'all': every stored item",
        "default": "only"
      },
      "land_use_type": {
        "enum": [
          "REZONING",
          "SITE_PLAN",
          "SUBDIVISION_PLAT",
          "VARIANCE",
          "CONDITIONAL_USE",
          "ANNEXATION",
          "PUD",
          "COMPREHENSIVE_PLAN",
          "DEMOLITION_REVIEW",
          "HISTORIC_REVIEW",
          "OTHER"
        ],
        "type": "string"
      },
      "case_number": {
        "type": "string",
        "description": "A case number named in the item (formatting ignored)"
      },
      "matter_file": {
        "type": "string",
        "description": "The clerk's file number"
      },
      "linked": {
        "type": "boolean",
        "description": "true: only items linked to a planning case we hold"
      },
      "meeting_after": {
        "type": "string",
        "format": "date"
      },
      "meeting_before": {
        "type": "string",
        "format": "date"
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "default": 1
      },
      "per_page": {
        "type": "integer",
        "minimum": 1,
        "default": 25,
        "maximum": 25
      }
    }
  },
  "endpoint": "/v1/pipeline/decisions/search"
},
{
  "name": "get_pipeline_coverage",
  "description": "List source and place coverage for planning cases and decisions, optionally within a state. dataset selects cases, decisions or all. Reports measured data_through and counts; decision records count land-use items. Requires a connected account.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "state": {
        "type": "string",
        "description": "2-letter state code"
      },
      "dataset": {
        "enum": [
          "cases",
          "decisions",
          "all"
        ],
        "type": "string",
        "default": "all"
      }
    }
  },
  "endpoint": "/v1/pipeline/coverage"
},
  {
    name: "search_permits",
    description:
      "Search building permits by location, category, status, date range, and value. " +
      "Use this to find recent permits of a specific type in a city (e.g., 'solar permits in Austin, TX from last month') " +
      "or to filter by contractor work, renovation scope, or property value. " +
      "Returns a paginated list with addresses, dates, values, contractors, and descriptions. " +
      "READING THE RESULT: `total` is exact unless `total_capped` is true, in which case it is a " +
      "floor (the real number is higher) ; never report a capped total as exact. If `total_unknown` " +
      "is true, `total` is null and the count could not be determined; say so rather than guessing. " +
      "If `account_window_clamped` is true, the connected account limited the date range and " +
      "`account_window_days`/`account_window_from` say to what ; an empty or small result may reflect that " +
      "window, not the absence of permits. Source omissions and account restrictions are distinct.",
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
            "Permit category (case-insensitive). Common values: SOLAR, ROOFING, HVAC, NEW_CONSTRUCTION, POOL, ELECTRICAL, PLUMBING, DEMOLITION, MECHANICAL, RENOVATION. " +
            "Note: asking for HVAC also returns MECHANICAL and vice versa ; HVAC work is routinely filed " +
            "as MECHANICAL, so the two are one market and querying either alone would miss roughly half of it.",
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
          description: "ISO date (YYYY-MM-DD) ; only permits filed on or after this date",
        },
        filed_before: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) ; only permits filed on or before this date",
        },
        issued_after: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) ; only permits issued on or after this date",
        },
        issued_before: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) ; only permits issued on or before this date",
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
      "on a building ; renovations, additions, systems replacements, solar, roofing. Covers all permit categories. " +
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
  {
    name: "get_permit_trend",
    description:
      "Monthly permit counts and total valuation for a city/state/category ; a time series. " +
      "USE THIS INSTEAD OF search_permits WHENEVER THE QUESTION IS 'HOW MANY' OR 'IS IT " +
      "TRENDING UP': it answers in one call from a precomputed rollup, where search would " +
      "need you to page through every matching permit just to count them. " +
      "Examples: 'how many roofing permits in Jacksonville each month this year', " +
      "'is solar activity in Phoenix growing'. Availability depends on the connected account. " +
      "Counts are rebuilt nightly ; the response carries `as_of`, and `undated` counts " +
      "permits whose source published no date.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Two-letter state code, e.g. FL" },
        city: { type: "string", description: "City name, e.g. Jacksonville" },
        category: {
          type: "string",
          description:
            "Permit category, e.g. ROOFING, SOLAR, HVAC, NEW_CONSTRUCTION, PLUMBING, ELECTRICAL",
        },
        months: {
          type: "integer",
          description: "How many trailing months to return (default 24, max 120)",
          default: 24,
        },
      },
      required: [],
    },
    endpoint: "/v1/metrics/monthly",
  },
  {
    name: "get_permit_totals",
    description:
      "Category breakdown for a city or state over a trailing window ; 'what kind of work is " +
      "happening here right now'. One call instead of paginating search. Returns each " +
      "category with its permit count and total valuation. Availability depends on the connected " +
      "account. Whole months only: `days` is rounded to the rollup's monthly grain.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Two-letter state code, e.g. TX" },
        city: { type: "string", description: "City name, e.g. Austin" },
        days: {
          type: "integer",
          description: "Trailing window in days (default 90, min 28, max 730)",
          default: 90,
        },
      },
      required: [],
    },
    endpoint: "/v1/metrics/current",
  },
  {
    name: "get_busiest_cities",
    description:
      "Rank the busiest cities in a state by permit volume, optionally for one trade. " +
      "Use for 'where is the most roofing work in Florida' style questions. " +
      "Availability depends on the connected account.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Two-letter state code, e.g. FL" },
        category: { type: "string", description: "Optional category, e.g. ROOFING" },
        months: { type: "integer", description: "Trailing months (default 12)", default: 12 },
        limit: { type: "integer", description: "How many cities (default 50)", default: 50 },
      },
      required: ["state"],
    },
    endpoint: "/v1/metrics/cities",
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

  const requestArgs = { ...(args ?? {}) } as Record<string, unknown>;
  const datasetTool = /^((search|get)_violations?|get_violation_coverage|search_pipeline_cases|search_pipeline_decisions|get_pipeline_case|get_pipeline_coverage)$/.test(name);
  if (datasetTool) {
    const props = tool.inputSchema.properties as Record<string, unknown>;
    for (const key of Object.keys(requestArgs)) {
      if (!(key in props)) throw new McpError(ErrorCode.InvalidParams, `Unknown argument: ${key}`);
    }
    for (const key of ["page", "per_page"]) {
      if (!(key in props)) continue;
      const n = Number(requestArgs[key] ?? (key === "page" ? 1 : 25));
      if (!Number.isInteger(n) || n < 1) throw new McpError(ErrorCode.InvalidParams, `${key} must be a positive integer.`);
      requestArgs[key] = key === "per_page" ? Math.min(n, 25) : n;
    }
    for (const key of ["violation_id", "case_id"]) {
      if (!(key in props)) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestArgs[key] ?? ""))) {
        throw new McpError(ErrorCode.InvalidParams, `${key} must be a UUID returned by the corresponding search.`);
      }
    }
  }
  const { path, params } = buildRequest(tool, requestArgs);
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
