/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 数据层
   基于 localStorage 的持久化存储 + 种子演示数据
   ============================================================ */
"use strict";

const COMPANY = {
    name: "义乌市钛沅商贸有限公司",
    short: "钛沅商贸",
    en: "TAIYUAN COMMERCE CO., LTD.",
    logoText: "钛",
    baseCurrency: "CNY",
    version: "1.0.0"
};

/* ---------------- 通用工具 ---------------- */
const Utils = {
    uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    today() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    },
    now() {
        const d = new Date();
        return this.today() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    },
    monthStart() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
    },
    addDays(dateStr, days) {
        const d = new Date(dateStr);
        d.setDate(d.getDate() + days);
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    },
    num(v) {
        const n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    },
    round(v, dec = 2) {
        const p = Math.pow(10, dec);
        return Math.round((Utils.num(v) + Number.EPSILON) * p) / p;
    },
    money(v, cur) {
        const n = Utils.round(v);
        const s = n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return s;
    },
    moneyInt(v) {
        return Math.round(Utils.num(v)).toLocaleString("zh-CN");
    },
    esc(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },
    // 依据前缀与日期生成单号：SO + YYYYMMDD + 3位流水
    nextNo(prefix, date, existing) {
        const key = date || this.today();
        const ymd = key.replace(/-/g, "");
        const coll = (existing && existing.list) ? existing : null;
        let max = 0;
        if (coll) {
            coll.list().forEach(r => {
                const m = String(r.no || "").match(new RegExp("^" + prefix + ymd + "(\\d+)$"));
                if (m) max = Math.max(max, parseInt(m[1], 10));
            });
        }
        return prefix + ymd + String(max + 1).padStart(3, "0");
    },
    maskPwd(p) { return p; }
};

/* ---------------- 数据存储 ---------------- */
const DB = {
    _mem: null,
    _loaded: false,

    load() {
        if (this._loaded) return;
        try {
            const raw = localStorage.getItem("taiyuan_erp_data_v1");
            if (raw) {
                this._mem = JSON.parse(raw);
            }
        } catch (e) { /* ignore */ }
        if (!this._mem || !this._mem.items) {
            this._mem = { version: 2, seeded: false };
        }
        if (!this._mem.seeded) {
            this.seed();
            this._mem.seeded = true;
            this._mem.dbVersion = 2;
            this.flush();
        } else if (this._mem.dbVersion !== 2) {
            // 旧版数据迁移：清空业务数据（销货单/出货单/采购单/库存调整/退回/费用/传票/商品/库存），保留基础资料
            this.clearBusiness();
            this._mem.dbVersion = 2;
            this.flush();
        }
        this._loaded = true;
    },
    flush() {
        try {
            localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(this._mem));
        } catch (e) { /* 存储满时忽略 */ }
    },
    coll(name) {
        this.load();
        if (!this._mem[name]) this._mem[name] = [];
        return this._mem[name];
    },
    list(name) {
        return this.coll(name).slice();
    },
    get(name, id) {
        return this.coll(name).find(r => r.id === id) || null;
    },
    find(name, fn) {
        return this.coll(name).find(fn) || null;
    },
    filter(name, fn) {
        return this.coll(name).filter(fn);
    },
    insert(name, rec) {
        const c = this.coll(name);
        if (!rec.id) rec.id = Utils.uid();
        if (!rec.created_at) rec.created_at = Utils.now();
        rec.updated_at = Utils.now();
        c.push(rec);
        this.flush();
        return rec;
    },
    update(name, id, patch) {
        const c = this.coll(name);
        const i = c.findIndex(r => r.id === id);
        if (i < 0) return null;
        patch.updated_at = Utils.now();
        c[i] = Object.assign({}, c[i], patch);
        this.flush();
        return c[i];
    },
    remove(name, id) {
        const c = this.coll(name);
        const i = c.findIndex(r => r.id === id);
        if (i >= 0) { c.splice(i, 1); this.flush(); return true; }
        return false;
    },
    /* ---------- 库存 ---------- */
    stockMap() {
        if (!this._mem.stock) this._mem.stock = {};
        return this._mem.stock;
    },
    stockOf(whId, itemId) {
        const m = this.stockMap();
        return (m[whId] && m[whId][itemId]) ? Utils.num(m[whId][itemId]) : 0;
    },
    totalStock(itemId) {
        const m = this.stockMap();
        let t = 0;
        Object.keys(m).forEach(wh => { t += Utils.num(m[wh][itemId]); });
        return t;
    },
    addStock(whId, itemId, qty) {
        const m = this.stockMap();
        if (!m[whId]) m[whId] = {};
        m[whId][itemId] = Utils.round(Utils.num(m[whId][itemId]) + Utils.num(qty), 4);
        this.flush();
    },
    stockValue(itemId) {
        const it = this.get("items", itemId);
        const cost = it ? Utils.num(it.cost) : 0;
        return Utils.round(this.totalStock(itemId) * cost);
    },

    /* ---------- 会话 ---------- */
    session() {
        try { return JSON.parse(localStorage.getItem("taiyuan_erp_session")); }
        catch (e) { return null; }
    },
    setSession(u) {
        localStorage.setItem("taiyuan_erp_session", JSON.stringify(u));
    },
    clearSession() { localStorage.removeItem("taiyuan_erp_session"); },
    currentUser() {
        const s = this.session();
        if (!s) return null;
        const u = this.get("users", s.user_id);
        return u || null;
    },

    /* ---------- 关联查找 ---------- */
    itemName(id) { const i = this.get("items", id); return i ? i.name : "-"; },
    itemByCode(code) { return this.find("items", i => i.code === code); },
    customerName(id) { const c = this.get("customers", id); return c ? c.name : "-"; },
    supplierName(id) { const s = this.get("suppliers", id); return s ? s.name : "-"; },
    warehouseName(id) { const w = this.get("warehouses", id); return w ? w.name : "-"; },
    currencyByCode(code) { return this.find("currencies", c => c.code === code); },
    currencyName(code) { const c = this.currencyByCode(code); return c ? c.name : code; },

    /* ---------- 重置 ---------- */
    resetAll() {
        localStorage.removeItem("taiyuan_erp_data_v1");
        localStorage.removeItem("taiyuan_erp_session");
        this._mem = null;
        this._loaded = false;
        this.load();
    },

    /* ---------- 清空业务数据（保留基础资料：仓库/币别/单位/分类/客户/供应商/用户/角色等） ---------- */
    clearBusiness() {
        const m = this._mem || (this.load(), this._mem);
        ["items", "sales_orders", "shipments", "purchase_orders",
            "inventory_adjusts", "sales_returns", "purchase_returns",
            "expenses", "vouchers"].forEach(k => { if (m[k]) m[k] = []; });
        m.stock = {};
        this.flush();
        return true;
    }
};

/* ---------------- 权限定义 ---------------- */
const PERMISSIONS = [
    { code: "dashboard.view", label: "查看仪表板", group: "首页" },
    { code: "workflow.view", label: "查看日常流程", group: "首页" },
    { code: "sales.view", label: "查看销货订单", group: "日常作业" },
    { code: "sales.create", label: "新增/编辑销货订单", group: "日常作业" },
    { code: "sales.ship", label: "出货扣库", group: "日常作业" },
    { code: "shipment.view", label: "查看出货单", group: "日常作业" },
    { code: "purchase.view", label: "查看采购单", group: "日常作业" },
    { code: "purchase.create", label: "新增/编辑采购单", group: "日常作业" },
    { code: "purchase.receive", label: "进货入库", group: "日常作业" },
    { code: "inventory.view", label: "查看库存调整", group: "日常作业" },
    { code: "inventory.adjust", label: "执行库存调整", group: "日常作业" },
    { code: "sales_return.view", label: "查看销货退回/折让", group: "日常作业" },
    { code: "purchase_return.view", label: "查看采购退回/折让", group: "日常作业" },
    { code: "finance.ar", label: "应收账款", group: "账款财务" },
    { code: "finance.ap", label: "应付账款", group: "账款财务" },
    { code: "finance.expense", label: "费用支出", group: "账款财务" },
    { code: "finance.voucher", label: "传票作业", group: "账款财务" },
    { code: "finance.income", label: "损益表", group: "账款财务" },
    { code: "master.item", label: "商品主档", group: "基本资料" },
    { code: "master.customer", label: "客户主档", group: "基本资料" },
    { code: "master.supplier", label: "供应商主档", group: "基本资料" },
    { code: "master.warehouse", label: "仓库主档", group: "基本资料" },
    { code: "master.basic", label: "基础设置(单位/币别/分类等)", group: "基本资料" },
    { code: "report.inventory", label: "库存总览", group: "报表查询" },
    { code: "report.safety", label: "安全库存报表", group: "报表查询" },
    { code: "system.migration", label: "Excel 导入中心", group: "系统设置" },
    { code: "system.backup", label: "系统备份", group: "系统设置" },
    { code: "system.user", label: "用户管理", group: "系统设置" },
    { code: "system.role", label: "角色管理", group: "系统设置" },
    { code: "system.permission", label: "权限管理", group: "系统设置" }
];

/* ---------------- 种子数据 ---------------- */
DB.seed = function () {
    const m = this._mem;
    const now = Utils.now();

    /* ---- 仓库 ---- */
    m.warehouses = [
        { id: "wh1", code: "WH001", name: "主仓库", contact: "王经理", phone: "0579-85120001", address: "浙江省金华市义乌市国际商贸城", remark: "总仓，存放常规商品", created_at: now, updated_at: now },
        { id: "wh2", code: "WH002", name: "电商发货仓", contact: "李主管", phone: "0579-85120002", address: "浙江省金华市义乌市北苑街道电商园", remark: "电商平台订单发货专用", created_at: now, updated_at: now }
    ];

    /* ---- 币别 ---- */
    m.currencies = [
        { id: "c1", code: "CNY", name: "人民币", rate: 1, symbol: "¥", is_base: true, remark: "本位币", created_at: now },
        { id: "c2", code: "USD", name: "美元", rate: 7.2, symbol: "$", is_base: false, remark: "", created_at: now },
        { id: "c3", code: "EUR", name: "欧元", rate: 7.8, symbol: "€", is_base: false, remark: "", created_at: now },
        { id: "c4", code: "JPY", name: "日元", rate: 0.048, symbol: "¥", is_base: false, remark: "", created_at: now },
        { id: "c5", code: "TWD", name: "新台币", rate: 0.23, symbol: "NT$", is_base: false, remark: "", created_at: now },
        { id: "c6", code: "VND", name: "越南盾", rate: 0.00028, symbol: "₫", is_base: false, remark: "", created_at: now }
    ];

    /* ---- 单位 ---- */
    m.units = [
        { id: "u1", name: "箱", code: "BOX", remark: "纸箱包装", created_at: now },
        { id: "u2", name: "袋", code: "BAG", remark: "袋装", created_at: now },
        { id: "u3", name: "盒", code: "BOX", remark: "盒装", created_at: now },
        { id: "u4", name: "个", code: "PC", remark: "单个", created_at: now },
        { id: "u5", name: "包", code: "PKT", remark: "小包装", created_at: now },
        { id: "u6", name: "件", code: "PCS", remark: "", created_at: now },
        { id: "u7", name: "套", code: "SET", remark: "", created_at: now },
        { id: "u8", name: "打", code: "DZN", remark: "12个/打", created_at: now }
    ];

    /* ---- 商品分类 ---- */
    m.categories = [
        { id: "g1", name: "咖啡饮品", parent_id: "", created_at: now },
        { id: "g2", name: "休闲零食", parent_id: "", created_at: now },
        { id: "g3", name: "坚果炒货", parent_id: "", created_at: now },
        { id: "g4", name: "冻干水果", parent_id: "", created_at: now },
        { id: "g5", name: "调味酱料", parent_id: "", created_at: now },
        { id: "g6", name: "烘焙食品", parent_id: "", created_at: now }
    ];

    /* ---- 物流方式 ---- */
    m.shipping_methods = [
        { id: "s1", name: "圆通速递", remark: "", created_at: now },
        { id: "s2", name: "中通快递", remark: "", created_at: now },
        { id: "s3", name: "申通快递", remark: "", created_at: now },
        { id: "s4", name: "韵达快递", remark: "", created_at: now },
        { id: "s5", name: "顺丰速运", remark: "时效最快", created_at: now },
        { id: "s6", name: "邮政EMS", remark: "", created_at: now },
        { id: "s7", name: "京东物流", remark: "", created_at: now },
        { id: "s8", name: "自提", remark: "客户上门自提", created_at: now },
        { id: "s9", name: "海运", remark: "大宗进口运输", created_at: now },
        { id: "s10", name: "空运", remark: "高价值快速运输", created_at: now }
    ];

    /* ---- 付款条件 ---- */
    m.payment_terms = [
        { id: "t1", name: "现款现货", days: 0, remark: "", created_at: now },
        { id: "t2", name: "货到付款", days: 0, remark: "", created_at: now },
        { id: "t3", name: "月结30天", days: 30, remark: "", created_at: now },
        { id: "t4", name: "月结60天", days: 60, remark: "", created_at: now },
        { id: "t5", name: "预付50%", days: 0, remark: "下单预付一半", created_at: now },
        { id: "t6", name: "支付宝/微信", days: 0, remark: "线上即时支付", created_at: now }
    ];

    /* ---- 商品（初始为空，由用户自行建立） ---- */
    m.items = [];

    /* ---- 客户 ---- */
    m.customers = [
        { id: "cu1", code: "WALKIN", name: "散客", english_name: "WALK-IN", contact: "", phone: "", fax: "", email: "", address: "", city: "义乌", country: "中国", tax_id: "", payment_method: "现款现货", payment_days: 0, currency: "CNY", credit_limit: 0, level: "散客", sales_owner: "业务人员", remark: "平台订单与散客通用客户", disabled: false, created_at: now, updated_at: now },
        { id: "cu2", code: "CUS000001", name: "义乌联华超市", english_name: "", contact: "陈店长", phone: "13800000001", fax: "", email: "", address: "义乌市稠城街道联华超市", city: "义乌", country: "中国", tax_id: "", payment_method: "月结30天", payment_days: 30, currency: "CNY", credit_limit: 50000, level: "批发客户", sales_owner: "业务人员", remark: "", disabled: false, created_at: now, updated_at: now },
        { id: "cu3", code: "CUS000002", name: "杭州好味食品商行", english_name: "", contact: "周总", phone: "13900000002", fax: "", email: "", address: "杭州市余杭区食品批发市场", city: "杭州", country: "中国", tax_id: "91330110MA2XXX001", payment_method: "月结60天", payment_days: 60, currency: "CNY", credit_limit: 100000, level: "批发客户", sales_owner: "业务人员", remark: "", disabled: false, created_at: now, updated_at: now },
        { id: "cu4", code: "CUS000003", name: "淘宝平台-钛沅旗舰店", english_name: "Taobao Store", contact: "", phone: "", fax: "", email: "", address: "", city: "", country: "中国", tax_id: "", payment_method: "平台已付款", payment_days: 0, currency: "CNY", credit_limit: 0, level: "平台客户", sales_owner: "系统管理员", remark: "淘宝/天猫订单", disabled: false, created_at: now, updated_at: now },
        { id: "cu5", code: "CUS000004", name: "拼多多平台-越南咖啡专营店", english_name: "PDD Store", contact: "", phone: "", fax: "", email: "", address: "", city: "", country: "中国", tax_id: "", payment_method: "平台已付款", payment_days: 0, currency: "CNY", credit_limit: 0, level: "平台客户", sales_owner: "系统管理员", remark: "拼多多订单", disabled: false, created_at: now, updated_at: now },
        { id: "cu6", code: "CUS000005", name: "抖音小店-越南特产馆", english_name: "Douyin Store", contact: "", phone: "", fax: "", email: "", address: "", city: "", country: "中国", tax_id: "", payment_method: "平台已付款", payment_days: 0, currency: "CNY", credit_limit: 0, level: "平台客户", sales_owner: "系统管理员", remark: "抖音订单", disabled: false, created_at: now, updated_at: now }
    ];

    /* ---- 供应商 ---- */
    m.suppliers = [
        { id: "sp1", code: "SUP000001", name: "越南中原咖啡进出口公司", english_name: "Trung Nguyen Coffee", contact: "阮先生", phone: "+84 901234567", fax: "", email: "sales@trungnguyen.vn", address: "越南邦美蜀市", city: "邦美蜀", country: "越南", tax_id: "", payment_method: "预付50%", payment_days: 0, currency: "VND", credit_limit: 200000000, level: "国外供应商", sales_owner: "系统管理员", remark: "咖啡类主要供应商", disabled: false, created_at: now, updated_at: now },
        { id: "sp2", code: "SUP000002", name: "LATA食品有限公司", english_name: "LATA Foods", contact: "黎小姐", phone: "+84 909876543", fax: "", email: "", address: "越南大叻市", city: "大叻", country: "越南", tax_id: "", payment_method: "预付50%", payment_days: 0, currency: "USD", credit_limit: 100000, level: "国外供应商", sales_owner: "系统管理员", remark: "坚果/冻干类", disabled: false, created_at: now, updated_at: now },
        { id: "sp3", code: "SUP000003", name: "云南普洱咖啡烘焙厂", english_name: "", contact: "张厂长", phone: "0879-2123456", fax: "", email: "", address: "云南省普洱市思茅区", city: "普洱", country: "中国", tax_id: "91530800MA6XX001", payment_method: "月结30天", payment_days: 30, currency: "CNY", credit_limit: 50000, level: "国内供应商", sales_owner: "业务人员", remark: "国内咖啡货源", disabled: false, created_at: now, updated_at: now },
        { id: "sp4", code: "SUP000004", name: "义乌国际商贸城食品批发部", english_name: "", contact: "吴老板", phone: "0579-85551234", fax: "", email: "", address: "义乌国际商贸城二区", city: "义乌", country: "中国", tax_id: "", payment_method: "现款现货", payment_days: 0, currency: "CNY", credit_limit: 20000, level: "国内供应商", sales_owner: "业务人员", remark: "本地补货", disabled: false, created_at: now, updated_at: now }
    ];

    /* ---- 库存（初始为空，随出入库动态变动） ---- */
    m.stock = {};

    /* ---- 用户 / 角色 ---- */
    m.roles = [
        { id: "r1", name: "系统管理员", description: "拥有全部系统权限", permissions: PERMISSIONS.map(p => p.code), created_at: now },
        { id: "r2", name: "管理者", description: "管理日常业务与报表", permissions: PERMISSIONS.filter(p => !p.code.startsWith("system.") && p.code !== "system.migration" && p.code !== "system.backup").map(p => p.code), created_at: now },
        { id: "r3", name: "业务", description: "负责销货订单与客户", permissions: ["dashboard.view", "sales.view", "sales.create", "sales_return.view", "master.item", "master.customer", "report.inventory", "report.safety", "finance.ar", "finance.income"], created_at: now },
        { id: "r4", name: "仓管", description: "负责出入库与库存", permissions: ["dashboard.view", "sales.view", "sales.ship", "shipment.view", "purchase.view", "purchase.receive", "inventory.view", "inventory.adjust", "master.item", "master.warehouse", "report.inventory", "report.safety"], created_at: now },
        { id: "r5", name: "会计", description: "负责账款与财务", permissions: ["dashboard.view", "finance.ar", "finance.ap", "finance.expense", "finance.voucher", "finance.income", "report.inventory", "report.safety"], created_at: now }
    ];
    m.users = [
        { id: "u_adm", username: "admin", password: "admin123", name: "系统管理员", role_id: "r1", email: "admin@taiyuan.cn", phone: "13800000000", status: "启用", created_at: now, updated_at: now },
        { id: "u_sal", username: "sales", password: "123456", name: "张业务", role_id: "r3", email: "", phone: "", status: "启用", created_at: now, updated_at: now },
        { id: "u_wh", username: "warehouse", password: "123456", name: "李仓管", role_id: "r4", email: "", phone: "", status: "启用", created_at: now, updated_at: now },
        { id: "u_acc", username: "accounting", password: "123456", name: "王会计", role_id: "r5", email: "", phone: "", status: "启用", created_at: now, updated_at: now }
    ];

    /* ---- 销货订单（初始为空） ---- */
    m.sales_orders = [];

    /* ---- 出货单（初始为空） ---- */
    m.shipments = [];

    /* ---- 采购单（初始为空） ---- */
    m.purchase_orders = [];

    /* ---- 库存调整（初始为空） ---- */
    m.inventory_adjusts = [];

    /* ---- 销货退回/折让（初始为空） ---- */
    m.sales_returns = [];
    /* ---- 采购退回/折让（初始为空） ---- */
    m.purchase_returns = [];

    /* ---- 费用支出（初始为空） ---- */
    m.expenses = [];

    /* ---- 传票（初始为空） ---- */
    m.vouchers = [];

    /* ---- 备份记录 ---- */
    m.backups = [
        { id: "b1", no: "BK20260701001", date: "2026-07-01 08:30:00", size: "2.4 MB", note: "首次初始化备份", created_at: now },
        { id: "b2", no: "BK20260801001", date: "2026-08-01 08:30:00", size: "3.1 MB", note: "月度例行备份", created_at: now },
        { id: "b3", no: "BK20260815001", date: "2026-08-15 08:30:00", size: "3.4 MB", note: "上线前备份", created_at: now }
    ];

    /* ---- 导入记录 ---- */
    m.migrations = [
        { id: "mg1", type: "商品主档", filename: "商品资料_20260801.xlsx", total: 21, ok: 20, fail: 1, date: "2026-08-01 10:12:00", note: "1笔币别缺漏", created_at: now },
        { id: "mg2", type: "客户主档", filename: "客户资料_20260802.xlsx", total: 6, ok: 6, fail: 0, date: "2026-08-02 14:30:00", note: "", created_at: now }
    ];
};

/* 初始化 */
DB.load();
