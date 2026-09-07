import {DevinLocalProvider} from '../dist/providers/devin-local.js'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
import {persistThreadAttachments} from '../dist/attachment-storage.js'
import {attachmentFromUrl} from '../dist/content.js'
import {SessionArchive} from '../dist/archive.js'
import {emitClaudeSession,emitCodexSession,emitCursorSession,emitGrokSession} from '../dist/emit.js'
import {ClaudeProvider} from '../dist/providers/claude.js'
import {CodexProvider} from '../dist/providers/codex.js'
import {CursorProvider} from '../dist/providers/cursor.js'
import {GrokProvider} from '../dist/providers/grok.js'
const root=await mkdtemp(join(tmpdir(),'mako-attachment-final-'))
try {
 const source=join(root,'source.txt');await writeFile(source,'original bytes')
 const ref={harness:'test',nativeId:'test',path:join(root,'native'),bytes:1,cwd:root}
 const fromUrl=attachmentFromUrl('source.txt','text/plain',pathToFileURL(source).href)
 const urlSaved=await persistThreadAttachments({ref,entries:[{kind:'user',text:'look',attachments:[fromUrl]}]},join(root,'assets'))
 assert.equal(urlSaved.entries[0].attachments[0].source.kind,'file')
 console.log('PASS local file URL copied')
 const attachment={type:'attachment',id:'asset-1',name:'source.txt',mimeType:'text/plain',source:{kind:'file',path:source}}
 const entries=[{kind:'user',text:'look',attachments:[attachment]}]
 const archive=new SessionArchive(join(root,'archive'));archive.note(ref,async()=>({ref,entries}));await archive.flush()
 const first=await archive.read(ref.path);const savedPath=first.entries[0].attachments[0].source.path;assert.equal(await readFile(savedPath,'utf8'),'original bytes')
 await rm(source)
 const next={...ref,bytes:2};archive.note(next,async()=>({ref:next,entries:[...entries,{kind:'assistant',blocks:[{type:'text',text:'done'}]}]}));await archive.flush()
 assert.equal((await archive.read(ref.path)).entries[0].attachments[0].source.kind,'file')
 console.log('PASS retained attachment survives original deletion plus later capture')
 await archive.stop()
 const inline={type:'attachment',name:'image.png',mimeType:'image/png',source:{kind:'inline',data:Buffer.from('test').toString('base64')}}
 const thread={ref,entries:[{kind:'user',text:'look',attachments:[inline]},{kind:'assistant',blocks:[{type:'text',text:'answer'},inline]}]}
 for (const [name,emit,Provider] of [['claude',emitClaudeSession,ClaudeProvider],['codex',emitCodexSession,CodexProvider],['cursor',emitCursorSession,CursorProvider],['grok',emitGrokSession,GrokProvider]]) {
  const home=join(root,name);const emitted=await emit(thread,{home,cwd:root});const loaded=await new Provider(home).read(emitted.path)
  assert.equal(loaded.entries.filter(e=>e.kind==='user').reduce((n,e)=>n+(e.attachments?.length??0),0),1,name+' user attachment')
  assert.equal(loaded.entries.filter(e=>e.kind==='assistant').flatMap(e=>e.blocks).filter(b=>b.type==='attachment').length,1,name+' assistant attachment')
  assert.equal(JSON.stringify(loaded.entries).includes('<mako-attachments>'),false,name+' envelope hidden')
  console.log('PASS '+name+' user and assistant attachment round trip')
 }
 const content={type:'image',data:Buffer.from('test').toString('base64'),mimeType:'image/png'}
 const devin=join(root,'devin');await mkdir(join(devin,'acp-events'),{recursive:true});const dpath=join(devin,'acp-events','session.ndjson')
 await writeFile(dpath,JSON.stringify({notification:{sessionUpdate:'user_message_chunk',content}})+'\n')
 const d=await new DevinLocalProvider(devin).read(dpath)
 assert.equal(d.entries[0]?.attachments?.[0]?.source.data,content.data)
 const grok=join(root,'.grok','sessions','project','session');await mkdir(grok,{recursive:true});await writeFile(join(grok,'summary.json'),JSON.stringify({info:{id:'session',cwd:root},session_summary:'Image request'}));const gpath=join(grok,'updates.jsonl')
 await writeFile(gpath,JSON.stringify({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'user_message_chunk',content}}})+'\n')
 const g=await new GrokProvider(root).read(gpath)
 assert.equal(g.entries[0]?.attachments?.[0]?.source.data,content.data)
 console.log('PASS Devin and Grok native image-only prompts')

}finally{await rm(root,{recursive:true,force:true})}
