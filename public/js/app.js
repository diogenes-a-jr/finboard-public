import { APP } from './utils.js';
import { bootStorage } from './storage.js';
import { renderOverview, renderFinance, renderCreditCards, renderInvestments } from './render.js';
import { loadAll, saveSettings, validateHealth } from './api.js';
import { buildNav, setView } from './nav.js';
import './modals.js';

// ─── Events ──────────────────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click',saveSettings);
document.getElementById('validateBtn').addEventListener('click',validateHealth);
document.getElementById('refreshBtn').addEventListener('click',loadAll);
document.getElementById('logoutBtn')?.addEventListener('click',async()=>{
  await fetch('/api/auth/logout',{method:'POST'});
  location.href='/login.html';
});
document.getElementById('periodFilter').addEventListener('change',e=>{
  APP.filters.period=e.target.value;
  if(e.target.value!=='all'){ APP.filters.month='all'; const mf=document.getElementById('monthFilter'); if(mf) mf.value='all'; }
  renderOverview(); renderFinance(); renderCreditCards(); renderInvestments();
});
document.getElementById('institutionFilter').addEventListener('change',e=>{
  if(APP._populatingFilters) return;
  APP.filters.institution=e.target.value;
  renderOverview();renderFinance();renderCreditCards();renderInvestments();
});
document.getElementById('categoryFilter').addEventListener('change',e=>{APP.filters.category=e.target.value;renderOverview();renderFinance();renderCreditCards();renderInvestments();});
document.getElementById('monthFilter')?.addEventListener('change',e=>{
  APP.filters.month=e.target.value;
  if(e.target.value!=='all'){ APP.filters.period='all'; const pf=document.getElementById('periodFilter'); if(pf) pf.value='all'; }
  renderOverview(); renderFinance(); renderCreditCards(); renderInvestments();
});

// ─── Init ────────────────────────────────────────────────────────────────────
// Event delegation para catbar-clickrow (toggle do mini-grid de transações).
document.addEventListener('click', e => {
  const row = e.target.closest('.catbar-clickrow');
  if(!row) return;
  if(e.target.closest('select, button, a, input')) return;
  const wrap = row.closest('.catbar-wrap');
  if(!wrap) return;
  const mini = wrap.querySelector('.catbar-mini');
  const toggle = row.querySelector('.catbar-toggle');
  if(!mini) return;
  const open = mini.classList.toggle('open');
  if(toggle) toggle.classList.toggle('open', open);
});

document.addEventListener('click', e => {
  const row = e.target.closest('.cc-row');
  if(!row) return;
  if(e.target.closest('button, a, input, select, .cc-row-actions')) return;
  row.classList.toggle('open');
});

(()=>{
  const now=new Date();
  APP.filters.month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
})();
buildNav();setView('overview');
(async () => {
  await bootStorage();
  await loadAll();
})();
