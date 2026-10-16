/** Lane-1 scenario assertions, not transport or production matching (b.omv SR-14). */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditReceipts, jsonLines, packedReceiptAdapters, personaTranscripts, readTranscripts, shimWords, transcriptFiles } from './transcript-receipts.ts'
const [command, state, key, shim, root, arg = '', arg2 = '', arg3 = ''] = process.argv.slice(2)
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
function journal() { return jsonLines(join(state!, 'queue', `${key}.jsonl`)) }
function calls() { return readFileSync(shim!, 'utf8').split('\n').filter(l => l.startsWith('call\t')).map(l => { const f=l.split('\t'); return { at:Number(f[1])*1000, words:shimWords(f[5]!) } }) }
function blocks(e:any):any[] { return e.value?.type==='assistant'&&Array.isArray(e.value?.message?.content)?e.value.message.content:[] }
async function entries() { return readTranscripts(transcriptFiles(root!), await packedReceiptAdapters()) }
try {
  check(existsSync('/etc/cscb-ci-image'), 'scenario assertions require the CI image')
  if (command === 'accepted' || command === 'delivered') {
    const j=journal(), a=j.filter(r=>r.kind==='accepted'&&!r.compact)
    check(a.length>=Number(arg), 'not enough accepted items')
    if(command==='delivered') for(const i of a.slice(0,Number(arg))) {
      const f=j.find(r=>r.kind==='fixed'&&r.seq===i.seq)
      check(f?.parts?.every((_:unknown,n:number)=>j.some(r=>r.kind==='delivered'&&r.seq===i.seq&&r.part===n+1)), 'prefix not yet delivered')
    }
  } else if(command==='no-send') {
    check(!calls().some(c=>c.at>=Number(arg)&&c.words.includes('send-keys')), 'keys typed during a hold')
  } else if(command==='open') {
    const j=journal(),seq=Number(arg),f=j.find(r=>r.seq===seq&&r.kind==='fixed')
    check(f?.parts?.some((_:unknown,n:number)=>!j.some(r=>r.seq===seq&&r.kind==='delivered'&&r.part===n+1)),'expected head is already complete')
  } else if(command==='no-enter-fault') {
    check(readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')&&shimWords(l.split('\t')[5]!)[1]==='no_enter').length>=Number(arg),'text fault not yet applied')
  } else if(command==='enter-fault') {
    check(readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')&&shimWords(l.split('\t')[5]!)[1]==='key=Enter').length>=Number(arg),'Enter fault not yet applied')
  } else if(command==='fault') {
    check(readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')&&shimWords(l.split('\t')[5]!)[2]===arg).length>=Number(arg2||1), 'fault not yet consumed')
  } else if(command==='fidelity-shapes') {
    const j=journal();for(const [seq,bytes] of [[9,850],[10,1400],[11,1900]]) {
      const f=j.find(r=>r.kind==='fixed'&&r.seq===seq);check(f?.parts?.length===1&&Buffer.byteLength(f.parts[0])===bytes,'single-part native fidelity size differs')
    }
  } else if(command==='unknown-proof') {
    const faults=readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')).map(l=>{const f=l.split('\t');return {at:Number(f[1])*1000,words:shimWords(f[5]!)}})
    const f=faults.find(f=>f.words[2]===arg);check(f,'unknown fault was not applied')
    const after=calls().filter(c=>c.at>f.at), next=after.findIndex(c=>c.words.includes('send-keys')&&c.words.includes('--no-enter'))
    check((next<0?after:after.slice(0,next)).some(c=>c.words.includes('read-pane')),'unknown send retyped without a fresh box read')
    console.log('recorded: unknown outcome checked before retype '+arg)
  } else if(command==='reset-spacing') {
    const s=journal().filter(r=>r.kind==='sent'&&r.seq===Number(arg)&&r.send_kind!=='enter')
    const launches=[...new Set(s.map(r=>r.launch_id))];check(launches.length>=2,'head was not retried across a real launch')
    const newer=s.filter(r=>r.launch_id===launches.at(-1));check(newer.length>=2,'restarted head did not exercise a new retry')
    check(newer[1].at-newer[0].at<60000,'restart retained later backoff instead of resetting')
    console.log('recorded: restart reset spacing '+JSON.stringify(newer.map(r=>r.at)))
  } else if(command==='key-proof') {
    const j=journal(), s=j.filter(r=>r.kind==='sent'&&r.seq===Number(arg))
    const text=s.filter(r=>r.send_kind!=='enter'), enter=s.filter(r=>r.send_kind==='enter')
    if(arg2==='enter') {
      // b.omv SR-13.5: real deliveries permit duplicate text. Prove that
      // the injected missed Enter was followed by an actual Enter-only
      // attempt; the no-second-text invariant belongs to the unit suite.
      const faults=readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')).map(l=>{const f=l.split('\t');return {at:Number(f[1])*1000,words:shimWords(f[5]!)}})
      check(enter.some(retry=>text.some(t=>t.part===retry.part&&t.launch_id===retry.launch_id&&t.at<=retry.at&&faults.some(f=>f.at>=t.at&&f.at<=retry.at&&f.words[1]==='key=Enter'&&f.words[2]==='swallow'))
        &&calls().some(c=>c.at>=retry.at&&c.words.includes('cscb_'+key)&&c.words.includes('--key')&&c.words.includes('Enter'))), 'swallowed Enter has no observed Enter-only recovery')
    }
    if(arg2==='retype') check(text.length>=2, 'missed text was not retyped')
    if(arg2==='spacing') {
      check(text.length>=4, 'three swallowed texts did not produce three retypes')
      for(let i=1;i<4;i++) check(text[i].at-text[i-1].at >= [10000,30000,60000][i-1]!, 'retype spacing below growing backoff')
      check(j.filter(r=>r.kind==='noticed'&&r.seq===Number(arg)).length===1, 'not-taken-in notice not once')
    }
    console.log('recorded: key proof '+JSON.stringify({seq:Number(arg),sends:s.map(r=>({kind:r.send_kind,at:r.at}))}))
  } else if(command==='cron') {
    const a=journal().filter(r=>r.kind==='accepted'&&r.source==='cron'&&!r.compact)
    check(a.length===Number(arg), 'cron fire count differs')
    check(a.every((r,i)=>r.ts&&(!i||Number(r.ts)>Number(a[i-1].ts))), 'cron fire timestamps missing or unordered')
    console.log('recorded: cron fires '+JSON.stringify(a.map(r=>({seq:r.seq,ts:r.ts,received_at:r.received_at}))))
  } else if(command==='compact-active') {
    const pane=JSON.parse(readFileSync(arg,'utf8')).pane
    check(typeof pane==='string'&&/compacting/i.test(pane),'native compacting turn not visible')
  } else if(command==='compact-count'||command==='compact-after') {
    const n=(await entries()).filter(e=>e.value?.type==='system'&&(/compact/.test(e.value.subtype??'')||e.value.compactMetadata)).length
    if(command==='compact-count') console.log(n); else check(n>Number(arg),'no new idle compaction boundary')
  } else if(command==='fault-at') {
    const f=readFileSync(shim!,'utf8').split('\n').filter(l=>l.startsWith('fault\t')&&shimWords(l.split('\t')[5]!)[2]===arg).at(-1);check(f,'fault not found');console.log(Number(f.split('\t')[1])*1000)
  } else if(command==='reconnect-proof') {
    const j=journal(),fixed=j.find(r=>r.kind==='fixed'&&r.seq===Number(arg));check(fixed,'reconnect target not fixed')
    const c=calls(), sent=c.find(c=>c.words.includes('--text')&&c.words[c.words.indexOf('--text')+1]===fixed.parts[0]);check(sent,'delivery was not typed')
    const reconnect=c.filter(c=>c.at>=Number(arg2)&&c.at<sent.at&&c.words.includes('send-keys')&&c.words.some(w=>w.startsWith('/mcp reconnect')))
    check(reconnect.length>=1,'delivery preceded its reconnect or reconnect violated the hold interval')
    console.log('recorded: MCP reconnect precedes item '+arg+' after hold '+arg2)
  } else if(command==='reconnects') {
    check(calls().filter(c=>c.words.includes('send-keys')&&c.words.some(w=>w.startsWith('/mcp reconnect'))).length>=4,'not all MCP reconnect variants typed')
  } else if(command==='compacted') {
    check((await entries()).some(e=>e.value?.type==='system'&&(/compact/.test(e.value.subtype??'')||e.value.compactMetadata)), 'no transcript compaction boundary')
  } else if(command==='no-shell') {
    check(!(await entries()).some(e=>e.value?.type==='user'&&JSON.stringify(e.value.message?.content).includes('<bash-input>')), 'body entered native bash-input mode')
  } else if(command==='active-tool'||command==='busy-proof') {
    const adapters=await packedReceiptAdapters(), all=await entries(), j=journal()
    const own=personaTranscripts(key!,j,readFileSync(join(state!,'server.log'),'utf8').split('\n'),all)
      .filter(e=>e.value?.isSidechain!==true)
    const results=(id:string,path:string)=>own.filter(e=>e.path===path&&e.value?.type==='user'&&Array.isArray(e.value.message?.content)
      &&e.value.message.content.some((b:any)=>b.type==='tool_result'&&b.tool_use_id===id))
    if(command==='active-tool') {
      const uses=own.flatMap(e=>blocks(e).filter((b:any)=>b.type==='tool_use'&&b.name==='Bash'&&b.input?.command===arg&&typeof b.id==='string')
        .map((b:any)=>({entry:e,id:b.id}))).filter(u=>results(u.id,u.entry.path).length===0)
      check(uses.length===1,'named Bash tool is not uniquely active')
      const {entry:e,id}=uses[0]!, observed_at=Date.now()
      check(Number.isFinite(e.at)&&e.at<=observed_at&&typeof e.value?.uuid==='string','active tool has no reliable timestamp/identity')
      writeFileSync(arg2,JSON.stringify({path:e.path,uuid:e.value.uuid,offset:e.offset,id,at:e.at,observed_at,command:arg}))
      console.log('recorded: active tool '+JSON.stringify({id,at:e.at,observed_at}))
    } else {
      const selected=JSON.parse(readFileSync(arg,'utf8')), item=j.find(r=>r.kind==='accepted'&&!r.compact&&r.seq===Number(arg2))
      check(item?.source==='slack'&&Number.isFinite(item.received_at),'busy message acceptance missing')
      const use=own.find(e=>e.path===selected.path&&e.offset===selected.offset&&e.value?.uuid===selected.uuid&&e.at===selected.at
        &&blocks(e).some((b:any)=>b.type==='tool_use'&&b.name==='Bash'&&b.id===selected.id&&b.input?.command===selected.command))
      check(use,'active tool does not belong to this persona/session')
      const completed=results(selected.id,use.path)
      check(completed.length===1,'named tool has no unique matching result')
      const result=completed[0]!
      check(Number.isFinite(selected.observed_at)&&use.at<=selected.observed_at&&selected.observed_at<=item.received_at
        &&Number.isFinite(result.at)&&item.received_at<result.at&&result.offset>use.offset,
        'message was not accepted while the observed tool was active (tool finished before acceptance)')
      const fixed=j.find(r=>r.kind==='fixed'&&r.seq===item.seq)
      check(fixed?.parts?.length===1,'busy message has no single fixed part')
      // The normal receipt audit supplies exact text, shim, durable receipt,
      // diagnostic and persona/session/path evidence for both messages.
      const audit=auditReceipts({stateDir:state!,key:key!,shimLog:shim!,transcripts:transcriptFiles(root!),expectedCount:2},all,adapters)
      const takes=own.filter(e=>e.kind==='take-in'&&e.text!==undefined&&e.at>=item.received_at&&adapters.receiptTextMatches(e.text,fixed.parts[0]))
      const take=takes[0]
      check(take&&take.path===use.path&&take.offset>use.offset&&Number.isFinite(take.at),'busy take-in has no same-session timestamp/identity')
      const ends=own.filter(e=>e.path===use.path&&e.offset>use.offset&&e.value?.type==='assistant'
        &&['end_turn','stop_sequence','refusal'].includes(e.value.message?.stop_reason)&&!blocks(e).some((b:any)=>b.type==='tool_use'))
      // Streaming records of one completed message are one turn boundary;
      // keep its first offset so later copies cannot hide a prior turn end.
      const byMessage=new Map<string|number,typeof ends[number]>()
      for(const e of ends) {
        const id=e.value.message?.id??e.value.uuid??e.offset, prior=byMessage.get(id)
        if(!prior||e.offset<prior.offset)byMessage.set(id,e)
      }
      const boundaries=[...byMessage.values()]
      check(boundaries.length>0&&boundaries.every(e=>Number.isFinite(e.at)&&e.at>=result.at),'completed tool turn evidence missing/invalid')
      const before=boundaries.filter(e=>e.offset<take.offset)
      check(before.length<=1&&before.every(e=>e.at<=take.at),'busy message was taken in later than the next turn')
      console.log('recorded: busy take-in '+JSON.stringify({tool_use_id:selected.id,tool_started_at:use.at,accepted_at:item.received_at,
        tool_result_at:result.at,taken_in_at:take.at,turn:before.length===0?'same':'next',duplicates:audit.duplicates}))
    }
  } else if(command==='permission'||command==='subagent-permission') {
    const prompts=jsonLines(arg).filter(r=>r.event==='api'&&r.method==='chat.postMessage'&&r.text?.startsWith('🤖🛠️ permission request:'))
    check(prompts.length>=(command==='permission'?1:2),'permission relay has not posted the request')
    const needle=command==='permission'?'permission-probe':'subagent-deny-probe'
    check((await entries()).some(e=>blocks(e).some((b:any)=>b.type==='tool_use'&&b.input?.command?.includes(needle))), 'requested permission tool not observed')
  } else if(command==='permission-held') {
    const prompt=jsonLines(arg).find(r=>r.event==='api'&&r.method==='chat.postMessage'&&r.text?.startsWith('🤖🛠️ permission request:'))
    check(prompt&&Date.now()-Date.parse(prompt.ts)>=4000,'permission hold has not exceeded the lowered stuck interval')
  } else if(command==='relay-action') {
    const candidates=jsonLines(arg).filter(r=>r.event==='api'&&r.method==='chat.postMessage'&&r.label===key!.replaceAll('_','')&&r.response_ts&&Array.isArray(r.blocks))
    let selected:any, action:any
    for(const post of candidates)for(const block of post.blocks)for(const button of block.elements??[]) {
      if(button.type==='button'&&button.text?.text?.toLowerCase()===arg2) {
        selected=post;action={type:'button',action_id:button.action_id,...(block.block_id?{block_id:block.block_id}:{}),...(button.value!==undefined?{value:button.value}:{})}
      }
    }
    check(selected&&action,'actual relay button not posted')
    console.log(JSON.stringify({label:selected.label,interactive:{type:'block_actions',user:{id:arg3},channel:{id:selected.channel},message:{ts:selected.response_ts},actions:[action]}}))
  } else if(command==='relay-decision') {
    const p=jsonLines(arg).filter(r=>r.event==='push'&&r.event_type==='block_actions').at(-1)
    check(p,'relay action was not sent')
    check(calls().some(c=>c.at>=Date.parse(p.ts)&&c.words.includes('decide')&&c.words[c.words.indexOf('--decision')+1]===arg2),'CSCB did not decide the relayed permission action')
    console.log('recorded: permission '+arg2+' flowed through CSCB relay')
  } else if(command==='dialog-notice') {
    const posts=jsonLines(arg).filter(r=>r.event==='api'&&r.method==='chat.postMessage'&&r.label===arg2)
    const notice=posts.find(r=>r.text?.includes('*Delivery stuck*')&&r.text.includes("a subagent's denied prompt stays held until the bot ends")&&r.text.includes("Restart the persona's bot."))
    check(notice,'dialog-hold Delivery stuck was not actually posted to Slack')
    check(readFileSync(join(state!,'server.log'),'utf8').split('\n').some(l=>l.includes('delivery-stuck:')&&l.includes('(key='+key+')')&&l.includes('reason=dialog-hold')),'dialog-hold diagnostic missing')
    console.log('recorded: actual dialog-hold notice '+JSON.stringify({channel:notice.channel,text:notice.text}))
  } else if(command==='no-stuck') {
    check(!readFileSync(join(state!,'server.log'),'utf8').includes('delivery-stuck:'),'permission prompt raised Delivery stuck')
  } else if(command==='mention-body') {
    const a=journal().filter(r=>r.kind==='accepted'&&!r.compact), m=a.find(r=>r.text.includes('<!here>'))
    check(m,'mention not stored');const f=journal().find(r=>r.kind==='fixed'&&r.seq===m.seq)
    check(f?.parts.join('').includes(`<@${arg}> <!here> &lt;b&gt; <https://example.com|link>`),'mention body lost another mention, here or markup')
  } else if(command==='launches') {
    const launch=calls().filter(c=>c.words.includes('spawn')||c.words.includes('resume'))
    check(launch.some(c=>c.words.includes('spawn')), 'no fresh launch')
    check(!launch.some(c=>c.words.some(w=>/--[a-z-]*channels\b/.test(w))), 'channel launch flag')
    if(arg==='resume') check(launch.some(c=>c.words.includes('resume')), 'resume never exercised')
    const templates=calls().filter(c=>c.words.includes('make-template'))
    check(templates.length>0,'no recorded template')
    const all=templates.map(c=>c.words.join(' ')).join('\n')
    for(const expected of ['DISABLE_AUTOUPDATER','CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY','CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION']) check(all.includes(expected)||launch.some(c=>c.words.some(w=>w.includes(expected))), 'missing launch disable setting '+expected)
    console.log('recorded: launches '+JSON.stringify(launch.map(c=>({at:c.at,verb:c.words.includes('resume')?'resume':'spawn'}))))
  } else if(command==='first-launch') {
    const c=calls(), start=Number(arg), s=c.filter(c=>c.at>=start&&c.words.includes('send-keys')&&c.words.includes('cscb_'+key))
    const text=s.filter(c=>c.words.includes('--no-enter')&&c.words.includes('--text'))
    const enter=s.filter(c=>c.words.includes('--key')&&c.words.includes('Enter'))
    check(text.length>=1&&enter.length>=1,'fresh launch has no text/Enter attempt')
    const j=journal(), item=j.find(r=>r.kind==='accepted'&&!r.compact&&r.received_at>=start), fixed=j.find(r=>r.kind==='fixed'&&r.seq===item?.seq)
    check(fixed?.parts?.length===1&&text.every(t=>t.words[t.words.indexOf('--text')+1]===fixed.parts[0]),'fresh launch text does not match its first message')
    check(!j.some(r=>r.kind==='sent'&&r.seq===item.seq&&r.send_kind==='enter'),'fresh launch needed an Enter-only recovery')
    const waiting=readFileSync(join(state!,'server.log'),'utf8').split('\n').flatMap(line=>{const marker='delivery-launch-first-waiting: ';const i=line.indexOf(marker);if(i<0)return [];try{return [JSON.parse(line.slice(i+marker.length))]}catch{return []}}).find(r=>r.key===key&&r.at>=start&&r.at<=text[0]!.at)
    check(waiting,'actual first-waiting launch observation missing')
    check(text[0]!.at-waiting.at>=1000,'fresh launch settle shorter than 1 second')
    let pending:typeof text[number]|undefined
    const pauses:number[]=[]
    for(const send of s) {
      if(text.includes(send)) pending=send
      if(enter.includes(send)) {
        check(pending,'fresh launch needed an Enter-only retry')
        check(send.at-pending.at>=500,'text/Enter pause shorter than 0.5 seconds')
        pauses.push(send.at-pending.at);pending=undefined
      }
    }
    console.log('recorded: fresh-launch timing '+JSON.stringify({settle_ms:text[0]!.at-waiting.at,enter_ms:pauses,text_attempts:text.length,duplicate_text_attempts:text.length-1}))
  } else if(command==='posts') {
    const posts=jsonLines(arg).filter(r=>r.event==='api'&&r.method==='chat.postMessage')
    const wanted=JSON.parse(readFileSync(arg2,'utf8'))
    const matches=(p:any,w:any)=>{
      if(p.channel!==w.channel||(p.thread_ts??'')!==(w.thread_ts??''))return false
      if(!w.json)return p.text===w.text
      try{const value=JSON.parse(p.text);return Object.keys(w.json).every(k=>value[k]===w.json[k])}catch{return false}
    }
    const remaining=[...posts]
    for(const w of wanted){const index=remaining.findIndex(p=>matches(p,w));check(index>=0,'reply destination/thread/text/count mismatch');remaining.splice(index,1)}
    const texts=wanted.flatMap((w:any)=>w.text?[w.text]:[])
    check(!remaining.some(p=>texts.includes(p.text)&&!wanted.some((w:any)=>matches(p,w))),'wrong-target reply')
  } else if(command==='at-least-one-duplicate') {
    const adapters=await packedReceiptAdapters(), all=await entries(), transcripts=transcriptFiles(root!)
    check(auditReceipts({stateDir:state!,key:key!,shimLog:shim!,transcripts},all,adapters).duplicates>=1,'intended duplicate was not observed')
  } else if(command==='corpus-wrapper') {
    const corpus=JSON.parse(readFileSync(arg,'utf8')), j=journal()
    for(const [i,row] of corpus.entries()) {
      const accepted=j.find(r=>r.kind==='accepted'&&r.seq===i+1&&!r.compact),fixed=j.find(r=>r.kind==='fixed'&&r.seq===i+1)
      check(accepted?.channel===row.msg.chat_id&&accepted.ts===row.msg.ts,'corpus input identity changed')
      check(fixed?.parts?.length===1&&fixed.parts[0]===row.typed,'production wrapper differs for '+row.name)
    }
    console.log('recorded: actual intake fixed every corpus wrapper byte for byte')
  } else if(command==='readback') {
    const expected=JSON.parse(readFileSync(arg,'utf8')), all=await entries()
    const replies=all.filter(e=>e.value?.type==='assistant').flatMap(e=>blocks(e).flatMap((b:any)=>b.type==='text'?[b.text]:b.type==='tool_use'&&b.name?.endsWith('__reply')?[b.input?.text]:[]))
    let found=false
    for(const text of replies) {
      try {
        const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''))
        if(value.case!==expected.case) continue
        const stable=(v:any):string=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):v)
        check(JSON.stringify(value)===JSON.stringify(expected)||Object.keys(expected).every(k=>stable(value[k])===stable(expected[k])),'AI read-back field differs')
        console.log('recorded: AI field comparison '+JSON.stringify(value));found=true
      } catch(e) { if(e instanceof Error&&e.message==='AI read-back field differs') throw e }
    }
    check(found,'no JSON read-back for this case')
  } else if(command==='selfcheck') {
    const dir=join(state!,'receipt-controls');mkdirSync(join(dir,'queue'),{recursive:true})
    const adapters=await packedReceiptAdapters(), transcript=join(dir,'session-control.jsonl'), log=join(dir,'shim.log')
    const texts=['<channel>one</channel>','<channel>two</channel>']
    // These are deliberately synthetic harness controls, never evidence for
    // a real-agent acceptance case. Every negative starts from this passing
    // production contract, including scoped attempts and both diagnostics.
    // Negative controls intentionally mutate journal shapes and identities.
    const records:any[]=texts.flatMap((text,i)=>[
      {v:1,kind:'accepted',seq:i+1,source:'slack',text,ts:'1792000000.000001',channel:'C0CONTROL'+i,user:'U0CONTROL',received_at:900},
      {v:1,kind:'fixed',seq:i+1,parts:[text]},
      {v:1,kind:'sent',seq:i+1,part:1,attempt:1,send_kind:'text',at:2000+i*20000,launch_id:1,session_id:'session-control',transcript_path:transcript,transcript_size:0},
      {v:1,kind:'delivered',seq:i+1,part:1,at:3000+i*20000,receipt:{path:transcript,uuid:'r'+i}},
    ])
    const originalTakes=texts.map((text,i)=>({type:'user',uuid:'r'+i,sessionId:'session-control',timestamp:new Date(2500+i*20000).toISOString(),message:{role:'user',content:text}}))
    const diagnostic=(kind:string,i:number,at:number)=>`[${new Date(at).toISOString()}] [slack] ${kind}: persona="control" (key=control) source=slack chat_id="C0CONTROL${i}" ts="1792000000.000001" sender_id="U0CONTROL"`
    const originalLines=texts.flatMap((_,i)=>[diagnostic('message-received',i,1000),diagnostic('message-delivered',i,i===0?20000:24000)])
    const write=(j=records,takes=originalTakes,sendTimes=[2000,22000],lines=originalLines,instanceIds=['cscb_control','cscb_control'],takePath=transcript)=>{
      writeFileSync(join(dir,'queue','control.jsonl'),j.map(r=>JSON.stringify(r)).join('\n')+'\n')
      mkdirSync(resolve(takePath,'..'),{recursive:true})
      writeFileSync(takePath,takes.map(r=>JSON.stringify(r)).join('\n')+'\n')
      writeFileSync(log,texts.map((t,i)=>`call\t${sendTimes[i]!/1000}\t1\t1\tbun\tsend-keys --instance-id ${instanceIds[i]} --text ${t.replaceAll('<','\\<').replaceAll('>','\\>')} --no-enter`).join('\n')+'\n')
      writeFileSync(join(dir,'server.log'),lines.join('\n')+'\n')
    }
    const audit=(path=transcript)=>auditReceipts({stateDir:dir,key:'control',shimLog:log,transcripts:[path]},readTranscripts([path],adapters),adapters)
    write();const positive=audit();check(positive.items===2,'positive receipt control failed')
    check(positive.timings[0]?.delivery_ms===19000,'19-second logged delivery latency was not 19000ms')
    console.log('recorded: positive receipt control passed; logged delivery_ms=19000')
    const foreignPath=join(dir,'foreign','session-control.jsonl')
    const controls:[string,()=>void,string?][]=[
      ['missing receipt',()=>write(records,[originalTakes[0]!])],
      ['out of order',()=>write(records,[{...originalTakes[1]!,timestamp:new Date(2500).toISOString()},{...originalTakes[0]!,timestamp:new Date(22500).toISOString()}])],
      ['premature send',()=>write(records,originalTakes,[2000,19000])],
      ['open item',()=>write(records.filter(r=>!(r.kind==='delivered'&&r.seq===2)))],
      ['other persona send',()=>write(records,originalTakes,[2000,22000],originalLines,['cscb_control','cscb_other'])],
      ['other persona session',()=>write(records.map(r=>r.kind==='sent'?{...r,session_id:'other-session',transcript_path:join(dir,'other-session.jsonl')}:r))],
      ['other transcript directory',()=>write(records,originalTakes,[2000,22000],originalLines,undefined,foreignPath),foreignPath],
      ['other embedded session',()=>write(records,originalTakes.map(r=>({...r,sessionId:'other-session'})))],
      ['missing received diagnostic',()=>write(records,originalTakes,[2000,22000],originalLines.filter(l=>!l.includes('message-received')))],
      ['missing delivered diagnostic',()=>write(records,originalTakes,[2000,22000],originalLines.filter(l=>!l.includes('message-delivered')))],
      ['other persona diagnostic',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.replace('(key=control)','(key=other)')))],
      ['same timestamp other channel diagnostic',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.replace('chat_id="C0CONTROL1"','chat_id="C0CONTROL0"')))],
      ['negative received timing',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.includes('message-received')?l.replace('1970-01-01T00:00:01.000Z','1969-12-31T23:59:59.000Z'):l))],
      ['invalid received timing',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.includes('message-received')?l.replace(/\[[^\]]+\]/,'[invalid]'):l))],
      ['negative typing measurement',()=>write(records,originalTakes,[500,22000])],
      ['invalid typing measurement',()=>write(records,originalTakes,[NaN,22000])],
      ['negative delivery measurement',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.includes('message-delivered')?l.replace('1970-01-01T00:00:20.000Z','1970-01-01T00:00:00.500Z'):l))],
      ['invalid delivery timing',()=>write(records,originalTakes,[2000,22000],originalLines.map(l=>l.includes('message-delivered')?l.replace(/\[[^\]]+\]/,'[invalid]'):l))],
    ]
    for(const [name,mutate,path] of controls) {
      write();check(audit().items===2,`${name} baseline failed`);mutate()
      let reason='';try{audit(path)}catch(error){reason=error instanceof Error?error.message:String(error)}check(reason,`${name} was accepted`)
      if(name==='premature send')check(reason==='Successor send preceded prior receipt/delivery log','premature send failed for another reason')
      console.log('recorded: receipt control rejected '+name)
    }
    write(records,[originalTakes[0]!,{...originalTakes[0]!,uuid:'duplicate',timestamp:new Date(4000).toISOString()},originalTakes[1]!]);check(audit().duplicates===1,'duplicate was rejected or not counted')
    console.log('recorded: receipt duplicate counted without failure')
    const retryRecords=records.flatMap(r=>r.kind==='delivered'&&r.seq===1?[
      {...records[2],send_kind:'retype',attempt:2,at:2100},
      {...records[2],send_kind:'enter',attempt:3,at:2800},r,
    ]:[r])
    write(retryRecords)
    const originalShim=readFileSync(log,'utf8')
    const enterCall='call\t2.9\t1\t1\tbun\tsend-keys --instance-id cscb_control --key Enter\n'
    const enterFault='fault\t2.5\t1\t1\tbun\tsend-keys key=Enter swallow 1\n'
    writeFileSync(log,originalShim+enterFault+enterCall)
    const keyProof=()=>Bun.spawnSync([process.execPath,import.meta.path,'key-proof',dir,'control',log,dir,'1','enter'])
    check(keyProof().exitCode===0,'Enter-only recovery rejected a permitted duplicate text attempt')
    writeFileSync(log,originalShim+enterCall)
    check(keyProof().exitCode!==0,'Enter-only recovery passed without the injected missed Enter')
    console.log('recorded: Enter-only recovery accepts duplicate text and requires the swallowed Enter')
    const invoke=(name:string,...args:string[])=>Bun.spawnSync([process.execPath,import.meta.path,name,dir,'control',log,dir,...args])
    const expectControl=(name:string,run:()=>ReturnType<typeof invoke>,reason?:string)=>{
      const result=run(), error=Buffer.from(result.stderr).toString()
      check(reason?result.exitCode!==0&&error.includes(reason):result.exitCode===0,`${name} control failed: ${error}`)
      console.log(`recorded: ${reason?'rejected':'passed'} ${name}`)
    }
    const call=(at:number,words:string)=>`call\t${at/1000}\t1\t1\tbun\tsend-keys --instance-id cscb_control ${words}\n`
    const textCall=(at:number)=>call(at,'--text '+texts[0]!.replaceAll('<','\\<').replaceAll('>','\\>')+' --no-enter')
    const writeLaunch=(duplicate=false,textAt=2000,enterAt=2500,duplicateEnter=3500)=>{
      const takes=[originalTakes[0]!,...(duplicate?[{...originalTakes[0]!,uuid:'launch-duplicate',timestamp:new Date(3500).toISOString()}]:[])]
      const attempts=records.slice(0,4)
      if(duplicate)attempts.push({...records[2],send_kind:'retype',attempt:2,at:3000})
      write(attempts,takes)
      writeFileSync(log,textCall(textAt)+call(enterAt,'--key Enter')+(duplicate?textCall(3000)+call(duplicateEnter,'--key Enter'):''))
      writeFileSync(join(dir,'server.log'),originalLines.slice(0,2).join('\n')+'\n[slack] delivery-launch-first-waiting: '+JSON.stringify({key:'control',at:1000})+'\n')
    }
    writeLaunch();check(audit().items===1,'first-launch baseline lacks valid receipt identities')
    expectControl('first-launch baseline',()=>invoke('first-launch','0'))
    writeLaunch(true);check(audit().duplicates===1,'first-launch duplicate not counted')
    expectControl('first-launch full text/Enter duplicate',()=>invoke('first-launch','0'))
    writeFileSync(log,readFileSync(log,'utf8')+call(4000,'--key Enter'))
    expectControl('first-launch Enter-only retry',()=>invoke('first-launch','0'),'Enter-only retry')
    writeLaunch(true)
    const launchJournal=join(dir,'queue','control.jsonl')
    writeFileSync(launchJournal,readFileSync(launchJournal,'utf8')+JSON.stringify({...records[2],send_kind:'enter',attempt:3,at:3500})+'\n')
    expectControl('first-launch recorded Enter recovery',()=>invoke('first-launch','0'),'Enter-only recovery')
    writeLaunch(false,1999,2500)
    expectControl('first-launch 999ms settle',()=>invoke('first-launch','0'),'settle shorter than 1 second')
    writeLaunch(false,2000,2499)
    expectControl('first-launch 499ms pause',()=>invoke('first-launch','0'),'pause shorter than 0.5 seconds')
    writeLaunch(true,2000,2500,3499)
    expectControl('first-launch duplicate 499ms pause',()=>invoke('first-launch','0'),'pause shorter than 0.5 seconds')
    writeLaunch()
    writeFileSync(join(dir,'server.log'),readFileSync(join(dir,'server.log'),'utf8').replace('"key":"control"','"key":"other"'))
    expectControl('first-launch other persona waiting',()=>invoke('first-launch','0'),'first-waiting launch observation missing')

    const checkpoint=join(dir,'active-tool.json'), base=Date.now()-3500
    let checkpointDelay=0
    const afterCheckpoint=(at:number)=>base+at+checkpointDelay
    const entry=(type:string,uuid:string,at:number,message:any)=>({type,uuid,sessionId:'session-control',timestamp:new Date(base+at).toISOString(),message})
    const tool=entry('assistant','sleep-use',3000,{id:'sleep-message',role:'assistant',content:[{type:'tool_use',id:'sleep-id',name:'Bash',input:{command:'sleep 20'}}],stop_reason:'tool_use'})
    const result=entry('user','sleep-result',23000,{role:'user',content:[{type:'tool_result',tool_use_id:'sleep-id',content:''}]})
    const end=(at:number,id:string)=>entry('assistant',id,at,{id,role:'assistant',content:[],stop_reason:'end_turn'})
    const writeBusy=(mode:'active'|'same'|'next'|'late'='same',resultAt=23000,receiptSession='session-control',resultId='sleep-id')=>{
      const next=mode==='next'||mode==='late',takeAt=next?24500:22500
      const j=records.map(r=>({...r,...(r.kind==='accepted'?{received_at:r.seq===2?afterCheckpoint(4000):base+900}:{}),
        ...('at' in r?{at:r.seq===2?afterCheckpoint(r.kind==='delivered'?takeAt+500:r.at):base+r.at}:{})}))
      const takes=originalTakes.map((r,i)=>({...r,sessionId:i===1?receiptSession:r.sessionId,timestamp:new Date(i===1?afterCheckpoint(takeAt):base+2500).toISOString()}))
      const done={...result,timestamp:new Date(afterCheckpoint(resultAt)).toISOString(),message:{...result.message,content:[{...result.message.content[0],tool_use_id:resultId}]}}
      const events=mode==='active'?[takes[0]!,tool]:[takes[0]!,tool,done,...(next?[end(24000+checkpointDelay,'sleep-turn-end')]:[]),
        ...(mode==='late'?[end(24200+checkpointDelay,'extra-turn-end')]:[]),takes[1]!,end((next?26000:24000)+checkpointDelay,'final-turn-end')]
      events.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))
      const lines=texts.flatMap((_,i)=>[diagnostic('message-received',i,i===1?afterCheckpoint(4000):base+1000),diagnostic('message-delivered',i,i===1?afterCheckpoint(takeAt+1000):base+20000)])
      write(j,events as typeof originalTakes,[base+2000,afterCheckpoint(22000)],lines)
    }
    writeBusy('active')
    expectControl('active named sleep',()=>invoke('active-tool','sleep 20',checkpoint))
    // Keep the actual checkpoint produced by the precondition. The following
    // controls are synthetic fixture mutations, never real acceptance evidence.
    // Anchor later events to its observation, so subprocess startup cannot
    // overtake the synthetic acceptance; keep the tool and its prefix intact.
    const observedAt=JSON.parse(readFileSync(checkpoint,'utf8')).observed_at
    check(Number.isFinite(observedAt),'active control checkpoint lacks an observation timestamp')
    checkpointDelay=observedAt-(base+3500)
    writeBusy('same');check(audit().items===2,'busy baseline lacks valid receipt identities')
    expectControl('busy same-turn receipt',()=>invoke('busy-proof',checkpoint,'2'))
    expectControl('completed sleep precondition',()=>invoke('active-tool','sleep 20',checkpoint),'not uniquely active')
    writeBusy('next')
    expectControl('busy next-turn receipt',()=>invoke('busy-proof',checkpoint,'2'))
    const repeatBoundary=(id:string,at:number)=>{
      const rows=jsonLines(transcript), repeated=rows.find(e=>e.message?.id===id)
      check(repeated,'turn-boundary control missing')
      rows.push({...repeated,uuid:id+'-stream-copy',timestamp:new Date(afterCheckpoint(at)).toISOString()})
      rows.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))
      writeFileSync(transcript,rows.map(e=>JSON.stringify(e)).join('\n')+'\n')
    }
    repeatBoundary('sleep-turn-end',24200)
    expectControl('busy duplicate streaming turn boundary',()=>invoke('busy-proof',checkpoint,'2'))
    writeBusy('late')
    expectControl('busy later-than-next receipt',()=>invoke('busy-proof',checkpoint,'2'),'later than the next turn')
    repeatBoundary('extra-turn-end',27000)
    expectControl('busy late boundary copied after receipt',()=>invoke('busy-proof',checkpoint,'2'),'later than the next turn')
    writeBusy('same',4000)
    expectControl('tool completion/acceptance race',()=>invoke('busy-proof',checkpoint,'2'),'tool finished before acceptance')
    writeBusy('same',23000,'session-control','other-tool-id')
    expectControl('unrelated tool result',()=>invoke('busy-proof',checkpoint,'2'),'no unique matching result')
    writeBusy('same',23000,'other-session')
    expectControl('busy foreign receipt session',()=>invoke('busy-proof',checkpoint,'2'),'no exact transcript receipt')
    writeBusy('active')
    expectControl('busy no matching result yet',()=>invoke('busy-proof',checkpoint,'2'),'no unique matching result')
    writeFileSync(transcript,jsonLines(transcript).map(e=>JSON.stringify(e.uuid==='sleep-use'?{...e,sessionId:'other-session'}:e)).join('\n')+'\n')
    expectControl('active tool foreign session',()=>invoke('active-tool','sleep 20',checkpoint),'not uniquely active')
    writeBusy()
    const busyEntries=jsonLines(transcript)
    writeFileSync(transcript,busyEntries.map(e=>JSON.stringify(e.uuid==='sleep-result'?{...e,timestamp:'invalid'}:e)).join('\n')+'\n')
    expectControl('busy invalid result timestamp',()=>invoke('busy-proof',checkpoint,'2'),'tool finished before acceptance')
    writeBusy()
    writeFileSync(transcript,jsonLines(transcript).filter(e=>e.message?.stop_reason!=='end_turn').map(e=>JSON.stringify(e)).join('\n')+'\n')
    expectControl('busy no completed turn evidence',()=>invoke('busy-proof',checkpoint,'2'),'completed tool turn evidence missing')
    rmSync(dir,{recursive:true,force:true})
  } else throw new Error('unknown lane-1 assertion')
} catch(error) { console.error('real-case-assertions: '+(error instanceof Error?error.message:'unknown'));process.exit(1) }
