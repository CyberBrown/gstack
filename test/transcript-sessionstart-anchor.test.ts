import {afterEach, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readPlanCountTranscript, type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {readOwnedClaudePublicTranscript} from '../lib/claude-public-transcript';

// A SessionStart hook's output is journaled as an `attachment` with a null
// parent BEFORE the first user message, which then parents onto it. Without
// admitting that anchor, every phase-entry Read in such a session is refused
// with "Native parent evidence has not reached the journal yet".

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid='session-owned',cwd='/fixture/repo',time='2026-09-27T16:10:43.790Z';
const hook=(n:number,parent:number|null,hookEvent='SessionStart')=>({
 sessionId:sid,cwd,isSidechain:false,uuid:uuid(n),parentUuid:parent===null?null:uuid(parent),timestamp:time,
 type:'attachment',attachment:{type:'hook_success',hookName:`${hookEvent}:startup`,hookEvent,content:'Estate notes'},
});
const msg=(n:number,parent:number,role:string,content:any[])=>({
 sessionId:sid,cwd,isSidechain:false,uuid:uuid(n),parentUuid:uuid(parent),timestamp:time,message:{role,content},
});
const use={type:'tool_use',id:'read-owned',name:'Read',input:{file_path:'/fixture/state/methodology.md'}};
function rows(anchors:any[]=[hook(1,null)]):any[]{
 const last=anchors.length;
 return [...anchors,
  msg(10,last,'user',[{type:'text',text:'Run the review.'}]),
  msg(11,10,'assistant',[use]),
  msg(12,11,'user',[{type:'tool_result',tool_use_id:'read-owned',content:'ok'}]),
 ];
}
function journal(records:any[]){
 const config=fs.mkdtempSync(path.join(os.tmpdir(),'ss-anchor-'));dirs.push(config);
 const project=path.join(config,'projects','owned');fs.mkdirSync(project,{recursive:true});
 const file=path.join(project,`${sid}.jsonl`);
 fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 return {config,file};
}
function both(records:any[]){
 const {config,file}=journal(records);
 const events:NativePublicToolEvent[]=[];
 const scan=readPlanCountTranscript(config,cwd,e=>events.push(e));
 const owned=readOwnedClaudePublicTranscript(fs.realpathSync(file),cwd,sid);
 return {scan,events,owned};
}
const sawUse=(r:ReturnType<typeof both>)=>({
 scan:r.events.some(e=>e.toolUseId==='read-owned'),
 owned:r.owned.events.some((e:any)=>e.kind==='use'&&e.toolUseId==='read-owned'),
});

test('a leading SessionStart attachment anchors the owned root',()=>{
 const r=both(rows());
 expect(r.owned.transcript.status).toBe('ready');
 expect(sawUse(r)).toEqual({scan:true,owned:true});
});
test('a chain of SessionStart attachments anchors the owned root',()=>{
 const r=both(rows([hook(1,null),hook(2,1)]));
 expect(r.owned.transcript.status).toBe('ready');
 expect(sawUse(r)).toEqual({scan:true,owned:true});
});

for(const [name,anchors] of Object.entries({
 'non-SessionStart hook attachment':[hook(1,null,'UserPromptSubmit')],
 'foreign-cwd attachment':[{...hook(1,null),cwd:'/another/repo'}],
 'sidechain attachment':[{...hook(1,null),isSidechain:true}],
 'agent attachment':[{...hook(1,null),agentId:'child'}],
 'attachment with a dangling parent':[hook(1,99)],
 'chain broken by a foreign attachment':[hook(1,null,'UserPromptSubmit'),hook(2,1)],
}))test(`${name} cannot anchor the owned root`,()=>{
 // Only the owned reader (what the phase hook uses) is ancestry-scoped; the
 // legacy scan keeps exact-cwd scoping, so it is not asserted here.
 const r=both(rows(anchors as any[]));
 expect(sawUse(r).owned).toBe(false);
});
