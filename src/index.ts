import 'dotenv/config';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const CHANNEL3_MCP_URL = 'https://mcp.trychannel3.com/';
const channel3ApiKey = process.env.CHANNEL3_API_KEY;

// Helper: call a Channel3 MCP tool via JSON-RPC over HTTP
async function callChannel3Tool(toolName: string, toolArgs: Record<string, unknown>) {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (channel3ApiKey) {
        headers['Authorization'] = `Bearer ${channel3ApiKey}`;
    }

    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
    });

    const res = await fetch(CHANNEL3_MCP_URL, { method: 'POST', headers, body });
    const text = await res.text();

    // SSE responses: extract every `data:` line and find the one with a valid JSON-RPC result
    if (res.headers.get('content-type')?.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.replace(/^data:\s*/, '').trim();
            if (!raw || raw === '[DONE]') continue;
            try {
                const json = JSON.parse(raw);
                if (json.error) throw new Error(`Channel3 error: ${JSON.stringify(json.error)}`);
                if (json.result !== undefined) return json.result;
            } catch (e) {
                // not valid JSON on this line, keep looking
                continue;
            }
        }
        throw new Error('Channel3: no valid JSON-RPC result found in SSE stream');
    }

    const json = JSON.parse(text);
    if (json.error) throw new Error(`Channel3 error: ${JSON.stringify(json.error)}`);
    return json.result;
}

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'payally-mcp', version: '1.0.0' });

    // ── Existing tool ──────────────────────────────────────────────────────────
    server.registerTool(
        'add-note',
        { description: 'Append a note', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );

    // ── Channel3: search_products ──────────────────────────────────────────────
    server.registerTool(
        'search_products',
        {
            description:
                'Search the Channel3 product catalog using a plain-language description and/or an image URL. ' +
                'Returns a ranked list of matching products with prices and availability.',
            inputSchema: z.object({
                query: z
                    .string()
                    .optional()
                    .describe('Plain-language product description, e.g. "black running shoes under $100"'),
                image_url: z
                    .string()
                    .url()
                    .optional()
                    .describe('URL of a reference image to search by visual similarity'),
            }),
        },
        async (args) => {
            const result = await callChannel3Tool('search_products', args);
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
    );

    // ── Channel3: get_products ─────────────────────────────────────────────────
    server.registerTool(
        'get_products',
        {
            description:
                'Fetch full product details — offers, variants, images, and attributes — for up to 40 products ' +
                'identified by Channel3 product IDs or retailer URLs.',
            inputSchema: z.object({
                ids: z
                    .array(z.string())
                    .optional()
                    .describe('List of Channel3 product IDs'),
                urls: z
                    .array(z.string().url())
                    .optional()
                    .describe('List of retailer product page URLs'),
            }),
        },
        async (args) => {
            const result = await callChannel3Tool('get_products', args);
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
    );

    return server;
});

const app = createMcpExpressApp();
const node = toNodeHandler(handler);
app.all('/mcp', (req: Request, res: Response) => void node(req, res, req.body));
app.listen(3002, () => {
    console.error('Demo MCP App Server Started');
});
