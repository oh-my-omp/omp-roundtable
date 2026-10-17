import {describe, expect, test} from 'bun:test';
import {Settings} from '@oh-my-pi/pi-coding-agent/config/settings';
import {lookup} from '@oh-my-pi/pi-coding-agent/config/registry';
import roundtable from '../index.ts';

// Regression for #191: once the extension is loaded, every cwd reload, clone,
// and disk reload validates all registered settings. Unset roundtable.* keys
// reach validators as undefined and must fall back to their defaults.

const stubApi = {registerFlag() {}, registerTool() {}, registerCommand() {}, on() {}} as never;

describe('roundtable settings after extension load', () => {
	test('unset keys pass cwd reload and clone with their defaults', async () => {
		roundtable(stubApi);
		const settings = await Settings.init({inMemory: true, cwd: '/tmp'});
		await settings.reloadForCwd('/var/tmp');
		const cloned = await settings.cloneForCwd('/tmp');
		expect(lookup('roundtable.recomputeIntervalSeconds')?.get(cloned)).toBe(120);
		expect(lookup('roundtable.ownerAgent')?.get(cloned)).toBe('task:high');
		expect(lookup('roundtable.gateAgent')?.get(cloned)).toBe('task:mid');
	});

	test('invalid values are still rejected', async () => {
		roundtable(stubApi);
		const settings = await Settings.init({inMemory: true, cwd: '/tmp'});
		expect(() => lookup('roundtable.recomputeIntervalSeconds')!.override(settings, 0 as never)).toThrow(
			'Roundtable recompute interval must be a positive safe whole number of seconds within the native timer range',
		);
		expect(() => lookup('roundtable.ownerAgent')!.override(settings, '   ' as never)).toThrow(
			'Roundtable setting must be a nonempty string',
		);
	});
});
