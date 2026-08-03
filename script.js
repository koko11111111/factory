(function(){
  "use strict";

  const LOW_STOCK_METERS = 10;
  const STORAGE_KEY = "factory-data";

  let state = {
    factoryName: "مصنع الأقمشة",
    fabrics: [],   // {id, code, color, total, used, image, costPerMeter(nullable, EGP/meter)}
    products: [],  // {id, code, name, cut, readyQty(units already made & in stock), fabricId(nullable), metersPerPiece, price, image, laborCostPerPiece(nullable, EGP/piece)}
    orders: [],    // {id, name, date, dueDate(nullable, expected delivery), paid(EGP received so far), items:[{id, productId, ordered, produced, sold}]}
    overheadMonthly: 0, // flat monthly overhead (rent, fixed salaries, electricity...) — subtracted once from the profit total, not per-item
    // ---- trash (soft delete) ----
    // Deleted fabrics/products/orders land here (with a deletedAt timestamp)
    // instead of vanishing immediately, so an accidental delete can be undone.
    // Photos are dropped when trashing (see deleteFabric/deleteProduct) so the
    // synced Firestore document doesn't balloon with base64 images nobody can
    // see anymore. Purged automatically after TRASH_DAYS (see purgeOldTrash).
    trash: { fabrics: [], products: [], orders: [] }
  };
  const TRASH_DAYS = 30;

  let view = "dashboard"; // dashboard | fabrics | products | orders | orderDetail
  let activeOrderId = null;
  let modal = null; // {title, fields, submitLabel, onSubmit}
  let confirmTarget = null; // {message, onConfirm}
  let historyModal = null; // customer name (string) whose history is being viewed, or null
  let historyContextOrderId = null; // if opened from a specific order, highlight it as "current" in the list
  let lightboxImage = null; // url/dataURL currently shown full-size, or null when closed
  let excelImport = null; // {kind:'fabrics'|'products', headers:[], rows:[][], mapping:{field:colIndex}, error} or null when closed
  let searchQuery = "";
  let showCompletedOrders = false; // Orders tab: toggle to reveal completed/archived orders
  let trashModalOpen = false; // 🗑️ trash/undo-delete overlay, toggled from the top bar

  // ---------- sorting (fabrics/products tables) ----------
  let sortState = { fabrics: {by:'', dir:1}, products: {by:'', dir:1} };

  // ---------- bulk selection (fabrics/products/orders) ----------
  let selection = { fabrics: new Set(), products: new Set(), orders: new Set() };
  let bulkMode = { fabrics:false, products:false, orders:false };

  // ---------- orders date-range filter ----------
  let orderDateFilter = 'all'; // all | month | 30 | 90

  // ---------- theme (device-local display preference, not synced across devices) ----------
  const THEME_KEY = "factory-theme";
  let theme = 'dark';
  try{ theme = localStorage.getItem(THEME_KEY) || 'dark'; }catch(e){}

  // ---------- password lock / cross-device sync ----------
  let authState = "checking"; // checking | needsSetup | needsLogin | unlocked
  let authError = "";
  let authBusy = false;
  let currentUid = null;
  let applyingRemoteUpdate = false; // guards against re-uploading a change we just received
  let changePasswordModal = false;
  let changePasswordError = "";
  let changePasswordBusy = false;

  // ---------- cloud photo storage (see buildSyncState/expandImagesInPlace) ----------
  // Firestore caps a single document at 1MB. The whole app state (fabrics,
  // products, orders) is one document, so if every uploaded photo lived
  // inline in it, a workshop with a lot of photos could eventually hit that
  // ceiling. To avoid that, uploaded photos (data: URLs) are stored one-per-
  // document in their own subcollection when synced to Firestore, and swapped
  // for a short "img:<id>" reference inside the synced copy of the state.
  // Locally, `state.fabrics[i].image` / `state.products[i].image` always hold
  // the real photo data — this layer only affects what gets sent to/read
  // from Firestore, so nothing else in the app needs to know it exists.
  const IMAGE_REF_PREFIX = "img:";
  let remoteImageCache = {}; // ownerId -> dataURL, mirrors what's currently stored in Firestore

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

  function ownerImageId(kind, id){ return kind + '_' + id; }

  // Returns { slim, toUpload, toDelete } — `slim` is a deep copy of `state`
  // with every uploaded photo replaced by a short reference; `toUpload` is
  // { ownerId: dataURL } for photos that changed since the last sync;
  // `toDelete` is ownerIds no longer used by any fabric/product (deleted,
  // photo removed, or photo replaced by a pasted URL instead of an upload).
  function buildSyncState(){
    const slim = JSON.parse(JSON.stringify(state));
    const toUpload = {};
    const usedOids = new Set();
    function process(list, slimList, kind){
      list.forEach((real, i)=>{
        if(real.image && real.image.startsWith('data:')){
          const oid = ownerImageId(kind, real.id);
          usedOids.add(oid);
          slimList[i].image = IMAGE_REF_PREFIX + oid;
          if(remoteImageCache[oid] !== real.image) toUpload[oid] = real.image;
        }
      });
    }
    process(state.fabrics, slim.fabrics, 'fab');
    process(state.products, slim.products, 'prod');
    const toDelete = Object.keys(remoteImageCache).filter(oid => !usedOids.has(oid));
    return { slim, toUpload, toDelete };
  }

  // Mutates targetState in place, turning any "img:<id>" reference back into
  // the real photo data from imageMap (or null if not loaded/found yet).
  function expandImagesInPlace(targetState, imageMap){
    ['fabrics','products'].forEach(key=>{
      (targetState[key]||[]).forEach(rec=>{
        if(rec.image && typeof rec.image === 'string' && rec.image.startsWith(IMAGE_REF_PREFIX)){
          const oid = rec.image.slice(IMAGE_REF_PREFIX.length);
          rec.image = imageMap[oid] || null;
        }
      });
    });
  }

  // Uploads/deletes whatever changed, per buildSyncState's plan, and keeps
  // remoteImageCache in sync so unchanged photos aren't re-uploaded later.
  async function syncImageChanges(uid, toUpload, toDelete){
    for(const oid of Object.keys(toUpload)){
      await window.AppSync.saveImage(uid, oid, toUpload[oid]);
      remoteImageCache[oid] = toUpload[oid];
    }
    for(const oid of toDelete){
      await window.AppSync.deleteImage(uid, oid);
      delete remoteImageCache[oid];
    }
  }

  async function boot(){
    document.documentElement.setAttribute('data-theme', theme);
    // show cached local data instantly (if any) while we check auth in the background
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw) state = Object.assign(state, JSON.parse(raw));
    }catch(e){ /* ignore */ }
    purgeOldTrash();

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
        remoteImageCache = await window.AppSync.loadImages(user.uid);
        if(remote){
          expandImagesInPlace(remote, remoteImageCache);
          state = Object.assign(state, remote);
          purgeOldTrash();
        } else {
          // first login: seed the cloud with local data (photos go to their own docs, not inline)
          const { slim, toUpload } = buildSyncState();
          await window.AppSync.saveData(user.uid, slim);
          await syncImageChanges(user.uid, toUpload, []);
        }
        authState = "unlocked";
        render();
        window.AppSync.subscribe(user.uid, (remoteState) => {
          applyingRemoteUpdate = true;
          expandImagesInPlace(remoteState, remoteImageCache);
          state = Object.assign(state, remoteState);
          try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
          render();
          applyingRemoteUpdate = false;
        });
        window.AppSync.subscribeImages(user.uid, (changedImages) => {
          // a photo was added/changed/removed (maybe from another device) —
          // merge it into the cache and re-expand any references to it
          Object.keys(changedImages).forEach(oid=>{
            const val = changedImages[oid];
            if(val) remoteImageCache[oid] = val; else delete remoteImageCache[oid];
          });
          applyingRemoteUpdate = true;
          expandImagesInPlace(state, remoteImageCache);
          try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
          render();
          applyingRemoteUpdate = false;
        });
      } else {
        currentUid = null;
        remoteImageCache = {};
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
        const { slim, toUpload, toDelete } = buildSyncState();
        await window.AppSync.saveData(currentUid, slim);
        try{
          await syncImageChanges(currentUid, toUpload, toDelete);
        }catch(imgErr){
          console.error('[save] image sync failed:', imgErr);
          const msg = String((imgErr && imgErr.message) || '');
          if(msg.includes('permission')){
            showToast("اتحفظت البيانات، بس الصور رفضتها صلاحيات Firestore — تأكد إن قواعد الصور منشورة في Firebase Console");
          } else {
            showToast("اتحفظت البيانات، بس تعذرت مزامنة الصور (" + msg.replace('image-sync-failed: ','') + ")");
          }
        }
      }catch(e){
        console.error('[save] data sync failed:', e);
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

  // If an order item's "produced" is typed higher than its "sold", that
  // extra stock was made but hasn't gone out the door yet — it's sitting
  // ready, same as manually-entered readyQty. `producedFromReady` (set once
  // when the order item is created) is excluded so ready stock that was
  // already drawn down to cover that order isn't counted twice.
  function productSurplusReady(productId){
    let surplus = 0;
    state.orders.forEach(o=>{
      o.items.forEach(it=>{
        if(it.productId !== productId) return;
        const newlyProduced = (Number(it.produced)||0) - (Number(it.producedFromReady)||0);
        surplus += Math.max(0, newlyProduced - (Number(it.sold)||0));
      });
    });
    return surplus;
  }
  // Total ready-to-sell stock for a product: what you told the app you
  // already have, plus any unsold surplus from over-producing an order.
  function effectiveReadyQty(p){
    return (Number(p.readyQty)||0) + productSurplusReady(p.id);
  }
  function orderById(id){ return state.orders.find(o=>o.id===id); }

  // ---------- profit (revenue − material − labor − overhead) ----------
  // Every layer here is optional and degrades gracefully: an item with no
  // price, or a fabric with no cost/meter set, is simply excluded from the
  // profit total (and counted in `unknown`) instead of being treated as 0 —
  // so partial data never quietly understates the real profit.
  function fabricCostPerMeter(f){
    const v = f && f.costPerMeter;
    return (v===null || v===undefined || v==='') ? null : Number(v);
  }
  // returns null if the product uses a fabric whose cost/meter isn't set (unknown material cost),
  // otherwise the material cost per single piece (0 if the product doesn't use fabric at all).
  function productMaterialCostPerPiece(p){
    if(!p.fabricId) return 0;
    const f = fabricById(p.fabricId);
    const cpm = f ? fabricCostPerMeter(f) : null;
    if(cpm===null) return null;
    return (Number(p.metersPerPiece)||0) * cpm;
  }
  // labor is treated as 0 when unset (supplementary cost, not a hard blocker like material/price)
  function productLaborCostPerPiece(p){
    const v = p && p.laborCostPerPiece;
    return (v===null || v===undefined || v==='') ? 0 : Number(v);
  }
  // Aggregates profit across every sold order-item. Returns:
  //  revenue/materialCost/laborCost/grossProfit — totals from items with complete data
  //  overhead/netProfit — grossProfit minus the flat monthly overhead
  //  knownSold/unknownSold — units sold with vs. without enough data to compute profit
  function computeProfitSummary(){
    let revenue=0, materialCost=0, laborCost=0, knownSold=0, unknownSold=0;
    state.orders.forEach(o=>o.items.forEach(it=>{
      const sold = Number(it.sold)||0;
      if(sold<=0) return;
      const p = productById(it.productId);
      const price = p && p.price!=null && p.price!=='' ? Number(p.price) : null;
      const matCost = p ? productMaterialCostPerPiece(p) : null;
      if(!p || price===null || matCost===null){ unknownSold += sold; return; }
      knownSold += sold;
      revenue += price * sold;
      materialCost += matCost * sold;
      laborCost += productLaborCostPerPiece(p) * sold;
    }));
    const grossProfit = revenue - materialCost - laborCost;
    const overhead = Number(state.overheadMonthly)||0;
    const netProfit = grossProfit - overhead;
    return { revenue, materialCost, laborCost, grossProfit, overhead, netProfit, knownSold, unknownSold };
  }

  // ---------- trash (soft delete) ----------
  function purgeOldTrash(){
    const cutoff = Date.now() - TRASH_DAYS*24*60*60*1000;
    if(!state.trash) state.trash = { fabrics: [], products: [], orders: [] };
    ['fabrics','products','orders'].forEach(kind=>{
      state.trash[kind] = (state.trash[kind]||[]).filter(item => (item.deletedAt||0) >= cutoff);
    });
  }
  function trashCount(){
    if(!state.trash) return 0;
    return (state.trash.fabrics||[]).length + (state.trash.products||[]).length + (state.trash.orders||[]).length;
  }

  // ---------- order money (revenue billed vs. paid so far) ----------
  // Revenue is based on units actually SOLD (same basis as computeProfitSummary/
  // totalRevenue above), not just ordered — an order isn't "worth" its full
  // price until the pieces are marked sold.
  function orderRevenue(o){
    let s = 0;
    o.items.forEach(it=>{
      const p = productById(it.productId);
      if(p && p.price) s += (Number(it.sold)||0) * Number(p.price);
    });
    return s;
  }
  function orderPaid(o){ return Number(o.paid)||0; }
  function orderBalance(o){ return orderRevenue(o) - orderPaid(o); }

  // ---------- customers (derived from order names — see modalCustomerLookup) ----------
  function customersList(){
    const map = new Map(); // lowercased name -> {name, orders:[]}
    state.orders.forEach(o=>{
      const name = (o.name||'').trim();
      if(!name) return;
      const key = name.toLowerCase();
      if(!map.has(key)) map.set(key, { name, orders: [] });
      map.get(key).orders.push(o);
    });
    return Array.from(map.values()).map(c=>{
      const revenue = c.orders.reduce((s,o)=>s+orderRevenue(o),0);
      const paid = c.orders.reduce((s,o)=>s+orderPaid(o),0);
      const activeCount = c.orders.filter(o=>!orderProgress(o).complete).length;
      const lastDate = c.orders.reduce((max,o)=> (o.date && o.date>max) ? o.date : max, '');
      return { name: c.name, ordersCount: c.orders.length, activeCount, revenue, paid, balance: revenue-paid, lastDate };
    }).sort((a,b)=> (b.lastDate||'').localeCompare(a.lastDate||''));
  }

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
    const complete = ordered>0 && produced>=ordered && sold>=ordered;
    return {ordered, produced, sold, pct, soldPct, complete};
  }
  function activeOrders(){
    return state.orders.filter(o => !orderProgress(o).complete);
  }
  function todayISO(){
    return new Date().toISOString().slice(0,10);
  }
  function isOrderOverdue(o){
    if(!o.dueDate) return false;
    if(orderProgress(o).complete) return false;
    return o.dueDate < todayISO();
  }
  function overdueOrders(){
    return state.orders.filter(isOrderOverdue);
  }
  function daysDiffLabel(dueDate){
    const diff = Math.round((new Date(dueDate) - new Date(todayISO())) / 86400000);
    if(diff === 0) return "النهارده";
    if(diff > 0) return `متبقي ${diff} يوم`;
    return `متأخرة ${Math.abs(diff)} يوم`;
  }

  // ---------- mutations ----------
  function addFabric(vals){
    const rows = extractColorRows(vals);
    if(rows.length===0){ showToast("أدخل لون واحد على الأقل"); return; }
    const code = vals.code.trim();
    let addedCount = 0, mergedCount = 0;
    const costPerMeter = vals.costPerMeter ? Number(vals.costPerMeter) : null;
    rows.forEach(row=>{
      const rowImage = row.image || vals.image || '';
      const existing = state.fabrics.find(f => f.code.trim()===code && f.color.trim().toLowerCase()===row.color.toLowerCase());
      if(existing){
        existing.total = (Number(existing.total)||0) + row.qty;
        if(rowImage) existing.image = rowImage;
        if(costPerMeter!==null) existing.costPerMeter = costPerMeter;
        existing.updatedAt = Date.now();
        mergedCount++;
      } else {
        state.fabrics.push({ id: uid(), code, color: row.color, total: row.qty, used: 0, image: rowImage || null, costPerMeter, updatedAt: Date.now() });
        addedCount++;
      }
    });
    save();
    const parts = [];
    if(addedCount) parts.push(addedCount>1 ? `تمت إضافة ${addedCount} ألوان جديدة` : "تمت إضافة القماش");
    if(mergedCount) parts.push(`اتضافت الكمية لـ ${mergedCount} لون موجود بالفعل`);
    showToast(parts.join(" و "));
    render();
  }
  function editFabric(id, vals){
    const f = fabricById(id);
    if(!f) return;
    f.code = vals.code.trim(); f.color = vals.color.trim(); f.total = Number(vals.qty)||0;
    f.image = vals.image || null;
    f.costPerMeter = vals.costPerMeter ? Number(vals.costPerMeter) : null;
    f.updatedAt = Date.now();
    save(); showToast("تم تعديل القماش"); render();
  }
  function deleteFabric(id){
    const used = state.products.some(p=>p.fabricId===id);
    if(used){ showToast("لا يمكن حذف قماش مستخدم في منتج"); return; }
    const f = fabricById(id);
    if(f) state.trash.fabrics.push({ ...f, image:null, deletedAt: Date.now() });
    state.fabrics = state.fabrics.filter(f=>f.id!==id);
    purgeOldTrash();
    save(); showToast("تم حذف القماش (تقدر تسترجعه من 🗑️ خلال ٣٠ يوم)"); render();
  }

  function addProduct(vals){
    const usesFabric = !!vals.usesFabric;
    const hasReady = !!vals.hasReady;
    const fabricIds = usesFabric ? extractMultiSelectIds(vals, 'fabricIds') : [];
    if(usesFabric && fabricIds.length===0){ showToast("اختر لون قماش واحد على الأقل"); return; }
    const base = {
      code: vals.code ? vals.code.trim() : '',
      name: vals.name.trim(),
      cut: vals.cut.trim(),
      readyQty: hasReady ? Math.max(0, Number(vals.readyQty)||0) : 0,
      metersPerPiece: usesFabric ? (Number(vals.meters)||0) : 0,
      price: vals.price ? Number(vals.price) : null,
      laborCostPerPiece: vals.laborCostPerPiece ? Number(vals.laborCostPerPiece) : null,
      image: vals.image || null,
      updatedAt: Date.now()
    };
    if(!usesFabric){
      state.products.push({ id: uid(), ...base, fabricId: null });
    } else {
      fabricIds.forEach(fid => state.products.push({ id: uid(), ...base, fabricId: fid }));
    }
    save();
    showToast(fabricIds.length>1 ? `تمت إضافة ${fabricIds.length} منتجات (نسخة لكل لون)` : "تمت إضافة المنتج");
    render();
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
    p.laborCostPerPiece = vals.laborCostPerPiece ? Number(vals.laborCostPerPiece) : null;
    p.image = vals.image || null;
    p.updatedAt = Date.now();
    save(); showToast("تم تعديل المنتج"); render();
  }
  function deleteProduct(id){
    const used = state.orders.some(o=>o.items.some(it=>it.productId===id));
    if(used){ showToast("لا يمكن حذف منتج مستخدم في طلبية"); return; }
    const p = productById(id);
    if(p) state.trash.products.push({ ...p, image:null, deletedAt: Date.now() });
    state.products = state.products.filter(p=>p.id!==id);
    purgeOldTrash();
    save(); showToast("تم حذف المنتج (تقدر تسترجعه من 🗑️ خلال ٣٠ يوم)"); render();
  }
  // duplicate/clone a product for near-identical variants (same cut, different color) —
  // copies everything except readyQty (starts at 0) and opens the edit modal so you can
  // tweak the name/color/fabric before saving.
  function duplicateProduct(id){
    const p = productById(id);
    if(!p) return;
    const clone = { ...p, id: uid(), readyQty: 0, updatedAt: Date.now() };
    state.products.push(clone);
    save(); render();
    modalEditProduct(clone);
    showToast("اتنسخ المنتج — عدّل البيانات المختلفة واحفظ");
  }

  function addOrder(vals){
    const o = { id: uid(), name: vals.name.trim(), date: vals.date, dueDate: vals.dueDate || null, paid: 0, items: [] };
    state.orders.push(o);
    save(); render();
    activeOrderId = o.id; view = "orderDetail"; render();
  }
  function editOrder(id, vals){
    const o = orderById(id);
    if(!o) return;
    o.name = vals.name.trim(); o.date = vals.date; o.dueDate = vals.dueDate || null;
    o.paid = vals.paid!=null && vals.paid!=='' ? Math.max(0, Number(vals.paid)||0) : 0;
    save(); showToast("تم تعديل الطلبية"); render();
  }
  function deleteOrder(id){
    const o = orderById(id);
    if(o) state.trash.orders.push({ ...o, deletedAt: Date.now() });
    state.orders = state.orders.filter(o=>o.id!==id);
    if(activeOrderId===id){ activeOrderId=null; view="orders"; }
    purgeOldTrash();
    save(); showToast("تم حذف الطلبية (تقدر تسترجعها من 🗑️ خلال ٣٠ يوم)"); render();
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
    o.items.push({ id: uid(), productId: vals.productId, ordered, produced, sold:0, producedFromReady: fromReady });
    if(fromReady>0){
      showToast(fromReady>=ordered ? `اتغطت الطلبية كلها من المخزون الجاهز (${fmt(fromReady)} قطعة)، مفيش داعي تنتج أكتر` : `اتغطى ${fmt(fromReady)} من ${fmt(ordered)} من المخزون الجاهز، والباقي محتاج إنتاج`);
    }
    save(); render();
  }
  function deleteOrderItem(orderId, itemId){
    const o = orderById(orderId);
    if(!o) return;
    if(orderProgress(o).complete){ showToast("الطلبية دي مكتملة ومقفولة للتعديل"); return; }
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

  // ---------- sorting ----------
  function toggleSort(kind, by){
    const s = sortState[kind];
    if(s.by === by) s.dir = -s.dir;
    else { s.by = by; s.dir = 1; }
    render();
  }
  function applySort(kind, list, accessors){
    const s = sortState[kind];
    if(!s.by || !accessors[s.by]) return list;
    const get = accessors[s.by];
    return list.slice().sort((a,b)=>{
      const va = get(a), vb = get(b);
      if(typeof va === 'string') return va.localeCompare(vb, 'ar') * s.dir;
      return (va - vb) * s.dir;
    });
  }
  function sortArrow(kind, by){
    const s = sortState[kind];
    if(s.by !== by) return '';
    return s.dir===1 ? ' ▲' : ' ▼';
  }

  // ---------- CSV export ----------
  function csvEscape(v){
    const s = String(v===null||v===undefined ? '' : v);
    if(/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  }
  function downloadCsv(filename, rows){
    const csv = "\uFEFF" + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }
  function exportFabricsCsv(){
    const rows = [['الكود','اللون','الإجمالي','المستخدم','المتبقي']];
    state.fabrics.forEach(f => rows.push([f.code, f.color, fmt(f.total), fmt(f.used), fmt(fabricRemaining(f))]));
    downloadCsv('fabrics.csv', rows);
  }
  function exportProductsCsv(){
    const rows = [['الرقم','الاسم','القصة','الجاهز عندك','القماش','متر/قطعة','السعر']];
    state.products.forEach(p=>{
      const f = fabricById(p.fabricId);
      rows.push([p.code||'', p.name, p.cut, fmt(p.readyQty), f ? (f.code+' - '+f.color) : '', p.fabricId ? fmt(p.metersPerPiece) : '', p.price ? fmt(p.price) : '']);
    });
    downloadCsv('products.csv', rows);
  }
  function exportOrdersCsv(){
    const rows = [['اسم الطلبية','التاريخ','تاريخ التسليم','المنتج','مطلوب','منتَج','مباع']];
    state.orders.forEach(o=>{
      if(o.items.length===0){ rows.push([o.name, o.date||'', o.dueDate||'', '', '', '', '']); return; }
      o.items.forEach(it=>{
        const p = productById(it.productId);
        rows.push([o.name, o.date||'', o.dueDate||'', p ? p.name+' - '+p.cut : '', it.ordered, it.produced, it.sold]);
      });
    });
    downloadCsv('orders.csv', rows);
  }

  // ---------- theme ----------
  function toggleTheme(){
    theme = (theme==='dark') ? 'light' : 'dark';
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
    document.documentElement.setAttribute('data-theme', theme);
    render();
  }

  // ---------- bulk selection / bulk delete ----------
  function toggleBulkMode(kind){
    bulkMode[kind] = !bulkMode[kind];
    selection[kind].clear();
    render();
  }
  function toggleSelected(kind, id){
    if(selection[kind].has(id)) selection[kind].delete(id);
    else selection[kind].add(id);
    render();
  }
  function toggleSelectAll(kind, ids){
    const all = ids.every(id => selection[kind].has(id));
    if(all) ids.forEach(id => selection[kind].delete(id));
    else ids.forEach(id => selection[kind].add(id));
    render();
  }
  function bulkDeleteFabrics(){
    const ids = Array.from(selection.fabrics);
    if(ids.length===0) return;
    const blocked = ids.filter(id => state.products.some(p=>p.fabricId===id));
    const toDelete = ids.filter(id => !blocked.includes(id));
    toDelete.forEach(id=>{ const f = fabricById(id); if(f) state.trash.fabrics.push({ ...f, image:null, deletedAt: Date.now() }); });
    state.fabrics = state.fabrics.filter(f => !toDelete.includes(f.id));
    selection.fabrics.clear();
    purgeOldTrash();
    save();
    showToast(blocked.length ? `اتحذف ${toDelete.length}، وتعذر حذف ${blocked.length} (مستخدم في منتج)` : `اتحذف ${toDelete.length} قماش`);
    render();
  }
  function bulkDeleteProducts(){
    const ids = Array.from(selection.products);
    if(ids.length===0) return;
    const blocked = ids.filter(id => state.orders.some(o=>o.items.some(it=>it.productId===id)));
    const toDelete = ids.filter(id => !blocked.includes(id));
    toDelete.forEach(id=>{ const p = productById(id); if(p) state.trash.products.push({ ...p, image:null, deletedAt: Date.now() }); });
    state.products = state.products.filter(p => !toDelete.includes(p.id));
    selection.products.clear();
    purgeOldTrash();
    save();
    showToast(blocked.length ? `اتحذف ${toDelete.length}، وتعذر حذف ${blocked.length} (مستخدم في طلبية)` : `اتحذف ${toDelete.length} منتج`);
    render();
  }
  function bulkDeleteOrders(){
    const ids = Array.from(selection.orders);
    if(ids.length===0) return;
    ids.forEach(id=>{ const o = orderById(id); if(o) state.trash.orders.push({ ...o, deletedAt: Date.now() }); });
    state.orders = state.orders.filter(o => !ids.includes(o.id));
    if(ids.includes(activeOrderId)){ activeOrderId=null; view='orders'; }
    selection.orders.clear();
    purgeOldTrash();
    save();
    showToast(`اتحذفت ${ids.length} طلبية`);
    render();
  }

  function setFactoryName(name){
    state.factoryName = name.trim() || "مصنع الأقمشة";
    save(); render();
  }

  function modalSetOverhead(){
    openModal({
      title: "المصاريف العامة الشهرية",
      submitLabel: "حفظ",
      fields: [
        {key:'overheadMonthly', label:'الإيجار + المرتبات الثابتة + الكهرباء... إلخ (جنيه/شهر)', type:'number', step:'0.01', value: state.overheadMonthly||'', required:false}
      ],
      onSubmit: vals => {
        state.overheadMonthly = Number(vals.overheadMonthly)||0;
        save(); showToast("اتحفظت المصاريف العامة"); render();
      }
    });
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
  function lightboxHtml(){
    return `<div class="lightbox-overlay" id="lightboxOverlay">
      <button class="lightbox-close" data-action="closeLightbox" title="إغلاق">✕</button>
      <img class="lightbox-img" src="${escapeHtml(lightboxImage)}" alt="">
    </div>`;
  }

  // ---------- open-modal actions ----------
  function modalAddFabric(){
    openModal({
      title: "إضافة قماش جديد",
      submitLabel: "إضافة",
      fields: [
        {key:'code', label:'كود القماش', type:'text', required:true},
        {type:'colorRows', key:'colors', label:'الألوان والكميات'},
        {key:'costPerMeter', label:'تكلفة المتر (اختياري، جنيه)', type:'number', step:'0.01', required:false},
        {key:'image', label:'صورة افتراضية (تُستخدم فقط للألوان اللي مالهاش صورة خاصة فوق)', type:'image', value:''}
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
        {key:'costPerMeter', label:'تكلفة المتر (اختياري، جنيه)', type:'number', step:'0.01', value:f.costPerMeter||'', required:false},
        {key:'image', label:'صورة القماش', type:'image', value:f.image||''}
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
          {key:'fabricIds', type:'fabricMultiSelect', label:'ألوان القماش المستخدمة', options: fabricSearchOptions(), emptyMsg:'لا يوجد قماش مسجل بعد'},
          {key:'meters', label:'متر لكل قطعة', type:'number', step:'0.1', required:false}
        ]},
        {key:'price', label:'سعر البيع (اختياري)', type:'number', required:false},
        {key:'laborCostPerPiece', label:'تكلفة العمالة لكل قطعة (اختياري، جنيه)', type:'number', step:'0.01', required:false},
        {key:'image', label:'صورة المنتج', type:'image', value:''}
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
        {key:'laborCostPerPiece', label:'تكلفة العمالة لكل قطعة (اختياري، جنيه)', type:'number', step:'0.01', value:p.laborCostPerPiece||'', required:false},
        {key:'image', label:'صورة المنتج', type:'image', value:p.image||''}
      ],
      onSubmit: vals => editProduct(p.id, vals)
    });
  }
  function modalAddOrder(prefillName){
    const today = new Date().toISOString().slice(0,10);
    openModal({
      title: "طلبية جديدة",
      submitLabel: "إنشاء",
      fields: [
        {key:'name', label:'اسم الطلبية / العميل', type:'text', required:true, value: prefillName||''},
        {key:'date', label:'التاريخ', type:'date', value:today, required:true},
        {key:'dueDate', label:'تاريخ التسليم المتوقع (اختياري)', type:'date', required:false}
      ],
      onSubmit: vals => addOrder(vals)
    });
  }
  function modalEditOrder(o){
    openModal({
      title: "تعديل الطلبية",
      submitLabel: "حفظ",
      fields: [
        {key:'name', label:'اسم الطلبية / العميل', type:'text', value:o.name, required:true},
        {key:'date', label:'التاريخ', type:'date', value:o.date, required:true},
        {key:'dueDate', label:'تاريخ التسليم المتوقع (اختياري)', type:'date', value:o.dueDate||''},
        {key:'paid', label:'المبلغ المدفوع من العميل حتى الآن (جنيه)', type:'number', step:'0.01', value:o.paid||'', required:false}
      ],
      onSubmit: vals => editOrder(o.id, vals)
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

  function bindColorRowRemove(btn, container){
    if(!btn || !container) return;
    btn.addEventListener('click', ()=>{
      if(container.querySelectorAll('.color-row-block').length<=1){ showToast("لازم يفضل لون واحد على الأقل"); return; }
      btn.closest('.color-row-block').remove();
    });
  }

  // ---------- backup / restore (full data export & import, doesn't touch normal save/sync flow) ----------
  function exportBackup(){
    try{
      const payload = { app: 'factory-manager-backup', exportedAt: new Date().toISOString(), state: state };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0,10);
      a.href = url;
      a.download = `factory-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=> URL.revokeObjectURL(url), 2000);
      showToast('اتنزلت النسخة الاحتياطية');
    }catch(e){
      showToast('تعذر إنشاء النسخة الاحتياطية');
    }
  }
  function importBackupFromFile(file){
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      let parsed;
      try{ parsed = JSON.parse(e.target.result); }
      catch(err){ showToast('الملف ده مش نسخة احتياطية صالحة (JSON غلط)'); return; }
      const incoming = (parsed && parsed.state) ? parsed.state : parsed; // supports wrapped backup file or a raw state object
      if(!incoming || !Array.isArray(incoming.fabrics) || !Array.isArray(incoming.products) || !Array.isArray(incoming.orders)){
        showToast('الملف ده مش نسخة احتياطية صالحة لبرنامج المصنع');
        return;
      }
      askConfirm('هيتم استبدال كل البيانات الحالية (الأقمشة والمنتجات والطلبات) بالنسخة اللي في الملف ده. متأكد؟', () => {
        state = {
          factoryName: incoming.factoryName || state.factoryName,
          fabrics: incoming.fabrics,
          products: incoming.products,
          orders: incoming.orders,
          overheadMonthly: incoming.overheadMonthly || 0,
          trash: incoming.trash || { fabrics: [], products: [], orders: [] }
        };
        save();
        showToast('اترجعت النسخة الاحتياطية بنجاح');
        render();
      });
    };
    reader.readAsText(file);
  }

  // ---------- import from Excel/CSV (bulk-add fabrics or products from a spreadsheet) ----------
  function excelFieldsForKind(kind){
    if(kind==='fabrics') return [
      {key:'code', label:'كود القماش', required:true, synonyms:['كود','code','رقم']},
      {key:'color', label:'اللون', required:true, synonyms:['لون','color']},
      {key:'qty', label:'الكمية (متر)', required:true, synonyms:['كمية','متر','qty','quantity','meter']},
      {key:'image', label:'رابط صورة (اختياري)', required:false, synonyms:['صورة','image','photo','url']}
    ];
    return [
      {key:'name', label:'اسم المنتج', required:true, synonyms:['اسم','name']},
      {key:'cut', label:'القصة / الشكل', required:true, synonyms:['قصة','قصه','cut','shape']},
      {key:'code', label:'رقم/كود المنتج (اختياري)', required:false, synonyms:['كود','رقم','code']},
      {key:'readyQty', label:'الكمية الجاهزة (اختياري)', required:false, synonyms:['جاهز','ready']},
      {key:'price', label:'سعر البيع (اختياري)', required:false, synonyms:['سعر','price']},
      {key:'fabric', label:'القماش المرتبط — اكتب "كود — لون" أو الكود بس (اختياري)', required:false, synonyms:['قماش','fabric']}
    ];
  }
  function guessColumnMapping(kind, headers){
    const mapping = {};
    excelFieldsForKind(kind).forEach(f=>{
      let found = -1;
      for(let i=0;i<headers.length;i++){
        const h = String(headers[i]||'').toLowerCase();
        if(f.synonyms.some(s => h.includes(s.toLowerCase()))){ found = i; break; }
      }
      mapping[f.key] = found;
    });
    return mapping;
  }
  function openExcelImport(kind){
    excelImport = { kind, headers: [], rows: [], mapping: {}, error: '' };
    render();
  }
  function closeExcelImport(){ excelImport = null; render(); }
  function handleExcelFile(file){
    if(!file || !excelImport) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        if(typeof XLSX === 'undefined'){
          excelImport.error = 'تعذر تحميل مكتبة قراءة الإكسل — تأكد من الاتصال بالإنترنت وحاول تاني';
          render(); return;
        }
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type:'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(sheet, { header:1, raw:false, defval:'' });
        if(!raw || raw.length < 2){
          excelImport.error = 'الملف فاضي أو مفيهوش صفوف بيانات تحت صف العناوين';
          render(); return;
        }
        const headers = raw[0].map((h,i) => (h!==undefined && String(h).trim()!=='') ? String(h).trim() : ('عمود '+(i+1)));
        const dataRows = raw.slice(1).filter(r => r.some(c => String(c||'').trim()!==''));
        if(dataRows.length===0){
          excelImport.error = 'مفيش صفوف بيانات تحت صف العناوين';
          render(); return;
        }
        excelImport.headers = headers;
        excelImport.rows = dataRows;
        excelImport.mapping = guessColumnMapping(excelImport.kind, headers);
        excelImport.error = '';
        render();
      }catch(err){
        excelImport.error = 'تعذر قراءة الملف — تأكد إنه ملف إكسل (.xlsx/.xls) أو CSV سليم';
        render();
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function readMappingFromDom(kind){
    const mapping = {};
    excelFieldsForKind(kind).forEach(f=>{
      const sel = document.querySelector(`[data-excel-map="${f.key}"]`);
      mapping[f.key] = sel ? Number(sel.value) : -1;
    });
    return mapping;
  }
  function buildImportRows(kind, mapping){
    const fields = excelFieldsForKind(kind);
    return excelImport.rows.map(r => {
      const obj = {};
      fields.forEach(f => {
        const idx = mapping[f.key];
        obj[f.key] = (idx!==undefined && idx>=0 && r[idx]!==undefined) ? String(r[idx]).trim() : '';
      });
      const missing = fields.filter(f => f.required && !obj[f.key]);
      obj.valid = missing.length===0;
      obj.reason = missing.length ? ('ناقص: ' + missing.map(f=>f.label).join('، ')) : '';
      return obj;
    });
  }
  function runExcelImport(){
    if(!excelImport) return;
    const kind = excelImport.kind;
    const mapping = readMappingFromDom(kind);
    excelImport.mapping = mapping;
    const rows = buildImportRows(kind, mapping).filter(r => r.valid);
    if(rows.length===0){ showToast('مفيش صفوف صالحة للاستيراد — راجع الأعمدة اللي اخترتها'); render(); return; }
    askConfirm(`هيتم استيراد ${rows.length} صف. متأكد؟`, () => {
      if(kind==='fabrics') importFabricRows(rows);
      else importProductRows(rows);
    });
  }
  function importFabricRows(rows){
    let added = 0, merged = 0;
    rows.forEach(r => {
      const code = r.code.trim(), color = r.color.trim();
      const qty = Number(r.qty) || 0;
      if(!code || !color) return;
      const existing = state.fabrics.find(f => f.code.trim()===code && f.color.trim().toLowerCase()===color.toLowerCase());
      if(existing){
        existing.total = (Number(existing.total)||0) + qty;
        if(r.image) existing.image = r.image;
        existing.updatedAt = Date.now();
        merged++;
      } else {
        state.fabrics.push({ id: uid(), code, color, total: qty, used:0, image: r.image || null, updatedAt: Date.now() });
        added++;
      }
    });
    save();
    excelImport = null;
    const parts = [];
    if(added) parts.push(`اتضاف ${added} لون جديد`);
    if(merged) parts.push(`اتحدثت الكمية لـ ${merged} لون موجود بالفعل`);
    showToast(parts.join(' و ') || 'تم الاستيراد');
    render();
  }
  function importProductRows(rows){
    let added = 0, unlinked = 0;
    rows.forEach(r => {
      if(!r.name || !r.cut) return;
      let fabricId = null;
      if(r.fabric){
        const q = r.fabric.trim().toLowerCase();
        let match = state.fabrics.find(f => (f.code+' — '+f.color).toLowerCase()===q || (f.code+' - '+f.color).toLowerCase()===q);
        if(!match){
          const byCode = state.fabrics.filter(f => f.code.trim().toLowerCase()===q);
          if(byCode.length===1) match = byCode[0];
        }
        if(match) fabricId = match.id; else unlinked++;
      }
      state.products.push({
        id: uid(), code: r.code || '', name: r.name, cut: r.cut,
        readyQty: Math.max(0, Number(r.readyQty)||0), fabricId,
        metersPerPiece: 0, price: r.price ? Number(r.price) : null, image: null,
        updatedAt: Date.now()
      });
      added++;
    });
    save();
    excelImport = null;
    const parts = [`اتضاف ${added} منتج`];
    if(unlinked) parts.push(`${unlinked} منهم متربطش بقماش (النص في عمود القماش مطابقش أي قماش مسجل)`);
    showToast(parts.join(' — '));
    render();
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
    app.innerHTML = topbarHtml() + tabsHtml() + viewHtml() + (modal? modalHtml(modal) : '') + (changePasswordModal? changePasswordModalHtml() : '') + (historyModal? customerHistoryHtml() : '') + (excelImport? excelImportModalHtml() : '') + (trashModalOpen? trashHtml() : '') + (confirmTarget? confirmHtml() : '') + (lightboxImage? lightboxHtml() : '');
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
    const overdue = overdueOrders().length;
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
        ${overdue>0 ? `<div class="qstat"><b style="color:#C1442E">${overdue}</b><span>طلبية متأخرة ⚠️</span></div>` : ''}
        <button class="btn ghost sm icon-only" data-action="toggleTheme" title="${theme==='dark'?'وضع فاتح':'وضع غامق'}" style="color:var(--paper); border-color:rgba(233,190,88,.35);">${theme==='dark'?'☀️':'🌙'}</button>
        <button class="btn ghost sm icon-only" data-action="openTrash" title="سلة المحذوفات" style="color:var(--paper); border-color:rgba(233,190,88,.35); position:relative;">🗑️${trashCount()>0?`<span class="trash-badge">${trashCount()}</span>`:''}</button>
        <button class="btn ghost sm icon-only" data-action="exportBackup" title="تنزيل نسخة احتياطية من كل البيانات" style="color:var(--paper); border-color:rgba(233,190,88,.35);">⬇️</button>
        <label class="btn ghost sm icon-only image-upload-btn" title="استرجاع نسخة احتياطية من ملف" style="color:var(--paper); border-color:rgba(233,190,88,.35);">⬆️<input type="file" accept="application/json,.json" class="visually-hidden" id="backupRestoreInput"></label>
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
      {id:'orders', label:'الطلبات'},
      {id:'customers', label:'العملاء'}
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
    if(view==='customers') return customersHtml();
    return '';
  }

  function dashboardHtml(){
    const lowFabrics = state.fabrics.filter(f=>fabricRemaining(f) < LOW_STOCK_METERS);
    const act = activeOrders().slice().sort((a,b) => (isOrderOverdue(b)?1:0) - (isOrderOverdue(a)?1:0));
    const rev = totalRevenue();
    const ratio = productSalesRatio();
    return `
    <div class="ticket">
      <div class="ticket-stub"><h2 class="ticket-title">القماش المنخفض</h2></div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      ${lowFabrics.length===0 ? emptyHtml('🧵','لا يوجد قماش منخفض المخزون حاليًا') : `
      <div class="table-scroll"><table><thead><tr><th>الكود</th><th>اللون</th><th>المتبقي</th></tr></thead><tbody>
      ${lowFabrics.map(f=>`<tr><td>${escapeHtml(f.code)}</td><td><span class="swatch" style="background:${colorSwatch(f.color)}"></span>${escapeHtml(f.color)}</td><td class="num" style="color:#C1442E">${fmt(fabricRemaining(f))} م</td></tr>`).join('')}
      </tbody></table></div>`}
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
        const overdue = isOrderOverdue(o);
        return `<div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:14px;margin-bottom:5px;gap:8px;">
            <b>${escapeHtml(o.name)} ${orderDueBadge(o, pr)}</b><span class="muted mono">${pr.produced}/${pr.ordered}</span>
          </div>
          <div class="progress${overdue?' overdue':''}"><div style="width:${pr.pct}%"></div></div>
        </div>`;
      }).join('')}
      </div>
    </div>

    <div class="ticket">
      <div class="ticket-stub"><h2 class="ticket-title">📊 نسبة مبيعات المنتجات</h2></div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      ${!ratio ? emptyHtml('📊','لا توجد مبيعات مسجّلة بعد. سجّل مبيعات في الطلبات عشان تظهر هنا نسبة كل منتج.') : `
      <div class="bestseller-wrap">
        <div class="bestseller-wheel">${donutWheelSvg(ratio)}</div>
        <div class="bestseller-info">
          <div class="bestseller-name">الأكثر مبيعًا: ${escapeHtml(ratio.items[0].label)} (${ratio.items[0].pct}%)</div>
          <div class="muted" style="font-size:13px;margin-bottom:10px;">${fmt(ratio.total)} قطعة مباعة إجمالاً على كل المنتجات</div>
          <div class="bestseller-legend">
          ${ratio.items.map(it=>`<div class="legend-row">
            <span class="swatch" style="background:${it.color}"></span>
            <span class="legend-label">${escapeHtml(it.label)}</span>
            <span class="legend-num mono">${fmt(it.sold)} <span class="muted">(${it.pct}%)</span></span>
          </div>`).join('')}
          </div>
        </div>
      </div>`}
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

    ${(() => {
      const rbm = revenueByMonth();
      if(!rbm) return '';
      return `<div class="ticket">
      <div class="ticket-stub"><h2 class="ticket-title">📈 الإيرادات الشهرية</h2></div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">${revenueBarChartSvg(rbm)}
        <div class="muted" style="font-size:12px;margin-top:6px;">آخر ${rbm.length} شهر فيهم مبيعات، حسب تاريخ الطلبية</div>
      </div>
    </div>`;
    })()}

    ${(() => {
      const totalBalance = state.orders.reduce((s,o)=> s + Math.max(0, orderBalance(o)), 0);
      if(totalBalance<=0) return '';
      return `<div class="ticket">
      <div class="ticket-stub">
        <h2 class="ticket-title">🧾 مستحق من العملاء</h2>
        <button class="btn ghost sm" data-nav="customers">عرض العملاء</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
        <div style="font-size:26px;color:#C1442E;" class="mono">${fmt(totalBalance)}</div>
        <div class="muted" style="font-size:13px;">إجمالي المتبقي على كل الطلبات (بعد خصم المدفوع)</div>
      </div>
    </div>`;
    })()}

    ${(() => {
      const ps = computeProfitSummary();
      if(ps.knownSold===0 && ps.overhead===0) return '';
      return `<div class="ticket">
      <div class="ticket-stub">
        <h2 class="ticket-title">💰 الأرباح</h2>
        <button class="btn ghost sm" data-action="openOverheadSettings">المصاريف العامة</button>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
        <div class="table-scroll"><table><tbody>
          <tr><td>المبيعات</td><td class="num mono">${fmt(ps.revenue)}</td></tr>
          <tr><td>تكلفة الخامة (القماش)</td><td class="num mono">- ${fmt(ps.materialCost)}</td></tr>
          <tr><td>تكلفة العمالة</td><td class="num mono">- ${fmt(ps.laborCost)}</td></tr>
          <tr><td><b>الربح قبل المصاريف العامة</b></td><td class="num mono"><b>${fmt(ps.grossProfit)}</b></td></tr>
          <tr><td>المصاريف العامة الشهرية</td><td class="num mono">- ${fmt(ps.overhead)}</td></tr>
          <tr><td><b>صافي الربح</b></td><td class="num mono" style="color:${ps.netProfit>=0?'#2F6F6B':'#C1442E'}"><b>${fmt(ps.netProfit)}</b></td></tr>
        </tbody></table></div>
        ${ps.unknownSold>0 ? `<div class="muted" style="font-size:12px;margin-top:8px;">⚠️ ${fmt(ps.unknownSold)} قطعة مباعة مستبعدة من الحساب لعدم وجود سعر بيع أو تكلفة قماش مسجّلة لمنتجها</div>` : ''}
        <div class="muted" style="font-size:12px;margin-top:4px;">المصاريف العامة رقم تقريبي بيتخصم مرة واحدة، مش بالمعاملة — عدّله من الزرار فوق.</div>
      </div>
    </div>`;
    })()}
    `;
  }

  // ---------- best seller stats (top product by units sold, broken down by fabric color) ----------
  const WHEEL_PALETTE = ['#D9A441','#2F6F6B','#C1442E','#1F4335','#B5822A','#24534F','#9C3423','#C9BC97'];
  function wheelColorFor(idx){
    if(idx < WHEEL_PALETTE.length) return WHEEL_PALETTE[idx];
    return `hsl(${(idx * 47) % 360}, 50%, 45%)`; // extra distinct colors once the fixed palette runs out
  }

  // Ratio of units sold across ALL products (grouped by name+cut so color variants roll up together).
  function productSalesRatio(){
    const soldByProduct = new Map(); // productId -> total sold across all orders
    state.orders.forEach(o => o.items.forEach(it => {
      const s = Number(it.sold) || 0;
      if(s <= 0) return;
      soldByProduct.set(it.productId, (soldByProduct.get(it.productId) || 0) + s);
    }));
    if(soldByProduct.size === 0) return null;

    const groups = new Map(); // key -> {label, sold}
    soldByProduct.forEach((sold, productId) => {
      const p = productById(productId);
      if(!p) return; // product was deleted since; its historical sales aren't attributable anymore
      const key = (p.name||'').trim().toLowerCase() + '||' + (p.cut||'').trim().toLowerCase();
      if(!groups.has(key)) groups.set(key, { label: p.name + (p.cut ? ' — '+p.cut : ''), sold: 0 });
      groups.get(key).sold += sold;
    });
    if(groups.size === 0) return null;

    let arr = Array.from(groups.values()).sort((a,b) => b.sold - a.sold);
    const total = arr.reduce((s,g) => s+g.sold, 0);
    if(total <= 0) return null;

    // cap the wheel at 7 individual slices + an "أخرى" bucket, so a shop with many products stays readable
    const MAX_SLICES = 7;
    if(arr.length > MAX_SLICES){
      const top = arr.slice(0, MAX_SLICES);
      const restSold = arr.slice(MAX_SLICES).reduce((s,g) => s+g.sold, 0);
      top.push({ label: 'أخرى', sold: restSold });
      arr = top;
    }

    const items = arr.map((g,idx) => ({ label: g.label, sold: g.sold, pct: Math.round(g.sold/total*100), color: wheelColorFor(idx) }));
    return { total, items };
  }

  // Donut "wheel": ring segments sized by each item's share, total units in the middle.
  function donutWheelSvg(stats){
    const size = 160, r = 60, cx = 80, cy = 80, strokeW = 22;
    const circumference = 2 * Math.PI * r;
    let acc = 0;
    const segs = stats.items.map(it => {
      const len = Math.max(0, (it.sold / stats.total) * circumference);
      const dash = `${len} ${Math.max(0, circumference - len)}`;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${strokeW}" stroke-dasharray="${dash}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(it.label)}: ${it.sold} (${it.pct}%)</title></circle>`;
      acc += len;
      return circle;
    }).join('');
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="نسبة مبيعات المنتجات">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(0,0,0,.07)" stroke-width="${strokeW}"></circle>
      ${segs}
      <circle cx="${cx}" cy="${cy}" r="${r - strokeW/2 - 5}" fill="var(--paper)"></circle>
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-family="'IBM Plex Mono'" font-size="24" font-weight="700" fill="var(--ink)">${stats.total}</text>
      <text x="${cx}" y="${cy + 17}" text-anchor="middle" font-family="'IBM Plex Sans Arabic'" font-size="11" fill="var(--ink-soft)">قطعة مباعة</text>
    </svg>`;
  }

  // ---------- monthly revenue (dashboard bar chart) ----------
  const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  function monthLabelAr(ym){
    const parts = ym.split('-');
    const mi = Number(parts[1]) - 1;
    return (AR_MONTHS[mi]||ym) + ' ' + parts[0];
  }
  // Revenue grouped by the order's own date (not a separate "sale date", which
  // the app doesn't track) — an approximation, but the best available signal.
  // Returns the last 6 months that actually had revenue, oldest first.
  function revenueByMonth(){
    const map = new Map();
    state.orders.forEach(o=>{
      if(!o.date) return;
      const rev = orderRevenue(o);
      if(rev<=0) return;
      const key = o.date.slice(0,7);
      map.set(key, (map.get(key)||0) + rev);
    });
    if(map.size===0) return null;
    const months = Array.from(map.keys()).sort().slice(-6);
    return months.map(m=>({ key:m, label: monthLabelAr(m), total: map.get(m) }));
  }
  function revenueBarChartSvg(data){
    const w = 560, h = 190, padL = 8, padR = 8, padT = 14, padB = 30, gap = 16;
    const max = Math.max(...data.map(d=>d.total), 1);
    const innerW = w - padL - padR;
    const barW = (innerW - gap*(data.length-1)) / data.length;
    const bars = data.map((d,i)=>{
      const bh = Math.max(3, Math.round((d.total/max) * (h-padT-padB)));
      const x = padL + i*(barW+gap);
      const y = h - padB - bh;
      return `<g>
        <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="5" fill="var(--gold)"><title>${escapeHtml(d.label)}: ${fmt(d.total)}</title></rect>
        <text x="${x+barW/2}" y="${y-6}" text-anchor="middle" font-family="'IBM Plex Mono'" font-size="11" font-weight="600" fill="var(--ink)">${fmt(d.total)}</text>
        <text x="${x+barW/2}" y="${h-padB+16}" text-anchor="middle" font-family="'IBM Plex Sans Arabic'" font-size="11" fill="var(--ink-soft)">${escapeHtml(d.label)}</text>
      </g>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="الإيرادات الشهرية">${bars}</svg>`;
  }

  function fabricsHtml(){
    const matchActive = !!imageMatchResults.fabrics;
    let list = state.fabrics.filter(f => matches(f.code) || matches(f.color));
    let matchMap = null;
    if(matchActive){
      matchMap = new Map(imageMatchResults.fabrics.map(r=>[r.id, r.pct]));
      list = list.filter(f => matchMap.has(f.id)).sort((a,b)=> matchMap.get(b.id) - matchMap.get(a.id));
    } else {
      list = applySort('fabrics', list, {
        code: f => (f.code||'').toLowerCase(),
        color: f => (f.color||'').toLowerCase(),
        remaining: f => fabricRemaining(f),
        updated: f => Number(f.updatedAt)||0
      });
    }
    const bulk = bulkMode.fabrics;
    const ids = list.map(f=>f.id);
    const allSelected = ids.length>0 && ids.every(id=>selection.fabrics.has(id));
    return `
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">الأقمشة</h2>
          <div class="ticket-meta"><span class="ticket-serial">${serialFor('STK', state.fabrics.length)}</span><span class="barcode"></span></div>
        </div>
        <div class="btn-group-wrap">
          ${state.fabrics.length>0 ? `<button class="btn ghost sm" data-action="exportFabricsCsv">⬇️ تصدير CSV</button>` : ''}
          <button class="btn ghost sm" data-action="openExcelImport" data-kind="fabrics">📥 استيراد إكسل</button>
          ${state.fabrics.length>0 ? `<button class="btn ghost sm" data-action="toggleBulkMode" data-kind="fabrics">${bulk?'إلغاء التحديد':'✓ تحديد متعدد'}</button>` : ''}
          <button class="btn gold" data-action="addFabric">+ إضافة قماش</button>
        </div>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      <div class="section-note">كل صف يمثل كود قماش ولون معيّن، والمتبقي يُحسب تلقائيًا عند الإنتاج.</div>
      ${state.fabrics.length>0 ? searchRowHtml('ابحث بالكود أو اللون...') + imageMatchControlsHtml('fabrics') : ''}
      ${bulk && selection.fabrics.size>0 ? `<div class="bulk-bar">محدد: ${selection.fabrics.size} <button class="btn red sm" data-action="bulkDeleteFabrics">🗑️ حذف المحدد</button></div>` : ''}
      ${state.fabrics.length===0 ? emptyHtml('🧵','لا يوجد قماش مسجل بعد. أضف أول رصيد من الزر أعلاه.') :
        list.length===0 ? emptyHtml('🔍', matchActive ? 'لا صور مطابقة لهذه الصورة' : 'لا توجد نتائج مطابقة للبحث') : `
      <div class="table-scroll"><table><thead><tr>
        ${bulk?`<th><input type="checkbox" data-select-all="fabrics" data-ids='${JSON.stringify(ids)}' ${allSelected?'checked':''}></th>`:''}
        <th></th>
        <th class="sortable" data-sort="fabrics:code">الكود${sortArrow('fabrics','code')}</th>
        <th class="sortable" data-sort="fabrics:color">اللون${sortArrow('fabrics','color')}</th>
        <th>الإجمالي</th><th>المستخدم</th>
        <th class="sortable" data-sort="fabrics:remaining">المتبقي${sortArrow('fabrics','remaining')}</th>
        ${matchActive?'<th>تطابق الصورة</th>':''}
        <th class="sortable" data-sort="fabrics:updated">آخر تحديث${sortArrow('fabrics','updated')}</th>
        <th></th></tr></thead><tbody>
      ${list.map((f,idx)=>{
        const rem = fabricRemaining(f);
        const low = rem < LOW_STOCK_METERS;
        const pct = matchActive ? matchMap.get(f.id) : null;
        return `<tr>
          ${bulk?`<td><input type="checkbox" data-select="fabrics:${f.id}" ${selection.fabrics.has(f.id)?'checked':''}></td>`:''}
          <td>${thumbHtml(f.image, f.code)}</td>
          <td>${escapeHtml(f.code)}</td>
          <td><span class="swatch" style="background:${colorSwatch(f.color)}"></span>${escapeHtml(f.color)}</td>
          <td class="num">${fmt(f.total)} م</td>
          <td class="num muted">${fmt(f.used)} م</td>
          <td class="num" style="${low?'color:#C1442E':''}">${fmt(rem)} م ${low?'<span class="badge low">منخفض</span>':''}</td>
          ${matchActive ? `<td><span class="badge match${idx===0?' best':''}">${pct}%</span></td>` : ''}
          <td class="muted" style="font-size:12px;">${f.updatedAt ? new Date(f.updatedAt).toLocaleDateString('ar-EG') : '—'}</td>
          <td class="row-actions">
            <button class="btn ghost sm" data-action="editFabric" data-id="${f.id}">تعديل</button>
            <button class="btn red sm icon-only" data-action="deleteFabric" data-id="${f.id}" title="حذف">✕</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table></div>`}
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
    const bulk = bulkMode.products;
    const ids = list.map(p=>p.id);
    const allSelected = ids.length>0 && ids.every(id=>selection.products.has(id));
    return `
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">المنتجات</h2>
          <div class="ticket-meta"><span class="ticket-serial">${serialFor('PRD', state.products.length)}</span><span class="barcode"></span></div>
        </div>
        <div class="btn-group-wrap">
          <button class="btn ghost sm" data-action="openExcelImport" data-kind="products">📥 استيراد إكسل</button>
          ${state.products.length>0 ? `<button class="btn ghost sm" data-action="toggleBulkMode" data-kind="products">${bulk?'إلغاء التحديد':'✓ تحديد متعدد'}</button>` : ''}
          <button class="btn gold" data-action="addProduct">+ إضافة منتج</button>
        </div>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-body">
      <div class="section-note">لكل منتج رقم خاص به، وكمية جاهزة عندك دلوقتي (لو موجودة)، وربطه بقماش اختياري.</div>
      ${state.products.length>0 ? searchRowHtml('ابحث بالرقم أو الاسم أو القصة أو القماش...') + imageMatchControlsHtml('products') : ''}
      ${bulk && selection.products.size>0 ? `<div class="bulk-bar">محدد: ${selection.products.size} <button class="btn red sm" data-action="bulkDeleteProducts">🗑️ حذف المحدد</button></div>` : ''}
      ${state.products.length===0 ? emptyHtml('✂️','لا توجد منتجات بعد. أضف أول منتج من الزر أعلاه.') :
        list.length===0 ? emptyHtml('🔍', matchActive ? 'لا صور مطابقة لهذه الصورة' : 'لا توجد نتائج مطابقة للبحث') : `
      <div class="table-scroll"><table><thead><tr>${bulk?`<th><input type="checkbox" data-select-all="products" data-ids='${JSON.stringify(ids)}' ${allSelected?'checked':''}></th>`:''}<th></th><th>الرقم</th><th>الاسم</th><th>القصة</th><th>الجاهز عندك</th><th>القماش</th><th>متر/قطعة</th><th>السعر</th>${matchActive?'<th>تطابق الصورة</th>':''}<th></th></tr></thead><tbody>
      ${list.map((p,idx)=>{
        const f = p.fabricId ? fabricById(p.fabricId) : null;
        const fabricCell = p.fabricId
          ? (f ? escapeHtml(f.code+' — '+f.color) : '<span class="muted">قماش محذوف</span>')
          : '<span class="muted">—</span>';
        const readyQty = effectiveReadyQty(p);
        const readyCell = readyQty>0 ? `<span class="badge ok">${fmt(readyQty)} قطعة</span>` : '<span class="muted">0</span>';
        const pct = matchActive ? matchMap.get(p.id) : null;
        return `<tr>
          ${bulk?`<td><input type="checkbox" data-select="products:${p.id}" ${selection.products.has(p.id)?'checked':''}></td>`:''}
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
      </tbody></table></div>`}
      </div>
    </div>`;
  }

  function orderDueBadge(o, pr){
    if(pr.complete) return '';
    if(!o.dueDate) return '';
    const overdue = isOrderOverdue(o);
    return `<span class="badge ${overdue?'overdue':'due'}">${overdue?'⚠️ ':'📅 '}${escapeHtml(daysDiffLabel(o.dueDate))}</span>`;
  }

  function ordersHtml(){
    const completedCount = state.orders.filter(o=>orderProgress(o).complete).length;
    const base = showCompletedOrders ? state.orders : state.orders.filter(o => !orderProgress(o).complete);
    const list = base.filter(o => matches(o.name));
    return `
    <div class="toolbar">
      <h2 class="ticket-title">الطلبات</h2>
      <div class="toolbar-search">${state.orders.length>0 ? searchRowHtml('ابحث باسم الطلبية...') : ''}</div>
      ${completedCount>0 ? `<button class="btn ghost" data-action="toggleCompletedOrders" title="إظهار/إخفاء الطلبيات المكتملة">${showCompletedOrders?'🔽 إخفاء المكتملة':'✅ إظهار المكتملة'} (${completedCount})</button>` : ''}
      <button class="btn gold" data-action="addOrder">+ طلبية جديدة</button>
    </div>
    ${completedCount>0 && !showCompletedOrders ? `<div class="muted" style="font-size:12.5px;margin:-6px 0 14px;">✅ ${completedCount} طلبية مكتملة متخبية دلوقتي — دوس "إظهار المكتملة" فوق عشان تشوفها.</div>` : ''}
    ${state.orders.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('📦','لا توجد طلبات بعد. أنشئ أول طلبية من الزر أعلاه.')}</div></div>` :
      list.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('🔍','لا توجد طلبات مطابقة')}</div></div>` :
      list.slice().reverse().map(o=>{
        const pr = orderProgress(o);
        return `<div class="ticket mini order-card${pr.complete?' archived':''}" data-open-order="${o.id}">
          <div class="ticket-stub">
            <div>
              <h2 class="ticket-title">${escapeHtml(o.name)} <span class="badge ${pr.complete?'done':'active'}">${pr.complete?'مكتملة':'قيد التنفيذ'}</span> ${orderDueBadge(o, pr)}</h2>
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

  function customersHtml(){
    const all = customersList();
    const list = all.filter(c => matches(c.name));
    return `
    <div class="toolbar">
      <h2 class="ticket-title">العملاء</h2>
      <div class="toolbar-search">${all.length>0 ? searchRowHtml('ابحث باسم العميل...') : ''}</div>
    </div>
    <div class="section-note">قائمة مبنية تلقائيًا من أسماء الطلبيات — كل الطلبيات بنفس الاسم بتتجمع هنا كعميل واحد.</div>
    ${all.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('🧑‍🤝‍🧑','لا يوجد عملاء بعد. بيتكوّن العميل تلقائيًا أول ما تنشئ طلبية باسمه.')}</div></div>` :
      list.length===0 ? `<div class="ticket"><div class="ticket-body">${emptyHtml('🔍','لا توجد نتائج مطابقة للبحث')}</div></div>` : `
    <div class="ticket">
      <div class="ticket-body">
      <div class="table-scroll"><table><thead><tr>
        <th>العميل</th><th>الطلبات</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>آخر طلبية</th><th></th>
      </tr></thead><tbody>
      ${list.map(c=>`<tr data-open-customer="${escapeHtml(c.name)}">
        <td><b>${escapeHtml(c.name)}</b></td>
        <td class="num mono">${c.ordersCount}${c.activeCount>0?` <span class="muted">(${c.activeCount} نشطة)</span>`:''}</td>
        <td class="num mono">${fmt(c.revenue)}</td>
        <td class="num mono">${fmt(c.paid)}</td>
        <td class="num mono" style="color:${c.balance>0?'#C1442E':'inherit'}">${fmt(c.balance)}</td>
        <td class="muted" style="font-size:12.5px;">${escapeHtml(c.lastDate||'—')}</td>
        <td class="row-actions"><button class="btn ghost sm" data-action="openCustomerHistoryByName" data-name="${escapeHtml(c.name)}" onclick="event.stopPropagation()">🕘 السجل</button></td>
      </tr>`).join('')}
      </tbody></table></div>
      </div>
    </div>`}
    `;
  }

  function orderDetailHtml(){
    const o = orderById(activeOrderId);
    if(!o){ view='orders'; return ordersHtml(); }
    const pr = orderProgress(o);
    const overdue = isOrderOverdue(o);
    return `
    <button class="back-link" data-nav="orders">→ رجوع للطلبات</button>
    <div class="ticket">
      <div class="ticket-stub">
        <div>
          <h2 class="ticket-title">${escapeHtml(o.name)} <span class="badge ${pr.complete?'done':'active'}">${pr.complete?'مكتملة':'قيد التنفيذ'}</span></h2>
          <div class="ticket-meta">
            <span class="ticket-serial">${serialFor('ORD', o.id)}</span>
            <span class="muted" style="font-size:12px;">${escapeHtml(o.date||'')}</span>
            ${o.dueDate ? `<span class="muted" style="font-size:12px;">· التسليم: ${escapeHtml(o.dueDate)}</span> <span class="badge ${overdue?'overdue':(pr.complete?'':'due')}">${pr.complete?'✔️ اتسلمت':(overdue?'⚠️ ':'📅 ')+daysDiffLabel(o.dueDate)}</span>` : ''}
            <button class="btn ghost sm icon-only" data-action="editOrder" data-id="${o.id}" title="تعديل بيانات الطلبية">✏️</button>
          </div>
        </div>
        <div class="btn-group-wrap">
          <button class="btn gold sm" data-action="addOrderItem" data-id="${o.id}">+ إضافة صنف</button>
        </div>
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

      ${(() => {
        const orderRev = orderRevenue(o), orderPd = orderPaid(o), orderBal = orderRev - orderPd;
        if(orderRev<=0 && orderPd<=0) return '';
        return `<div class="table-scroll" style="margin-bottom:18px;"><table><tbody>
          <tr><td>قيمة المباع من الطلبية</td><td class="num mono">${fmt(orderRev)}</td></tr>
          <tr><td>المدفوع</td><td class="num mono">${fmt(orderPd)}</td></tr>
          <tr><td><b>المتبقي</b></td><td class="num mono" style="color:${orderBal>0?'#C1442E':'#2F6F6B'}"><b>${fmt(orderBal)}</b></td></tr>
        </tbody></table></div>`;
      })()}

      ${o.items.length===0 ? emptyHtml('📋','لا توجد أصناف في هذه الطلبية بعد.') : o.items.map(it=>{
        const p = productById(it.productId);
        const label = p?escapeHtml((p.code?p.code+' — ':'')+p.name+' — '+p.cut):'<span class="muted">منتج محذوف</span>';
        return `<div class="order-item-row">
          <div class="order-item-name">
            ${thumbHtml(p&&p.image, p&&p.name)}
            <b>${label}</b>
          </div>
          <div><span class="mini-label">مطلوب</span><input type="number" min="0" value="${it.ordered}" data-oi="ordered" data-order="${o.id}" data-item="${it.id}"></div>
          <div><span class="mini-label">منتَج</span><input type="number" min="0" value="${it.produced}" data-oi="produced" data-order="${o.id}" data-item="${it.id}"></div>
          <div><span class="mini-label">مباع</span><input type="number" min="0" value="${it.sold}" data-oi="sold" data-order="${o.id}" data-item="${it.id}"></div>
          <div class="del-cell">${pr.complete?'':`<button class="btn red sm icon-only" data-action="deleteOrderItem" data-order="${o.id}" data-item="${it.id}" title="حذف">✕</button>`}</div>
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
    if(f.type==='colorRows'){
      return colorRowsFieldHtml(f);
    }
    if(f.type==='fabricMultiSelect'){
      return fabricMultiSelectFieldHtml(f);
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

  // ---------- repeatable "color + quantity + photo" rows (add many fabric colors under one code at once) ----------
  function colorRowHtml(idx, color, qty, image){
    const img = image || '';
    const imgKey = 'mc_image_' + idx;
    return `<div class="color-row-block">
      <div class="color-row">
        <input type="text" name="mc_color_${idx}" placeholder="اللون (مثلاً: أحمر)" value="${escapeHtml(color||'')}">
        <input type="number" name="mc_qty_${idx}" placeholder="الكمية (متر)" min="0" step="0.1" value="${qty!==undefined && qty!==null && qty!=='' ? escapeHtml(qty) : ''}">
        <button type="button" class="btn red sm icon-only" data-remove-color-row title="حذف اللون">✕</button>
      </div>
      <div class="color-row-image">
        <div class="image-preview sm" id="imgPreview_${imgKey}">
          ${img ? `<img src="${escapeHtml(img)}" alt="">` : `<div class="image-placeholder">صورة اللون ده</div>`}
        </div>
        <input type="hidden" name="${imgKey}" id="imgInput_${imgKey}" value="${escapeHtml(img)}">
        <div class="image-actions">
          <label class="btn ghost sm image-upload-btn">📁 صورة اللون<input type="file" accept="image/*" class="visually-hidden" data-upload-for="${imgKey}"></label>
          <button type="button" class="btn ghost sm" data-image-clear="${imgKey}" style="${img?'':'display:none;'}">✕ إزالة</button>
        </div>
        <div class="image-url-row">
          <input type="text" placeholder="أو الصق رابط صورة مباشر (URL)" data-image-url-input="${imgKey}">
          <button type="button" class="btn ghost sm" data-image-url-apply="${imgKey}">تطبيق</button>
        </div>
      </div>
    </div>`;
  }
  function colorRowsFieldHtml(f){
    return `<div class="field">
      <label>${escapeHtml(f.label)}</label>
      <div class="muted" style="font-size:12px;margin:-2px 0 8px;">أضف كل لون بمتراته وصورته — تقدر تضيف أكتر من لون بنفس الكود ده دفعة واحدة بدل ما تكرر الكود كل مرة، وكل لون تقدر تحط له صورة مختلفة</div>
      <div class="color-rows" id="colorRows_${f.key}" data-seq="1">
        ${colorRowHtml(0)}
      </div>
      <button type="button" class="btn ghost sm" data-add-color-row="${f.key}" style="margin-top:8px;">+ لون تاني</button>
    </div>`;
  }

  // ---------- multi-select checklist (link a product to several fabric colors → one product per color) ----------
  function fabricMultiSelectFieldHtml(f){
    const options = f.options || [];
    if(options.length===0){
      return `<div class="field"><label>${escapeHtml(f.label)}</label><div class="muted" style="font-size:13px;">${escapeHtml(f.emptyMsg||'لا توجد خيارات بعد')}</div></div>`;
    }
    const selectedSet = new Set(f.value || []);
    return `<div class="field">
      <label>${escapeHtml(f.label)}</label>
      <div class="muted" style="font-size:12px;margin:-2px 0 8px;">اختر لون واحد أو أكتر — لو اخترت أكتر من لون هيتعمل نسخة من المنتج لكل لون تختاره</div>
      <input type="text" class="fms-filter" placeholder="اكتب للتصفية..." data-fms-filter="${f.key}">
      <div class="fms-list" id="fmsList_${f.key}">
        ${options.map(o => `<label class="fms-item"><input type="checkbox" name="fm_${f.key}_${escapeHtml(o.id)}" ${selectedSet.has(o.id)?'checked':''}><span>${escapeHtml(o.label)}</span></label>`).join('')}
      </div>
    </div>`;
  }

  function extractColorRows(vals){
    const rows = [];
    Object.keys(vals).forEach(k=>{
      const m = k.match(/^mc_color_(\d+)$/);
      if(!m) return;
      const color = (vals[k]||'').trim();
      if(!color) return;
      const qty = Number(vals['mc_qty_'+m[1]]) || 0;
      const image = (vals['mc_image_'+m[1]]||'').trim();
      rows.push({ color, qty, image });
    });
    return rows;
  }
  function extractMultiSelectIds(vals, key){
    const prefix = 'fm_'+key+'_';
    return Object.keys(vals).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
  }

  // Image field renderer: upload + paste URL only. No image-search feature anywhere in this app.
  function imageFieldHtml(f){
    const url = f.value || '';
    return `<div class="field field-image">
      <label>${escapeHtml(f.label)}</label>
      <div class="image-field">
        <div class="image-preview" id="imgPreview_${f.key}">
          ${url ? `<img src="${escapeHtml(url)}" alt="">` : `<div class="image-placeholder">لا توجد صورة</div>`}
        </div>
        <input type="hidden" name="${f.key}" id="imgInput_${f.key}" value="${escapeHtml(url)}">
        <div class="image-actions">
          <label class="btn ghost sm image-upload-btn">📁 رفع صورة<input type="file" accept="image/*" class="visually-hidden" data-upload-for="${f.key}"></label>
          <button type="button" class="btn ghost sm" data-image-clear="${f.key}" style="${url?'':'display:none;'}">✕ إزالة</button>
        </div>
        <div class="image-url-row">
          <input type="text" placeholder="أو الصق رابط صورة مباشر (URL)" data-image-url-input="${f.key}">
          <button type="button" class="btn ghost sm" data-image-url-apply="${f.key}">تطبيق</button>
        </div>
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

  function customerOrders(name){
    const key = (name||'').trim().toLowerCase();
    if(!key) return [];
    return state.orders
      .filter(o => (o.name||'').trim().toLowerCase() === key)
      .slice()
      .sort((a,b) => (a.date||'').localeCompare(b.date||''));
  }

  function customerHistoryHtml(){
    const name = (historyModal||'').trim();
    if(!name){ return ''; }
    const orders = customerOrders(name);
    const totalRev = orders.reduce((s,o)=>s+orderRevenue(o),0);
    const totalPaid = orders.reduce((s,o)=>s+orderPaid(o),0);
    const totalBal = totalRev - totalPaid;
    return `<div class="overlay">
      <div class="modal" style="max-width:560px;">
        <button class="modal-close" data-action="closeHistoryModal">✕</button>
        <h3>🕘 سجل العميل: ${escapeHtml(name)}</h3>
        <div class="muted" style="font-size:12px;margin:-8px 0 14px;">${orders.length} طلبية بنفس الاسم</div>
        ${(totalRev>0 || totalPaid>0) ? `<div class="table-scroll" style="margin-bottom:14px;"><table><tbody>
          <tr><td>إجمالي القيمة</td><td class="num mono">${fmt(totalRev)}</td></tr>
          <tr><td>المدفوع</td><td class="num mono">${fmt(totalPaid)}</td></tr>
          <tr><td><b>المتبقي</b></td><td class="num mono" style="color:${totalBal>0?'#C1442E':'#2F6F6B'}"><b>${fmt(totalBal)}</b></td></tr>
        </tbody></table></div>` : ''}
        <button class="btn gold sm" data-action="addOrderForCustomer" data-name="${escapeHtml(name)}" style="margin-bottom:14px;">+ طلبية جديدة لنفس العميل</button>
        <div style="max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
        ${orders.length===0 ? emptyHtml('🕘','لا يوجد سجل سابق لهذا العميل') : orders.map(o=>{
          const pr = orderProgress(o);
          const isCurrent = o.id === historyContextOrderId;
          return `<div class="ticket mini" style="margin:0;${isCurrent?'border-color:var(--gold, #e9be58);':''}">
            <div class="ticket-stub">
              <div>
                <h2 class="ticket-title" style="font-size:14px;">${escapeHtml(o.date||'بدون تاريخ')} <span class="badge ${pr.complete?'done':'active'}">${pr.complete?'مكتملة':'قيد التنفيذ'}</span>${isCurrent?' <span class="muted" style="font-size:11px;">(الطلبية الحالية)</span>':''}</h2>
                <div class="ticket-meta"><span class="ticket-serial">${serialFor('ORD', o.id)}</span></div>
              </div>
            </div>
            <div class="ticket-body" style="padding-top:8px;">
            ${o.items.length===0 ? '<div class="muted" style="font-size:13px;">لا توجد أصناف</div>' : o.items.map(it=>{
              const p = productById(it.productId);
              return `<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:4px 0;border-bottom:1px solid rgba(0,0,0,.06);">
                <span>${p?escapeHtml((p.code?p.code+' — ':'')+p.name+' — '+p.cut):'<span class="muted">منتج محذوف</span>'}</span>
                <span class="mono muted">مطلوب ${fmt(it.ordered)} · منتَج ${fmt(it.produced)} · مباع ${fmt(it.sold)}</span>
              </div>`;
            }).join('')}
            </div>
          </div>`;
        }).join('')}
        </div>
      </div>
    </div>`;
  }

  function restoreFabric(id){
    const idx = state.trash.fabrics.findIndex(f=>f.id===id);
    if(idx<0) return;
    const item = { ...state.trash.fabrics[idx] };
    delete item.deletedAt;
    state.trash.fabrics.splice(idx,1);
    state.fabrics.push(item);
    save(); showToast("اترجع القماش — الصورة (لو كانت موجودة) محتاجة تتضاف تاني"); render();
  }
  function restoreProduct(id){
    const idx = state.trash.products.findIndex(p=>p.id===id);
    if(idx<0) return;
    const item = { ...state.trash.products[idx] };
    delete item.deletedAt;
    state.trash.products.splice(idx,1);
    state.products.push(item);
    save(); showToast("اترجع المنتج — الصورة (لو كانت موجودة) محتاجة تتضاف تاني"); render();
  }
  function restoreOrder(id){
    const idx = state.trash.orders.findIndex(o=>o.id===id);
    if(idx<0) return;
    const item = { ...state.trash.orders[idx] };
    delete item.deletedAt;
    state.trash.orders.splice(idx,1);
    state.orders.push(item);
    save(); showToast("اترجعت الطلبية"); render();
  }
  function purgeTrashItem(kind, id){
    if(!state.trash[kind]) return;
    state.trash[kind] = state.trash[kind].filter(x=>x.id!==id);
    save(); render();
  }
  function trashKindLabel(kind){ return kind==='fabrics'?'أقمشة':kind==='products'?'منتجات':'طلبات'; }
  function trashHtml(){
    const daysLeft = (deletedAt) => Math.max(0, Math.ceil((deletedAt + TRASH_DAYS*86400000 - Date.now())/86400000));
    const count = trashCount();
    function section(kind, items, labelFn){
      if(items.length===0) return '';
      return `<div class="muted" style="font-size:12px;margin:14px 0 6px;">${trashKindLabel(kind)} (${items.length})</div>` +
        items.slice().reverse().map(it=>`<div class="trash-row">
          <div>
            <b>${escapeHtml(labelFn(it))}</b>
            <div class="muted" style="font-size:11px;">هيتحذف نهائيًا خلال ${daysLeft(it.deletedAt)} يوم</div>
          </div>
          <div class="btn-group-wrap">
            <button class="btn ghost sm" data-action="restoreTrashItem" data-kind="${kind}" data-id="${it.id}">↩️ استرجاع</button>
            <button class="btn red sm icon-only" data-action="purgeTrashItem" data-kind="${kind}" data-id="${it.id}" title="حذف نهائي">✕</button>
          </div>
        </div>`).join('');
    }
    return `<div class="overlay">
      <div class="modal" style="max-width:520px;">
        <button class="modal-close" data-action="closeTrash">✕</button>
        <h3>🗑️ سلة المحذوفات</h3>
        <div class="muted" style="font-size:12px;margin:-8px 0 14px;">العناصر المحذوفة بتتحذف نهائيًا تلقائيًا بعد ${TRASH_DAYS} يوم من حذفها</div>
        <div style="max-height:55vh;overflow-y:auto;">
        ${count===0 ? emptyHtml('🗑️','سلة المحذوفات فاضية') :
          section('fabrics', state.trash.fabrics, f=>f.code+' — '+f.color) +
          section('products', state.trash.products, p=>p.name+' — '+p.cut) +
          section('orders', state.trash.orders, o=>o.name)
        }
        </div>
      </div>
    </div>`;
  }

  function excelImportModalHtml(){
    const ex = excelImport;
    const title = ex.kind==='fabrics' ? 'استيراد أقمشة من إكسل' : 'استيراد منتجات من إكسل';
    if(ex.headers.length===0){
      return `<div class="overlay">
        <div class="modal" style="max-width:480px;">
          <button class="modal-close" data-action="closeExcelImport">✕</button>
          <h3>${title}</h3>
          <div class="section-note">اختار ملف إكسل (.xlsx/.xls) أو CSV — أول صف لازم يكون أسماء الأعمدة (عناوين)، وباقي الصفوف بياناتك.</div>
          ${ex.error ? `<div class="import-error">${escapeHtml(ex.error)}</div>` : ''}
          <label class="btn gold" style="display:inline-flex;">📁 اختيار ملف<input type="file" accept=".xlsx,.xls,.csv" class="visually-hidden" id="excelFileInput"></label>
        </div>
      </div>`;
    }
    const fields = excelFieldsForKind(ex.kind);
    const rows = buildImportRows(ex.kind, ex.mapping);
    const validCount = rows.filter(r=>r.valid).length;
    return `<div class="overlay">
      <div class="modal" style="max-width:640px;">
        <button class="modal-close" data-action="closeExcelImport">✕</button>
        <h3>${title}</h3>
        <div class="section-note">حدد كل عمود في ملفك بيمثل إيه — الحقول اللي فيها * لازم تتحدد، والباقي اختياري.</div>
        <div class="excel-map-grid">
        ${fields.map(f=>`
          <div class="field">
            <label>${escapeHtml(f.label)}${f.required?' *':''}</label>
            <select data-excel-map="${f.key}">
              ${!f.required?`<option value="-1" ${ex.mapping[f.key]===-1?'selected':''}>— تجاهل —</option>`:''}
              ${ex.headers.map((h,i)=>`<option value="${i}" ${ex.mapping[f.key]===i?'selected':''}>${escapeHtml(h)}</option>`).join('')}
            </select>
          </div>`).join('')}
        </div>
        ${excelPreviewHtml(rows)}
        <div class="modal-actions">
          <button class="btn gold" data-action="runExcelImport" ${validCount===0?'disabled':''}>📥 استيراد ${validCount} صف</button>
          <button class="btn ghost" data-action="closeExcelImport">إلغاء</button>
        </div>
      </div>
    </div>`;
  }
  function excelPreviewHtml(rows){
    const validCount = rows.filter(r=>r.valid).length;
    const invalidCount = rows.length - validCount;
    const sample = rows.slice(0,6);
    const cols = sample.length ? Object.keys(sample[0]).filter(k=>k!=='valid'&&k!=='reason') : [];
    return `
      <div class="muted" style="font-size:12px;margin:10px 0 6px;">معاينة (${rows.length} صف إجمالي — ${validCount} صالح${invalidCount?` — ${invalidCount} هيتجاهل`:''})</div>
      <div class="table-scroll" style="max-height:220px;">
        <table><thead><tr>${cols.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}<th></th></tr></thead><tbody>
        ${sample.map(r=>`<tr style="${r.valid?'':'opacity:.5;'}">${cols.map(c=>`<td>${escapeHtml(r[c]||'')}</td>`).join('')}<td style="font-size:12px;">${r.valid?'✓':'⚠️ '+escapeHtml(r.reason)}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
  }

  // ---------- image field helpers ----------
  // binds upload/clear/url-apply controls for every image field under `root`
  // (the whole app on a normal render, or just a freshly-inserted color row
  // that was added without a full re-render)
  function bindImageFieldControls(root){
    root.querySelectorAll('[data-upload-for]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        const key = inp.getAttribute('data-upload-for');
        const file = inp.files && inp.files[0];
        if(!file) return;
        readImageFile(file, dataUrl => setImageFieldValue(key, dataUrl));
      });
    });
    root.querySelectorAll('[data-image-clear]').forEach(btn=>{
      btn.addEventListener('click', ()=> setImageFieldValue(btn.getAttribute('data-image-clear'), ''));
    });
    root.querySelectorAll('[data-image-url-apply]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.getAttribute('data-image-url-apply');
        const input = root.querySelector(`[data-image-url-input="${key}"]`) || document.querySelector(`[data-image-url-input="${key}"]`);
        const val = input ? input.value.trim() : '';
        if(!val){ showToast('أدخل رابط صورة أولاً'); return; }
        setImageFieldValue(key, val);
        if(input) input.value = '';
      });
    });
  }

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

    const backupRestoreInput = document.getElementById('backupRestoreInput');
    if(backupRestoreInput){
      backupRestoreInput.addEventListener('change', () => {
        const file = backupRestoreInput.files && backupRestoreInput.files[0];
        importBackupFromFile(file);
        backupRestoreInput.value = ''; // allow re-selecting the same file again later
      });
    }

    const excelFileInput = document.getElementById('excelFileInput');
    if(excelFileInput){
      excelFileInput.addEventListener('change', () => {
        const file = excelFileInput.files && excelFileInput.files[0];
        if(file) handleExcelFile(file);
      });
    }
    app.querySelectorAll('[data-excel-map]').forEach(sel=>{
      sel.addEventListener('change', () => {
        if(!excelImport) return;
        excelImport.mapping[sel.getAttribute('data-excel-map')] = Number(sel.value);
        render();
      });
    });

    app.querySelectorAll('[data-nav]').forEach(el=>{
      el.addEventListener('click', ()=>{ view = el.getAttribute('data-nav'); searchQuery = ''; render(); });
    });

    app.querySelectorAll('[data-open-customer]').forEach(el=>{
      el.addEventListener('click', ()=>{ historyModal = el.getAttribute('data-open-customer'); historyContextOrderId = null; render(); });
    });
    app.querySelectorAll('[data-open-order]').forEach(el=>{
      el.addEventListener('click', ()=>{ activeOrderId = el.getAttribute('data-open-order'); view='orderDetail'; render(); });
    });

    const searchEl = document.getElementById('searchInput');
    if(searchEl){
      searchEl.addEventListener('input', ()=>{ searchQuery = searchEl.value; renderPreserveFocus(); });
    }

    app.querySelectorAll('[data-sort]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const [kind, by] = el.getAttribute('data-sort').split(':');
        toggleSort(kind, by);
      });
    });
    app.querySelectorAll('[data-select]').forEach(el=>{
      el.addEventListener('change', (ev)=>{
        ev.stopPropagation();
        const [kind, id] = el.getAttribute('data-select').split(':');
        toggleSelected(kind, id);
      });
      el.addEventListener('click', ev=> ev.stopPropagation());
    });
    app.querySelectorAll('[data-select-all]').forEach(el=>{
      el.addEventListener('change', ()=>{
        const kind = el.getAttribute('data-select-all');
        const ids = JSON.parse(el.getAttribute('data-ids'));
        toggleSelectAll(kind, ids);
      });
    });
    const orderFilterEl = document.getElementById('orderDateFilter');
    if(orderFilterEl){
      orderFilterEl.addEventListener('change', ()=>{ orderDateFilter = orderFilterEl.value; render(); });
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
          const readyQty = p ? effectiveReadyQty(p) : 0;
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

    // repeatable color+qty rows (fabric multi-color add): add row, remove row
    app.querySelectorAll('[data-add-color-row]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.getAttribute('data-add-color-row');
        const container = document.getElementById('colorRows_'+key);
        if(!container) return;
        const idx = Number(container.getAttribute('data-seq'))||1;
        container.insertAdjacentHTML('beforeend', colorRowHtml(idx));
        container.setAttribute('data-seq', idx+1);
        const newRow = container.lastElementChild;
        bindColorRowRemove(newRow.querySelector('[data-remove-color-row]'), container);
        bindImageFieldControls(newRow);
        const colorInput = newRow.querySelector('input[type="text"]');
        if(colorInput) colorInput.focus();
      });
    });
    app.querySelectorAll('.color-rows').forEach(container=>{
      container.querySelectorAll('[data-remove-color-row]').forEach(btn=>{
        bindColorRowRemove(btn, container);
      });
    });

    // fabric multi-select checklist: live text filter over the checkbox list
    app.querySelectorAll('[data-fms-filter]').forEach(inp=>{
      const key = inp.getAttribute('data-fms-filter');
      const list = document.getElementById('fmsList_'+key);
      if(!list) return;
      inp.addEventListener('input', ()=>{
        const q = inp.value.trim().toLowerCase();
        list.querySelectorAll('.fms-item').forEach(item=>{
          item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
        });
      });
    });

    // image fields: upload, search, manual URL, clear
    bindImageFieldControls(app);

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
        else if(action==='duplicateProduct') duplicateProduct(id);
        else if(action==='toggleTheme') toggleTheme();
        else if(action==='exportBackup') exportBackup();
        else if(action==='openExcelImport') openExcelImport(el.getAttribute('data-kind'));
        else if(action==='closeExcelImport') closeExcelImport();
        else if(action==='runExcelImport') runExcelImport();
        else if(action==='toggleBulkMode') toggleBulkMode(el.getAttribute('data-kind'));
        else if(action==='bulkDeleteFabrics') askConfirm('هل تريد حذف الأصناف المحددة؟', bulkDeleteFabrics);
        else if(action==='bulkDeleteProducts') askConfirm('هل تريد حذف الأصناف المحددة؟', bulkDeleteProducts);
        else if(action==='bulkDeleteOrders') askConfirm('هل تريد حذف الطلبات المحددة؟', bulkDeleteOrders);
        else if(action==='exportFabricsCsv') exportFabricsCsv();
        else if(action==='exportProductsCsv') exportProductsCsv();
        else if(action==='exportOrdersCsv') exportOrdersCsv();
        else if(action==='addOrder') modalAddOrder();
        else if(action==='editOrder'){ const o = orderById(id); if(o) modalEditOrder(o); }
        else if(action==='toggleCompletedOrders'){ showCompletedOrders = !showCompletedOrders; render(); }
        else if(action==='deleteOrder') askConfirm('سيتم حذف الطلبية وكل أصنافها. متأكد؟', ()=>deleteOrder(id));
        else if(action==='addOrderItem') modalAddOrderItem(id);
        else if(action==='deleteOrderItem') deleteOrderItem(el.getAttribute('data-order'), el.getAttribute('data-item'));
        else if(action==='closeModal') closeModal();
        else if(action==='openCustomerHistoryByName'){ historyModal = el.getAttribute('data-name'); historyContextOrderId = null; render(); }
        else if(action==='closeHistoryModal'){ historyModal = null; render(); }
        else if(action==='openTrash'){ trashModalOpen = true; render(); }
        else if(action==='closeTrash'){ trashModalOpen = false; render(); }
        else if(action==='restoreTrashItem'){
          const kind = el.getAttribute('data-kind');
          if(kind==='fabrics') restoreFabric(id);
          else if(kind==='products') restoreProduct(id);
          else if(kind==='orders') restoreOrder(id);
        }
        else if(action==='purgeTrashItem'){
          const kind = el.getAttribute('data-kind');
          askConfirm('حذف نهائي؟ مش هينفع ترجعه بعد كده.', ()=>purgeTrashItem(kind, id));
        }
        else if(action==='closeLightbox'){ lightboxImage = null; render(); }
        else if(action==='addOrderForCustomer'){ const customerName = el.getAttribute('data-name'); historyModal = null; historyContextOrderId = null; modalAddOrder(customerName); }
        else if(action==='confirmYes'){ const fn=confirmTarget.onConfirm; confirmTarget=null; fn(); }
        else if(action==='confirmNo'){ confirmTarget=null; render(); }
        else if(action==='openOverheadSettings'){ modalSetOverhead(); }
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

    // click any thumbnail photo to zoom it full-size
    app.querySelectorAll('.thumb img').forEach(img=>{
      img.addEventListener('click', ()=>{ lightboxImage = img.getAttribute('src'); render(); });
    });
    const lightboxOverlay = document.getElementById('lightboxOverlay');
    if(lightboxOverlay){
      lightboxOverlay.addEventListener('click', (ev)=>{
        if(ev.target === lightboxOverlay){ lightboxImage = null; render(); }
      });
    }

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

  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && lightboxImage){ lightboxImage = null; render(); }
  });

  boot();
})();
