#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CosmosClient, Container, PartitionKey } from "@azure/cosmos";
import * as dotenv from "dotenv";
import express from 'express';
import cors from 'cors';

// Define interfaces for resource handling
interface MCPResource {
  uri: string;
  contents: Array<{
    uri: string;
    text: string;
  }>;
}

interface ResourceProvider {
  scheme: string;
  id: string;
  template: string;
  capabilities?: {
    watch?: boolean;
    stream?: boolean;
  };
  provide: (uri: URL, params?: Record<string, string>, options?: Record<string, unknown>) => Promise<MCPResource>;
}

dotenv.config();

if (!process.env.COSMOSDB_URI) {
  console.error("Fatal Error: COSMOSDB_URI environment variable is not set.");
  process.exit(1);
}
if (!process.env.COSMOSDB_KEY) {
  console.error("Fatal Error: COSMOSDB_KEY environment variable is not set.");
  process.exit(1);
}
if (!process.env.COSMOS_DATABASE_ID) {
  console.error("Fatal Error: COSMOS_DATABASE_ID environment variable is not set.");
  process.exit(1);
}
if (!process.env.COSMOS_CONTAINER_ID) {
  console.error("Fatal Error: COSMOS_CONTAINER_ID environment variable is not set.");
  process.exit(1);
}


const app = express();
app.use(cors());
app.use(express.json());

app.get('/sse', (req, res) => {
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive'); 

  res.flushHeaders();
  const clientId = Date.now().toString(); 
  const messageEndpoint = `/message?sessionId=${clientId}`; 

  try {
    const host = req.get('host') || 'localhost:8000';
    const protocol = req.protocol || 'http';
    const fullEndpoint = `${protocol}://${host}${messageEndpoint}`;
    res.write(`event: endpoint\ndata: ${fullEndpoint}\n\n`);
  } catch (error) {
  }

  const intervalId = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (error) {
      clearInterval(intervalId);
      res.end();
    }
  }, 30000);

  global.sseClients.push(res);

  req.on('close', () => {
    clearInterval(intervalId);
    
    const index = global.sseClients.indexOf(res);
    if (index > -1) {
      global.sseClients.splice(index, 1);
    }
    
    res.end();
  });
});

declare global {
  var sseClients: any[];
}
global.sseClients = [];

function broadcastEvent(event: string, data: any) {  
  const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  global.sseClients.forEach((client: any, index: number) => {
    try {
      client.write(eventData);
    } catch (error) {
      global.sseClients.splice(index, 1);
    }
  });
}

const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOSDB_URI!, 
  key: process.env.COSMOSDB_KEY!, 
});

const databaseId = process.env.COSMOS_DATABASE_ID!; 
const containerId = process.env.COSMOS_CONTAINER_ID!; 
const container = cosmosClient.database(databaseId).container(containerId);

const SERVER_CAPABILITIES = {
  capabilities: {
    tools: {
      supportsProgress: true,
      supportsCancel: true,
      supportsConcurrency: true
    },
    resources: {
      supportsWatching: true, 
      supportsStreaming: true, 
      supportsSearch: false 
    },
    configuration: {
      supportsDidChange: true
    }
  }
};

interface ServerConfig {
  cosmos: {
    maxConcurrentRequests?: number;
    requestTimeout?: number;
  };
}

let serverConfig: ServerConfig = {
  cosmos: {
    maxConcurrentRequests: 10, 
    requestTimeout: 30000 
  }
};

interface ProgressToken {
  id: string;
  operation: string;
  progress: number;
}

const activeProgress = new Map<string, ProgressToken>();

function createProgressToken(operation: string): string {
  const token = `${operation}-${Date.now()}`;
  activeProgress.set(token, {
    id: token,
    operation,
    progress: 0
  });
  return token;
}

function reportProgress(token: string, progress: number, message?: string) {
  if (activeProgress.has(token)) {
    server.notification({ 
      method: "$/progress",
      params: {
        token,
        progress,
        message
      }
    });
  }
}

const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownErrorCode: -32001
} as const;

function createErrorResponse(code: number, message: string, data?: any) {
  return {
    code,
    message,
    data
  };
}

const UPDATE_ITEM_TOOL: Tool = {
  name: "update_item",
  description: "Updates specific attributes of an item in a Azure Cosmos DB container",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "ID of the item to update" },
      updates: { type: "object", description: "The updated attributes of the item" },
    },
    required: ["id", "updates"],
  },
};

const PUT_ITEM_TOOL: Tool = {
  name: "put_item",
  description: "Inserts or replaces an item in a Azure Cosmos DB container",
  inputSchema: {
    type: "object",
    properties: {
      item: { type: "object", description: "Item to insert into the container" },
    },
    required: ["item"],
  },
};

const GET_ITEM_TOOL: Tool = {
  name: "get_item",
  description: "Retrieves an item from a Azure Cosmos DB container by its ID",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "ID of the item to retrieve" },
    },
    required: ["id"],
  },
};

const QUERY_CONTAINER_TOOL: Tool = {
  name: "query_container",
  description: "Queries an Azure Cosmos DB container using SQL-like syntax",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "SQL query string" },
      parameters: {
        type: "array",
        description: "Query parameters",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Parameter name" },
            value: { type: "string", description: "Parameter value" } 
          },
          required: ["name", "value"]
        }
      },
    },
    required: ["query"], 
  },
};

async function updateItem(params: any, progressToken?: string) {
  const token = progressToken || createProgressToken("update_item");
  try {
    reportProgress(token, 0, "Starting item update");
    const { id, updates } = params;
    const { resource } = await container.item(id).read();

    reportProgress(token, 30, "Retrieved existing item");

    if (!resource) {
      throw new Error("Item not found");
    }

    if (!activeProgress.has(token)) { throw new Error("Operation cancelled"); }

    const updatedItem = { ...resource, ...updates };

    const { resource: updatedResource } = await container.item(id).replace(updatedItem);
    reportProgress(token, 80, "Item replaced in Cosmos DB");

    broadcastEvent('itemUpdated', { id: updatedResource.id, item: updatedResource });

    reportProgress(token, 100, "Update complete");
    activeProgress.delete(token);

    return {
      success: true,
      message: `Item updated successfully`,
      item: updatedResource,
    };
  } catch (error: any) {
    activeProgress.delete(token);
    if (error.message === "Operation cancelled") {
      return createErrorResponse(ErrorCodes.InvalidRequest, "Operation cancelled by client");
    }
    return createErrorResponse(ErrorCodes.InternalError, `Failed to update item: ${error.message}`);
  }
}

async function putItem(params: any, progressToken?: string) {
  const token = progressToken || createProgressToken("put_item");
  try {
    reportProgress(token, 0, "Starting item creation");
    const { item } = params;

    if (!activeProgress.has(token)) { throw new Error("Operation cancelled"); }

    const { resource } = await container.items.create(item);
    reportProgress(token, 80, "Item created in Cosmos DB");

    broadcastEvent('itemCreated', { id: resource.id, item: resource });

    reportProgress(token, 100, "Item created successfully");
    activeProgress.delete(token);

    return {
      success: true,
      message: `Item added successfully to container`,
      item: resource,
    };
  } catch (error: any) {
    activeProgress.delete(token);
    if (error.message === "Operation cancelled") {
      return createErrorResponse(ErrorCodes.InvalidRequest, "Operation cancelled by client");
    }
    return createErrorResponse(ErrorCodes.InternalError, `Failed to put item: ${error.message}`);
  }
}

async function getItem(params: any) {
  try {
    const { id } = params;
    const { resource } = await container.item(id).read();

    if (!resource) {
      return createErrorResponse(ErrorCodes.InvalidParams, `Item with id ${id} not found.`);
    }

    return {
      success: true,
      message: `Item retrieved successfully`,
      item: resource,
    };
  } catch (error: any) {
    return createErrorResponse(ErrorCodes.InternalError, `Failed to get item: ${error.message}`);
  }
}

async function queryContainer(params: any, progressToken?: string) {
  const token = progressToken || createProgressToken("query_container");
  try {
    reportProgress(token, 0, "Starting query execution");
    const { query, parameters } = params;
    
    if (!activeProgress.has(token)) { throw new Error("Operation cancelled"); }

    const { resources } = await container.items.query({ query, parameters }).fetchAll();
    reportProgress(token, 90, "Query results fetched");

    reportProgress(token, 100, "Query completed");
    activeProgress.delete(token);

    return {
      success: true,
      message: `Query executed successfully`,
      items: resources,
    };
  } catch (error: any) {
    activeProgress.delete(token);
    if (error.message === "Operation cancelled") {
      return createErrorResponse(ErrorCodes.InvalidRequest, "Operation cancelled by client");
    }
    return createErrorResponse(ErrorCodes.InternalError, `Failed to query container: ${error.message}`);
  }
}

type ServerWithResources = Server<any, any, any> & {
  registerResourceProvider: (provider: ResourceProvider) => void;
  handleJsonRpcMessage: (message: any) => Promise<any>;
};

const server = new Server(
  {
    name: "cosmosdb-mcp-server",
    version: "0.1.0",
  },
  SERVER_CAPABILITIES
) as ServerWithResources;

server.registerResourceProvider = function(provider: ResourceProvider) {
  this.setRequestHandler(
    z.object({
      method: z.literal(`$/resource/${provider.scheme}/${provider.id}/provide`),
      params: z.object({
        uri: z.string(),
        parameters: z.record(z.string(), z.string()).optional(),
        options: z.record(z.string(), z.unknown()).optional()
      })
    }),
    async (request) => {
      const { uri, parameters, options } = request.params;
      return await provider.provide(new URL(uri), parameters, options);
    }
  );
};

server.handleJsonRpcMessage = async function(message: any) {
  let response;
  
  if (message.method === 'initialize') {
    response = {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        serverInfo: {
          name: "cosmosdb-mcp-server",
          version: "0.1.0",
        },
        capabilities: SERVER_CAPABILITIES.capabilities
      }
    };  } else if (message.method === 'notifications/initialized') {
    await this.notification(message);
    return { jsonrpc: '2.0' };
  } else if (message.method === 'tools/list') {
    response = {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          PUT_ITEM_TOOL,
          GET_ITEM_TOOL,
          QUERY_CONTAINER_TOOL,
          UPDATE_ITEM_TOOL
        ]
      }
    };
  } else {
    try {
      if (!message.method) {
        throw new Error('Method is required');
      }      if (!message.id) {
        await this.notification(message);
        return { jsonrpc: '2.0' };
      }

      const result = await this.request(message.method, message.params || {});
      response = {
        jsonrpc: '2.0',
        id: message.id,
        result
      };
    } catch (error: any) {
      response = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: error.message || 'Internal server error'
        }
      };
    }
  }

  if (message.id) {
    broadcastEvent('message', response);
  }
  
  return response;
};

const ConfigurationNotificationSchema = z.object({
  method: z.literal("$/didChangeConfiguration"),
  params: z.object({
    settings: z.object({
      cosmos: z.object({
        maxConcurrentRequests: z.number().optional(),
        requestTimeout: z.number().optional()
      }).optional()
    }).passthrough() 
  }).passthrough()
});

server.setNotificationHandler(ConfigurationNotificationSchema, (notification) => {
  const { settings } = notification.params;
  if (settings?.cosmos) {
    serverConfig = {
      ...serverConfig,
      cosmos: {
        ...serverConfig.cosmos,
        ...settings.cosmos 
      }
    };
  }
});

const CancelRequestSchema = z.object({
  method: z.literal("$/cancelRequest"), 
  params: z.object({
    id: z.union([z.string(), z.number()]) 
  })
});

server.setNotificationHandler(CancelRequestSchema, (notification) => {
  const { id } = notification.params;
  const tokenKey = String(id); 
  const token = activeProgress.get(tokenKey);
  if (token) {
    activeProgress.delete(tokenKey);
    reportProgress(tokenKey, 100, "Operation cancelled by client");
  } 
});

// --- Resource Definitions ---
server.registerResourceProvider({
  scheme: "cosmos",
  id: "database-info",
  template: "cosmos://database", 
  provide: async (uri: URL) => {
    return {
      uri: uri.href,
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          databaseId,
          containerId,
          endpoint: process.env.COSMOSDB_URI?.split('://')[1].split(':')[0] 
        }, null, 2)
      }]
    };
  }
});

server.registerResourceProvider({
  scheme: "cosmos",
  id: "cosmos-item",
  template: "cosmos://{containerId}/items/{id}", 
  provide: async (uri: URL, params?: Record<string, string>) => {
    const itemId = params?.id;
    const itemContainerId = params?.containerId;

    if (!itemId || !itemContainerId || itemContainerId !== containerId) {
      return { 
        uri: uri.href,
        contents: [{ uri: uri.href, text: JSON.stringify({ error: "Invalid container or item ID" }) }] 
      };
    }

    try {
      const { resource } = await container.item(itemId).read();
      if (!resource) {
        return { 
          uri: uri.href,
          contents: [{ uri: uri.href, text: JSON.stringify({ error: `Item ${itemId} not found` }) }] 
        };
      }
      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify(resource, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ error: `Failed to read item ${itemId}: ${error.message}` })
        }]
      };
    }
  }
});

server.registerResourceProvider({
  scheme: "cosmos",
  id: "cosmos-query",
  template: "cosmos://{containerId}/query", 
  provide: async (uri: URL, params?: Record<string, string>, options?: Record<string, unknown>) => {
    const queryContainerId = params?.containerId;

    if (!queryContainerId || queryContainerId !== containerId) {
      return { 
        uri: uri.href,
        contents: [{ uri: uri.href, text: JSON.stringify({ error: "Invalid container ID" }) }] 
      };
    }

    try {
      const queryText = options?.query as string || "SELECT * FROM c";
      const queryParams = options?.parameters as { name: string; value: any }[] | undefined;
      const { resources } = await container.items.query({ query: queryText, parameters: queryParams }).fetchAll();

      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify(resources, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ error: `Failed to execute query: ${error.message}` })
        }]
      };
    }
  }
});

server.registerResourceProvider({
  scheme: "cosmos",
  id: "cosmos-changes",
  template: "cosmos://{containerId}/changes", 
  capabilities: { 
      watch: true,
      stream: true
  },
  provide: async (uri: URL, params?: Record<string, string>, options?: Record<string, unknown>) => {
    const changeContainerId = params?.containerId;

    if (!changeContainerId || changeContainerId !== containerId) {
      return { 
        uri: uri.href,
        contents: [{ uri: uri.href, text: JSON.stringify({ error: "Invalid container ID" }) }] 
      };
    }

    const containerToWatch = cosmosClient.database(databaseId).container(changeContainerId);
   
    const changeFeedIterator = containerToWatch.items.changeFeed("*", { 
      maxItemCount: 10 
    });
   
    if (options?.watch) {
      return {
        uri: uri.href,
        contents: [],
        async *stream() {
          try {
            while (true) { 
              const feed = await changeFeedIterator.fetchNext();
              const items = feed ? [feed] : [];
              
              if (items.length > 0) {
                yield {
                  contents: [{
                    uri: `${uri.href}#${Date.now()}`,
                    text: JSON.stringify(items, null, 2)
                  }]
                };
                broadcastEvent('cosmosChange', items);
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (error: any) {
            yield {
              contents: [{
                uri: `${uri.href}#error`,
                text: JSON.stringify({ error: `Change feed stream error: ${error.message}` })
              }]
            };
          }
        }
      };
    }
    
    try {
      const feed = await changeFeedIterator.fetchNext();
      const items = feed ? [feed] : [];
      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify(items, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        uri: uri.href,
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ error: `Failed to fetch initial changes: ${error.message}` })
        }]
      };
    }
  }
});


// --- Request Handlers ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [PUT_ITEM_TOOL, GET_ITEM_TOOL, QUERY_CONTAINER_TOOL, UPDATE_ITEM_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params;
  const progressToken = _meta?.progressToken ? String(_meta.progressToken) : undefined; 

  try {
    let result;
    switch (name) {
      case "put_item":
        result = await putItem(args, progressToken);
        break;
      case "get_item":
        result = await getItem(args); 
        break;
      case "query_container":
        result = await queryContainer(args, progressToken);
        break;
      case "update_item":
        result = await updateItem(args, progressToken);
        break;
      default:
        return createErrorResponse(
          ErrorCodes.MethodNotFound, 
          `Unknown tool: ${name}`
        );
    }

    if (result && typeof result === 'object' && 'code' in result && 'message' in result) {
      return result;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error: any) {

    return createErrorResponse(
      ErrorCodes.InternalError,
      `Internal server error occurred: ${error.message}`
    );
  }
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  
  let message = req.body;
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message);
    } catch (error) {
      console.error(`[Message:${sessionId}] Error parsing message:`, error);
    }
  }
  try {
    const message = req.body;
    if (message && message.jsonrpc === '2.0') {     
      const result = await server.handleJsonRpcMessage(message);
      res.json(result);
    } else {
      res.json({ status: 'ok' });
    }    } catch (error: any) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id,
      error: {
        code: -32000,
        message: 'Internal server error',
        data: error.message
      }
    });
  }
});


app.get('/message', (req, res) => {
  const sessionId = req.query.sessionId;
  
  res.json({ status: 'ok' });
});

async function runServer() {
  const port = process.env.PORT || 8000; 
  const httpServer = app.listen(port, () => {
    console.error(`SSE Server running on port ${port}`); 
  });

  const shutdown = () => {
    console.error('Received shutdown signal. Cleaning up...');

    global.sseClients.forEach(client => {
      try {
        client.end();
      } catch (error) {
        console.error('Error closing SSE connection:', error);
      }
    });
    global.sseClients = [];
    activeProgress.clear();

    httpServer.close(() => {
      console.error('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
        console.error('Forcefully shutting down after timeout.');
        process.exit(1);
    }, 5000); 
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown); 

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Azure Cosmos DB MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
