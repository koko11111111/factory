// 1. استرجاع قائمة المنتجات من المتصفح (أو إنشاء قائمة فارغة إذا لم يوجد)
let productsList = JSON.parse(localStorage.getItem('factoryProductsList')) || [];

// 2. دالة حفظ البيانات وتحديث الشاشة
function saveDataAndRender() {
  localStorage.setItem('factoryProductsList', JSON.stringify(productsList));
  renderProducts();
}

// 3. دالة إضافة منتج جديد
document.getElementById('add-product-form').addEventListener('submit', function(e) {
  e.preventDefault();

  const newProduct = {
    id: Date.now(), // رقم تعريفي فريد
    code: document.getElementById('new-code').value,
    color: document.getElementById('new-color').value,
    cut: document.getElementById('new-cut').value,
    shape: document.getElementById('new-shape').value,
    totalFabric: parseFloat(document.getElementById('new-fabric-total').value),
    targetItems: parseInt(document.getElementById('new-target').value),
    usedFabric: 0,
    completedItems: 0,
    soldItems: 0
  };

  productsList.unshift(newProduct); // إضافة المنتج الجديد في أعلى القائمة
  saveDataAndRender();
  this.reset(); // تفريغ الحقول
});

// 4. دالة عرض المنتجات على الشاشة
function renderProducts() {
  const container = document.getElementById('products-container');
  container.innerHTML = ''; // تفريغ الحاوية قبل إعادة الرسم

  if (productsList.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:#777;">لا توجد منتجات حالياً. قم بإضافة منتج جديد للبدء.</p>';
    return;
  }

  productsList.forEach(product => {
    const fabricLeft = product.totalFabric - product.usedFabric;
    let progressPercentage = (product.completedItems / product.targetItems) * 100;
    if (progressPercentage > 100) progressPercentage = 100;

    // بناء كود الـ HTML لكل منتج
    const productHTML = `
      <section class="card">
        <h2>
          <span>المنتج: ${product.shape} (${product.cut})</span>
          <button class="delete-btn" onclick="deleteProduct(${product.id})">حذف المنتج</button>
        </h2>
        
        <div class="product-specs">
          <div>كود القماش: <span>${product.code}</span></div>
          <div>اللون: <span>${product.color}</span></div>
        </div>

        <div class="metric-row">
          <!-- المخزون -->
          <div style="display:flex; gap:10px;">
             <div class="metric" style="flex:1;">
               <h3>القماش المتبقي</h3>
               <p class="highlight-green">${fabricLeft.toFixed(1)} م</p>
               <small style="color:#888;">من أصل ${product.totalFabric} م</small>
             </div>
          </div>
          <!-- الإنتاج -->
          <div style="display:flex; gap:10px;">
             <div class="metric" style="flex:1;">
               <h3>الإنتاج</h3>
               <p>${product.completedItems} / ${product.targetItems}</p>
               <div class="progress-bar-container">
                 <div class="progress-bar" style="width: ${progressPercentage}%;"></div>
               </div>
             </div>
             <div class="metric" style="flex:1;">
               <h3>المباع</h3>
               <p class="highlight-blue">${product.soldItems}</p>
             </div>
          </div>
        </div>

        <!-- نموذج تحديث المنتج الحالي -->
        <form class="update-form" onsubmit="updateProgress(event, ${product.id})">
          <div class="form-group">
            <label>قماش مستخدم اليوم (متر)</label>
            <input type="number" step="0.1" id="add-fab-${product.id}" placeholder="0">
          </div>
          <div class="form-group">
            <label>تم تصنيعه اليوم (قطعة)</label>
            <input type="number" id="add-comp-${product.id}" placeholder="0">
          </div>
          <div class="form-group">
            <label>تم بيعه اليوم (قطعة)</label>
            <input type="number" id="add-sold-${product.id}" placeholder="0">
          </div>
          <button type="submit" class="primary-btn">تحديث</button>
        </form>
      </section>
    `;
    
    container.innerHTML += productHTML;
  });
}

// 5. دالة تحديث أرقام منتج معين
window.updateProgress = function(event, productId) {
  event.preventDefault(); // منع إعادة تحميل الصفحة
  
  // البحث عن المنتج في القائمة
  const productIndex = productsList.findIndex(p => p.id === productId);
  if (productIndex === -1) return;

  // جلب القيم من المدخلات
  const addedFab = parseFloat(document.getElementById(`add-fab-${productId}`).value) || 0;
  const addedComp = parseInt(document.getElementById(`add-comp-${productId}`).value, 10) || 0;
  const addedSold = parseInt(document.getElementById(`add-sold-${productId}`).value, 10) || 0;

  // تحديث القيم
  productsList[productIndex].usedFabric += addedFab;
  productsList[productIndex].completedItems += addedComp;
  productsList[productIndex].soldItems += addedSold;

  // الحفظ وإعادة الرسم
  saveDataAndRender();
};

// 6. دالة حذف منتج
window.deleteProduct = function(productId) {
  if (confirm("هل أنت متأكد من حذف هذا المنتج بالكامل؟ لا يمكن التراجع عن هذا الإجراء.")) {
    productsList = productsList.filter(p => p.id !== productId);
    saveDataAndRender();
  }
};

// 7. تهيئة التطبيق عند فتح الصفحة
renderProducts();