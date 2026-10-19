/* Calendo Embed Widget - https://calendo.dev
 * data-url: booking page URL, data-mode: "inline"|"popup"
 * data-text: button text, data-color: brand color
 * data-width/data-height: iframe dimensions */
(function(){
'use strict';
var containers=document.querySelectorAll('[data-url][data-mode]');
if(!containers.length)return;
if(!document.getElementById('calendo-embed-styles')){
var s=document.createElement('style');s.id='calendo-embed-styles';
s.textContent='.calendo-embed-inline{width:100%;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}.calendo-embed-inline iframe{width:100%;border:none;display:block}.calendo-embed-popup-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;transition:opacity .15s,transform .15s}.calendo-embed-popup-btn:hover{opacity:.9;transform:translateY(-1px)}.calendo-embed-popup-btn svg{width:18px;height:18px;flex-shrink:0}.calendo-embed-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;animation:calendoFadeIn .2s ease-out}@keyframes calendoFadeIn{from{opacity:0}to{opacity:1}}.calendo-embed-modal{width:90vw;max-width:520px;height:85vh;max-height:750px;background:#fff;border-radius:16px;overflow:hidden;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:calendoScaleIn .2s ease-out}@keyframes calendoScaleIn{from{transform:scale(.95);opacity:0}to{transform:scale(1);opacity:1}}.calendo-embed-modal-close{position:absolute;top:12px;right:12px;z-index:1;background:rgba(0,0,0,.06);border:none;border-radius:50%;width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#64748b}.calendo-embed-modal-close:hover{background:rgba(0,0,0,.12)}.calendo-embed-modal iframe{width:100%;height:100%;border:none;display:block}';
document.head.appendChild(s);}
var icon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
function embedUrl(u){return u+(u.indexOf('?')<0?'?':'&')+'embed=1';}
function openPopup(url){
var ov=document.createElement('div');ov.className='calendo-embed-overlay';
var m=document.createElement('div');m.className='calendo-embed-modal';
var cb=document.createElement('button');cb.className='calendo-embed-modal-close';cb.innerHTML='&times;';cb.setAttribute('aria-label','Close');
var f=document.createElement('iframe');f.src=embedUrl(url);f.setAttribute('title','Calendo Booking');f.setAttribute('allow','payment');
m.appendChild(cb);m.appendChild(f);ov.appendChild(m);document.body.appendChild(ov);
function cl(){if(ov.parentNode)ov.parentNode.removeChild(ov);}
cb.addEventListener('click',cl);
ov.addEventListener('click',function(e){if(e.target===ov)cl();});
document.addEventListener('keydown',function h(e){if(e.key==='Escape'){cl();document.removeEventListener('keydown',h);}});}
window.addEventListener('message',function(e){
if(!e.data||e.data.type!=='calendo:booking-confirmed')return;
var ev;try{ev=new CustomEvent('calendo:booking-confirmed',{detail:e.data});}catch(x){ev=document.createEvent('CustomEvent');ev.initCustomEvent('calendo:booking-confirmed',true,true,e.data);}
window.dispatchEvent(ev);});
containers.forEach(function(c){
var url=c.getAttribute('data-url');if(!url)return;
var mode=c.getAttribute('data-mode')||'inline';
var text=c.getAttribute('data-text')||'Schedule a meeting';
var color=c.getAttribute('data-color')||'#2563eb';
var w=c.getAttribute('data-width')||'100%';
var h=c.getAttribute('data-height')||'700px';
if(mode==='inline'){
var wr=document.createElement('div');wr.className='calendo-embed-inline';wr.style.width=w;
var f=document.createElement('iframe');f.src=embedUrl(url);f.style.height=h;f.style.width=w;f.setAttribute('title','Calendo Booking');f.setAttribute('allow','payment');
wr.appendChild(f);c.appendChild(wr);
}else if(mode==='popup'){
var b=document.createElement('button');b.className='calendo-embed-popup-btn';b.style.background=color;
b.innerHTML=icon+' '+text;b.addEventListener('click',function(){openPopup(url);});c.appendChild(b);}});
window.Calendo={open:function(url){if(url)openPopup(url);}};
})();
