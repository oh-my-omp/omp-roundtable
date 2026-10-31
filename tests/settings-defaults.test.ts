import {describe, expect, test} from 'bun:test';
import {Settings} from '@oh-my-pi/pi-coding-agent/config/settings';
import {lookup} from '@oh-my-pi/pi-coding-agent/config/registry';
import roundtable from '../index.ts';


const stubApi = {registerFlag() {}, registerTool() {}, registerCommand() {}, on() {}} as never;

describe('roundtable settings after extension load', () => {

	test('invalid values are still rejected', async () => {
		roundtable(stubApi);
		const settings = await Settings.init({inMemory: true, cwd: '/tmp'});
		expect(() => lookup('roundtable.recomputeIntervalSeconds')!.override(settings, 0 as never)).toThrow();
		expect(() => lookup('roundtable.dataDir')!.override(settings, '   ' as never)).toThrow();
		expect(lookup('roundtable.workflowFile')).toBeUndefined();
	});
});
