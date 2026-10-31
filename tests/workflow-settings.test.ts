import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredWorkflow} from '../src/ports/workflow-settings.ts';

const source=await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text();
test('project workflowFile is read anew and environment takes precedence',async()=>{
  const root=await mkdtemp('/tmp/roundtable-plugin-settings-'),saved=process.env.OMP_ROUNDTABLE_WORKFLOW;
  try {
    delete process.env.OMP_ROUNDTABLE_WORKFLOW;
    await mkdir(join(root,'.omp'));
    await writeFile(join(root,'selected.yml'),source.replace('agent: roundtable-owner','agent: project-owner'));
    const overrides=join(root,'.omp','plugin-overrides.json');
    await writeFile(overrides,JSON.stringify({settings:{'omp-roundtable':{workflowFile:'selected.yml'}}}));
    const selected=await configuredWorkflow(root,join(root,'data'));
    expect(selected).toMatchObject({ok:true,value:{ticket:{states:{Coding:{agent:'project-owner'}}}}});
    await writeFile(overrides,JSON.stringify({settings:{'omp-roundtable':{workflowFile:'missing.yml'}}}));
    expect(await configuredWorkflow(root,join(root,'data'))).toMatchObject({ok:false,error:{source:join(root,'missing.yml')}});
    process.env.OMP_ROUNDTABLE_WORKFLOW='selected.yml';
    expect(await configuredWorkflow(root,join(root,'data'))).toEqual(selected);
    process.env.OMP_ROUNDTABLE_WORKFLOW=' ';
    expect(await configuredWorkflow(root,join(root,'data'))).toMatchObject({ok:false,error:{source:'omp-roundtable.workflowFile'}});
    delete process.env.OMP_ROUNDTABLE_WORKFLOW;
    await writeFile(overrides,JSON.stringify({settings:{'omp-roundtable':{workflowFile:42}}}));
    expect(await configuredWorkflow(root,join(root,'data'))).toMatchObject({ok:false,error:{source:'omp-roundtable.workflowFile'}});
    await writeFile(overrides,JSON.stringify({settings:{'omp-roundtable':{}}}));
    expect(await configuredWorkflow(root,join(root,'data'))).toMatchObject({ok:true,value:{ticket:{states:{Coding:{agent:'roundtable-owner'}}}}});
  }finally{
    if(saved===undefined)delete process.env.OMP_ROUNDTABLE_WORKFLOW;else process.env.OMP_ROUNDTABLE_WORKFLOW=saved;
    await rm(root,{recursive:true,force:true});
  }
});
