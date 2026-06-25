import { APP, NAV, esc, escAttr, fmtBRL, fmtShort, fmtDate, monthKey, monthLabel, accountLabel, isCardAccount, txCategoryName, getItemName, _allUniqueCatsCache, allUniqueCats, _invalidateCatsCache, translateCat, PALETTE, catColor } from './utils.js';
import { STORAGE_KEYS, ALL_STORAGE_KEYS, NAMES_KEY, GROUPS_KEY, CAT_NAMES_KEY, MANUAL_CARDS_KEY, MANUAL_CARD_TXS_KEY, EXCL_CATS_KEY, INV_CATS_KEY, MANUAL_INVS_KEY, STORAGE_CACHE, STORAGE_PENDING, STORAGE_STATE, storageDefault, storageGet, storageSet, _storagePushKey, bootStorage, storageResyncAll, updateStorageBanner, getRules, saveRules, getManual, saveManual, getCustomNames, saveCustomNames, getCatGroups, saveCatGroups, getManualCards, saveManualCards, getManualCardTxs, saveManualCardTxs, getExclCats, saveExclCats, getCatNames, saveCatNames, getInvCats, saveInvCats, getManualInvs, saveManualInvs, exportAllStorage, importAllStorage, applyCatGroups } from './storage.js';
import { ruleBasedCategory, normalizeData, INVEST_CAT_PATTERNS, TRANSFER_CAT_PATTERNS, INVEST_ACCOUNT_TYPES, isInvestTx, filteredTransactions, filteredFinTransactions, filteredTransactionsAllMonths, populateFilters, monthlyCashflow, monthlyInvested, isCreditCardPayment, monthlyCardInvoices, topCategories } from './normalize.js';
import { svgCashflow, svgArea, svgBar, empty, kpi, chip, badge2, txTable, accFlowChart, ccEvolutionChart } from './charts.js';
import { fetchJson, loadSettings, validateHealth, loadAll, saveSettings, generateConnectToken, openPluggyConnect } from './api.js';
import { openModal, closeModal } from './modals.js';

// Substitui handler anterior em vez de empilhar. Evita save N× quando o
// botão pertence a um modal (que sobrevive ao innerHTML da view) e
// bindInvManualListeners é chamado a cada render.
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el._clickHandler) el.removeEventListener('click', el._clickHandler);
  el._clickHandler = handler;
  el.addEventListener('click', handler);
}

// Valor de um investimento num determinado mês:
// 1) snapshot exato do mês, OU
// 2) último snapshot <= mês (forward-fill),
// 3) fallback: currentValue (usado quando não há snapshots — ex.: Pluggy puro).
function invValueAt(inv, month) {
  if (!month || month === 'all') return Number(inv.currentValue || 0);
  const snaps = inv.snapshots || {};
  if (snaps[month] != null) return Number(snaps[month] || 0);
  const prior = Object.keys(snaps).filter(k => k <= month).sort();
  if (prior.length) return Number(snaps[prior[prior.length - 1]] || 0);
  return Number(inv.currentValue || 0);
}


// ─── Render: Overview ────────────────────────────────────────────────────────
function renderOverview(){
  const txs=filteredTransactions();
  const overviewTxs=txs.filter(tx=>!tx.isCard&&!isInvestTx(tx));
  const expenseBase=overviewTxs.filter(t=>t.direction==='expense');
  const incomeBase=overviewTxs.filter(t=>t.direction==='income');
  const recMo =incomeBase.reduce((s,t)=>s+t.amountAbs,0);
  const expMo =expenseBase.reduce((s,t)=>s+t.amountAbs,0);
  const netMo = recMo - expMo;
  const totalBal=APP.data.accounts.reduce((s,a)=>s+Number(a.balance??a.bankData?.balance??0),0);
  const totalInv=APP.data.investments.reduce((s,i)=>s+i.currentValue,0);
  const totalPat=totalBal+totalInv;
  const cats=topCategories(expenseBase);
  const incCats=(()=>{const g={};incomeBase.forEach(t=>{const c=t.categoryFinal||'Sem categoria';g[c]=(g[c]||0)+t.amountAbs});return Object.entries(g).sort((a,b)=>b[1]-a[1]).slice(0,8);})();

  // Período label
  const periodLabel = APP.filters.month!=='all'
    ? monthLabel(APP.filters.month)
    : APP.filters.period!=='all'
      ? `Últimos ${APP.filters.period} dias`
      : 'Mês atual';

  // Para cada conta: movimentação no período e série mensal (para o expand)
  const accMap={};
  filteredTransactions().forEach(tx=>{
    if(tx.isCard) return;
    if(!accMap[tx.accountId]) accMap[tx.accountId]={in:0,out:0,txs:[]};
    if(tx.direction==='income') accMap[tx.accountId].in+=tx.amountAbs;
    else accMap[tx.accountId].out+=tx.amountAbs;
    accMap[tx.accountId].txs.push(tx);
  });
  // Série mensal por conta (últimos 12 meses, todas as txs não-cartão)
  const accSeries={};
  APP.data.accounts.forEach(a=>{
    const all=APP.data.transactions.filter(t=>t.accountId===a.id && !t.isCard);
    const mp={};
    all.forEach(t=>{
      const k=monthKey(t.date); if(!k) return;
      if(!mp[k]) mp[k]={month:k,label:monthLabel(k),inflow:0,outflow:0,net:0};
      if(t.direction==='income') mp[k].inflow+=t.amountAbs;
      else mp[k].outflow+=t.amountAbs;
      mp[k].net=mp[k].inflow-mp[k].outflow;
    });
    accSeries[a.id]=Object.values(mp).sort((x,y)=>x.month.localeCompare(y.month)).slice(-12);
  });

  // Para investimentos manuais: série de snapshots
  const invSnapSeries={};
  APP.data.investments.forEach(i=>{
    if(!i._manual || !i.snapshots) return;
    const months=Object.keys(i.snapshots).sort().slice(-12);
    invSnapSeries[i.invId||i.id]=months.map(m=>({month:m,label:monthLabel(m),value:Number(i.snapshots[m]||0)}));
  });

  document.getElementById('overview').innerHTML=`
<!-- ============ HEADER ============ -->
<div class="cc-hdr">
  <div>
    <div class="cc-hdr-title">🏠 Visão Geral</div>
    <div class="cc-hdr-sub">${periodLabel} · ${APP.data.accounts.length} conta(s) · ${APP.data.investments.length} investimento(s)</div>
  </div>
</div>

<!-- ============ SUMMARY ROW DESTACADA (4 blocos) ============ -->
<div class="cc-summary ov-summary">
  <div class="cc-sum-block ov-sum-hero">
    <div class="cc-sum-label">Patrimônio total</div>
    <div class="cc-sum-value c-b ov-hero-value">${fmtBRL(totalPat)}</div>
    <div class="cc-sum-meta">contas + investimentos</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Saldo em conta</div>
    <div class="cc-sum-value c-i">${fmtBRL(totalBal)}</div>
    <div class="cc-sum-meta">${APP.data.accounts.length} conta(s) corrente</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Total investido</div>
    <div class="cc-sum-value" style="color:var(--invest)">${fmtBRL(totalInv)}</div>
    <div class="cc-sum-meta">${APP.data.investments.length} posição(ões)</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Líquido · ${periodLabel}</div>
    <div class="cc-sum-value ${netMo>=0?'c-i':'c-e'}">${netMo>=0?'+':'−'}${fmtBRL(Math.abs(netMo))}</div>
    <div class="cc-sum-meta">${fmtBRL(recMo)} − ${fmtBRL(expMo)}</div>
  </div>
</div>

<!-- ============ COMPOSIÇÃO RECEBIDO / GASTO (lado a lado) ============ -->
<div class="ov-comp-grid">
  <!-- Recebido -->
  <div class="card">
    <div class="ov-comp-head ov-comp-head-in">
      <div>
        <div class="ov-comp-title">↓ Recebido</div>
        <div class="ov-comp-sub">${incCats.length} categoria(s) · ${incomeBase.length} entrada(s)</div>
      </div>
      <div class="ov-comp-total c-i">${fmtBRL(recMo)}</div>
    </div>
    <div class="ov-comp-body">
      ${incCats.length?incCats.map(([n,v])=>{
        const co=catColor(n);
        const pct=recMo>0?(v/recMo)*100:0;
        const miniTxs=filteredTransactions().filter(t=>t.direction==='income'&&(t.categoryFinal||'Sem categoria')===n&&!t.isCard&&!isInvestTx(t));
        const miniRows=miniTxs.map(tx=>`
          <tr>
            <td style="width:80px"><span class="num c-d" style="font-size:11px">${fmtDate(tx.date)}</span></td>
            <td><div class="txdesc">${esc(tx.description||'Transação')}</div><div class="txmeta">${esc(tx.accountName||'')}</div></td>
            <td style="width:110px">
              <div class="fin-cat-wrap" style="position:relative;display:inline-block">
                ${chip(tx.categoryFinal||'Sem categoria')}
                <select class="ov-cat-sel" data-txid="${tx.id}" aria-label="Alterar categoria da transação">
                  ${allUniqueCats().map(c=>`<option value="${esc(c)}" ${c===tx.categoryFinal?'selected':''}>${esc(getCatNames()[c]||c)}</option>`).join('')}
                </select>
              </div>
            </td>
            <td style="text-align:right"><span class="num c-i" style="font-size:12px;font-weight:500">+${fmtBRL(tx.amountAbs)}</span></td>
          </tr>`).join('');
        return`
        <div class="catbar-wrap" data-cat="${esc(n)}">
          <div class="catbar-clickrow">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              ${chip(n)}
              <div style="flex:1;min-width:40px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin:0 8px">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${co};border-radius:3px;transition:width .4s"></div>
              </div>
              <span style="font-size:10px;color:var(--muted);flex-shrink:0;min-width:30px;text-align:right">${pct.toFixed(0)}%</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:10px">
              <span class="num c-i" style="font-size:11px">${fmtBRL(v)}</span>
              <span class="catbar-toggle">▼</span>
            </div>
          </div>
          <div class="catbar-mini">
            ${miniRows?`<div style="max-height:220px;overflow-y:auto"><table style="width:100%">${miniRows}</table></div><div class="catbar-mini-footer">${miniTxs.length} lançamento${miniTxs.length!==1?'s':''} · clique no chip para corrigir a categoria</div>`:'<div style="padding:8px 6px;font-size:11px;color:var(--muted)">Nenhum lançamento encontrado.</div>'}
          </div>
        </div>`}).join(''):empty('Sem entradas no período.')}
    </div>
  </div>

  <!-- Gasto -->
  <div class="card">
    <div class="ov-comp-head ov-comp-head-out">
      <div>
        <div class="ov-comp-title">↑ Gasto</div>
        <div class="ov-comp-sub">${cats.length} categoria(s) · ${expenseBase.length} saída(s)</div>
      </div>
      <div class="ov-comp-total c-e">${fmtBRL(expMo)}</div>
    </div>
    <div class="ov-comp-body">
      ${cats.length?cats.map(([n,v])=>{
        const co=catColor(n);
        const pct=expMo>0?(v/expMo)*100:0;
        const miniTxs=filteredTransactions().filter(t=>t.direction==='expense'&&(t.categoryFinal||'Sem categoria')===n);
        const miniRows=miniTxs.map(tx=>`
          <tr>
            <td style="width:80px"><span class="num c-d" style="font-size:11px">${fmtDate(tx.date)}</span></td>
            <td><div class="txdesc">${esc(tx.description||'Transação')}</div><div class="txmeta">${esc(tx.accountName||'')}</div></td>
            <td style="width:110px">
              <div class="fin-cat-wrap" style="position:relative;display:inline-block">
                ${chip(tx.categoryFinal||'Sem categoria')}
                <select class="ov-cat-sel" data-txid="${tx.id}" aria-label="Alterar categoria da transação">
                  ${allUniqueCats().map(c=>`<option value="${esc(c)}" ${c===tx.categoryFinal?'selected':''}>${esc(getCatNames()[c]||c)}</option>`).join('')}
                </select>
              </div>
            </td>
            <td style="text-align:right"><span class="num c-e" style="font-size:12px;font-weight:500">-${fmtBRL(tx.amountAbs)}</span></td>
          </tr>`).join('');
        return`
        <div class="catbar-wrap" data-cat="${esc(n)}">
          <div class="catbar-clickrow">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              ${chip(n)}
              <div style="flex:1;min-width:40px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin:0 8px">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${co};border-radius:3px;transition:width .4s"></div>
              </div>
              <span style="font-size:10px;color:var(--muted);flex-shrink:0;min-width:30px;text-align:right">${pct.toFixed(0)}%</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:10px">
              <span class="num c-d" style="font-size:11px">${fmtBRL(v)}</span>
              <span class="catbar-toggle">▼</span>
            </div>
          </div>
          <div class="catbar-mini">
            ${miniRows?`<div style="max-height:220px;overflow-y:auto"><table style="width:100%">${miniRows}</table></div><div class="catbar-mini-footer">${miniTxs.length} lançamento${miniTxs.length!==1?'s':''} · clique no chip para corrigir a categoria</div>`:'<div style="padding:8px 6px;font-size:11px;color:var(--muted)">Nenhum lançamento encontrado.</div>'}
          </div>
        </div>`}).join(''):empty('Sem dados de categorias.')}
    </div>
  </div>
</div>

<!-- ============ COMPOSIÇÃO PATRIMONIAL (Contas | Investimentos) ============ -->
<div class="cc-hdr" style="margin-top:24px;margin-bottom:14px">
  <div>
    <div style="font-size:15px;font-weight:700;color:var(--text)">Composição patrimonial</div>
    <div style="font-size:12px;color:var(--muted);margin-top:2px">${APP.data.accounts.length} conta(s) corrente e ${APP.data.investments.length} investimento(s)</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Patrimônio total</div>
    <div class="num c-b" style="font-size:18px;font-weight:700">${fmtBRL(totalPat)}</div>
  </div>
</div>

<div class="ov-pat-grid">
  <!-- Coluna esquerda: Contas (saldo apenas) -->
  <div class="card">
    <div class="ov-pat-head ov-pat-head-acc">
      <div>
        <div class="ov-pat-title">🏦 Contas correntes</div>
        <div class="ov-pat-sub">${APP.data.accounts.length} conta(s)</div>
      </div>
      <div class="ov-pat-total c-i">${fmtBRL(totalBal)}</div>
    </div>
    <div class="ov-pat-body">
      ${APP.data.accounts.length ? APP.data.accounts.map(a=>{
        const bal=Number(a.balance??a.bankData?.balance??0);
        const bank=a._manualBank||getItemName(a.itemId)||'-';
        const pctPat=totalPat>0?(bal/totalPat*100):0;
        return `<div class="ov-pat-row">
          <div class="ov-pat-row-id">
            <div class="ov-pat-row-name">${esc(accountLabel(a))}</div>
            <div class="ov-pat-row-meta">
              <span>${esc((a.type||'-').toUpperCase())}</span>
              <span class="ov-pat-dot"></span>
              <span>${esc(bank)}</span>
              <span class="ov-pat-dot"></span>
              <span>${pctPat.toFixed(1)}% do patrimônio</span>
            </div>
          </div>
          <div class="ov-pat-row-val">
            <div class="num c-i" style="font-size:15px;font-weight:600">${fmtBRL(bal)}</div>
          </div>
        </div>`;
      }).join('') : '<div class="empty">Nenhuma conta corrente.</div>'}
    </div>
  </div>

  <!-- Coluna direita: Investimentos -->
  <div class="card">
    <div class="ov-pat-head ov-pat-head-inv">
      <div>
        <div class="ov-pat-title">📊 Investimentos</div>
        <div class="ov-pat-sub">${APP.data.investments.length} posição(ões)</div>
      </div>
      <div class="ov-pat-total" style="color:var(--invest)">${fmtBRL(totalInv)}</div>
    </div>
    <div class="ov-pat-body">
      ${APP.data.investments.length ? APP.data.investments.map(i=>{
        const val=Number(i.currentValue||0);
        const isManual=!!i._manual;
        const bank=isManual?'Manual':(getItemName(i.itemId)||'-');
        const cat=i.categoryEditable||i.type||'Outros';
        const co=catColor(cat);
        const pctPat=totalPat>0?(val/totalPat*100):0;
        return `<div class="ov-pat-row">
          <div class="ov-pat-row-id">
            <div class="ov-pat-row-name">${isManual?'✦ ':''}${esc(i.displayName||i.name||'Investimento')}</div>
            <div class="ov-pat-row-meta">
              <span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33;font-size:10px;padding:1px 7px">${esc(cat)}</span>
              <span class="ov-pat-dot"></span>
              <span>${esc(bank)}</span>
              <span class="ov-pat-dot"></span>
              <span>${pctPat.toFixed(1)}% do patrimônio</span>
            </div>
          </div>
          <div class="ov-pat-row-val">
            <div class="num" style="font-size:15px;font-weight:600;color:var(--invest)">${fmtBRL(val)}</div>
          </div>
        </div>`;
      }).join('') : '<div class="empty">Nenhum investimento.</div>'}
    </div>
  </div>
</div>
`;

  // Inline category change nos mini-grids de Top Categorias
  document.querySelectorAll('#overview .ov-cat-sel').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const manual=getManual();
      const v=sel.value;
      if(v) manual[sel.dataset.txid]=v; else delete manual[sel.dataset.txid];
      saveManual(manual); normalizeData(); populateFilters();
      renderOverview(); renderFinance();
    });
  });
}

// ─── Render: Finance ─────────────────────────────────────────────────────────
function renderFinance(){
  const accounts = APP.data.accounts; // somente contas correntes
  // KPIs: somente contas correntes, sem invest/transfer (comportamento original)
  const txs=filteredFinTransactions().filter(tx=>{
    if(tx.isCard) return false;
    const t=String(tx.accountType||'').toLowerCase();
    if(t.includes('credit')||t.includes('card')) return false;
    return true;
  });

  // Lançamentos detalhados: todas as transações não-cartão, respeitando filtros
  const f=APP.filters, ff=APP.fin, now=new Date();
  const allNonCardTxs=APP.data.transactions.filter(tx=>{
    if(tx.isCard) return false;
    if(f.institution!=='all'&&tx.accountId!==f.institution) return false;
    if(f.category!=='all'&&tx.categoryFinal!==f.category) return false;
    if(f.period!=='all'){const diff=(now-new Date(tx.date))/(864e5);if(diff>Number(f.period)) return false;}
    if(f.month!=='all'&&monthKey(tx.date)!==f.month) return false;
    if(ff.direction!=='all'&&tx.direction!==ff.direction) return false;
    if(ff.search){const low=ff.search.toLowerCase();if(!String(tx.description||'').toLowerCase().includes(low)) return false;}
    return true;
  });

  // Movimentação por conta no período filtrado (entradas/saídas)
  const accMap={};
  filteredTransactions().forEach(tx=>{
    if(tx.isCard) return;
    if(!accMap[tx.accountId]) accMap[tx.accountId]={in:0,out:0,txs:[]};
    if(tx.direction==='income') accMap[tx.accountId].in+=tx.amountAbs;
    else accMap[tx.accountId].out+=tx.amountAbs;
    accMap[tx.accountId].txs.push(tx);
  });

  // Série mensal por conta para o expand (entradas/saídas mês a mês)
  // Considera todas as transações da conta (não filtradas), últimos 12 meses.
  const accSeries={};
  accounts.forEach(a=>{
    const allTxs=APP.data.transactions.filter(t=>t.accountId===a.id && !t.isCard);
    const monthMap={};
    allTxs.forEach(t=>{
      const k=monthKey(t.date); if(!k) return;
      if(!monthMap[k]) monthMap[k]={month:k,label:monthLabel(k),inflow:0,outflow:0,net:0};
      if(t.direction==='income') monthMap[k].inflow+=t.amountAbs;
      else monthMap[k].outflow+=t.amountAbs;
      monthMap[k].net=monthMap[k].inflow-monthMap[k].outflow;
    });
    accSeries[a.id]=Object.values(monthMap).sort((x,y)=>x.month.localeCompare(y.month)).slice(-12);
  });

  // Top categorias por conta (gastos no período filtrado)
  const accTopCats={};
  accounts.forEach(a=>{
    const map={};
    (accMap[a.id]?.txs||[]).forEach(tx=>{
      if(tx.direction!=='expense') return;
      const cat=tx.categoryFinal||'Sem categoria';
      map[cat]=(map[cat]||0)+tx.amountAbs;
    });
    accTopCats[a.id]=Object.entries(map).sort((x,y)=>y[1]-x[1]).slice(0,5);
  });

  const totalIn=txs.filter(t=>t.direction==='income').reduce((s,t)=>s+t.amountAbs,0);
  const totalEx=txs.filter(t=>t.direction==='expense').reduce((s,t)=>s+t.amountAbs,0);
  const net=totalIn-totalEx;
  const totalBal=accounts.reduce((s,a)=>s+Number(a.balance??a.bankData?.balance??0),0);
  const kpiLabel=APP.filters.month!=='all'?monthLabel(APP.filters.month):APP.filters.period!=='all'?`Últimos ${APP.filters.period}d`:'Mês atual';

  // Série consolidada (todas as contas) para o gráfico no fim
  const allMonths=[...new Set(Object.values(accSeries).flatMap(s=>s.map(m=>m.month)))].sort();
  const unifiedAccSeries=allMonths.map(m=>{
    const acc=Object.values(accSeries).reduce((agg,arr)=>{
      const found=arr.find(x=>x.month===m);
      if(found){agg.inflow+=found.inflow;agg.outflow+=found.outflow;}
      return agg;
    },{inflow:0,outflow:0});
    return {month:m,label:monthLabel(m),inflow:acc.inflow,outflow:acc.outflow,net:acc.inflow-acc.outflow,total:acc.inflow-acc.outflow};
  });

  document.getElementById('finance').innerHTML=`
<!-- ============ HEADER ============ -->
<div class="cc-hdr">
  <div>
    <div class="cc-hdr-title">🏦 Contas</div>
    <div class="cc-hdr-sub">${accounts.length} conta(s) · ${kpiLabel}</div>
  </div>
</div>

<!-- ============ SUMMARY ROW DESTACADA ============ -->
<div class="cc-summary">
  <div class="cc-sum-block">
    <div class="cc-sum-label">Saldo total · contas correntes</div>
    <div class="cc-sum-value c-b">${fmtBRL(totalBal)}</div>
    <div class="cc-sum-meta">${accounts.length} conta(s) somada(s)</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Total recebido · ${kpiLabel}</div>
    <div class="cc-sum-value c-i">${fmtBRL(totalIn)}</div>
    <div class="cc-sum-meta">${txs.filter(t=>t.direction==='income').length} entrada(s)</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Total gasto · ${kpiLabel}</div>
    <div class="cc-sum-value c-e">${fmtBRL(totalEx)}</div>
    <div class="cc-sum-meta">${txs.filter(t=>t.direction==='expense').length} saída(s)</div>
  </div>
  <div class="cc-sum-block">
    <div class="cc-sum-label">Saldo líquido · período</div>
    <div class="cc-sum-value ${net>=0?'c-i':'c-e'}">${fmtBRL(net)}</div>
    <div class="cc-sum-meta">Entradas − saídas</div>
  </div>
</div>

<!-- ============ STACK DE CONTAS (uma linha rica por conta) ============ -->
<div class="cc-stack">
  ${(()=>{
    // Mostrar apenas contas com pelo menos um lançamento no período filtrado
    const visiveis = accounts.filter(a=>(accMap[a.id]?.txs?.length||0)>0);
    if(!visiveis.length){
      return `<div class="empty">Nenhuma conta com lançamentos no período filtrado.</div>`;
    }
    return visiveis.map(a=>{
      const bal=Number(a.balance??a.bankData?.balance??0);
      const m=accMap[a.id]||{in:0,out:0,txs:[]};
      const netAcc=m.in-m.out;
      const bank=a._manualBank||getItemName(a.itemId)||'-';
      const series=accSeries[a.id]||[];
      const topCats=accTopCats[a.id]||[];
      const catMax=topCats.length?topCats[0][1]:1;
      const last12=series.slice(-12);
      const maxAbs=Math.max(...last12.flatMap(s=>[s.inflow,s.outflow]),1);
      return `<div class="cc-row acc" data-accid="${esc(a.id)}">
        <!-- Coluna 1: identificação -->
        <div class="cc-row-id">
          <div class="cc-row-chip acc">🏦</div>
          <div style="min-width:0;flex:1">
            <div class="cc-row-name">${esc(accountLabel(a))}</div>
            <div class="cc-row-meta">
              <span class="cc-row-tag">${esc((a.type||'-').toUpperCase())}</span>
              ${a.subtype?`<span class="cc-row-tag">${esc(a.subtype.toUpperCase())}</span>`:''}
              <span class="cc-row-dot"></span>
              <span>${esc(bank)}</span>
            </div>
          </div>
        </div>

        <!-- Coluna 2: Saldo atual em destaque -->
        <div class="acc-balance">
          <div class="acc-balance-label">Saldo atual</div>
          <div class="acc-balance-value">${fmtBRL(bal)}</div>
          <div class="acc-balance-meta">${m.txs.length} lançamento(s) no filtro</div>
        </div>

        <!-- Coluna 3: trio Entradas / Saídas / Líquido -->
        <div class="acc-trio">
          <div class="acc-trio-item">
            <div class="acc-trio-label">↓ Entradas</div>
            <div class="acc-trio-val c-i">${fmtBRL(m.in)}</div>
          </div>
          <div class="acc-trio-item">
            <div class="acc-trio-label">↑ Saídas</div>
            <div class="acc-trio-val c-e">${fmtBRL(m.out)}</div>
          </div>
          <div class="acc-trio-item">
            <div class="acc-trio-label">Líquido</div>
            <div class="acc-trio-val ${netAcc>=0?'c-i':'c-e'}">${netAcc>=0?'+':'−'}${fmtBRL(Math.abs(netAcc))}</div>
          </div>
        </div>

        <div class="cc-row-toggle-side">clique para ${topCats.length||last12.length?'expandir ↓':'detalhes ↓'}</div>

        <!-- Detail expandido -->
        <div class="cc-row-detail">
          <div class="cc-detail-grid">
            <div>
              <div class="cc-section-label">Saldo líquido mensal · últimos 12 meses</div>
              ${last12.length?(()=>{
                // SVG bar chart de saldo líquido (positivo verde, negativo vermelho)
                const W=420, H=100, P={t:14,r:6,b:22,l:38};
                const cW=W-P.l-P.r, cH=H-P.t-P.b;
                const nets=last12.map(s=>s.net);
                const absMax=Math.max(...nets.map(Math.abs),1);
                const niceMax=(v=>{
                  const mag=Math.pow(10,Math.floor(Math.log10(v)));
                  const norm=v/mag;
                  let nm;
                  if(norm<=1) nm=1; else if(norm<=2) nm=2;
                  else if(norm<=2.5) nm=2.5; else if(norm<=5) nm=5; else nm=10;
                  return nm*mag;
                })(absMax*1.05);
                const slot=cW/last12.length;
                const bW=Math.min(slot*0.62,22);
                // Eixo Y centralizado em 0
                const zeroY=P.t+cH/2;
                const halfH=cH/2;
                const bars=last12.map((s,i)=>{
                  const x=P.l+i*slot+(slot-bW)/2;
                  const h=Math.abs(s.net)/niceMax*halfH;
                  const isPos=s.net>=0;
                  const y=isPos?(zeroY-h):zeroY;
                  const color=isPos?'#06f7b4':'#ff4d6d';
                  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bW.toFixed(1)}" height="${Math.max(h,.5).toFixed(1)}" fill="${color}" opacity=".85" rx="3"><title>${esc(s.label)}: ${s.net>=0?'+':'−'}${fmtBRL(Math.abs(s.net))}</title></rect>`;
                }).join('');
                const lbls=last12.map((s,i)=>{
                  const isLast=(i===last12.length-1);
                  return `<text x="${(P.l+i*slot+slot/2).toFixed(1)}" y="${(H-6).toFixed(1)}" text-anchor="middle" fill="${isLast?'var(--text)':'var(--muted)'}" font-size="9" font-family="Inter,sans-serif" font-weight="${isLast?'600':'400'}">${esc(s.label.slice(0,3))}</text>`;
                }).join('');
                // Linha zero + escalas
                return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;margin-top:6px">
                  <line x1="${P.l}" y1="${zeroY}" x2="${(P.l+cW).toFixed(1)}" y2="${zeroY}" stroke="var(--border2)" stroke-width="1"/>
                  <line x1="${P.l}" y1="${P.t}" x2="${(P.l+cW).toFixed(1)}" y2="${P.t}" stroke="var(--border)" stroke-width=".5" stroke-dasharray="2,3" opacity=".5"/>
                  <line x1="${P.l}" y1="${(P.t+cH).toFixed(1)}" x2="${(P.l+cW).toFixed(1)}" y2="${(P.t+cH).toFixed(1)}" stroke="var(--border)" stroke-width=".5" stroke-dasharray="2,3" opacity=".5"/>
                  <text x="${P.l-6}" y="${(P.t+3).toFixed(1)}" text-anchor="end" fill="var(--income)" font-size="9" font-family="JetBrains Mono,monospace" opacity=".8">+${fmtShort(niceMax)}</text>
                  <text x="${P.l-6}" y="${(zeroY+3).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="9" font-family="JetBrains Mono,monospace">0</text>
                  <text x="${P.l-6}" y="${(P.t+cH+3).toFixed(1)}" text-anchor="end" fill="var(--expense)" font-size="9" font-family="JetBrains Mono,monospace" opacity=".8">−${fmtShort(niceMax)}</text>
                  ${bars}
                  ${lbls}
                </svg>`;
              })():`<div class="cc-empty-mini">Sem histórico mensal.</div>`}
            </div>
            <div>
              <div class="cc-section-label">Top categorias de gastos · período filtrado</div>
              ${topCats.length?`<div class="cc-minicat">
                ${topCats.map(([n,v])=>{
                  const co=catColor(n);
                  const pct=(v/catMax*100);
                  return `<div class="cc-minicat-row">
                    <div class="cc-minicat-dot" style="background:${co}"></div>
                    <span class="cc-minicat-name">${esc(n)}</span>
                    <div class="cc-minicat-bar"><div class="cc-minicat-fill" style="width:${pct.toFixed(0)}%;background:${co}"></div></div>
                    <span class="cc-minicat-val">${fmtBRL(v)}</span>
                  </div>`;
                }).join('')}
              </div>`:`<div class="cc-empty-mini">Nenhum gasto categorizado nesta conta no período.</div>`}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  })()}
</div>

<!-- ============ GRÁFICO DE FLUXO CONSOLIDADO ============ -->
<div class="card mb20">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:6px">
    <div>
      <div class="ctitle">Fluxo mensal — todas as contas</div>
      <div class="csub" style="margin-bottom:0">Entradas, saídas e saldo líquido por mês</div>
    </div>
    ${(()=>{
      if(!unifiedAccSeries.length) return '';
      const totals=unifiedAccSeries.reduce((acc,s)=>{acc.in+=s.inflow;acc.out+=s.outflow;return acc;},{in:0,out:0});
      const netTot=totals.in-totals.out;
      return `<div style="display:flex;gap:18px;align-items:baseline">
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Período</div>
          <div class="num" style="font-size:14px;color:var(--dim)">${unifiedAccSeries.length} mês(es)</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Líquido acumulado</div>
          <div class="num" style="font-size:16px;font-weight:600;color:${netTot>=0?'var(--income)':'var(--expense)'}">${fmtBRL(netTot)}</div>
        </div>
      </div>`;
    })()}
  </div>
  ${accFlowChart(unifiedAccSeries)}
</div>

<!-- ============ LANÇAMENTOS DETALHADOS ============ -->
<div class="card mb20">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px">
    <div>
      <div class="ctitle">Lançamentos detalhados</div>
      <div class="csub" style="margin-bottom:0">${allNonCardTxs.length} transação(ões) · todas as contas correntes · período filtrado</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="finSearch" class="finput" placeholder="🔍 Buscar..." value="${esc(APP.fin.search)}" style="font-size:12px"/>
      <select id="finDir" class="fsel" style="font-size:12px">
        <option value="all" ${APP.fin.direction==='all'?'selected':''}>Todos os tipos</option>
        <option value="income" ${APP.fin.direction==='income'?'selected':''}>Entradas</option>
        <option value="expense" ${APP.fin.direction==='expense'?'selected':''}>Saídas</option>
      </select>
    </div>
  </div>
  ${txTable(allNonCardTxs)}
</div>
`;

  const _finSrch=document.getElementById('finSearch');
  if(_finSrch){
    let _finTimer=null;
    _finSrch.addEventListener('input',e=>{
      e.stopPropagation();
      clearTimeout(_finTimer);
      _finTimer=setTimeout(()=>{
        const low=_finSrch.value.toLowerCase().trim();
        const dir=document.getElementById('finDir')?.value||'all';
        const rows=document.querySelectorAll('#finance .txtable tbody tr');
        rows.forEach(row=>{
          const dirOk=dir==='all'||row.dataset.dir===dir;
          const srchOk=!low||row.dataset.txt.includes(low);
          row.style.display=dirOk&&srchOk?'':'none';
        });
      },120);
    });
  }
  document.querySelectorAll('#finance .txtable thead th[data-sort]').forEach(th=>{
    th.addEventListener('click',()=>{
      const col=th.dataset.sort;
      if(APP.fin.sort===col) APP.fin.sortDir=APP.fin.sortDir==='asc'?'desc':'asc';
      else{APP.fin.sort=col; APP.fin.sortDir='desc';}
      renderFinance();
    });
  });
  document.getElementById('finDir')?.addEventListener('change',e=>{
    APP.fin.direction=e.target.value;
    const dir=e.target.value;
    const low=(document.getElementById('finSearch')?.value||'').toLowerCase().trim();
    document.querySelectorAll('#finance .txtable tbody tr').forEach(row=>{
      const dirOk=dir==='all'||row.dataset.dir===dir;
      const srchOk=!low||row.dataset.txt.includes(low);
      row.style.display=dirOk&&srchOk?'':'none';
    });
  });

  // Inline category change in Lançamentos detalhados
  document.querySelectorAll('#finance .fin-cat-sel').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const manual=getManual();
      const v=sel.value;
      if(v) manual[sel.dataset.txid]=v; else delete manual[sel.dataset.txid];
      saveManual(manual); normalizeData(); populateFilters();
      renderOverview(); renderFinance();
    });
  });
}


// ─── Render: Credit Cards ────────────────────────────────────────────────────
function renderCreditCards(){
  // Garante que cartões manuais estejam presentes mesmo se normalizeData rodou antes de loadAll
  if(!APP.data.cards.length){
    const mc=getManualCards();
    if(mc.length){
      APP.data.cards=[...APP.data.cards,...mc];
    }
  }
  const cards=APP.data.cards;
  if(!cards.length){
    document.getElementById('creditcards').innerHTML=`<div class="card">${empty('Nenhum cartão de crédito encontrado.')}</div>`;
    return;
  }

  // Per-card invoice totals
  const exclCats=getExclCats().map(c=>c.toLowerCase());
  const cardData=cards.map(c=>{
    const series=monthlyCardInvoices(c).slice(-12); // full history for chart
    const txs=filteredTransactions().filter(t=>t.accountId===c.id&&!exclCats.includes((t.categoryFinal||'').toLowerCase())&&!isCreditCardPayment(t)); // filtered for table (income = estornos)
    const total=txs.reduce((s,t)=>s+t.amountAbs,0);
    // "Mês atual" = mês filtrado, ou o mais recente da série
    const currentMonthKey=APP.filters.month!=='all'
      ?APP.filters.month
      :(series.length?series[series.length-1].month:null);
    const last=currentMonthKey?(series.find(s=>s.month===currentMonthKey)?.total||0):(series.length?series[series.length-1].total:0);
    // "Mês anterior" = mês imediatamente antes do mês atual
    let prev=null;
    if(currentMonthKey){
      const [y,mo]=currentMonthKey.split('-').map(Number);
      const prevDate=new Date(y,mo-2,1);
      const prevKey=`${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}`;
      const prevEntry=series.find(s=>s.month===prevKey);
      prev=prevEntry?prevEntry.total:null;
    }
    const delta=prev!==null&&prev>0?((last-prev)/prev*100).toFixed(1):null;
    return{c,series,txs,total,last,prev,delta};
  });

  // Unified chart: all cards combined by month
  const allMonths=[...new Set(cardData.flatMap(d=>d.series.map(s=>s.month)))].sort();
  const unifiedSeries=allMonths.map(m=>({
    month:m,label:monthLabel(m),
    ...Object.fromEntries(cardData.map(({c,series})=>{
      const found=series.find(s=>s.month===m);
      return[accountLabel(c),found?found.total:0];
    })),
    total:cardData.reduce((s,{series})=>{const f=series.find(x=>x.month===m);return s+(f?f.total:0);},0)
  }));

  // ── allCardTxs computed once — used by both composition and transactions table
  const allCardTxs=cardData.flatMap(({c,txs})=>txs.map(t=>({...t,_cardName:accountLabel(c)})));
  allCardTxs.sort((a,b)=>new Date(b.date)-new Date(a.date));

  document.getElementById('creditcards').innerHTML=`
<!-- ============ HEADER ============ -->
<div class="cc-hdr">
  <div>
    <div class="cc-hdr-title">💳 Cartões de crédito</div>
    <div class="cc-hdr-sub">${cards.length} cartão(ões) cadastrado(s)</div>
  </div>
  <button id="btnNewCard" class="btn primary" style="font-size:13px;padding:10px 18px;display:flex;align-items:center;gap:6px">＋ Novo cartão</button>
</div>

<!-- ============ SUMMARY ROW DESTACADA ============ -->
${(()=>{
  const totLast=cardData.reduce((s,d)=>s+d.last,0);
  const totPrev=cardData.reduce((s,d)=>s+(d.prev||0),0);
  const totDelta=totPrev>0?((totLast-totPrev)/totPrev*100):null;
  const totTotal=cardData.reduce((s,d)=>s+d.total,0);
  return `<div class="cc-summary">
    <div class="cc-sum-block">
      <div class="cc-sum-label">Fatura consolidada · mês atual</div>
      <div class="cc-sum-value">${fmtBRL(totLast)}</div>
      ${totDelta!==null?`<div class="cc-sum-meta ${totDelta>=0?'up':'down'}">${totDelta>=0?'▲':'▼'} ${Math.abs(totDelta).toFixed(1)}% vs mês anterior</div>`:`<div class="cc-sum-meta">sem comparativo do mês anterior</div>`}
    </div>
    <div class="cc-sum-block">
      <div class="cc-sum-label">Mês anterior</div>
      <div class="cc-sum-value c-vl">${totPrev>0?fmtBRL(totPrev):'—'}</div>
      <div class="cc-sum-meta">${cardData.filter(d=>d.prev!==null).length} de ${cardData.length} cartão(ões) com histórico</div>
    </div>
    <div class="cc-sum-block">
      <div class="cc-sum-label">Total no período</div>
      <div class="cc-sum-value">${fmtBRL(totTotal)}</div>
      <div class="cc-sum-meta">${allCardTxs.length} lançamento(s) no filtro</div>
    </div>
  </div>`;
})()}

<!-- ============ STACK DE CARTÕES (uma linha rica por cartão) ============ -->
<div class="cc-stack">
  ${(()=>{
    // Mostrar apenas cartões com pelo menos um lançamento no período filtrado.
    const visiveis = cardData.filter(d=>d.txs && d.txs.length>0);
    if(!visiveis.length){
      return `<div class="empty">Nenhum cartão com lançamentos no período filtrado.</div>`;
    }
    return visiveis.map(({c,last,prev,delta,series,txs})=>{
    const deltaN=delta!==null?Number(delta):null;
    const isManual=!!c._manual;
    // Top categorias DESTE cartão (mês atual filtrado)
    const catMap={};
    txs.forEach(t=>{
      if(isCreditCardPayment(t)) return;
      const cat=t.categoryFinal||'Sem categoria';
      catMap[cat]=(catMap[cat]||0)+t.amountAbs;
    });
    const topCats=Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const catMax=topCats.length?topCats[0][1]:1;
    // Mini chart 12 meses (apenas barras simples)
    const last12=series.slice(-12);
    const maxVal=Math.max(...last12.map(s=>s.total),1);
    return `<div class="cc-row ${isManual?'manual':''}" data-cardid="${esc(c.id)}">
      <!-- Coluna 1: identificação -->
      <div class="cc-row-id">
        <div class="cc-row-chip ${isManual?'manual':''}">${isManual?'✦':'💳'}</div>
        <div style="min-width:0;flex:1">
          <div class="cc-row-name">${esc(accountLabel(c))}</div>
          <div class="cc-row-meta">
            ${isManual
              ? `<span class="cc-row-tag m">MANUAL</span>${c._lastDigits?`<span class="cc-row-dot"></span><span>•••• ${esc(c._lastDigits)}</span>`:''}${c.creditData?.closingDay?`<span class="cc-row-dot"></span><span>Fecha dia ${esc(c.creditData.closingDay)}</span>`:''}${c._manualBank?`<span class="cc-row-dot"></span><span>${esc(c._manualBank)}</span>`:''}`
              : `<span class="cc-row-tag">${esc(c.type||'-')}</span><span class="cc-row-tag">${esc(c.subtype||'-')}</span><span class="cc-row-dot"></span><span>${esc(getItemName(c.itemId)||'—')}</span>`
            }
          </div>
        </div>
        ${isManual?`<div class="cc-row-actions" onclick="event.stopPropagation()">
          <button class="btn btn-edit-card" data-cardid="${esc(c.id)}" aria-label="Editar cartão" title="Editar cartão" style="font-size:11px;padding:5px 8px">✏️</button>
          <button class="btn btn-del-card" data-cardid="${esc(c.id)}" aria-label="Excluir cartão" title="Excluir cartão" style="font-size:11px;padding:5px 8px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">🗑️</button>
        </div>`:''}
      </div>

      <!-- Coluna 2: fatura atual -->
      <div class="cc-row-fatura">
        <div class="cc-row-fatura-label">Fatura atual</div>
        <div class="cc-row-fatura-value">${fmtBRL(last)}</div>
        <div class="cc-row-fatura-meta">${prev!==null?'vs '+fmtBRL(prev)+' anterior':'sem comparativo'}</div>
      </div>

      <!-- Coluna 3: variação -->
      <div class="cc-row-spark">
        <div class="cc-row-spark-label">Variação</div>
        ${deltaN!==null
          ? `<span class="cc-row-delta delta-${deltaN>=0?'up':'down'}">${deltaN>=0?'▲':'▼'} ${Math.abs(deltaN)}%</span>`
          : `<span class="cc-row-delta delta-na">—</span>`
        }
        <div class="cc-row-toggle">clique para ${topCats.length||last12.length>1?'expandir ↓':'detalhes ↓'}</div>
      </div>

      <!-- Detail expandido -->
      <div class="cc-row-detail">
        <div class="cc-detail-grid">
          <div>
            <div class="cc-section-label">Evolução · últimos 12 meses</div>
            ${last12.length>1?`
              <div class="cc-mini12">
                ${last12.map((s,i)=>`<div class="cc-mini12-bar${i===last12.length-1?' now':''}" style="height:${(s.total/maxVal*100).toFixed(0)}%" title="${esc(s.label)}: ${fmtBRL(s.total)}"></div>`).join('')}
              </div>
              <div class="cc-mini12-axis">
                <span>${esc(last12[0].label)}</span>
                <span>${esc(last12[last12.length-1].label)}</span>
              </div>
            `:`<div class="cc-empty-mini">Histórico insuficiente para gráfico</div>`}
          </div>
          <div>
            <div class="cc-section-label">Top categorias deste cartão · período filtrado</div>
            ${topCats.length?`<div class="cc-minicat">
              ${topCats.map(([n,v])=>{
                const co=catColor(n);
                const pct=(v/catMax*100);
                return `<div class="cc-minicat-row">
                  <div class="cc-minicat-dot" style="background:${co}"></div>
                  <span class="cc-minicat-name">${esc(n)}</span>
                  <div class="cc-minicat-bar"><div class="cc-minicat-fill" style="width:${pct.toFixed(0)}%;background:${co}"></div></div>
                  <span class="cc-minicat-val">${fmtBRL(v)}</span>
                </div>`;
              }).join('')}
            </div>`:`<div class="cc-empty-mini">Nenhum lançamento neste cartão no período.</div>`}
          </div>
        </div>
      </div>
    </div>`;
    }).join('');
  })()}
</div>

<!-- ============ COMPOSIÇÃO AGREGADA (donut + lista) ============ -->
${(()=>{
  const catMap={};
  allCardTxs.filter(t=>!isCreditCardPayment(t)).forEach(t=>{
    const c=t.categoryFinal||'Sem categoria';
    catMap[c]=(catMap[c]||0)+t.amountAbs;
  });
  const totalGasto=Object.values(catMap).reduce((s,v)=>s+v,0);
  const catEntries=Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
  if(!catEntries.length) return '';

  // SVG donut
  const R=68,cx=90,cy=90,sw=26;
  let cum=-Math.PI/2;
  const arcs=catEntries.map(([name,val])=>{
    const pct=val/totalGasto;
    const angle=pct*2*Math.PI;
    const x1=(cx+R*Math.cos(cum)).toFixed(2), y1=(cy+R*Math.sin(cum)).toFixed(2);
    cum+=angle;
    const x2=(cx+R*Math.cos(cum)).toFixed(2), y2=(cy+R*Math.sin(cum)).toFixed(2);
    const large=angle>Math.PI?1:0;
    return{name,val,pct,x1,y1,x2,y2,large,co:catColor(name)};
  });
  const svgDonut=`<svg viewBox="0 0 180 180" width="180" height="180" style="flex-shrink:0;display:block">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--s3)" stroke-width="${sw}"/>
    ${arcs.map(a=>a.pct>0.001?`<path d="M ${a.x1} ${a.y1} A ${R} ${R} 0 ${a.large} 1 ${a.x2} ${a.y2}" fill="none" stroke="${a.co}" stroke-width="${sw}" stroke-linecap="butt" opacity=".9"/>`:'').join('')}
    <text x="${cx}" y="${cy-7}" text-anchor="middle" fill="#7a90b8" font-size="9.5" font-family="Inter,sans-serif">Total</text>
    <text x="${cx}" y="${cy+9}" text-anchor="middle" fill="#e2edff" font-size="12" font-family="JetBrains Mono,monospace" font-weight="500">${fmtShort(totalGasto)}</text>
    <text x="${cx}" y="${cy+22}" text-anchor="middle" fill="#7a90b8" font-size="9" font-family="Inter,sans-serif">${catEntries.length} cat${catEntries.length!==1?'s':''}</text>
  </svg>`;

  const bars=catEntries.map(([n,v])=>{
    const co=catColor(n);
    const pct=(v/totalGasto*100);
    const miniTxs=allCardTxs.filter(t=>!isCreditCardPayment(t)&&(t.categoryFinal||'Sem categoria')===n);
    const miniRows=miniTxs.map(tx=>`
      <tr>
        <td style="width:88px"><span class="num c-d" style="font-size:11px">${fmtDate(tx.date)}</span></td>
        <td><div class="txdesc">${esc(tx.description||'Transação')}</div><div class="txmeta">💳 ${esc(tx._cardName||tx.accountName||'')}</div></td>
        <td style="width:130px">
          <div class="fin-cat-wrap" style="position:relative;display:inline-block">
            ${chip(tx.categoryFinal||'Sem categoria')}
            <select class="card-cat-sel" data-txid="${tx.id}" aria-label="Alterar categoria do lançamento" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
              ${allUniqueCats().map(c=>`<option value="${esc(c)}" ${c===tx.categoryFinal?'selected':''}>${esc(getCatNames()[c]||c)}</option>`).join('')}
            </select>
          </div>
        </td>
        <td style="text-align:right"><span class="num c-e" style="font-size:12px;font-weight:500">${fmtBRL(tx.amountAbs)}</span></td>
      </tr>`).join('');
    return `
    <div class="catbar-wrap">
      <div class="catbar-clickrow">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <div style="width:7px;height:7px;border-radius:50%;background:${co};flex-shrink:0"></div>
          ${chip(n)}
          <div style="flex:1;min-width:40px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden;margin:0 6px">
            <div style="height:100%;width:${pct.toFixed(1)}%;background:${co};border-radius:2px;transition:width .4s"></div>
          </div>
          <span style="font-size:10px;color:var(--muted);flex-shrink:0;min-width:28px;text-align:right">${pct.toFixed(0)}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:10px">
          <span class="num c-e" style="font-size:11px;min-width:96px;text-align:right">${fmtBRL(v)}</span>
          <span class="catbar-toggle">▼</span>
        </div>
      </div>
      <div class="catbar-mini">
        ${miniRows
          ? `<div style="max-height:240px;overflow-y:auto"><table style="width:100%">${miniRows}</table></div>
             <div class="catbar-mini-footer">${miniTxs.length} lançamento${miniTxs.length!==1?'s':''} · clique no chip para reclassificar</div>`
          : `<div style="padding:8px 6px;font-size:11px;color:var(--muted)">Nenhum lançamento.</div>`}
      </div>
    </div>`;
  }).join('');

  return `<div class="card mb20">
    <div class="ctitle">Composição agregada por categoria</div>
    <div class="csub">Todos os cartões · período filtrado · clique na categoria para ver os lançamentos</div>
    <div style="display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap">
      ${svgDonut}
      <div style="flex:1;min-width:220px">
        ${bars}
        <div style="padding:8px 4px;display:flex;justify-content:space-between;border-top:1px solid var(--border);margin-top:4px">
          <span style="font-size:11px;color:var(--muted)">Total</span>
          <span class="num c-e" style="font-size:12px;font-weight:600">${fmtBRL(totalGasto)}</span>
        </div>
      </div>
    </div>
  </div>`;
})()}

<!-- ============ GRÁFICO DE EVOLUÇÃO CONSOLIDADO ============ -->
<div class="card mb20">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:6px">
    <div>
      <div class="ctitle">Evolução de faturas — todos os cartões</div>
      <div class="csub" style="margin-bottom:0">Gasto mensal consolidado nos últimos meses</div>
    </div>
    ${(()=>{
      if(!unifiedSeries.length) return '';
      const vals=unifiedSeries.map(s=>s.total||0);
      const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
      const lastV=vals[vals.length-1]||0;
      const trend=avg>0?((lastV-avg)/avg*100):0;
      return `<div style="display:flex;gap:18px;align-items:baseline">
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Média do período</div>
          <div class="num" style="font-size:16px;font-weight:600;color:var(--dim)">${fmtBRL(avg)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Mês atual vs média</div>
          <div class="num" style="font-size:16px;font-weight:600;color:${trend>=0?'var(--expense)':'var(--income)'}">${trend>=0?'▲':'▼'} ${Math.abs(trend).toFixed(1)}%</div>
        </div>
      </div>`;
    })()}
  </div>
  ${ccEvolutionChart(unifiedSeries)}
</div>

<!-- ============ LANÇAMENTOS CONSOLIDADOS ============ -->
<div class="card mb20">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px">
    <div>
      <div class="ctitle">Lançamentos consolidados</div>
      <div class="csub" style="margin-bottom:0">${allCardTxs.length} transação(ões) · todos os cartões · período filtrado</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="cardTxSearch" class="finput" placeholder="🔍 Buscar..." style="font-size:12px;max-width:200px"/>
      <button id="btnNewCardTx" class="btn primary" style="font-size:12px;padding:8px 14px;white-space:nowrap">＋ Novo lançamento</button>
    </div>
  </div>
  ${allCardTxs.length?`
  <div style="max-height:420px;overflow-y:auto;border-radius:var(--r-sm);border:1px solid var(--border)">
    <table class="txtable" style="min-width:600px">
      <thead><tr>
        <th>Data</th><th>Descrição</th><th>Cartão</th><th>Categoria</th>
        <th style="text-align:right">Valor</th>
        <th style="text-align:center;width:70px">Ações</th>
      </tr></thead>
      <tbody id="cardTxBody">
        ${allCardTxs.map(tx=>{
          const srchTxt=[tx.description||'',tx._cardName||'',tx.categoryFinal||'',fmtBRL(tx.amountAbs),fmtDate(tx.date)].join(' ').toLowerCase();
          return `<tr data-txt="${escAttr(srchTxt)}">
            <td><span class="num c-d" style="font-size:12px">${fmtDate(tx.date)}</span></td>
            <td><div class="txdesc">${esc(tx.description||'Transação')}</div><div class="txmeta">${esc(tx.accountName)}</div></td>
            <td class="c-m" style="font-size:12px">${tx._manual?'✦':'💳'} ${esc(tx._cardName)}</td>
            <td>
              <div class="fin-cat-wrap" style="position:relative;display:inline-block">
                ${chip(tx.categoryFinal||'Sem categoria')}
                <select class="card-cat-sel" data-txid="${tx.id}" aria-label="Alterar categoria do lançamento" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
                  ${allUniqueCats().map(c=>`<option value="${esc(c)}" ${c===tx.categoryFinal?'selected':''}>${esc(getCatNames()[c]||c)}</option>`).join('')}
                </select>
              </div>
            </td>
            <td style="text-align:right"><span class="num c-e" style="font-size:13px;font-weight:500">-${fmtBRL(tx.amountAbs)}</span></td>
            <td style="text-align:center;white-space:nowrap">${tx._manual?`<button class="btn btn-edit-cardtx" data-txid="${esc(tx.id)}" aria-label="Editar lançamento" title="Editar lançamento" style="font-size:11px;padding:4px 8px;margin-right:3px">✏️</button><button class="btn btn-del-cardtx" data-txid="${esc(tx.id)}" aria-label="Excluir lançamento" title="Excluir lançamento" style="font-size:11px;padding:4px 8px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">🗑️</button>`:''}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`:empty('Nenhuma transação de cartão encontrada no período.')}
</div>

`;

  // ── Edit / Delete card ────────────────────────────────────────────────────
  document.querySelectorAll('.btn-edit-card').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.cardid;
      const c=getManualCards().find(x=>x.id===id);
      if(!c) return;
      document.getElementById('nc_name').value  =c.name||'';
      document.getElementById('nc_bank').value  =c._manualBank||'';
      document.getElementById('nc_limit').value =c.creditData?.limitAmount||'';
      document.getElementById('nc_close').value =c.creditData?.closingDay||'';
      document.getElementById('nc_number').value=c._lastDigits||'';
      document.getElementById('nc_error').style.display='none';
      const modal=document.getElementById('modalNewCard');
      modal.dataset.editId=id;
      openModal(modal);
    });
  });

  document.querySelectorAll('.btn-del-card').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.cardid;
      const c=APP.data.cards.find(x=>x.id===id);
      const label=c?accountLabel(c):id;
      if(!confirm('Excluir o cartão "'+label+'" e todos os seus lançamentos manuais?')) return;
      saveManualCards(getManualCards().filter(x=>x.id!==id));
      saveManualCardTxs(getManualCardTxs().filter(x=>x.accountId!==id));
      normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderCreditCards();
    });
  });

  // ── New Card button ────────────────────────────────────────────────────────
  bindClick('btnNewCard', ()=>{
    ['nc_name','nc_bank','nc_limit','nc_close','nc_number'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('nc_error').style.display='none';
    const modal=document.getElementById('modalNewCard');
    delete modal.dataset.editId;
    openModal(modal);
  });

  // ── New Tx button ──────────────────────────────────────────────────────────
  bindClick('btnNewCardTx', ()=>{
    const sel=document.getElementById('nctx_card');
    if(sel) sel.innerHTML=APP.data.cards.map(c=>`<option value="${c.id}">${accountLabel(c)}</option>`).join('');
    // populate category datalist
    const dl=document.getElementById('nctx_cat_list');
    if(dl) dl.innerHTML=allUniqueCats().map(c=>`<option value="${esc(c)}">`).join('');
    ['nctx_desc','nctx_val','nctx_cat'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const dateEl=document.getElementById('nctx_date');
    if(dateEl) dateEl.value=new Date().toISOString().slice(0,10);
    document.getElementById('nctx_error').style.display='none';
    openModal(document.getElementById('modalNewCardTx'));
  });

  // ── Modal Save/Cancel — Novo Cartão ───────────────────────────────────────
  // clone buttons to wipe any previously attached listeners
  ['btnNewCardCancel','btnNewCardSave','btnNewCardTxCancel','btnNewCardTxSave'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ const cl=el.cloneNode(true); el.parentNode.replaceChild(cl,el); }
  });

  bindClick('btnNewCardCancel', ()=>{
    const m=document.getElementById('modalNewCard');
    m.style.display='none'; delete m.dataset.editId;
  });

  bindClick('btnNewCardSave', ()=>{
    const errEl=document.getElementById('nc_error');
    const name=(document.getElementById('nc_name').value||'').trim();
    if(!name){ errEl.textContent='Nome é obrigatório.'; errEl.style.display='block'; return; }
    errEl.style.display='none';
    const modal=document.getElementById('modalNewCard');
    const editId=modal.dataset.editId||'';
    const cards=getManualCards();
    const cardObj={
      name, marketingName:name, type:'CREDIT', subtype:'credit',
      _manualBank:(document.getElementById('nc_bank').value||'').trim(),
      creditData:{
        limitAmount:parseFloat(document.getElementById('nc_limit').value)||0,
        closingDay:parseInt(document.getElementById('nc_close').value)||0
      },
      _lastDigits:(document.getElementById('nc_number').value||'').trim(),
      _manual:true
    };
    if(editId){
      const i=cards.findIndex(c=>c.id===editId);
      if(i>=0) cards[i]={...cards[i],...cardObj};
    } else {
      cards.push({id:'manual_card_'+Date.now(),...cardObj});
    }
    saveManualCards(cards);
    closeModal(modal);
    normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderCreditCards();
  });

  // ── Modal Save/Cancel — Novo Lançamento ───────────────────────────────────
  bindClick('btnNewCardTxCancel', ()=>{
    closeModal(document.getElementById('modalNewCardTx'));
  });

  bindClick('btnNewCardTxSave', ()=>{
    const errEl=document.getElementById('nctx_error');
    const desc=(document.getElementById('nctx_desc').value||'').trim();
    const val=parseFloat(document.getElementById('nctx_val').value);
    const date=document.getElementById('nctx_date').value;
    const cat=(document.getElementById('nctx_cat').value||'').trim()||'Outros';
    const cardId=document.getElementById('nctx_card').value;
    if(!desc){ errEl.textContent='Descrição é obrigatória.'; errEl.style.display='block'; return; }
    if(!val||val<=0){ errEl.textContent='Valor deve ser maior que zero.'; errEl.style.display='block'; return; }
    if(!date){ errEl.textContent='Data é obrigatória.'; errEl.style.display='block'; return; }
    errEl.style.display='none';
    const card=APP.data.cards.find(c=>c.id===cardId);
    const txs=getManualCardTxs();
    txs.push({
      id:'manual_tx_'+Date.now(), accountId:cardId,
      accountName:card?accountLabel(card):'Cartão',
      description:desc, amount:-Math.abs(val), amountAbs:Math.abs(val),
      direction:'expense', date, category:cat, categoryFinal:cat, _manual:true
    });
    saveManualCardTxs(txs);
    closeModal(document.getElementById('modalNewCardTx'));
    normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderCreditCards();
  });

  // ── Edit / Delete manual tx ──────────────────────────────────────────────
  document.querySelectorAll('.btn-edit-cardtx').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.txid;
      const tx=getManualCardTxs().find(x=>x.id===id);
      if(!tx) return;
      const sel=document.getElementById('etx_card');
      if(sel) sel.innerHTML=APP.data.cards.map(c=>`<option value="${c.id}"${c.id===tx.accountId?' selected':''}>${accountLabel(c)}</option>`).join('');
      document.getElementById('etx_desc').value=tx.description||'';
      document.getElementById('etx_val').value=tx.amountAbs||'';
      document.getElementById('etx_date').value=tx.date||'';
      document.getElementById('etx_cat').value=tx.categoryFinal||'';
      const dl=document.getElementById('etx_cat_list');
      if(dl) dl.innerHTML=allUniqueCats().map(c=>`<option value="${esc(c)}">`).join('');
      document.getElementById('etx_error').style.display='none';
      const modal=document.getElementById('modalEditCardTx');
      modal.dataset.txid=id;
      openModal(modal);
    });
  });

  document.querySelectorAll('.btn-del-cardtx').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.txid;
      const tx=getManualCardTxs().find(x=>x.id===id);
      const label=tx?tx.description:id;
      if(!confirm('Excluir o lançamento "'+label+'"?')) return;
      saveManualCardTxs(getManualCardTxs().filter(x=>x.id!==id));
      normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderCreditCards();
    });
  });

  // clone edit-tx modal buttons
  ['btnEditCardTxCancel','btnEditCardTxSave'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ const cl=el.cloneNode(true); el.parentNode.replaceChild(cl,el); }
  });

  bindClick('btnEditCardTxCancel', ()=>{
    closeModal(document.getElementById('modalEditCardTx'));
  });

  bindClick('btnEditCardTxSave', ()=>{
    const errEl=document.getElementById('etx_error');
    const desc=(document.getElementById('etx_desc').value||'').trim();
    const val=parseFloat(document.getElementById('etx_val').value);
    const date=document.getElementById('etx_date').value;
    const cat=(document.getElementById('etx_cat').value||'').trim()||'Outros';
    const cardId=document.getElementById('etx_card').value;
    if(!desc){ errEl.textContent='Descrição é obrigatória.'; errEl.style.display='block'; return; }
    if(!val||val<=0){ errEl.textContent='Valor deve ser maior que zero.'; errEl.style.display='block'; return; }
    if(!date){ errEl.textContent='Data é obrigatória.'; errEl.style.display='block'; return; }
    errEl.style.display='none';
    const modal=document.getElementById('modalEditCardTx');
    const txId=modal.dataset.txid;
    const txs=getManualCardTxs();
    const i=txs.findIndex(x=>x.id===txId);
    if(i>=0){
      const card=APP.data.cards.find(c=>c.id===cardId);
      txs[i]={...txs[i], accountId:cardId, accountName:card?accountLabel(card):'Cartão',
        description:desc, amount:-Math.abs(val), amountAbs:Math.abs(val),
        date, category:cat, categoryFinal:cat};
    }
    saveManualCardTxs(txs);
    closeModal(modal);
    normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderCreditCards();
  });

  // ── Inline category change nos lançamentos de cartão ─────────────────────
  document.querySelectorAll('#creditcards .card-cat-sel').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const manual=getManual();
      const v=sel.value;
      if(v) manual[sel.dataset.txid]=v; else delete manual[sel.dataset.txid];
      saveManual(manual); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderCreditCards();
    });
  });

  // ── Card transactions search ───────────────────────────────────────────────
  const _cSrch=document.getElementById('cardTxSearch');
  if(_cSrch){
    let _cTimer=null;
    _cSrch.addEventListener('input',e=>{
      e.stopPropagation(); clearTimeout(_cTimer);
      _cTimer=setTimeout(()=>{
        const low=_cSrch.value.toLowerCase().trim();
        document.querySelectorAll('#cardTxBody tr[data-txt]').forEach(r=>{
          r.style.display=!low||r.dataset.txt.includes(low)?'':'none';
        });
      },120);
    });
  }
}

function renderInvestments(){
  const invsAll=APP.data.investments;
  const invCat=APP.filters?.category||'all';
  const invsCat=invCat==='all'?invsAll:invsAll.filter(i=>(i.categoryEditable||i.type||'Outros')===invCat);
  // Filtro mensal: substitui currentValue pelo valor do mês selecionado.
  // Para "Todos", mantém o currentValue original. Isso unifica todos os
  // widgets (KPI, distribuição, tabela, insights) num único conjunto de
  // valores — sem cálculos com numerador atual e denominador histórico.
  const monthFilterEarly=APP.filters?.month||'all';
  const invs=monthFilterEarly==='all'
    ? invsCat
    : invsCat.map(i=>({...i, currentValue: invValueAt(i, monthFilterEarly)}));
  if(!invsAll.length){
    document.getElementById('investments').innerHTML=`
<!-- Header com botão Novo investimento -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
  <div>
    <div style="font-size:18px;font-weight:700;color:var(--text)">📈 Investimentos</div>
    <div style="font-size:13px;color:var(--muted);margin-top:2px">Nenhum ativo encontrado — adicione um investimento manual ou conecte uma conta na Pluggy</div>
  </div>
  <button id="btnNewInv" class="btn primary" style="font-size:13px;padding:10px 18px;display:flex;align-items:center;gap:6px">＋ Novo investimento</button>
</div>
<div class="card">${empty('Nenhum investimento ainda. Clique em "+ Novo investimento" para começar.')}</div>`;
    bindInvManualListeners();
    return;
  }

  // Gráfico mensal: usa invsCat (currentValue original) porque monthlyInvested
  // já faz seu próprio forward-fill de snapshots por mês.
  const monthFilter=monthFilterEarly;
  const monthlyAll=monthlyInvested(invsCat);
  const monthly=monthFilter==='all'
    ? monthlyAll.slice(-12)
    : monthlyAll.filter(s=>s.month<=monthFilter).slice(-12);
  const last=monthly.length?monthly[monthly.length-1].total:0;
  const prev=monthly.length>1?monthly[monthly.length-2].total:null;
  // total: agora sempre vem do invs (já com currentValue do mês quando filtrado).
  // byType, sorted, top, tabela e percentuais usam o mesmo invs — consistente.
  const total=invs.reduce((s,i)=>s+i.currentValue,0);
  // Lançamentos de investimento detectados — espelha a lógica de monthlyInvested
  // para que o usuário consiga conferir quais transações alimentam o fluxo Pluggy.
  const invTxsAll = (APP.data.transactions||[]).filter(tx=>{
    if(tx.isCard) return false;
    const accType=String(tx.accountType||'').toUpperCase();
    if(/INVEST/.test(accType)) return true;
    const cat=(tx.categoryFinal||tx.nativeCategory||'').toString();
    return INVEST_CAT_PATTERNS.some(p=>p.test(cat));
  });
  const invTxsFiltered = monthFilter==='all'
    ? invTxsAll
    : invTxsAll.filter(tx=>monthKey(tx.date)===monthFilter);
  const invTxs = [...invTxsFiltered].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const totalAportes = invTxs.filter(t=>t.direction==='expense').reduce((s,t)=>s+Number(t.amountAbs||0),0);
  const totalResgates = invTxs.filter(t=>t.direction!=='expense').reduce((s,t)=>s+Number(t.amountAbs||0),0);

  const delta=prev&&prev>0?((last-prev)/prev*100):null;
  const deltaAbs=prev!==null?last-prev:null;

  const byType={};
  invs.forEach(inv=>{const t=inv.categoryEditable||inv.type||'Outros';if(!byType[t])byType[t]=0;byType[t]+=inv.currentValue});
  const typeEntries=Object.entries(byType).sort((a,b)=>b[1]-a[1]);
  const sorted=[...invs].sort((a,b)=>b.currentValue-a.currentValue);
  const top=sorted[0];

  function svgAreaLabeled(series,key,color){
    if(!series.length) return empty('Sem histórico mensal disponível.');
    const W=800,H=200,P={t:36,r:12,b:34,l:12};
    const cW=W-P.l-P.r, cH=H-P.t-P.b;
    const maxV=Math.max(...series.map(s=>s[key]||0),1);
    const n=series.length;
    const px=i=>P.l+(n===1?cW/2:(i/(n-1))*cW);
    const py=v=>P.t+cH-(v/maxV)*cH;
    const pts=series.map((s,i)=>`${px(i).toFixed(1)},${py(s[key]||0).toFixed(1)}`);
    const lStr=pts.join(' ');
    const aStr=`${P.l.toFixed(1)},${(P.t+cH).toFixed(1)} ${lStr} ${(W-P.r).toFixed(1)},${(P.t+cH).toFixed(1)}`;
    const valLbls=series.map((s,i)=>{ if(n>8&&i%2!==0) return ''; const x=px(i).toFixed(1), y=(py(s[key]||0)-8).toFixed(1); return `<text x="${x}" y="${y}" text-anchor="middle" fill="${color}" font-size="8.5" font-family="IBM Plex Mono,monospace" opacity=".9">${fmtShort(s[key]||0)}</text>`; }).join('');
    const lbls=series.map((s,i)=>{ if(n>8&&i%2!==0) return ''; return `<text x="${px(i).toFixed(1)}" y="${H-3}" text-anchor="middle" fill="#5a7099" font-size="9.5" font-family="DM Sans,sans-serif">${esc(s.label)}</text>`; }).join('');
    const gId=`gi${color.replace('#','')}`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible"><defs><linearGradient id="${gId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><polygon points="${aStr}" fill="url(#${gId})"/>${n>1?`<polyline points="${lStr}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`:''}${series.map((s,i)=>`<circle cx="${px(i).toFixed(1)}" cy="${py(s[key]||0).toFixed(1)}" r="3" fill="${color}" stroke="#070c14" stroke-width="1.5"/>`).join('')}${valLbls}${lbls}</svg>`;
  }

  document.getElementById('investments').innerHTML=`
<!-- Header com botão Novo investimento -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px">
  <div>
    <div style="font-size:18px;font-weight:700;color:var(--text)">📈 Investimentos</div>
    <div style="font-size:13px;color:var(--muted);margin-top:2px">${invs.length} de ${invsAll.length} ativo(s) · ${invsAll.filter(i=>i._manual).length} manual(is)${invCat!=='all'?` · filtro: ${esc(invCat)}`:''}</div>
  </div>
  <button id="btnNewInv" class="btn primary" style="font-size:13px;padding:10px 18px;display:flex;align-items:center;gap:6px">＋ Novo investimento</button>
</div>

<div class="grid g4 mb20">
  ${kpi('Total investido',fmtBRL(total),monthFilter==='all'?`${invs.length} posição(ões) ativas`:`em ${monthLabel(monthFilter)} · ${invs.length} posição(ões)`,'invest')}
  ${kpi('Maior posição',fmtBRL(top?.currentValue||0),esc(top?.displayName||'-'),'violet')}
  ${kpi('Classes de ativos',String(typeEntries.length),'Tipos diferentes','muted')}
  ${delta!==null ? kpi('Variação mensal',`${delta>=0?'+':''}${delta.toFixed(2)}%`,`${delta>=0?'+':''}${fmtBRL(deltaAbs)} vs mês ant.`,delta>=0?'income':'expense') : kpi('Variação mensal','—','Sem dados comparativos','muted')}
</div>

<div class="grid g2 mb20">
  <div class="card">
    <div class="ctitle">Evolução mensal do patrimônio</div>
    <div class="csub">Patrimônio total consolidado mês a mês${monthFilter!=='all'?` · até ${monthLabel(monthFilter)}`:''}</div>
    ${svgAreaLabeled(monthly,'total','#f6a93b')}
    <div class="chart-legend"><div class="leg-item"><div class="leg-line" style="background:#f6a93b"></div>Total investido</div></div>
  </div>
  <div class="card">
    <div class="ctitle">Distribuição por classe de ativo</div>
    <div class="csub">Alocação percentual por tipo</div>
    ${typeEntries.length?typeEntries.map(([t,v])=>{ const pct=(v/total*100), co=catColor(t); return `<div class="catbar-wrap"><div class="catbar-row"><span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33">${esc(t)}</span><div style="display:flex;gap:10px;align-items:center"><span class="num c-d" style="font-size:11px">${pct.toFixed(1)}%</span><span class="num c-v" style="font-size:11px">${fmtBRL(v)}</span></div></div><div class="catbar"><div class="catbar-fill" style="width:${pct}%;background:${co}"></div></div></div>`; }).join(''):empty('Sem dados por tipo.')}
  </div>
</div>

<div class="card mb20">
  <div class="ctitle">Insights do portfólio</div>
  <div class="csub">Análise automática com base nas posições atuais</div>
  <div class="grid g3">
    <div style="padding:18px;background:var(--s0);border-radius:12px;border:1px solid var(--border)"><div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Maior alocação por tipo</div><div style="font-weight:500;font-size:13px;color:var(--text);margin-bottom:6px">${esc(typeEntries[0]?.[0]||'-')}</div><div class="num c-v" style="font-size:20px;font-weight:500">${fmtBRL(typeEntries[0]?.[1]||0)}</div><div style="font-size:11px;color:var(--muted);margin-top:5px">${((typeEntries[0]?.[1]||0)/total*100).toFixed(1)}% do portfólio total</div></div>
    <div style="padding:18px;background:var(--s0);border-radius:12px;border:1px solid var(--border)"><div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Maior posição individual</div><div style="font-weight:500;font-size:13px;color:var(--text);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(top?.displayName||'-')}</div><div class="num c-v" style="font-size:20px;font-weight:500">${fmtBRL(top?.currentValue||0)}</div><div style="font-size:11px;color:var(--muted);margin-top:5px">${((top?.currentValue||0)/total*100).toFixed(1)}% do total investido</div></div>
    <div style="padding:18px;background:var(--s0);border-radius:12px;border:1px solid var(--border)"><div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Variação mês anterior</div>${delta!==null?`<div class="num ${delta>=0?'c-i':'c-e'}" style="font-size:26px;font-weight:500">${delta>=0?'+':''}${delta.toFixed(2)}%</div><div style="font-size:12px;color:${delta>=0?'var(--income)':'var(--expense)'};margin-top:6px">${delta>=0?'+':''}${fmtBRL(deltaAbs)}</div><div style="font-size:11px;color:var(--muted);margin-top:3px">${delta>=0?'patrimônio cresceu':'patrimônio reduziu'} no último mês</div>`:`<div style="font-size:13px;color:var(--muted);margin-top:10px">Sem dados suficientes para comparação</div>`}</div>
  </div>
</div>

<!-- Investimentos manuais (gestão) -->
${(()=>{
  const manualInvs = getManualInvs();
  if(!manualInvs.length) return '';
  return `<div class="card mb20">
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <div>
        <div class="ctitle">Investimentos manuais</div>
        <div class="csub" style="margin-bottom:0">${manualInvs.length} investimento(s) · clique em ▦ para atualizar valor mensal</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Total manual</div>
        <div class="num c-v" style="font-size:18px;font-weight:600">${fmtBRL(invs.filter(i=>i._manual).reduce((s,i)=>s+i.currentValue,0))}</div>
      </div>
    </div>
    <div class="minv-grid">
      ${manualInvs.map(mi=>{
        const snaps=mi.snapshots||{};
        const months=Object.keys(snaps).sort();
        const latestMonth=months[months.length-1];
        const latestValue=latestMonth?Number(snaps[latestMonth]||0):0;
        // delta vs mês anterior nos snapshots
        const prevMonth=months[months.length-2];
        const prevValue=prevMonth?Number(snaps[prevMonth]||0):null;
        const delta=prevValue&&prevValue>0?((latestValue-prevValue)/prevValue*100):null;
        const co=catColor(mi.category||'Outros');
        // mini-sparkline
        const sparkPts=months.length>1?(()=>{
          const vals=months.map(m=>Number(snaps[m]||0));
          const max=Math.max(...vals,1);
          const W=80,H=24;
          const pts=vals.map((v,i)=>`${(i/(vals.length-1)*W).toFixed(1)},${(H-(v/max*H)).toFixed(1)}`).join(' ');
          return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block"><polyline points="${pts}" fill="none" stroke="${co}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
        })():'<div style="font-size:10px;color:var(--muted);font-style:italic">sem histórico</div>';
        return `<div class="minv-card">
          <div class="minv-head">
            <div style="flex:1;min-width:0">
              <div class="minv-title">${esc(mi.name)}</div>
              <span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33;font-size:10.5px;margin-top:3px;display:inline-block">${esc(mi.category||'Outros')}</span>
            </div>
            <div class="minv-actions">
              <button class="btn btn-snap-inv" data-invid="${esc(mi.id)}" aria-label="Atualizar valor mensal" title="Atualizar valor mensal" style="font-size:11px;padding:5px 8px;background:var(--accent-bg);color:var(--accent);border-color:rgba(6,247,180,.3)">▦</button>
              <button class="btn btn-edit-inv" data-invid="${esc(mi.id)}" aria-label="Editar" title="Editar" style="font-size:11px;padding:5px 8px">✏️</button>
              <button class="btn btn-del-inv" data-invid="${esc(mi.id)}" aria-label="Excluir" title="Excluir" style="font-size:11px;padding:5px 8px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">🗑️</button>
            </div>
          </div>
          <div class="minv-main">
            <div>
              <div class="minv-label">Valor atual${latestMonth?' · '+monthLabel(latestMonth):''}</div>
              <div class="num c-v" style="font-size:19px;font-weight:600;line-height:1.1">${fmtBRL(latestValue)}</div>
              ${delta!==null?`<div style="font-size:11px;color:${delta>=0?'var(--income)':'var(--expense)'};margin-top:2px">${delta>=0?'▲':'▼'} ${Math.abs(delta).toFixed(2)}% vs mês ant.</div>`:''}
            </div>
            <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:3px">
              ${sparkPts}
              <div style="font-size:10px;color:var(--muted)">${months.length} snapshot(s)</div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
})()}

<div class="card">
  <div class="ctitle">Posições detalhadas</div>
  <div class="csub">${invs.length} ativo(s) · ordenado por valor atual</div>
  <div class="txwrap">
    <table class="txtable">
      <thead><tr><th>Nome</th><th>Categoria</th><th>Banco</th><th style="text-align:right">Valor atual</th><th style="text-align:right">% do total</th></tr></thead>
      <tbody>${sorted.map((inv,idx)=>{ const pct=(inv.currentValue/total*100); const currentCat=inv.categoryEditable||inv.type||'Outros'; const co=catColor(currentCat); return `<tr><td><div class="txdesc">${idx===0?'⭐ ':''}${esc(inv.displayName)}</div></td><td>
            <div class="fin-cat-wrap" style="position:relative;display:inline-block">
              <span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33">${esc(currentCat)}</span>
              <select class="inv-cat-sel" data-invid="${esc(inv.invId)}" aria-label="Alterar categoria do ativo" data-current="${esc(currentCat)}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
                <option value="">Carregando...</option>
              </select>
            </div>
          </td><td class="c-m" style="font-size:12px">${inv._manual?'<span style="color:var(--accent);font-weight:500">✦ Manual</span>':esc(getItemName(inv.itemId))}</td><td style="text-align:right"><span class="num c-v" style="font-size:13px">${fmtBRL(inv.currentValue)}</span></td><td style="text-align:right"><div style="display:flex;align-items:center;justify-content:flex-end;gap:8px"><div style="width:50px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden"><div style="height:100%;width:${Math.min(pct,100)}%;background:${co};border-radius:2px"></div></div><span class="num c-d" style="font-size:12px;width:36px;text-align:right">${pct.toFixed(1)}%</span></div></td></tr>`; }).join('')}</tbody>
    </table>
  </div></div>

<!-- Lançamentos de investimento - tabela de conferência do fluxo Pluggy -->
<div class="card mb20">
  <div class="ctitle">📊 Lançamentos de investimento (conferência)</div>
  <div class="csub">Transações detectadas como aporte/resgate · base do cálculo do histórico Pluggy${monthFilter!=='all'?` · ${monthLabel(monthFilter)}`:''}. ${invTxs.length} lançamento(s) · Aportes ${fmtBRL(totalAportes)} · Resgates ${fmtBRL(totalResgates)} · Líquido ${fmtBRL(totalAportes-totalResgates)}</div>
  ${invTxs.length ? `<div class="txwrap">
    <table class="txtable">
      <thead><tr>
        <th>Data</th>
        <th>Mês</th>
        <th>Descrição</th>
        <th>Conta</th>
        <th>Categoria</th>
        <th style="text-align:right">Tipo</th>
        <th style="text-align:right">Valor</th>
      </tr></thead>
      <tbody>${invTxs.map(tx=>{
        const m=monthKey(tx.date);
        const cat=tx.categoryFinal||tx.nativeCategory||'Sem categoria';
        const co=catColor(cat);
        const isAporte=tx.direction==='expense';
        const dirColor=isAporte?'#06f7b4':'#ff4d6d';
        const dirLabel=isAporte?'Aporte':'Resgate';
        return `<tr>
          <td class="c-m" style="font-size:12px">${fmtDate(tx.date)}</td>
          <td class="c-m" style="font-size:11.5px">${esc(monthLabel(m))}</td>
          <td><div class="txdesc">${esc(tx.description||'-')}</div></td>
          <td class="c-m" style="font-size:12px">${esc(tx.accountName||'-')}</td>
          <td><span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33">${esc(cat)}</span></td>
          <td style="text-align:right"><span class="chip" style="background:${dirColor}1a;color:${dirColor};border:1px solid ${dirColor}33">${dirLabel}</span></td>
          <td class="num" style="text-align:right;color:${dirColor};font-size:13px">${isAporte?'+':'-'}${fmtBRL(tx.amountAbs)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>` : empty('Nenhum lançamento de investimento no período.')}
</div>

</div>`;

  document.querySelectorAll('#investments .inv-cat-sel').forEach(sel=>{
    loadPluggyCategoryCatalog().then(res=>{
      const fallback=[...new Set(APP.data.investments.map(i=>i.categoryEditable||i.type||'Outros').filter(Boolean))].sort();
      const current=sel.dataset.current||'Outros';
      let options=[], errMsg=null;
      if(res.ok){
        const flat=[...new Set(flattenPluggyCategories(res.list))].filter(Boolean).sort();
        options = flat.length ? flat : fallback;
      } else {
        // API falhou: usa fallback local e expõe erro ao usuário
        options = fallback;
        errMsg = res.error;
      }
      const placeholderTxt = errMsg
        ? `(catálogo offline: ${errMsg})`
        : (res.ok && !res.list.length ? '(catálogo Pluggy vazio - usando local)' : null);
      const placeholderOpt = placeholderTxt
        ? `<option value="" disabled>${esc(placeholderTxt)}</option>`
        : '';
      sel.innerHTML = placeholderOpt +
        options.map(c=>`<option value="${esc(c)}" ${c===current?'selected':''}>${esc(c)}</option>`).join('');
    });
    sel.addEventListener('change',()=>{
      const invId=sel.dataset.invid;
      const next=sel.value;
      if(!next) return;
      const saved=getInvCats();
      saved[invId]=next;
      saveInvCats(saved);
      normalizeData();
      populateFilters();
      // Re-renderiza tudo que mostra categoria de investimento
      renderInvestments();
      renderOverview();
      renderEditar();
    });
  });

  bindInvManualListeners();
}

// ─── Investimentos manuais: listeners e modais ───────────────────────────────
function bindInvManualListeners(){
  // Botão "+ Novo investimento"
  bindClick('btnNewInv', ()=>{
    ['ni_name','ni_cat','ni_value'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
    const mEl=document.getElementById('ni_month');
    if(mEl){
      const now=new Date();
      mEl.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    }
    document.getElementById('ni_error').style.display='none';
    // popular categorias sugeridas
    const dl=document.getElementById('ni_cat_list');
    if(dl){
      const cats=[...new Set([
        ...APP.data.investments.map(i=>i.categoryEditable||i.type||'Outros'),
        'Renda Fixa','Renda Variável','Tesouro','CDB','LCI','LCA','FII','Ações','Fundos','Previdência','Cripto'
      ].filter(Boolean))].sort();
      dl.innerHTML=cats.map(c=>`<option value="${esc(c)}">`).join('');
    }
    openModal(document.getElementById('modalNewInv'));
  });

  // Salvar novo investimento
  bindClick('btnNewInvSave', ()=>{
    const err=document.getElementById('ni_error');
    const name=(document.getElementById('ni_name').value||'').trim();
    const cat=(document.getElementById('ni_cat').value||'').trim()||'Outros';
    const value=parseFloat(document.getElementById('ni_value').value);
    const month=document.getElementById('ni_month').value;
    if(!name){err.textContent='Nome é obrigatório.';err.style.display='block';return;}
    if(!value||value<=0){err.textContent='Valor deve ser maior que zero.';err.style.display='block';return;}
    if(!month||!/^\d{4}-\d{2}$/.test(month)){err.textContent='Mês inválido.';err.style.display='block';return;}
    const invs=getManualInvs();
    invs.push({
      id:'manual_inv_'+Date.now(),
      name, category:cat,
      createdAt:new Date().toISOString().slice(0,10),
      snapshots:{[month]:value}
    });
    saveManualInvs(invs);
    closeModal(document.getElementById('modalNewInv'));
    normalizeData(); populateFilters();
    renderInvestments(); renderOverview();
  });

  bindClick('btnNewInvCancel', ()=>{
    closeModal(document.getElementById('modalNewInv'));
  });

  // Botão "▦ Atualizar" — abrir modal de snapshot
  document.querySelectorAll('.btn-snap-inv').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.invid;
      const inv=getManualInvs().find(x=>x.id===id);
      if(!inv) return;
      const modal=document.getElementById('modalSnapInv');
      modal.dataset.invid=id;
      document.getElementById('snap_inv_name').textContent=`${inv.name} · ${inv.category||'Outros'}`;
      // Mês default: atual
      const now=new Date();
      document.getElementById('snap_month').value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      document.getElementById('snap_value').value='';
      document.getElementById('snap_error').style.display='none';
      renderSnapHistory(inv);
      openModal(modal);
    });
  });

  // Mostrar histórico de snapshots dentro do modal
  function renderSnapHistory(inv){
    const box=document.getElementById('snap_history');
    if(!box) return;
    const snaps=inv.snapshots||{};
    const months=Object.keys(snaps).sort().reverse();
    if(!months.length){
      box.innerHTML='<div style="font-size:11px;color:var(--muted);font-style:italic;text-align:center;padding:8px">Nenhum snapshot ainda — adicione o primeiro acima.</div>';
      return;
    }
    box.innerHTML=`<div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Histórico (${months.length})</div>
      <div style="display:grid;gap:4px">
      ${months.map((m,i)=>{
        const v=Number(snaps[m]||0);
        const prev=i<months.length-1?Number(snaps[months[i+1]]||0):null;
        const delta=prev&&prev>0?((v-prev)/prev*100):null;
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--s1);border-radius:8px;font-size:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-weight:500;min-width:65px">${monthLabel(m)}</span>
            ${delta!==null?`<span style="font-size:10.5px;color:${delta>=0?'var(--income)':'var(--expense)'}">${delta>=0?'▲':'▼'} ${Math.abs(delta).toFixed(2)}%</span>`:''}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="num c-v" style="font-size:12px;font-weight:500">${fmtBRL(v)}</span>
            <button class="btn btn-snap-del" data-month="${esc(m)}" aria-label="Apagar snapshot" title="Apagar snapshot" style="font-size:10px;padding:2px 6px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">✕</button>
          </div>
        </div>`;
      }).join('')}
      </div>`;
    // Listener de apagar snapshot
    box.querySelectorAll('.btn-snap-del').forEach(b=>{
      b.addEventListener('click',()=>{
        const m=b.dataset.month;
        if(!confirm(`Apagar snapshot de ${monthLabel(m)}?`)) return;
        const invs=getManualInvs();
        const target=invs.find(x=>x.id===inv.id);
        if(target?.snapshots){
          delete target.snapshots[m];
          saveManualInvs(invs);
          renderSnapHistory(target);
          normalizeData(); populateFilters();
          renderInvestments(); renderOverview();
        }
      });
    });
  }

  // Salvar snapshot
  bindClick('btnSnapSave', ()=>{
    const err=document.getElementById('snap_error');
    const modal=document.getElementById('modalSnapInv');
    const id=modal.dataset.invid;
    const month=document.getElementById('snap_month').value;
    const value=parseFloat(document.getElementById('snap_value').value);
    if(!month||!/^\d{4}-\d{2}$/.test(month)){err.textContent='Mês inválido.';err.style.display='block';return;}
    if(isNaN(value)||value<0){err.textContent='Valor inválido.';err.style.display='block';return;}
    const invs=getManualInvs();
    const target=invs.find(x=>x.id===id);
    if(!target){err.textContent='Investimento não encontrado.';err.style.display='block';return;}
    target.snapshots=target.snapshots||{};
    target.snapshots[month]=value;
    saveManualInvs(invs);
    // limpar formulário, mostrar feedback no histórico
    document.getElementById('snap_value').value='';
    err.style.display='none';
    renderSnapHistory(target);
    normalizeData(); populateFilters();
    renderInvestments(); renderOverview();
  });

  bindClick('btnSnapCancel', ()=>{
    closeModal(document.getElementById('modalSnapInv'));
  });

  // Botão Editar (nome/categoria)
  document.querySelectorAll('.btn-edit-inv').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.invid;
      const inv=getManualInvs().find(x=>x.id===id);
      if(!inv) return;
      const modal=document.getElementById('modalEditInv');
      modal.dataset.invid=id;
      document.getElementById('ei_name').value=inv.name||'';
      document.getElementById('ei_cat').value=inv.category||'';
      document.getElementById('ei_error').style.display='none';
      const dl=document.getElementById('ei_cat_list');
      if(dl){
        const cats=[...new Set([
          ...APP.data.investments.map(i=>i.categoryEditable||i.type||'Outros'),
          'Renda Fixa','Renda Variável','Tesouro','CDB','LCI','LCA','FII','Ações','Fundos','Previdência','Cripto'
        ].filter(Boolean))].sort();
        dl.innerHTML=cats.map(c=>`<option value="${esc(c)}">`).join('');
      }
      openModal(modal);
    });
  });

  bindClick('btnEditInvSave', ()=>{
    const err=document.getElementById('ei_error');
    const modal=document.getElementById('modalEditInv');
    const id=modal.dataset.invid;
    const name=(document.getElementById('ei_name').value||'').trim();
    const cat=(document.getElementById('ei_cat').value||'').trim()||'Outros';
    if(!name){err.textContent='Nome é obrigatório.';err.style.display='block';return;}
    const invs=getManualInvs();
    const i=invs.findIndex(x=>x.id===id);
    if(i<0){err.textContent='Investimento não encontrado.';err.style.display='block';return;}
    invs[i]={...invs[i],name,category:cat};
    saveManualInvs(invs);
    closeModal(modal);
    normalizeData(); populateFilters();
    renderInvestments(); renderOverview();
  });

  bindClick('btnEditInvCancel', ()=>{
    closeModal(document.getElementById('modalEditInv'));
  });

  // Excluir investimento
  document.querySelectorAll('.btn-del-inv').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.invid;
      const inv=getManualInvs().find(x=>x.id===id);
      if(!inv) return;
      if(!confirm(`Excluir "${inv.name}" e todo o histórico de valores?`)) return;
      saveManualInvs(getManualInvs().filter(x=>x.id!==id));
      // limpa também a categoria customizada associada
      const cats=getInvCats(); delete cats[id]; saveInvCats(cats);
      normalizeData(); populateFilters();
      renderInvestments(); renderOverview();
    });
  });
}


// Retorna {ok, list, error}. Permite ao consumidor distinguir "API offline"
// de "lista vazia" e exibir feedback adequado ao usuário.
async function loadPluggyCategoryCatalog(){
  try{
    const r = await fetchJson('/api/pluggy/categories');
    if(!r.ok){
      return {ok:false, list:[], error:r.json?.message||`HTTP ${r.status}`};
    }
    const list = Array.isArray(r?.json) ? r.json : (r?.json?.categories || r?.json?.data || []);
    return {ok:true, list};
  }catch(e){
    return {ok:false, list:[], error:e.message||'Erro de rede'};
  }
}
function flattenPluggyCategories(nodes, out=[]){
  if(!Array.isArray(nodes)) return out;
  for(const n of nodes){
    if(!n) continue;
    const name = n.name || n.description || n.label || n.title;
    if(name) out.push(name);
    const kids = n.children || n.items || n.subcategories || n.subCategories;
    if(kids) flattenPluggyCategories(kids, out);
  }
  return out;
}

// ─── Render: Editar ──────────────────────────────────────────────────────────
function renderEditar(){
  const allAccounts=[...APP.data.accounts,...APP.data.cards];
  const customNames=getCustomNames();
  const catGroups=getCatGroups();
  const search=APP.edit.search||'';

  const allCats = [...new Set(APP.data.transactions.filter(t => !isInvestTx(t) && (t.isCard || (!t.isCard && !String(t.accountType||'').toLowerCase().includes('credit') && !String(t.accountType||'').toLowerCase().includes('card')))).map(t => t.nativeCategory || t.categoryFinal).filter(Boolean))].sort();

  // Group names already defined
  const groupNames=catGroups.map(g=>g.groupName);

  const editTxs=APP.data.transactions.slice(0,100);

  document.getElementById('editar').innerHTML=`

<!-- ── Section 1: Account/card names ───────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Renomear contas e cartões</div>
  <div class="csub">Busque ou clique na conta para selecionar e renomear</div>

  ${(()=>{
    const saved=getCustomNames();
    const entries=Object.entries(saved);
    return entries.length?`<div style="display:grid;gap:8px;margin-bottom:20px">${entries.map(([id,custom])=>{
      const acc=allAccounts.find(a=>a.id===id);
      const orig=acc?(acc.name||acc.marketingName||acc.number||id):id;
      const isCard=acc?(!!(acc.creditData||String(acc.type||'').toLowerCase().includes('credit'))):false;
      const co=isCard?'var(--expense)':'var(--balance)';
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--s0);border:1px solid var(--border);border-radius:12px">
        <div style="flex:1;min-width:0">
          <span style="font-weight:600;font-size:13px;color:var(--text)">${esc(custom)}</span>
          <span style="font-size:11px;color:var(--muted);margin-left:8px">← <em>${esc(orig)}</em></span>
        </div>
        <span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33;flex-shrink:0">${isCard?'💳':'🏦'} ${esc(custom)}</span>
        <button class="btn btn-del-accname" data-id="${esc(id)}" style="flex-shrink:0;font-size:12px;padding:7px 11px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">✕ Remover</button>
      </div>`;
    }).join('')}</div>`:`<div class="empty mb16">Nenhuma conta renomeada ainda.</div>`;
  })()}

  <div style="padding:18px;background:var(--s0);border:1px solid var(--border2);border-radius:12px">
    <div style="font-weight:500;font-size:13px;color:var(--text);margin-bottom:14px">✏️ Selecionar e renomear</div>
    <div style="margin-bottom:12px">
      <div class="flbl">Buscar conta ou cartão</div>
      <input id="accRenameSearch" class="input" placeholder="🔍 Digite para filtrar…" style="padding:9px 12px;font-size:13px;max-width:320px"/>
    </div>
    <div class="flbl" style="margin-bottom:6px">Ou clique na conta abaixo</div>
    <div id="accRenameCloud" style="display:flex;flex-wrap:wrap;gap:7px;padding:14px;background:var(--s1);border:1px solid var(--border);border-radius:10px;min-height:50px;margin-bottom:16px">
      ${allAccounts.map((acc,i)=>{
        const isCard=!!(acc.creditData||String(acc.type||'').toLowerCase().includes('credit'));
        const co=isCard?'var(--expense)':'var(--balance)';
        const coHex=isCard?'ff4d6d':'4fa3fb';
        const saved=getCustomNames()[acc.id];
        const label=saved||accountLabel(acc);
        const sz=['11px','12.5px','13px','11.5px','12px','13.5px','11px'][i%7];
        return `<span class="acc-cloud-item" data-accid="${esc(acc.id)}" style="cursor:pointer;padding:6px 13px;border-radius:999px;font-size:${sz};font-weight:500;background:#${coHex}18;color:${co};border:1.5px solid #${coHex}40;transition:all .15s;user-select:none">${isCard?'💳 ':'🏦 '}${esc(label)}${saved?` <em style="font-size:9px;opacity:.5">(${esc(acc.name||acc.id)})</em>`:''}</span>`;
      }).join('')}
    </div>
    <div id="accRenameForm" style="display:none;padding:14px;background:var(--s2);border:1px solid var(--border2);border-radius:10px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Conta selecionada:</div>
      <div id="accRenameChip" style="margin-bottom:12px"></div>
      <div class="flbl">Novo nome</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="accRenameValue" class="input" placeholder="Digite o novo nome" style="padding:9px 12px;font-size:13px;flex:1;min-width:160px"/>
        <button id="btnSaveAccName" class="btn primary" style="font-size:13px;padding:9px 16px">Salvar</button>
        <button id="btnCancelAccName" class="btn" style="font-size:13px;padding:9px 12px">Cancelar</button>
      </div>
    </div>
  </div>
</div>



<!-- ── Section 1b: Category rename ─────────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Editar categorias</div>
  <div class="csub">Busque ou clique na nuvem para selecionar uma categoria usada nas abas Financeiro e Cartões</div>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
    <div style="flex:1;min-width:180px">
      <div class="flbl">Buscar categoria</div>
      <input id="catRenameSearch" class="input" placeholder="🔍 Digite para filtrar…" style="padding:9px 12px;font-size:13px;max-width:320px"/>
    </div>
  </div>
  <div class="flbl" style="margin-bottom:6px">Ou clique em uma categoria em uso abaixo</div>
  <div id="catRenameCloud" style="display:flex;flex-wrap:wrap;gap:7px;padding:14px;background:var(--s1);border:1px solid var(--border);border-radius:10px;min-height:60px;margin-bottom:16px">
    ${allCats.map((cat,i)=>{
      const co=catColor(cat), saved=getCatNames()[cat];
      const sz=['10.5px','12px','13.5px','11.5px','14px','11px','12.5px'][i%7];
      return `<span class="cat-cloud-item" data-cat="${esc(cat)}" style="cursor:pointer;padding:6px 13px;border-radius:999px;font-size:${sz};font-weight:500;background:${co}18;color:${co};border:1.5px solid ${co}40;transition:all .15s;user-select:none">${esc(saved||cat)}${saved?` <em style="font-size:9.5px;opacity:.5">(${esc(cat)})</em>`:''}</span>`;
    }).join('')}
  </div>
  <div id="catRenameForm" style="display:none;padding:14px;background:var(--s2);border:1px solid var(--border2);border-radius:10px">
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Categoria selecionada:</div>
    <div id="catRenameChip" style="margin-bottom:12px"></div>
    <div class="flbl">Novo nome</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="catRenameValue" class="input" placeholder="Digite o novo nome…" style="padding:9px 12px;font-size:13px;flex:1;min-width:160px"/>
      <button id="btnSaveCatName" class="btn primary" style="font-size:13px;padding:9px 16px">Salvar</button>
      <button id="btnCancelCatName" class="btn" style="font-size:13px;padding:9px 12px">Cancelar</button>
    </div>
  </div>
</div>
<!-- ── Section 2: Category groups ──────────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Agrupar categorias</div>
  <div class="csub">Combine múltiplas categorias em um único rótulo — aplicado automaticamente em todo o dashboard</div>

  ${catGroups.length?`<div style="display:grid;gap:8px;margin-bottom:20px">
    ${catGroups.map((g,gi)=>`
    <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;background:var(--s0);border:1px solid var(--border);border-radius:12px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-weight:600;font-size:13px;color:var(--text)">${esc(g.groupName)}</span>
          <span style="font-size:11px;color:var(--muted)">${(g.categories||[]).length} categorias agrupadas</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${(g.categories||[]).map(c=>{const co=catColor(c);return`<span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33;font-size:10.5px">${esc(c)}</span>`}).join('')}
          <span style="font-size:10.5px;color:var(--muted);display:flex;align-items:center">→ <strong style="color:var(--accent);margin-left:4px">${esc(g.groupName)}</strong></span>
        </div>
      </div>
      <button class="btn btn-del-group" data-gi="${gi}" style="flex-shrink:0;font-size:12px;padding:8px 12px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">✕ Remover</button>
    </div>`).join('')}
  </div>`:`<div class="empty mb16">Nenhum grupo criado ainda.</div>`}

  <div style="padding:18px;background:var(--s0);border:1px solid var(--border2);border-radius:12px">
    <div style="font-weight:500;font-size:13px;color:var(--text);margin-bottom:14px">+ Criar novo grupo</div>
    <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="flbl">Nome do grupo</div>
        <input id="newGroupName" class="input" placeholder="Ex: Alimentação, Lazer…" style="padding:10px 12px;font-size:13px"/>
      </div>
      <div style="flex:2;min-width:240px">
        <div class="flbl">Selecione as categorias em uso nas abas Financeiro e Cartões para unificar</div>
        <div id="groupCatPicker" style="display:flex;flex-wrap:wrap;gap:5px;padding:12px;background:var(--s1);border:1px solid var(--border);border-radius:10px;max-height:160px;overflow-y:auto">
          ${allCats.map(c=>{const co=catColor(c);return`
          <label class="grp-lbl" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;padding:5px 9px;border-radius:7px;border:1px solid transparent;transition:all .12s" data-cat="${esc(c)}">
            <input type="checkbox" class="grp-chk" value="${esc(c)}" style="accent-color:var(--accent);width:12px;height:12px;flex-shrink:0"/>
            <span style="font-size:11.5px;color:${co}">${esc(c)}</span>
          </label>`}).join('')}
        </div>
        <div id="groupSelected" style="margin-top:8px;font-size:11px;color:var(--muted)">Nenhuma selecionada</div>
      </div>
    </div>
    <button id="btnCreateGroup" class="btn primary" style="margin-top:14px;font-size:12px">Criar grupo</button>
  </div>
</div>



<!-- ── Section 4b: Excluded Categories ─────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Categorias excluídas dos totais</div>
  <div class="csub">Transações dessas categorias não serão contabilizadas em Recebido, Gasto ou Fluxo de caixa</div>

  <!-- Current excluded list -->
  ${(()=>{
    const excl=getExclCats();
    if(!excl.length) return '<div class="empty mb16" style="padding:14px;font-size:12px">Nenhuma categoria excluída. As exclusões fixas (Investimentos, Transferências) já são aplicadas automaticamente.</div>';
    // Calcular impacto: quantas transações e valor total por categoria excluída
    const allTxs=APP.data.transactions.filter(t=>!isInvestTx(t));
    return `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
      ${excl.map(c=>{
        const co=catColor(c);
        const catTxs=allTxs.filter(t=>(t.categoryFinal||'').toLowerCase()===c.toLowerCase());
        const total=catTxs.reduce((s,t)=>s+t.amountAbs,0);
        const count=catTxs.length;
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:${co}10;border:1px solid ${co}30">
          <span class="chip" style="background:${co}22;color:${co};border:1px solid ${co}44;flex-shrink:0">${esc(c)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:var(--text);font-weight:500">${count} lançamento${count!==1?'s':''} descartado${count!==1?'s':''} dos totais</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Total excluído: <span style="color:${co};font-family:var(--font-num)">${fmtBRL(total)}</span></div>
          </div>
          <button class="btn-excl-del" data-cat="${esc(c)}" style="background:rgba(255,77,109,.08);border:1px solid rgba(255,77,109,.22);color:var(--expense);border-radius:8px;cursor:pointer;font-size:12px;padding:5px 10px;white-space:nowrap">✕ Remover</button>
        </div>`;
      }).join('')}
      <div style="padding:10px 14px;border-radius:10px;background:var(--s0);border:1px solid var(--border);font-size:12px;color:var(--muted)">
        Total excluído dos cálculos: <span style="color:var(--expense);font-family:var(--font-num);font-weight:600">${fmtBRL(excl.reduce((s,c)=>{const t=allTxs.filter(tx=>(tx.categoryFinal||'').toLowerCase()===c.toLowerCase()).reduce((a,tx)=>a+tx.amountAbs,0);return s+t;},0))}</span>
        &nbsp;·&nbsp; ${excl.reduce((s,c)=>s+allTxs.filter(tx=>(tx.categoryFinal||'').toLowerCase()===c.toLowerCase()).length,0)} transações no total
      </div>
    </div>`;
  })()}

  <!-- Add exclusion -->
  <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;padding:14px;background:var(--s0);border:1px solid var(--border2);border-radius:12px">
    <div style="flex:1;min-width:180px">
      <div class="flbl">Selecionar categoria</div>
      <select id="exclCatSel" class="fsel" style="width:100%;font-size:13px;padding:9px 12px">
        <option value="">-- escolha --</option>
        ${allUniqueCats().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
    </div>
    <button id="btnAddExcl" class="btn primary" style="font-size:13px;padding:9px 18px;white-space:nowrap">＋ Excluir categoria</button>
  </div>
</div>

<!-- ── Section 4: Automatic Rules ───────────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Regras automáticas de categoria</div>
  <div class="csub">Palavras-chave na descrição → atribuição automática de categoria</div>

  <!-- Existing rules list -->
  ${(()=>{
    const rules=getRules();
    if(!rules.length) return '<div class="empty mb16">Nenhuma regra criada ainda.</div>';
    return `<div style="display:grid;gap:8px;margin-bottom:20px">
      ${rules.map((r,i)=>`
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--s0);border:1px solid var(--border);border-radius:12px">
          <div style="flex:1;min-width:0">
            <span style="font-weight:600;font-size:13px;color:var(--text)">${esc(r.keyword)}</span>
            <span style="font-size:11px;color:var(--muted);margin-left:8px">→</span>
            <span class="chip" style="background:${catColor(r.category)}1a;color:${catColor(r.category)};border:1px solid ${catColor(r.category)}33;margin-left:6px">${esc(r.category)}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="fsel btn-rule-cat" data-idx="${i}" style="font-size:11px;padding:5px 8px">
              ${allUniqueCats().map(c=>`<option value="${esc(c)}" ${c===r.category?'selected':''}>${esc(c)}</option>`).join('')}
            </select>
            <button class="btn btn-del-rule" data-idx="${i}" style="font-size:12px;padding:7px 11px;background:rgba(255,77,109,.08);color:var(--expense);border-color:rgba(255,77,109,.22)">✕</button>
          </div>
        </div>`).join('')}
    </div>`;
  })()}

  <!-- Add new rule -->
  <div style="padding:18px;background:var(--s0);border:1px solid var(--border2);border-radius:12px">
    <div style="font-weight:500;font-size:13px;color:var(--text);margin-bottom:14px">Criar nova regra</div>
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <div>
        <div class="flbl">Palavra-chave na descrição</div>
        <input id="ruleKeyword" class="input" placeholder="Ex: UBER, NETFLIX, CAIXA" style="padding:9px 12px;font-size:13px;min-width:200px"/>
      </div>
      <div>
        <div class="flbl">Categoria</div>
        <select id="ruleCat" class="fsel" style="font-size:13px;padding:9px 12px">
          ${allUniqueCats().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div>
        <div class="flbl">Prioridade</div>
        <select id="rulePriority" class="fsel" style="font-size:13px;padding:9px 12px">
          <option value="high">Alta (frente da fila)</option>
          <option value="normal" selected>Normal (fim da fila)</option>
        </select>
      </div>
      <button id="btnAddRule" class="btn primary" style="font-size:13px;white-space:nowrap;padding:9px 18px">＋ Adicionar regra</button>
    </div>
    <div id="ruleMsg" style="margin-top:10px;font-size:12px;color:var(--accent);display:none"></div>
  </div>
</div>

<!-- ── Section: Backup / Restauração ──────────────────────────────── -->
<div class="card mb20">
  <div class="ctitle">Backup e restauração</div>
  <div class="csub">Exporte ou restaure todas as suas categorizações, regras, cartões, lançamentos e investimentos manuais</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div style="padding:16px;background:var(--s0);border:1px solid var(--border);border-radius:10px">
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">📤 Exportar dados</div>
      <div style="font-size:11.5px;color:var(--muted);margin-bottom:12px">Gera um arquivo JSON com todas as configurações e dados manuais. Útil para mover entre máquinas ou guardar como backup.</div>
      <button id="btnExportData" class="btn primary" style="font-size:12px;padding:8px 16px">Baixar backup .json</button>
    </div>

    <div style="padding:16px;background:var(--s0);border:1px solid var(--border);border-radius:10px">
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">📥 Restaurar dados</div>
      <div style="font-size:11.5px;color:var(--muted);margin-bottom:12px">Carrega um backup .json. <strong style="color:var(--expense)">Substitui</strong> os dados atuais. Recomendado exportar antes.</div>
      <input id="importFile" type="file" accept=".json,application/json" style="display:none"/>
      <button id="btnImportData" class="btn" style="font-size:12px;padding:8px 16px">Escolher arquivo...</button>
    </div>
  </div>

  <div style="margin-top:14px;padding:12px;background:var(--s0);border:1px solid var(--border);border-radius:8px;font-size:11.5px;color:var(--muted);line-height:1.5">
    <strong style="color:var(--dim)">ℹ️ Sobre o armazenamento:</strong> Desde a migração para SQLite, seus dados ficam no servidor (arquivo <code>data.db</code> na pasta do projeto). Mesmo se você trocar a porta ou apagar o cache do navegador, os dados permanecem. O navegador mantém uma cópia local como cache, então a app continua funcionando se o servidor cair temporariamente (modo somente local).
  </div>
</div>`;

  // ── Listeners ─────────────────────────────────────────────────────────────

  // ── Account rename cloud listeners ────────────────────────────────────────
  const _accCloud=document.getElementById('accRenameCloud');
  const _accForm=document.getElementById('accRenameForm');
  const _accChip=document.getElementById('accRenameChip');
  const _accVal=document.getElementById('accRenameValue');
  let _selAccId=null;

  document.getElementById('accRenameSearch')?.addEventListener('input',e=>{
    const low=e.target.value.toLowerCase();
    document.querySelectorAll('#accRenameCloud .acc-cloud-item').forEach(el=>{
      el.style.display=!low||el.textContent.toLowerCase().includes(low)?'':'none';
    });
  });

  document.querySelectorAll('.acc-cloud-item').forEach(el=>{
    el.addEventListener('click',()=>{
      _selAccId=el.dataset.accid;
      const names=getCustomNames();
      const acc=([...APP.data.accounts,...APP.data.cards]).find(a=>a.id===_selAccId);
      const orig=acc?(acc.name||acc.marketingName||acc.number||_selAccId):_selAccId;
      const isCard=acc?(!!(acc.creditData||String(acc.type||'').toLowerCase().includes('credit'))):false;
      const co=isCard?'var(--expense)':'var(--balance)';
      if(_accChip) _accChip.innerHTML=`<span class="chip" style="background:${co}1a;color:${co};border:1px solid ${co}33">${isCard?'💳':'🏦'} ${esc(orig)}</span>`;
      if(_accVal) _accVal.value=names[_selAccId]||'';
      if(_accForm) _accForm.style.display='block';
      _accVal?.focus();
    });
  });

  bindClick('btnSaveAccName', ()=>{
    if(!_selAccId) return;
    const v=_accVal?.value?.trim();
    const names=getCustomNames();
    if(v) names[_selAccId]=v; else delete names[_selAccId];
    saveCustomNames(names); normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderEditar();
  });

  bindClick('btnCancelAccName', ()=>{
    if(_accForm) _accForm.style.display='none'; _selAccId=null;
  });

  document.getElementById('accRenameValue')?.addEventListener('keydown',e=>{
    if(e.key==='Enter') document.getElementById('btnSaveAccName')?.click();
  });

  document.querySelectorAll('.btn-del-accname').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const names=getCustomNames(); delete names[btn.dataset.id];
      saveCustomNames(names); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });
  });


  // ── Category rename cloud listeners ──────────────────────────────────────
  (() => {
    let selCat=null;
    const cloud=document.getElementById('catRenameCloud');
    const form=document.getElementById('catRenameForm');
    const chipEl=document.getElementById('catRenameChip');
    const inp=document.getElementById('catRenameValue');
    const srch=document.getElementById('catRenameSearch');
    if(!cloud) return;

    const selectCat=cat=>{
      selCat=cat;
      const co=catColor(cat);
      const saved=getCatNames()[cat]||'';
      if(chipEl) chipEl.innerHTML=`<span style="padding:5px 13px;border-radius:999px;background:${co}1a;color:${co};border:1.5px solid ${co}40;font-weight:600;font-size:13px">${esc(saved||cat)}</span><span style="font-size:11px;color:var(--muted);margin-left:8px">original: <em>${esc(cat)}</em></span>`;
      if(inp) inp.value=saved;
      if(form) form.style.display='block';
      document.querySelectorAll('.cat-cloud-item').forEach(el=>{
        const active=el.dataset.cat===cat;
        el.style.opacity=active?'1':'.4';
        el.style.transform=active?'scale(1.08)':'';
        el.style.fontWeight=active?'700':'500';
      });
      inp?.focus();
    };

    cloud.addEventListener('click',e=>{
      const item=e.target.closest('.cat-cloud-item');
      if(item) selectCat(item.dataset.cat);
    });

    srch?.addEventListener('input',()=>{
      const low=srch.value.toLowerCase().trim();
      document.querySelectorAll('.cat-cloud-item').forEach(el=>{
        el.style.display=!low||el.dataset.cat.toLowerCase().includes(low)?'':'none';
      });
    });

    bindClick('btnSaveCatName', ()=>{
      if(!selCat){alert('Selecione uma categoria.');return;}
      const v=(inp?.value||'').trim();
      const names=getCatNames();
      if(v) names[selCat]=v; else delete names[selCat];
      saveCatNames(names); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });

    bindClick('btnCancelCatName', ()=>{
      selCat=null;
      if(form) form.style.display='none';
      document.querySelectorAll('.cat-cloud-item').forEach(el=>{
        el.style.opacity=''; el.style.transform=''; el.style.fontWeight='';
      });
    });

    document.getElementById('catRenameValue')?.addEventListener('keydown',e=>{
      if(e.key==='Enter') document.getElementById('btnSaveCatName')?.click();
    });

    document.querySelectorAll('.btn-del-catname').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const names=getCatNames(); delete names[btn.dataset.cat];
        saveCatNames(names); normalizeData(); populateFilters();
        renderOverview(); renderFinance(); renderEditar();
      });
    });
  })();
  // Delete cat group
  document.querySelectorAll('.btn-del-group').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const groups=getCatGroups(); groups.splice(Number(btn.dataset.gi),1);
      saveCatGroups(groups); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });
  });

  // Checkbox hover styling + counter update
  document.querySelectorAll('.grp-chk').forEach(chk=>{
    chk.addEventListener('change',()=>{
      const checked=[...document.querySelectorAll('.grp-chk:checked')].map(c=>c.value);
      const sel=document.getElementById('groupSelected');
      if(sel) sel.textContent=checked.length?`${checked.length} selecionada(s): ${checked.join(', ')}`:'Nenhuma selecionada';
      const lbl=chk.closest('.grp-lbl');
      if(lbl){
        lbl.style.background=chk.checked?'rgba(6,247,180,.1)':'transparent';
        lbl.style.borderColor=chk.checked?'rgba(6,247,180,.3)':'transparent';
      }
    });
  });

  // Create group
  bindClick('btnClearGroupSelection', ()=>{document.querySelectorAll('#groupCatCloud .grp-chk').forEach(i=>i.checked=false); const out=document.getElementById('groupSelected'); const chips=document.getElementById('groupSelectedChips'); const inp=document.getElementById('newGroupName'); if(out) out.textContent='Nenhuma selecionada'; if(chips) chips.innerHTML='<span style="font-size:11px;color:var(--muted)">Nenhuma categoria selecionada.</span>'; if(inp) inp.value='';});
  bindClick('btnCreateGroup', ()=>{
    const name=document.getElementById('newGroupName')?.value?.trim();
    if(!name){alert('Informe o nome do grupo.');return;}
    const checked=[...document.querySelectorAll('.grp-chk:checked')].map(c=>c.value);
    if(checked.length<2){alert('Selecione ao menos 2 categorias para agrupar.');return;}
    const groups=getCatGroups();
    // remove these cats from other groups to avoid duplicates
    groups.forEach(g=>{g.categories=(g.categories||[]).filter(c=>!checked.includes(c))});
    groups.push({groupName:name,categories:checked});
    saveCatGroups(groups.filter(g=>(g.categories||[]).length>0));
    normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderEditar();
  });

  // Change tx category
  document.querySelectorAll('.tx-cat-sel').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const manual=getManual();
      manual[sel.dataset.txid]=sel.value;
      saveManual(manual); normalizeData(); populateFilters();
      renderOverview(); renderFinance();
      // highlight the row briefly
      const row=sel.closest('tr');
      if(row){row.style.background='rgba(6,247,180,.06)'; setTimeout(()=>{row.style.background=''},800);}
    });
  });

  // Reset single tx category
  document.querySelectorAll('.btn-reset-one').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const manual=getManual(); delete manual[btn.dataset.txid];
      saveManual(manual); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });
  });

  // Search — DOM filter, no rerender
  const _editSrch=document.getElementById('editSearch');
  if(_editSrch){
    let _editTimer=null;
    _editSrch.addEventListener('input',e=>{
      e.stopPropagation();
      clearTimeout(_editTimer);
      _editTimer=setTimeout(()=>{
        const low=_editSrch.value.toLowerCase().trim();
        document.querySelectorAll('#editar .txtable tbody tr[data-txt]').forEach(row=>{
          row.style.display=!low||row.dataset.txt.includes(low)?'':'none';
        });
      },120);
    });
  }



  // ── Excluded categories listeners ────────────────────────────────────────
  bindClick('btnAddExcl', ()=>{
    const sel=document.getElementById('exclCatSel');
    const cat=sel?.value?.trim();
    if(!cat){alert('Selecione uma categoria.');return;}
    const excl=getExclCats();
    if(excl.includes(cat)){alert('Categoria já está na lista.');return;}
    excl.push(cat);
    saveExclCats(excl); normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderEditar();
  });

  document.querySelectorAll('.btn-excl-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const excl=getExclCats().filter(c=>c!==btn.dataset.cat);
      saveExclCats(excl); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });
  });
  // ── Rules listeners ──────────────────────────────────────────────────────
  bindClick('btnAddRule', ()=>{
    const kw=document.getElementById('ruleKeyword')?.value?.trim();
    const cat=document.getElementById('ruleCat')?.value;
    const priority=document.getElementById('rulePriority')?.value;
    const msg=document.getElementById('ruleMsg');
    if(!kw){if(msg){msg.textContent='Informe uma palavra-chave.';msg.style.display='block';msg.style.color='var(--expense)';}return;}
    const rules=getRules();
    if(rules.some(r=>r.keyword.toLowerCase()===kw.toLowerCase())){
      if(msg){msg.textContent='Já existe uma regra com essa palavra-chave.';msg.style.display='block';msg.style.color='var(--expense)';}return;
    }
    const newRule={keyword:kw,category:cat};
    if(priority==='high') rules.unshift(newRule); else rules.push(newRule);
    saveRules(rules); normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderEditar();
  });

  document.querySelectorAll('.btn-del-rule').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const rules=getRules(); rules.splice(Number(btn.dataset.idx),1);
      saveRules(rules); normalizeData(); populateFilters();
      renderOverview(); renderFinance(); renderEditar();
    });
  });

  document.querySelectorAll('.btn-rule-cat').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const rules=getRules(); rules[Number(sel.dataset.idx)].category=sel.value;
      saveRules(rules); normalizeData(); populateFilters();
      renderOverview(); renderFinance();
      const row=sel.closest('div[style]');
      if(row){row.style.transition='background .3s';row.style.background='rgba(6,247,180,.07)';setTimeout(()=>{row.style.background=''},800);}
    });
  });

  // ruleKeyword Enter shortcut
  document.getElementById('ruleKeyword')?.addEventListener('keydown',e=>{
    if(e.key==='Enter') document.getElementById('btnAddRule')?.click();
  });
  // Reset all manual categories
  bindClick('btnResetCats', ()=>{
    if(!confirm('Apagar todas as categorizações manuais e voltar ao padrão. Confirmar?')) return;
    saveManual({}); normalizeData(); populateFilters();
    renderOverview(); renderFinance(); renderEditar();
  });

  // Export / Import backup
  bindClick('btnExportData', ()=>{
    exportAllStorage();
  });
  const _importFile=document.getElementById('importFile');
  bindClick('btnImportData', ()=>{
    _importFile?.click();
  });
  _importFile?.addEventListener('change',async e=>{
    const f=e.target.files?.[0];
    if(!f) return;
    await importAllStorage(f);
    e.target.value=''; // reset input
  });

  // ── Group search + checkbox listeners (movidos do escopo global) ──────────
  const groupSearch = document.getElementById('groupCatSearch');
  if(groupSearch){
    groupSearch.addEventListener('input',()=>{
      const low = groupSearch.value.toLowerCase().trim();
      document.querySelectorAll('#groupCatCloud .group-cloud-item').forEach(lbl=>{
        const cat = (lbl.dataset.cat||'').toLowerCase();
        lbl.style.display = !low || cat.includes(low) ? 'inline-flex' : 'none';
      });
    });
  }
  document.querySelectorAll('#groupCatCloud .grp-chk').forEach(ch=>ch.addEventListener('change',()=>{
    const vals=[...document.querySelectorAll('#groupCatCloud .grp-chk:checked')].map(i=>i.value);
    const out=document.getElementById('groupSelected');
    const chips=document.getElementById('groupSelectedChips');
    if(out) out.textContent = vals.length ? `${vals.length} categoria(s) selecionada(s)` : 'Nenhuma selecionada';
    if(chips) chips.innerHTML = vals.length ? vals.map(v=>{ const co=catColor(v); return `<span class="chip" style="margin:0 4px 4px 0;background:${co}1a;color:${co};border:1px solid ${co}33">${esc(v)}</span>`; }).join('') : '<span style="font-size:11px;color:var(--muted)">Nenhuma categoria selecionada.</span>';
  }));
}

// ─── Render: Connections ─────────────────────────────────────────────────────
function renderConnections(){
  document.getElementById('connections').innerHTML=`
<div class="grid g2">
  <div class="card">
    <div class="ctitle">Saúde da integração</div>
    <div class="csub">Status da conexão com a API Pluggy</div>
    <div class="litem"><div><div class="lname">API Pluggy</div><div class="lmeta">${APP.raw.health?.ok?'Conectada e operacional':'Falha na conexão'}</div></div>${badge2(APP.raw.health?.ok?'OK':'Falha',APP.raw.health?.ok)}</div>
    <div class="litem"><div><div class="lname">Base URL</div><div class="lmeta">${esc(APP.raw.health?.baseUrl||'-')}</div></div></div>
    <div class="litem"><div><div class="lname">Itens configurados</div><div class="lmeta">${(APP.raw.settings?.itemIds||[]).length} item(s)</div></div></div>
  </div>
  <div class="card">
    <div class="ctitle">Itens conectados</div>
    <div class="csub">${(APP.raw.items||[]).length} item(s) Pluggy</div>
    ${(APP.raw.items||[]).length?`<div>${(APP.raw.items).map(item=>`<div class="litem">
      <div><div class="lname">${esc(item.connector?.name||item.id||'Item')}</div>
      <div class="lmeta">ID: ${esc(item.id||'-')} · ${esc(item.status||(item.unavailable?'indisponível':'ativo'))}</div>
      ${item.error?`<div class="lmeta c-e">${esc(item.error)}</div>`:''}</div>
      ${badge2(item.unavailable?'Indisponível':'Ativo',!item.unavailable)}
    </div>`).join('')}</div>`:empty('Sem itens configurados.')}
  </div>
</div>`;
}

// ─── Render: Admin ───────────────────────────────────────────────────────────
function renderAdmin(){
  const s=APP.raw.settings||{itemIds:[]};
  // Estatísticas do KV para o card de Backup
  let kvKeys=0, kvBytes=0;
  try {
    for (const k of ALL_STORAGE_KEYS) {
      const v = storageGet(k);
      if (v !== null && v !== undefined) {
        kvKeys++;
        kvBytes += JSON.stringify(v).length;
      }
    }
  } catch {}
  const kvSize = kvBytes < 1024 ? `${kvBytes} B`
              : kvBytes < 1024*1024 ? `${(kvBytes/1024).toFixed(1)} KB`
              : `${(kvBytes/1024/1024).toFixed(2)} MB`;

  document.getElementById('admin').innerHTML=`
<div class="grid g2">
  <div class="card">
    <div class="ctitle">Configuração da API</div>
    <div class="csub">Credenciais e parâmetros da integração Pluggy</div>
    <div class="flrow">
      <div><div class="flbl">Client ID</div><input id="clientId" class="input" value="${esc(s.clientId||'')}"/></div>
      <div><div class="flbl">Client Secret</div><input id="clientSecret" class="input" type="password" placeholder="Deixe em branco para manter"/></div>
      <div><div class="flbl">Client User ID</div><input id="clientUserId" class="input" value="${esc(s.clientUserId||'')}"/></div>
      <div><div class="flbl">Webhook URL</div><input id="webhookUrl" class="input" value="${esc(s.webhookUrl||'')}"/></div>
      <div><div class="flbl">Item IDs (um por linha)</div><textarea id="itemIds" class="textarea">${esc((s.itemIds||[]).join('\n'))}</textarea></div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Resumo</div>
    <div class="csub">Estado atual da configuração</div>
    <div class="litem"><div><div class="lname">Client ID</div><div class="lmeta">${esc(s.clientId||'Não configurado')}</div></div></div>
    <div class="litem"><div><div class="lname">Client Secret</div><div class="lmeta">${esc(s.clientSecretMasked||'Não configurado')}</div></div></div>
    <div class="litem"><div><div class="lname">Item IDs</div><div class="lmeta">${(s.itemIds||[]).length} item(s)</div></div></div>
    <div class="mt16">
      <button class="btn primary" id="openConnectBtn">Conectar banco</button>
      <button class="btn" id="newTokenBtn" style="margin-left:8px">Gerar token manual</button>
      <div id="tokenBox" style="margin-top:12px;font-size:12px;color:var(--muted);word-break:break-all"></div>
    </div>
  </div>
</div>

<div class="card mt16" style="margin-top:20px">
  <div class="ctitle">💾 Backup e restauração</div>
  <div class="csub">Exporta/importa todos os dados gerenciados pelo app: regras de categorização, nomes customizados, grupos, investimentos manuais (com snapshots), transações manuais, cartões manuais. <b>Não inclui credenciais nem dados da Pluggy</b> — esses são externos.</div>
  <div class="litem" style="margin-top:14px">
    <div><div class="lname">Chaves no KV</div><div class="lmeta">${kvKeys} de ${ALL_STORAGE_KEYS.length} chaves com dados &middot; ${kvSize} no total</div></div>
  </div>
  <div class="mt16" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <button class="btn primary" id="adminExportBtn">⬇ Baixar backup (JSON)</button>
    <button class="btn" id="adminImportBtn">⬆ Restaurar de arquivo&hellip;</button>
    <input id="adminImportFile" type="file" accept=".json,application/json" style="display:none"/>
    <span id="adminBackupStatus" style="font-size:12px;color:var(--muted)"></span>
  </div>
  <div style="margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.5">
    O backup baixa um arquivo <code>finboard-backup-AAAA-MM-DD-HH-MM-SS.json</code>. Guarde junto com o <code>data.db</code> se for migrar de máquina. A restauração <b>substitui</b> os dados atuais &mdash; pede confirmação antes.
  </div>
</div>`;
  bindClick('openConnectBtn', openPluggyConnect);
  bindClick('newTokenBtn', generateConnectToken);
  bindClick('adminExportBtn', () => {
    try {
      exportAllStorage();
      const el = document.getElementById('adminBackupStatus');
      if (el) { el.textContent = '✓ Backup baixado'; setTimeout(()=>{ el.textContent=''; }, 4000); }
    } catch (e) {
      alert('Falha ao gerar backup: ' + e.message);
    }
  });
  bindClick('adminImportBtn', () => {
    document.getElementById('adminImportFile')?.click();
  });
  const inputFile = document.getElementById('adminImportFile');
  if (inputFile) {
    if (inputFile._handler) inputFile.removeEventListener('change', inputFile._handler);
    inputFile._handler = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const el = document.getElementById('adminBackupStatus');
      if (el) el.textContent = 'Importando&hellip;';
      try {
        await importAllStorage(f);
        if (el) { el.textContent = '✓ Importação concluída'; setTimeout(()=>{ el.textContent=''; }, 4000); }
      } catch (err) {
        if (el) el.textContent = '';
        alert('Falha ao importar: ' + err.message);
      }
      e.target.value = '';
    };
    inputFile.addEventListener('change', inputFile._handler);
  }
}


export { renderOverview, renderFinance, renderCreditCards, renderInvestments, bindInvManualListeners, loadPluggyCategoryCatalog, flattenPluggyCategories, renderEditar, renderConnections, renderAdmin };
