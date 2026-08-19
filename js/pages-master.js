/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 基本资料页面
   商品 / 客户 / 供应商 / 仓库 / 单位 / 币别 / 分类 / 物流 / 付款条件
   ============================================================ */
"use strict";

/* ============================================================
   商品主档
   ============================================================ */
Pages.items = function () {
    const list = DB.list("items").sort((a, b) => a.code.localeCompare(b.code));
    const q = (window.__itemSearch || "").toLowerCase();
    const rows = list.filter(i => !q || (i.code + i.name + i.brand + i.english_name).toLowerCase().indexOf(q) >= 0).map(i => {
        const cat = DB.get("categories", i.category_id);
        const stock = DB.totalStock(i.id);
        const stockCls = stock < 0 ? "neg" : stock < i.safety_stock ? "low" : "";
        const pct = i.safety_stock > 0 ? Math.min(stock / i.safety_stock * 100, 100) : 100;
        return `<tr>
            <td><a href="#/master/items/${i.id}/edit"><b>${h(i.code)}</b></a></td>
            <td><b>${h(i.name)}</b>${i.english_name ? `<br><span style="color:var(--muted);font-size:12px">${h(i.english_name)}</span>` : ""}</td>
            <td>${h(cat ? cat.name : "-")}</td>
            <td>${h(i.brand || "-")}</td>
            <td>${h(i.sales_unit || "-")}</td>
            <td class="num">${fmt(i.cost)}</td>
            <td class="num">${fmt(i.price)}</td>
            <td>${h(i.purchase_currency || "-")}</td>
            <td>
                <div class="stock-bar-wrap">
                    <span class="num" style="width:52px;${stock < 0 ? "color:var(--danger);font-weight:700" : ""}">${stock}</span>
                    <span class="stock-bar ${stockCls}"><i style="width:${pct}%"></i></span>
                    <span style="color:var(--muted);font-size:12px">${i.safety_stock}</span>
                </div>
            </td>
            <td>${i.disabled ? badge("停用") : badge("启用")}</td>
            <td class="action-col">
                <a class="link-btn" href="#/master/items/${i.id}/edit">编辑</a>
                <button class="link-btn danger" onclick="Pages.deleteItem('${i.id}')">删除</button>
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>商品主档</h1><p>维护商品基础资料：编号、品名、规格、单位、成本、售价与安全库存。</p></div>
        <div class="head-actions">
            ${can("master.item") ? `<a class="btn primary" href="#/master/items/create">+ 新增商品</a>` : ""}
            <a class="btn ghost" href="#/tools/migration-center">Excel 导入</a>
        </div>
    </div>
    <div class="toolbar">
        <div class="search"><input placeholder="搜索品号/品名/品牌..." value="${h(window.__itemSearch || "")}" oninput="Pages.itemSearch(this.value)"></div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>品号</th><th>品名</th><th>分类</th><th>品牌</th><th>销售单位</th><th class="num">成本</th><th class="num">售价</th><th>采购币别</th><th>库存 / 安全</th><th>状态</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="11"><div class="empty-state"><div class="big">📦</div>没有符合的商品</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔商品</p>`;
    renderShell("items", content, "首页 / 基本资料 / 商品主档");
};

Pages.itemSearch = function (v) {
    window.__itemSearch = v;
    Pages.items();
};

Pages.deleteItem = function (id) {
    const it = DB.get("items", id);
    if (!it) return;
    confirmModal(`确定要删除商品 ${it.code} - ${it.name} 吗？`, () => {
        DB.remove("items", id);
        toast("商品已删除", "success");
        render();
    });
};

Pages.itemForm = function (id) {
    const it = id ? DB.get("items", id) : null;
    if (id && !it) { toast("找不到该商品", "error"); render(); return; }
    const isEdit = !!it;
    const catOpts = DB.list("categories").map(c => `<option value="${c.id}" ${it && it.category_id === c.id ? "selected" : ""}>${h(c.name)}</option>`).join("");
    const curOpts = DB.list("currencies").map(c => `<option value="${c.code}" ${it && it.purchase_currency === c.code ? "selected" : ""}>${h(c.code)} - ${h(c.name)}</option>`).join("");
    const unitOpts = (sel) => DB.list("units").map(u => `<option ${it && it[sel] === u.name ? "selected" : ""}>${h(u.name)}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h2>商品主档｜${isEdit ? "编辑" : "新增"}</h2><p>商品编号用于订单与库存判读，请保持唯一。</p></div>
        <div class="actions"><a class="btn" href="#/master/items">返回商品主档</a></div>
    </div>
    <form class="form-panel" onsubmit="Pages.saveItem(event, '${id || ""}')">
        <section class="form-section">
            <div class="form-section-title"><h3>基本信息</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>品号<b>*</b></label><input name="code" value="${h(it ? it.code : "")}" required placeholder="如 605900001"></div>
                <div class="form-item"><label>品名<b>*</b></label><input name="item_name" value="${h(it ? it.name : "")}" required></div>
                <div class="form-item"><label>英文品名</label><input name="english_name" value="${h(it ? it.english_name : "")}"></div>
                <div class="form-item"><label>规格</label><input name="spec" value="${h(it ? it.spec : "")}"></div>
                <div class="form-item"><label>品牌</label><input name="brand" value="${h(it ? it.brand : "")}"></div>
                <div class="form-item"><label>型号</label><input name="model" value="${h(it ? it.model : "")}"></div>
                <div class="form-item"><label>商品分类</label><select name="category_id"><option value="">请选择</option>${catOpts}</select></div>
                <div class="form-item"><label>商品类型</label>
                    <select name="product_type"><option ${!it || it.product_type === "成品" ? "selected" : ""}>成品</option><option ${it && it.product_type === "半成品" ? "selected" : ""}>半成品</option><option ${it && it.product_type === "原材料" ? "selected" : ""}>原材料</option><option ${it && it.product_type === "服务" ? "selected" : ""}>服务</option></select></div>
                <div class="form-item"><label>条码</label><input name="barcode" value="${h(it ? it.barcode : "")}"></div>
                <div class="form-item"><label>二维码</label><input name="qrcode" value="${h(it ? it.qrcode : "")}"></div>
                <div class="form-item"><label>状态</label><select name="disabled"><option value="0" ${!it || !it.disabled ? "selected" : ""}>启用</option><option value="1" ${it && it.disabled ? "selected" : ""}>停用</option></select></div>
            </div>
        </section>
        <section class="form-section">
            <div class="form-section-title"><h3>单位与换算</h3><p>采购/销售/库存单位不同时，透过换算率换算。</p></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>销售单位</label><select name="sales_unit"><option value="">请选择</option>${unitOpts("sales_unit")}</select></div>
                <div class="form-item"><label>采购单位</label><select name="purchase_unit"><option value="">请选择</option>${unitOpts("purchase_unit")}</select></div>
                <div class="form-item"><label>库存单位</label><select name="stock_unit"><option value="">请选择</option>${unitOpts("stock_unit")}</select></div>
                <div class="form-item"><label>销售→库存换算</label><input type="number" step="0.0001" name="sales_to_stock" value="${it ? it.sales_to_stock : 1}"></div>
                <div class="form-item"><label>采购→库存换算</label><input type="number" step="0.0001" name="purchase_to_stock" value="${it ? it.purchase_to_stock : 1}"></div>
            </div>
        </section>
        <section class="form-section">
            <div class="form-section-title"><h3>成本与售价</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>成本（本位币）</label><input type="number" step="0.0001" name="cost" value="${it ? it.cost : ""}" placeholder="影响库存价值与销货成本"></div>
                <div class="form-item"><label>售价</label><input type="number" step="0.0001" name="price" value="${it ? it.price : ""}"></div>
                <div class="form-item"><label>最低售价</label><input type="number" step="0.0001" name="min_price" value="${it ? it.min_price : ""}"></div>
                <div class="form-item"><label>采购币别</label><select name="purchase_currency"><option value="">请选择</option>${curOpts}</select></div>
                <div class="form-item"><label>安全库存</label><input type="number" step="0.0001" name="safety_stock" value="${it ? it.safety_stock : 0}"></div>
                <div class="form-item"><label>最高库存</label><input type="number" step="0.0001" name="max_stock" value="${it ? it.max_stock : 0}"></div>
            </div>
        </section>
        <section class="form-section">
            <div class="form-section-title"><h3>包装与物流</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>重量 (g)</label><input type="number" step="0.01" name="weight" value="${it ? it.weight : ""}"></div>
                <div class="form-item"><label>体积 (cm³)</label><input type="number" step="0.01" name="volume" value="${it ? it.volume : ""}"></div>
                <div class="form-item"><label>长 (cm)</label><input type="number" step="0.01" name="length_cm" value="${it ? it.length_cm : ""}"></div>
                <div class="form-item"><label>宽 (cm)</label><input type="number" step="0.01" name="width_cm" value="${it ? it.width_cm : ""}"></div>
                <div class="form-item"><label>高 (cm)</label><input type="number" step="0.01" name="height_cm" value="${it ? it.height_cm : ""}"></div>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark">${h(it ? it.remark : "")}</textarea></div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存商品</button>
            <a class="btn" href="#/master/items">返回</a>
        </div>
    </form>`;
    renderShell("items", content, "首页 / 基本资料 / 商品主档");
};

Pages.saveItem = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const existing = DB.find("items", i => i.code === d.code && i.id !== id);
    if (existing) { toast("品号已存在，请更换", "error"); return; }
    const payload = {
        code: d.code, name: d.item_name, english_name: d.english_name, spec: d.spec,
        brand: d.brand, model: d.model, category_id: d.category_id, product_type: d.product_type,
        sales_unit: d.sales_unit, purchase_unit: d.purchase_unit, stock_unit: d.stock_unit,
        sales_to_stock: Utils.num(d.sales_to_stock) || 1, purchase_to_stock: Utils.num(d.purchase_to_stock) || 1,
        cost: Utils.num(d.cost), price: Utils.num(d.price), min_price: Utils.num(d.min_price),
        purchase_currency: d.purchase_currency, safety_stock: Utils.num(d.safety_stock),
        max_stock: Utils.num(d.max_stock), weight: Utils.num(d.weight), volume: Utils.num(d.volume),
        length_cm: Utils.num(d.length_cm), width_cm: Utils.num(d.width_cm), height_cm: Utils.num(d.height_cm),
        barcode: d.barcode, qrcode: d.qrcode, remark: d.remark || "", disabled: d.disabled === "1"
    };
    if (id) {
        DB.update("items", id, payload);
        toast("商品已更新", "success");
    } else {
        DB.insert("items", payload);
        toast("商品已新增", "success");
    }
    render();
};

/* ============================================================
   客户主档
   ============================================================ */
Pages.customers = function () {
    const list = DB.list("customers").sort((a, b) => a.code.localeCompare(b.code));
    const rows = list.map(c => `
        <div class="master-card">
            <div class="mc-head">
                <div><div class="mc-name">${h(c.name)}</div><div class="mc-code">${h(c.code)}${c.english_name ? " · " + h(c.english_name) : ""}</div></div>
                ${c.disabled ? badge("停用") : badge("启用")}
            </div>
            <div class="mc-body">
                <div>联系人：${h(c.contact_person || "-")}　电话：${h(c.phone || "-")}</div>
                <div>地址：${h([c.city, c.address].filter(Boolean).join(" ") || "-")}　税号：${h(c.tax_id || "-")}</div>
                <div>币别：${h(c.currency || "-")}　付款：${h(c.payment_method || "-")}${c.payment_days ? "（" + c.payment_days + "天）" : ""}　额度：${fmt(c.credit_limit || 0)}</div>
                <div>等级：${h(c.level || "-")}　业务：${h(c.sales_owner || "-")}　修改：${h((c.updated_at || "").slice(0, 16))}</div>
            </div>
            <div class="mc-actions">
                <a class="btn sm" href="#/master/customers/${c.id}/edit">编辑</a>
                <button class="btn sm danger" onclick="Pages.deleteMaster('customers','${c.id}','客户')">删除</button>
            </div>
        </div>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>客户主档</h1><p>维护客户基础资料；销货订单必须指定客户。</p></div>
        <div class="head-actions">${can("master.customer") ? `<a class="btn primary" href="#/master/customers/create">+ 新增客户</a>` : ""}</div>
    </div>
    <div class="master-grid">${rows || `<div class="empty-state" style="grid-column:1/-1"><div class="big">👥</div>暂无客户</div>`}</div>
    <p class="stat-line">共 ${list.length} 笔客户</p>`;
    renderShell("customers", content, "首页 / 基本资料 / 客户主档");
};

Pages.customerForm = function (id) {
    const c = id ? DB.get("customers", id) : null;
    if (id && !c) { toast("找不到该客户", "error"); render(); return; }
    const isEdit = !!c;
    const curOpts = DB.list("currencies").map(x => `<option value="${x.code}" ${c && c.currency === x.code ? "selected" : ""}>${h(x.code)} - ${h(x.name)}</option>`).join("");
    const ownerOpts = DB.list("users").map(u => `<option ${c && c.sales_owner === u.name ? "selected" : ""}>${h(u.name)}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h2>客户主档｜${isEdit ? "编辑" : "新增"}</h2><p>散客与平台订单可使用 WALKIN 客户。</p></div>
        <div class="actions"><a class="btn" href="#/master/customers">返回客户主档</a></div>
    </div>
    <form class="form-panel" onsubmit="Pages.saveCustomer(event, '${id || ""}')">
        <div class="form-grid section-grid">
            <div class="form-item"><label>客户代码<b>*</b></label><input name="code" value="${h(c ? c.code : "")}" required placeholder="如 CUS000001"></div>
            <div class="form-item"><label>客户名称<b>*</b></label><input name="customer_name" value="${h(c ? c.name : "")}" required></div>
            <div class="form-item"><label>英文名称</label><input name="english_name" value="${h(c ? c.english_name : "")}"></div>
            <div class="form-item"><label>联系人</label><input name="contact_person" value="${h(c ? c.contact_person : "")}"></div>
            <div class="form-item"><label>电话</label><input name="phone" value="${h(c ? c.phone : "")}"></div>
            <div class="form-item"><label>传真</label><input name="fax" value="${h(c ? c.fax : "")}"></div>
            <div class="form-item"><label>Email</label><input name="email" value="${h(c ? c.email : "")}"></div>
            <div class="form-item"><label>城市</label><input name="city" value="${h(c ? c.city : "")}"></div>
            <div class="form-item"><label>国家/地区</label><input name="country" value="${h(c ? c.country : "")}"></div>
            <div class="form-item wide"><label>地址</label><input name="address" value="${h(c ? c.address : "")}"></div>
            <div class="form-item"><label>统一编号</label><input name="tax_id" value="${h(c ? c.tax_id : "")}"></div>
            <div class="form-item"><label>付款方式</label><select name="payment_method">${payMethodOptions(c ? c.payment_method : "")}</select></div>
            <div class="form-item"><label>付款天数</label><input type="number" name="payment_days" value="${c ? c.payment_days : 0}"></div>
            <div class="form-item"><label>币别</label><select name="currency">${curOpts}</select></div>
            <div class="form-item"><label>信用额度</label><input type="number" name="credit_limit" value="${c ? c.credit_limit : 0}"></div>
            <div class="form-item"><label>客户等级</label>
                <select name="customer_level"><option ${!c || c.level === "散客" ? "selected" : ""}>散客</option><option ${c && c.level === "批发客户" ? "selected" : ""}>批发客户</option><option ${c && c.level === "平台客户" ? "selected" : ""}>平台客户</option><option ${c && c.level === "重点客户" ? "selected" : ""}>重点客户</option></select></div>
            <div class="form-item"><label>业务员</label><select name="sales_owner"><option value="">请选择</option>${ownerOpts}</select></div>
            <div class="form-item"><label>状态</label><select name="disabled"><option value="0" ${!c || !c.disabled ? "selected" : ""}>启用</option><option value="1" ${c && c.disabled ? "selected" : ""}>停用</option></select></div>
            <div class="form-item wide"><label>备注</label><textarea name="remark">${h(c ? c.remark : "")}</textarea></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存客户</button>
            <a class="btn" href="#/master/customers">返回</a>
        </div>
    </form>`;
    renderShell("customers", content, "首页 / 基本资料 / 客户主档");
};

Pages.saveCustomer = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const payload = {
        code: d.code, name: d.customer_name, english_name: d.english_name,
        contact_person: d.contact_person, phone: d.phone, fax: d.fax, email: d.email,
        city: d.city, country: d.country, address: d.address, tax_id: d.tax_id,
        payment_method: d.payment_method, payment_days: Utils.num(d.payment_days),
        currency: d.currency, credit_limit: Utils.num(d.credit_limit),
        level: d.customer_level, sales_owner: d.sales_owner,
        remark: d.remark || "", disabled: d.disabled === "1"
    };
    if (id) {
        DB.update("customers", id, payload);
        toast("客户已更新", "success");
    } else {
        DB.insert("customers", payload);
        toast("客户已新增", "success");
    }
    render();
};

/* ============================================================
   供应商主档
   ============================================================ */
Pages.suppliers = function () {
    const list = DB.list("suppliers").sort((a, b) => a.code.localeCompare(b.code));
    const rows = list.map(s => `
        <div class="master-card">
            <div class="mc-head">
                <div><div class="mc-name">${h(s.name)}</div><div class="mc-code">${h(s.code)}${s.english_name ? " · " + h(s.english_name) : ""}</div></div>
                ${s.disabled ? badge("停用") : badge("启用")}
            </div>
            <div class="mc-body">
                <div>联系人：${h(s.contact_person || "-")}　电话：${h(s.phone || "-")}</div>
                <div>地址：${h([s.city, s.country].filter(Boolean).join(" ") || "-")}　税号：${h(s.tax_id || "-")}</div>
                <div>币别：${h(s.currency || "-")}　付款：${h(s.payment_method || "-")}　额度：${fmt(s.credit_limit || 0)}</div>
                <div>等级：${h(s.level || "-")}　修改：${h((s.updated_at || "").slice(0, 16))}</div>
            </div>
            <div class="mc-actions">
                <a class="btn sm" href="#/master/suppliers/${s.id}/edit">编辑</a>
                <button class="btn sm danger" onclick="Pages.deleteMaster('suppliers','${s.id}','供应商')">删除</button>
            </div>
        </div>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>供应商主档</h1><p>维护供应商基础资料；采购单必须指定供应商。</p></div>
        <div class="head-actions">${can("master.supplier") ? `<a class="btn primary" href="#/master/suppliers/create">+ 新增供应商</a>` : ""}</div>
    </div>
    <div class="master-grid">${rows || `<div class="empty-state" style="grid-column:1/-1"><div class="big">🏭</div>暂无供应商</div>`}</div>
    <p class="stat-line">共 ${list.length} 笔供应商</p>`;
    renderShell("suppliers", content, "首页 / 基本资料 / 供应商主档");
};

Pages.supplierForm = function (id) {
    const s = id ? DB.get("suppliers", id) : null;
    if (id && !s) { toast("找不到该供应商", "error"); render(); return; }
    const isEdit = !!s;
    const curOpts = DB.list("currencies").map(x => `<option value="${x.code}" ${s && s.currency === x.code ? "selected" : ""}>${h(x.code)} - ${h(x.name)}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h2>供应商主档｜${isEdit ? "编辑" : "新增"}</h2></div>
        <div class="actions"><a class="btn" href="#/master/suppliers">返回供应商主档</a></div>
    </div>
    <form class="form-panel" onsubmit="Pages.saveSupplier(event, '${id || ""}')">
        <div class="form-grid section-grid">
            <div class="form-item"><label>供应商代码<b>*</b></label><input name="code" value="${h(s ? s.code : "")}" required placeholder="如 SUP000001"></div>
            <div class="form-item"><label>供应商名称<b>*</b></label><input name="supplier_name" value="${h(s ? s.name : "")}" required></div>
            <div class="form-item"><label>英文名称</label><input name="english_name" value="${h(s ? s.english_name : "")}"></div>
            <div class="form-item"><label>联系人</label><input name="contact_person" value="${h(s ? s.contact_person : "")}"></div>
            <div class="form-item"><label>电话</label><input name="phone" value="${h(s ? s.phone : "")}"></div>
            <div class="form-item"><label>传真</label><input name="fax" value="${h(s ? s.fax : "")}"></div>
            <div class="form-item"><label>Email</label><input name="email" value="${h(s ? s.email : "")}"></div>
            <div class="form-item"><label>城市</label><input name="city" value="${h(s ? s.city : "")}"></div>
            <div class="form-item"><label>国家/地区</label><input name="country" value="${h(s ? s.country : "")}"></div>
            <div class="form-item wide"><label>地址</label><input name="address" value="${h(s ? s.address : "")}"></div>
            <div class="form-item"><label>统一编号</label><input name="tax_id" value="${h(s ? s.tax_id : "")}"></div>
            <div class="form-item"><label>付款方式</label><select name="payment_method">${payMethodOptions(s ? s.payment_method : "")}</select></div>
            <div class="form-item"><label>付款天数</label><input type="number" name="payment_days" value="${s ? s.payment_days : 0}"></div>
            <div class="form-item"><label>币别</label><select name="currency">${curOpts}</select></div>
            <div class="form-item"><label>信用额度</label><input type="number" name="credit_limit" value="${s ? s.credit_limit : 0}"></div>
            <div class="form-item"><label>供应商等级</label>
                <select name="supplier_level"><option ${!s || s.level === "国内供应商" ? "selected" : ""}>国内供应商</option><option ${s && s.level === "国外供应商" ? "selected" : ""}>国外供应商</option><option ${s && s.level === "重点供应商" ? "selected" : ""}>重点供应商</option></select></div>
            <div class="form-item"><label>状态</label><select name="disabled"><option value="0" ${!s || !s.disabled ? "selected" : ""}>启用</option><option value="1" ${s && s.disabled ? "selected" : ""}>停用</option></select></div>
            <div class="form-item wide"><label>备注</label><textarea name="remark">${h(s ? s.remark : "")}</textarea></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存供应商</button>
            <a class="btn" href="#/master/suppliers">返回</a>
        </div>
    </form>`;
    renderShell("suppliers", content, "首页 / 基本资料 / 供应商主档");
};

Pages.saveSupplier = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const payload = {
        code: d.code, name: d.supplier_name, english_name: d.english_name,
        contact_person: d.contact_person, phone: d.phone, fax: d.fax, email: d.email,
        city: d.city, country: d.country, address: d.address, tax_id: d.tax_id,
        payment_method: d.payment_method, payment_days: Utils.num(d.payment_days),
        currency: d.currency, credit_limit: Utils.num(d.credit_limit),
        level: d.supplier_level, remark: d.remark || "", disabled: d.disabled === "1"
    };
    if (id) {
        DB.update("suppliers", id, payload);
        toast("供应商已更新", "success");
    } else {
        DB.insert("suppliers", payload);
        toast("供应商已新增", "success");
    }
    render();
};

/* ============================================================
   仓库主档
   ============================================================ */
Pages.warehouses = function () {
    const list = DB.list("warehouses");
    const rows = list.map(w => {
        const stockMap = DB.stockMap()[w.id] || {};
        const kinds = Object.keys(stockMap).length;
        const qty = Object.keys(stockMap).reduce((s, k) => s + Utils.num(stockMap[k]), 0);
        const value = Object.keys(stockMap).reduce((s, k) => s + DB.stockValue(k), 0);
        return `<tr>
            <td><b>${h(w.code)}</b></td>
            <td><b>${h(w.name)}</b></td>
            <td>${h(w.contact || "-")}</td>
            <td>${h(w.phone || "-")}</td>
            <td>${h(w.address || "-")}</td>
            <td class="num">${kinds}</td>
            <td class="num">${qty}</td>
            <td class="num">${fmt(value)}</td>
            <td class="action-col">
                <a class="link-btn" href="#/master/warehouses/${w.id}/edit">编辑</a>
                <button class="link-btn danger" onclick="Pages.deleteMaster('warehouses','${w.id}','仓库')">删除</button>
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>仓库主档</h1><p>维护仓库基础资料；采购进货、销货出货与库存调整都要指定仓库。</p></div>
        <div class="head-actions">${can("master.warehouse") ? `<a class="btn primary" href="#/master/warehouses/create">+ 新增仓库</a>` : ""}</div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>仓库代码</th><th>仓库名称</th><th>联系人</th><th>电话</th><th>地址</th><th class="num">品项数</th><th class="num">库存总量</th><th class="num">库存价值</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="9"><div class="empty-state"><div class="big">🏬</div>暂无仓库</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔仓库</p>`;
    renderShell("warehouses", content, "首页 / 基本资料 / 仓库主档");
};

Pages.warehouseForm = function (id) {
    const w = id ? DB.get("warehouses", id) : null;
    if (id && !w) { toast("找不到该仓库", "error"); render(); return; }
    const isEdit = !!w;
    const content = `
    <div class="page-head">
        <div><h2>仓库主档｜${isEdit ? "编辑" : "新增"}</h2></div>
        <div class="actions"><a class="btn" href="#/master/warehouses">返回仓库主档</a></div>
    </div>
    <form class="form-panel" style="max-width:820px" onsubmit="Pages.saveWarehouse(event, '${id || ""}')">
        <div class="form-grid section-grid">
            <div class="form-item"><label>仓库代码<b>*</b></label><input name="code" value="${h(w ? w.code : "")}" required placeholder="如 WH001"></div>
            <div class="form-item"><label>仓库名称<b>*</b></label><input name="name" value="${h(w ? w.name : "")}" required></div>
            <div class="form-item"><label>联系人</label><input name="contact" value="${h(w ? w.contact : "")}"></div>
            <div class="form-item"><label>电话</label><input name="phone" value="${h(w ? w.phone : "")}"></div>
            <div class="form-item wide"><label>地址</label><input name="address" value="${h(w ? w.address : "")}"></div>
            <div class="form-item wide"><label>备注</label><textarea name="remark">${h(w ? w.remark : "")}</textarea></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存仓库</button>
            <a class="btn" href="#/master/warehouses">返回</a>
        </div>
    </form>`;
    renderShell("warehouses", content, "首页 / 基本资料 / 仓库主档");
};

Pages.saveWarehouse = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const payload = { code: d.code, name: d.name, contact: d.contact, phone: d.phone, address: d.address, remark: d.remark || "" };
    if (id) {
        DB.update("warehouses", id, payload);
        toast("仓库已更新", "success");
    } else {
        DB.insert("warehouses", payload);
        toast("仓库已新增", "success");
    }
    render();
};

/* ============================================================
   通用主档删除
   ============================================================ */
Pages.deleteMaster = function (coll, id, label) {
    confirmModal(`确定要删除这笔${label}资料吗？`, () => {
        DB.remove(coll, id);
        toast(label + "已删除", "success");
        render();
    });
};

/* ============================================================
   简单主档（单位/币别/分类/物流/付款条件）
   ============================================================ */
Pages.simpleMaster = function (coll, title) {
    const list = DB.list(coll);
    let columns = [], rows = "";
    const confs = {
        units: { cols: [["name", "单位名称"], ["code", "代码"], ["remark", "备注"]], add: "新增单位" },
        currencies: { cols: [["code", "币别代码"], ["name", "币别名称"], ["rate", "汇率"], ["symbol", "符号"], ["is_base", "本位币"]], add: "新增币别" },
        categories: { cols: [["name", "分类名称"], ["parent_id", "上级分类"], ["created_at", "建立时间"]], add: "新增分类" },
        shipping_methods: { cols: [["name", "物流方式"], ["remark", "备注"]], add: "新增物流方式" },
        payment_terms: { cols: [["name", "付款条件"], ["days", "付款天数"], ["remark", "备注"]], add: "新增付款条件" }
    };
    const conf = confs[coll];
    const cols = conf.cols;
    rows = list.map((r, idx) => `<tr>
        ${cols.map(([k]) => {
            if (k === "is_base") return `<td>${r.is_base ? badge("本位币") : '-'}</td>`;
            if (k === "parent_id") return `<td>${r.parent_id ? h(DB.get("categories", r.parent_id)?.name || r.parent_id) : '<span style="color:var(--muted)">顶级</span>'}</td>`;
            if (k === "rate") return `<td class="num">${r.rate}</td>`;
            if (k === "days") return `<td class="num">${r.days} 天</td>`;
            return `<td>${h(r[k] ?? "")}</td>`;
        }).join("")}
        <td class="action-col">
            <button class="link-btn" onclick="Pages.simpleMasterEdit('${coll}','${r.id}')">编辑</button>
            <button class="link-btn danger" onclick="Pages.deleteMaster('${coll}','${r.id}','${title}')">删除</button>
        </td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>${title}</h1></div>
        <div class="head-actions">${can("master.basic") ? `<button class="btn primary" onclick="Pages.simpleMasterAdd('${coll}')">+ ${conf.add}</button>` : ""}</div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr>${cols.map(([, label]) => `<th>${label}</th>`).join("")}<th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="${cols.length + 1}"><div class="empty-state"><div class="big">📋</div>暂无资料</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔</p>`;
    const codeMap = { units: "units", currencies: "currencies", categories: "categories", shipping_methods: "shipping_methods", payment_terms: "payment_terms" };
    renderShell(codeMap[coll], content, "首页 / 基本资料 / " + title);
};

Pages.simpleMasterAdd = function (coll) {
    Pages.simpleMasterModal(coll, null);
};

Pages.simpleMasterEdit = function (coll, id) {
    Pages.simpleMasterModal(coll, id);
};

Pages.simpleMasterModal = function (coll, id) {
    const r = id ? DB.get(coll, id) : null;
    const fields = {
        units: [
            { k: "name", label: "单位名称", req: true },
            { k: "code", label: "代码", req: false },
            { k: "remark", label: "备注", req: false, area: true }
        ],
        currencies: [
            { k: "code", label: "币别代码", req: true },
            { k: "name", label: "币别名称", req: true },
            { k: "rate", label: "汇率(兑本位币)", req: true, type: "number", step: "0.00001" },
            { k: "symbol", label: "符号", req: false },
            { k: "is_base", label: "本位币", req: false, check: true }
        ],
        categories: [
            { k: "name", label: "分类名称", req: true },
            { k: "parent_id", label: "上级分类", req: false, select: "categories" },
            { k: "remark", label: "备注", req: false, area: true }
        ],
        shipping_methods: [
            { k: "name", label: "物流方式", req: true },
            { k: "remark", label: "备注", req: false, area: true }
        ],
        payment_terms: [
            { k: "name", label: "付款条件", req: true },
            { k: "days", label: "付款天数", req: false, type: "number" },
            { k: "remark", label: "备注", req: false, area: true }
        ]
    };
    const fdef = fields[coll];
    const catOpts = DB.list("categories").filter(x => x.id !== id).map(x => `<option value="${x.id}" ${r && r.parent_id === x.id ? "selected" : ""}>${h(x.name)}</option>`).join("");

    const body = fdef.map(f => {
        let input;
        if (f.select) {
            input = `<select name="${f.k}" ${f.req ? "required" : ""}><option value="">（无/顶级）</option>${catOpts}</select>`;
        } else if (f.check) {
            input = `<label class="inline-check"><input type="checkbox" name="${f.k}" value="1" ${r && r.is_base ? "checked" : ""}> 该币别为本位币</label>`;
        } else if (f.area) {
            input = `<textarea name="${f.k}">${h(r ? r[f.k] || "" : "")}</textarea>`;
        } else {
            input = `<input type="${f.type || "text"}" name="${f.k}" ${f.req ? "required" : ""} step="${f.step || ""}" value="${h(r ? r[f.k] ?? "" : "")}">`;
        }
        return `<div class="form-item" style="margin-bottom:12px"><label>${f.label}${f.req ? "<b>*</b>" : ""}</label>${input}</div>`;
    }).join("");

    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:480px">
        <div class="modal-head"><h3>${r ? "编辑" : "新增"}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body"><form id="smForm" onsubmit="Pages.saveSimpleMaster(event, '${coll}', '${id || ""}')">${body}</form></div>
        <div class="modal-foot">
            <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
            <button class="btn primary" onclick="document.getElementById('smForm').requestSubmit()">保存</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
};

Pages.saveSimpleMaster = function (e, coll, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const r = id ? DB.get(coll, id) : null;
    const payload = {};
    const fdef = {
        units: ["name", "code", "remark"],
        currencies: ["code", "name", "rate", "symbol", "is_base"],
        categories: ["name", "parent_id", "remark"],
        shipping_methods: ["name", "remark"],
        payment_terms: ["name", "days", "remark"]
    }[coll];
    fdef.forEach(k => {
        if (k === "rate") payload[k] = Utils.num(d[k]);
        else if (k === "days") payload[k] = Utils.num(d[k]);
        else if (k === "is_base") payload[k] = d[k] === "1";
        else payload[k] = d[k] || "";
    });
    if (id) {
        DB.update(coll, id, payload);
        toast("已更新", "success");
    } else {
        DB.insert(coll, payload);
        toast("已新增", "success");
    }
    document.querySelector(".modal-mask")?.remove();
    render();
};
