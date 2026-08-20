/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 核心应用
   路由 / 布局 / 登录 / 仪表板 / 日常流程
   ============================================================ */
"use strict";

const h = (v) => Utils.esc(v);
const fmt = (v, cur) => Utils.money(v, cur);
const curSymbol = (code) => { const c = DB.currencyByCode(code); return c ? c.symbol + " " : ""; };

/* ---------------- 本位币（人民币）换算 ---------------- */
// 将任意币别金额折合本位币（人民币）；币别缺失或汇率无效时按 1 处理
const toCNY = (amount, code) => {
    const cu = DB.currencyByCode(code);
    const rate = cu && Utils.num(cu.rate) > 0 ? Utils.num(cu.rate) : 1;
    return Utils.num(amount) * rate;
};
// 商品成本折合本位币（按商品采购币别汇率）
const itemCostCNY = (it) => it ? toCNY(it.cost, it.purchase_currency) : 0;

/* ---------------- 人民币金额大写（大陆单据用） ---------------- */
function rmbUpper(n) {
    const num = Utils.num(n);
    if (num === 0) return "零元整";
    const neg = num < 0;
    const abs = Math.abs(num);
    const cn = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
    const unit = ["", "拾", "佰", "仟"];
    const big = ["", "万", "亿", "万亿"];
    let s = "";
    const groups = [];
    let x = Math.floor(abs);
    if (x === 0) s = "零";
    while (x > 0) { groups.unshift(x % 10000); x = Math.floor(x / 10000); }
    let needZero = false;
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g === 0) { needZero = true; continue; }
        const str = String(g).padStart(4, "0");
        let gs = "", zf = false;
        for (let i = 0; i < 4; i++) {
            const d = parseInt(str[i], 10);
            if (d === 0) { zf = true; }
            else {
                if (zf && (gs !== "" || s !== "")) gs += "零";
                gs += cn[d] + unit[3 - i];
                zf = false;
            }
        }
        if (needZero) s += "零";
        s += gs + big[groups.length - 1 - gi];
        needZero = false;
    }
    const dec = Math.round((abs - Math.floor(abs)) * 100);
    const jiao = Math.floor(dec / 10), fen = dec % 10;
    let r = s + "元";
    if (jiao === 0 && fen === 0) r += "整";
    else {
        if (jiao > 0) r += cn[jiao] + "角";
        else if (fen > 0) r += "零";
        if (fen > 0) r += cn[fen] + "分";
    }
    return (neg ? "负" : "") + r;
}

/* ---------------- 单据打印（大陆 A4 格式） ---------------- */
const PRINT_CSS = `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:"Microsoft YaHei","PingFang SC","SimSun",sans-serif; color:#111; background:#fff; padding:34px 40px; }
    .doc-head { text-align:center; }
    .doc-head .company { font-size:19px; font-weight:700; letter-spacing:3px; }
    .doc-head .en { font-size:10.5px; color:#666; letter-spacing:1.5px; margin-top:2px; }
    .doc-title { text-align:center; font-size:21px; font-weight:700; letter-spacing:12px; margin:10px 0 14px; padding-bottom:8px; border-bottom:2.5px solid #111; }
    .meta { display:flex; flex-wrap:wrap; row-gap:5px; column-gap:28px; font-size:12.5px; margin-bottom:10px; line-height:1.7; }
    .meta b { font-weight:600; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border:1px solid #111; padding:5px 7px; }
    th { background:#f2f2f2; font-weight:600; text-align:center; }
    td.c, th.c { text-align:center; }
    td.r, th.r { text-align:right; }
    .totals { margin-top:12px; font-size:13px; line-height:2; }
    .totals .up { font-weight:700; }
    .remark { margin-top:8px; font-size:12px; min-height:20px; }
    .sign { margin-top:32px; display:flex; justify-content:space-between; font-size:12.5px; }
    .sign div { width:31%; }
    .sign .line { border-bottom:1px solid #111; height:26px; margin-bottom:3px; }
    .foot-note { margin-top:24px; text-align:center; font-size:10px; color:#888; }
    @page { size:A4; margin:10mm; }
    @media print { body { padding:0; } }
`;

function printDoc(title, bodyHtml) {
    const w = window.open("", "_blank", "width=900,height=1150");
    if (!w) { toast("浏览器拦截了打印窗口，请允许弹出窗口后重试", "error"); return; }
    w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${h(title)}</title><style>${PRINT_CSS}</style></head><body>${bodyHtml}<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},300);});<\/script></body></html>`);
    w.document.close();
}

/* ---------------- 权限检查 ---------------- */
function can(perm) {
    const u = DB.currentUser();
    if (!u) return false;
    const role = DB.get("roles", u.role_id);
    if (!role) return false;
    return role.permissions.indexOf(perm) >= 0;
}

/* ---------------- 导航 ---------------- */
function go(path) {
    location.hash = "#" + path;
}

/* ---------------- Toast ---------------- */
function toast(msg, type) {
    const wrap = document.getElementById("toastWrap");
    if (!wrap) return;
    const t = document.createElement("div");
    t.className = "toast " + (type || "");
    t.innerHTML = h(msg);
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2800);
    setTimeout(() => t.remove(), 3200);
}

/* ---------------- 确认弹窗 ---------------- */
function confirmModal(msg, onOk, title) {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>${h(title || "操作确认")}</h3><button class="icon-btn" onclick="this.closest('.modal-mask').remove()">✕</button></div>
        <div class="modal-body">${h(msg)}</div>
        <div class="modal-foot">
            <button class="btn" onclick="this.closest('.modal-mask').remove()">取消</button>
            <button class="btn danger" id="confirmOkBtn">确定</button>
        </div>
    </div>`;
    document.body.appendChild(mask);
    mask.querySelector("#confirmOkBtn").onclick = () => { mask.remove(); onOk(); };
    mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
}

/* ---------------- 通用表单数据读取 ---------------- */
function formData(formId) {
    const form = document.getElementById(formId);
    if (!form) return {};
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = v; });
    return data;
}

/* ---------------- 状态徽章 ---------------- */
function badge(status) {
    const map = {
        "未出货": "blue", "已出货": "green", "已取消": "red",
        "draft": "orange", "shipped": "green", "received": "green", "cancelled": "red",
        "已进货": "green", "未进货": "orange",
        "已收款": "green", "未收款": "orange", "部分收款": "blue",
        "已付清": "green", "部分付款": "orange", "未付款": "red",
        "已开": "green", "未开": "gray", "作废": "red", "折让": "purple", "退回": "red",
        "已过账": "green", "未过账": "orange",
        "启用": "green", "停用": "red"
    };
    const c = map[status] || "gray";
    return `<span class="badge ${c}">${h(status)}</span>`;
}
function soStatusBadge(st) {
    if (st === "shipped") return `<span class="badge green">已出货</span>`;
    if (st === "cancelled") return `<span class="badge red">已取消</span>`;
    return `<span class="badge orange">未出货</span>`;
}
function poStatusBadge(st) {
    if (st === "received") return `<span class="badge green">已进货</span>`;
    if (st === "cancelled") return `<span class="badge red">已取消</span>`;
    return `<span class="badge orange">未进货</span>`;
}

/* ---------------- 菜单定义 ---------------- */
const MENU = [
    {
        group: "首页", key: "dashboard", items: [
            { code: "dashboard", label: "Dashboard", hash: "#/dashboard", perm: "dashboard.view" },
            { code: "daily_workflow", label: "日常流程", hash: "#/daily-workflow", perm: "workflow.view" }
        ]
    },
    {
        group: "日常作业", key: "daily", items: [
            { code: "sales_orders", label: "销货订单", hash: "#/sales-orders", perm: "sales.view" },
            { code: "shipments", label: "出货单", hash: "#/shipments", perm: "shipment.view" },
            { code: "purchase_orders", label: "采购单", hash: "#/purchase-orders", perm: "purchase.view" },
            { code: "inventory_adjust", label: "库存调整", hash: "#/inventory/inventory_adjust", perm: "inventory.view" },
            { code: "sales_returns", label: "销货退回/折让", hash: "#/sales-returns", perm: "sales_return.view" },
            { code: "purchase_returns", label: "采购退回/折让", hash: "#/purchase-returns", perm: "purchase_return.view" }
        ]
    },
    {
        group: "账款财务", key: "finance", items: [
            { code: "accounts_receivable", label: "应收账款", hash: "#/accounting/accounts-receivable", perm: "finance.ar" },
            { code: "accounts_payable", label: "应付账款", hash: "#/accounting/accounts-payable", perm: "finance.ap" },
            { code: "expenses", label: "费用支出", hash: "#/expenses", perm: "finance.expense" },
            { code: "vouchers", label: "传票作业", hash: "#/accounting/vouchers", perm: "finance.voucher" },
            { code: "income_statement", label: "损益表", hash: "#/accounting/income-statement", perm: "finance.income" }
        ]
    },
    {
        group: "基本资料", key: "master", items: [
            { code: "items", label: "商品主档", hash: "#/master/items", perm: "master.item" },
            { code: "customers", label: "客户主档", hash: "#/master/customers", perm: "master.customer" },
            { code: "suppliers", label: "供应商主档", hash: "#/master/suppliers", perm: "master.supplier" },
            { code: "warehouses", label: "仓库主档", hash: "#/master/warehouses", perm: "master.warehouse" },
            { code: "units", label: "单位管理", hash: "#/master/units", perm: "master.basic" },
            { code: "currencies", label: "币别管理", hash: "#/master/currencies", perm: "master.basic" },
            { code: "categories", label: "商品分类", hash: "#/master/categories", perm: "master.basic" },
            { code: "shipping_methods", label: "物流方式", hash: "#/master/shipping_methods", perm: "master.basic" },
            { code: "payment_terms", label: "付款条件", hash: "#/master/payment_terms", perm: "master.basic" }
        ]
    },
    {
        group: "报表查询", key: "reports", items: [
            { code: "inventory_overview", label: "库存总览", hash: "#/inventory/inventory_overview", perm: "report.inventory" },
            { code: "inventory_safety", label: "安全库存", hash: "#/inventory/inventory_safety", perm: "report.safety" },
            { code: "report_income", label: "损益表", hash: "#/accounting/income-statement", perm: "finance.income" }
        ]
    },
    {
        group: "系统设置", key: "system", items: [
            { code: "migration_center", label: "Excel 导入中心", hash: "#/tools/migration-center", perm: "system.migration" },
            { code: "system_backup", label: "系统备份", hash: "#/tools/system-backup", perm: "system.backup" },
            { code: "users", label: "用户管理", hash: "#/users", perm: "system.user" },
            { code: "roles", label: "角色管理", hash: "#/roles", perm: "system.role" },
            { code: "permissions", label: "权限管理", hash: "#/permissions", perm: "system.permission" }
        ]
    }
];

/* ---------------- 布局 ---------------- */
function renderShell(activeCode, contentHtml, breadcrumb) {
    const u = DB.currentUser();
    const role = u ? DB.get("roles", u.role_id) : null;
    const roleName = role ? role.name : "";
    const dark = localStorage.getItem("taiyuan_erp_dark") === "1";

    let menuHtml = "";
    MENU.forEach(g => {
        const items = g.items.filter(it => can(it.perm));
        if (!items.length) return;
        const groupOpen = items.some(it => it.code === activeCode);
        const links = items.map(it =>
            `<a class="menu-link ${(it.code === activeCode || (it.code === "report_income" && activeCode === "income_statement")) ? "active" : ""}" data-code="${it.code}" href="${it.hash}">${it.label}</a>`
        ).join("");
        menuHtml += `<div class="menu-group ${groupOpen ? "open" : ""}">
            <button class="menu-main" type="button" onclick="this.parentElement.classList.toggle('open')">
                <span>${g.group}</span><b>▾</b>
            </button>
            <div class="submenu">${links}</div>
        </div>`;
    });

    document.body.classList.toggle("dark", dark);
    const shell = document.getElementById("app");
    shell.innerHTML = `<div class="erp-shell">
    <aside class="sidebar">
        <div class="brand">
            <div class="brand-logo">${COMPANY.logoText}</div>
            <div>
                <div class="brand-title">${COMPANY.short}</div>
                <div class="brand-subtitle">ERP SYSTEM</div>
            </div>
        </div>
        <div class="side-search"><input type="text" placeholder="搜索功能..." id="sideSearch"></div>
        <nav class="menu">${menuHtml}</nav>
    </aside>
    <main class="main">
        <header class="topbar">
            <button class="icon-btn" onclick="App.toggleSidebar()">☰</button>
            <div class="top-title">
                <strong>${COMPANY.short} ERP</strong>
                <span>企业运营管理平台</span>
            </div>
            <div class="top-actions">
                <button class="icon-btn" onclick="App.toggleDark()" title="切换深色/浅色模式">${dark ? "☀" : "🌙"}</button>
                <span class="user-pill">${h(u ? u.name : "")}｜${h(roleName)}</span>
                <a class="logout" href="javascript:void(0)" onclick="App.logout()">登出</a>
            </div>
        </header>
        <section class="breadcrumb">${breadcrumb || ""}</section>
        <section class="content">${contentHtml}</section>
    </main>
    </div>`;

    // 菜单搜索过滤
    const s = document.getElementById("sideSearch");
    if (s) s.addEventListener("input", () => {
        const q = s.value.trim().toLowerCase();
        document.querySelectorAll(".menu-link").forEach(a => {
            const show = !q || a.textContent.toLowerCase().indexOf(q) >= 0 || (a.dataset.code || "").toLowerCase().indexOf(q) >= 0;
            a.style.display = show ? "" : "none";
        });
    });
}

/* ---------------- 登录 ---------------- */
function renderLogin(err) {
    const app = document.getElementById("app");
    document.body.className = "login-body";
    document.body.classList.toggle("dark", localStorage.getItem("taiyuan_erp_dark") === "1");
    app.innerHTML = `<div class="login-card">
        <div class="login-brand">${COMPANY.name}</div>
        <div class="login-sub">${COMPANY.en}</div>
        <form id="loginForm" onsubmit="App.doLogin(event)">
            <label>账号</label>
            <input name="username" required autocomplete="off" placeholder="请输入账号">
            <label>密码</label>
            <input name="password" type="password" required placeholder="请输入密码">
            <button type="submit">登录系统</button>
        </form>
        <div class="login-err" id="loginErr" style="${err ? "display:block" : ""}">${h(err || "")}</div>
        <div class="login-hint">默认：admin / admin123</div>
    </div>`;
}

const App = {
    doLogin(e) {
        e.preventDefault();
        const fd = new FormData(e.target);
        const username = fd.get("username").trim();
        const password = fd.get("password");
        const u = DB.find("users", x => x.username === username && x.password === password);
        if (!u) {
            renderLogin("账号或密码错误，请重新输入");
            return;
        }
        if (u.status !== "启用") {
            renderLogin("该账号已停用，请联系系统管理员");
            return;
        }
        DB.setSession({ user_id: u.id, login_at: Utils.now() });
        location.hash = "#/dashboard";
        render();
    },
    logout() {
        DB.clearSession();
        location.hash = "#/login";
        render();
    },
    toggleSidebar() {
        const c = document.body.classList.toggle("sidebar-collapsed");
        localStorage.setItem("taiyuan_erp_sidebar", c ? "1" : "0");
    },
    toggleDark() {
        const d = document.body.classList.toggle("dark");
        localStorage.setItem("taiyuan_erp_dark", d ? "1" : "0");
        render();
    }
};

/* ---------------- 仪表板 ---------------- */
function renderDashboard() {
    const orders = DB.list("sales_orders");
    const pos = DB.list("purchase_orders");
    const items = DB.list("items");
    const today = Utils.today();
    const month = Utils.monthStart();

    const pendingShip = orders.filter(o => o.status === "draft");
    const pendingReceive = pos.filter(o => o.status === "draft");
    const lowStock = items.filter(i => !i.disabled && DB.totalStock(i.id) < i.safety_stock && DB.totalStock(i.id) >= 0);
    const negStock = items.filter(i => !i.disabled && DB.totalStock(i.id) < 0);
    const shippedAll = orders.filter(o => o.status === "shipped");
    const costMissingCount = shippedAll.filter(o => o.lines.some(l => {
        const it = DB.get("items", l.item_id);
        return !it || !it.cost || it.cost <= 0;
    })).length;
    const curMissingCount = DB.list("currencies").filter(c => !c.is_base && (!c.rate || c.rate <= 0)).length;

    // 本月损益（本位币口径：外币乘汇率、成本乘销售→库存换算率、冲回退货成本，与损益表一致）
    // 联动：收入按「出货日期」归属，与损益表口径一致（跨月订单以实际出货月份计入）
    const shipIds = new Set(DB.list("shipments").filter(s => s.ship_date >= month).map(s => s.sales_order_id));
    const shipped = orders.filter(o => o.status === "shipped" && shipIds.has(o.id));
    const revenue = shipped.reduce((s, o) => s + toCNY(o.invoice_amount, o.currency), 0);
    const cogs = shipped.reduce((s, o) => s + o.lines.reduce((a, l) => {
        const it = DB.get("items", l.item_id);
        const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
        return a + Utils.num(l.qty) * rate * itemCostCNY(it);
    }, 0), 0);
    const monthReturns = DB.list("sales_returns").filter(r => r.return_date >= month);
    const returnTotal = monthReturns.reduce((s, r) => {
        const so = DB.get("sales_orders", r.sales_order_id);
        return s + toCNY(r.total_amount, so ? so.currency : "");
    }, 0);
    const returnCost = monthReturns.reduce((s, r) => s + Utils.num(r.cost_reversal), 0);
    const expenses = DB.list("expenses").filter(e => e.date >= month).reduce((s, e) => s + Utils.num(e.amount), 0);
    const profit = Utils.round((revenue - returnTotal) - (cogs - returnCost) - expenses);

    // 应收应付（扣除已收/已付与退货/退回冲销；外币折本位币，与应收账款/应付账款页 KPI 口径一致）
    const arReturnMap = {};
    DB.list("sales_returns").filter(r => r.offset_receivable).forEach(r => {
        arReturnMap[r.sales_order_id] = (arReturnMap[r.sales_order_id] || 0) + Utils.num(r.total_amount);
    });
    const shippedOrders = orders.filter(o => o.status === "shipped");
    const arUnpaid = shippedOrders
        .reduce((s, o) => s + toCNY(Math.max(Utils.num(o.invoice_amount) - Utils.num(o.received_amount) - (arReturnMap[o.id] || 0), 0), o.currency), 0);
    const arBalance = shippedOrders
        .reduce((s, o) => s + toCNY(Utils.num(o.invoice_amount), o.currency), 0);
    const apReturnMap = {};
    DB.list("purchase_returns").filter(r => r.offset_payable).forEach(r => {
        apReturnMap[r.purchase_order_id] = (apReturnMap[r.purchase_order_id] || 0) + Utils.num(r.amount);
    });
    const receivedPos = pos.filter(o => o.status === "received");
    const apUnpaid = receivedPos
        .reduce((s, o) => s + toCNY(Math.max(Utils.num(o.amount) - Utils.num(o.paid_amount) - (apReturnMap[o.id] || 0), 0), o.currency), 0);
    const apBalance = receivedPos.reduce((s, o) => s + toCNY(Utils.num(o.amount), o.currency), 0);
    const stockValue = items.reduce((s, i) => s + DB.stockValue(i.id), 0);
    const unposted = DB.list("vouchers").filter(v => v.status === "未过账").length;
    const lastBackup = DB.list("backups").sort((a, b) => b.date.localeCompare(a.date))[0];
    const daysSinceBackup = lastBackup ? Math.max(0, Math.round((new Date(today) - new Date(lastBackup.date.slice(0, 10))) / 86400000)) : "-";

    // 上线检核
    const checks = [
        { label: "仓库设定", count: DB.list("warehouses").length + "笔", unit: "笔", status: "ok", link: "#/master/warehouses", desc: "至少需要一个可用仓库，采购进货、销货出货与库存调整才有落点。" },
        { label: "客户资料", count: DB.list("customers").length + "笔", unit: "笔", status: "ok", link: "#/master/customers", desc: "销货订单需要客户；散客与平台订单可使用 WALKIN 客户并填实际收件资料。" },
        { label: "供应商资料", count: DB.list("suppliers").length + "笔", unit: "笔", status: "ok", link: "#/master/suppliers", desc: "采购单需要供应商，进货后才能形成应付账款。" },
        { label: "商品成本缺漏", count: items.filter(i => !i.disabled && (!i.cost || i.cost <= 0)).length + "笔", unit: "笔", status: "ok", link: "#/master/items", desc: "销货成本会进损益表；商品成本不可空白或为 0。" },
        { label: "商品币别缺漏", count: items.filter(i => !i.disabled && !i.purchase_currency).length + "笔", unit: "笔", status: "warning", link: "#/master/items", desc: "商品采购币别会影响库存价值与销货成本人民币换算。" },
        { label: "商品单位缺漏", count: items.filter(i => !i.disabled && (!i.sales_unit || !i.purchase_unit)).length + "笔", unit: "笔", status: "warning", link: "#/master/items", desc: "采购、销售、库存单位会影响拆包与库存异动判读。" },
        { label: "负库存", count: negStock.length + "笔", unit: "笔", status: negStock.length ? "blocker" : "ok", link: "#/inventory/inventory_overview", desc: "负库存代表出货、拆包或盘点流程有资料需要修正。" },
        { label: "已出货成本缺漏", count: costMissingCount + "笔", unit: "笔", status: costMissingCount ? "warning" : "ok", link: "#/sales-orders", desc: "已出货订单若没有成本，损益表的销货成本会低估。" },
        { label: "外币汇率缺漏", count: curMissingCount + "笔", unit: "笔", status: curMissingCount ? "warning" : "ok", link: "#/master/currencies", desc: "外币单据与商品成本都需要汇率，才能换算人民币库存与损益。" },
        { label: "低库存", count: lowStock.length + "笔", unit: "笔", status: lowStock.length ? "warning" : "ok", link: "#/inventory/inventory_overview", desc: "低于安全库存的品项，需要评估是否采购。" },
        { label: "待出货订单", count: pendingShip.length + "笔", unit: "笔", status: pendingShip.length ? "warning" : "ok", link: "#/sales-orders", desc: "销货订单完成出货后才会正式扣库存并形成应收。" },
        { label: "待进货采购", count: pendingReceive.length + "笔", unit: "笔", status: pendingReceive.length ? "warning" : "ok", link: "#/purchase-orders", desc: "采购单进货后才会增加库存并形成应付。" },
        { label: "未收应收", count: fmt(arUnpaid), unit: "元", status: arUnpaid ? "warning" : "ok", link: "#/accounting/accounts-receivable", desc: "出货后的未收款要在应收账款追踪。" },
        { label: "未付应付", count: fmt(apUnpaid), unit: "元", status: apUnpaid ? "warning" : "ok", link: "#/accounting/accounts-payable", desc: "进货后的未付款要在应付账款追踪。" },
        { label: "待切传票", count: unposted + "笔", unit: "笔", status: unposted ? "warning" : "ok", link: "#/accounting/vouchers", desc: "收付款与费用传票应定期切传票，后续财务报表才完整。" },
        { label: "系统备份", count: (daysSinceBackup === "-" ? "-" : daysSinceBackup + "天"), unit: "", status: "warning", link: "#/tools/system-backup", desc: "正式使用前建议定期备份，降低数据遗失风险。" }
    ];
    const blockerCount = checks.filter(c => c.status === "blocker").length;
    const warnCount = checks.filter(c => c.status === "warning").length;
    const score = Math.max(0, Math.round(100 - blockerCount * 12 - warnCount * 3));

    const checkHtml = checks.map(c =>
        `<a class="launch-check ${c.status}" href="${c.link}">
            <div><span class="status-dot"></span><strong>${c.label}</strong></div>
            <b>${c.count}${c.unit ? `<small>${c.unit}</small>` : ""}</b>
            <p>${c.desc}</p>
        </a>`).join("");

    const pendingShipHtml = pendingShip.slice(0, 6).map(o => {
        const cu = DB.get("customers", o.customer_id);
        return `<a href="#/sales-orders/${o.id}"><b>${h(o.no)}</b><span>${h(cu ? cu.name : "")}</span><em>${fmt(o.invoice_amount)}</em></a>`;
    }).join("") || `<p class="empty" style="padding:14px 18px;color:var(--muted);font-size:12.5px">没有待出货订单</p>`;

    const pendingReceiveHtml = pendingReceive.slice(0, 6).map(o => {
        const sp = DB.get("suppliers", o.supplier_id);
        return `<a href="#/purchase-orders/${o.id}/edit"><b>${h(o.no)}</b><span>${h(sp ? sp.name : "")}</span><em>${fmt(o.amount)}</em></a>`;
    }).join("") || `<p class="empty" style="padding:14px 18px;color:var(--muted);font-size:12.5px">没有待进货采购单</p>`;

    const lowStockHtml = lowStock.slice(0, 8).map(i =>
        `<a href="#/inventory/inventory_overview"><b>${h(i.code)}</b><span>${h(i.name)}</span><em>${DB.totalStock(i.id)} / ${i.safety_stock}</em></a>`
    ).join("");

    const cleanHtml = `<h3>商品成本缺漏</h3>` +
        (items.filter(i => !i.disabled && (!i.cost || i.cost <= 0)).length ? items.filter(i => !i.disabled && (!i.cost || i.cost <= 0)).map(i => `<p><a href="#/master/items/${i.id}/edit">${h(i.code)} - ${h(i.name)}</a></p>`).join("") : `<p class="empty">没有成本缺漏的商品。</p>`) +
        `<h3>商品采购币别缺漏</h3>` +
        (items.filter(i => !i.disabled && !i.purchase_currency).length ? items.filter(i => !i.disabled && !i.purchase_currency).map(i => `<p><a href="#/master/items/${i.id}/edit">${h(i.code)} - ${h(i.name)}</a></p>`).join("") : `<p class="empty">没有币别缺漏。</p>`) +
        `<h3>负库存</h3>` +
        (negStock.length ? negStock.slice(0, 8).map(i => `<p><a href="#/inventory/inventory_overview">${h(i.code)} - ${h(i.name)}：${DB.totalStock(i.id)}</a></p>`).join("") : `<p class="empty">没有负库存商品。</p>`) +
        `<h3>未过账传票</h3>` +
        (unposted ? DB.list("vouchers").filter(v => v.status === "未过账").map(v => `<p><a href="#/accounting/vouchers">${h(v.no)} - ${h(v.source_no || "")} - ${fmt(v.lines.reduce((s, l) => s + Utils.num(l.debit), 0))}</a></p>`).join("") : `<p class="empty">没有未过账传票。</p>`);

    const content = `
    <div class="page-head">
        <div>
            <h1>上线检核仪表板</h1>
            <p>把订单、采购、出货、库存、账款与损益串起来检查；有阻挡项先处理，避免上线后资料不好追。</p>
        </div>
        <div class="head-actions">
            <a class="btn primary" href="#/daily-workflow">日常流程</a>
            <a class="btn ghost" href="#/purchase-orders/create">新增采购单</a>
            <a class="btn primary" href="#/sales-orders/create">新增销货订单</a>
            <a class="btn ghost" href="#/inventory/inventory_adjust">拆包/组包</a>
            <a class="btn ghost" href="#/accounting/income-statement">损益表</a>
        </div>
    </div>

    <section class="launch-hero">
        <div class="launch-score-card">
            <div class="score-ring" style="--score:${score}"><span>${score}</span><small>/100</small></div>
            <div>
                <p class="eyebrow">ERP 完整度</p>
                <h2>${score >= 80 ? "资料相当完整" : score >= 50 ? "需要先修正关键资料" : "请优先处理阻挡项"}</h2>
                <p>阻挡项 ${blockerCount} 笔，提醒项 ${warnCount} 笔。这个分数只看目前资料完整度，不代表流程不能继续测试。</p>
            </div>
        </div>
        <div class="ops-flow-panel">
            <p class="eyebrow">建议日常流程</p>
            <div class="flow-steps">
                <span>采购单</span><b>→</b><span>进货入库 / 应付</span><b>→</b><span>销货订单</span><b>→</b><span>出货扣库存 / 应收</span><b>→</b><span>收付款 / 传票 / 损益</span>
            </div>
        </div>
    </section>

    <section class="launch-check-grid">${checkHtml}</section>

    <section class="kpi-grid">
        <div class="kpi-card"><span>待进货采购</span><strong>${pendingReceive.length}</strong><p>确认后仍未进货</p></div>
        <div class="kpi-card"><span>待出货订单</span><strong>${pendingShip.length}</strong><p>订单尚未扣库存</p></div>
        <div class="kpi-card"><span>低库存商品</span><strong>${lowStock.length}</strong><p>低于安全库存</p></div>
        <div class="kpi-card"><span>本月损益</span><strong>${fmt(profit)}</strong><p>净营收 - 销货成本净额 - 费用</p></div>
    </section>

    <section class="launch-section-grid">
        <div class="panel">
            <div class="panel-title"><h2>本月损益摘要</h2><a href="#/accounting/income-statement">查看损益表</a></div>
            <div class="mini-metrics">
                <div><span>营收</span><strong>${fmt(revenue)}</strong></div>
                <div><span>销货成本</span><strong>${fmt(cogs)}</strong></div>
                <div><span>费用</span><strong>${fmt(expenses)}</strong></div>
                <div><span>库存价值</span><strong>${fmt(stockValue)}</strong></div>
            </div>
        </div>
        <div class="panel">
            <div class="panel-title"><h2>账款状态（本位币）</h2><a href="#/accounting/accounts-receivable">查看应收应付</a></div>
            <div class="mini-metrics">
                <div><span>未收应收</span><strong>${fmt(arUnpaid)}</strong></div>
                <div><span>未付应付</span><strong>${fmt(apUnpaid)}</strong></div>
                <div><span>应收余额</span><strong>${fmt(arBalance)}</strong></div>
                <div><span>应付余额</span><strong>${fmt(apBalance)}</strong></div>
            </div>
        </div>
        <div class="panel">
            <div class="panel-title"><h2>待出货订单</h2><a href="#/sales-orders">全部订单</a></div>
            <div class="ops-list">${pendingShipHtml}</div>
        </div>
        <div class="panel">
            <div class="panel-title"><h2>待进货采购</h2><a href="#/purchase-orders">全部采购</a></div>
            <div class="ops-list">${pendingReceiveHtml}</div>
        </div>
        <div class="panel">
            <div class="panel-title"><h2>低库存商品</h2><a href="#/inventory/inventory_overview">库存总览</a></div>
            <div class="ops-list">${lowStockHtml || `<p class="empty" style="padding:14px 18px;color:var(--muted);font-size:12.5px">没有低库存商品</p>`}</div>
        </div>
        <div class="panel">
            <div class="panel-title"><h2>上线待处理清单</h2><span style="font-size:12px;color:var(--muted)">优先处理成本、汇率、负库存</span></div>
            <div class="cleanup-list">${cleanHtml}</div>
        </div>
    </section>`;

    renderShell("dashboard", content, "首页 / ERP");
}

/* ---------------- 日常流程 ---------------- */
function renderDailyWorkflow() {
    const flows = [
        { icon: "🛒", title: "新增采购单", desc: "向供应商下单，进货后增加库存并形成应付账款。", hash: "#/purchase-orders/create", perm: "purchase.create" },
        { icon: "📦", title: "进货入库", desc: "采购单到货后执行进货入库，更新库存。", hash: "#/purchase-orders", perm: "purchase.receive" },
        { icon: "🧾", title: "新增销货订单", desc: "建立销售订单，记录客户、商品与售价。", hash: "#/sales-orders/create", perm: "sales.create" },
        { icon: "🚚", title: "出货扣库存", desc: "订单出货：扣减库存、锁定成本并建立出货单。", hash: "#/sales-orders", perm: "sales.ship" },
        { icon: "🏷️", title: "库存调整", desc: "盘点差异、拆包/组包等库存异动。", hash: "#/inventory/inventory_adjust", perm: "inventory.adjust" },
        { icon: "↩️", title: "销货退回/折让", desc: "客户退货或折让，回冲应收并增加库存。", hash: "#/sales-returns/create", perm: "sales_return.view" },
        { icon: "💳", title: "费用支出", desc: "登记房租、物流、平台费等支出。", hash: "#/expenses/create", perm: "finance.expense" },
        { icon: "📒", title: "传票作业", desc: "收付款与费用切传票，形成财务报表。", hash: "#/accounting/vouchers/create", perm: "finance.voucher" },
        { icon: "📊", title: "损益表", desc: "查看收入、成本、费用与净利润。", hash: "#/accounting/income-statement", perm: "finance.income" },
        { icon: "📈", title: "库存总览", desc: "查询各仓库商品库存数量与价值。", hash: "#/inventory/inventory_overview", perm: "report.inventory" },
        { icon: "💾", title: "系统备份", desc: "定期备份系统数据，降低遗失风险。", hash: "#/tools/system-backup", perm: "system.backup" },
        { icon: "📥", title: "Excel 导入中心", desc: "批量导入商品、客户等主档资料。", hash: "#/tools/migration-center", perm: "system.migration" }
    ].filter(f => can(f.perm));

    const content = `
    <div class="page-head">
        <div><h1>日常流程</h1><p>从采购进货到销货出货，再到收付款与财务报表的标准作业流程。</p></div>
        <div class="head-actions"><a class="btn primary" href="#/dashboard">返回仪表板</a></div>
    </div>
    <div class="ops-flow-panel" style="margin-bottom:18px">
        <p class="eyebrow">标准作业流程</p>
        <div class="flow-steps">
            <span>采购单</span><b>→</b><span>进货入库 / 应付</span><b>→</b><span>销货订单</span><b>→</b><span>出货扣库存 / 应收</span><b>→</b><span>收付款 / 传票 / 损益</span>
        </div>
    </div>
    <div class="flow-card-grid">
        ${flows.map(f => `<a class="flow-card" href="${f.hash}">
            <div class="fc-icon">${f.icon}</div>
            <h3>${f.title}</h3><p>${f.desc}</p>
        </a>`).join("")}
    </div>`;
    renderShell("daily_workflow", content, "首页 / 日常流程");
}

/* ---------------- 主渲染 ---------------- */
function render() {
    if (!DB.currentUser() && location.hash !== "#/login" && !location.hash) {
        location.hash = "#/login";
        renderLogin();
        return;
    }
    if (!DB.currentUser()) {
        renderLogin();
        return;
    }
    const hash = location.hash || "#/dashboard";
    document.body.className = localStorage.getItem("taiyuan_erp_sidebar") === "1" ? "sidebar-collapsed" : "";
    document.body.classList.toggle("dark", localStorage.getItem("taiyuan_erp_dark") === "1");
    route(hash);
}

/* ---------------- 路由 ---------------- */
function route(hash) {
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const p = parts.map(decodeURIComponent);
    const key = p.join("/");

    const routes = {
        "dashboard": renderDashboard,
        "daily-workflow": renderDailyWorkflow,
        "sales-orders": () => Pages.salesOrders(),
        "sales-orders/create": () => Pages.salesOrderForm(),
        "shipments": () => Pages.shipments(),
        "purchase-orders": () => Pages.purchaseOrders(),
        "purchase-orders/create": () => Pages.purchaseOrderForm(),
        "inventory/inventory_adjust": () => Pages.inventoryAdjust(),
        "inventory/inventory_adjust/create": () => Pages.inventoryAdjustForm(),
        "sales-returns": () => Pages.salesReturns(),
        "sales-returns/create": () => Pages.salesReturnForm(),
        "purchase-returns": () => Pages.purchaseReturns(),
        "purchase-returns/create": () => Pages.purchaseReturnForm(),
        "accounting/accounts-receivable": () => Pages.accountsReceivable(),
        "accounting/accounts-payable": () => Pages.accountsPayable(),
        "expenses": () => Pages.expenses(),
        "expenses/create": () => Pages.expenseForm(),
        "accounting/vouchers": () => Pages.vouchers(),
        "accounting/vouchers/create": () => Pages.voucherForm(),
        "accounting/income-statement": () => Pages.incomeStatement(),
        "master/items": () => Pages.items(),
        "master/items/create": () => Pages.itemForm(),
        "master/customers": () => Pages.customers(),
        "master/customers/create": () => Pages.customerForm(),
        "master/suppliers": () => Pages.suppliers(),
        "master/suppliers/create": () => Pages.supplierForm(),
        "master/warehouses": () => Pages.warehouses(),
        "master/warehouses/create": () => Pages.warehouseForm(),
        "master/units": () => Pages.simpleMaster("units", "单位管理"),
        "master/currencies": () => Pages.simpleMaster("currencies", "币别管理"),
        "master/categories": () => Pages.simpleMaster("categories", "商品分类"),
        "master/shipping_methods": () => Pages.simpleMaster("shipping_methods", "物流方式"),
        "master/payment_terms": () => Pages.simpleMaster("payment_terms", "付款条件"),
        "inventory/inventory_overview": () => Pages.inventoryOverview(),
        "inventory/inventory_safety": () => Pages.inventorySafety(),
        "tools/migration-center": () => Pages.migrationCenter(),
        "tools/system-backup": () => Pages.systemBackup(),
        "users": () => Pages.users(),
        "users/create": () => Pages.userForm(),
        "roles": () => Pages.roles(),
        "roles/create": () => Pages.roleForm(),
        "permissions": () => Pages.permissions()
    };

    // 菜单路径 → 权限映射
    const permForPath = (k) => {
        for (const g of MENU) for (const it of g.items) {
            if (it.hash === "#/" + k) return it.perm;
        }
        return null;
    };
    const denyAccess = (k) => { toast("您没有访问该页面的权限", "error"); renderDashboard(); };

    // 带参数的编辑路由：/xxx/<id>/edit 或 /a/xxx/<id>/edit
    if (routes[key]) {
        const perm = permForPath(key);
        if (perm && !can(perm)) { denyAccess(key); return; }
        routes[key](); return;
    }
    const lastSeg = p[p.length - 1];
    if (lastSeg === "edit" && p.length >= 3 && p[p.length - 2] !== "create") {
        const id = p[p.length - 2];
        const base = p.slice(0, -2).join("/");
        const map = {
            "sales-orders": () => Pages.salesOrderForm(id),
            "purchase-orders": () => Pages.purchaseOrderForm(id),
            "master/items": () => Pages.itemForm(id),
            "master/customers": () => Pages.customerForm(id),
            "master/suppliers": () => Pages.supplierForm(id),
            "master/warehouses": () => Pages.warehouseForm(id),
            "users": () => Pages.userForm(id),
            "roles": () => Pages.roleForm(id)
        };
        if (map[base]) {
            const perm = permForPath(base);
            if (perm && !can(perm)) { denyAccess(base); return; }
            map[base](); return;
        }
    }
    // 详情路由：/xxx/<id>
    if (p.length === 2 && p[1] !== "create") {
        const id = p[1];
        if (p[0] === "shipments") {
            const perm = permForPath("shipments");
            if (perm && !can(perm)) { denyAccess("shipments"); return; }
            Pages.shipmentDetail(id); return;
        }
        if (p[0] === "sales-orders") {
            const perm = permForPath("sales-orders");
            if (perm && !can(perm)) { denyAccess("sales-orders"); return; }
            Pages.salesOrderDetail(id); return;
        }
    }
    toast("找不到该页面，已回到首页", "error");
    renderDashboard();
}

/* ---------------- 启动 ---------------- */
window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", () => {
    if (!location.hash) location.hash = "#/login";
    render();
});
