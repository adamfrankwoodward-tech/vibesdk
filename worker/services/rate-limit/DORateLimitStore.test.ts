import { vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: DurableObjectState;

		constructor(ctx: DurableObjectState) {
			this.ctx = ctx;
		}
	},
}));

import {
	DORateLimitStore,
	type RateLimitBucket,
	type RateLimitConfig,
} from './DORateLimitStore';

type StoredState = {
	buckets: [string, RateLimitBucket][];
	lastCleanup: number;
};

function createStore(initial?: StoredState) {
	let persisted = initial;
	const storage = {
		get: vi.fn(async () => persisted),
		put: vi.fn(async (_key: string, state: StoredState) => {
			persisted = structuredClone(state);
		}),
	};
	const store = new DORateLimitStore(
		{ storage } as unknown as DurableObjectState,
		{} as Env,
	);
	return { store, storage, getPersisted: () => persisted };
}

const config: RateLimitConfig = { limit: 100, period: 3600 };

describe('DORateLimitStore.increment', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
	});

	afterEach(() => vi.useRealTimers());

	it('accepts a charge equal to the remaining allowance and rejects a weighted overage without writing', async () => {
		const { store, storage, getPersisted } = createStore();
		expect(await store.increment('user', config, 99)).toEqual({
			success: true,
			remainingLimit: 1,
		});
		expect(await store.increment('user', config, 20)).toMatchObject({
			success: false,
			exceededLimit: 'main',
			limitValue: 100,
		});
		expect(storage.put).toHaveBeenCalledTimes(1);
		expect(getPersisted()?.buckets[0][1].count).toBe(99);
		expect(await store.increment('user', config, 1)).toEqual({
			success: true,
			remainingLimit: 0,
		});
		expect(await store.increment('user', config, 1)).toMatchObject({
			success: false,
			exceededLimit: 'main',
		});
	});

	it('rejects burst overages independently of the main window', async () => {
		const { store, storage } = createStore();
		const burstConfig = { ...config, burst: 10, burstWindow: 60 };
		expect(await store.increment('user', burstConfig, 9)).toMatchObject({
			success: true,
		});
		expect(await store.increment('user', burstConfig, 2)).toMatchObject({
			success: false,
			exceededLimit: 'burst',
			limitValue: 10,
		});
		expect(storage.put).toHaveBeenCalledTimes(1);
		expect(await store.increment('user', burstConfig, 1)).toMatchObject({
			success: true,
		});
	});

	it('rejects daily overages independently of the main window', async () => {
		const { store, storage } = createStore();
		const dailyConfig = { ...config, dailyLimit: 10 };
		expect(await store.increment('user', dailyConfig, 9)).toEqual({
			success: true,
			remainingLimit: 1,
		});
		expect(await store.increment('user', dailyConfig, 2)).toMatchObject({
			success: false,
			exceededLimit: 'daily',
			limitValue: 10,
		});
		expect(storage.put).toHaveBeenCalledTimes(1);
		expect(await store.increment('user', dailyConfig, 1)).toEqual({
			success: true,
			remainingLimit: 0,
		});
	});

	it('keeps yesterday’s usage in the rolling daily window after the calendar reset', async () => {
		vi.setSystemTime(new Date('2026-10-06T00:00:10Z'));
		const yesterday = Date.now() - 20_000;
		const { store, storage } = createStore({
			buckets: [
				[`user:${yesterday}`, { count: 99, timestamp: yesterday }],
			],
			lastCleanup: Date.now(),
		});
		expect(
			await store.increment(
				'user',
				{
					...config,
					calendarDaily: true,
					dailyLimit: 100,
				},
				20,
			),
		).toMatchObject({ success: false, exceededLimit: 'daily' });
		expect(storage.put).not.toHaveBeenCalled();
	});

	it('charges fractional credits against the remaining allowance', async () => {
		const { store, storage } = createStore();
		expect(await store.increment('user', config, 99.2)).toMatchObject({
			success: true,
		});
		expect(await store.increment('user', config, 0.8)).toMatchObject({
			success: true,
		});
		expect(await store.increment('user', config, 0.4)).toMatchObject({
			success: false,
			exceededLimit: 'main',
		});
		expect(storage.put).toHaveBeenCalledTimes(2);
	});

	it('rejects negative and nonfinite increments without changing storage; allows a free charge', async () => {
		const { store, storage } = createStore();
		for (const invalid of [-1, NaN, Infinity, -Infinity]) {
			expect(await store.increment('user', config, invalid)).toEqual({
				success: false,
			});
		}
		expect(storage.get).not.toHaveBeenCalled();
		expect(await store.increment('user', config, 100)).toMatchObject({
			success: true,
		});
		expect(await store.increment('user', config, 0)).toEqual({
			success: true,
			remainingLimit: 0,
		});
		expect(storage.put).toHaveBeenCalledTimes(1);
	});

	it('serializes concurrent weighted charges against a persisted allowance', async () => {
		const now = Date.now();
		const { store, storage, getPersisted } = createStore({
			buckets: [[`user:${now}`, { count: 80, timestamp: now }]],
			lastCleanup: now,
		});
		const results = await Promise.all([
			store.increment('user', config, 15),
			store.increment('user', config, 15),
		]);
		expect(results.map((result) => result.success).sort()).toEqual([
			false,
			true,
		]);
		expect(storage.get).toHaveBeenCalledTimes(1);
		expect(storage.put).toHaveBeenCalledTimes(1);
		expect(getPersisted()?.buckets[0][1].count).toBe(95);
	});
});
