'use strict';
(() => {
 const $ = id => document.getElementById(id);
 const state = {joined:false, directory:false, marketing:false, requested:false, mutual:false};
 let toastTimer;
 function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
 function selectTab(name,scroll=false){
   if(!['profile','event','organizer'].includes(name))return;
   document.querySelectorAll('[data-tab]').forEach(b=>{const s=b.dataset.tab===name;b.setAttribute('aria-selected',String(s));b.tabIndex=s?0:-1;});
   ['profile','event','organizer'].forEach(t=>$(`panel-${t}`).hidden=t!==name);
   updateStats();
   if(scroll){$('demo').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});$(`tab-${name}`).focus({preventScroll:true});}
 }
 document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));
 document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.open,true)));
 document.querySelector('[role=tablist]').addEventListener('keydown',e=>{
   const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(document.activeElement);
   let n=i;
   if(e.key==='ArrowRight')n=(i+1)%tabs.length;else if(e.key==='ArrowLeft')n=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=tabs.length-1;else return;
   e.preventDefault();selectTab(tabs[n].dataset.tab);tabs[n].focus();
 });
 function profile(){
   const name=$('profile-name').value.trim()||'Ваше имя', role=$('profile-role').value.trim()||'Ваша роль';
   $('preview-name').textContent=name;$('preview-role').textContent=role;
   $('preview-initials').textContent=name.split(/\s+/).slice(0,2).map(n=>[...n][0]||'').join('').toUpperCase();
   const shown=$('public-email').checked;
   $('preview-email').hidden=!shown;$('email-hidden-info').textContent=shown?'Телефон не опубликован':'Email и телефон не опубликованы';
 }
 ['profile-name','profile-role','public-email'].forEach(id=>$(id).addEventListener('input',profile));
 function download(content,mime,filename){const blob=new Blob([content],{type:mime}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
 const esc=value=>String(value).replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
 $('save-vcard').addEventListener('click',()=>{
   const lines=['BEGIN:VCARD','VERSION:3.0','FN:'+esc($('profile-name').value.trim()||'Demo Profile'),'TITLE:'+esc($('profile-role').value.trim())];
   if($('public-email').checked)lines.push('EMAIL;TYPE=INTERNET:anna@example.com');
   lines.push('NOTE:WELCOME demonstration only — fictional person','END:VCARD');
   download(lines.join('\r\n')+'\r\n','text/vcard;charset=utf-8','welcome-demo.vcf');toast('Скачана демонстрационная vCard. На телефоне может потребоваться подтверждение импорта.');
 });
 $('download-qr').addEventListener('click',()=>{const svg=document.querySelector('.qr-code svg');download(svg.outerHTML,'image/svg+xml','welcome-demo-qr.svg');toast('Демо QR скачан. Его адрес задаётся при сборке; localhost не доступен на чужом телефоне.');});
 $('copy-link').addEventListener('click',async()=>{
   const url=new URL(location.href);url.hash='profile';
   if(url.protocol==='file:'){toast('Для общей ссылки запустите preview на сервере или подключите публичный домен.');return;}
   try{await navigator.clipboard.writeText(url.href);toast('Ссылка на текущий preview скопирована. Локальный адрес работает только на этом устройстве.');}
   catch{toast('Браузер не разрешил буфер обмена. Скопируйте адрес страницы и добавьте #profile.');}
 });
 $('whatsapp-info').addEventListener('click',()=>{const d=$('faq-whatsapp');d.open=true;d.scrollIntoView({behavior:'smooth'});d.querySelector('summary').focus({preventScroll:true});});
 function updateStats(){$('stat-profiles').textContent=state.joined?'1':'0';$('stat-mutual').textContent=state.mutual?'1':'0';$('stat-optin').textContent=state.joined&&state.marketing?'1':'0';}
 function renderEvent(){
   const eligible=state.joined&&state.directory;
   $('match-empty').hidden=eligible;$('match-card').hidden=!eligible;
   $('event-status').hidden=!state.joined;
   $('event-status').textContent=state.directory?'Профиль подтверждён в демо. Подбор включён. Подписка на анонсы: '+(state.marketing?'включена отдельно.':'выключена.'):'Профиль подтверждён в демо. Подбор выключен по вашему выбору; анонсы '+(state.marketing?'включены.':'выключены.');
   $('join-event').textContent=state.joined?'Обновить выбор · демо':'Подтвердить профиль · демо';
   $('request-intro').hidden=state.requested;
   $('intro-status').hidden=!state.requested;
   $('intro-status').textContent=state.mutual?'В демо обе стороны согласились. Это не реальный обмен контактами.':'Запрос сохранён в демо. Вторая сторона ещё не ответила. Закрытые контакты не открыты.';
   $('accept-other').hidden=!state.requested||state.mutual;
   $('next-step').hidden=!state.mutual;$('revoke-intro').hidden=!state.requested;
   updateStats();
 }
 $('join-event').addEventListener('click',()=>{
   state.joined=true;state.directory=$('event-consent').checked;state.marketing=$('marketing-consent').checked;
   if(!state.directory){state.requested=false;state.mutual=false;$('next-step-status').hidden=true;}
   renderEvent();
 });
 $('request-intro').addEventListener('click',()=>{if(!state.joined||!state.directory)return;state.requested=true;renderEvent();});
 $('accept-other').addEventListener('click',()=>{if(!state.requested||!state.directory)return;state.mutual=true;renderEvent();});
 $('next-step').addEventListener('click',()=>{$('next-step-status').hidden=false;toast('Это локальный черновик. Ничего не отправлено в календарь или мессенджер.');});
 $('revoke-intro').addEventListener('click',()=>{state.requested=false;state.mutual=false;$('next-step-status').hidden=true;renderEvent();toast('Согласие отозвано в демонстрации.');});
 $('campaign-info').addEventListener('click',()=>toast(state.joined&&state.marketing?'В демо есть 1 отдельная подписка. Live-рассылки не подключены.':'В демо нет подписок на анонсы. Импорт или участие не дают согласие на маркетинг.'));
 $('reset-demo').addEventListener('click',()=>{Object.assign(state,{joined:false,directory:false,marketing:false,requested:false,mutual:false});['public-email','event-consent','marketing-consent'].forEach(id=>$(id).checked=false);$('profile-name').value='Анна Левина';$('profile-role').value='Продуктовый дизайнер';$('next-step-status').hidden=true;profile();renderEvent();selectTab('profile');toast('Демонстрация сброшена. Реальных данных не было.');});
 if(location.hash==='#profile')selectTab('profile',true);
 profile();renderEvent();
})();
