self.addEventListener('push',event=>{
let data={};try{data=event.data?.json()||{};}catch{}
event.waitUntil(self.registration.showNotification(data.title||'課題ノート',{body:data.body||'課題の締切を確認してください。',tag:data.tag||'kadai-reminder',data:{url:self.location.origin+'/'}}));
});
self.addEventListener('notificationclick',event=>{
event.notification.close();
event.waitUntil((async()=>{
const list=await clients.matchAll({type:'window',includeUncontrolled:true});
for(const c of list){if(new URL(c.url).origin===self.location.origin)return c.focus();}
return clients.openWindow(self.location.origin+'/');
})());
});
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(clients.claim()));
