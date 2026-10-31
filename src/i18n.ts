import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {getAgentDir} from '@oh-my-pi/pi-coding-agent';

export type Language='en'|'zh';
const configFiles=['omomp.yml','omomp.yaml','omomp.json','omomp.toml'] as const;
let configRead=false;
let configLanguage:Language|undefined;
function record(value:unknown):value is Record<string,unknown> {return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function readConfigLanguage():Language|undefined {
  if(configRead)return configLanguage;
  configRead=true;
  let candidate:{path:string;text:string}|undefined;
  for(const name of configFiles){
    try {
      const path=join(getAgentDir(),name),text=readFileSync(path,'utf8');
      if(candidate)return undefined;
      candidate={path,text};
    }catch(error){if(!record(error)||error.code!=='ENOENT')return undefined;}
  }
  if(!candidate)return undefined;
  try {
    const parsed:unknown=candidate.path.endsWith('.json')?JSON.parse(candidate.text):candidate.path.endsWith('.toml')?Bun.TOML.parse(candidate.text):Bun.YAML.parse(candidate.text);
    if(!record(parsed))return undefined;
    const section=parsed['omomp-lang'];
    if(!record(section)||Object.keys(section).length!==1||section.language!=='en'&&section.language!=='zh')return undefined;
    return configLanguage=section.language;
  }catch{return undefined;}
}
/** Environment stays live; the strict agent-directory section is read once per process. */
export function language():Language {
  const explicit=process.env.OMOMP_LANG?.trim().toLowerCase();
  if(explicit==='en'||explicit==='zh')return explicit;
  const configured=readConfigLanguage();
  if(configured)return configured;
  for(const key of ['LC_ALL','LC_MESSAGES','LANG'] as const){const value=process.env[key]?.trim();if(value)return value.toLowerCase().startsWith('zh')?'zh':'en';}
  return 'en';
}
export function tr(en:string,zh:string):string {return language()==='zh'?zh:en;}
