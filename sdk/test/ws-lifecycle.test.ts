import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAgentConnection } from '../src/ws';
import type { AgentConnection } from '../src/types';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

class MockWebSocket extends EventTarget {
	static instances: MockWebSocket[] = [];
	closeCount = 0;

	constructor(readonly url: string) {
		super();
		MockWebSocket.instances.push(this);
	}

	close(): void {
		this.closeCount += 1;
	}

	send(_data: string): void {}
}

describe('createAgentConnection lifecycle', () => {
	const originalWebSocket = globalThis.WebSocket;
	const connections: AgentConnection[] = [];

	beforeEach(() => {
		MockWebSocket.instances.length = 0;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		for (const connection of connections) connection.close();
		connections.length = 0;
		globalThis.WebSocket = originalWebSocket;
	});

	function connect(getUrl: () => Promise<string>, retry = false) {
		const connection = createAgentConnection(getUrl, {
			retry: { enabled: retry, initialDelayMs: 1, maxDelayMs: 1 },
		});
		connections.push(connection);
		return connection;
	}

	it('does not construct a socket when closed before the ticket resolves', async () => {
		const ticket = deferred<string>();
		const connection = connect(() => ticket.promise);
		let openCount = 0;
		connection.on('ws:open', () => {
			openCount += 1;
		});

		connection.close();
		ticket.resolve('ws://test/late');
		await ticket.promise;
		await Promise.resolve();

		expect(MockWebSocket.instances).toHaveLength(0);
		expect(openCount).toBe(0);
	});

	it('does not report or retry a ticket error after close', async () => {
		const ticket = deferred<string>();
		const connection = connect(() => ticket.promise, true);
		let errorCount = 0;
		let reconnectCount = 0;
		connection.on('ws:error', () => {
			errorCount += 1;
		});
		connection.on('ws:reconnecting', () => {
			reconnectCount += 1;
		});

		connection.close();
		ticket.reject(new Error('ticket failed'));
		await ticket.promise.catch(() => undefined);
		await Promise.resolve();

		expect(errorCount).toBe(0);
		expect(reconnectCount).toBe(0);
		expect(MockWebSocket.instances).toHaveLength(0);
	});

	it('reports an active ticket error and reconnects', async () => {
		const ticket = deferred<string>();
		const retryRequested = deferred<void>();
		let requests = 0;
		const connection = connect(() => {
			requests += 1;
			if (requests === 1) return ticket.promise;
			retryRequested.resolve(undefined);
			return Promise.resolve('ws://test/recovered');
		}, true);
		let errorCount = 0;
		connection.on('ws:error', () => {
			errorCount += 1;
		});

		ticket.reject(new Error('ticket failed'));
		await ticket.promise.catch(() => undefined);
		await retryRequested.promise;
		await Promise.resolve();

		expect(errorCount).toBe(1);
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(MockWebSocket.instances[0]!.url).toBe('ws://test/recovered');
	});

	it('does not reconnect when closed during a retry ticket request', async () => {
		const retryTicket = deferred<string>();
		const retryRequested = deferred<void>();
		let requests = 0;
		const connection = connect(() => {
			requests += 1;
			if (requests === 1) return Promise.resolve('ws://test/initial');
			retryRequested.resolve(undefined);
			return retryTicket.promise;
		}, true);

		await Promise.resolve();
		const socket = MockWebSocket.instances[0]!;
		socket.dispatchEvent(new Event('open'));
		socket.dispatchEvent(new Event('error'));
		await retryRequested.promise;

		connection.close();
		retryTicket.resolve('ws://test/retry');
		await retryTicket.promise;
		await Promise.resolve();

		expect(MockWebSocket.instances).toHaveLength(1);
		expect(socket.closeCount).toBe(1);
	});

	it('ignores an older ticket while the latest reconnect opens normally', async () => {
		const olderTicket = deferred<string>();
		const latestTicket = deferred<string>();
		const olderRequested = deferred<void>();
		const latestRequested = deferred<void>();
		let requests = 0;
		const connection = connect(() => {
			requests += 1;
			if (requests === 1) return Promise.resolve('ws://test/initial');
			if (requests === 2) {
				olderRequested.resolve(undefined);
				return olderTicket.promise;
			}
			latestRequested.resolve(undefined);
			return latestTicket.promise;
		}, true);
		let openCount = 0;
		connection.on('ws:open', () => {
			openCount += 1;
		});

		await Promise.resolve();
		const initialSocket = MockWebSocket.instances[0]!;
		initialSocket.dispatchEvent(new Event('open'));
		initialSocket.dispatchEvent(new Event('error'));
		await olderRequested.promise;
		initialSocket.dispatchEvent(new Event('close'));
		await latestRequested.promise;

		olderTicket.resolve('ws://test/stale');
		await olderTicket.promise;
		await Promise.resolve();
		expect(MockWebSocket.instances).toHaveLength(1);

		latestTicket.resolve('ws://test/latest');
		await latestTicket.promise;
		await Promise.resolve();
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(MockWebSocket.instances[1]!.url).toBe('ws://test/latest');
		MockWebSocket.instances[1]!.dispatchEvent(new Event('open'));
		expect(openCount).toBe(2);
	});
});
