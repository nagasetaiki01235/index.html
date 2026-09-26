// Cloudflare Worker: bind D1 as DB; Cron: */5 * * * *.
// No external packages or node compatibility flags required.
const ORIGIN = 'https://kadai-note.pages.dev';
const enc = new TextEncoder();
const bytes = v => new Uint8Array(v);
const join = (...parts) => { const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let i=0; for(const p of parts){out.set(p,i);i+=p.length;} return out; };
const b64 = v => btoa(String.fromCharCode(...bytes(v))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const un64 = v => Uint8Array.from(atob(v.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const hash = async v => b64(await crypto.subtle.digest('SHA-256',enc.encode(v)));
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const sql = (db,q,...args) => db.prepare(q).bind(...args);
let initialized;
async function setup(db){
  if(!db)fail(503,'DB binding is missing');
  if(!initialized)initialized=db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_clients (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, subscription TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, test_at INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_jobs (client_id TEXT NOT NULL, id TEXT NOT NULL, due INTEGER NOT NULL, fire INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(client_id,id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS push_jobs_fire ON push_jobs(fire)'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_deliveries (client_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, lease INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(client_id,id))')
  ]).catch(e=>{initialized=null;throw e;});
  await initialized;
}
async function keys(db){
  let k=await db.prepare('SELECT * FROM push_keys WHERE id=1').first();
  if(!k){
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const pub=b64(await crypto.subtle.exportKey('raw',pair.publicKey));
    const priv=JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey));
    await sql(db,'INSERT OR IGNORE INTO push_keys VALUES (1,?,?)',pub,priv).run();
    k=await db.prepare('SELECT * FROM push_keys WHERE id=1').first();
  }
  return k;
}
async function hkdf(secret,salt,info,length){
  const key=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
  return bytes(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
async function encrypt(subscription,message){
  const ua=un64(subscription.keys.p256dh), auth=un64(subscription.keys.auth);
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const as=bytes(await crypto.subtle.exportKey('raw',pair.publicKey));
  const peer=await crypto.subtle.importKey('raw',ua,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const secret=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
  const ikm=await hkdf(secret,auth,join(enc.encode('WebPush: info\0'),ua,as),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),12);
  const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const plain=join(enc.encode(JSON.stringify(message)),new Uint8Array([2]));
  if(plain.length+16>=4096)fail(400,'Push payload too large');
  const cipher=bytes(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,plain));
  const header=new Uint8Array(5);new DataView(header.buffer).setUint32(0,4096);header[4]=as.length;
  return join(salt,header,as,cipher);
}
async function authorization(endpoint,k){
  const head=b64(enc.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const payload=b64(enc.encode(JSON.stringify({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:ORIGIN})));
  const unsigned=head+'.'+payload;
  const key=await crypto.subtle.importKey('jwk',JSON.parse(k.private_key),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(unsigned));
  return 'vapid t='+unsigned+'.'+b64(sig)+', k='+k.public_key;
}
async function validateSubscription(s){
  if(!s||typeof s.endpoint!=='string'||s.endpoint.length>2048||!s.keys)fail(400,'Invalid subscription');
  const u=new URL(s.endpoint);
  const allowed=u.hostname==='web.push.apple.com'||u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com';
  if(!allowed||u.protocol!=='https:'||u.port||u.username||u.password)fail(400,'Unsupported push endpoint');
  if(typeof s.keys.auth!=='string'||typeof s.keys.p256dh!=='string'||s.keys.auth.length>32||s.keys.p256dh.length>100)fail(400,'Invalid subscription keys');
  const pub=un64(s.keys.p256dh);if(pub.length!==65||un64(s.keys.auth).length!==16)fail(400,'Invalid subscription keys');
  await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);
}
async function send(s,message,k){
  await validateSubscription(s);
  return fetch(s.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:await authorization(s.endpoint,k),'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'3600',Urgency:'normal'},body:await encrypt(s,message)});
}
async function readJson(request){
  if(!request.headers.get('Content-Type')?.includes('application/json'))fail(415,'JSON required');
  if(!request.body)fail(400,'Missing body');
  const reader=request.body.getReader();let length=0;const parts=[];
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>250000){await reader.cancel();fail(413,'Request too large');}parts.push(value);}
  try{return JSON.parse(new TextDecoder().decode(join(...parts)));}catch{fail(400,'Invalid JSON');}
}
function validateJobs(jobs){
  if(!Array.isArray(jobs)||jobs.length>500)fail(400,'At most 500 reminders');
  const ids=new Set(),now=Date.now();
  for(const j of jobs){
    if(!j||typeof j.id!=='string'||!j.id.length||j.id.length>160||ids.has(j.id)||!Number.isSafeInteger(j.due)||!Number.isSafeInteger(j.fire)||j.fire>=j.due||j.due>now+180*86400000||j.due<now-86400000||typeof j.title!=='string'||j.title.length>150||typeof j.body!=='string'||j.body.length>300)fail(400,'Invalid reminder');
    ids.add(j.id);
  }
}
async function removeClient(db,id){
  await db.batch([sql(db,'DELETE FROM push_jobs WHERE client_id=?',id),sql(db,'DELETE FROM push_deliveries WHERE client_id=?',id),sql(db,'DELETE FROM push_clients WHERE id=?',id)]);
}
function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':ORIGIN,'Vary':'Origin'}});}
async function api(request,env){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin'}});
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==ORIGIN)fail(403,'Origin not allowed');
  await setup(env.DB);
  if(request.method==='GET'&&url.pathname==='/')return reply({ok:true,message:'通知サーバー準備OK。アプリ側で通知を有効にしてください。'});
  if(request.method==='GET'&&url.pathname==='/key')return reply({publicKey:(await keys(env.DB)).public_key});
  if(request.method!=='POST')fail(405,'POST required');
  const token=request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!token)fail(401,'Device token required');
  const id=await hash(token),db=env.DB;
  if(url.pathname==='/unsubscribe'){await removeClient(db,id);return reply({ok:true});}
  if(url.pathname==='/sync'){
    const body=await readJson(request);await validateSubscription(body.subscription);validateJobs(body.jobs);
    if(!Number.isSafeInteger(body.revision)||body.revision<1)fail(400,'Revision required');
    const client=await sql(db,'SELECT revision FROM push_clients WHERE id=?',id).first();
    if(client&&body.revision<=client.revision)fail(409,'Stale revision');
    const owner=await sql(db,'SELECT id FROM push_clients WHERE endpoint=?',body.subscription.endpoint).first();
    if(owner&&owner.id!==id)fail(409,'Subscription belongs to another device token');
    const statements=[sql(db,'INSERT INTO push_clients(id,endpoint,subscription,revision) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,subscription=excluded.subscription,revision=excluded.revision WHERE excluded.revision>push_clients.revision',id,body.subscription.endpoint,JSON.stringify(body.subscription),body.revision),sql(db,'DELETE FROM push_jobs WHERE client_id=? AND EXISTS (SELECT 1 FROM push_clients WHERE id=? AND revision=?)',id,id,body.revision)];
    for(const j of body.jobs)statements.push(sql(db,'INSERT OR REPLACE INTO push_jobs(client_id,id,due,fire,title,body) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM push_clients WHERE id=? AND revision=?)',id,j.id,j.due,j.fire,j.title,j.body,id,body.revision));
    await db.batch(statements);return reply({ok:true,count:body.jobs.length});
  }
  if(url.pathname==='/test'){
    const client=await sql(db,'SELECT * FROM push_clients WHERE id=?',id).first();if(!client)fail(404,'Enable notifications first');
    const changed=await sql(db,'UPDATE push_clients SET test_at=? WHERE id=? AND test_at<? RETURNING id',Date.now(),id,Date.now()-60000).first();
    if(!changed)fail(429,'Wait one minute before another test');
    const result=await send(JSON.parse(client.subscription),{title:'課題ノート',body:'テスト通知です。通知を受け取れました！',tag:'kadai-test',url:ORIGIN},await keys(db));
    if(result.status===404||result.status===410){await removeClient(db,id);fail(410,'Subscription expired');}
    if(!result.ok)fail(502,'Push service rejected test: '+result.status);
    return reply({ok:true,message:'Push service accepted the notification'});
  }
  fail(404,'Not found');
}
async function scheduled(env){
  const db=env.DB;await setup(db);const now=Date.now();
  const {results}=await sql(db,"SELECT j.*, c.subscription FROM push_jobs j JOIN push_clients c ON c.id=j.client_id LEFT JOIN push_deliveries d ON d.client_id=j.client_id AND d.id=j.id WHERE j.fire<=? AND j.due>? AND (d.id IS NULL OR (d.state='pending' AND d.lease<? AND d.attempts<5)) ORDER BY j.fire LIMIT 20",now,now,now).all();
  if(!results.length)return;const k=await keys(db);
  for(const j of results){
    const claim=await sql(db,"INSERT INTO push_deliveries(client_id,id,state,lease,attempts) VALUES (?,?,'pending',?,1) ON CONFLICT(client_id,id) DO UPDATE SET lease=excluded.lease,attempts=push_deliveries.attempts+1 WHERE push_deliveries.state='pending' AND push_deliveries.lease<? AND push_deliveries.attempts<5 RETURNING id",j.client_id,j.id,now+600000,now).first();
    if(!claim)continue;
    const active=await sql(db,'SELECT 1 AS ok FROM push_jobs WHERE client_id=? AND id=?',j.client_id,j.id).first();
    if(!active)continue;
    try{
      const result=await send(JSON.parse(j.subscription),{title:j.title,body:j.body,tag:j.id,url:ORIGIN},k);
      if(result.status===404||result.status===410){await removeClient(db,j.client_id);continue;}
      if(result.ok)await sql(db,"UPDATE push_deliveries SET state='sent' WHERE client_id=? AND id=?",j.client_id,j.id).run();
      else console.warn('Push service status',result.status);
    }catch{console.warn('Push attempt failed; will retry');}
  }
}
export default {
  async fetch(request,env){try{return await api(request,env);}catch(e){return reply({ok:false,error:e.status?e.message:'通知サーバーでエラーが発生しました。DB設定を確認してください。'},e.status||500);}},
  async scheduled(event,env,ctx){ctx.waitUntil(scheduled(env));}
};
