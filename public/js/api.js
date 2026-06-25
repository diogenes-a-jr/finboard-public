import { APP, NAV, esc, escAttr, fmtBRL, fmtShort, fmtDate, monthKey, monthLabel, accountLabel, isCardAccount, txCategoryName, getItemName, _allUniqueCatsCache, allUniqueCats, _invalidateCatsCache, translateCat, PALETTE, catColor } from './utils.js';
import { STORAGE_KEYS, ALL_STORAGE_KEYS, NAMES_KEY, GROUPS_KEY, CAT_NAMES_KEY, MANUAL_CARDS_KEY, MANUAL_CARD_TXS_KEY, EXCL_CATS_KEY, INV_CATS_KEY, MANUAL_INVS_KEY, STORAGE_CACHE, STORAGE_PENDING, STORAGE_STATE, storageDefault, storageGet, storageSet, _storagePushKey, bootStorage, storageResyncAll, updateStorageBanner, getRules, saveRules, getManual, saveManual, getCustomNames, saveCustomNames, getCatGroups, saveCatGroups, getManualCards, saveManualCards, getManualCardTxs, saveManualCardTxs, getExclCats, saveExclCats, getCatNames, saveCatNames, getInvCats, saveInvCats, getManualInvs, saveManualInvs, exportAllStorage, importAllStorage, applyCatGroups } from './storage.js';
import { ruleBasedCategory, normalizeData, INVEST_CAT_PATTERNS, TRANSFER_CAT_PATTERNS, INVEST_ACCOUNT_TYPES, isInvestTx, filteredTransactions, filteredFinTransactions, filteredTransactionsAllMonths, populateFilters, monthlyCashflow, monthlyInvested, isCreditCardPayment, monthlyCardInvoices, topCategories } from './normalize.js';
import { svgCashflow, svgArea, svgBar, empty, kpi, chip, badge2, txTable, accFlowChart, ccEvolutionChart } from './charts.js';
import { renderOverview, renderFinance, renderCreditCards, renderInvestments, bindInvManualListeners, loadPluggyCategoryCatalog, flattenPluggyCategories, renderEditar, renderConnections, renderAdmin } from './render.js';
import { setView } from './nav.js';

// ─── API ─────────────────────────────────────────────────────────────────────
async function fetchJson(url,opts){
  try{const res=await fetch(url,opts);const text=await res.text();const json=text?JSON.parse(text):{};return{ok:res.ok,status:res.status,json}}
  catch(e){return{ok:false,status:0,json:{message:e.message}}}
}
async function loadSettings(){const r=await fetchJson('/api/admin/settings');if(r.ok)APP.raw.settings=r.json.settings}

async function validateHealth(){
  const badge=document.getElementById('healthBadge');
  const box=document.getElementById('globalMessage');
  if(!badge) return;
  badge.innerHTML='<span class="dot dot-warn"></span><span>Validando...</span>';
  const r=await fetchJson('/api/health');
  APP.raw.health=r.json;
  if(r.ok&&r.json.ok){
    badge.innerHTML='<span class="dot dot-ok"></span><span>Conectado</span>';
    if(box) box.innerHTML='';
  } else {
    badge.innerHTML=`<span class="dot dot-err"></span><span>${esc(r.json.message||'Falha')}</span>`;
    if(box) box.innerHTML=`<div class="warning warning-err mb20">${esc(r.json.message||'Falha ao validar a API')}</div>`;
  }
}

async function loadAll(){
  await loadSettings();
  renderAdmin();
  await validateHealth();

  // Busca dados com suporte a paginação de transações
  // O backend /api/full-sync pode retornar hasMore:true e nextPage indicando que há mais páginas
  const r=await fetchJson('/api/full-sync');
  if(!r.ok){
    document.getElementById('overview').innerHTML=`<div class="card"><div class="warning warning-err">Falha ao carregar dados: ${esc(r.json.message||'Erro')}</div></div>`;
    renderConnections();renderInvestments();renderCreditCards();renderEditar();setView(APP.view);return;
  }

  const baseData=r.json;

  // Paginação: se o backend indicar hasMore ou nextPage, busca páginas adicionais
  // e acumula as transações dentro de cada conta — com dedupe por tx.id e proteção
  // contra cursor repetido (loop infinito do backend).
  if(baseData.hasMore || baseData.nextPage){
    let page=2;
    let more=true;
    const maxPages=20; // segurança: no máximo 20 páginas extras (~2000 transações extras)
    const seenCursors=new Set();
    if(baseData.nextPage) seenCursors.add(baseData.nextPage);
    // Indexar IDs já vistos por conta para dedupe O(1)
    const seenTxByAcc=new Map();
    (baseData.accounts||[]).forEach(acc=>{
      const set=new Set();
      (acc.transactions||[]).forEach(tx=>{ if(tx.id) set.add(tx.id); });
      seenTxByAcc.set(acc.id,set);
    });
    while(more && page<=maxPages+1){
      const pageUrl=baseData.nextPage?`/api/full-sync?cursor=${encodeURIComponent(baseData.nextPage)}`:`/api/full-sync?page=${page}`;
      const pr=await fetchJson(pageUrl);
      if(!pr.ok) break;
      // Mesclar transações da página extra nas contas existentes (com dedupe)
      if(pr.json.accounts){
        pr.json.accounts.forEach(pacc=>{
          const existing=(baseData.accounts||[]).find(a=>a.id===pacc.id);
          if(existing && pacc.transactions && pacc.transactions.length){
            let seen=seenTxByAcc.get(existing.id);
            if(!seen){ seen=new Set(); seenTxByAcc.set(existing.id,seen); }
            const novas=pacc.transactions.filter(tx=>{
              if(tx.id && seen.has(tx.id)) return false;
              if(tx.id) seen.add(tx.id);
              return true;
            });
            existing.transactions=[...(existing.transactions||[]),...novas];
          }
        });
      }
      more=pr.json.hasMore||!!pr.json.nextPage;
      // Detectar cursor repetido (loop infinito do backend)
      if(pr.json.nextPage){
        if(seenCursors.has(pr.json.nextPage)){
          console.warn('Paginação interrompida: cursor repetido detectado.');
          break;
        }
        seenCursors.add(pr.json.nextPage);
        baseData.nextPage=pr.json.nextPage;
      }
      page++;
    }
    if(more && page>maxPages+1){
      console.warn(`Paginação atingiu o limite de ${maxPages} páginas — transações além desse ponto não foram carregadas.`);
    }
  }

  APP.raw={...APP.raw,...baseData};
  normalizeData();populateFilters();
  renderOverview();renderFinance();renderInvestments();renderCreditCards();renderEditar();renderConnections();renderAdmin();
  setView(APP.view);
}

async function saveSettings(){
  const payload={
    clientId:document.getElementById('clientId')?.value||'',
    clientSecret:document.getElementById('clientSecret')?.value||'',
    clientUserId:document.getElementById('clientUserId')?.value||'',
    webhookUrl:document.getElementById('webhookUrl')?.value||'',
    itemIds:(document.getElementById('itemIds')?.value||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean)
  };
  const r=await fetchJson('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) return alert(r.json.message||'Falha ao salvar');
  await loadAll(); alert('Configurações salvas.');
}

async function generateConnectToken(){
  const box=document.getElementById('tokenBox');
  box.textContent='Gerando token...';
  const r=await fetchJson('/api/connect-token');
  if(!r.ok){box.textContent=`Erro: ${r.json.message||'falha'}`;return}
  box.textContent=r.json.connectToken||r.json.accessToken||r.json.token||JSON.stringify(r.json);
}

function getConnectAccessToken(payload){
  return payload?.accessToken || payload?.connectToken || payload?.token;
}

function extractConnectedItemId(itemData){
  return itemData?.item?.id || itemData?.itemId || itemData?.id || itemData?.data?.itemId || itemData?.data?.item?.id || null;
}

async function persistConnectedItem(itemData){
  const itemId = extractConnectedItemId(itemData);
  if(!itemId) return false;
  const current = APP.raw.settings || {};
  const itemIds = [...new Set([...(current.itemIds||[]), itemId])];
  const payload = {
    clientUserId: current.clientUserId || '',
    webhookUrl: current.webhookUrl || '',
    itemIds
  };
  const r = await fetchJson('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error(r.json.message || 'Falha ao salvar item conectado');
  APP.raw.settings = r.json.settings;
  return true;
}

async function openPluggyConnect(){
  const box=document.getElementById('tokenBox');
  if(box) box.textContent='Abrindo Pluggy Connect...';
  const r=await fetchJson('/api/connect-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  if(!r.ok){
    if(box) box.textContent=`Erro: ${r.json.message||'falha ao gerar token'}`;
    return;
  }
  const connectToken=getConnectAccessToken(r.json);
  if(!connectToken){
    if(box) box.textContent='Token retornado pela Pluggy nao contem accessToken.';
    return;
  }

  try{
    const [{ default: React }, { createRoot }, connectModule] = await Promise.all([
      import('https://esm.sh/react@18.3.1'),
      import('https://esm.sh/react-dom@18.3.1/client'),
      import('https://esm.sh/react-pluggy-connect?external=react,react-dom')
    ]);
    const PluggyConnect = connectModule.PluggyConnect || connectModule.default;
    if(!PluggyConnect) throw new Error('Componente PluggyConnect nao encontrado');

    const host=document.createElement('div');
    host.id='pluggyConnectHost';
    document.body.appendChild(host);
    let root;
    const close=()=>{ try{ root?.unmount(); }catch{} host.remove(); };
    root=createRoot(host);
    root.render(React.createElement(PluggyConnect,{
      connectToken,
      includeSandbox:true,
      onSuccess:async (itemData)=>{
        try{
          await persistConnectedItem(itemData);
          if(box) box.textContent='Conta conectada. Sincronizando dados...';
          close();
          await loadAll();
        }catch(e){
          if(box) box.textContent=`Conectou, mas falhou ao salvar item: ${e.message}`;
        }
      },
      onError:(error)=>{
        if(box) box.textContent=`Falha na conexao: ${error?.message||error||'erro desconhecido'}`;
        close();
      },
      onClose:close
    }));
  }catch(error){
    if(box) box.textContent=`Widget indisponivel. Use este connect token manualmente: ${connectToken}`;
  }
}

export { fetchJson, loadSettings, validateHealth, loadAll, saveSettings, generateConnectToken, openPluggyConnect };
