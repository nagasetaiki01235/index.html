
'use strict';
(()=>{
const API='https://kadai-note-notify.nagase-taiki8.workers.dev';
const KEY='kadai-note:push:v1';
let config={},registration=null,busy=false,queued=false,timer=null,lastSync=0;
const status=text=>document.getElementById('push-status').textContent=text;
try{config=JSON.parse(localStorage.getItem(KEY)||'{}');}catch{status('通知設定を読み込めませんでした。');}
function persist(){localStorage.setItem(KEY,JSON.stringify(config));}
function supported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
function token(){if(!config.token){config.token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');persist();}return config.token;}
function buttons(){
document.getElementById('push-enable').hidden=!!config.enabled;
document.getElementById('push-test').hidden=!config.enabled;
document.getElementById('push-disable').hidden=!config.enabled;
}
async function request(path,body){
const r=await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
const d=await r.json();if(!r.ok)throw Error(d.error||'通知サーバーに接続できません。');return d;
}
function reminders(now=Date.now()){
const occurrences=new Map();
for(const t of tasks){if(!t.done&&!t.skipped&&new Date(t.due).getTime()>now)occurrences.set((t.ruleId||t.id)+'@'+t.due,t);}
for(const r of rules.filter(r=>r.active)){
let due=firstDue(r.day,r.time,new Date(now));
while(new Date(due).getTime()<now+90*86400000){
const recorded=tasks.find(t=>t.ruleId===r.id&&t.due===due);
if(!recorded||(!recorded.done&&!recorded.skipped))occurrences.set(r.id+'@'+due,{course:r.course,title:r.title,due});
due=nextWeek(due);
}
}
const jobs=[];
for(const [id,t] of occurrences){
const due=new Date(t.due).getTime();
if(due>now+179*86400000)continue;
for(const [offset,label] of [[86400000,'前日'],[3600000,'1時間前']]){
const fire=due-offset;
if(fire<now-300000)continue;
jobs.push({id:id+':'+offset,due,fire,title:('課題ノート · '+label).slice(0,150),body:(t.course+(t.title?'：'+t.title:'')+'\n締切 '+new Date(due).toLocaleString('ja-JP',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})).slice(0,300)});
}
}
if(jobs.length>500)throw Error('通知予約の上限を超えています。毎週の設定を減らしてください。');
return jobs;
}
async function sync(){
if(!config.enabled)return;
if(busy){queued=true;return;}
busy=true;status('通知予定を保存しています…');
try{
if(saveFailed||storageBlocked)throw Error('課題の保存エラーを解消してから、通知予定を更新してください。');
registration=registration||await navigator.serviceWorker.ready;
const sub=await registration.pushManager.getSubscription();
if(!sub||Notification.permission!=='granted')throw Error('通知の許可がありません。「通知を停止」後に再度有効にしてください。');
const jobs=reminders();config.revision=Math.max(Date.now(),(config.revision||0)+1);persist();
await request('/sync',{subscription:sub.toJSON(),jobs,revision:config.revision});
lastSync=Date.now();status('通知予定を保存しました。締切の前日・1時間前にお知らせします。');
}catch(e){status('通知予定を更新できません：'+e.message+' 変更が反映されるまで、以前の通知予定が残る場合があります。');}
finally{busy=false;if(queued){queued=false;queueSync();}}
}
function queueSync(){if(!config.enabled)return;clearTimeout(timer);timer=setTimeout(sync,500);}
window.queueNotificationSync=queueSync;
document.getElementById('push-enable').onclick=async()=>{
if(!supported()){status('iPhoneではSafariからホーム画面に追加し、そのアイコンから開いてください。iOS 16.4以降が必要です。');return;}
if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!navigator.standalone&&!matchMedia('(display-mode: standalone)').matches){status('Safariの共有メニューから「ホーム画面に追加」して、そのアイコンから開いてください。');return;}
const button=document.getElementById('push-enable');button.disabled=true;
try{
const permission=await Notification.requestPermission();
if(permission!=='granted')throw Error('通知が許可されていません。iPhoneの設定で通知を許可してください。');
registration=registration||await navigator.serviceWorker.ready;
let sub=await registration.pushManager.getSubscription();
if(!sub){
const r=await fetch(API+'/key',{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('通知サーバーに接続できません。');
const {publicKey}=await r.json();
const key=Uint8Array.from(atob(publicKey.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
token();sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
}
config.enabled=true;persist();buttons();await sync();
}catch(e){status(e.message);}
finally{button.disabled=false;}
};
document.getElementById('push-test').onclick=async()=>{
const button=document.getElementById('push-test');button.disabled=true;
try{await request('/test',{});status('テスト通知を送信しました。iPhoneの通知を確認してください。');}
catch(e){status('テスト通知を送れませんでした：'+e.message);}
finally{button.disabled=false;}
};
document.getElementById('push-disable').onclick=async()=>{
if(busy){status('通知予定の保存が終わってから、もう一度停止してください。');return;}
const button=document.getElementById('push-disable');button.disabled=true;clearTimeout(timer);
try{
await request('/unsubscribe',{});
config.enabled=false;persist();buttons();
registration=registration||await navigator.serviceWorker.ready;
const sub=await registration.pushManager.getSubscription();if(sub)await sub.unsubscribe();
status('通知を停止しました。');
}catch(e){status('通知の停止を完了できませんでした：'+e.message);}
finally{button.disabled=false;}
};
buttons();
if(supported()){
navigator.serviceWorker.register('/sw.js').then(async r=>{registration=r;await navigator.serviceWorker.ready;if(config.enabled)sync();}).catch(()=>status('通知機能を準備できませんでした。通信状態を確認して再読み込みしてください。'));
}else status('iPhoneはSafariからホーム画面に追加して開いてください。');
window.addEventListener('online',queueSync);
window.addEventListener('focus',()=>{if(Date.now()-lastSync>86400000)queueSync();});
setInterval(()=>{if(Date.now()-lastSync>86400000)queueSync();},60000);
})();
