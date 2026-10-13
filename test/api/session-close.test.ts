import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { CreatioEngineManager } from '../../src/creatio';
import { HttpServer } from '../../src/server/http/http-server';
import { Server } from '../../src/server/mcp';
import { SessionContext } from '../../src/sessions/session-context';
import { makeFakeContext } from '../support/fake-context';

const PORT = 39123;

describe('MCP session close (client DELETE)', () => {
	// Clients like Open WebUI open a fresh session per chat message and DELETE it afterwards. The
	// close path used to re-enter itself until the stack overflowed, crashing the process.
	it('survives repeated connect → list → DELETE rounds and drops each session', async () => {
		const errors: unknown[] = [];
		const onError = (e: unknown) => errors.push(e);
		process.on('unhandledRejection', onError);
		process.on('uncaughtException', onError);
		const engines = new CreatioEngineManager(makeFakeContext() as never);
		const http = new HttpServer(new Server(engines, { readonlyMode: true }));
		await http.start(PORT);
		try {
			for (let round = 0; round < 3; round++) {
				const transport = new StreamableHTTPClientTransport(
					new URL(`http://127.0.0.1:${PORT}/mcp`),
				);
				const client = new Client({ name: 'session-close-test', version: '0' });
				await client.connect(transport);
				expect((await client.listTools()).tools.length).toBeGreaterThan(0);
				await transport.terminateSession();
				await client.close();
			}
			await new Promise((r) => setTimeout(r, 100));
			expect(SessionContext.instance.getStats().sessionsCount).toBe(0);
		} finally {
			process.off('unhandledRejection', onError);
			process.off('uncaughtException', onError);
			await http.stop();
		}
		expect(errors).toEqual([]);
	}, 20_000);
});
