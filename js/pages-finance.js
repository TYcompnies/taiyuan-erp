/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 账款财务页面
   应收账款（收款登记）/ 应付账款（付款登记）
   （会计模块——传票/科目/总账/试算/资产负债表/损益表与费用支出已于 2026-08-28 移除）
   ============================================================ */
"use strict";

/* ============================================================
   应收账款
   ============================================================ */
Pages.accountsReceivable = function () {
    const orders = DB.list("sales_orders").filter(o => o.status === "shipped").sort((a, b) => b.no.localeCompare(a.no));
    // 销货退回冲减应收的金额映射（按订单）
    const returnMap = {};
    DB.list("sales_returns").filter(r => r.offset_receivable).forEach(r => {
        returnMap[r.sales_order_id] = (returnMap[r.sales_order_id] || 0) + Utils.num(r.total_amount);
    });
    const rows = orders.map(o => {
        const cu = DB.get("customers", o.customer_id);
        const received = Utils.num(o.received_amount) || 0;
        const outstanding = Math.max(Utils.num(o.invoice_amount) - received - (returnMap[o.id] || 0), 0);
        const days = Math.max(0, Math.round((new Date(Utils.today()) - new Date(o.order_date)) / 86400000));
        // 外币金额附本位币换算，与报表口径联动
        const fx = o.currency && o.currency !== COMPANY.baseCurrency;
        const cnv = (v) => fx ? `<br><small style="color:var(--muted)">≈ ${fmt(toCNY(v, o.currency))} ${COMPANY.baseCurrency}</small>` : "";
        return `<tr>
            <td><b>${h(o.no)}</b></td>
            <td>${h(o.order_date)}</td>
            <td>${h(cu ? cu.name : "")}</td>
            <td>${h(o.currency)}</td>
            <td class="num">${fmt(o.invoice_amount)}${cnv(o.invoice_amount)}</td>
            <td class="num">${fmt(received)}${cnv(received)}</td>
            <td class="num" style="color:${outstanding > 0 ? "var(--danger)" : "var(--green)"};font-weight:700">${fmt(outstanding)}${cnv(outstanding)}</td>
            <td>${outstanding <= 0 ? badge("已收款") : days > 60 ? badge("逾期超60天") : days > 30 ? badge("逾期") : badge("未收款")}</td>
            <td class="num">${days}天</td>
            <td class="action-col">${outstanding > 0 ? `<button class="link-btn" onclick="Pages.receivePayment('${o.id}')">登记收款</button>` : ""}</td>
        </tr>`;
    }).join("");

    const totalReceivable = orders.reduce((s, o) => s + toCNY(Math.max(Utils.num(o.invoice_amount) - Utils.num(o.received_amount) - (returnMap[o.id] || 0), 0), o.currency), 0);
    // 已收款笔数：已收金额 ≥ 净应收（应收扣退货冲减），口径与未收一致
    const paidCount = orders.filter(o => Utils.num(o.received_amount) >= Math.max(Utils.num(o.invoice_amount) - (returnMap[o.id] || 0), 0) - 0.001).length;

    const content = `
    <div class="page-head">
        <div><h1>进销存应收账款</h1><p>追踪已出货订单的未收款；登记收款后金额实时更新，外币附本位币换算（${COMPANY.baseCurrency}）。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/report/profit">进销存损益报表</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>未收应收（本位币）</span><strong style="color:var(--danger)">${fmt(totalReceivable)}</strong><p>所有已出货未收款折合 ${COMPANY.baseCurrency}</p></div>
        <div class="kpi-card"><span>应收笔数</span><strong>${orders.length}</strong><p>已出货订单数</p></div>
        <div class="kpi-card"><span>已收款笔数</span><strong>${paidCount}</strong><p>全额收款订单（含退货冲减）</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>订单单号</th><th>日期</th><th>客户</th><th>币别</th><th class="num">应收金额</th><th class="num">已收金额</th><th class="num">未收金额</th><th>状态</th><th class="num">账龄</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="10"><div class="empty-state"><div class="big">💰</div>暂无应收账款</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("accounts_receivable", content, "首页 / 账款财务 / 进销存应收账款");
};

Pages.receivePayment = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    const received = Utils.num(o.received_amount) || 0;
    // 未收金额扣除销货退回/折让冲减，与应收账款列表口径一致
    const returnTotal = DB.list("sales_returns").filter(r => r.sales_order_id === id && r.offset_receivable).reduce((s, r) => s + Utils.num(r.total_amount), 0);
    const outstanding = Math.max(Utils.num(o.invoice_amount) - received - returnTotal, 0);
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>登记收款 - ${h(o.no)}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">
            <div class="form-item"><label>应收金额</label><input value="${fmt(o.invoice_amount)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>未收金额</label><input value="${fmt(outstanding)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>本次收款金额<b>*</b></label><input type="number" id="payAmount" value="${outstanding.toFixed(2)}" step="0.01" min="0" oninput="Pages.updatePayRemain(${outstanding})"></div>
            <div class="form-item" style="margin-top:10px"><label>收后未收余额</label><input id="payRemain" value="${fmt(outstanding)}" readonly style="color:var(--green);font-weight:700"></div>
            <div class="form-item" style="margin-top:10px"><label>收款方式</label><select id="payMethod">${feeMethodOptions("银行转账")}</select></div>
            <div class="form-item" style="margin-top:10px"><label>收款日期</label><input type="date" id="payDate" value="${Utils.today()}"></div>
        </div>
        <div class="modal-foot">
            <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
            <button class="btn primary" onclick="Pages.doSavePayment('${id}')">确认收款</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
};

// 收款弹窗：输入金额后实时更新收后未收余额（联动）
Pages.updatePayRemain = function (outstanding) {
    const amt = Utils.num(document.getElementById("payAmount").value);
    const remainEl = document.getElementById("payRemain");
    if (remainEl) remainEl.value = fmt(Math.max(Utils.num(outstanding) - amt, 0));
};

Pages.doSavePayment = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    const amt = Utils.num(document.getElementById("payAmount").value);
    if (amt <= 0) { toast("请输入有效收款金额", "error"); return; }
    const received = Utils.num(o.received_amount) || 0;
    // 未收金额扣除销货退回/折让冲减，避免超收
    const returnTotal = DB.list("sales_returns").filter(r => r.sales_order_id === id && r.offset_receivable).reduce((s, r) => s + Utils.num(r.total_amount), 0);
    const outstanding = Math.max(Utils.num(o.invoice_amount) - received - returnTotal, 0);
    if (amt > outstanding + 0.001) { toast("收款金额不能超过未收金额（含退货冲减）", "error"); return; }
    const newReceived = Utils.round(received + amt);
    // 收款状态联动：净应收 = 应收 - 退货冲减；全部收足即视为已收款（口径与应收账款页一致）
    const allReturns = DB.list("sales_returns").filter(r => r.sales_order_id === id && r.offset_receivable).reduce((s, r) => s + Utils.num(r.total_amount), 0);
    const netInv = Math.max(Utils.num(o.invoice_amount) - allReturns, 0);
    const payment_status = newReceived >= netInv - 0.001 ? "paid" : (newReceived > 0 ? "partial" : "unpaid");
    // 保存收款方式与收款日期，形成收款流水可追溯
    const method = document.getElementById("payMethod") ? document.getElementById("payMethod").value : "";
    const pDate = document.getElementById("payDate") ? document.getElementById("payDate").value : Utils.today();
    DB.update("sales_orders", id, {
        received_amount: newReceived, payment_status,
        payment_method: method || o.payment_method || "银行转账",
        payment_date: pDate
    });
    document.querySelector(".modal-mask")?.remove();
    toast("收款登记成功", "success");
    render();
};

/* ============================================================
   应付账款
   ============================================================ */
Pages.accountsPayable = function () {
    const pos = DB.list("purchase_orders").filter(o => o.status === "received").sort((a, b) => b.no.localeCompare(a.no));
    // 采购退回冲减应付的金额映射（按采购单）
    const returnMap = {};
    DB.list("purchase_returns").filter(r => r.offset_payable).forEach(r => {
        returnMap[r.purchase_order_id] = (returnMap[r.purchase_order_id] || 0) + Utils.num(r.amount);
    });
    const rows = pos.map(o => {
        const sp = DB.get("suppliers", o.supplier_id);
        const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - (returnMap[o.id] || 0), 0);
        const days = Math.max(0, Math.round((new Date(Utils.today()) - new Date(o.po_date)) / 86400000));
        // 外币金额附本位币换算，与报表口径联动
        const fx = o.currency && o.currency !== COMPANY.baseCurrency;
        const cnv = (v) => fx ? `<br><small style="color:var(--muted)">≈ ${fmt(toCNY(v, o.currency))} ${COMPANY.baseCurrency}</small>` : "";
        return `<tr>
            <td><b>${h(o.no)}</b></td>
            <td>${h(o.po_date)}</td>
            <td>${h(sp ? sp.name : "")}</td>
            <td>${h(o.currency)}</td>
            <td class="num">${fmt(o.amount)}${cnv(o.amount)}</td>
            <td class="num">${fmt(o.paid_amount)}${cnv(o.paid_amount)}</td>
            <td class="num" style="color:${unpaid > 0 ? "var(--danger)" : "var(--green)"};font-weight:700">${fmt(unpaid)}${cnv(unpaid)}</td>
            <td>${unpaid <= 0 ? badge("已付清") : badge("未付款")}</td>
            <td class="num">${days}天</td>
            <td class="action-col">${unpaid > 0 ? `<button class="link-btn" onclick="Pages.payPO('${o.id}')">登记付款</button>` : ""}</td>
        </tr>`;
    }).join("");

    const totalPayable = pos.reduce((s, o) => s + toCNY(Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - (returnMap[o.id] || 0), 0), o.currency), 0);
    // 已付清笔数：已付金额 ≥ 净应付（应付扣退回冲减），口径与未付一致
    const paidCount = pos.filter(o => Utils.num(o.paid_amount) >= Math.max(Utils.num(o.amount) - (returnMap[o.id] || 0), 0) - 0.001).length;

    const content = `
    <div class="page-head">
        <div><h1>进销存应付账款</h1><p>追踪已进货采购单的未付款；登记付款后金额实时更新，外币附本位币换算（${COMPANY.baseCurrency}）。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/report/profit">进销存损益报表</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>未付应付（本位币）</span><strong style="color:var(--danger)">${fmt(totalPayable)}</strong><p>所有已进货未付款折合 ${COMPANY.baseCurrency}</p></div>
        <div class="kpi-card"><span>应付笔数</span><strong>${pos.length}</strong><p>已进货采购单数</p></div>
        <div class="kpi-card"><span>已付清笔数</span><strong>${paidCount}</strong><p>全额付款采购单（含退回冲减）</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>采购单号</th><th>日期</th><th>供应商</th><th>币别</th><th class="num">应付金额</th><th class="num">已付金额</th><th class="num">未付金额</th><th>状态</th><th class="num">账龄</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="10"><div class="empty-state"><div class="big">💰</div>暂无应付账款</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("accounts_payable", content, "首页 / 账款财务 / 进销存应付账款");
};

Pages.payPO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    // 未付金额扣除采购退回/折让冲减，与应付账款列表口径一致
    const returnTotal = DB.list("purchase_returns").filter(r => r.purchase_order_id === id && r.offset_payable).reduce((s, r) => s + Utils.num(r.amount), 0);
    const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - returnTotal, 0);
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>登记付款 - ${h(o.no)}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">
            <div class="form-item"><label>应付金额</label><input value="${fmt(o.amount)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>未付金额</label><input value="${fmt(unpaid)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>本次付款金额<b>*</b></label><input type="number" id="payAmountPO" value="${unpaid.toFixed(2)}" step="0.01" min="0" oninput="Pages.updatePayRemainPO(${unpaid})"></div>
            <div class="form-item" style="margin-top:10px"><label>付后未付余额</label><input id="payRemainPO" value="${fmt(unpaid)}" readonly style="color:var(--green);font-weight:700"></div>
            <div class="form-item" style="margin-top:10px"><label>付款方式</label><select id="payMethodPO">${feeMethodOptions("银行转账")}</select></div>
            <div class="form-item" style="margin-top:10px"><label>付款日期</label><input type="date" id="payDatePO" value="${Utils.today()}"></div>
        </div>
        <div class="modal-foot">
            <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
            <button class="btn primary" onclick="Pages.doSavePayPO('${id}')">确认付款</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
};

// 付款弹窗：输入金额后实时更新付后未付余额（联动）
Pages.updatePayRemainPO = function (unpaid) {
    const amt = Utils.num(document.getElementById("payAmountPO").value);
    const remainEl = document.getElementById("payRemainPO");
    if (remainEl) remainEl.value = fmt(Math.max(Utils.num(unpaid) - amt, 0));
};

Pages.doSavePayPO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    const amt = Utils.num(document.getElementById("payAmountPO").value);
    if (amt <= 0) { toast("请输入有效付款金额", "error"); return; }
    // 未付金额扣除采购退回/折让冲减，避免超付
    const returnTotal = DB.list("purchase_returns").filter(r => r.purchase_order_id === id && r.offset_payable).reduce((s, r) => s + Utils.num(r.amount), 0);
    const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - returnTotal, 0);
    if (amt > unpaid + 0.001) { toast("付款金额不能超过未付金额（含退回冲减）", "error"); return; }
    const newPaid = Utils.round(Utils.num(o.paid_amount) + amt);
    // 付款状态联动：净应付 = 应付 - 退回冲减；全部付足即视为已付清（口径与应付账款页一致）
    const allPRs = DB.list("purchase_returns").filter(r => r.purchase_order_id === id && r.offset_payable).reduce((s, r) => s + Utils.num(r.amount), 0);
    const netInv = Math.max(Utils.num(o.amount) - allPRs, 0);
    const payment_status = newPaid >= netInv - 0.001 ? "paid" : (newPaid > 0 ? "partial" : "unpaid");
    // 保存付款方式与付款日期，形成付款流水可追溯
    const method = document.getElementById("payMethodPO") ? document.getElementById("payMethodPO").value : "";
    const pDate = document.getElementById("payDatePO") ? document.getElementById("payDatePO").value : Utils.today();
    DB.update("purchase_orders", id, {
        paid_amount: newPaid, payment_status,
        payment_method: method || o.payment_method || "银行转账",
        payment_date: pDate
    });
    document.querySelector(".modal-mask")?.remove();
    toast("付款登记成功", "success");
    render();
};
