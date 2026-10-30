import {describe,expect,test} from 'bun:test';
import {YAML} from 'bun';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseWorkflow} from '../src/domain/parse.ts';
import {loadWorkflow} from '../src/ports/workflow.ts';

const parsed=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsed.ok)throw new Error(parsed.error.reason);
const defaultWorkflow=parsed.value;

describe('workflow validation',()=>{
  test('parseWorkflow rejects a duplicate judge role across stages',()=>{
    const workflow=structuredClone(defaultWorkflow);
    workflow.judges.mergeCommit[0]!.role=workflow.judges.pullRequest[0]!.role;
    expect(parseWorkflow(workflow)).toMatchObject({ok:false,error:{path:'judges'}});
  });
  test('parseWorkflow reserves owner for the implementation seat',()=>{
    const workflow=structuredClone(defaultWorkflow);workflow.judges.parent[0]!.role='owner';
    expect(parseWorkflow(workflow)).toMatchObject({ok:false,error:{path:'judges'}});
  });
  test('parseWorkflow rejects unknown fields at every workflow level',()=>{
    const judge=defaultWorkflow.judges.pullRequest[0]!;
    for(const workflow of [
      {...defaultWorkflow,extra:true},
      {...defaultWorkflow,owner:{...defaultWorkflow.owner,extra:true}},
      {...defaultWorkflow,judges:{...defaultWorkflow.judges,extra:[]}},
      {...defaultWorkflow,judges:{...defaultWorkflow.judges,pullRequest:[{...judge,extra:true}]}},
    ])expect(parseWorkflow(workflow).ok).toBe(false);
  });
  test('parseWorkflow rejects empty owner and judge agents',()=>{
    expect(parseWorkflow({...defaultWorkflow,owner:{...defaultWorkflow.owner,agent:''}}).ok).toBe(false);
    const workflow=structuredClone(defaultWorkflow);workflow.judges.mergeCommit[0]!.agent='';
    expect(parseWorkflow(workflow).ok).toBe(false);
  });
  test('parseWorkflow accepts all three empty judge lists',()=>{
    expect(parseWorkflow({owner:defaultWorkflow.owner,judges:{pullRequest:[],mergeCommit:[],parent:[]}})).toMatchObject({ok:true,value:{judges:{pullRequest:[],mergeCommit:[],parent:[]}}});
  });
});

describe('workflow file source selection',()=>{
  test('a missing dataDir workflow loads the built-in roster',async()=>{
    const root=await mkdtemp('/tmp/roundtable-workflow-');
    try {
      const result=await loadWorkflow({kind:'dataDir',path:join(root,'workflow.yml')});
      expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error.reason);
      expect(result.value.owner.agent).toBe('task:high');
      expect(result.value.judges.pullRequest.map(judge=>judge.role)).toEqual(['review','accept']);
      expect(result.value.judges.mergeCommit.map(judge=>judge.role)).toEqual(['postMerge']);
      expect(result.value.judges.parent.map(judge=>judge.role)).toEqual(['closure']);
      expect(Object.values(result.value.judges).flat().every(judge=>judge.agent==='task:mid')).toBe(true);
    }finally {await rm(root,{recursive:true,force:true});}
  });
  test('an existing dataDir workflow overrides the built-in roster',async()=>{
    const root=await mkdtemp('/tmp/roundtable-workflow-');
    try {
      const path=join(root,'workflow.yml');
      await writeFile(path,'owner:\n  agent: implementer\n  brief: Deliver the change.\njudges:\n  pullRequest:\n    - role: safety\n      agent: auditor\n      brief: Check production safety.\n  mergeCommit: []\n  parent: []\n');
      expect(await loadWorkflow({kind:'dataDir',path})).toEqual({ok:true,value:{owner:{agent:'implementer',brief:'Deliver the change.'},judges:{pullRequest:[{role:'safety',agent:'auditor',brief:'Check production safety.'}],mergeCommit:[],parent:[]}}});
    }finally {await rm(root,{recursive:true,force:true});}
  });
  test('a missing configured workflow reports its path rather than falling back',async()=>{
    const root=await mkdtemp('/tmp/roundtable-workflow-');
    try {
      const path=join(root,'required.yml');
      expect(await loadWorkflow({kind:'configured',path})).toMatchObject({ok:false,error:{source:path,reason:expect.stringContaining('does not exist')}});
    }finally {await rm(root,{recursive:true,force:true});}
  });
  for(const [name,text] of [['invalid YAML','owner: [unterminated'],['invalid schema','owner: {}\njudges: {}\n']] as const)test(`an existing dataDir workflow with ${name} errors instead of using defaults`,async()=>{
    const root=await mkdtemp('/tmp/roundtable-workflow-');
    try {
      const path=join(root,'workflow.yml');await writeFile(path,text);
      const result=await loadWorkflow({kind:'dataDir',path});
      expect(result.ok).toBe(false);
      if(result.ok)throw new Error('Invalid override silently loaded a workflow');
      expect(result.error.source).toBe(path);
      expect(typeof result.error.reason).toBe('string');
      expect(result.error.reason).not.toBe('');
      if(name==='invalid YAML')expect(result.error.reason).toContain('Invalid YAML');
    }finally {await rm(root,{recursive:true,force:true});}
  });
});
