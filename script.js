(function(){
  "use strict";

  const LOW_STOCK_METERS = 10;
  const STORAGE_KEY = "factory-data";

  let state = {
    factoryName: "مصنع الأقمشة",
    fabrics: [],   // {id, code, color, total, used, image}
    products: [],  // {id, code, name, cut, readyQty(units already made & in stock), fabricId(nullable), metersPerPiece, price, image}
    orders: []     // {id, name, date, items:[{id, productId, ordered, produced, sold}]}
  };

  const IMAGE_SEARCH_ENDPOINT = "https://commons.wikimedia.org/w/api.php";

  let view = "dashboard"; // dashboard | fabrics | products | orders | orderDetail
  let activeOrderId = null;
  let modal = null; // {title, fields, submitLabel, onSubmit}
  let confirmTarget = null; // {message, onConfirm}
  let searchQuery = "";

  // ---------- password lock / cross-device sync ----------
  let authState = "checking"; // checking | needsSetup | needsLogin | unlocked
  let authError = "";
  let authBusy = false;
  let currentUid = null;
  let applyingRemoteUpdate = false; // guards against re-uploading a change we just received
  let changePasswordModal = false;
  let changePasswordError = "";
  let changePasswordBusy = false;

  // ---------- "search by photo" (reverse match against saved fabric/product images) ----------
  let imageMatchPanelOpen = { fabrics:false, products:false };
  let imageMatchQueryImage = { fabrics:null, products:null };   // dataURL or URL currently loaded as the query photo
  let imageMatchResults = { fabrics:null, products:null };       // null = inactive; else [{id, pct}] sorted best-first
  let imageMatchStatusMsg = { fabrics:'', products:'' };

  const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);

  function todayLabel(){
    try{
      return new Date().toLocaleDateString('ar-EG', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    }catch(e){ return ''; }
  }

  function fmt(n){
    const v = Math.round((Number(n)||0) * 100) / 100;
    return v.toLocaleString('en-US');
  }

  function waitForAppSync(){
    return new Promise(resolve=>{
      if(window.AppSync) return resolve();
      window.addEventListener("appsync-ready", ()=>resolve(), { once:true });
    });
  }

  async function boot(){
    // show cached local data instantly (if any) while we check auth in the background
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw) state = Object.assign(state, JSON.parse(raw));
    }catch(e){ /* ignore */ }

    await waitForAppSync();

    if(!window.AppSync){
      // Firebase not configured yet — behave exactly like the plain local-only app
      authState = "unlocked";
      render();
      return;
    }

    let hasPassword = false;
    try{ hasPassword = await window.AppSync.checkHasPassword(); }
    catch(e){ authError = e.message || "تعذر الاتصال، تحقق من الإنترنت"; }

    window.AppSync.onReady(async (user) => {
      if(user){
        currentUid = user.uid;
        authError = "";
        const remote = await window.AppSync.loadData(user.uid);
        if(remote) state = Object.assign(state, remote);
        else await window.AppSync.saveData(user.uid, state); // first login: seed the cloud with local data
        authState = "unlocked";
        render();
        window.AppSync.subscribe(user.uid, (remoteState) => {
          applyingRemoteUpdate = true;
          state = Object.assign(state, remoteState);
          try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
          render();
          applyingRemoteUpdate = false;
        });
      } else {
        currentUid = null;
        authState = hasPassword ? "needsLogin" : "needsSetup";
        render();
      }
    });

    authState = hasPassword ? "needsLogin" : "needsSetup";
    render();
  }

  async function save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){
      showToast("تعذر حفظ البيانات محليًا");
    }
    if(currentUid && !applyingRemoteUpdate){
      try{
        await window.AppSync.saveData(currentUid, state);
      }catch(e){
        showToast("اتحفظت البيانات على الجهاز، بس تعذرت المزامنة (تحقق من الإنترنت)");
      }
    }
  }

  let toastTimer = null;
  function showToast(msg){
    let el = document.getElementById("toast");
    if(!el){
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(()=> el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> el.classList.remove("show"), 2200);
  }

  // ---------- derived helpers ----------
  function fabricRemaining(f){ return (Number(f.total)||0) - (Number(f.used)||0); }
  function fabricById(id){ return state.fabrics.find(f=>f.id===id); }
  function productById(id){ return state.products.find(p=>p.id===id); }
  function orderById(id){ return state.orders.find(o=>o.id===id); }

  function totalRemainingMeters(){
    return state.fabrics.reduce((s,f)=> s + fabricRemaining(f), 0);
  }
  function totalSoldPieces(){
    let s = 0;
    state.orders.forEach(o => o.items.forEach(it => s += Number(it.sold)||0));
    return s;
  }
  function totalRevenue(){
    let s = 0;
    state.orders.forEach(o => o.items.forEach(it => {
      const p = productById(it.productId);
      if(p && p.price) s += (Number(it.sold)||0) * Number(p.price);
    }));
    return s;
  }
  function orderProgress(order){
    let ordered=0, produced=0, sold=0;
    order.items.forEach(it=>{ ordered+=Number(it.ordered)||0; produced+=Number(it.produced)||0; sold+=Number(it.sold)||0; });
    const pct = ordered ? Math.min(100, Math.round(produced/ordered*100)) : 0;
    const soldPct = ordered ? Math.min(100, Math.round(sold/ordered*100)) : 0;
    const complete = ordered>0 && produced>=ordered;
    return {ordered, produced, sold, pct, soldPct, complete};
  }
  function activeOrders(){
    return state.orders.filter(o => !orderProgress(o).complete);
  }

  // ---------- mutations ----------
  function addFabric(vals){
    const existing = state.fabrics.find(f => f.code.trim()===vals.code.trim() && f.color.trim()===vals.color.trim());
    if(existing){
      existing.total = (Number(existing.total)||0) + Number(vals.qty);
      if(vals.image) existing.image = vals.image;
      showToast("تمت إضافة الكمية إلى القماش الموجود");
    } else {
      state.fabrics.push({ id: uid(), code: vals.code.trim(), color: vals.color.trim(), total: Number(vals.qty)||0, used: 0, image: vals.image || null });
      showToast("تمت إضافة القماش");
    }
    save(); render();
  }
  function editFabric(id, vals){
    const f = fabricById(id);
    if(!f) return;
    f.code = vals.code.trim(); f.color = vals.color.trim(); f.total = Number(vals.qty)||0;
    f.image = vals.image || null;
    save(); showToast("تم تعديل القماش"); render();
  }
  function deleteFabric(id){
    const used = state.products.some(p=>p.fabricId===id);
    if(used){ showToast("لا يمكن حذف قماش مستخدم في منتج"); return; }
    state.fabrics = state.fabrics.filter(f=>f.id!==id);
    save(); showToast("تم حذف القماش"); render();
  }

  function addProduct(vals){
    const usesFabric = !!vals.usesFabric;
    const hasReady = !!vals.hasReady;
    state.products.push({
      id: uid(), code: vals.code ? vals.code.trim() : '', name: vals.name.trim(), cut: vals.cut.trim(),
      readyQty: hasReady ? Math.max(0, Number(vals.readyQty)||0) : 0,
      fabricId: usesFabric ? (vals.fabricId || null) : null,
      metersPerPiece: usesFabric ? (Number(vals.meters)||0) : 0,
      price: vals.price ? Number(vals.price) : null,
      image: vals.image || null
    });
    save(); showToast("تمت إضافة المنتج"); render();
  }
  function editProduct(id, vals){
    const p = productById(id);
    if(!p) return;
    const usesFabric = !!vals.usesFabric;
    const hasReady = !!vals.hasReady;
    p.code = vals.code ? vals.code.trim() : ''; p.name = vals.name.trim(); p.cut = vals.cut.trim();
    p.readyQty = hasReady ? Math.max(0, Number(vals.readyQty)||0) : 0;
    p.fabricId = usesFabric ? (vals.fabricId || null) : null;
    p.metersPerPiece = usesFabric ? (Number(vals.meters)||0) : 0;
    p.price = vals.price ? Number(vals.price) : null;
    p.image = vals.image || null;
    save(); showToast("تم تعديل المنتج"); render();
  }
  function deleteProduct(id){
    const used = state.orders.some(o=>o.items.some(it=>it.productId===id));
    if(used){ showToast("لا يمكن حذف منتج مستخدم في طلبية"); return; }
    state.products = state.products.filter(p=>p.id!==id);
    save(); showToast("تم حذف المنتج"); render();
  }

  function addOrder(vals){
    const o = { id: uid(), name: vals.name.trim(), date: vals.date, items: [] };
    state.orders.push(o);
    save(); render();
    activeOrderId = o.id; view = "orderDetail"; render();
  }
  function deleteOrder(id){
    state.orders = state.orders.filter(o=>o.id!==id);
    if(activeOrderId===id){ activeOrderId=null; view="orders"; }
    save(); showToast("تم حذف الطلبية"); render();
  }
  function addOrderItem(orderId, vals){
    const o = orderById(orderId);
    if(!o) return;
    const ordered = Number(vals.ordered)||0;
    const p = productById(vals.productId);
    let produced = 0, fromReady = 0;
    if(p && ordered>0 && (Number(p.readyQty)||0) > 0){
      fromReady = Math.min(ordered, Number(p.readyQty)||0);
      produced = fromReady;
      p.readyQty = (Number(p.readyQty)||0) - fromReady;
    }
    o.items.push({ id: uid(), productId: vals.productId, ordered, produced, sold:0 });
    if(fromReady>0){
      showToast(fromReady>=ordered ? `اتغطت الطلبية كلها من المخزون الجاهز (${fmt(fromReady)} قطعة)، مفيش داعي تنتج أكتر` : `اتغطى ${fmt(fromReady)} من ${fmt(ordered)} من المخزون الجاهز، والباقي محتاج إنتاج`);
    }
    save(); render();
  }
  function deleteOrderItem(orderId, itemId){
    const o = orderById(orderId);
    if(!o) return;
    o.items = o.items.filter(it=>it.id!==itemId);
    save(); render();
  }
  function updateOrderItemQty(orderId, itemId, field, value){
    const o = orderById(orderId);
    if(!o) return;
    const it = o.items.find(i=>i.id===itemId);
    if(!it) return;
    const num = Math.max(0, Number(value)||0);

    if(field==="produced"){
      const delta = num - (Number(it.produced)||0);
      if(delta !== 0){
        const p = productById(it.productId);
        if(p && p.fabricId){
          const f = fabricById(p.fabricId);
          if(f){
            const metersDelta = delta * (Number(p.metersPerPiece)||0);
            if(delta > 0 && metersDelta > fabricRemaining(f)){
              showToast("تنبيه: القماش المتبقي أقل من الكمية المطلوبة للإنتاج");
            }
            f.used = (Number(f.used)||0) + metersDelta;
            if(f.used < 0) f.used = 0;
          }
        }
      }
      it.produced = num;
    } else if(field==="sold"){
      it.sold = num;
    } else if(field==="ordered"){
      it.ordered = num;
    }
    save(); render();
  }

  function setFactoryName(name){
    state.factoryName = name.trim() || "مصنع الأقمشة";
    save(); render();
  }

  // ---------- modal helpers ----------
  function openModal(cfg){ modal = cfg; render(); setTimeout(()=>{ const f=document.querySelector('.modal input,.modal select'); if(f) f.focus(); }, 30); }
  function closeModal(){ modal = null; render(); }

  function fabricSearchOptions(){
    return state.fabrics.map(f => ({ id: f.id, label: f.code + " — " + f.color + " (" + fmt(fabricRemaining(f)) + " م متبقي)" }));
  }
  function productSearchOptions(){
    return state.products.map(p => ({ id: p.id, label: (p.code ? p.code + " — " : "") + p.name + " — " + p.cut }));
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function matches(text){
    if(!searchQuery.trim()) return true;
    return String(text||'').toLowerCase().includes(searchQuery.trim().toLowerCase());
  }
  function serialFor(prefix, seed){
    const s = String(seed).replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
    return prefix + '-' + (s ? s.slice(-6) : '000000');
  }
  function searchRowHtml(placeholder){
    return `<div class="search-row">
      <input type="text" id="searchInput" value="${escapeHtml(searchQuery)}" placeholder="${escapeHtml(placeholder)}">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21L16.5 16.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </div>`;
  }
  function thumbHtml(url, alt){
    if(url) return `<span class="thumb"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt||'')}" loading="lazy"></span>`;
    return `<span class="thumb thumb-empty">🧵</span>`;
  }

  // ---------- open-modal actions ----------
  function modalAddFabric(){
    openModal({
      title: "إضافة قماش جديد",
      submitLabel: "إضافة",
      fields: [
        {key:'code', label:'كود القماش', type:'text', required:true},
        {key:'color', label:'اللون', type:'text', required:true},
        {key:'qty', label:'الكمية (متر)', type:'number', required:true},
        {key:'image', label:'صورة القماش', type:'image', value:'', queryFields:['code','color']}
      ],
      onSubmit: vals => addFabric(vals)
    });
  }
  function modalEditFabric(f){
    openModal({
      title: "تعديل القماش",
      submitLabel: "حفظ",
      fields: [
        {key:'code', label:'كود القماش', type:'text', value:f.code, required:true},
        {key:'color', label:'اللون', type:'text', value:f.color, required:true},
        {key:'qty', label:'إجمالي الكمية (متر)', type:'number', value:f.total, required:true},
        {key:'image', label:'صورة القماش', type:'image', value:f.image||'', queryFields:['code','color']}
      ],
      onSubmit: vals => editFabric(f.id, vals)
    });
  }
  function modalAddProduct(){
    openModal({
      title: "إضافة منتج جديد",
      submitLabel: "إضافة",
      fields: [
        {key:'code', label:'رقم/كود المنتج (اختياري)', type:'text', required:false},
        {key:'name', label:'اسم المنتج', type:'text', required:true},
        {key:'cut', label:'القصة / الشكل', type:'text', required:true},
        {key:'hasReady', label:'📦 عندي كمية جاهزة من المنتج ده دلوقتي', type:'checkbox', checked:false, toggleTarget:'readyGroup'},
        {type:'group', groupId:'readyGroup', collapsed:true, fields:[
          {key:'readyQty', label:'كام قطعة عندك جاهزة؟', type:'number', required:false}
        ]},
        {key:'usesFabric', label:'🧵 مرتبط بقماش من المخزون', type:'checkbox', checked:false, toggleTarget:'fabricGroup'},
        {type:'group', groupId:'fabricGroup', collapsed:true, fields:[
          {key:'fabricId', label:'القماش المستخدم (اكتب للبحث)', type:'searchselect', options: fabricSearchOptions(), required:false, emptyMsg:'لا يوجد قماش مسجل بعد'},
          {key:'meters', label:'متر لكل قطعة', type:'number', step:'0.1', required:false}
        ]},
        {key:'price', label:'سعر البيع (اختياري)', type:'number', required:false},
        {key:'image', label:'صورة المنتج', type:'image', value:'', queryFields:['name','cut']}
      ],
      onSubmit: vals => addProduct(vals)
    });
  }
  function modalEditProduct(p){
    openModal({
      title: "تعديل المنتج",
      submitLabel: "حفظ",
      fields: [
        {key:'code', label:'رقم/كود المنتج (اختياري)', type:'text', value:p.code||'', required:false},
        {key:'name', label:'اسم المنتج', type:'text', value:p.name, required:true},
        {key:'cut', label:'القصة / الشكل', type:'text', value:p.cut, required:true},
        {key:'hasReady', label:'📦 عندي كمية جاهزة من المنتج ده دلوقتي', type:'checkbox', checked: (Number(p.readyQty)||0)>0, toggleTarget:'readyGroup'},
        {type:'group', groupId:'readyGroup', collapsed: !((Number(p.readyQty)||0)>0), fields:[
          {key:'readyQty', label:'كام قطعة عندك جاهزة؟', type:'number', value:p.readyQty||0, required:false}
        ]},
        {key:'usesFabric', label:'🧵 مرتبط بقماش من المخزون', type:'checkbox', checked: !!p.fabricId, toggleTarget:'fabricGroup'},
        {type:'group', groupId:'fabricGroup', collapsed: !p.fabricId, fields:[
          {key:'fabricId', label:'القماش المستخدم (اكتب للبحث)', type:'searchselect', options: fabricSearchOptions(), value:p.fabricId, required:false, emptyMsg:'لا يوجد قماش مسجل بعد'},
          {key:'meters', label:'متر لكل قطعة', type:'number', step:'0.1', value:p.metersPerPiece, required:false}
        ]},
        {key:'price', label:'سعر البيع (اختياري)', type:'number', value:p.price||''},
        {key:'image', label:'صورة المنتج', type:'image', value:p.image||'', queryFields:['name','cut']}
      ],
      onSubmit: vals => editProduct(p.id, vals)
    });
  }
  function modalAddOrder(){
    const today = new Date().toISOString().slice(0,10);
    openModal({
      title: "طلبية جديدة",
      submitLabel: "إنشاء",
      fields: [
        {key:'name', label:'اسم الطلبية / العميل', type:'text', required:true},
        {key:'date', label:'التاريخ', type:'date', value:today, required:true}
      ],
      onSubmit: vals => addOrder(vals)
    });
  }
  function modalAddOrderItem(orderId){
    if(state.products.length===0){ showToast("أضف منتجًا أولاً من تبويب المنتجات"); return; }
    openModal({
      title: "إضافة صنف للطلبية",
      submitLabel: "إضافة",
      fields: [
        {key:'productId', label:'المنتج / القصة (اكتب للبحث)', type:'searchselect', options: productSearchOptions(), required:true, emptyMsg:'لا يوجد منتجات بعد', showReadyHint:true},
        {key:'ordered', label:'الكمية المطلوبة', type:'number', required:true}
      ],
      onSubmit: vals => addOrderItem(orderId, vals)
    });
  }

  function askConfirm(message, onConfirm){
    confirmTarget = {message, onConfirm};
    render();
  }

  // ---------- rendering ----------
  function render(){
    const app = document.getElementById('app');
    if(authState !== 'unlocked'){
      app.innerHTML = lockScreenHtml();
      bindLockEvents();
      return;
    }
    app.innerHTML = topbarHtml() + tabsHtml() + viewHtml() + (modal? modalHtml(modal) : '') + (confirmTarget? confirmHtml() : '') + (changePasswordModal? changePasswordModalHtml() : '');
    bindEvents();
  }

  function renderPreserveFocus(){
    const active = document.activeElement;
    const id = active && active.id;
    const start = (active && typeof active.selectionStart === 'number') ? active.selectionStart : null;
    const end = (active && typeof active.selectionEnd === 'number') ? active.selectionEnd : null;
    render();
    if(id){
      const el = document.getElementById(id);
      if(el){
        el.focus();
        if(start!==null && el.setSelectionRange){ try{ el.setSelectionRange(start, end); }catch(e){} }
      }
    }
  }

  function topbarHtml(){
    const low = state.fabrics.filter(f => fabricRemaining(f) < LOW_STOCK_METERS && fabricRemaining(f) >= 0).length;
    return `
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 9L12 4L20 9V19H15V13H9V19H4V9Z" stroke="#241F16" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <div>
          <input class="brand-name" id="factoryNameInput" value="${escapeHtml(state.factoryName)}" />
          <div class="brand-tag">${escapeHtml(todayLabel())}</div>
        </div>
      </div>
      <div class="quickstats">
        <div class="qstat"><b>${fmt(totalRemainingMeters())}</b><span>متر متبقي</span></div>
        <div class="qstat"><b>${fmt(totalSoldPieces())}</b><span>قطعة مباعة</span></div>
        <div class="qstat"><b>${activeOrders().length}</b><span>طلبية نشطة</span></div>
        <div class="qstat"><b style="color:${low>0?'#C1442E':'#D9A441'}">${low}</b><span>قماش منخفض</span></div>
        ${currentUid ? `
        <button class="btn ghost sm icon-only" data-action="openChangePassword" title="تغيير كلمة السر" style="color:var(--paper); border-color:rgba(233,190,88,.35);">🔑</button>
        <button class="btn ghost sm icon-only" data-action="lockApp" title="قفل" style="color:var(--paper); border-color:rgba(233,190,88,.35);">🔒</button>` : ''}
      </div>
    </div>`;
  }

  function lockScreenHtml(){
    const factoryName = escapeHtml(state.factoryName || 'مصنع الأقمشة');
    const brandMark = `<div class="lock-brand-mark"><svg viewBox="0 0 24 24" fill="none"><path d="M4 9L12 4L20 9V19H15V13H9V19H4V9Z" stroke="#F6F0DE" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`;
    if(authState === 'checking'){
      return `<div class="lock-screen"><div class="lock-card">${brandMark}<div class="lock-title">${factoryName}</div><div class="lock-sub">...جارٍ التحميل</div></div></div>`;
    }
    const isSetup = authState === 'needsSetup';
    return `<div class="lock-screen"><div class="lock-card">
      ${brandMark}
      <div class="lock-title">${factoryName}</div>
      <div class="lock-sub">${isSetup ? 'أول مرة؟ اختر كلمة سر للتطبيق' : 'ادخل كلمة السر عشان تدخل'}</div>
      <form id="lockForm">
        <div class="field"><input type="password" id="lockPassword" placeholder="${isSetup?'اختار كلمة سر (٦ حروف/أرقام على الأقل)':'كلمة السر'}" minlength="${isSetup?6:1}" required></div>
        ${isSetup ? `<div class="field"><input type="password" id="lockPasswordConfirm" placeholder="أكد كلمة السر" minlength="6" required></div>` : ''}
        ${authError ? `<div class="lock-error">${escapeHtml(authError)}</div>` : ''}
        <button type="submit" class="btn gold" style="width:100%; justify-content:center;" ${authBusy?'disabled':''}>${authBusy? '...جارٍ التحقق' : (isSetup?'إنشاء كلمة السر':'دخول')}</button>
      </form>
      ${isSetup ? '<div class="lock-note">كلمة السر دي هتفتح التطبيق على أي جهاز — لابتوب أو موبايل. محدش هيقدر يدخل من غيرها، واحفظها في مكان مأمون.</div>' : ''}
    </div></div>`;
  }

  function bindLockEvents(){
    const form = document.getElementById('lockForm');
    if(!form) return;
    form.addEventListener('submit', async (ev)=>{
      ev.preventDefault();
      const pw = document.getElementById('lockPassword').value;
      if(authState === 'needsSetup'){
        const confirmEl = document.getElementById('lockPasswordConfirm');
        if(confirmEl && confirmEl.value !== pw){ authError = 'كلمة السر مش متطابقة'; render(); return; }
      }
      authBusy = true; authError = ''; render();
      try{
        if(authState === 'needsSetup') await window.AppSync.setup(pw);
        else await window.AppSync.login(pw);
        // on success, boot()'s onAuthStateChanged listener flips authState to 'unlocked' and re-renders
      }catch(e){
        authBusy = false; authError = e.message || 'حصل خطأ'; render();
      }
    });
  }

  function changePasswordModalHtml(){
    return `<div class="overlay">
      <div class="modal">
        <button class="modal-close" data-action="closeChangePassword">✕</button>
        <h3>تغيير كلمة السر</h3>
        <form id="changePasswordForm">
          <div class="field"><label>كلمة السر الحالية</label><input type="password" id="cpOld" required></div>
          <div class="field"><label>كلمة السر الجديدة</label><input type="password" id="cpNew" minlength="6" required></div>
          <div class="field"><label>تأكيد كلمة السر الجديدة</label><input type="password" id="cpConfirm" minlength="6" required></div>
          ${changePasswordError ? `<div class="lock-error">${escapeHtml(changePasswordError)}</div>` : ''}
          <div class="modal-actions">
            <button type="submit" class="btn gold" ${changePasswordBusy?'disabled':''}>${changePasswordBusy?'...جارٍ الحفظ':'حفظ'}</button>
            <button type="button" class="btn ghost" data-action="closeChangePassword">إلغاء</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  function tabsHtml(){
    const tabs = [
      {id:'dashboard', label:'الرئيسية'},
      {id:'fabrics', label:'الأقمشة'},
      {id:'products', label:'المنتجات'},
      {id:'orders', label:'الطلبات'}
    ];
    const cur = (view==='orderDetail') ? 'orders' : view;
    return `<div class="tabs">` + tabs.map(t=>
      `<button class="tab ${cur===t.id?'active':''}" data-nav="${t.id}">${t.label}</button>`
    ).join('') + `</div>`;
  }

  function viewHtml(){
    if(view==='dashboard') return dashboardHtml();
    if(view==='fabrics') return fabricsHtml();
    if(view==='products') return productsHtml();
    if(view==='orders') return ordersHtml();
    if(view==='orderDetail') return orderDetailHtml();
    return '';
  }

  function dashboardHtml(){
    const lowFabrics = state.fabrics.filter(f=>fabricRemaining(f) < LOW_STOCK_METERS);
    const act = activeOrders();
    const rev = totalRevenue();
    return `
    <div class="ticket">
      <div class="ticket-stub"><h2 class="ticket-title">القماش المنخفض</h2></div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      ${lowFabrics.length===0 ? emptyHtml('🧵','لا يوجد قماش منخفض المخزون حاليًا') : `
      <table><thead><tr><th>الكود</th><th>اللون</th><th>المتبقي</th></tr></thead><tbody>
      ${lowFabrics.map(f=>`<tr><td>${escapeHtml(f.code)}</td><td><span class="swatch" style="background:${colorSwatch(f.color)}"></span>${escapeHtml(f.color)}</td><td class="num" style="color:#C1442E">${fmt(fabricRemaining(f))} م</td></tr>`).join('')}
      </tbody></table>`}
      </div>
    </div>

    <div class="ticket">
      <div class="ticket-stub">
        <h2 class="ticket-title">الطلبات النشطة</h2>
        <button class="btn gold sm" data-nav="orders">عرض الكل</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      ${act.length===0 ? emptyHtml('📦','لا توجد طلبات نشطة الآن') : act.slice(0,4).map(o=>{
        const pr = orderProgress(o);
        return `<div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:5px;">
            <b>${escapeHtml(o.name)}</b><span class="muted mono">${pr.produced}/${pr.ordered}</span>
          </div>
          <div class="progress"><div style="width:${pr.pct}%"></div></div>
        </div>`;
      }).join('')}
      </div>
    </div>

    ${rev>0 ? `<div class="ticket">
      <div class="ticket-stub"><h2 class="ticket-title">إجمالي المبيعات</h2></div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
        <div style="font-size:26px;" class="mono">${fmt(rev)}</div>
        <div class="muted" style="font-size:13px;">بناءً على أسعار المنتجات المسجّلة</div>
      </div>
    </div>` : ''}
    `;
  }

  function fabricsHtml(){
    const matchActive = !!imageMatchResults.fabrics;
    let list = state.fabrics.filter(f => matches(f.code) || matches(f.color));
    let matchMap = null;
    if(matchActive){
      matchMap = new Map(imageMatchResults.fabrics.map(r=>[r.id, r.pct]));
      list = list.filter(f => matchMap.has(f.id)).sort((a,b)=> matchMap.get(b.id) - matchMap.get(a.id));
    }
    return `
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">الأقمشة</h2>
          <div class="ticket-meta"><span class="ticket-serial">${serialFor('STK', state.fabrics.length)}</span><span class="barcode"></span></div>
        </div>
        <button class="btn gold" data-action="addFabric">+ إضافة قماش</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      <div class="section-note">كل صف يمثل كود قماش ولون معيّن، والمتبقي يُحسب تلقائيًا عند الإنتاج.</div>
      ${state.fabrics.length>0 ? searchRowHtml('ابحث بالكود أو اللون...') + imageMatchControlsHtml('fabrics') : ''}
      ${state.fabrics.length===0 ? emptyHtml('🧵','لا يوجد قماش مسجل بعد. أضف أول رصيد من الزر أعلاه.') :
        list.length===0 ? emptyHtml('🔍', matchActive ? 'لا صور مطابقة لهذه الصورة' : 'لا توجد نتائج مطابقة للبحث') : `
      <table><thead><tr><th></th><th>الكود</th><th>اللون</th><th>الإجمالي</th><th>المستخدم</th><th>المتبقي</th>${matchActive?'<th>تطابق الصورة</th>':''}<th></th></tr></thead><tbody>
      ${list.map((f,idx)=>{
        const rem = fabricRemaining(f);
        const low = rem < LOW_STOCK_METERS;
        const pct = matchActive ? matchMap.get(f.id) : null;
        return `<tr>
          <td>${thumbHtml(f.image, f.code)}</td>
          <td>${escapeHtml(f.code)}</td>
          <td><span class="swatch" style="background:${colorSwatch(f.color)}"></span>${escapeHtml(f.color)}</td>
          <td class="num">${fmt(f.total)} م</td>
          <td class="num muted">${fmt(f.used)} م</td>
          <td class="num" style="${low?'color:#C1442E':''}">${fmt(rem)} م ${low?'<span class="badge low">منخفض</span>':''}</td>
          ${matchActive ? `<td><span class="badge match${idx===0?' best':''}">${pct}%</span></td>` : ''}
          <td class="row-actions">
            <button class="btn ghost sm" data-action="editFabric" data-id="${f.id}">تعديل</button>
            <button class="btn red sm icon-only" data-action="deleteFabric" data-id="${f.id}" title="حذف">✕</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>`}
      </div>
    </div>`;
  }

  function productsHtml(){
    const matchActive = !!imageMatchResults.products;
    let list = state.products.filter(p=>{
      const f = fabricById(p.fabricId);
      return matches(p.code) || matches(p.name) || matches(p.cut) || (f && (matches(f.code) || matches(f.color)));
    });
    let matchMap = null;
    if(matchActive){
      matchMap = new Map(imageMatchResults.products.map(r=>[r.id, r.pct]));
      list = list.filter(p => matchMap.has(p.id)).sort((a,b)=> matchMap.get(b.id) - matchMap.get(a.id));
    }
    return `
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">المنتجات</h2>
          <div class="ticket-meta"><span class="ticket-serial">${serialFor('PRD', state.products.length)}</span><span class="barcode"></span></div>
        </div>
        <button class="btn gold" data-action="addProduct">+ إضافة منتج</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      <div class="section-note">لكل منتج رقم خاص به، وكمية جاهزة عندك دلوقتي (لو موجودة)، وربطه بقماش اختياري.</div>
      ${state.products.length>0 ? searchRowHtml('ابحث بالرقم أو الاسم أو القصة أو القماش...') + imageMatchControlsHtml('products') : ''}
      ${state.products.length===0 ? emptyHtml('✂️','لا توجد منتجات بعد. أضف أول منتج من الزر أعلاه.') :
        list.length===0 ? emptyHtml('🔍', matchActive ? 'لا صور مطابقة لهذه الصورة' : 'لا توجد نتائج مطابقة للبحث') : `
      <table><thead><tr><th></th><th>الرقم</th><th>الاسم</th><th>القصة</th><th>الجاهز عندك</th><th>القماش</th><th>متر/قطعة</th><th>السعر</th>${matchActive?'<th>تطابق الصورة</th>':''}<th></th></tr></thead><tbody>
      ${list.map((p,idx)=>{
        const f = p.fabricId ? fabricById(p.fabricId) : null;
        const fabricCell = p.fabricId
          ? (f ? escapeHtml(f.code+' — '+f.color) : '<span class="muted">قماش محذوف</span>')
          : '<span class="muted">—</span>';
        const readyQty = Number(p.readyQty)||0;
        const readyCell = readyQty>0 ? `<span class="badge ok">${fmt(readyQty)} قطعة</span>` : '<span class="muted">0</span>';
        const pct = matchActive ? matchMap.get(p.id) : null;
        return `<tr>
          <td>${thumbHtml(p.image, p.name)}</td>
          <td class="mono">${p.code ? escapeHtml(p.code) : '<span class="muted">—</span>'}</td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.cut)}</td>
          <td>${readyCell}</td>
          <td>${fabricCell}</td>
          <td class="num">${p.fabricId ? fmt(p.metersPerPiece) : '<span class="muted">—</span>'}</td>
          <td class="num">${p.price ? fmt(p.price) : '<span class="muted">—</span>'}</td>
          ${matchActive ? `<td><span class="badge match${idx===0?' best':''}">${pct}%</span></td>` : ''}
          <td class="row-actions">
            <button class="btn ghost sm" data-action="editProduct" data-id="${p.id}">تعديل</button>
            <button class="btn red sm icon-only" data-action="deleteProduct" data-id="${p.id}" title="حذف">✕</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>`}
      </div>
    </div>`;
  }

  function ordersHtml(){
    const list = state.orders.filter(o => matches(o.name));
    return `
    <div class="toolbar">
      <h2 class="ticket-title">الطلبات</h2>
      <div class="toolbar-search">${state.orders.length>0 ? searchRowHtml('ابحث باسم الطلبية...') : ''}</div>
      <button class="btn gold" data-action="addOrder">+ طلبية جديدة</button>
    </div>
    ${state.orders.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('📦','لا توجد طلبات بعد. أنشئ أول طلبية من الزر أعلاه.')}</div></div>` :
      list.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('🔍','لا توجد نتائج مطابقة للبحث')}</div></div>` :
      list.slice().reverse().map(o=>{
        const pr = orderProgress(o);
        return `<div class="ticket mini order-card" data-open-order="${o.id}">
          <div class="ticket-stub">
            <div>
              <h2 class="ticket-title">${escapeHtml(o.name)} <span class="badge ${pr.complete?'done':'active'}">${pr.complete?'مكتملة':'قيد التنفيذ'}</span></h2>
              <div class="ticket-meta"><span class="ticket-serial">${serialFor('ORD', o.id)}</span><span class="muted" style="font-size:12px;">${escapeHtml(o.date||'')} · ${o.items.length} صنف</span></div>
            </div>
            <button class="btn red sm icon-only" data-action="deleteOrder" data-id="${o.id}" title="حذف الطلبية" onclick="event.stopPropagation()">✕</button>
          </div>
          <div class="ticket-perf"></div>
          <div class="ticket-body">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;" class="muted"><span>الإنتاج</span><span class="num">${pr.produced}/${pr.ordered}</span></div>
            <div class="progress"><div style="width:${pr.pct}%"></div></div>
          </div>
        </div>`;
      }).join('')}
    `;
  }

  function orderDetailHtml(){
    const o = orderById(activeOrderId);
    if(!o){ view='orders'; return ordersHtml(); }
    const pr = orderProgress(o);
    return `
    <button class="back-link" data-nav="orders">→ رجوع للطلبات</button>
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">${escapeHtml(o.name)} <span class="badge ${pr.complete?'done':'active'}">${pr.complete?'مكتملة':'قيد التنفيذ'}</span></h2>
          <div class="ticket-meta"><span class="ticket-serial">${serialFor('ORD', o.id)}</span><span class="muted" style="font-size:12px;">${escapeHtml(o.date||'')}</span></div>
        </div>
        <button class="btn gold sm" data-action="addOrderItem" data-id="${o.id}">+ إضافة صنف</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">

      <div class="field-row" style="margin-bottom:18px;">
        <div>
          <div class="muted" style="font-size:12px;margin-bottom:4px;">نسبة الإنتاج (${pr.produced}/${pr.ordered})</div>
          <div class="progress"><div style="width:${pr.pct}%"></div></div>
        </div>
        <div>
          <div class="muted" style="font-size:12px;margin-bottom:4px;">نسبة المبيعات (${pr.sold}/${pr.ordered})</div>
          <div class="progress sold"><div style="width:${pr.soldPct}%"></div></div>
        </div>
      </div>

      ${o.items.length===0 ? emptyHtml('📋','لا توجد أصناف في هذه الطلبية بعد.') : o.items.map(it=>{
        const p = productById(it.productId);
        return `<div class="order-item-row">
          <div style="display:flex;align-items:center;gap:8px;">
            ${thumbHtml(p&&p.image, p&&p.name)}
            <b>${p?escapeHtml((p.code?p.code+' — ':'')+p.name+' — '+p.cut):'<span class="muted">منتج محذوف</span>'}</b>
          </div>
          <div><span class="mini-label">مطلوب</span><input type="number" min="0" value="${it.ordered}" data-oi="ordered" data-order="${o.id}" data-item="${it.id}"></div>
          <div><span class="mini-label">منتَج</span><input type="number" min="0" value="${it.produced}" data-oi="produced" data-order="${o.id}" data-item="${it.id}"></div>
          <div><span class="mini-label">مباع</span><input type="number" min="0" value="${it.sold}" data-oi="sold" data-order="${o.id}" data-item="${it.id}"></div>
          <div class="del-cell"><button class="btn red sm icon-only" data-action="deleteOrderItem" data-order="${o.id}" data-item="${it.id}" title="حذف">✕</button></div>
        </div>`;
      }).join('')}
      </div>
    </div>`;
  }

  function emptyHtml(icon, msg){
    return `<div class="empty"><div class="big">${icon}</div>${escapeHtml(msg)}</div>`;
  }

  function colorSwatch(name){
    const map = {'أبيض':'#fff','اسود':'#111','أسود':'#111','احمر':'#c0392b','أحمر':'#c0392b','ازرق':'#2980b9','أزرق':'#2980b9','اخضر':'#27ae60','أخضر':'#27ae60','اصفر':'#f1c40f','أصفر':'#f1c40f','بني':'#7a4a2b','رمادي':'#95a5a6','بيج':'#e6d3b3','كحلي':'#1b2a4a','وردي':'#e6a4c4','بنفسجي':'#8e44ad'};
    return map[name.trim()] || '#c9bc97';
  }

  function fieldHtml(f){
    if(f.type==='select'){
      return `<div class="field"><label>${escapeHtml(f.label)}</label><select name="${f.key}" ${f.required?'required':''}>${f.optionsHtml}</select></div>`;
    }
    if(f.type==='searchselect'){
      return searchSelectFieldHtml(f);
    }
    if(f.type==='image'){
      return imageFieldHtml(f);
    }
    if(f.type==='checkbox'){
      return `<div class="field checkbox-field"><label><input type="checkbox" name="${f.key}" ${f.checked?'checked':''} ${f.toggleTarget?`data-toggle-target="${f.toggleTarget}"`:''}> ${escapeHtml(f.label)}</label></div>`;
    }
    if(f.type==='group'){
      return `<div class="fabric-group ${f.collapsed?'collapsed':''}" id="${f.groupId}">${(f.fields||[]).map(fieldHtml).join('')}</div>`;
    }
    return `<div class="field"><label>${escapeHtml(f.label)}</label><input type="${f.type}" name="${f.key}" ${f.step?'step="'+f.step+'"':''} value="${f.value!==undefined?escapeHtml(f.value):''}" ${f.required?'required':''}></div>`;
  }

  function searchSelectFieldHtml(f){
    const options = f.options || [];
    if(options.length===0){
      return `<div class="field"><label>${escapeHtml(f.label)}</label><div class="muted" style="font-size:13px;">${escapeHtml(f.emptyMsg||'لا توجد خيارات بعد')}</div></div>`;
    }
    const selected = options.find(o => o.id === f.value);
    const listId = 'dl_' + f.key;
    return `<div class="field">
      <label>${escapeHtml(f.label)}</label>
      <input type="text" list="${listId}" data-searchselect="${f.key}" value="${escapeHtml(selected?selected.label:'')}" placeholder="اكتب للبحث..." autocomplete="off">
      <datalist id="${listId}">
        ${options.map(o => `<option data-id="${escapeHtml(o.id)}" value="${escapeHtml(o.label)}"></option>`).join('')}
      </datalist>
      <input type="hidden" name="${f.key}" value="${escapeHtml(f.value||'')}">
      ${f.showReadyHint ? `<div class="ready-hint" id="readyHint_${f.key}" style="display:none;"></div>` : ''}
    </div>`;
  }

  function imageFieldHtml(f){
    const url = f.value || '';
    const queryFieldsAttr = (f.queryFields||[]).join(',');
    return `<div class="field field-image">
      <label>${escapeHtml(f.label)}</label>
      <div class="image-field">
        <div class="image-preview" id="imgPreview_${f.key}">
          ${url ? `<img src="${escapeHtml(url)}" alt="">` : `<div class="image-placeholder">لا توجد صورة</div>`}
        </div>
        <input type="hidden" name="${f.key}" id="imgInput_${f.key}" value="${escapeHtml(url)}">
        <div class="image-actions">
          <label class="btn ghost sm image-upload-btn">📁 رفع صورة<input type="file" accept="image/*" class="visually-hidden" data-upload-for="${f.key}"></label>
          <button type="button" class="btn ghost sm" data-image-search="${f.key}" data-query-fields="${escapeHtml(queryFieldsAttr)}">🔍 بحث عن صورة</button>
          <button type="button" class="btn ghost sm" data-image-clear="${f.key}" style="${url?'':'display:none;'}">✕ إزالة</button>
        </div>
        <div class="image-url-row">
          <input type="text" placeholder="أو الصق رابط صورة مباشر (URL)" data-image-url-input="${f.key}">
          <button type="button" class="btn ghost sm" data-image-url-apply="${f.key}">تطبيق</button>
        </div>
        <div class="image-search-results" id="imgResults_${f.key}"></div>
      </div>
    </div>`;
  }

  function modalHtml(cfg){
    return `<div class="overlay" id="overlayEl">
      <div class="modal">
        <button class="modal-close" data-action="closeModal">✕</button>
        <h3>${escapeHtml(cfg.title)}</h3>
        <form id="modalForm">
          ${cfg.fields.map(fieldHtml).join('')}
          <div class="modal-actions">
            <button type="submit" class="btn gold">${escapeHtml(cfg.submitLabel)}</button>
            <button type="button" class="btn ghost" data-action="closeModal">إلغاء</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  function confirmHtml(){
    return `<div class="overlay">
      <div class="modal" style="max-width:360px;">
        <h3>تأكيد</h3>
        <p style="margin:-6px 0 16px;font-size:14px;">${escapeHtml(confirmTarget.message)}</p>
        <div class="modal-actions">
          <button class="btn red" data-action="confirmYes">نعم، متأكد</button>
          <button class="btn ghost" data-action="confirmNo">إلغاء</button>
        </div>
      </div>
    </div>`;
  }

  // ---------- image field helpers ----------
  function setImageFieldValue(key, url){
    const hidden = document.getElementById('imgInput_'+key);
    if(hidden) hidden.value = url || '';
    const preview = document.getElementById('imgPreview_'+key);
    if(preview) preview.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="">` : `<div class="image-placeholder">لا توجد صورة</div>`;
    const clearBtn = document.querySelector(`[data-image-clear="${key}"]`);
    if(clearBtn) clearBtn.style.display = url ? '' : 'none';
  }

  function readImageFile(file, cb){
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 640;
        let w = img.width, h = img.height;
        if(w > maxDim || h > maxDim){
          if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => showToast('تعذر قراءة الصورة');
      img.src = e.target.result;
    };
    reader.onerror = () => showToast('تعذر قراءة الملف');
    reader.readAsDataURL(file);
  }

  async function fetchImageSearchResults(query){
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: '12',
      gsrnamespace: '6', // File: namespace
      prop: 'imageinfo',
      iiprop: 'url|mime',
      iiurlwidth: '300',
      format: 'json',
      origin: '*' // required for anonymous cross-origin requests to the MediaWiki API
    });
    const res = await fetch(IMAGE_SEARCH_ENDPOINT + '?' + params.toString());
    if(!res.ok) throw new Error('search failed');
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    return Object.values(pages)
      .map(p => {
        const info = p.imageinfo && p.imageinfo[0];
        if(!info || !info.url) return null;
        if(info.mime && !/^image\//.test(info.mime)) return null; // skip audio/video/pdf files
        return { url: info.url, thumb: info.thumburl || info.url };
      })
      .filter(Boolean);
  }

  function searchBoxHtml(key, q){
    return `<div class="image-search-box">
      <input type="text" class="image-search-input" data-search-input-for="${key}" value="${escapeHtml(q||'')}" placeholder="ابحث عن صورة...">
      <button type="button" class="btn ghost sm" data-search-go="${key}">بحث</button>
    </div>`;
  }

  function bindImageSearchBox(key){
    const goBtn = document.querySelector(`[data-search-go="${key}"]`);
    const input = document.querySelector(`[data-search-input-for="${key}"]`);
    if(goBtn) goBtn.addEventListener('click', () => runImageSearch(key, input ? input.value.trim() : ''));
    if(input){
      input.addEventListener('keydown', (e) => {
        if(e.key==='Enter'){ e.preventDefault(); runImageSearch(key, input.value.trim()); }
      });
    }
  }

  function runImageSearch(key, queryOverride){
    const resultsEl = document.getElementById('imgResults_'+key);
    if(!resultsEl) return;
    let query = queryOverride;
    if(query===undefined){
      const btn = document.querySelector(`[data-image-search="${key}"]`);
      const qKeys = btn && btn.getAttribute('data-query-fields') ? btn.getAttribute('data-query-fields').split(',').filter(Boolean) : [];
      const parts = qKeys.map(k=>{
        const el = document.querySelector(`#modalForm [name="${k}"]`);
        return el ? el.value.trim() : '';
      }).filter(Boolean);
      query = parts.join(' ');
    }
    if(!query){
      resultsEl.innerHTML = searchBoxHtml(key, '') + `<div class="image-search-hint">اكتب اسمًا أعلاه أو استخدم مربع البحث هنا</div>`;
      bindImageSearchBox(key);
      return;
    }
    resultsEl.innerHTML = searchBoxHtml(key, query) + `<div class="image-search-hint">🔎 جارٍ البحث عن "${escapeHtml(query)}"...</div>`;
    bindImageSearchBox(key);
    fetchImageSearchResults(query).then(items=>{
      if(!items || items.length===0){
        resultsEl.innerHTML = searchBoxHtml(key, query) + `<div class="image-search-hint">لا توجد نتائج لهذا البحث. جرّب كلمة أخرى أو أدخل رابط صورة يدويًا.</div>`;
        bindImageSearchBox(key);
        return;
      }
      resultsEl.innerHTML = searchBoxHtml(key, query) + `<div class="image-results-grid">${items.map(it=>
        `<button type="button" class="image-result" data-pick-image="${key}" data-url="${escapeHtml(it.url)}"><img src="${escapeHtml(it.thumb)}" alt="" loading="lazy"></button>`
      ).join('')}</div>`;
      bindImageSearchBox(key);
      resultsEl.querySelectorAll('[data-pick-image]').forEach(elx=>{
        elx.addEventListener('click', ()=>{
          setImageFieldValue(key, elx.getAttribute('data-url'));
          resultsEl.innerHTML = '';
        });
      });
    }).catch(()=>{
      resultsEl.innerHTML = searchBoxHtml(key, query) + `<div class="image-search-hint">تعذر البحث عن صور الآن. تحقق من الاتصال بالإنترنت، أو أدخل رابط صورة يدويًا أعلاه.</div>`;
      bindImageSearchBox(key);
    });
  }

  // ---------- reverse image match (perceptual hash, fully client-side) ----------
  function computeImageHash(src){
    return new Promise((resolve)=>{
      if(!src){ resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try{
          const w = 9, h = 8;
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data; // throws if canvas is CORS-tainted
          const gray = [];
          for(let i=0;i<w*h;i++){
            const r=data[i*4], g=data[i*4+1], b=data[i*4+2];
            gray.push(0.299*r + 0.587*g + 0.114*b);
          }
          let bits = '';
          for(let row=0; row<h; row++){
            for(let col=0; col<w-1; col++){
              bits += (gray[row*w+col] > gray[row*w+col+1]) ? '1' : '0';
            }
          }
          resolve(bits); // 64-bit difference hash
        }catch(e){
          resolve(null); // CORS-tainted canvas or decode failure — can't compare this one
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function hammingDistance(a, b){
    if(!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++;
    return d;
  }

  async function runImageMatch(context){
    const items = context==='fabrics' ? state.fabrics : state.products;
    const withImage = items.filter(it=>it.image);
    if(withImage.length===0){
      imageMatchStatusMsg[context] = 'لا توجد عناصر لديها صور بعد للمقارنة.';
      render();
      return;
    }
    imageMatchStatusMsg[context] = '🔎 جارٍ تحليل الصورة...';
    render();
    const queryHash = await computeImageHash(imageMatchQueryImage[context]);
    if(!queryHash){
      imageMatchStatusMsg[context] = 'تعذر تحليل هذه الصورة. جرّب رفعها من جهازك بدلًا من رابط.';
      render();
      return;
    }
    imageMatchStatusMsg[context] = `🔎 جارٍ مقارنة ${withImage.length} عنصر...`;
    render();
    const results = [];
    let skipped = 0;
    for(const it of withImage){
      const h = await computeImageHash(it.image);
      if(!h){ skipped++; continue; }
      const dist = hammingDistance(queryHash, h);
      results.push({ id: it.id, pct: Math.max(0, Math.round((64-dist)/64*100)) });
    }
    results.sort((a,b)=> b.pct - a.pct);
    imageMatchResults[context] = results;
    imageMatchPanelOpen[context] = true;
    imageMatchStatusMsg[context] = results.length
      ? `أقرب تطابق: ${results[0].pct}%` + (skipped ? ` · تعذرت مقارنة ${skipped} عنصر` : '')
      : 'تعذرت مقارنة أي صورة (قد تكون الروابط محمية من النسخ).';
    render();
  }

  function imageMatchControlsHtml(context){
    const open = imageMatchPanelOpen[context];
    const qImg = imageMatchQueryImage[context];
    const active = !!imageMatchResults[context];
    const isUrlLike = qImg && /^https?:\/\//.test(qImg);
    return `<div class="image-match">
      <button type="button" class="btn ghost sm" data-match-toggle="${context}">🖼️ ${active ? 'نتائج المطابقة بالصورة' : 'ابحث بالصورة'}</button>
      <div class="image-match-panel ${open?'open':''}">
        <div class="image-match-row">
          <label class="btn ghost sm image-upload-btn">📁 ارفع صورة<input type="file" accept="image/*" class="visually-hidden" data-match-upload="${context}"></label>
          <input type="text" placeholder="أو الصق رابط صورة" data-match-url="${context}" value="${isUrlLike ? escapeHtml(qImg) : ''}">
          <button type="button" class="btn gold sm" data-match-go="${context}">قارن</button>
          ${active ? `<button type="button" class="btn ghost sm" data-match-clear="${context}">إلغاء</button>` : ''}
        </div>
        ${qImg ? `<div class="image-match-preview"><img src="${escapeHtml(qImg)}" alt=""></div>` : ''}
        ${imageMatchStatusMsg[context] ? `<div class="image-match-status">${escapeHtml(imageMatchStatusMsg[context])}</div>` : ''}
      </div>
    </div>`;
  }

  // ---------- events ----------
  function bindEvents(){
    const app = document.getElementById('app');

    const nameInput = document.getElementById('factoryNameInput');
    if(nameInput){
      nameInput.addEventListener('change', e => setFactoryName(e.target.value));
    }

    app.querySelectorAll('[data-nav]').forEach(el=>{
      el.addEventListener('click', ()=>{ view = el.getAttribute('data-nav'); searchQuery = ''; render(); });
    });

    app.querySelectorAll('[data-open-order]').forEach(el=>{
      el.addEventListener('click', ()=>{ activeOrderId = el.getAttribute('data-open-order'); view='orderDetail'; render(); });
    });

    const searchEl = document.getElementById('searchInput');
    if(searchEl){
      searchEl.addEventListener('input', ()=>{ searchQuery = searchEl.value; renderPreserveFocus(); });
    }

    app.querySelectorAll('[data-oi]').forEach(el=>{
      el.addEventListener('change', ()=>{
        updateOrderItemQty(el.getAttribute('data-order'), el.getAttribute('data-item'), el.getAttribute('data-oi'), el.value);
      });
    });

    // searchable fabric/product pickers: keep a hidden id input in sync with the typed label
    app.querySelectorAll('[data-searchselect]').forEach(input=>{
      const key = input.getAttribute('data-searchselect');
      const hidden = app.querySelector(`input[type="hidden"][name="${key}"]`);
      const datalist = document.getElementById('dl_'+key);
      const hint = document.getElementById('readyHint_'+key);
      const sync = () => {
        const val = input.value.trim();
        let matchedId = '';
        if(datalist){
          const found = Array.from(datalist.querySelectorAll('option')).find(o => o.value === val);
          if(found) matchedId = found.getAttribute('data-id');
        }
        if(hidden) hidden.value = matchedId;
        if(hint){
          const p = matchedId ? productById(matchedId) : null;
          const readyQty = p ? (Number(p.readyQty)||0) : 0;
          if(!p){
            hint.style.display = 'none';
          } else if(readyQty>0){
            hint.innerHTML = `📦 عندك بالفعل <b>${fmt(readyQty)}</b> قطعة جاهزة من المنتج ده`;
            hint.style.display = '';
          } else {
            hint.innerHTML = `⚠️ مفيش مخزون جاهز من المنتج ده — هيحتاج إنتاج`;
            hint.style.display = '';
          }
        }
      };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      sync();
    });

    // checkbox that shows/hides a field group (e.g. the fabric section)
    app.querySelectorAll('[data-toggle-target]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const target = document.getElementById(cb.getAttribute('data-toggle-target'));
        if(target) target.classList.toggle('collapsed', !cb.checked);
      });
    });

    // image fields: upload, search, manual URL, clear
    app.querySelectorAll('[data-upload-for]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        const key = inp.getAttribute('data-upload-for');
        const file = inp.files && inp.files[0];
        if(!file) return;
        readImageFile(file, dataUrl => setImageFieldValue(key, dataUrl));
      });
    });
    app.querySelectorAll('[data-image-search]').forEach(btn=>{
      btn.addEventListener('click', ()=> runImageSearch(btn.getAttribute('data-image-search')));
    });
    app.querySelectorAll('[data-image-clear]').forEach(btn=>{
      btn.addEventListener('click', ()=> setImageFieldValue(btn.getAttribute('data-image-clear'), ''));
    });
    app.querySelectorAll('[data-image-url-apply]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.getAttribute('data-image-url-apply');
        const input = app.querySelector(`[data-image-url-input="${key}"]`);
        const val = input ? input.value.trim() : '';
        if(!val){ showToast('أدخل رابط صورة أولاً'); return; }
        setImageFieldValue(key, val);
        if(input) input.value = '';
      });
    });

    // "search by photo" (reverse image match) controls
    app.querySelectorAll('[data-match-toggle]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const ctx = btn.getAttribute('data-match-toggle');
        imageMatchPanelOpen[ctx] = !imageMatchPanelOpen[ctx];
        render();
      });
    });
    app.querySelectorAll('[data-match-upload]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        const ctx = inp.getAttribute('data-match-upload');
        const file = inp.files && inp.files[0];
        if(!file) return;
        readImageFile(file, dataUrl => {
          imageMatchQueryImage[ctx] = dataUrl;
          runImageMatch(ctx);
        });
      });
    });
    app.querySelectorAll('[data-match-url]').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const ctx = inp.getAttribute('data-match-url');
        imageMatchQueryImage[ctx] = inp.value.trim();
      });
    });
    app.querySelectorAll('[data-match-go]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const ctx = btn.getAttribute('data-match-go');
        const urlInput = app.querySelector(`[data-match-url="${ctx}"]`);
        if(urlInput){
          const v = urlInput.value.trim();
          if(v) imageMatchQueryImage[ctx] = v;
        }
        if(!imageMatchQueryImage[ctx]){
          showToast('ارفع صورة أو الصق رابطًا أولًا');
          return;
        }
        runImageMatch(ctx);
      });
    });
    app.querySelectorAll('[data-match-clear]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const ctx = btn.getAttribute('data-match-clear');
        imageMatchQueryImage[ctx] = null;
        imageMatchResults[ctx] = null;
        imageMatchStatusMsg[ctx] = '';
        render();
      });
    });

    app.querySelectorAll('[data-action]').forEach(el=>{
      el.addEventListener('click', (ev)=>{
        const action = el.getAttribute('data-action');
        const id = el.getAttribute('data-id');
        if(action==='addFabric') modalAddFabric();
        else if(action==='editFabric') modalEditFabric(fabricById(id));
        else if(action==='deleteFabric') askConfirm('هل تريد حذف هذا القماش؟', ()=>deleteFabric(id));
        else if(action==='addProduct') modalAddProduct();
        else if(action==='editProduct') modalEditProduct(productById(id));
        else if(action==='deleteProduct') askConfirm('هل تريد حذف هذا المنتج؟', ()=>deleteProduct(id));
        else if(action==='addOrder') modalAddOrder();
        else if(action==='deleteOrder') askConfirm('سيتم حذف الطلبية وكل أصنافها. متأكد؟', ()=>deleteOrder(id));
        else if(action==='addOrderItem') modalAddOrderItem(id);
        else if(action==='deleteOrderItem') deleteOrderItem(el.getAttribute('data-order'), el.getAttribute('data-item'));
        else if(action==='closeModal') closeModal();
        else if(action==='confirmYes'){ const fn=confirmTarget.onConfirm; confirmTarget=null; fn(); }
        else if(action==='confirmNo'){ confirmTarget=null; render(); }
        else if(action==='openChangePassword'){ changePasswordModal=true; changePasswordError=''; render(); }
        else if(action==='closeChangePassword'){ changePasswordModal=false; changePasswordError=''; render(); }
        else if(action==='lockApp'){
          askConfirm('هل تريد قفل التطبيق؟ هتحتاج تدخل كلمة السر تاني عشان تفتحه.', async ()=>{
            await window.AppSync.logout();
            authState = 'needsLogin'; authError=''; render();
          });
        }
      });
    });

    const form = document.getElementById('modalForm');
    if(form){
      form.addEventListener('submit', (ev)=>{
        ev.preventDefault();
        const data = new FormData(form);
        const vals = {};
        for(const [k,v] of data.entries()) vals[k]=v;
        const cfg = modal;
        const missing = (cfg.fields||[]).find(f => f.type==='searchselect' && f.required && !vals[f.key]);
        if(missing){ showToast('اختر "' + missing.label.replace(' (اكتب للبحث)','') + '" من القائمة'); return; }
        modal = null;
        cfg.onSubmit(vals);
      });
    }

    const cpForm = document.getElementById('changePasswordForm');
    if(cpForm){
      cpForm.addEventListener('submit', async (ev)=>{
        ev.preventDefault();
        const oldPw = document.getElementById('cpOld').value;
        const newPw = document.getElementById('cpNew').value;
        const confirmPw = document.getElementById('cpConfirm').value;
        if(newPw !== confirmPw){ changePasswordError = 'كلمة السر الجديدة مش متطابقة'; render(); return; }
        changePasswordBusy = true; changePasswordError = ''; render();
        try{
          await window.AppSync.changePassword(oldPw, newPw);
          changePasswordBusy = false; changePasswordModal = false;
          showToast('اتغيرت كلمة السر'); render();
        }catch(e){
          changePasswordBusy = false; changePasswordError = e.message || 'حصل خطأ'; render();
        }
      });
    }
  }

  boot();
})();
