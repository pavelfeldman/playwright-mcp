/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import url from 'node:url';
import http from 'node:http';
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createConnection } from '@playwright/mcp';

import { test as baseTest, expect } from './fixtures.js';

// NOTE: Can be removed when we drop Node.js 18 support and changed to import.meta.filename.
const __filename = url.fileURLToPath(import.meta.url);

const test = baseTest.extend<{ serverEndpoint: (args?: string[]) => Promise<{ url: URL, stderr: () => string }> }>({
  serverEndpoint: async ({}, use) => {
    let cp: ChildProcess | undefined;
    await use(async (args?: string[]) => {
      if (cp)
        throw new Error('Server already running');
      cp = spawn('node', [
        path.join(path.dirname(__filename), '../cli.js'), '--port', '0', ...(args ?? [])
      ], {
        stdio: 'pipe',
        env: { ...process.env, DEBUG: 'pw-mcp:test', DEBUG_COLORS: '0' },
      });
      let stderr = '';
      const url = await new Promise<string>(resolve => cp!.stderr?.on('data', data => {
        stderr += data.toString();
        const match = stderr.match(/Listening on (http:\/\/.*)/);
        if (match)
          resolve(match[1]);
      }));
      return { url: new URL(url), stderr: () => stderr };
    });

    if (cp)
      cp.kill('SIGTERM');
  },
});

test('sse transport', async ({ serverEndpoint }) => {
  const { url } = await serverEndpoint();
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  await client.ping();
});

test('streamable http transport', async ({ serverEndpoint }) => {
  const { url } = await serverEndpoint();
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  await client.ping();
  expect(transport.sessionId, 'has session support').toBeDefined();
});

test('sse transport via public API', async ({ server }, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data-dir');
  const sessions = new Map<string, SSEServerTransport>();
  const mcpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      const connection = await createConnection({
        browser: {
          userDataDir,
          launchOptions: { headless: true }
        },
      });
      const transport = new SSEServerTransport('/sse', res);
      sessions.set(transport.sessionId, transport);
      await connection.connect(transport);
    } else if (req.method === 'POST') {
      const url = new URL(`http://localhost${req.url}`);
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.statusCode = 400;
        return res.end('Missing sessionId');
      }
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.statusCode = 404;
        return res.end('Session not found');
      }
      void transport.handlePostMessage(req, res);
    }
  });
  await new Promise<void>(resolve => mcpServer.listen(0, () => resolve()));
  const serverUrl = `http://localhost:${(mcpServer.address() as AddressInfo).port}/sse`;
  const transport = new SSEClientTransport(new URL(serverUrl));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  await client.ping();
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toContainTextContent(`- generic [ref=e1]: Hello, world!`);
  await client.close();
  mcpServer.close();
});

test('sse transport isolated contexts', async ({ serverEndpoint, server, mcpHeadless }) => {
  server.setContent('/', `
    <body>
    </body>
    <script>
      document.body.textContent = localStorage.getItem('test') ? 'Storage: YES' : 'Storage: NO';
      localStorage.setItem('test', 'test');
    </script>
  `, 'text/html');

  const { url, stderr } = await serverEndpoint(['--isolated', ...(mcpHeadless ? ['--headless'] : [])]);

  const transport1 = new SSEClientTransport(url);
  const client1 = new Client({ name: 'test', version: '1.0.0' });
  await client1.connect(transport1);
  const response1 = await client1.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response1).toContainTextContent(`Storage: NO`);

  const transport2 = new SSEClientTransport(url);
  const client2 = new Client({ name: 'test', version: '1.0.0' });
  await client2.connect(transport2);
  const response2 = await client2.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response2).toContainTextContent(`Storage: NO`);

  // Check that it only contains this string once
  const log = stderr();
  expect(log.match(/Launching browser/g)?.length).toBe(1);
  expect(log.match(/Creating isolated context/g)?.length).toBe(2);
});

test('sse transport non-isolated contexts should fail', async ({ serverEndpoint, server, mcpHeadless }) => {
  const { url } = await serverEndpoint(mcpHeadless ? ['--headless'] : []);

  const transport1 = new SSEClientTransport(url);
  const client1 = new Client({ name: 'test', version: '1.0.0' });
  await client1.connect(transport1);
  await client1.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const transport2 = new SSEClientTransport(url);
  const client2 = new Client({ name: 'test', version: '1.0.0' });
  const error = await client2.connect(transport2).catch(e => e);
  expect(error.message).toContain('Non-200 status code (503)');
});

test.only('sse transport non-isolated contexts should work after closing the first connection', async ({ serverEndpoint, server, mcpHeadless }) => {
  const { url } = await serverEndpoint(mcpHeadless ? ['--headless'] : []);

  const transport1 = new SSEClientTransport(url);
  const client1 = new Client({ name: 'test', version: '1.0.0' });
  await client1.connect(transport1);
  await client1.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  await client1.close();

  const transport2 = new SSEClientTransport(url);
  const client2 = new Client({ name: 'test', version: '1.0.0' });
  await client2.connect(transport2);
  await client2.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
});
