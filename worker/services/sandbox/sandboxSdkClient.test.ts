import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getSandbox: vi.fn(),
	env: {
		ALLOCATION_STRATEGY: 'many_to_one',
		CUSTOM_DOMAIN: 'preview.example.com',
		MAX_SANDBOX_INSTANCES: '1',
	},
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		setFields: vi.fn(),
	},
}));

vi.mock('@cloudflare/sandbox', () => ({
	getSandbox: mocks.getSandbox,
	Sandbox: class {},
}));
vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../../logger', () => ({ createObjectLogger: () => mocks.logger }));
vi.mock('./BaseSandboxService', () => ({
	BaseSandboxService: class {
		constructor(protected sandboxId: string) {}
	},
}));
vi.mock('../deployer/deploy', () => ({}));
vi.mock('../deployer/utils/index', () => ({}));
vi.mock('./resourceProvisioner', () => ({}));
vi.mock('./templateParser', () => ({}));
vi.mock('./fileTreeBuilder', () => ({}));
vi.mock('worker/utils/envs', () => ({}));

import { SandboxSdkClient } from './sandboxSdkClient';

type Metadata = {
	projectName: string;
	startTime: string;
	processId?: string;
	allocatedPort?: number;
	donttouch_files: string[];
	redacted_files: string[];
};

function makeHarness() {
	const metadata = new Map<string, Metadata>([
		[
			'i-target',
			{
				projectName: 'target',
				startTime: '2026-01-01',
				processId: 'target-process',
				allocatedPort: 8001,
				donttouch_files: [],
				redacted_files: [],
			},
		],
		[
			'i-neighbor',
			{
				projectName: 'neighbor',
				startTime: '2026-01-01',
				processId: 'neighbor-process',
				allocatedPort: 8002,
				donttouch_files: [],
				redacted_files: [],
			},
		],
	]);
	const processes = new Map([
		['target-process', 'running'],
		['neighbor-process', 'running'],
	]);
	const ports = new Set([8001, 8002]);
	const directories = new Set(['i-target', 'i-neighbor']);
	const failures = {
		kill: false,
		unexpose: false,
		rm: false,
		exec: false,
		processCheck: false,
		portCheck: false,
		killNoop: false,
		unexposeNoop: false,
		filesRemain: false,
	};
	const session = {
		readFile: vi.fn(async (path: string) => {
			const id = path
				.replace('/workspace/', '')
				.replace('-metadata.json', '');
			const data = metadata.get(id);
			return { success: !!data, content: JSON.stringify(data) };
		}),
		exec: vi.fn(async (command: string) => {
			if (failures.exec) throw new Error('exec unavailable');
			const id = command.match(/rm -rf -- '\/workspace\/([^']+)'/)?.[1];
			if (!id) throw new Error(`Unexpected command: ${command}`);
			if (failures.rm)
				return { exitCode: 1, stderr: 'permission denied', stdout: '' };
			if (!failures.filesRemain) directories.delete(id);
			return {
				exitCode: directories.has(id) ? 1 : 0,
				stderr: '',
				stdout: '',
			};
		}),
	};
	const sandbox = {
		createSession: vi.fn(async () => session),
		killProcess: vi.fn(async (id: string) => {
			if (failures.kill) throw new Error('kill denied');
			if (!processes.has(id)) throw new Error('process not found');
			if (!failures.killNoop) processes.set(id, 'killed');
		}),
		listProcesses: vi.fn(async () => {
			if (failures.processCheck)
				throw new Error('process listing unavailable');
			return [...processes].map(([id, status]) => ({ id, status }));
		}),
		unexposePort: vi.fn(async (port: number) => {
			if (failures.unexpose) throw new Error('unexpose denied');
			if (!ports.has(port)) throw new Error('port not exposed');
			if (!failures.unexposeNoop) ports.delete(port);
		}),
		getExposedPorts: vi.fn(async () => {
			if (failures.portCheck) throw new Error('port listing unavailable');
			return [...ports].map((port) => ({ port }));
		}),
		destroy: vi.fn(),
		killAllProcesses: vi.fn(),
		exec: vi.fn(),
	};
	mocks.getSandbox.mockReturnValue(sandbox);
	const client = new SandboxSdkClient('sandbox-id', 'agent-id');
	return {
		client,
		metadata,
		processes,
		ports,
		directories,
		failures,
		session,
		sandbox,
	};
}

describe('SandboxSdkClient cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mocks.env.ALLOCATION_STRATEGY = 'many_to_one';
	});

	afterEach(() => vi.restoreAllMocks());

	it.each([
		['kill', 'Process target-process', 'kill denied'],
		['unexpose', 'Port 8001', 'unexpose denied'],
		['rm', 'instance files', 'permission denied'],
		['exec', 'instance files', 'exec unavailable'],
	] as const)(
		'reports a %s failure and supports retry after recovery',
		async (failure, resource, reason) => {
			const h = makeHarness();
			h.failures[failure] = true;
			const result = await h.client.shutdownInstance('i-target');
			expect(result.success).toBe(false);
			expect(result.error).toContain(resource);
			expect(result.error).toContain(reason);
			expect(h.sandbox.killProcess).toHaveBeenCalledWith(
				'target-process',
			);
			expect(h.sandbox.unexposePort).toHaveBeenCalledWith(8001);
			expect(h.session.exec).toHaveBeenCalled();
			expect(h.metadata.has('i-target')).toBe(true);
			expect(h.session.readFile).toHaveBeenCalledTimes(1);
			expect(h.sandbox.createSession).toHaveBeenCalledTimes(1);
			h.failures[failure] = false;
			expect((await h.client.shutdownInstance('i-target')).success).toBe(
				true,
			);
			// The retry uses cached metadata and sessions; durable metadata also remains.
			expect(h.session.readFile).toHaveBeenCalledTimes(1);
			expect(h.sandbox.createSession).toHaveBeenCalledTimes(1);
			expect(h.processes.get('target-process')).toBe('killed');
			expect(h.ports.has(8001)).toBe(false);
			expect(h.directories.has('i-target')).toBe(false);
		},
	);

	it('keeps the instance session cache on failure and clears it after success', async () => {
		const h = makeHarness();
		const sessions = h.client as unknown as {
			getInstanceSession(id: string): Promise<unknown>;
		};
		await sessions.getInstanceSession('i-target');
		h.failures.rm = true;
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			false,
		);
		await sessions.getInstanceSession('i-target');
		expect(h.sandbox.createSession).toHaveBeenCalledTimes(2);
		h.failures.rm = false;
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			true,
		);
		await sessions.getInstanceSession('i-target');
		expect(h.sandbox.createSession).toHaveBeenCalledTimes(3);
	});

	it('cleans up files when there is no process or allocated port', async () => {
		const h = makeHarness();
		const data = h.metadata.get('i-target')!;
		delete data.processId;
		delete data.allocatedPort;
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			true,
		);
		expect(h.sandbox.killProcess).not.toHaveBeenCalled();
		expect(h.sandbox.unexposePort).not.toHaveBeenCalled();
		expect(h.directories.has('i-target')).toBe(false);
	});

	it('aggregates independent cleanup failures', async () => {
		const h = makeHarness();
		Object.assign(h.failures, { kill: true, unexpose: true, rm: true });
		const result = await h.client.shutdownInstance('i-target');
		expect(result.success).toBe(false);
		for (const reason of [
			'kill denied',
			'unexpose denied',
			'permission denied',
		]) {
			expect(result.error).toContain(reason);
		}
	});

	it.each([
		'processCheck',
		'portCheck',
		'killNoop',
		'unexposeNoop',
		'filesRemain',
	] as const)(
		'requires confirmation of resource removal: %s',
		async (failure) => {
			const h = makeHarness();
			h.failures[failure] = true;
			expect((await h.client.shutdownInstance('i-target')).success).toBe(
				false,
			);
		},
	);

	it('recognizes already absent resources and repeated cleanup', async () => {
		const h = makeHarness();
		h.processes.delete('target-process');
		h.ports.delete(8001);
		h.directories.delete('i-target');
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			true,
		);
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			true,
		);
		// Successful cleanup clears the metadata cache, then reloads the durable file.
		expect(h.session.readFile).toHaveBeenCalledTimes(2);
		expect(h.metadata.has('i-target')).toBe(true);
	});

	it.each(['completed', 'failed', 'killed', 'error'])(
		'recognizes a terminal process status: %s',
		async (status) => {
			const h = makeHarness();
			h.processes.set('target-process', status);
			h.failures.kill = true;
			expect((await h.client.shutdownInstance('i-target')).success).toBe(
				true,
			);
		},
	);

	it('retries from durable metadata in a new client', async () => {
		const h = makeHarness();
		h.failures.kill = true;
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			false,
		);
		h.failures.kill = false;
		const freshClient = new SandboxSdkClient('sandbox-id', 'agent-id');
		expect((await freshClient.shutdownInstance('i-target')).success).toBe(
			true,
		);
		expect(h.session.readFile).toHaveBeenCalledTimes(2);
	});

	it('leaves adjacent pooled instances intact', async () => {
		const h = makeHarness();
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			true,
		);
		expect(h.processes.get('neighbor-process')).toBe('running');
		expect(h.ports.has(8002)).toBe(true);
		expect(h.directories.has('i-neighbor')).toBe(true);
		expect(h.metadata.has('i-neighbor')).toBe(true);
		expect(h.session.exec).toHaveBeenCalledWith(
			"rm -rf -- '/workspace/i-target' && test ! -e '/workspace/i-target' && test ! -L '/workspace/i-target'",
			undefined,
		);
		expect(h.sandbox.destroy).not.toHaveBeenCalled();
		expect(h.sandbox.killAllProcesses).not.toHaveBeenCalled();
		expect(mocks.getSandbox).toHaveBeenCalledWith(
			undefined,
			'container-pool-0',
		);
	});

	it.each([
		'../i-neighbor',
		'.',
		'',
		'sandbox-default',
		"i-target'; rm -rf /workspace; '",
	])('rejects unsafe cleanup IDs: %s', async (id) => {
		const h = makeHarness();
		expect((await h.client.shutdownInstance(id)).success).toBe(false);
		expect(h.session.exec).not.toHaveBeenCalled();
		expect(h.sandbox.killProcess).not.toHaveBeenCalled();
	});

	it('returns a failure without mutating resources when metadata cannot be read', async () => {
		const h = makeHarness();
		h.session.readFile.mockRejectedValueOnce(new Error('read unavailable'));
		expect((await h.client.shutdownInstance('i-target')).success).toBe(
			false,
		);
		expect(h.sandbox.killProcess).not.toHaveBeenCalled();
		expect(h.session.exec).not.toHaveBeenCalled();
	});

	it('does not replace an old instance when cleanup fails', async () => {
		mocks.env.ALLOCATION_STRATEGY = 'one_to_one';
		const h = makeHarness();
		h.failures.kill = true;
		vi.spyOn(h.client, 'listAllInstances').mockResolvedValue({
			success: true,
			instances: [
				{
					runId: 'i-target',
					startTime: '2026-01-01',
					uptime: 0,
					directory: 'i-target',
					serviceDirectory: 'i-target',
				},
			],
			count: 1,
		});
		vi.spyOn(h.client, 'getInstanceStatus').mockResolvedValue({
			success: true,
			pending: false,
			isHealthy: false,
		});
		const result = await h.client.createInstance({
			files: [],
			projectName: 'replacement',
			initCommand: 'bun run dev',
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain('kill denied');
		expect(h.sandbox.exec).not.toHaveBeenCalled();
		expect(h.metadata.get('i-target')?.processId).toBe('target-process');
	});
});
