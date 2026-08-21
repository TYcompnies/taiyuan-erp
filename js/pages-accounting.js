/* ============================================================
   会计财务页面（pages-accounting.js）
   - 会计科目管理
   - 总分类账（按科目）
   - 试算表（借贷平衡检验）
   - 资产负债表
   ============================================================ */

/* ============================================================
   会计科目管理
   ============================================================ */
Pages.chartAccounts = function () {
    const list = DB.list("chart_accounts").sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const rows = list.map(a => `<tr>
        <td><b>${h(a.code)}</b></td>
        <td>${h(a.name)}</td>
        <td><span class="badge ${a.type === "资产" ? "blue" : a.type === "负债" ? "orange" : a.type === "权益" ? "purple" : "teal"}">${h(a.type)}</span></td>
        <td>${h(a.direction)}方</td>
        <td>${a.is_cash ? badge("货币资金") : "-"}</td>
        <td>${h(a.remark || "-")}</td>
        <td class="action-col">
            <a class="link-btn" href="#/accounting/accounts/${a.id}/edit">编辑</a>
            <button class="link-btn danger" onclick="Pages.deleteChartAccount('${a.id}')">删除</button>
        </td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>会计科目</h1><p>维护会计科目表（资产/负债/权益/损益），供传票分录、总分类账与财务报表使用。</p></div>
        <div class="head-actions"><a class="btn primary" href="#/accounting/accounts/create">+ 新增科目</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>科目总数</span><strong>${list.length}</strong><p>全部会计科目</p></div>
        <div class="kpi-card"><span>货币资金科目</span><strong>${list.filter(a => a.is_cash).length}</strong><p>现金/银行存款类</p></div>
        <div class="kpi-card"><span>损益类科目</span><strong>${list.filter(a => a.type === "损益").length}</strong><p>收入/成本/费用</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>科目编号</th><th>科目名称</th><th>类别</th><th>余额方向</th><th>货币资金</th><th>备注</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="7"><div class="empty-state"><div class="big">📚</div>暂无会计科目</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("chart_accounts", content, "首页 / 账款财务 / 会计科目");
};

Pages.deleteChartAccount = function (id) {
    const a = DB.get("chart_accounts", id);
    if (!a) return;
    // 引用守卫：已有传票使用该科目（含旧名）时禁止删除
    const used = DB.list("vouchers").some(v => (v.lines || []).some(l => l.account === a.name || (ACCT_LEGACY_MAP[l.account] || l.account) === a.name));
    if (used) { toast("已有传票使用该科目，无法删除", "error"); return; }
    confirmModal(`确定要删除会计科目 ${h(a.code)} ${h(a.name)} 吗？`, () => {
        DB.remove("chart_accounts", id);
        toast("已删除", "success");
        render();
    });
};

Pages.chartAccountForm = function (id) {
    const a = id ? DB.get("chart_accounts", id) : null;
    if (id && !a) { toast("找不到该会计科目", "error"); render(); return; }
    const content = `
    <div class="page-head">
        <div><h2>会计科目｜${a ? "编辑" : "新增"}</h2><p>科目类别决定其在资产负债表/损益表中的位置。</p></div>
        <div class="actions"><a class="btn" href="#/accounting/accounts">返回会计科目</a></div>
    </div>
    <form class="form-panel" style="max-width:640px" novalidate onsubmit="Pages.saveChartAccount(event, '${id || ""}')">
        <div class="form-grid section-grid">
            <div class="form-item"><label>科目编号<b>*</b></label><input name="code" value="${a ? h(a.code) : ""}" placeholder="如 1001" required></div>
            <div class="form-item"><label>科目名称<b>*</b></label><input name="name" value="${a ? h(a.name) : ""}" placeholder="如 库存现金" required></div>
            <div class="form-item"><label>科目类别<b>*</b></label>
                <select name="type" required>
                    <option value="">请选择</option>
                    ${["资产", "负债", "权益", "损益"].map(t => `<option ${a && a.type === t ? "selected" : ""}>${t}</option>`).join("")}
                </select></div>
            <div class="form-item"><label>余额方向<b>*</b></label>
                <select name="direction" required>
                    <option value="借" ${a && a.direction === "借" ? "selected" : ""}>借方</option>
                    <option value="贷" ${a && a.direction === "贷" ? "selected" : ""}>贷方</option>
                </select></div>
            <div class="form-item"><label>货币资金科目</label>
                <select name="is_cash">
                    <option value="0" ${!a || !a.is_cash ? "selected" : ""}>否</option>
                    <option value="1" ${a && a.is_cash ? "selected" : ""}>是（现金/银行存款）</option>
                </select></div>
            <div class="form-item"><label>备注</label><input name="remark" value="${a ? h(a.remark || "") : ""}" placeholder="科目说明"></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存科目</button>
            <a class="btn" href="#/accounting/accounts">返回</a>
        </div>
    </form>`;
    renderShell("chart_accounts", content, "首页 / 账款财务 / 会计科目 / " + (a ? "编辑" : "新增"));
};

Pages.saveChartAccount = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    if (!data.code || !data.name) { toast("请填写科目编号与名称", "error"); return; }
    if (!data.type) { toast("请选择科目类别", "error"); return; }
    // 编号/名称唯一性检查
    const dupCode = DB.list("chart_accounts").some(a => a.code === data.code.trim() && a.id !== id);
    if (dupCode) { toast("科目编号已存在", "error"); return; }
    const dupName = DB.list("chart_accounts").some(a => a.name === data.name.trim() && a.id !== id);
    if (dupName) { toast("科目名称已存在", "error"); return; }
    const payload = {
        code: data.code.trim(), name: data.name.trim(), type: data.type,
        direction: data.direction || "借", is_cash: data.is_cash === "1", remark: data.remark || ""
    };
    if (id) {
        const old = DB.get("chart_accounts", id);
        DB.update("chart_accounts", id, payload);
        // 科目改名时同步更新传票分录引用（保持报表口径一致）
        if (old && old.name !== payload.name) {
            DB.list("vouchers").forEach(v => {
                let changed = false;
                const lines = (v.lines || []).map(l => {
                    if (l.account === old.name) { changed = true; return Object.assign({}, l, { account: payload.name }); }
                    return l;
                });
                if (changed) DB.update("vouchers", v.id, { lines });
            });
            toast("科目已更新，传票分录已同步改名", "success");
        } else {
            toast("科目已更新", "success");
        }
    } else {
        DB.insert("chart_accounts", payload);
        toast("会计科目已保存", "success");
    }
    setTimeout(() => { location.hash = "#/accounting/accounts"; }, 300);
};

/* ============================================================
   总分类账
   ============================================================ */
let glMonthSel = "";

Pages.generalLedger = function () {
    const accounts = DB.list("chart_accounts").sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const sel = window.__glAccount || "";
    const month = glMonthSel || Utils.today().slice(0, 7);
    const from = month + "-01";
    const to = month + "-31";
    const acct = accounts.find(a => a.id === sel) || accounts.find(a => a.name === "银行存款") || accounts[0];
    const acctName = acct ? acct.name : "";

    const accOpts = accounts.map(a => `<option value="${a.id}" ${acct && a.id === acct.id ? "selected" : ""}>${h(a.code)} ${h(a.name)}</option>`).join("");
    const monthOpts = monthOptionsHtml(month);

    // 取该科目全部过账分录（含期初累计）
    const entries = [];
    DB.list("vouchers").filter(v => v.status === "已过账").sort((a, b) => (a.date + a.no).localeCompare(b.date + b.no)).forEach(v => {
        (v.lines || []).forEach(l => {
            const std = ACCT_LEGACY_MAP[l.account] || l.account;
            if (std === acctName) entries.push({ no: v.no, date: v.date, source: v.source, source_no: v.source_no, counterparty: v.counterparty, debit: Utils.num(l.debit), credit: Utils.num(l.credit), remark: v.remark });
        });
    });
    const openBal = entries.filter(e => e.date < from).reduce((s, e) => s + e.debit - e.credit, 0);
    let running = openBal;
    const rows = entries.filter(e => e.date >= from && e.date <= to).map(e => {
        running += e.debit - e.credit;
        return `<tr>
            <td>${h(e.date)}</td>
            <td><b>${h(e.no)}</b></td>
            <td>${h(e.source || "-")}${e.source_no ? " " + h(e.source_no) : ""}</td>
            <td>${h(e.counterparty || "-")}</td>
            <td class="num">${e.debit ? fmt(e.debit) : ""}</td>
            <td class="num">${e.credit ? fmt(e.credit) : ""}</td>
            <td class="num" style="font-weight:700">${fmt(Math.abs(running) < 0.005 ? 0 : running)}</td>
        </tr>`;
    }).join("");
    const monthDebit = entries.filter(e => e.date >= from && e.date <= to).reduce((s, e) => s + e.debit, 0);
    const monthCredit = entries.filter(e => e.date >= from && e.date <= to).reduce((s, e) => s + e.credit, 0);

    const content = `
    <div class="page-head">
        <div><h1>总分类账</h1><p>按会计科目汇总已过账传票分录，含期初余额与逐笔余额（本位币 ${COMPANY.baseCurrency}）。</p></div>
        <div class="head-actions">
            <a class="btn ghost" href="#/accounting/trial-balance">试算表</a>
            <a class="btn ghost" href="#/accounting/balance-sheet">资产负债表</a>
        </div>
    </div>
    <div class="filter-bar">
        <div class="form-item"><label>会计科目</label>
            <select onchange="window.__glAccount=this.value;Pages.generalLedger()">${accOpts}</select></div>
        <div class="form-item"><label>月份</label>
            <select onchange="glMonthSel=this.value;Pages.generalLedger()">${monthOpts}</select></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>期初余额</span><strong>${fmt(openBal)}</strong><p>本月前累计（借为正）</p></div>
        <div class="kpi-card"><span>本期借方发生</span><strong>${fmt(monthDebit)}</strong><p>${month} 借方合计</p></div>
        <div class="kpi-card"><span>本期贷方发生</span><strong>${fmt(monthCredit)}</strong><p>${month} 贷方合计</p></div>
        <div class="kpi-card"><span>期末余额</span><strong style="color:${Math.abs(running) < 0.005 ? "" : running > 0 ? "var(--green)" : "var(--danger)"}">${fmt(Math.abs(running) < 0.005 ? 0 : running)}</strong><p>截至 ${month} 末</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>日期</th><th>传票号</th><th>来源</th><th>对象</th><th class="num">借方</th><th class="num">贷方</th><th class="num">余额</th></tr></thead>
            <tbody>
                <tr style="background:var(--bg2,rgba(0,0,0,.03))"><td colspan="4"><b>期初余额</b></td><td></td><td></td><td class="num" style="font-weight:700">${fmt(openBal)}</td></tr>
                ${rows || `<tr><td colspan="7"><div class="empty-state"><div class="big">📒</div>该科目本月无分录</div></td></tr>`}
            </tbody>
            <tfoot>
                <tr><th colspan="4" style="text-align:right">本期合计</th><th class="num">${fmt(monthDebit)}</th><th class="num">${fmt(monthCredit)}</th><th class="num">${fmt(Math.abs(running) < 0.005 ? 0 : running)}</th></tr>
            </tfoot>
        </table>
    </div>`;
    renderShell("general_ledger", content, "首页 / 账款财务 / 总分类账");
};

Pages.glSelect = function (v) { window.__glAccount = v; Pages.generalLedger(); };
Pages.glMonth = function (v) { glMonthSel = v; Pages.generalLedger(); };

/* 月份下拉选项（近 24 个月） */
function monthOptionsHtml(selected) {
    const opts = [];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
        const m = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        opts.push(`<option value="${m}" ${m === selected ? "selected" : ""}>${m}</option>`);
        d.setMonth(d.getMonth() - 1);
    }
    return opts.join("");
}

/* ============================================================
   试算表
   ============================================================ */
let tbMonthSel = "";

Pages.trialBalance = function () {
    const month = tbMonthSel || Utils.today().slice(0, 7);
    const from = month + "-01";
    const to = month + "-31";
    const balances = ACCT.allAccountBalances(to);
    const accounts = DB.list("chart_accounts").sort((a, b) => String(a.code).localeCompare(String(b.code)));

    // 出现在传票但不在科目表中的科目（旧数据兜底）
    const known = new Set(accounts.map(a => a.name));
    const extras = Object.keys(balances).filter(n => !known.has(n));

    const rowOf = (name, type, direction, code) => {
        const bal = balances[name] || { debit: 0, credit: 0 };
        const net = Utils.round(bal.debit - bal.credit);
        return { name, type, direction, code, debit: bal.debit, credit: bal.credit, net };
    };
    const allRows = accounts.map(a => rowOf(a.name, a.type, a.direction, a.code)).concat(extras.map(n => rowOf(n, "未分类", "借", "")));
    const shown = allRows.filter(r => r.debit !== 0 || r.credit !== 0);
    const totalDebit = shown.reduce((s, r) => s + r.debit, 0);
    const totalCredit = shown.reduce((s, r) => s + r.credit, 0);
    const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

    const rows = shown.map(r => `<tr>
        <td>${h(r.code || "-")}</td>
        <td><b>${h(r.name)}</b></td>
        <td>${h(r.type)}</td>
        <td class="num">${r.debit ? fmt(r.debit) : ""}</td>
        <td class="num">${r.credit ? fmt(r.credit) : ""}</td>
        <td class="num" style="font-weight:700">${fmt(Math.abs(r.net) < 0.005 ? 0 : r.net)}</td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>试算表</h1><p>汇总全部已过账传票的借贷发生额与余额，检验借贷是否平衡（截至所选月末）。</p></div>
        <div class="head-actions">
            <a class="btn ghost" href="#/accounting/general-ledger">总分类账</a>
            <a class="btn ghost" href="#/accounting/balance-sheet">资产负债表</a>
        </div>
    </div>
    <div class="filter-bar">
        <div class="form-item"><label>截至月份</label>
            <select onchange="tbMonthSel=this.value;Pages.trialBalance()">${monthOptionsHtml(month)}</select></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>借方总额</span><strong>${fmt(totalDebit)}</strong><p>累计借方发生额</p></div>
        <div class="kpi-card"><span>贷方总额</span><strong>${fmt(totalCredit)}</strong><p>累计贷方发生额</p></div>
        <div class="kpi-card"><span>借贷差额</span><strong style="color:${balanced ? "var(--green)" : "var(--danger)"}">${fmt(Utils.round(totalDebit - totalCredit))}</strong><p>${balanced ? "借贷平衡 ✓" : "借贷不平衡！"}</p></div>
        <div class="kpi-card"><span>有发生额科目数</span><strong>${shown.length}</strong><p>含分录的科目</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>科目编号</th><th>科目名称</th><th>类别</th><th class="num">累计借方</th><th class="num">累计贷方</th><th class="num">余额（借+/贷-）</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6"><div class="empty-state"><div class="big">⚖️</div>暂无过账传票分录</div></td></tr>`}</tbody>
            <tfoot>
                <tr><th colspan="3" style="text-align:right">合计</th><th class="num">${fmt(totalDebit)}</th><th class="num">${fmt(totalCredit)}</th><th class="num" style="color:${balanced ? "var(--green)" : "var(--danger)"}">${fmt(Utils.round(totalDebit - totalCredit))}</th></tr>
            </tfoot>
        </table>
    </div>`;
    renderShell("trial_balance", content, "首页 / 账款财务 / 试算表");
};

Pages.tbMonth = function (v) { tbMonthSel = v; Pages.trialBalance(); };

/* ============================================================
   资产负债表
   ============================================================ */
let bsMonthSel = "";

Pages.balanceSheet = function () {
    const month = bsMonthSel || Utils.today().slice(0, 7);
    const asOf = month + "-31";
    const balances = ACCT.allAccountBalances(asOf);
    const accounts = DB.list("chart_accounts");
    const byName = {};
    accounts.forEach(a => { byName[a.name] = a; });

    const netOf = (name) => Utils.round((balances[name] || { debit: 0, credit: 0 }).debit - (balances[name] || { debit: 0, credit: 0 }).credit);

    // 逐科目归类（余额按 借+/贷- 呈现，再按类别取绝对方向）
    const cats = { assets: [], liabilities: [], equity: [], profit: 0 };
    Object.keys(balances).forEach(name => {
        const meta = byName[name] || { type: "未分类" };
        const net = netOf(name);
        if (Math.abs(net) < 0.005 && !(balances[name].debit || balances[name].credit)) return;
        if (meta.type === "资产") cats.assets.push({ name, amt: net });
        else if (meta.type === "负债") cats.liabilities.push({ name, amt: -net }); // 贷余为正
        else if (meta.type === "权益") cats.equity.push({ name, amt: -net });
        else if (meta.type === "损益") cats.profit += -net; // 收入贷方为正利润，成本费用借方为负
    });
    const totalAssets = cats.assets.reduce((s, a) => s + a.amt, 0);
    const totalLiab = cats.liabilities.reduce((s, a) => s + a.amt, 0);
    const totalEquity = cats.equity.reduce((s, a) => s + a.amt, 0) + Utils.round(cats.profit);
    const diff = Utils.round(totalAssets - totalLiab - totalEquity);
    const balanced = Math.abs(diff) < 0.01;

    const assetRows = cats.assets.map(a => `<tr><td>${h(a.name)}</td><td class="num">${fmt(a.amt)}</td></tr>`).join("");
    const liabRows = cats.liabilities.map(a => `<tr><td>${h(a.name)}</td><td class="num">${fmt(a.amt)}</td></tr>`).join("");
    const eqRows = cats.equity.map(a => `<tr><td>${h(a.name)}</td><td class="num">${fmt(a.amt)}</td></tr>`).join("")
        + `<tr><td>本年利润（损益累计）</td><td class="num">${fmt(Utils.round(cats.profit))}</td></tr>`;

    const content = `
    <div class="page-head">
        <div><h1>资产负债表</h1><p>依已过账传票编制：资产 = 负债 + 权益（含损益累计）。应收/应付/存货已与业务资料对齐（本位币 ${COMPANY.baseCurrency}）。</p></div>
        <div class="head-actions">
            <a class="btn ghost" href="#/accounting/general-ledger">总分类账</a>
            <a class="btn ghost" href="#/accounting/trial-balance">试算表</a>
        </div>
    </div>
    <div class="filter-bar">
        <div class="form-item"><label>截至月份</label>
            <select onchange="bsMonthSel=this.value;Pages.balanceSheet()">${monthOptionsHtml(month)}</select></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>资产总计</span><strong>${fmt(totalAssets)}</strong><p>货币资金+应收+存货+其他</p></div>
        <div class="kpi-card"><span>负债总计</span><strong style="color:var(--danger)">${fmt(totalLiab)}</strong><p>应付+税费+借款</p></div>
        <div class="kpi-card"><span>权益总计</span><strong>${fmt(totalEquity)}</strong><p>实收资本+未分配利润+损益累计</p></div>
        <div class="kpi-card"><span>平衡检验</span><strong style="color:${balanced ? "var(--green)" : "var(--danger)"}">${balanced ? "平衡 ✓" : "差额 " + fmt(diff)}</strong><p>资产 - 负债 - 权益</p></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="table-wrap list-scroll">
            <table class="table">
                <thead><tr><th>资产</th><th class="num">金额</th></tr></thead>
                <tbody>${assetRows || `<tr><td colspan="2"><div class="empty-state"><div class="big">🏦</div>暂无资产科目余额</div></td></tr>`}</tbody>
                <tfoot><tr><th>资产总计</th><th class="num">${fmt(totalAssets)}</th></tr></tfoot>
            </table>
        </div>
        <div class="table-wrap list-scroll">
            <table class="table">
                <thead><tr><th>负债及权益</th><th class="num">金额</th></tr></thead>
                <tbody>
                    <tr><td colspan="2" style="background:var(--bg2,rgba(0,0,0,.03));font-weight:700">负债</td></tr>
                    ${liabRows || `<tr><td colspan="2" class="muted" style="padding:6px 12px">（无负债科目余额）</td></tr>`}
                    <tr><td colspan="2" style="background:var(--bg2,rgba(0,0,0,.03));font-weight:700">权益</td></tr>
                    ${eqRows || `<tr><td colspan="2" class="muted" style="padding:6px 12px">（无权益科目余额）</td></tr>`}
                </tbody>
                <tfoot><tr><th>负债及权益总计</th><th class="num">${fmt(Utils.round(totalLiab + totalEquity))}</th></tr></tfoot>
            </table>
        </div>
    </div>`;
    renderShell("balance_sheet", content, "首页 / 账款财务 / 资产负债表");
};

Pages.bsMonth = function (v) { bsMonthSel = v; Pages.balanceSheet(); };
