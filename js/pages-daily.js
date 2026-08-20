/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 日常作业页面
   销货订单 / 出货单 / 采购单 / 库存调整 / 退回折让
   ============================================================ */
"use strict";

const Pages = {};

/* ---------------- 共用辅助 ---------------- */
function nextDocNo(prefix, collection, date) {
    return Utils.nextNo(prefix, date || Utils.today(), { list: () => DB.list(collection) });
}
function itemOptions(selectedId) {
    return DB.list("items").filter(i => !i.disabled).map(i =>
        `<option value="${i.id}" data-code="${h(i.code)}" data-name="${h(i.name)}" data-price="${i.price}" data-unit="${h(i.sales_unit)}" ${selectedId === i.id ? "selected" : ""}>${h(i.code)} - ${h(i.name)}</option>`
    ).join("");
}
function customerOptions(selectedId) {
    return DB.list("customers").filter(c => !c.disabled).map(c =>
        `<option value="${c.id}" data-code="${h(c.code)}" data-currency="${h(c.currency || "")}" ${selectedId === c.id ? "selected" : ""}>${h(c.code)} - ${h(c.name)}</option>`
    ).join("");
}
function supplierOptions(selectedId) {
    return DB.list("suppliers").filter(s => !s.disabled).map(s =>
        `<option value="${s.id}" data-currency="${h(s.currency || "")}" ${selectedId === s.id ? "selected" : ""}>${h(s.code)} - ${h(s.name)}</option>`
    ).join("");
}
function warehouseOptions(selectedId) {
    return DB.list("warehouses").map(w =>
        `<option value="${w.id}" ${selectedId === w.id ? "selected" : ""}>${h(w.code)} - ${h(w.name)}</option>`
    ).join("");
}
function currencyOptions(selectedId) {
    return DB.list("currencies").map(c =>
        `<option value="${c.code}" ${selectedId === c.code ? "selected" : ""}>${h(c.code)} - ${h(c.name)}</option>`
    ).join("");
}
function payMethodOptions(selected) {
    const list = ["现款现货", "货到付款", "月结30天", "月结60天", "预付50%", "支付宝/微信"];
    return list.map(m => `<option ${selected === m ? "selected" : ""}>${m}</option>`).join("");
}
function feeMethodOptions(selected) {
    const list = ["现金", "银行转账", "支付宝", "微信", "支票"];
    return list.map(m => `<option ${selected === m ? "selected" : ""}>${m}</option>`).join("");
}
function logisticsOptions(selected) {
    return DB.list("shipping_methods").map(m =>
        `<option ${selected === m.name ? "selected" : ""}>${h(m.name)}</option>`).join("");
}
function channelOptions(selected) {
    const list = ["一般销货", "散客", "淘宝", "拼多多", "抖音", "其他平台"];
    return list.map(c => `<option ${selected === c ? "selected" : ""}>${c}</option>`).join("");
}

/* 订单金额计算（与原始系统逻辑一致） */
function calcOrderTotals(goodsTotal, fees, taxType, priceMode, taxRate, settlementTaxIncluded) {
    let basis = goodsTotal;
    if (settlementTaxIncluded) basis = basis - fees;
    basis = Math.max(basis, 0);
    const rate = taxRate > 1 ? taxRate / 100 : taxRate;
    let taxable = basis, tax = 0, invoice = basis;
    if (taxType === "应税" && rate > 0) {
        if (priceMode === "含税") {
            invoice = Utils.round(basis);
            taxable = Utils.round(invoice / (1 + rate));
            tax = Utils.round(invoice - taxable);
        } else {
            taxable = Utils.round(basis);
            tax = Utils.round(taxable * rate);
            invoice = Utils.round(taxable + tax);
        }
    } else {
        taxable = Utils.round(basis);
        invoice = Utils.round(basis);
    }
    const net = Math.round(Math.max(settlementTaxIncluded ? invoice : invoice - fees, 0));
    return { taxable, tax, invoice, net };
}

/* ============================================================
   销货订单
   ============================================================ */
Pages.salesOrders = function () {
    const orders = DB.list("sales_orders").sort((a, b) => b.no.localeCompare(a.no));
    const rows = orders.map(o => {
        const cu = DB.get("customers", o.customer_id);
        const goods = o.lines.reduce((s, l) => s + Utils.num(l.amount), 0);
        const shipRow = DB.find("shipments", s => s.sales_order_id === o.id);
        const shipDate = shipRow ? shipRow.ship_date : "-";
        return `<tr>
            <td><a href="#/sales-orders/${o.id}"><b>${h(o.no)}</b></a></td>
            <td>${h(o.order_date)}</td>
            <td><span class="badge gray">${h(o.channel)}</span></td>
            <td>${h(cu ? cu.name : "")}</td>
            <td>${h(o.platform_no || "-")}</td>
            <td class="num">${fmt(o.invoice_amount)}</td>
            <td class="num">${fmt(o.shipping_fee + o.platform_fee + o.payment_fee + o.other_fee)}</td>
            <td class="num">${fmt(o.tax_amount)}</td>
            <td class="num">${fmt(o.net_receipt)}</td>
            <td>${soStatusBadge(o.status)}${shipRow ? `<span style="display:block;font-size:11.5px;color:var(--muted)">${h(shipDate)}</span>` : ""}</td>
            <td>${o.payment_status === "paid" ? badge("已收款") : badge("未收款")}</td>
            <td>${h(o.logistics_method || "-")}</td>
            <td>${o.invoice_status ? badge(o.invoice_status) : '-'}</td>
            <td class="action-col">
                <a class="link-btn" href="#/sales-orders/${o.id}">查看</a>
                <a class="link-btn" href="#/sales-orders/${o.id}/edit">编辑</a>
                <button class="link-btn" onclick="Pages.printSalesOrder('${o.id}')">打印</button>
                ${o.status === "draft" && can("sales.ship") ? `<button class="link-btn" onclick="Pages.shipOrder('${o.id}')">出货</button>` : ""}
                <button class="link-btn danger" onclick="Pages.deleteSalesOrder('${o.id}')">删除</button>
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>销货订单</h1><p>订单负责成交、出货与应收依据；核账与传票留在财务流程。</p></div>
        <div class="head-actions">
            ${can("sales.create") ? `<a class="btn primary" href="#/sales-orders/create">+ 新增销货订单</a>` : ""}
            <a class="btn ghost" href="#/accounting/accounts-receivable">应收账款</a>
        </div>
    </div>
    <div class="toolbar">
        <div class="search"><input id="soSearch" placeholder="搜索单号/客户/平台单号..." oninput="Pages.soSearch()"></div>
        <div class="filters">
            <select id="soStatusFilter" onchange="Pages.soSearch()">
                <option value="">全部状态</option><option value="draft">未出货</option><option value="shipped">已出货</option>
            </select>
            <select id="soChannelFilter" onchange="Pages.soSearch()">
                <option value="">全部来源</option>${channelOptions("").split("</option>").map(x => x.replace(/selected/g, "")).join("</option>")}
            </select>
        </div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr>
                <th>订单单号</th><th>订单日期</th><th>来源</th><th>客户 / 收件人</th><th>平台单号</th>
                <th class="num">销售金额</th><th class="num">销售费用</th><th class="num">税额</th><th class="num">预估实收</th>
                <th>出货</th><th>收款</th><th>物流</th><th>发票</th><th class="action-col">操作</th>
            </tr></thead>
            <tbody id="soBody">${rows}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${orders.length} 笔销货订单</p>`;
    renderShell("sales_orders", content, "首页 / 日常作业 / 销货订单");
};

Pages.soSearch = function () {
    const q = (document.getElementById("soSearch").value || "").trim().toLowerCase();
    const st = document.getElementById("soStatusFilter").value;
    const ch = document.getElementById("soChannelFilter").value;
    const rows = DB.list("sales_orders").sort((a, b) => b.no.localeCompare(a.no)).filter(o => {
        const cu = DB.get("customers", o.customer_id);
        const txt = (o.no + " " + (cu ? cu.name : "") + " " + (o.platform_no || "")).toLowerCase();
        return (!q || txt.indexOf(q) >= 0) && (!st || o.status === st) && (!ch || o.channel === ch);
    });
    const body = document.getElementById("soBody");
    if (!body) return;
    body.innerHTML = rows.map(o => {
        const cu = DB.get("customers", o.customer_id);
        return `<tr>
            <td><a href="#/sales-orders/${o.id}"><b>${h(o.no)}</b></a></td>
            <td>${h(o.order_date)}</td>
            <td><span class="badge gray">${h(o.channel)}</span></td>
            <td>${h(cu ? cu.name : "")}</td>
            <td>${h(o.platform_no || "-")}</td>
            <td class="num">${fmt(o.invoice_amount)}</td>
            <td class="num">${fmt(o.shipping_fee + o.platform_fee + o.payment_fee + o.other_fee)}</td>
            <td class="num">${fmt(o.tax_amount)}</td>
            <td class="num">${fmt(o.net_receipt)}</td>
            <td>${soStatusBadge(o.status)}</td>
            <td>${o.payment_status === "paid" ? badge("已收款") : badge("未收款")}</td>
            <td>${h(o.logistics_method || "-")}</td>
            <td>${o.invoice_status ? badge(o.invoice_status) : '-'}</td>
            <td class="action-col">
                <a class="link-btn" href="#/sales-orders/${o.id}">查看</a>
                <a class="link-btn" href="#/sales-orders/${o.id}/edit">编辑</a>
                <button class="link-btn" onclick="Pages.printSalesOrder('${o.id}')">打印</button>
                ${o.status === "draft" && can("sales.ship") ? `<button class="link-btn" onclick="Pages.shipOrder('${o.id}')">出货</button>` : ""}
                <button class="link-btn danger" onclick="Pages.deleteSalesOrder('${o.id}')">删除</button>
            </td>
        </tr>`;
    }).join("");
};

Pages.deleteSalesOrder = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    if (o.status !== "draft") { toast("已出货的订单不能删除，请先处理关联的出货单", "error"); return; }
    confirmModal(`确定要删除销货订单 ${o.no} 吗？此操作不可恢复。`, () => {
        DB.remove("sales_orders", id);
        toast("销货订单已删除", "success");
        render();
    });
};

/* ---- 销货订单查看（只读详情） ---- */
Pages.salesOrderDetail = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) { toast("找不到该销货订单", "error"); render(); return; }
    const cu = DB.get("customers", o.customer_id);
    const shipRow = DB.find("shipments", s => s.sales_order_id === o.id);
    const wh = shipRow ? DB.get("warehouses", shipRow.warehouse_id) : null;
    const goods = o.lines.reduce((s, l) => s + Utils.num(l.amount), 0);
    const fees = Utils.num(o.shipping_fee) + Utils.num(o.platform_fee) + Utils.num(o.payment_fee) + Utils.num(o.other_fee);

    const content = `
    <div class="page-head">
        <div><h1>销货订单｜${h(o.no)}</h1>
        <p>订单日期 ${h(o.order_date)} ｜ ${h(o.channel)}${o.platform_no ? ` ｜ 平台单号 ${h(o.platform_no)}` : ""} ｜ ${o.status === "shipped" ? "已出货" : "未出货"}</p></div>
        <div class="head-actions">
            <button class="btn" onclick="Pages.printSalesOrder('${o.id}')">🖨 打印</button>
            <a class="btn ghost" href="#/sales-orders/${o.id}/edit">编辑</a>
            <a class="btn" href="#/sales-orders">返回列表</a>
        </div>
    </div>
    <div class="doc-audit">
        <div><span>客户</span><strong>${h(cu ? cu.name : "-")}</strong></div>
        <div><span>收件人</span><strong>${h(o.recipient_name || (cu ? cu.name : "") || "-")}</strong></div>
        <div><span>联系电话</span><strong>${h(o.recipient_phone || "-")}</strong></div>
        <div><span>收件地址</span><strong>${h(o.shipping_address || "-")}</strong></div>
        <div><span>业务员</span><strong>${h(o.sales_owner || "-")}</strong></div>
        <div><span>物流方式</span><strong>${h(o.logistics_method || "-")}</strong></div>
        <div><span>物流单号</span><strong>${h(o.shipment_no || "-")}</strong></div>
        <div><span>收款状态</span><strong>${o.payment_status === "paid" ? badge("已收款") : badge("未收款")}</strong></div>
        <div><span>发票状态</span><strong>${o.invoice_status ? badge(o.invoice_status) : '-'}</strong></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>品号</th><th>品名</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th><th>备注</th></tr></thead>
            <tbody>${o.lines.map(l => `<tr>
                <td>${h(l.code)}</td><td>${h(l.name)}</td>
                <td class="num">${l.qty}</td><td>${h(l.unit)}</td>
                <td class="num">${fmt(l.unit_price)}</td><td class="num">${fmt(l.amount)}</td>
                <td>${h(l.remark || "")}</td>
            </tr>`).join("")}</tbody>
        </table>
    </div>
    <div class="order-summary-bar" style="margin-top:16px">
        <div><span>商品小计</span><strong>${fmt(goods)}</strong></div>
        <div><span>销售费用</span><strong>${fmt(fees)}</strong></div>
        <div><span>税额</span><strong>${fmt(o.tax_amount)}</strong></div>
        <div><span>应收总额</span><strong>${fmt(o.invoice_amount)}</strong></div>
        <div><span>预估实收</span><strong>${fmt(o.net_receipt)}</strong></div>
    </div>
    ${shipRow ? `<div class="doc-flow-card" style="margin-top:16px">
        <div><span class="doc-flow-label">出货信息</span>
        <strong>出货单 <a href="#/shipments/${shipRow.id}">${h(shipRow.no)}</a> ｜ ${h(shipRow.ship_date)} ｜ ${h(wh ? wh.name : "")}</strong>
        <p>${h(shipRow.logistics_method || "")}${shipRow.shipment_no ? ` ｜ 物流单号 ${h(shipRow.shipment_no)}` : ""}</p></div>
    </div>` : ""}
    ${o.remark ? `<p class="stat-line" style="margin-top:12px">备注：${h(o.remark)}</p>` : ""}`;
    renderShell("sales_orders", content, "首页 / 日常作业 / 销货订单 / " + o.no);
};

/* ---- 销货订单打印（大陆格式） ---- */
Pages.printSalesOrder = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) { toast("找不到该销货订单", "error"); return; }
    const cu = DB.get("customers", o.customer_id);
    const goods = o.lines.reduce((s, l) => s + Utils.num(l.amount), 0);
    const lines = o.lines.map((l, i) => {
        const it = DB.get("items", l.item_id);
        return `<tr><td class="c">${i + 1}</td><td>${h(l.code)}</td><td>${h(l.name)}</td><td>${h(it ? it.spec : "")}</td><td class="c">${l.qty}</td><td class="c">${h(l.unit)}</td><td class="r">${fmt(l.unit_price)}</td><td class="r">${fmt(l.amount)}</td></tr>`;
    }).join("");
    const body = `
    <div class="doc-head">
        <div class="company">${h(COMPANY.name)}</div>
        <div class="en">${h(COMPANY.en)}</div>
    </div>
    <div class="doc-title">销 货 订 单</div>
    <div class="meta">
        <span>单据编号：<b>${h(o.no)}</b></span>
        <span>订单日期：<b>${h(o.order_date)}</b></span>
        <span>预计出货：<b>${h(o.delivery_date || "-")}</b></span>
        <span>销售来源：<b>${h(o.channel)}</b></span>
        <span>平台单号：<b>${h(o.platform_no || "-")}</b></span>
        <span>业务员：<b>${h(o.sales_owner || "-")}</b></span>
    </div>
    <div class="meta">
        <span>客户名称：<b>${h(cu ? cu.name : "-")}</b></span>
        <span>联系电话：<b>${h(o.recipient_phone || (cu ? cu.phone : "") || "-")}</b></span>
        <span>物流方式：<b>${h(o.logistics_method || "-")}</b></span>
    </div>
    <div class="meta"><span>收件地址：<b>${h(o.shipping_address || (cu ? cu.address : "") || "-")}</b></span></div>
    <table>
        <thead><tr><th style="width:36px">序号</th><th style="width:104px">品号</th><th>品名</th><th style="width:84px">规格</th><th style="width:56px">数量</th><th style="width:52px">单位</th><th style="width:88px">单价</th><th style="width:98px">金额</th></tr></thead>
        <tbody>${lines}</tbody>
    </table>
    <div class="totals">
        <div>商品小计：<b>¥${fmt(goods)}</b>　运费：¥${fmt(o.shipping_fee)}　平台手续费：¥${fmt(o.platform_fee)}　金流手续费：¥${fmt(o.payment_fee)}　其他费用：¥${fmt(o.other_fee)}</div>
        <div>未税销售额：¥${fmt(o.taxable_amount)}　税额：¥${fmt(o.tax_amount)}　预估实收：¥${fmt(o.net_receipt)}　收款状态：${o.payment_status === "paid" ? "已收款" : "未收款"}</div>
        <div>应收总额：<b>¥${fmt(o.invoice_amount)}</b></div>
        <div class="up">金额大写（人民币）：${rmbUpper(o.invoice_amount)}</div>
    </div>
    <div class="remark">备注：${h(o.remark || "")}</div>
    <div class="sign">
        <div><div class="line"></div>制单人：${h(DB.currentUser() ? DB.currentUser().name : "")}</div>
        <div><div class="line"></div>审核人：</div>
        <div><div class="line"></div>打印日期：${Utils.today()}</div>
    </div>
    <div class="foot-note">本单据由 ${h(COMPANY.name)} ERP 系统自动生成，仅用于业务对账参考</div>`;
    printDoc("销货订单 " + o.no, body);
};

/* ---- 出货单打印（大陆送货单格式） ---- */
Pages.printShipment = function (id) {
    const s = DB.get("shipments", id);
    if (!s) { toast("找不到该出货单", "error"); return; }
    const wh = DB.get("warehouses", s.warehouse_id);
    const goods = s.lines.reduce((a, l) => a + Utils.num(l.amount), 0);
    const totalQty = s.lines.reduce((a, l) => a + Utils.num(l.qty), 0);
    const lines = s.lines.map((l, i) => {
        const it = DB.get("items", l.item_id);
        return `<tr><td class="c">${i + 1}</td><td>${h(l.code)}</td><td>${h(l.name)}</td><td>${h(it ? it.spec : "")}</td><td class="c">${l.qty}</td><td class="c">${h(l.unit)}</td><td class="r">${fmt(l.unit_price)}</td><td class="r">${fmt(l.amount)}</td></tr>`;
    }).join("");
    const body = `
    <div class="doc-head">
        <div class="company">${h(COMPANY.name)}</div>
        <div class="en">${h(COMPANY.en)}</div>
    </div>
    <div class="doc-title">出 货 单</div>
    <div class="meta">
        <span>出货单号：<b>${h(s.no)}</b></span>
        <span>出货日期：<b>${h(s.ship_date)}</b></span>
        <span>对应订单：<b>${h(s.order_no)}</b></span>
        <span>出货仓库：<b>${h(wh ? wh.name : "-")}</b></span>
        <span>物流方式：<b>${h(s.logistics_method || "-")}</b></span>
        <span>物流单号：<b>${h(s.shipment_no || "-")}</b></span>
    </div>
    <div class="meta">
        <span>收货单位：<b>${h(s.recipient_name || "-")}</b></span>
        <span>联系电话：<b>${h(s.recipient_phone || "-")}</b></span>
    </div>
    <div class="meta"><span>收货地址：<b>${h(s.shipping_address || "-")}</b></span></div>
    <table>
        <thead><tr><th style="width:36px">序号</th><th style="width:104px">品号</th><th>品名</th><th style="width:84px">规格</th><th style="width:56px">数量</th><th style="width:52px">单位</th><th style="width:88px">单价</th><th style="width:98px">金额</th></tr></thead>
        <tbody>${lines}</tbody>
    </table>
    <div class="totals">
        <div>合计数量：<b>${totalQty}</b>　合计金额：<b>¥${fmt(goods)}</b></div>
        <div class="up">金额大写（人民币）：${rmbUpper(goods)}</div>
    </div>
    <div class="remark">备注：${h(s.remark || "")}</div>
    <div class="sign">
        <div><div class="line"></div>制单人：${h(s.created_by || "")}</div>
        <div><div class="line"></div>收货单位（签收）：</div>
        <div><div class="line"></div>签收日期：</div>
    </div>
    <div class="foot-note">本单据由 ${h(COMPANY.name)} ERP 系统自动生成，请核对商品数量与金额无误后签收</div>`;
    printDoc("出货单 " + s.no, body);
};

/* ---- 出货扣库存 ---- */
Pages.shipOrder = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    const whOpts = warehouseOptions("");
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal">
        <div class="modal-head"><h3>出货扣库存 - ${h(o.no)}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">
            <div class="form-item" style="margin-bottom:14px"><label>出货仓库 <b>*</b></label><select id="shipWh">${whOpts}</select></div>
            <div class="form-item" style="margin-bottom:14px"><label>物流方式</label><select id="shipLog">${logisticsOptions(o.logistics_method || "圆通速递")}</select></div>
            <div class="form-item" style="margin-bottom:14px"><label>物流单号</label><input id="shipNo" placeholder="物流或平台出货编号"></div>
            <table class="table"><thead><tr><th>品号</th><th>品名</th><th class="num">数量</th><th>单位</th></tr></thead>
            <tbody>${o.lines.map(l => `<tr><td>${h(l.code)}</td><td>${h(l.name)}</td><td class="num">${l.qty}</td><td>${h(l.unit)}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="modal-foot">
            <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
            <button class="btn primary" onclick="Pages.doShip('${id}')">确认出货</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
};

Pages.doShip = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    if (o.status !== "draft") { toast("该订单已出货，请勿重复操作", "error"); return; }
    const whId = document.getElementById("shipWh").value;
    const log = document.getElementById("shipLog").value;
    const shipNo = document.getElementById("shipNo").value;
    if (!whId) { toast("请选择出货仓库", "error"); return; }

    // 扣库存前检查库存是否充足（含单位换算，仅预警，不阻断超卖场景）
    const shortLines = o.lines.filter(l => {
        const it = DB.get("items", l.item_id);
        const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
        const qty = Utils.num(l.qty) * rate;
        const stock = DB.stockOf(whId, l.item_id);
        return qty > 0 && stock < qty;
    });
    if (shortLines.length) {
        toast(`库存不足提醒：${shortLines.map(l => l.code).join("、")} 出货后会产生负库存`, "error");
    }

    // 扣库存（按销售→库存换算率换算为库存单位数量）
    o.lines.forEach(l => {
        const it = DB.get("items", l.item_id);
        const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
        DB.addStock(whId, l.item_id, -Utils.num(l.qty) * rate);
    });

    // 建立出货单
    const no = nextDocNo("SH", "shipments");
    DB.insert("shipments", {
        no, sales_order_id: o.id, order_no: o.no, warehouse_id: whId,
        ship_date: Utils.today(), logistics_method: log, shipment_no: shipNo,
        recipient_name: o.recipient_name, recipient_phone: o.recipient_phone,
        shipping_address: o.shipping_address,
        lines: o.lines.map(l => Object.assign({}, l)),
        remark: "", created_by: DB.currentUser().name
    });

    // 更新订单状态
    DB.update("sales_orders", o.id, { status: "shipped", logistics_method: log, shipment_no: shipNo });
    document.querySelector(".modal-mask")?.remove();
    toast(`订单 ${o.no} 已出货，库存已扣减`, "success");
    render();
};

/* ---- 销货订单表单 ---- */
Pages.salesOrderForm = function (id) {
    const o = id ? DB.get("sales_orders", id) : null;
    if (id && !o) { toast("找不到该订单", "error"); render(); return; }

    const goodsTotal = o ? o.lines.reduce((s, l) => s + Utils.num(l.amount), 0) : 0;
    const lineRows = o ? o.lines.map(l => lineRowHtml(l)).join("") : "";
    const isEdit = !!o;

    const content = `
    <div class="page-head">
        <div><h2>销货订单｜${isEdit ? "编辑" : "新增"}</h2>
        <p>订单负责成交、出货与应收依据；核账与传票留在财务流程，避免订单画面过度复杂。</p></div>
        <div class="actions">
            <a class="btn" href="#/sales-orders">返回订单</a>
            <a class="btn" href="#/accounting/accounts-receivable">应收账款</a>
        </div>
    </div>

    <form class="form-panel order-form-panel" id="salesOrderForm" novalidate onsubmit="Pages.saveSalesOrder(event, '${id || ""}')">
        <div class="doc-audit">
            <div><span>建立人员</span><strong>${isEdit ? h(o.created_by) : "保存后产生"}</strong></div>
            <div><span>建立时间</span><strong>${isEdit ? h(o.created_at) : "保存后产生"}</strong></div>
            <div><span>修改时间</span><strong>${isEdit ? h(o.updated_at) : "保存后产生"}</strong></div>
        </div>

        <div class="order-summary-bar">
            <div><span>订单单号</span><strong>${isEdit ? h(o.no) : "保存后依订单日期自动产生"}</strong></div>
            <div><span>出货状态</span><strong id="soStatusText">${isEdit ? (o.status === "shipped" ? "已出货" : o.status === "cancelled" ? "已取消" : "未出货") : "未出货"}</strong></div>
            <div><span>商品小计</span><strong id="salesGoodsTotal">${fmt(goodsTotal)}</strong></div>
            <div><span>未税销售额</span><strong id="taxableSummary">${fmt(o ? o.taxable_amount : 0)}</strong></div>
            <div><span>应收总额</span><strong id="salesSummaryTotal">${fmt(o ? o.invoice_amount : 0)}</strong></div>
            <div><span>预估实收</span><strong id="salesNetTotal">${o ? o.net_receipt : 0}</strong></div>
        </div>

        <div class="doc-flow-card editable">
            <div>
                <span class="doc-flow-label">目前流程</span>
                <strong>${isEdit && o.status === "shipped" ? "已出货，订单内容已锁定" : "未出货，可调整订单内容并执行出货扣库"}</strong>
                <p>${isEdit && o.status === "shipped" ? "该订单已完成出货，库存已扣减并形成应收，如需修改请使用退回/折让流程。" : "确认订单内容后，可在列表页点击「出货」选择仓库，系统会扣库存、锁定成本并建立出货单。"}</p>
            </div>
            <ul>
                <li>平台或散客订单可使用 WALKIN 客户，收件人会显示在出货单上。</li>
                <li>平台手续费、金流手续费与其他费用会影响预估实收与损益。</li>
                <li>收款与传票后续由应收账款与传票作业处理。</li>
            </ul>
        </div>

        <section class="form-section">
            <div class="form-section-title"><h3>订单信息</h3><p>选择销售来源、客户、日期、物流与收件资料。</p></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>销售来源<b>*</b></label>
                    <select name="sales_channel" onchange="Pages.handleChannelChange(this)">${channelOptions(o ? o.channel : "一般销货")}</select></div>
                <div class="form-item"><label>平台单号</label><input name="platform_order_no" value="${h(o ? o.platform_no : "")}" placeholder="淘宝、拼多多、抖音或其他平台订单编号"></div>
                <div class="form-item"><label>客户<b>*</b></label>
                    <select name="customer_id" id="customerSelect" required onchange="Pages.syncCustomerCurrency(this)"><option value="">请选择</option>${customerOptions(o ? o.customer_id : "")}</select></div>
                <div class="form-item"><label>付款状态</label>
                    <select name="payment_status"><option value="unpaid" ${o && o.payment_status === "unpaid" ? "selected" : ""}>未收款 / 赊账</option><option value="paid" ${o && o.payment_status === "paid" ? "selected" : ""}>已收款</option></select></div>
                <div class="form-item"><label>收款方式</label><select name="payment_method">${payMethodOptions(o ? o.payment_method : "")}</select></div>
                <div class="form-item"><label>销售币别</label><select name="currency">${currencyOptions(o ? o.currency : "CNY")}</select></div>
                <div class="form-item"><label>订单日期</label><input type="date" name="order_date" value="${o ? h(o.order_date) : Utils.today()}"></div>
                <div class="form-item"><label>预计出货日</label><input type="date" name="delivery_date" value="${o ? h(o.delivery_date || "") : ""}"></div>
                <div class="form-item"><label>单据状态</label><input value="${isEdit && o.status === "shipped" ? "已出货" : "未出货"}" readonly><input type="hidden" name="status" value="${o ? o.status : "draft"}"></div>
                <div class="form-item"><label>物流方式</label><select name="logistics_method"><option value="">请选择</option>${logisticsOptions(o ? o.logistics_method : "")}</select></div>
                <div class="form-item"><label>业务员 <b>*</b></label><select name="sales_owner" required>
                    <option value="">请选择</option>
                    ${DB.list("users").map(u => `<option ${o && o.sales_owner === u.name ? "selected" : ""}>${h(u.name)}</option>`).join("")}
                </select></div>
                <div class="form-item"><label>物流单号</label><input name="shipment_no" value="${h(o ? o.shipment_no : "")}" placeholder="物流或平台出货编号"></div>
                <div class="form-item"><label>收件人</label><input name="recipient_name" value="${h(o ? o.recipient_name : "")}"></div>
                <div class="form-item"><label>收件电话</label><input name="recipient_phone" value="${h(o ? o.recipient_phone : "")}"></div>
                <div class="form-item wide"><label>收件地址</label><input name="shipping_address" value="${h(o ? o.shipping_address : "")}"></div>
            </div>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>税务 / 费用 / 应收</h3><p>产品售价可设定含税或未税；平台与金流手续费会计入费用，预估实收四舍五入。</p></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>发票类型</label><select name="invoice_type">
                    <option ${o && o.invoice_type === "不开发票" ? "selected" : ""}>不开发票</option>
                    <option ${o && o.invoice_type === "二联式" ? "selected" : ""}>二联式</option>
                    <option ${o && o.invoice_type === "三联式" ? "selected" : ""}>三联式</option>
                    <option ${o && o.invoice_type === "电子发票" ? "selected" : ""}>电子发票</option>
                    <option ${o && o.invoice_type === "月结汇总开" ? "selected" : ""}>月结汇总开</option>
                </select></div>
                <div class="form-item"><label>售价税别</label><select name="price_tax_mode">
                    <option ${o && o.price_tax_mode === "含税" || !o ? "selected" : ""}>含税</option>
                    <option ${o && o.price_tax_mode === "未税" ? "selected" : ""}>未税</option>
                </select></div>
                <div class="form-item"><label>课税类型</label><select name="tax_type">
                    <option ${o && o.tax_type === "应税" ? "selected" : ""}>应税</option>
                    <option ${o && o.tax_type === "免税" ? "selected" : ""}>免税</option>
                    <option ${o && o.tax_type === "零税率" ? "selected" : ""}>零税率</option>
                    <option ${(!o || o.tax_type === "不计税") ? "selected" : ""}>不计税</option>
                </select></div>
                <div class="form-item"><label>税率 %</label><input type="number" step="0.01" name="tax_rate" value="${o ? o.tax_rate : 5}"></div>
                <div class="form-item"><label>运费</label><input type="number" step="0.01" name="shipping_fee" value="${o ? o.shipping_fee : 0}"></div>
                <div class="form-item"><label>平台抽成 %</label><input type="number" step="0.01" name="commission_rate" value="${o ? o.commission_rate : 0}" placeholder="例如 25"></div>
                <div class="form-item"><label>平台手续费</label><input type="number" step="0.01" name="platform_fee" value="${o ? o.platform_fee : 0}"></div>
                <div class="form-item"><label>金流手续费</label><input type="number" step="0.01" name="payment_fee" value="${o ? o.payment_fee : 0}"></div>
                <div class="form-item"><label>其他费用</label><input type="number" step="0.01" name="other_fee" value="${o ? o.other_fee : 0}"></div>
                <div class="form-item"><label>月结含税</label><label class="inline-check"><input type="checkbox" name="settlement_tax_included" value="1" ${o && o.settlement_tax_included ? "checked" : ""}> 手续费自应收基础扣除</label></div>
                <div class="form-item"><label>未税销售额</label><input name="taxable_amount" id="taxableAmount" value="${o ? o.taxable_amount : 0}" readonly></div>
                <div class="form-item"><label>税额</label><input type="number" step="0.01" name="tax_amount" id="taxAmount" value="${o ? o.tax_amount : 0}" readonly></div>
                <div class="form-item"><label>应收总额</label><input name="invoice_amount" id="invoiceAmount" value="${o ? o.invoice_amount : 0}" readonly></div>
                <div class="form-item"><label>预估实收</label><input id="netReceipt" value="${o ? o.net_receipt : 0}" readonly></div>
                <div class="form-item"><label>发票抬头</label><input name="invoice_title" value="${h(o ? o.invoice_title : "")}"></div>
                <div class="form-item"><label>统一编号</label><input name="invoice_tax_id" value="${h(o ? o.invoice_tax_id : "")}"></div>
                <div class="form-item"><label>发票号码</label><input name="invoice_no" value="${h(o ? o.invoice_no : "")}"></div>
                <div class="form-item"><label>发票日期</label><input type="date" name="invoice_date" value="${o ? h(o.invoice_date || "") : ""}"></div>
                <div class="form-item"><label>发票状态</label><select name="invoice_status">
                    <option ${(!o || o.invoice_status === "未开") ? "selected" : ""}>未开</option>
                    <option ${o && o.invoice_status === "已开" ? "selected" : ""}>已开</option>
                    <option ${o && o.invoice_status === "作废" ? "selected" : ""}>作废</option>
                    <option ${o && o.invoice_status === "折让" ? "selected" : ""}>折让</option>
                    <option ${o && o.invoice_status === "退回" ? "selected" : ""}>退回</option>
                </select></div>
            </div>
        </section>

        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>订单明细</h3><p class="muted">单身保留品号、品名、数量、单位、单价、金额与备注，方便对应平台 SKU 与后续出货。</p></div>
                ${!(isEdit && o.status === "shipped") ? `<button class="btn" type="button" onclick="Pages.addSalesLine()">+ 新增明细</button>` : ""}
            </div>
            <div class="table-wrap erp-table detail-scroll">
                <table class="table bom-lines detail-table" id="salesLines">
                    <thead><tr><th>品号</th><th>品名</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th><th>备注</th><th class="action-col">操作</th></tr></thead>
                    <tbody>${lineRows}</tbody>
                    <tfoot><tr><th colspan="5" style="text-align:right">商品小计</th><th id="salesTotal" class="num">${fmt(goodsTotal)}</th><th colspan="2"></th></tr></tfoot>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark">${h(o ? o.remark : "")}</textarea></div>

        <div class="form-actions sticky-actions">
            ${!(isEdit && o.status === "shipped") ? `<button class="btn primary" type="submit">保存销货订单</button>` : ""}
            <a class="btn" href="#/sales-orders">返回</a>
        </div>
    </form>`;

    renderShell("sales_orders", content, "首页 / 日常作业 / 销货订单");
    if (!isEdit) Pages.addSalesLine();
    Pages.bindSalesFormEvents();
};

function lineRowHtml(l) {
    return `<tr>
        <td><input class="item-code" value="${h(l.code)}" readonly style="width:90px"></td>
        <td><select name="item_id[]" required onchange="Pages.syncItemDefaults(this)"><option value="">请选择</option>${itemOptions(l.item_id)}</select></td>
        <td><input type="number" step="0.0001" name="qty[]" value="${l.qty}" required style="width:90px"></td>
        <td><input name="unit[]" value="${h(l.unit)}" style="width:70px"></td>
        <td><input type="number" step="0.0001" name="unit_price[]" value="${l.unit_price}" style="width:110px"></td>
        <td class="line-amount num">${fmt(l.amount)}</td>
        <td><input name="line_remark[]" value="${h(l.remark || "")}"></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="Pages.removeSalesLine(this)">移除</button></td>
    </tr>`;
}

Pages.addSalesLine = function (itemId) {
    const tbody = document.querySelector("#salesLines tbody");
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input class="item-code" value="" readonly style="width:90px"></td>
        <td><select name="item_id[]" required onchange="Pages.syncItemDefaults(this)"><option value="">请选择</option>${itemOptions(itemId)}</select></td>
        <td><input type="number" step="0.0001" name="qty[]" value="" required style="width:90px"></td>
        <td><input name="unit[]" value="" style="width:70px"></td>
        <td><input type="number" step="0.0001" name="unit_price[]" value="" style="width:110px"></td>
        <td class="line-amount num">0.00</td>
        <td><input name="line_remark[]" value=""></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="Pages.removeSalesLine(this)">移除</button></td>`;
    tbody.appendChild(tr);
    Pages.bindSalesLineEvents(tr);
    Pages.updateSalesTotal();
};

Pages.removeSalesLine = function (btn) {
    const row = btn.closest("tr");
    if (row) row.remove();
    Pages.updateSalesTotal();
};

Pages.syncItemDefaults = function (select) {
    const opt = select.options[select.selectedIndex];
    const row = select.closest("tr");
    if (!opt) return;
    row.querySelector(".item-code").value = opt.dataset.code || "";
    row.querySelector('[name="unit_price[]"]').value = (opt.dataset.price && opt.dataset.price !== "0") ? opt.dataset.price : "";
    row.querySelector('[name="unit[]"]').value = opt.dataset.unit || "";
    Pages.calcSalesLine(select);
};

Pages.calcSalesLine = function (el) {
    const row = el.closest("tr");
    if (!row) return;
    const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
    const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
    row.querySelector(".line-amount").textContent = Utils.round(qty * price).toFixed(2);
    Pages.updateSalesTotal();
};

Pages.bindSalesLineEvents = function (row) {
    row.querySelectorAll('[name="qty[]"],[name="unit_price[]"]').forEach(inp => {
        inp.addEventListener("input", () => Pages.calcSalesLine(inp));
    });
};

Pages.updateSalesTotal = function () {
    let goodsTotal = 0;
    document.querySelectorAll("#salesLines tbody tr").forEach(row => {
        goodsTotal += Utils.num(row.querySelector(".line-amount").textContent);
    });
    const fees = Pages.feesTotal();
    const taxType = Pages.fieldVal("tax_type") || "不计税";
    const priceMode = Pages.fieldVal("price_tax_mode") || "含税";
    const rate = Utils.num(Pages.fieldVal("tax_rate"));
    const sti = !!document.querySelector('[name="settlement_tax_included"]')?.checked;
    const t = calcOrderTotals(goodsTotal, fees, taxType, priceMode, rate, sti);

    const totalEl = document.getElementById("salesTotal");
    const goodsEl = document.getElementById("salesGoodsTotal");
    const taxableEl = document.getElementById("taxableAmount");
    const taxEl = document.getElementById("taxAmount");
    const invoiceEl = document.getElementById("invoiceAmount");
    const netEl = document.getElementById("netReceipt");
    const taxableS = document.getElementById("taxableSummary");
    const summaryS = document.getElementById("salesSummaryTotal");
    const netS = document.getElementById("salesNetTotal");
    if (totalEl) totalEl.textContent = fmt(goodsTotal);
    if (goodsEl) goodsEl.textContent = fmt(goodsTotal);
    if (taxableEl) taxableEl.value = t.taxable.toFixed(2);
    if (taxEl) taxEl.value = t.tax.toFixed(2);
    if (invoiceEl) invoiceEl.value = t.invoice.toFixed(2);
    if (netEl) netEl.value = t.net.toFixed(0);
    if (taxableS) taxableS.textContent = t.taxable.toFixed(2);
    if (summaryS) summaryS.textContent = t.invoice.toFixed(2);
    if (netS) netS.textContent = t.net.toFixed(0);
};

Pages.fieldVal = function (name) {
    const el = document.querySelector('[name="' + name + '"]');
    return el ? el.value : "";
};

Pages.feesTotal = function () {
    return ["shipping_fee", "platform_fee", "payment_fee", "other_fee"].reduce((s, n) => s + Utils.num(Pages.fieldVal(n)), 0);
};

Pages.handleChannelChange = function (sel) {
    const ch = sel.value;
    const customer = document.getElementById("customerSelect");
    if (customer && ["散客", "淘宝", "拼多多", "抖音", "其他平台"].includes(ch)) {
        Array.from(customer.options).forEach(opt => {
            if (opt.dataset.code === "WALKIN") {
                customer.value = opt.value;
                Pages.syncCustomerCurrency(customer);
            }
        });
    }
};

Pages.syncCustomerCurrency = function (select) {
    const opt = select.options[select.selectedIndex];
    const target = document.querySelector('[name="currency"]');
    if (opt && opt.dataset.currency && target) target.value = opt.dataset.currency;
};

Pages.bindSalesFormEvents = function () {
    ["shipping_fee", "platform_fee", "payment_fee", "other_fee", "commission_rate", "tax_rate"].forEach(n => {
        const el = document.querySelector('[name="' + n + '"]');
        if (el) el.addEventListener("input", Pages.updateSalesTotal);
    });
    ["invoice_type", "price_tax_mode", "tax_type", "settlement_tax_included"].forEach(n => {
        const el = document.querySelector('[name="' + n + '"]');
        if (el) el.addEventListener("change", Pages.updateSalesTotal);
    });
    document.querySelectorAll("#salesLines tbody tr").forEach(row => Pages.bindSalesLineEvents(row));
    Pages.updateSalesTotal();
};

Pages.saveSalesOrder = function (e, id) {
    e.preventDefault();
    if (window.__saveLock) { toast("正在保存，请稍候…", "error"); return; }
    window.__saveLock = true;
    try {
    // 状态守卫：已出货订单锁定，任何途径（含回车提交）都不可再改
    if (id) {
        const old = DB.get("sales_orders", id);
        if (old && old.status !== "draft") { toast("该订单已出货，内容已锁定，无法修改", "error"); return; }
    }
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });

    const lines = [];
    document.querySelectorAll("#salesLines tbody tr").forEach(row => {
        const sel = row.querySelector('[name="item_id[]"]');
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
        if (!sel || !sel.value || qty <= 0) return;
        const it = DB.get("items", sel.value);
        lines.push({
            item_id: sel.value, code: it ? it.code : "", name: it ? it.name : "",
            qty, unit: row.querySelector('[name="unit[]"]').value || (it ? it.sales_unit : ""),
            unit_price: price, amount: Utils.round(qty * price),
            remark: row.querySelector('[name="line_remark[]"]').value || ""
        });
    });
    if (!lines.length) { toast("请至少新增一笔有效的订单明细", "error"); return; }
    if (!data.customer_id) { toast("请选择客户", "error"); return; }
    if (!data.sales_owner) { toast("请选择业务员", "error"); return; }

    const goodsTotal = lines.reduce((s, l) => s + l.amount, 0);
    const fees = Utils.num(data.shipping_fee) + Utils.num(data.platform_fee) + Utils.num(data.payment_fee) + Utils.num(data.other_fee);
    const t = calcOrderTotals(goodsTotal, fees, data.tax_type, data.price_tax_mode, data.tax_rate, !!data.settlement_tax_included);
    const cu = DB.get("customers", data.customer_id);

    const payload = {
        no: id ? DB.get("sales_orders", id).no : nextDocNo("SO", "sales_orders", data.order_date),
        channel: data.sales_channel, platform_no: data.platform_order_no,
        customer_id: data.customer_id, payment_status: data.payment_status, payment_method: data.payment_method,
        currency: data.currency, order_date: data.order_date, delivery_date: data.delivery_date || "",
        status: data.status || "draft", logistics_method: data.logistics_method, sales_owner: data.sales_owner,
        shipment_no: data.shipment_no, recipient_name: data.recipient_name, recipient_phone: data.recipient_phone,
        shipping_address: data.shipping_address,
        invoice_type: data.invoice_type, price_tax_mode: data.price_tax_mode, tax_type: data.tax_type,
        tax_rate: Utils.num(data.tax_rate), shipping_fee: Utils.num(data.shipping_fee),
        commission_rate: Utils.num(data.commission_rate), platform_fee: Utils.num(data.platform_fee),
        payment_fee: Utils.num(data.payment_fee), other_fee: Utils.num(data.other_fee),
        settlement_tax_included: !!data.settlement_tax_included,
        taxable_amount: t.taxable, tax_amount: t.tax, invoice_amount: t.invoice, net_receipt: t.net,
        invoice_title: data.invoice_title, invoice_tax_id: data.invoice_tax_id, invoice_no: data.invoice_no,
        invoice_date: data.invoice_date || "", invoice_status: data.invoice_status || "未开",
        lines, remark: data.remark || "", created_by: DB.currentUser().name
    };

    if (id) {
        DB.update("sales_orders", id, payload);
        toast("销货订单已更新", "success");
    } else {
        DB.insert("sales_orders", payload);
        toast("销货订单已保存", "success");
    }
    setTimeout(() => { location.hash = "#/sales-orders"; }, 300);
    } finally { setTimeout(() => { window.__saveLock = false; }, 400); }
};

/* ============================================================
   出货单
   ============================================================ */
Pages.shipments = function () {
    const list = DB.list("shipments").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(s => {
        const wh = DB.get("warehouses", s.warehouse_id);
        const goods = s.lines.reduce((a, l) => a + Utils.num(l.amount), 0);
        const o = DB.get("sales_orders", s.sales_order_id);
        return `<tr>
            <td><a href="#/shipments/${s.id}"><b>${h(s.no)}</b></a></td>
            <td><a href="#/sales-orders/${s.sales_order_id}">${h(s.order_no)}</a></td>
            <td>${h(s.ship_date)}</td>
            <td>${h(wh ? wh.name : "")}</td>
            <td>${h(s.recipient_name || "-")}</td>
            <td>${h(s.logistics_method || "-")}${s.shipment_no ? `<br><span style="color:var(--muted);font-size:12px">${h(s.shipment_no)}</span>` : ""}</td>
            <td class="num">${s.lines.length}</td>
            <td class="num">${fmt(goods)}</td>
            <td>${o ? soStatusBadge(o.status) : badge("已出货")}</td>
            <td>${h(s.created_by)}</td>
            <td class="action-col">
                <a class="link-btn" href="#/shipments/${s.id}">查看</a>
                <button class="link-btn" onclick="Pages.printShipment('${s.id}')">打印</button>
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>出货单</h1><p>销货订单出货后系统自动建立出货单并扣减库存。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/sales-orders">前往销货订单</a></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>出货单号</th><th>订单单号</th><th>出货日期</th><th>出货仓库</th><th>收件人</th><th>物流</th><th class="num">品项数</th><th class="num">出货金额</th><th>状态</th><th>建立人</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="11"><div class="empty-state"><div class="big">📭</div>暂无出货记录</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔出货单</p>`;
    renderShell("shipments", content, "首页 / 日常作业 / 出货单");
};

/* ---- 出货单详情 ---- */
Pages.shipmentDetail = function (id) {
    const s = DB.get("shipments", id);
    if (!s) { toast("找不到该出货单", "error"); render(); return; }
    const wh = DB.get("warehouses", s.warehouse_id);
    const o = DB.get("sales_orders", s.sales_order_id);
    const goods = s.lines.reduce((a, l) => a + Utils.num(l.amount), 0);

    const content = `
    <div class="page-head">
        <div><h1>出货单｜${h(s.no)}</h1>
        <p>出货日期 ${h(s.ship_date)} ｜ ${h(wh ? wh.name : "")} ｜ ${h(s.logistics_method || "-")}${s.shipment_no ? ` ｜ 物流单号 ${h(s.shipment_no)}` : ""}</p></div>
        <div class="head-actions">
            <button class="btn" onclick="Pages.printShipment('${s.id}')">🖨 打印</button>
            <a class="btn ghost" href="#/sales-orders/${s.sales_order_id}">查看来源订单 ${h(s.order_no)}</a>
            <a class="btn" href="#/shipments">返回出货单</a>
        </div>
    </div>
    <div class="doc-audit">
        <div><span>收件人</span><strong>${h(s.recipient_name || "-")}</strong></div>
        <div><span>联系电话</span><strong>${h(s.recipient_phone || "-")}</strong></div>
        <div><span>收件地址</span><strong>${h(s.shipping_address || "-")}</strong></div>
        <div><span>建立人员</span><strong>${h(s.created_by)}</strong></div>
        <div><span>来源订单状态</span><strong>${o ? soStatusBadge(o.status) : badge("已出货")}</strong></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>品号</th><th>品名</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th></tr></thead>
            <tbody>${s.lines.map(l => `<tr>
                <td>${h(l.code)}</td><td>${h(l.name)}</td>
                <td class="num">${l.qty}</td><td>${h(l.unit)}</td>
                <td class="num">${fmt(l.unit_price)}</td><td class="num">${fmt(l.amount)}</td>
            </tr>`).join("")}</tbody>
        </table>
    </div>
    <div class="order-summary-bar" style="margin-top:16px">
        <div><span>品项数</span><strong>${s.lines.length}</strong></div>
        <div><span>出货金额</span><strong>${fmt(goods)}</strong></div>
        <div><span>库存异动</span><strong style="color:var(--danger)">-${s.lines.reduce((a, l) => a + Utils.num(l.qty), 0)}</strong></div>
    </div>`;
    renderShell("shipments", content, "首页 / 日常作业 / 出货单 / " + s.no);
};

/* ============================================================
   采购单
   ============================================================ */
Pages.purchaseOrders = function () {
    const list = DB.list("purchase_orders").sort((a, b) => b.no.localeCompare(a.no));
    // 采购退回/折让冲减未付金额映射（与应付账款页口径一致）
    const prMap = {};
    DB.list("purchase_returns").filter(r => r.offset_payable).forEach(r => {
        prMap[r.purchase_order_id] = (prMap[r.purchase_order_id] || 0) + Utils.num(r.amount);
    });
    const rows = list.map(o => {
        const sp = DB.get("suppliers", o.supplier_id);
        const wh = DB.get("warehouses", o.warehouse_id);
        const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - (prMap[o.id] || 0), 0);
        return `<tr>
            <td><a href="#/purchase-orders/${o.id}/edit"><b>${h(o.no)}</b></a></td>
            <td>${h(o.po_date)}</td>
            <td>${h(sp ? sp.name : "")}</td>
            <td>${h(wh ? wh.name : "")}</td>
            <td>${h(o.currency)}</td>
            <td class="num">${fmt(o.amount)}</td>
            <td class="num">${fmt(unpaid)}</td>
            <td>${poStatusBadge(o.status)}</td>
            <td class="num">${o.status === "received" ? `<a class="link-btn" href="#/purchase-returns/create">退回/折让</a>` : "-"}</td>
            <td class="action-col">
                <a class="link-btn" href="#/purchase-orders/${o.id}/edit">编辑</a>
                ${o.status === "draft" && can("purchase.receive") ? `<button class="link-btn" onclick="Pages.receivePO('${o.id}')">进货入库</button>` : ""}
                <button class="link-btn danger" onclick="Pages.deletePO('${o.id}')">删除</button>
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>采购单</h1><p>向供应商下单，进货后增加库存并形成应付账款。</p></div>
        <div class="head-actions">
            ${can("purchase.create") ? `<a class="btn primary" href="#/purchase-orders/create">+ 新增采购单</a>` : ""}
            <a class="btn ghost" href="#/accounting/accounts-payable">应付账款</a>
        </div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>采购单号</th><th>日期</th><th>供应商</th><th>入库仓库</th><th>币别</th><th class="num">采购金额</th><th class="num">未付金额</th><th>状态</th><th>退回/折让</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="10"><div class="empty-state"><div class="big">📭</div>暂无采购单</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔采购单</p>`;
    renderShell("purchase_orders", content, "首页 / 日常作业 / 采购单");
};

Pages.deletePO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    if (o.status !== "draft") { toast("已进货的采购单不能删除，请先处理关联的进货记录", "error"); return; }
    confirmModal(`确定要删除采购单 ${o.no} 吗？此操作不可恢复。`, () => {
        DB.remove("purchase_orders", id);
        toast("采购单已删除", "success");
        render();
    });
};

/* ---- 进货入库 ---- */
Pages.receivePO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    if (o.status !== "draft") { toast("该采购单已进货，请勿重复操作", "error"); return; }
    confirmModal(`确定要执行进货入库吗？采购单 ${o.no} 的商品将增加库存并形成应付账款。`, () => {
        // 加库存（按采购→库存换算率换算为库存单位数量）
        o.lines.forEach(l => {
            const it = DB.get("items", l.item_id);
            const rate = it && Utils.num(it.purchase_to_stock) > 0 ? Utils.num(it.purchase_to_stock) : 1;
            DB.addStock(o.warehouse_id, l.item_id, Utils.num(l.qty) * rate);
        });
        DB.update("purchase_orders", o.id, { status: "received" });
        toast(`采购单 ${o.no} 已进货入库`, "success");
        render();
    }, "进货入库");
};

/* ---- 采购单表单 ---- */
Pages.purchaseOrderForm = function (id) {
    const o = id ? DB.get("purchase_orders", id) : null;
    if (id && !o) { toast("找不到该采购单", "error"); render(); return; }
    const isEdit = !!o;
    const goodsTotal = o ? o.lines.reduce((s, l) => s + Utils.num(l.amount), 0) : 0;
    const lineRows = o ? o.lines.map(l => poLineRowHtml(l)).join("") : "";

    const content = `
    <div class="page-head">
        <div><h2>采购单｜${isEdit ? "编辑" : "新增"}</h2><p>向供应商下单采购商品，进货后库存增加、应付账款形成。</p></div>
        <div class="actions"><a class="btn" href="#/purchase-orders">返回采购单</a></div>
    </div>
    <form class="form-panel" id="poForm" novalidate onsubmit="Pages.savePO(event, '${id || ""}')">
        <div class="doc-audit">
            <div><span>建立人员</span><strong>${isEdit ? h(o.created_by) : "保存后产生"}</strong></div>
            <div><span>建立时间</span><strong>${isEdit ? h(o.created_at) : "保存后产生"}</strong></div>
        </div>
        <div class="order-summary-bar">
            <div><span>采购单号</span><strong>${isEdit ? h(o.no) : "保存后依日期自动产生"}</strong></div>
            <div><span>进货状态</span><strong>${isEdit ? (o.status === "received" ? "已进货" : "未进货") : "未进货"}</strong></div>
            <div><span>采购金额</span><strong id="poTotal">${fmt(goodsTotal)}</strong></div>
        </div>
        <section class="form-section">
            <div class="form-section-title"><h3>采购信息</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>供应商<b>*</b></label>
                    <select name="supplier_id" required onchange="Pages.syncSupplierCurrency(this)"><option value="">请选择</option>${supplierOptions(o ? o.supplier_id : "")}</select></div>
                <div class="form-item"><label>采购日期</label><input type="date" name="po_date" value="${o ? h(o.po_date) : Utils.today()}"></div>
                <div class="form-item"><label>预计到货日</label><input type="date" name="delivery_date" value="${o ? h(o.delivery_date || "") : ""}"></div>
                <div class="form-item"><label>币别</label><select name="currency">${currencyOptions(o ? o.currency : "CNY")}</select></div>
                <div class="form-item"><label>付款方式</label><select name="payment_method">${payMethodOptions(o ? o.payment_method : "现款现货")}</select></div>
                <div class="form-item"><label>入库仓库<b>*</b></label><select name="warehouse_id" required>${warehouseOptions(o ? o.warehouse_id : "wh1")}</select></div>
                <div class="form-item"><label>单据状态</label><input value="${isEdit && o.status === "received" ? "已进货" : "未进货"}" readonly><input type="hidden" name="status" value="${o ? o.status : "draft"}"></div>
            </div>
        </section>
        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>采购明细</h3></div>
                ${!(isEdit && o.status === "received") ? `<button class="btn" type="button" onclick="Pages.addPOLine()">+ 新增明细</button>` : ""}
            </div>
            <div class="table-wrap detail-scroll">
                <table class="table bom-lines" id="poLines">
                    <thead><tr><th>品号</th><th>品名</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th><th>备注</th><th class="action-col">操作</th></tr></thead>
                    <tbody>${lineRows}</tbody>
                    <tfoot><tr><th colspan="5" style="text-align:right">合计</th><th id="poTotalFoot" class="num">${fmt(goodsTotal)}</th><th colspan="2"></th></tr></tfoot>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark">${h(o ? o.remark : "")}</textarea></div>
        <div class="form-actions sticky-actions">
            ${!(isEdit && o.status === "received") ? `<button class="btn primary" type="submit">保存采购单</button>` : ""}
            <a class="btn" href="#/purchase-orders">返回</a>
        </div>
    </form>`;

    renderShell("purchase_orders", content, "首页 / 日常作业 / 采购单");
    if (!isEdit) Pages.addPOLine();
    Pages.bindPOEvents();
};

function poLineRowHtml(l) {
    return `<tr>
        <td><input class="item-code" value="${h(l.code)}" readonly style="width:90px"></td>
        <td><select name="item_id[]" required onchange="Pages.syncPOItem(this)"><option value="">请选择</option>${itemOptions(l.item_id)}</select></td>
        <td><input type="number" step="0.0001" name="qty[]" value="${l.qty}" required style="width:90px"></td>
        <td><input name="unit[]" value="${h(l.unit)}" style="width:70px"></td>
        <td><input type="number" step="0.0001" name="unit_price[]" value="${l.unit_price}" style="width:110px"></td>
        <td class="line-amount num">${fmt(l.amount)}</td>
        <td><input name="line_remark[]" value="${h(l.remark || "")}"></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="Pages.removePOLine(this)">移除</button></td>
    </tr>`;
}

Pages.addPOLine = function (itemId) {
    const tbody = document.querySelector("#poLines tbody");
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input class="item-code" value="" readonly style="width:90px"></td>
        <td><select name="item_id[]" required onchange="Pages.syncPOItem(this)"><option value="">请选择</option>${itemOptions(itemId)}</select></td>
        <td><input type="number" step="0.0001" name="qty[]" value="" required style="width:90px"></td>
        <td><input name="unit[]" value="" style="width:70px"></td>
        <td><input type="number" step="0.0001" name="unit_price[]" value="" style="width:110px"></td>
        <td class="line-amount num">0.00</td>
        <td><input name="line_remark[]" value=""></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="Pages.removePOLine(this)">移除</button></td>`;
    tbody.appendChild(tr);
    Pages.bindPOLineEvents(tr);
    Pages.updatePOTotal();
};

Pages.removePOLine = function (btn) {
    const row = btn.closest("tr");
    if (row) row.remove();
    Pages.updatePOTotal();
};

Pages.syncPOItem = function (select) {
    const opt = select.options[select.selectedIndex];
    const row = select.closest("tr");
    if (!opt) return;
    row.querySelector(".item-code").value = opt.dataset.code || "";
    row.querySelector('[name="unit_price[]"]').value = "";
    row.querySelector('[name="unit[]"]').value = opt.dataset.unit || "";
    Pages.calcPOLine(select);
};

Pages.calcPOLine = function (el) {
    const row = el.closest("tr");
    if (!row) return;
    const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
    const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
    row.querySelector(".line-amount").textContent = Utils.round(qty * price).toFixed(2);
    Pages.updatePOTotal();
};

Pages.bindPOLineEvents = function (row) {
    row.querySelectorAll('[name="qty[]"],[name="unit_price[]"]').forEach(inp => inp.addEventListener("input", () => Pages.calcPOLine(inp)));
};

Pages.updatePOTotal = function () {
    let total = 0;
    document.querySelectorAll("#poLines tbody tr").forEach(row => {
        total += Utils.num(row.querySelector(".line-amount").textContent);
    });
    const els = [document.getElementById("poTotal"), document.getElementById("poTotalFoot")];
    els.forEach(el => { if (el) el.textContent = fmt(total); });
};

Pages.bindPOEvents = function () {
    document.querySelectorAll("#poLines tbody tr").forEach(row => Pages.bindPOLineEvents(row));
    Pages.updatePOTotal();
};

Pages.syncSupplierCurrency = function (select) {
    const opt = select.options[select.selectedIndex];
    const target = document.querySelector('[name="currency"]');
    if (opt && opt.dataset.currency && target) target.value = opt.dataset.currency;
};

Pages.savePO = function (e, id) {
    e.preventDefault();
    if (window.__saveLock) { toast("正在保存，请稍候…", "error"); return; }
    window.__saveLock = true;
    try {
    // 状态守卫：已进货采购单锁定，任何途径（含回车提交）都不可再改
    if (id) {
        const old = DB.get("purchase_orders", id);
        if (old && old.status !== "draft") { toast("该采购单已进货，内容已锁定，无法修改", "error"); return; }
    }
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });

    const lines = [];
    document.querySelectorAll("#poLines tbody tr").forEach(row => {
        const sel = row.querySelector('[name="item_id[]"]');
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
        if (!sel || !sel.value || qty <= 0) return;
        const it = DB.get("items", sel.value);
        lines.push({
            item_id: sel.value, code: it ? it.code : "", name: it ? it.name : "",
            qty, unit: row.querySelector('[name="unit[]"]').value || (it ? it.purchase_unit : ""),
            unit_price: price, amount: Utils.round(qty * price),
            remark: row.querySelector('[name="line_remark[]"]').value || ""
        });
    });
    if (!lines.length) { toast("请至少新增一笔有效的采购明细", "error"); return; }
    if (!data.supplier_id) { toast("请选择供应商", "error"); return; }
    if (!data.warehouse_id) { toast("请选择入库仓库", "error"); return; }
    const amount = lines.reduce((s, l) => s + l.amount, 0);

    const payload = {
        no: id ? DB.get("purchase_orders", id).no : nextDocNo("PO", "purchase_orders", data.po_date),
        supplier_id: data.supplier_id, po_date: data.po_date, delivery_date: data.delivery_date || "",
        currency: data.currency, payment_method: data.payment_method, status: data.status || "draft",
        warehouse_id: data.warehouse_id, amount, paid_amount: id ? DB.get("purchase_orders", id).paid_amount : 0,
        lines, remark: data.remark || "", created_by: DB.currentUser().name
    };

    if (id) {
        DB.update("purchase_orders", id, payload);
        toast("采购单已更新", "success");
    } else {
        DB.insert("purchase_orders", payload);
        toast("采购单已保存", "success");
    }
    setTimeout(() => { location.hash = "#/purchase-orders"; }, 300);
    } finally { setTimeout(() => { window.__saveLock = false; }, 400); }
};

/* ============================================================
   库存调整
   ============================================================ */
Pages.inventoryAdjust = function () {
    const list = DB.list("inventory_adjusts").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(a => {
        const wh = DB.get("warehouses", a.warehouse_id);
        return `<tr>
            <td><b>${h(a.no)}</b></td>
            <td>${h(a.type)}</td>
            <td>${h(a.source_type || "-")}</td>
            <td>${h(a.source_no || "-")}</td>
            <td>${h(wh ? wh.name : "")}</td>
            <td>${a.lines.map(l => `${h(l.code)} ${h(l.name)}`).join("<br>")}</td>
            <td class="num">${a.lines.map(l => `<span style="${l.qty < 0 ? "color:var(--danger)" : "color:var(--green)"}">${l.qty > 0 ? "+" : ""}${l.qty}</span>`).join("<br>")}</td>
            <td class="num">${a.lines.map(l => `${l.before} → ${l.after}`).join("<br>")}</td>
            <td>${h(a.created_by)}</td>
            <td>${h(a.created_at.slice(0, 10))}</td>
            <td>${h(a.remark || "-")}</td>
            <td class="action-col"><button class="link-btn danger" onclick="Pages.deleteAdj('${a.id}')">删除</button></td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>库存调整</h1><p>处理盘点差异、拆包/组包等库存异动；异动会即时更新仓库库存。</p></div>
        <div class="head-actions">${can("inventory.adjust") ? `<a class="btn primary" href="#/inventory/inventory_adjust/create">+ 新增库存调整</a>` : ""}</div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>单号</th><th>类型</th><th>来源类型</th><th>来源单号</th><th>仓库</th><th>品号 / 品名</th><th class="num">数量</th><th class="num">异动前 → 后</th><th>建立人</th><th>异动时间</th><th>备注</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="12"><div class="empty-state"><div class="big">📭</div>暂无库存调整记录</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔库存调整</p>`;
    renderShell("inventory_adjust", content, "首页 / 日常作业 / 库存调整");
};

Pages.deleteAdj = function (id) {
    const a = DB.get("inventory_adjusts", id);
    if (!a) return;
    confirmModal("确定要删除这笔库存调整记录吗？删除后库存将按原数量反向冲销。", () => {
        a.lines.forEach(l => { DB.addStock(a.warehouse_id, l.item_id, -Utils.num(l.qty)); });
        DB.remove("inventory_adjusts", id);
        toast("已删除，库存已回冲", "success");
        render();
    });
};

Pages.inventoryAdjustForm = function () {
    const content = `
    <div class="page-head">
        <div><h2>库存调整｜新增</h2><p>调整类型：调整（盘点差异）、拆包（大包装拆小包）、组包（小包组合成大包装）。</p></div>
        <div class="actions"><a class="btn" href="#/inventory/inventory_adjust">返回库存调整</a></div>
    </div>
    <form class="form-panel" id="adjForm" novalidate onsubmit="Pages.saveAdj(event)">
        <section class="form-section">
            <div class="form-grid section-grid">
                <div class="form-item"><label>调整类型<b>*</b></label>
                    <select name="type" required><option>调整</option><option>拆包</option><option>组包</option></select></div>
                <div class="form-item"><label>来源类型</label>
                    <select name="source_type"><option value="">-</option><option>盘点</option><option>拆包作业</option><option>组包作业</option><option>其他</option></select></div>
                <div class="form-item"><label>来源单号</label><input name="source_no" placeholder="关联单号，如盘点单号"></div>
                <div class="form-item"><label>仓库<b>*</b></label><select name="warehouse_id" required>${warehouseOptions("wh1")}</select></div>
            </div>
        </section>
        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>调整明细</h3><p class="muted">数量正数为入库（增加），负数为出库（减少）。</p></div>
                <button class="btn" type="button" onclick="Pages.addAdjLine()">+ 新增明细</button>
            </div>
            <div class="table-wrap detail-scroll">
                <table class="table bom-lines" id="adjLines">
                    <thead><tr><th>品号</th><th>品名</th><th class="num">数量(+/-)</th><th>单位</th><th class="num">异动前</th><th class="num">异动后</th><th>明细备注</th><th class="action-col">操作</th></tr></thead>
                    <tbody></tbody>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark" placeholder="调整原因说明"></textarea></div>
        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存库存调整</button>
            <a class="btn" href="#/inventory/inventory_adjust">返回</a>
        </div>
    </form>`;

    renderShell("inventory_adjust", content, "首页 / 日常作业 / 库存调整");
    Pages.addAdjLine();
    Pages.bindAdjEvents();
};

Pages.addAdjLine = function (itemId) {
    const tbody = document.querySelector("#adjLines tbody");
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input class="item-code" value="" readonly style="width:90px"></td>
        <td><select name="item_id[]" required onchange="Pages.syncAdjItem(this)"><option value="">请选择</option>${itemOptions(itemId)}</select></td>
        <td><input type="number" step="0.0001" name="qty[]" value="" placeholder="+/-" required style="width:100px"></td>
        <td><input name="unit[]" value="" style="width:70px"></td>
        <td class="before-qty num">-</td>
        <td class="after-qty num">-</td>
        <td><input name="line_remark[]" value=""></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="Pages.removeAdjLine(this)">移除</button></td>`;
    tbody.appendChild(tr);
    Pages.bindAdjLineEvents(tr);
};

Pages.removeAdjLine = function (btn) {
    btn.closest("tr").remove();
};

Pages.syncAdjItem = function (select) {
    const opt = select.options[select.selectedIndex];
    const row = select.closest("tr");
    if (!opt) return;
    row.querySelector(".item-code").value = opt.dataset.code || "";
    row.querySelector('[name="unit[]"]').value = opt.dataset.unit || "";
    Pages.updateAdjPreview(row);
};

Pages.updateAdjPreview = function (row) {
    const sel = row.querySelector('[name="item_id[]"]');
    const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
    if (!sel || !sel.value) return;
    const whId = document.querySelector('[name="warehouse_id"]').value;
    const before = DB.stockOf(whId, sel.value);
    row.querySelector(".before-qty").textContent = before;
    row.querySelector(".after-qty").textContent = Utils.round(before + qty, 4);
};

Pages.bindAdjLineEvents = function (row) {
    row.querySelector('[name="qty[]"]').addEventListener("input", () => Pages.updateAdjPreview(row));
    row.querySelector('[name="warehouse_id"]') && null;
};
Pages.bindAdjEvents = function () {
    document.querySelectorAll("#adjLines tbody tr").forEach(r => Pages.bindAdjLineEvents(r));
    const whSel = document.querySelector('[name="warehouse_id"]');
    if (whSel) whSel.addEventListener("change", () => document.querySelectorAll("#adjLines tbody tr").forEach(r => Pages.updateAdjPreview(r)));
};

Pages.saveAdj = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });

    const lines = [];
    let ok = true;
    document.querySelectorAll("#adjLines tbody tr").forEach(row => {
        const sel = row.querySelector('[name="item_id[]"]');
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        if (!sel || !sel.value) return;
        if (qty === 0) { ok = false; return; }
        const it = DB.get("items", sel.value);
        const before = DB.stockOf(data.warehouse_id, sel.value);
        lines.push({
            item_id: sel.value, code: it.code, name: it.name, qty,
            unit: row.querySelector('[name="unit[]"]').value || it.stock_unit,
            before, after: Utils.round(before + qty, 4),
            remark: row.querySelector('[name="line_remark[]"]').value || ""
        });
    });
    if (!ok) { toast("调整数量不可为 0", "error"); return; }
    if (!lines.length) { toast("请至少新增一笔有效的调整明细", "error"); return; }

    lines.forEach(l => { DB.addStock(data.warehouse_id, l.item_id, l.qty); });
    DB.insert("inventory_adjusts", {
        no: nextDocNo("ADJ", "inventory_adjusts"), warehouse_id: data.warehouse_id,
        type: data.type, source_type: data.source_type || "", source_no: data.source_no || "",
        lines, remark: data.remark || "", created_by: DB.currentUser().name
    });
    toast("库存调整已保存并更新库存", "success");
    setTimeout(() => { location.hash = "#/inventory/inventory_adjust"; }, 300);
};

/* ============================================================
   销货退回/折让
   ============================================================ */
Pages.salesReturns = function () {
    const list = DB.list("sales_returns").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(r => {
        const cu = DB.get("customers", r.customer_id);
        const wh = DB.get("warehouses", r.warehouse_id);
        return `<tr>
            <td><b>${h(r.no)}</b></td>
            <td>${h(r.return_date)}</td>
            <td><a href="#/sales-orders/${r.sales_order_id}">${h(r.order_no)}</a></td>
            <td>${h(cu ? cu.name : "")}</td>
            <td><span class="badge ${r.type === "退回" ? "red" : "purple"}">${h(r.type)}</span></td>
            <td>${h(wh ? wh.name : "")}</td>
            <td class="num">${fmt(r.untaxed_amount)}</td>
            <td class="num">${fmt(r.tax_amount)}</td>
            <td>${r.offset_receivable ? badge("冲减应收") : badge("不冲应收")}</td>
            <td class="num">${fmt(r.cost_reversal)}</td>
            <td>${h(r.remark || "-")}</td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>销货退回/折让</h1><p>客户退货或折让时使用；退货回冲应收账款并增加库存，成本一并回冲。</p></div>
        <div class="head-actions"><a class="btn primary" href="#/sales-returns/create">+ 新增退回/折让</a></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>退回单号</th><th>日期</th><th>销货订单</th><th>客户</th><th>类型</th><th>仓库</th><th class="num">未税金额</th><th class="num">税额</th><th>冲减应收</th><th class="num">回冲成本</th><th>备注</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="11"><div class="empty-state"><div class="big">📭</div>暂无销货退回记录</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔销货退回/折让</p>`;
    renderShell("sales_returns", content, "首页 / 日常作业 / 销货退回/折让");
};

Pages.salesReturnForm = function () {
    const soOpts = DB.list("sales_orders").filter(o => o.status === "shipped").map(o => {
        const cu = DB.get("customers", o.customer_id);
        return `<option value="${o.id}" data-customer="${o.customer_id}" data-currency="${h(o.currency)}">${h(o.no)} - ${h(cu ? cu.name : "")}</option>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h2>销货退回/折让｜新增</h2><p>选择已出货订单后自动带出客户与明细；退回增加库存、折让仅冲减应收。</p></div>
        <div class="actions"><a class="btn" href="#/sales-returns">返回退回/折让</a></div>
    </div>
    <form class="form-panel" id="srForm" novalidate onsubmit="Pages.saveSalesReturn(event)">
        <section class="form-section">
            <div class="form-grid section-grid">
                <div class="form-item"><label>销货订单<b>*</b></label>
                    <select name="sales_order_id" id="srSo" required onchange="Pages.srLoadOrder()"><option value="">请选择已出货订单</option>${soOpts}</select></div>
                <div class="form-item"><label>类型<b>*</b></label>
                    <select name="type" required><option>退回</option><option>折让</option></select></div>
                <div class="form-item"><label>退回日期</label><input type="date" name="return_date" value="${Utils.today()}"></div>
                <div class="form-item"><label>客户</label><input id="srCustomer" readonly></div>
                <div class="form-item"><label>入库仓库<b>*</b></label><select name="warehouse_id" required>${warehouseOptions("wh1")}</select></div>
                <div class="form-item"><label>冲减应收</label><select name="offset_receivable"><option value="1">冲减应收</option><option value="0">不冲减</option></select></div>
            </div>
        </section>
        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>退回明细</h3></div>
                <button class="btn" type="button" onclick="Pages.srLoadOrder(true)">从订单带出明细</button>
            </div>
            <div class="table-wrap detail-scroll">
                <table class="table bom-lines" id="srLines">
                    <thead><tr><th>品号</th><th>品名</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th><th>备注</th><th class="action-col">操作</th></tr></thead>
                    <tbody></tbody>
                    <tfoot><tr><th colspan="5" style="text-align:right">未税合计</th><th id="srTotal" class="num">0.00</th><th colspan="2"></th></tr></tfoot>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark" placeholder="退回/折让原因"></textarea></div>
        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存退回/折让</button>
            <a class="btn" href="#/sales-returns">返回</a>
        </div>
    </form>`;
    renderShell("sales_returns", content, "首页 / 日常作业 / 销货退回/折让");
};

Pages.srLoadOrder = function (forceLines) {
    const sel = document.getElementById("srSo");
    const opt = sel.options[sel.selectedIndex];
    const cuInput = document.getElementById("srCustomer");
    if (opt && opt.dataset.customer) {
        const cu = DB.get("customers", opt.dataset.customer);
        if (cuInput) cuInput.value = cu ? cu.name : "";
    }
    if (!forceLines) return;
    const o = DB.get("sales_orders", sel.value);
    if (!o) { toast("请先选择订单", "error"); return; }
    const tbody = document.querySelector("#srLines tbody");
    tbody.innerHTML = "";
    o.lines.forEach(l => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><input class="item-code" value="${h(l.code)}" readonly style="width:90px"></td>
            <td><input name="item_name[]" value="${h(l.name)}" readonly></td>
            <td><input type="number" step="0.0001" name="qty[]" value="${l.qty}" required style="width:90px"></td>
            <td><input name="unit[]" value="${h(l.unit)}" readonly style="width:70px"></td>
            <td><input type="number" step="0.0001" name="unit_price[]" value="${l.unit_price}" readonly style="width:110px"></td>
            <td class="line-amount num">${fmt(l.amount)}</td>
            <td><input name="line_remark[]" value=""></td>
            <td class="action-col"><button class="link-btn danger" type="button" onclick="this.closest('tr').remove();Pages.updateSRTotal()">移除</button></td>`;
        tbody.appendChild(tr);
    });
    Pages.updateSRTotal();
};

Pages.updateSRTotal = function () {
    let total = 0;
    document.querySelectorAll("#srLines tbody tr").forEach(row => {
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
        row.querySelector(".line-amount").textContent = Utils.round(qty * price).toFixed(2);
        total += Utils.round(qty * price);
    });
    const el = document.getElementById("srTotal");
    if (el) el.textContent = fmt(total);
};

Pages.saveSalesReturn = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    const so = DB.get("sales_orders", data.sales_order_id);
    if (!so) { toast("请选择销货订单", "error"); return; }

    const lines = [];
    document.querySelectorAll("#srLines tbody tr").forEach(row => {
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        if (qty <= 0) return;
        const code = row.querySelector(".item-code").value;
        const itRef = DB.itemByCode(code);
        lines.push({
            item_id: itRef ? itRef.id : "", code,
            name: row.querySelector('[name="item_name[]"]').value, qty,
            unit: row.querySelector('[name="unit[]"]').value,
            unit_price: Utils.num(row.querySelector('[name="unit_price[]"]').value),
            amount: Utils.round(qty * Utils.num(row.querySelector('[name="unit_price[]"]').value)),
            remark: row.querySelector('[name="line_remark[]"]').value || ""
        });
    });
    if (!lines.length) { toast("请至少新增一笔退回明细", "error"); return; }
    // 超退限制：累计退回（含本次）不得超过订单各商品已出货数量
    const priorReturns = DB.list("sales_returns").filter(r => r.sales_order_id === so.id);
    for (const l of lines) {
        const soLine = so.lines.find(sl => sl.item_id === l.item_id || (sl.code && sl.code === l.code));
        if (!soLine) continue;
        const priorQty = priorReturns.reduce((s, r) => s + (r.lines || []).reduce((a, x) =>
            a + (x.item_id === l.item_id || (x.code && x.code === l.code) ? Utils.num(x.qty) : 0), 0), 0);
        if (Utils.num(l.qty) + priorQty > Utils.num(soLine.qty) + 0.0001) {
            toast(`商品 ${l.code} 累计退回数量超过订单出货数量（最多可退 ${Utils.num(soLine.qty) - priorQty}），无法保存`, "error");
            return;
        }
    }
    const total = lines.reduce((s, l) => s + l.amount, 0);
    // 税额按退回金额占原单销售额比例分摊
    const ratio = Utils.num(so.invoice_amount) > 0 ? total / Utils.num(so.invoice_amount) : 0;
    const taxAmount = Utils.round(Utils.num(so.tax_amount) * ratio);
    const untaxedAmount = Utils.round(total - taxAmount);
    const costReversal = lines.reduce((s, l) => {
        const it = DB.itemByCode(l.code);
        const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
        // 成本按采购币别汇率折合本位币，与损益表/仪表板口径一致
        return s + Utils.num(l.qty) * rate * itemCostCNY(it);
    }, 0);

    // 退回增加库存（按销售→库存换算率换算为库存单位数量）
    if (data.type === "退回") {
        lines.forEach(l => {
            const it = DB.itemByCode(l.code);
            if (!it) return;
            const rate = Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
            DB.addStock(data.warehouse_id, it.id, Utils.num(l.qty) * rate);
        });
    }
    DB.insert("sales_returns", {
        no: nextDocNo("SR", "sales_returns", data.return_date), sales_order_id: so.id, order_no: so.no,
        customer_id: so.customer_id, type: data.type, return_date: data.return_date,
        warehouse_id: data.warehouse_id, lines, untaxed_amount: untaxedAmount, tax_amount: taxAmount,
        total_amount: total, offset_receivable: data.offset_receivable === "1",
        cost_reversal: Utils.round(costReversal), remark: data.remark || "",
        created_by: DB.currentUser().name
    });
    // 冲减应收时，同步回写订单收款状态（未收重新计算，已收超限则退回未收状态）
    if (data.offset_receivable === "1") {
        const received = Utils.num(so.received_amount);
        const allReturns = priorReturns.filter(r => r.offset_receivable).reduce((s, r) => s + Utils.num(r.total_amount), 0) + total;
        const outstanding = Math.max(Utils.num(so.invoice_amount) - received - allReturns, 0);
        const st = outstanding <= 0.001 ? "paid" : (received > 0 ? "partial" : "unpaid");
        DB.update("sales_orders", so.id, { payment_status: st });
    }
    toast("销货退回/折让已保存", "success");
    setTimeout(() => { location.hash = "#/sales-returns"; }, 300);
};

/* ============================================================
   采购退回/折让
   ============================================================ */
Pages.purchaseReturns = function () {
    const list = DB.list("purchase_returns").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(r => {
        const sp = DB.get("suppliers", r.supplier_id);
        return `<tr>
            <td><b>${h(r.no)}</b></td>
            <td>${h(r.return_date)}</td>
            <td><a href="#/purchase-orders/${r.purchase_order_id}/edit">${h(r.order_no)}</a></td>
            <td>${h(sp ? sp.name : "")}</td>
            <td><span class="badge ${r.type === "退回" ? "red" : "purple"}">${h(r.type)}</span></td>
            <td class="num">${fmt(r.amount)}</td>
            <td>${r.offset_payable ? badge("冲减应付") : badge("不冲应付")}</td>
            <td>${h(r.remark || "-")}</td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>采购退回/折让</h1><p>向供应商退货或折让时使用；退回减少库存并冲减应付账款。</p></div>
        <div class="head-actions"><a class="btn primary" href="#/purchase-returns/create">+ 新增退回/折让</a></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>退回单号</th><th>日期</th><th>采购单</th><th>供应商</th><th>类型</th><th class="num">金额</th><th>冲减应付</th><th>备注</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="8"><div class="empty-state"><div class="big">📭</div>暂无采购退回记录</div></td></tr>`}</tbody>
        </table>
    </div>
    <p class="stat-line">共 ${list.length} 笔采购退回/折让</p>`;
    renderShell("purchase_returns", content, "首页 / 日常作业 / 采购退回/折让");
};

Pages.purchaseReturnForm = function () {
    const poOpts = DB.list("purchase_orders").filter(o => o.status === "received").map(o => {
        const sp = DB.get("suppliers", o.supplier_id);
        return `<option value="${o.id}" data-supplier="${o.supplier_id}">${h(o.no)} - ${h(sp ? sp.name : "")}</option>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h2>采购退回/折让｜新增</h2><p>选择已进货采购单后自动带出供应商与明细；退回减少库存、冲减应付。</p></div>
        <div class="actions"><a class="btn" href="#/purchase-returns">返回退回/折让</a></div>
    </div>
    <form class="form-panel" id="prForm" novalidate onsubmit="Pages.savePurchaseReturn(event)">
        <section class="form-section">
            <div class="form-grid section-grid">
                <div class="form-item"><label>采购单<b>*</b></label>
                    <select name="purchase_order_id" id="prPo" required onchange="Pages.prLoadOrder()"><option value="">请选择已进货采购单</option>${poOpts}</select></div>
                <div class="form-item"><label>类型<b>*</b></label><select name="type" required><option>退回</option><option>折让</option></select></div>
                <div class="form-item"><label>退回日期</label><input type="date" name="return_date" value="${Utils.today()}"></div>
                <div class="form-item"><label>供应商</label><input id="prSupplier" readonly></div>
                <div class="form-item"><label>冲减应付</label><select name="offset_payable"><option value="1">冲减应付</option><option value="0">不冲减</option></select></div>
            </div>
        </section>
        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>退回明细</h3></div>
                <button class="btn" type="button" onclick="Pages.prLoadOrder(true)">从采购单带出明细</button>
            </div>
            <div class="table-wrap detail-scroll">
                <table class="table bom-lines" id="prLines">
                    <thead><tr><th>品号</th><th>品名</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th><th>备注</th><th class="action-col">操作</th></tr></thead>
                    <tbody></tbody>
                    <tfoot><tr><th colspan="5" style="text-align:right">合计</th><th id="prTotal" class="num">0.00</th><th colspan="2"></th></tr></tfoot>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark" placeholder="退回/折让原因"></textarea></div>
        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存退回/折让</button>
            <a class="btn" href="#/purchase-returns">返回</a>
        </div>
    </form>`;
    renderShell("purchase_returns", content, "首页 / 日常作业 / 采购退回/折让");
};

Pages.prLoadOrder = function (forceLines) {
    const sel = document.getElementById("prPo");
    const opt = sel.options[sel.selectedIndex];
    const spInput = document.getElementById("prSupplier");
    if (opt && opt.dataset.supplier) {
        const sp = DB.get("suppliers", opt.dataset.supplier);
        if (spInput) spInput.value = sp ? sp.name : "";
    }
    if (!forceLines) return;
    const o = DB.get("purchase_orders", sel.value);
    if (!o) { toast("请先选择采购单", "error"); return; }
    const tbody = document.querySelector("#prLines tbody");
    tbody.innerHTML = "";
    o.lines.forEach(l => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><input class="item-code" value="${h(l.code)}" readonly style="width:90px"></td>
            <td><input name="item_name[]" value="${h(l.name)}" readonly></td>
            <td><input type="number" step="0.0001" name="qty[]" value="${l.qty}" required style="width:90px"></td>
            <td><input name="unit[]" value="${h(l.unit)}" readonly style="width:70px"></td>
            <td><input type="number" step="0.0001" name="unit_price[]" value="${l.unit_price}" readonly style="width:110px"></td>
            <td class="line-amount num">${fmt(l.amount)}</td>
            <td><input name="line_remark[]" value=""></td>
            <td class="action-col"><button class="link-btn danger" type="button" onclick="this.closest('tr').remove();Pages.updatePRTotal()">移除</button></td>`;
        tbody.appendChild(tr);
    });
    Pages.updatePRTotal();
};

Pages.updatePRTotal = function () {
    let total = 0;
    document.querySelectorAll("#prLines tbody tr").forEach(row => {
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        const price = Utils.num(row.querySelector('[name="unit_price[]"]').value);
        row.querySelector(".line-amount").textContent = Utils.round(qty * price).toFixed(2);
        total += Utils.round(qty * price);
    });
    const el = document.getElementById("prTotal");
    if (el) el.textContent = fmt(total);
};

Pages.savePurchaseReturn = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    const po = DB.get("purchase_orders", data.purchase_order_id);
    if (!po) { toast("请选择采购单", "error"); return; }

    const lines = [];
    document.querySelectorAll("#prLines tbody tr").forEach(row => {
        const qty = Utils.num(row.querySelector('[name="qty[]"]').value);
        if (qty <= 0) return;
        const code = row.querySelector(".item-code").value;
        const itRef = DB.itemByCode(code);
        lines.push({
            item_id: itRef ? itRef.id : "", code,
            name: row.querySelector('[name="item_name[]"]').value, qty,
            unit: row.querySelector('[name="unit[]"]').value,
            unit_price: Utils.num(row.querySelector('[name="unit_price[]"]').value),
            amount: Utils.round(qty * Utils.num(row.querySelector('[name="unit_price[]"]').value)),
            remark: row.querySelector('[name="line_remark[]"]').value || ""
        });
    });
    if (!lines.length) { toast("请至少新增一笔退回明细", "error"); return; }
    // 超退限制：累计退回（含本次）不得超过采购单各商品已进货数量
    const priorPRs = DB.list("purchase_returns").filter(r => r.purchase_order_id === po.id);
    for (const l of lines) {
        const poLine = po.lines.find(pl => pl.item_id === l.item_id || (pl.code && pl.code === l.code));
        if (!poLine) continue;
        const priorQty = priorPRs.reduce((s, r) => s + (r.lines || []).reduce((a, x) =>
            a + (x.item_id === l.item_id || (x.code && x.code === l.code) ? Utils.num(x.qty) : 0), 0), 0);
        if (Utils.num(l.qty) + priorQty > Utils.num(poLine.qty) + 0.0001) {
            toast(`商品 ${l.code} 累计退回数量超过采购单进货数量（最多可退 ${Utils.num(poLine.qty) - priorQty}），无法保存`, "error");
            return;
        }
    }
    const total = lines.reduce((s, l) => s + l.amount, 0);

    if (data.type === "退回") {
        lines.forEach(l => {
            const it = DB.itemByCode(l.code);
            if (!it) return;
            const rate = Utils.num(it.purchase_to_stock) > 0 ? Utils.num(it.purchase_to_stock) : 1;
            DB.addStock(po.warehouse_id, it.id, -Utils.num(l.qty) * rate);
        });
    }
    DB.insert("purchase_returns", {
        no: nextDocNo("PR", "purchase_returns", data.return_date), purchase_order_id: po.id, order_no: po.no,
        supplier_id: po.supplier_id, type: data.type, return_date: data.return_date,
        warehouse_id: po.warehouse_id, lines, amount: total,
        offset_payable: data.offset_payable === "1", remark: data.remark || "",
        created_by: DB.currentUser().name
    });
    // 冲减应付时，同步回写采购单付款状态（已付重新计算，超限则退回未付状态）
    if (data.offset_payable === "1") {
        const paid = Utils.num(po.paid_amount);
        const allPRs = priorPRs.filter(r => r.offset_payable).reduce((s, r) => s + Utils.num(r.amount), 0) + total;
        const outstanding = Math.max(Utils.num(po.amount) - paid - allPRs, 0);
        const st = outstanding <= 0.001 ? "paid" : (paid > 0 ? "partial" : "unpaid");
        DB.update("purchase_orders", po.id, { payment_status: st });
    }
    toast("采购退回/折让已保存", "success");
    setTimeout(() => { location.hash = "#/purchase-returns"; }, 300);
};
