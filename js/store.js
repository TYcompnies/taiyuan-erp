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
            this._mem = { version: 1, seeded: false };
        }
        if (!this._mem.seeded) {
            this.seed();
            this._mem.seeded = true;
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

    /* ---- 商品 ---- */
    const mkItem = (code, name, cat, su, pu, su2, pu2, cost, price, safety, brand, remark, disabled) => ({
        id: "it_" + code, code, name, english_name: name, spec: "", brand: brand || "钛沅优选",
        model: "", category_id: cat, product_type: "成品",
        sales_unit: su, purchase_unit: pu, stock_unit: su2 || su, sales_to_stock: 1, purchase_to_stock: 1,
        cost: Utils.num(cost), price: Utils.num(price), min_price: Utils.num(price) * 0.8,
        purchase_currency: "CNY", safety_stock: Utils.num(safety), max_stock: Utils.num(safety) * 5,
        weight: 0, volume: 0, length_cm: 0, width_cm: 0, height_cm: 0,
        barcode: "", qrcode: "", remark: remark || "", disabled: !!disabled,
        created_at: now, updated_at: now
    });
    m.items = [
        mkItem("605900001", "越南1合1黑咖啡", "g1", "箱", "箱", "箱", "箱", 239, 320, 20, "VINACAFE", "进口越南黑咖啡"),
        mkItem("605900002", "越南2合1即溶咖啡", "g1", "箱", "箱", "箱", "箱", 210, 285, 20, "VINACAFE", ""),
        mkItem("605900003", "越南4合1海盐即溶咖啡", "g1", "箱", "箱", "箱", "箱", 260, 350, 15, "VINACAFE", ""),
        mkItem("605900004", "越南4合1鸡蛋即溶咖啡", "g1", "箱", "箱", "箱", "箱", 265, 358, 15, "VINACAFE", ""),
        mkItem("605900005", "越南3合1麝香猫咖啡风味即溶咖啡", "g1", "箱", "箱", "箱", "箱", 280, 380, 15, "VINACAFE", "猫屎咖啡风味"),
        mkItem("605900006", "越南4合1椰子风味即溶咖啡", "g1", "箱", "箱", "箱", "箱", 265, 358, 15, "VINACAFE", ""),
        mkItem("605900007", "越南4合1榴莲即溶咖啡", "g1", "箱", "箱", "箱", "箱", 275, 372, 15, "VINACAFE", ""),
        mkItem("605900008", "越南4合1栗子风味即溶咖啡", "g1", "箱", "箱", "箱", "箱", 268, 362, 15, "VINACAFE", ""),
        mkItem("605900009", "船型综合坚果饼干", "g6", "袋", "袋", "袋", "袋", 45, 68, 40, "LATA", ""),
        mkItem("605900010", "船型综合坚果饼干-大", "g6", "袋", "袋", "袋", "袋", 78, 118, 30, "LATA", ""),
        mkItem("605900011", "夏威夷果仁-带壳", "g3", "袋", "袋", "袋", "袋", 55, 85, 30, "LATA", ""),
        mkItem("605900012", "夏威夷果仁-带壳-大", "g3", "袋", "袋", "袋", "袋", 95, 148, 25, "LATA", ""),
        mkItem("605900013", "Lata's DALAT-综合蔬果干", "g4", "袋", "袋", "袋", "袋", 32, 52, 50, "LATA", ""),
        mkItem("605900014", "Lata's DALAT-综合蔬果干-大", "g4", "袋", "袋", "袋", "袋", 56, 88, 40, "LATA", ""),
        mkItem("605900015", "Lata's DALAT-香脆草莓冻干", "g4", "盒", "盒", "盒", "盒", 48, 75, 30, "LATA", ""),
        mkItem("AA0001", "大叻辣椒酱", "g5", "瓶", "瓶", "瓶", "瓶", 12, 22, 60, "大叻", "越南风味"),
        mkItem("AA0002", "大叻山竹冻干", "g4", "袋", "袋", "袋", "袋", 35, 58, 40, "大叻", ""),
        mkItem("AA0003", "大叻巧克力夏威夷果仁", "g3", "袋", "袋", "袋", "袋", 62, 98, 35, "大叻", ""),
        mkItem("AA0004", "大叻香葱芋头脆片", "g2", "袋", "袋", "袋", "袋", 18, 30, 80, "大叻", ""),
        mkItem("AA0005", "大叻海苔洋芋片", "g2", "袋", "袋", "袋", "袋", 16, 28, 80, "大叻", ""),
        mkItem("AA0006", "大叻香辣酱汁洋芋片", "g2", "袋", "袋", "袋", "袋", 17, 29, 60, "大叻", "")
    ];

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

    /* ---- 库存 ---- */
    m.stock = {
        wh1: {
            "it_605900001": 120, "it_605900002": 95, "it_605900003": 60, "it_605900004": 55,
            "it_605900005": 48, "it_605900006": 50, "it_605900007": 45, "it_605900008": 52,
            "it_605900009": 180, "it_605900010": 120, "it_605900011": 150, "it_605900012": 100,
            "it_605900013": 220, "it_605900014": 160, "it_605900015": 130,
            "it_AA0001": 300, "it_AA0002": 180, "it_AA0003": 140, "it_AA0004": 260, "it_AA0005": 240, "it_AA0006": 200
        },
        wh2: {
            "it_605900001": 60, "it_605900002": 40, "it_605900003": 30, "it_605900004": 25,
            "it_605900009": 80, "it_605900013": 60, "it_605900015": 40,
            "it_AA0004": 90, "it_AA0005": 80
        }
    };

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

    /* ---- 销货订单（含已出货） ---- */
    const mkSOLine = (itemId, qty, price) => {
        const it = m.items.find(i => i.id === itemId);
        const p = price != null ? price : it.price;
        return { item_id: it.id, code: it.code, name: it.name, qty: Utils.num(qty), unit: it.sales_unit, unit_price: Utils.num(p), amount: Utils.round(qty * p), remark: "" };
    };
    const mkSO = (no, date, customerId, channel, lines, opts) => {
        const goods = lines.reduce((s, l) => s + l.amount, 0);
        const shipping_fee = opts && opts.shipping_fee != null ? opts.shipping_fee : 0;
        const platform_fee = opts && opts.platform_fee != null ? opts.platform_fee : 0;
        const payment_fee = opts && opts.payment_fee != null ? opts.payment_fee : 0;
        const other_fee = opts && opts.other_fee != null ? opts.other_fee : 0;
        const tax_rate = opts && opts.tax_rate != null ? opts.tax_rate : 5;
        const tax_type = opts && opts.tax_type ? opts.tax_type : "不计税";
        const status = opts && opts.status ? opts.status : "draft";
        const payment_status = opts && opts.payment_status ? opts.payment_status : "unpaid";
        const cu = m.customers.find(c => c.id === customerId);
        const currency = cu ? cu.currency : "CNY";
        const invoice_amount = Utils.round(goods + shipping_fee);
        return {
            id: "so_" + no, no, channel: channel || "一般销货", platform_no: opts && opts.platform_no || "",
            customer_id: customerId, payment_status, payment_method: opts && opts.payment_method || (cu ? cu.payment_method : "现款现货"),
            currency, order_date: date, delivery_date: Utils.addDays(date, 3), status,
            logistics_method: opts && opts.logistics || "圆通速递", sales_owner: opts && opts.owner || "业务人员",
            shipment_no: "", recipient_name: cu ? cu.name : "", recipient_phone: cu ? cu.phone : "", shipping_address: cu ? cu.address : "",
            invoice_type: "不开发票", price_tax_mode: "含税", tax_type, tax_rate: Utils.num(tax_rate),
            shipping_fee, commission_rate: opts && opts.commission_rate || 0, platform_fee, payment_fee, other_fee,
            settlement_tax_included: false,
            taxable_amount: Utils.round(invoice_amount / (1 + tax_rate / 100)), tax_amount: Utils.round(invoice_amount - invoice_amount / (1 + tax_rate / 100)),
            invoice_amount, net_receipt: Math.round(Math.max(invoice_amount - shipping_fee - platform_fee - payment_fee - other_fee, 0)),
            invoice_title: "", invoice_tax_id: "", invoice_no: "", invoice_date: "", invoice_status: "未开",
            lines, remark: opts && opts.remark || "", created_by: "系统管理员", created_at: now, updated_at: now
        };
    };
    m.sales_orders = [
        mkSO("SO20260805001", "2026-08-05", "cu2", "一般销货", [mkSOLine("it_605900001", 20, 320), mkSOLine("it_605900009", 30, 68)], { status: "shipped", payment_status: "unpaid", tax_type: "应税", tax_rate: 13, owner: "张业务", remark: "联华超市首批订单" }),
        mkSO("SO20260806001", "2026-08-06", "cu4", "淘宝", [mkSOLine("it_605900002", 10, 285), mkSOLine("it_605900013", 20, 52)], { status: "shipped", payment_status: "paid", payment_method: "平台已付款", owner: "系统管理员", platform_fee: 55, commission_rate: 5 }),
        mkSO("SO20260810001", "2026-08-10", "cu5", "拼多多", [mkSOLine("it_605900005", 8, 380), mkSOLine("it_605900007", 6, 372)], { status: "shipped", payment_status: "paid", payment_method: "平台已付款", owner: "系统管理员", platform_fee: 68, commission_rate: 5 }),
        mkSO("SO20260812001", "2026-08-12", "cu1", "散客", [mkSOLine("it_605900011", 15, 85), mkSOLine("it_AA0002", 10, 58)], { status: "shipped", payment_status: "unpaid", owner: "张业务" }),
        mkSO("SO20260815001", "2026-08-15", "cu3", "一般销货", [mkSOLine("it_605900010", 25, 118), mkSOLine("it_605900015", 20, 75)], { status: "shipped", payment_status: "unpaid", tax_type: "应税", tax_rate: 13, owner: "张业务", remark: "杭州商行月结客户" }),
        mkSO("SO20260816001", "2026-08-16", "cu6", "抖音", [mkSOLine("it_605900003", 5, 350), mkSOLine("it_605900004", 5, 358), mkSOLine("it_AA0005", 20, 28)], { status: "draft", payment_status: "paid", payment_method: "平台已付款", owner: "系统管理员", platform_fee: 42, commission_rate: 8 }),
        mkSO("SO20260817001", "2026-08-17", "cu2", "一般销货", [mkSOLine("it_605900001", 15, 320), mkSOLine("it_605900002", 10, 285)], { status: "draft", payment_status: "unpaid", tax_type: "应税", tax_rate: 13, owner: "张业务" }),
        mkSO("SO20260818001", "2026-08-18", "cu1", "散客", [mkSOLine("it_AA0001", 50, 22), mkSOLine("it_AA0006", 30, 29)], { status: "draft", payment_status: "paid", payment_method: "现款现货", owner: "张业务" })
    ];

    /* ---- 出货单（对应已出货订单） ---- */
    m.shipments = [
        { id: "sh1", no: "SH20260806001", sales_order_id: "so_SO20260805001", order_no: "SO20260805001", warehouse_id: "wh1", ship_date: "2026-08-06", logistics_method: "圆通速递", shipment_no: "YT800001", recipient_name: "义乌联华超市", recipient_phone: "13800000001", shipping_address: "义乌市稠城街道联华超市", lines: m.sales_orders[0].lines.map(l => Object.assign({}, l)), remark: "", created_by: "李仓管", created_at: now, updated_at: now },
        { id: "sh2", no: "SH20260807001", sales_order_id: "so_SO20260806001", order_no: "SO20260806001", warehouse_id: "wh2", ship_date: "2026-08-07", logistics_method: "圆通速递", shipment_no: "YT800002", recipient_name: "淘宝平台-钛沅旗舰店", recipient_phone: "", shipping_address: "", lines: m.sales_orders[1].lines.map(l => Object.assign({}, l)), remark: "平台订单", created_by: "李仓管", created_at: now, updated_at: now },
        { id: "sh3", no: "SH20260811001", sales_order_id: "so_SO20260810001", order_no: "SO20260810001", warehouse_id: "wh2", ship_date: "2026-08-11", logistics_method: "中通快递", shipment_no: "ZT800003", recipient_name: "拼多多平台-越南咖啡专营店", recipient_phone: "", shipping_address: "", lines: m.sales_orders[2].lines.map(l => Object.assign({}, l)), remark: "平台订单", created_by: "李仓管", created_at: now, updated_at: now },
        { id: "sh4", no: "SH20260813001", sales_order_id: "so_SO20260812001", order_no: "SO20260812001", warehouse_id: "wh1", ship_date: "2026-08-13", logistics_method: "自提", shipment_no: "", recipient_name: "散客", recipient_phone: "", shipping_address: "", lines: m.sales_orders[3].lines.map(l => Object.assign({}, l)), remark: "客户自提", created_by: "李仓管", created_at: now, updated_at: now },
        { id: "sh5", no: "SH20260816001", sales_order_id: "so_SO20260815001", order_no: "SO20260815001", warehouse_id: "wh1", ship_date: "2026-08-16", logistics_method: "顺丰速运", shipment_no: "SF800004", recipient_name: "杭州好味食品商行", recipient_phone: "13900000002", shipping_address: "杭州市余杭区食品批发市场", lines: m.sales_orders[4].lines.map(l => Object.assign({}, l)), remark: "", created_by: "李仓管", created_at: now, updated_at: now }
    ];

    /* ---- 采购单 ---- */
    const mkPOLine = (itemId, qty, price) => {
        const it = m.items.find(i => i.id === itemId);
        const p = price != null ? price : it.cost;
        return { item_id: it.id, code: it.code, name: it.name, qty: Utils.num(qty), unit: it.purchase_unit, unit_price: Utils.num(p), amount: Utils.round(qty * p), remark: "" };
    };
    const mkPO = (no, date, supplierId, lines, opts) => {
        const amount = lines.reduce((s, l) => s + l.amount, 0);
        const sp = m.suppliers.find(s => s.id === supplierId);
        return {
            id: "po_" + no, no, supplier_id: supplierId, po_date: date, delivery_date: Utils.addDays(date, 15),
            currency: sp ? sp.currency : "CNY", payment_method: sp ? sp.payment_method : "现款现货",
            status: opts && opts.status || "draft", warehouse_id: opts && opts.wh || "wh1",
            amount, paid_amount: opts && opts.paid_amount || 0,
            lines, remark: opts && opts.remark || "", created_by: "系统管理员", created_at: now, updated_at: now
        };
    };
    m.purchase_orders = [
        mkPO("PO20260720001", "2026-07-20", "sp1", [mkPOLine("it_605900001", 100, 239), mkPOLine("it_605900002", 100, 210), mkPOLine("it_605900003", 60, 260)], { status: "received", wh: "wh1", paid_amount: 50000, remark: "7月咖啡补货" }),
        mkPO("PO20260725001", "2026-07-25", "sp2", [mkPOLine("it_605900009", 200, 45), mkPOLine("it_605900013", 200, 32), mkPOLine("it_605900015", 120, 48)], { status: "received", wh: "wh1", remark: "LATA坚果零食" }),
        mkPO("PO20260805001", "2026-08-05", "sp3", [mkPOLine("it_605900002", 80, 210), mkPOLine("it_605900006", 60, 265)], { status: "draft", wh: "wh1", remark: "国内补货待确认" }),
        mkPO("PO20260812001", "2026-08-12", "sp4", [mkPOLine("it_AA0001", 300, 12), mkPOLine("it_AA0005", 300, 16), mkPOLine("it_AA0006", 200, 17)], { status: "draft", wh: "wh2", remark: "本地批发补货" })
    ];

    /* ---- 库存调整 ---- */
    m.inventory_adjusts = [
        { id: "ia1", no: "ADJ20260801001", warehouse_id: "wh1", type: "调整", source_type: "盘点", source_no: "盘点单20260801", lines: [{ item_id: "it_605900001", code: "605900001", name: "越南1合1黑咖啡", qty: 2, before: 118, after: 120, remark: "盘点差异调整" }], remark: "月度盘点", created_by: "李仓管", created_at: now, updated_at: now },
        { id: "ia2", no: "ADJ20260810001", warehouse_id: "wh1", type: "拆包", source_type: "拆包作业", source_no: "SO20260810001", lines: [{ item_id: "it_605900011", code: "605900011", name: "夏威夷果仁-带壳", qty: 5, before: 145, after: 150, remark: "拆包入库" }], remark: "大包装拆小包", created_by: "李仓管", created_at: now, updated_at: now }
    ];

    /* ---- 销货退回/折让 ---- */
    m.sales_returns = [
        { id: "sr1", no: "SR20260808001", sales_order_id: "so_SO20260806001", order_no: "SO20260806001", customer_id: "cu4", type: "退回", return_date: "2026-08-08", warehouse_id: "wh2", lines: [{ item_id: "it_605900013", code: "605900013", name: "Lata's DALAT-综合蔬果干", qty: 2, unit: "袋", unit_price: 52, amount: 104, remark: "外包装破损" }], untaxed_amount: 104, tax_amount: 0, total_amount: 104, offset_receivable: true, cost_reversal: 64, remark: "客户退货", created_by: "张业务", created_at: now, updated_at: now }
    ];
    /* ---- 采购退回/折让 ---- */
    m.purchase_returns = [
        { id: "pr1", no: "PR20260802001", purchase_order_id: "po_PO20260720001", order_no: "PO20260720001", supplier_id: "sp1", type: "退回", return_date: "2026-08-02", warehouse_id: "wh1", lines: [{ item_id: "it_605900002", code: "605900002", name: "越南2合1即溶咖啡", qty: 5, unit: "箱", unit_price: 210, amount: 1050, remark: "品质问题" }], amount: 1050, offset_payable: true, remark: "品质异常退回", created_by: "系统管理员", created_at: now, updated_at: now }
    ];

    /* ---- 费用支出 ---- */
    m.expenses = [
        { id: "ex1", no: "EX20260803001", date: "2026-08-03", type: "房租", account: "管理费用-房租", amount: 8000, payment_method: "银行转账", remark: "8月仓库租金", voucher_no: "", created_by: "王会计", created_at: now, updated_at: now },
        { id: "ex2", no: "EX20260810001", date: "2026-08-10", type: "水电费", account: "管理费用-水电", amount: 1350.5, payment_method: "银行转账", remark: "8月水电", voucher_no: "", created_by: "王会计", created_at: now, updated_at: now },
        { id: "ex3", no: "EX20260812001", date: "2026-08-12", type: "物流费", account: "销售费用-物流", amount: 2680, payment_method: "现金", remark: "电商发货物流费", voucher_no: "", created_by: "王会计", created_at: now, updated_at: now },
        { id: "ex4", no: "EX20260815001", date: "2026-08-15", type: "平台服务费", account: "销售费用-平台费", amount: 420, payment_method: "支付宝", remark: "淘宝平台服务费", voucher_no: "JV20260818002", created_by: "王会计", created_at: now, updated_at: now },
        { id: "ex5", no: "EX20260817001", date: "2026-08-17", type: "办公费", account: "管理费用-办公", amount: 860, payment_method: "银行转账", remark: "办公用品", voucher_no: "", created_by: "王会计", created_at: now, updated_at: now }
    ];

    /* ---- 传票 ---- */
    m.vouchers = [
        { id: "v1", no: "JV20260815001", date: "2026-08-15", source: "费用支出", source_no: "EX20260815001", counterparty: "淘宝平台", payment_method: "支付宝", status: "已过账", lines: [{ account: "销售费用-平台费", debit: 420, credit: 0 }, { account: "银行存款", debit: 0, credit: 420 }], balanced: true, remark: "", created_by: "王会计", created_at: now, updated_at: now },
        { id: "v2", no: "JV20260818001", date: "2026-08-18", source: "应收账款", source_no: "SO20260805001", counterparty: "义乌联华超市", payment_method: "转账", status: "未过账", lines: [{ account: "应收账款", debit: 7330, credit: 0 }, { account: "主营业务收入", debit: 0, credit: 6487 }, { account: "应交税费-销项税", debit: 0, credit: 843 }], balanced: true, remark: "联华超市销售", created_by: "王会计", created_at: now, updated_at: now },
        { id: "v3", no: "JV20260818002", date: "2026-08-18", source: "应收账款", source_no: "SO20260815001", counterparty: "杭州好味食品商行", payment_method: "转账", status: "未过账", lines: [{ account: "应收账款", debit: 5030, credit: 0 }, { account: "主营业务收入", debit: 0, credit: 4451 }, { account: "应交税费-销项税", debit: 0, credit: 579 }], balanced: true, remark: "杭州商行销售", created_by: "王会计", created_at: now, updated_at: now },
        { id: "v4", no: "JV20260818003", date: "2026-08-18", source: "费用支出", source_no: "EX20260812001", counterparty: "圆通速递", payment_method: "现金", status: "未过账", lines: [{ account: "销售费用-物流", debit: 2680, credit: 0 }, { account: "现金", debit: 0, credit: 2680 }], balanced: true, remark: "物流费", created_by: "王会计", created_at: now, updated_at: now }
    ];

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
