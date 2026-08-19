/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 账款财务页面
   应收 / 应付 / 费用支出 / 传票作业 / 损益表
   ============================================================ */
"use strict";

/* ============================================================
   应收账款
   ============================================================ */
Pages.accountsReceivable = function () {
    const orders = DB.list("sales_orders").filter(o => o.status === "shipped").sort((a, b) => b.no.localeCompare(a.no));
    const rows = orders.map(o => {
        const cu = DB.get("customers", o.customer_id);
        const received = Utils.num(o.received_amount) || 0;
        const outstanding = Math.max(Utils.num(o.invoice_amount) - received, 0);
        const days = Math.max(0, Math.round((new Date(Utils.today()) - new Date(o.order_date)) / 86400000));
        return `<tr>
            <td><b>${h(o.no)}</b></td>
            <td>${h(o.order_date)}</td>
            <td>${h(cu ? cu.name : "")}</td>
            <td>${h(o.currency)}</td>
            <td class="num">${fmt(o.invoice_amount)}</td>
            <td class="num">${fmt(received)}</td>
            <td class="num" style="color:${outstanding > 0 ? "var(--danger)" : "var(--green)"};font-weight:700">${fmt(outstanding)}</td>
            <td>${outstanding <= 0 ? badge("已收款") : days > 60 ? badge("逾期超60天") : days > 30 ? badge("逾期") : badge("未收款")}</td>
            <td class="num">${days}天</td>
            <td class="action-col">${outstanding > 0 ? `<button class="link-btn" onclick="Pages.receivePayment('${o.id}')">登记收款</button>` : ""}</td>
        </tr>`;
    }).join("");

    const totalReceivable = orders.reduce((s, o) => s + Math.max(Utils.num(o.invoice_amount) - Utils.num(o.received_amount), 0), 0);

    const content = `
    <div class="page-head">
        <div><h1>应收账款</h1><p>追踪已出货订单的未收款；登记收款后金额实时更新。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/accounting/income-statement">损益表</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>未收应收</span><strong style="color:var(--danger)">${fmt(totalReceivable)}</strong><p>所有已出货未收款</p></div>
        <div class="kpi-card"><span>应收笔数</span><strong>${orders.length}</strong><p>已出货订单数</p></div>
        <div class="kpi-card"><span>已收款笔数</span><strong>${orders.filter(o => Utils.num(o.received_amount) >= Utils.num(o.invoice_amount)).length}</strong><p>全额收款订单</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>订单单号</th><th>日期</th><th>客户</th><th>币别</th><th class="num">应收金额</th><th class="num">已收金额</th><th class="num">未收金额</th><th>状态</th><th class="num">账龄</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="10"><div class="empty-state"><div class="big">💰</div>暂无应收账款</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("accounts_receivable", content, "首页 / 账款财务 / 应收账款");
};

Pages.receivePayment = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    const received = Utils.num(o.received_amount) || 0;
    const outstanding = Math.max(Utils.num(o.invoice_amount) - received, 0);
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>登记收款 - ${h(o.no)}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">
            <div class="form-item"><label>应收金额</label><input value="${fmt(o.invoice_amount)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>未收金额</label><input value="${fmt(outstanding)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>本次收款金额<b>*</b></label><input type="number" id="payAmount" value="${fmt(outstanding)}" step="0.01"></div>
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

Pages.doSavePayment = function (id) {
    const o = DB.get("sales_orders", id);
    if (!o) return;
    const amt = Utils.num(document.getElementById("payAmount").value);
    if (amt <= 0) { toast("请输入有效收款金额", "error"); return; }
    const received = Utils.num(o.received_amount) || 0;
    const newReceived = Utils.round(received + amt);
    const payment_status = newReceived >= Utils.num(o.invoice_amount) ? "paid" : "partial";
    DB.update("sales_orders", id, { received_amount: newReceived, payment_status });
    document.querySelector(".modal-mask")?.remove();
    toast("收款登记成功", "success");
    render();
};

/* ============================================================
   应付账款
   ============================================================ */
Pages.accountsPayable = function () {
    const pos = DB.list("purchase_orders").filter(o => o.status === "received").sort((a, b) => b.no.localeCompare(a.no));
    const rows = pos.map(o => {
        const sp = DB.get("suppliers", o.supplier_id);
        const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount), 0);
        const days = Math.max(0, Math.round((new Date(Utils.today()) - new Date(o.po_date)) / 86400000));
        return `<tr>
            <td><b>${h(o.no)}</b></td>
            <td>${h(o.po_date)}</td>
            <td>${h(sp ? sp.name : "")}</td>
            <td>${h(o.currency)}</td>
            <td class="num">${fmt(o.amount)}</td>
            <td class="num">${fmt(o.paid_amount)}</td>
            <td class="num" style="color:${unpaid > 0 ? "var(--danger)" : "var(--green)"};font-weight:700">${fmt(unpaid)}</td>
            <td>${unpaid <= 0 ? badge("已付清") : badge("未付款")}</td>
            <td class="num">${days}天</td>
            <td class="action-col">${unpaid > 0 ? `<button class="link-btn" onclick="Pages.payPO('${o.id}')">登记付款</button>` : ""}</td>
        </tr>`;
    }).join("");

    const totalPayable = pos.reduce((s, o) => s + Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount), 0), 0);

    const content = `
    <div class="page-head">
        <div><h1>应付账款</h1><p>追踪已进货采购单的未付款；登记付款后金额实时更新。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/accounting/income-statement">损益表</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>未付应付</span><strong style="color:var(--danger)">${fmt(totalPayable)}</strong><p>所有已进货未付款</p></div>
        <div class="kpi-card"><span>应付笔数</span><strong>${pos.length}</strong><p>已进货采购单数</p></div>
        <div class="kpi-card"><span>已付清笔数</span><strong>${pos.filter(o => Utils.num(o.paid_amount) >= Utils.num(o.amount)).length}</strong><p>全额付款采购单</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>采购单号</th><th>日期</th><th>供应商</th><th>币别</th><th class="num">应付金额</th><th class="num">已付金额</th><th class="num">未付金额</th><th>状态</th><th class="num">账龄</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="10"><div class="empty-state"><div class="big">💰</div>暂无应付账款</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("accounts_payable", content, "首页 / 账款财务 / 应付账款");
};

Pages.payPO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    const unpaid = Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount), 0);
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>登记付款 - ${h(o.no)}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">
            <div class="form-item"><label>应付金额</label><input value="${fmt(o.amount)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>未付金额</label><input value="${fmt(unpaid)}" readonly></div>
            <div class="form-item" style="margin-top:10px"><label>本次付款金额<b>*</b></label><input type="number" id="payAmountPO" value="${fmt(unpaid)}" step="0.01"></div>
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

Pages.doSavePayPO = function (id) {
    const o = DB.get("purchase_orders", id);
    if (!o) return;
    const amt = Utils.num(document.getElementById("payAmountPO").value);
    if (amt <= 0) { toast("请输入有效付款金额", "error"); return; }
    DB.update("purchase_orders", id, { paid_amount: Utils.round(Utils.num(o.paid_amount) + amt) });
    document.querySelector(".modal-mask")?.remove();
    toast("付款登记成功", "success");
    render();
};

/* ============================================================
   费用支出
   ============================================================ */
Pages.expenses = function () {
    const list = DB.list("expenses").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(e => `<tr>
        <td><b>${h(e.no)}</b></td>
        <td>${h(e.date)}</td>
        <td><span class="badge teal">${h(e.type)}</span></td>
        <td>${h(e.account)}</td>
        <td class="num" style="font-weight:700">${fmt(e.amount)}</td>
        <td>${h(e.payment_method)}</td>
        <td>${e.voucher_no ? `<a href="#/accounting/vouchers">${h(e.voucher_no)}</a>` : '<span class="badge orange">未切传票</span>'}</td>
        <td>${h(e.remark || "-")}</td>
        <td class="action-col"><button class="link-btn danger" onclick="Pages.deleteExpense('${e.id}')">删除</button></td>
    </tr>`).join("");
    const total = list.reduce((s, e) => s + Utils.num(e.amount), 0);

    const content = `
    <div class="page-head">
        <div><h1>费用支出</h1><p>登记房租、水电、物流、平台费等营业支出，进入损益表。</p></div>
        <div class="head-actions">${can("finance.expense") ? `<a class="btn primary" href="#/expenses/create">+ 新增费用支出</a>` : ""}</div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>本月费用</span><strong>${fmt(total)}</strong><p>全部费用支出合计</p></div>
        <div class="kpi-card"><span>费用笔数</span><strong>${list.length}</strong><p>登记费用记录数</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>费用单号</th><th>日期</th><th>费用类型</th><th>会计科目</th><th class="num">金额</th><th>付款方式</th><th>传票</th><th>备注</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="9"><div class="empty-state"><div class="big">📭</div>暂无费用记录</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("expenses", content, "首页 / 账款财务 / 费用支出");
};

Pages.deleteExpense = function (id) {
    confirmModal("确定要删除这笔费用支出吗？", () => {
        DB.remove("expenses", id);
        toast("已删除", "success");
        render();
    });
};

Pages.expenseForm = function () {
    const content = `
    <div class="page-head">
        <div><h2>费用支出｜新增</h2><p>登记营业费用，配合传票作业形成完整财务报表。</p></div>
        <div class="actions"><a class="btn" href="#/expenses">返回费用支出</a></div>
    </div>
    <form class="form-panel" style="max-width:820px" onsubmit="Pages.saveExpense(event)">
        <div class="form-grid section-grid">
            <div class="form-item"><label>费用日期<b>*</b></label><input type="date" name="date" value="${Utils.today()}" required></div>
            <div class="form-item"><label>费用类型<b>*</b></label>
                <select name="type" required>
                    <option value="">请选择</option>
                    <option>房租</option><option>水电费</option><option>物流费</option><option>平台服务费</option>
                    <option>广告费</option><option>办公费</option><option>员工工资</option><option>差旅费</option>
                    <option>设备购置</option><option>其他</option>
                </select></div>
            <div class="form-item"><label>会计科目<b>*</b></label>
                <select name="account" required>
                    <option value="">请选择</option>
                    <option>管理费用-房租</option><option>管理费用-水电</option><option>管理费用-办公</option>
                    <option>销售费用-物流</option><option>销售费用-平台费</option><option>销售费用-广告</option>
                    <option>销售费用-包装</option><option>管理费用-工资</option><option>管理费用-差旅</option>
                    <option>营业外支出</option><option>其他费用</option>
                </select></div>
            <div class="form-item"><label>金额<b>*</b></label><input type="number" step="0.01" name="amount" required placeholder="0.00"></div>
            <div class="form-item"><label>付款方式</label><select name="payment_method">${feeMethodOptions("银行转账")}</select></div>
            <div class="form-item wide"><label>备注</label><textarea name="remark" placeholder="费用说明"></textarea></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存费用支出</button>
            <a class="btn" href="#/expenses">返回</a>
        </div>
    </form>`;
    renderShell("expenses", content, "首页 / 账款财务 / 费用支出");
};

Pages.saveExpense = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    if (Utils.num(data.amount) <= 0) { toast("请输入有效金额", "error"); return; }
    DB.insert("expenses", {
        no: nextDocNo("EX", "expenses"), date: data.date, type: data.type,
        account: data.account, amount: Utils.round(data.amount),
        payment_method: data.payment_method, remark: data.remark || "",
        voucher_no: "", created_by: DB.currentUser().name
    });
    toast("费用支出已保存", "success");
    render();
};

/* ============================================================
   传票作业
   ============================================================ */
Pages.vouchers = function () {
    const list = DB.list("vouchers").sort((a, b) => b.no.localeCompare(a.no));
    const rows = list.map(v => {
        const debits = v.lines.filter(l => Utils.num(l.debit) > 0);
        const credits = v.lines.filter(l => Utils.num(l.credit) > 0);
        const amount = v.lines.reduce((s, l) => s + Utils.num(l.debit), 0);
        return `<tr>
            <td><b>${h(v.no)}</b></td>
            <td>${h(v.date)}</td>
            <td><span class="badge gray">${h(v.source)}</span> ${h(v.source_no || "")}</td>
            <td>${h(v.counterparty || "-")}</td>
            <td>${debits.map(l => h(l.account)).join("<br>")}</td>
            <td>${credits.map(l => h(l.account)).join("<br>")}</td>
            <td class="num">${fmt(amount)}</td>
            <td>${v.balanced ? badge("平衡") : badge("不平衡")}</td>
            <td>${h(v.payment_method || "-")}</td>
            <td>${v.status === "已过账" ? badge("已过账") : badge("未过账")}</td>
            <td>${h(v.created_by)}</td>
            <td class="action-col">
                ${v.status === "未过账" ? `<button class="link-btn" onclick="Pages.postVoucher('${v.id}')">过账</button>` : ""}
                <button class="link-btn danger" onclick="Pages.deleteVoucher('${v.id}')">删除</button>
            </td>
        </tr>`;
    }).join("");
    const unposted = list.filter(v => v.status === "未过账").length;

    const content = `
    <div class="page-head">
        <div><h1>传票作业</h1><p>收付款与费用切传票，过账后进入财务报表。</p></div>
        <div class="head-actions">${can("finance.voucher") ? `<a class="btn primary" href="#/accounting/vouchers/create">+ 新增传票</a>` : ""}</div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>未过账传票</span><strong style="color:var(--orange)">${unposted}</strong><p>需处理并过账</p></div>
        <div class="kpi-card"><span>传票总数</span><strong>${list.length}</strong><p>全部传票笔数</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>传票号</th><th>日期</th><th>来源</th><th>对象</th><th>借方科目</th><th>贷方科目</th><th class="num">金额</th><th>平衡</th><th>收付款方式</th><th>状态</th><th>切传票人员</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="12"><div class="empty-state"><div class="big">📭</div>暂无传票</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("vouchers", content, "首页 / 账款财务 / 传票作业");
};

Pages.postVoucher = function (id) {
    const v = DB.get("vouchers", id);
    if (!v) return;
    if (!v.balanced) { toast("该传票借贷不平衡，无法过账", "error"); return; }
    confirmModal(`确定要过账传票 ${v.no} 吗？过账后不可修改。`, () => {
        DB.update("vouchers", id, { status: "已过账" });
        const ex = DB.find("expenses", e => e.voucher_no === v.no);
        if (ex) DB.update("expenses", ex.id, { voucher_no: v.no });
        toast("传票已过账", "success");
        render();
    }, "传票过账");
};

Pages.deleteVoucher = function (id) {
    confirmModal("确定要删除这笔传票吗？", () => {
        DB.remove("vouchers", id);
        toast("已删除", "success");
        render();
    });
};

Pages.voucherForm = function () {
    const content = `
    <div class="page-head">
        <div><h2>传票作业｜新增</h2><p>借方与贷方金额需平衡方可过账。</p></div>
        <div class="actions"><a class="btn" href="#/accounting/vouchers">返回传票</a></div>
    </div>
    <form class="form-panel" onsubmit="Pages.saveVoucher(event)">
        <section class="form-section">
            <div class="form-grid section-grid">
                <div class="form-item"><label>传票日期<b>*</b></label><input type="date" name="date" value="${Utils.today()}" required></div>
                <div class="form-item"><label>来源</label>
                    <select name="source"><option>应收账款</option><option>应付账款</option><option>费用支出</option><option>收款作业</option><option>付款作业</option><option>其他</option></select></div>
                <div class="form-item"><label>来源单号</label><input name="source_no" placeholder="关联单据编号"></div>
                <div class="form-item"><label>对象</label><input name="counterparty" placeholder="往来对象/供应商/客户"></div>
                <div class="form-item"><label>收付款方式</label><select name="payment_method">${feeMethodOptions("银行转账")}</select></div>
                <div class="form-item"><label>状态</label><select name="status"><option>未过账</option><option>已过账</option></select></div>
            </div>
        </section>
        <section class="form-section">
            <div class="bom-lines-head">
                <div><h3>传票分录</h3><p class="muted">借方（Debit）与贷方（Credit）需平衡。</p></div>
                <button class="btn" type="button" onclick="Pages.addVoucherLine()">+ 新增分录</button>
            </div>
            <div class="table-wrap detail-scroll">
                <table class="table bom-lines" id="voucherLines">
                    <thead><tr><th>会计科目<b>*</b></th><th class="num">借方金额</th><th class="num">贷方金额</th><th class="action-col">操作</th></tr></thead>
                    <tbody></tbody>
                    <tfoot>
                        <tr><th style="text-align:right">合计</th><th id="vDebitTotal" class="num">0.00</th><th id="vCreditTotal" class="num">0.00</th><th></th></tr>
                        <tr><th style="text-align:right">差额</th><th id="vDiff" class="num" colspan="2">0.00</th><th></th></tr>
                    </tfoot>
                </table>
            </div>
        </section>
        <div class="form-item wide" style="margin-top:16px"><label>备注</label><textarea name="remark" placeholder="传票说明"></textarea></div>
        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存传票</button>
            <a class="btn" href="#/accounting/vouchers">返回</a>
        </div>
    </form>`;
    renderShell("vouchers", content, "首页 / 账款财务 / 传票作业");
    Pages.addVoucherLine();
    Pages.addVoucherLine();
};

Pages.addVoucherLine = function () {
    const tbody = document.querySelector("#voucherLines tbody");
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><select name="account[]" required style="min-width:220px">
            <option value="">请选择科目</option>
            <option>应收账款</option><option>应付账款</option><option>银行存款</option><option>现金</option>
            <option>主营业务收入</option><option>主营业务成本</option><option>应交税费-销项税</option><option>应交税费-进项税</option>
            <option>销售费用-物流</option><option>销售费用-平台费</option><option>销售费用-广告</option><option>管理费用-房租</option>
            <option>管理费用-水电</option><option>管理费用-办公</option><option>管理费用-工资</option><option>营业外支出</option><option>其他费用</option>
        </select></td>
        <td><input type="number" step="0.01" name="debit[]" value="" style="width:130px" oninput="Pages.updateVoucherTotals()"></td>
        <td><input type="number" step="0.01" name="credit[]" value="" style="width:130px" oninput="Pages.updateVoucherTotals()"></td>
        <td class="action-col"><button class="link-btn danger" type="button" onclick="this.closest('tr').remove();Pages.updateVoucherTotals()">移除</button></td>`;
    tbody.appendChild(tr);
};

Pages.updateVoucherTotals = function () {
    let d = 0, c = 0;
    document.querySelectorAll("#voucherLines tbody tr").forEach(row => {
        d += Utils.num(row.querySelector('[name="debit[]"]').value);
        c += Utils.num(row.querySelector('[name="credit[]"]').value);
    });
    const de = document.getElementById("vDebitTotal");
    const ce = document.getElementById("vCreditTotal");
    const df = document.getElementById("vDiff");
    if (de) de.textContent = fmt(d);
    if (ce) ce.textContent = fmt(c);
    if (df) {
        df.textContent = fmt(d - c);
        df.style.color = Math.abs(d - c) < 0.01 ? "var(--green)" : "var(--danger)";
    }
};

Pages.saveVoucher = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });

    const lines = [];
    const accts = e.target.querySelectorAll('[name="account[]"]');
    const debits = e.target.querySelectorAll('[name="debit[]"]');
    const credits = e.target.querySelectorAll('[name="credit[]"]');
    for (let i = 0; i < accts.length; i++) {
        const a = accts[i].value;
        const d = Utils.num(debits[i].value);
        const c = Utils.num(credits[i].value);
        if (!a) continue;
        if (d === 0 && c === 0) continue;
        lines.push({ account: a, debit: d, credit: c });
    }
    if (!lines.length) { toast("请至少输入一笔分录", "error"); return; }
    const dTotal = lines.reduce((s, l) => s + l.debit, 0);
    const cTotal = lines.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(dTotal - cTotal) > 0.01) { toast("借方与贷方金额不平衡，无法保存", "error"); return; }

    DB.insert("vouchers", {
        no: nextDocNo("JV", "vouchers"), date: data.date, source: data.source,
        source_no: data.source_no || "", counterparty: data.counterparty || "",
        payment_method: data.payment_method, status: data.status || "未过账",
        lines, balanced: true, remark: data.remark || "", created_by: DB.currentUser().name
    });
    toast("传票已保存", "success");
    render();
};

/* ============================================================
   损益表
   ============================================================ */
let incomeMonthSel = "";

Pages.incomeStatement = function () {
    const month = incomeMonthSel || (new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"));
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
        months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
    }
    const monthOpts = months.map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${m}</option>`).join("");

    // 计算（以传入月份为准；默认当月，为了演示丰富，默认显示上月若有数据则当月）
    const shippedInMonth = DB.list("sales_orders").filter(o => o.status === "shipped" && o.order_date.startsWith(month));
    const revenue = shippedInMonth.reduce((s, o) => s + Utils.num(o.invoice_amount), 0);
    const cogs = shippedInMonth.reduce((s, o) => s + o.lines.reduce((a, l) => {
        const it = DB.get("items", l.item_id);
        return a + Utils.num(l.qty) * Utils.num(it ? it.cost : 0);
    }, 0), 0);
    const grossProfit = revenue - cogs;

    const expenses = DB.list("expenses").filter(e => e.date.startsWith(month));
    const expenseTotal = expenses.reduce((s, e) => s + Utils.num(e.amount), 0);
    const expenseRows = {};
    expenses.forEach(e => { expenseRows[e.account] = (expenseRows[e.account] || 0) + Utils.num(e.amount); });
    const expenseHtml = Object.keys(expenseRows).map(k =>
        `<tr class="indent"><td>${h(k)}</td><td class="num">${fmt(expenseRows[k])}</td></tr>`).join("");

    const returns = DB.list("sales_returns").filter(r => r.return_date.startsWith(month));
    const returnTotal = returns.reduce((s, r) => s + Utils.num(r.total_amount), 0);
    const netProfit = Utils.round(grossProfit - expenseTotal - returnTotal);

    const content = `
    <div class="page-head">
        <div><h1>损益表</h1><p>收入 - 销货成本 - 费用 = 净利润；退货冲减收入。</p></div>
        <div class="head-actions">
            <select id="incomeMonth" style="width:150px" onchange="Pages.reloadIncome()">${monthOpts}</select>
        </div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>营收</span><strong>${fmt(revenue)}</strong><p>${month} 已出货订单</p></div>
        <div class="kpi-card"><span>销货成本</span><strong>${fmt(cogs)}</strong><p>出货数量 × 商品成本</p></div>
        <div class="kpi-card"><span>毛利</span><strong style="color:${grossProfit >= 0 ? "var(--green)" : "var(--danger)"}">${fmt(grossProfit)}</strong><p>营收 - 成本</p></div>
        <div class="kpi-card"><span>净利润</span><strong style="color:${netProfit >= 0 ? "var(--green)" : "var(--danger)"}">${fmt(netProfit)}</strong><p>毛利 - 费用 - 退货</p></div>
    </div>
    <div class="table-wrap fin-report">
        <table class="table">
            <tbody>
                <tr class="section-row"><td>营业收入</td><td class="num">${fmt(revenue)}</td></tr>
                <tr><td style="padding-left:34px">销货收入（已出货）</td><td class="num">${fmt(revenue)}</td></tr>
                <tr><td style="padding-left:34px">减：销货退回/折让</td><td class="num" style="color:var(--danger)">-${fmt(returnTotal)}</td></tr>
                <tr class="section-row"><td>营业成本</td><td class="num">${fmt(cogs)}</td></tr>
                <tr><td style="padding-left:34px">销货成本</td><td class="num">${fmt(cogs)}</td></tr>
                <tr class="total-row"><td>营业毛利</td><td class="num">${fmt(grossProfit - returnTotal)}</td></tr>
                <tr class="section-row"><td>营业费用</td><td class="num">${fmt(expenseTotal)}</td></tr>
                ${expenseHtml || `<tr class="indent"><td style="color:var(--muted)">（本月无费用记录）</td><td></td></tr>`}
                <tr class="total-row"><td>净利润</td><td class="num" style="color:${netProfit >= 0 ? "var(--green)" : "var(--danger)"};font-size:16px">${fmt(netProfit)}</td></tr>
            </tbody>
        </table>
    </div>
    <p class="stat-line" style="margin-top:10px">统计口径：${month} 期间已出货订单收入与成本、期间内费用与退货。</p>`;
    renderShell("income_statement", content, "首页 / 账款财务 / 损益表");
};

Pages.reloadIncome = function () {
    incomeMonthSel = document.getElementById("incomeMonth").value;
    render();
};
