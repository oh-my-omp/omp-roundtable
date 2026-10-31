import {describe,expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const moduleUrl=new URL('../src/i18n.ts',import.meta.url).href;
async function resolveLanguage(env:Record<string,string>,files:Record<string,string>={}):Promise<string> {
  const root=await mkdtemp('/tmp/roundtable-language-');
  try {
    for(const [name,text] of Object.entries(files))await writeFile(join(root,name),text);
    const childEnv={...process.env};
    for(const key of ['OMOMP_LANG','LC_ALL','LC_MESSAGES','LANG'])delete childEnv[key];
    const child=Bun.spawnSync([process.execPath,'-e',`import {language} from ${JSON.stringify(moduleUrl)}; console.log(language());`],{env:{...childEnv,PI_CODING_AGENT_DIR:root,...env}});
    expect(child.exitCode).toBe(0);
    return child.stdout.toString().trim();
  }finally{await rm(root,{recursive:true,force:true});}
}

describe('four-step interface language',()=>{
  const zh={'omomp.yml':'omomp-lang:\n  language: zh\n'};
  const vectors:[string,Record<string,string>,Record<string,string>,string][]=[
    ['normalized env',{OMOMP_LANG:' ZH '},{},'zh'],
    ['invalid env',{OMOMP_LANG:'zh-CN',LANG:'en_US.UTF-8'},{},'en'],
    ['empty locale skipped',{LC_ALL:'',LC_MESSAGES:'zh_CN.UTF-8'},{},'zh'],
    ['first locale wins',{LC_ALL:'C',LANG:'zh_CN.UTF-8'},{},'en'],
    ['final fallback',{},{},'en'],
    ['configured language',{LANG:'en_US.UTF-8'},zh,'zh'],
    ['env over config',{OMOMP_LANG:'en'},zh,'en'],
    ['strict config',{LANG:'zh_CN.UTF-8'},{'omomp.yml':'omomp-lang:\n  language: ZH\n'},'zh'],
  ];
  for(const [name,env,files,expected] of vectors)test(name,async()=>expect(await resolveLanguage(env,files)).toBe(expected));
  test('multiple candidates are ambiguous',async()=>expect(await resolveLanguage({LANG:'en'},{...zh,'omomp.json':'{"omomp-lang":{"language":"zh"}}'})).toBe('en'));
  test('extra section fields are invalid',async()=>expect(await resolveLanguage({LANG:'en'},{'omomp.toml':'[omomp-lang]\nlanguage="zh"\nextra=true\n'})).toBe('en'));
  test('JSON and TOML strict sections work',async()=>{
    for(const [name,text] of [['omomp.json','{"omomp-lang":{"language":"zh"}}'],['omomp.toml','[omomp-lang]\nlanguage="zh"\n']] as const)expect(await resolveLanguage({LANG:'en'},{[name]:text})).toBe('zh');
  });
  test('environment remains live while the agent section is cached',async()=>{
    const root=await mkdtemp('/tmp/roundtable-language-cache-');
    try {
      await mkdir(join(root,'project','.omp'),{recursive:true});
      await writeFile(join(root,'omomp.yml'),'omomp-lang:\n  language: zh\n');
      const child=Bun.spawnSync([process.execPath,'-e',`import {language} from ${JSON.stringify(moduleUrl)}; delete process.env.OMOMP_LANG; console.log(language()); await Bun.write(${JSON.stringify(join(root,'omomp.yml'))},'omomp-lang:\\n  language: en\\n'); console.log(language()); process.env.OMOMP_LANG='en';console.log(language()); process.env.OMOMP_LANG=' ZH ';console.log(language());`],{env:{...process.env,PI_CODING_AGENT_DIR:root}});
      expect(child.exitCode).toBe(0);expect(child.stdout.toString().trim().split('\n')).toEqual(['zh','zh','en','zh']);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
