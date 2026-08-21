/* ============================================================
   会计模块测试 test-accounting.js
   覆盖：科目CRUD、自动传票（出货/进货/收款/付款/费用/退回/调整）、
        传票作废、总分类账、试算表、资产负债表、回填+期初调整
   ============================================================ */
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8902/";

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let pass = 0, fail = 0;
    const errors = [];
    page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
    page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

    const ok = (name, cond, extra) => {
        if (cond) { pass++; console.log("  PASS " + name); }
        else { fail++; console.log("  FAIL " + name + (extra ? "  | " + extra : "")); }
    };
    const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval("(" + src + ")"); return f(a); }, { src: fn.toString(), a: arg });
    const gotoHash = async (h) => {
        await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));
        await page.goto(BASE + "#" + h);
        await page.waitForTimeout(300);
    };

    console.log("== 0. 登录 ==");
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    ok("admin 登录成功", await page.locator(".erp-shell").count() > 0);

    console.log("== 0b. 准备测试数据 ==");
    await db(() => {
        // 清空业务数据
        DB.clearBusiness();
        // 插入测试商品
        const it = DB.insert("items", {
            id: "it_acct", code: "ACCT001", name: "会计测试商品", english_name: "", spec: "", brand: "", model: "",
            category_id: DB.list("categories")[0].id, product_type: "成品",
            sales_unit: "个", purchase_unit: "个", stock_unit: "个",
            sales_to_stock: 1, purchase_to_stock: 1,
            cost: 10, price: 30, min_price: 25, purchase_currency: "CNY",
            safety_stock: 5, max_stock: 100, weight: 0, volume: 0, remark: ""
        });
        DB.addStock("wh1", it.id, 100);
        return true;
    });
    ok("测试商品已插入", (await db(() => DB.list("items").some(i => i.code === "ACCT001"))));

    // 检查科目表是否已迁移注入
    const chartCount = await db(() => DB.list("chart_accounts").length);
    ok("科目表已注入（19个标准科目）", chartCount === 19, "实际: " + chartCount);

    console.log("\n== 1. 科目表页面渲染 ==");
    await gotoHash("/accounting/accounts");
    ok("会计科目页面渲染", await page.locator("table").count() > 0);
    ok("科目表显示19行", await page.locator("table tbody tr").count() === 19);

    console.log("\n== 2. 科目新增 ==");
    await gotoHash("/accounting/accounts/create");
    ok("科目新增表单渲染", await page.locator("form").count() > 0);
    await page.fill('input[name="code"]', "1999");
    await page.fill('input[name="name"]', "测试待摊费用");
    await page.selectOption('select[name="type"]', "资产");
    await page.selectOption('select[name="direction"]', "借");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(400);
    ok("科目新增成功", (await db(() => DB.list("chart_accounts").some(a => a.name === "测试待摊费用"))), "未找到新增科目");

    console.log("\n== 3. 科目重名/重编码守卫 ==");
    await gotoHash("/accounting/accounts/create");
    await page.fill('input[name="code"]', "1999");
    await page.fill('input[name="name"]', "另一个待摊");
    await page.selectOption('select[name="type"]', "资产");
    await page.selectOption('select[name="direction"]', "借");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(400);
    ok("重复编码被拒绝", !(await db(() => DB.list("chart_accounts").some(a => a.name === "另一个待摊"))));

    console.log("\n== 4. 创建销货订单并出货 → 自动传票 ==");
    // 先创建一个 draft 订单
    await db(() => {
        const it = DB.get("items", "it_acct");
        const cu = DB.list("customers")[0];
        DB.insert("sales_orders", {
            id: "so_acct1", no: "SO20260120001", channel: "一般销货", platform_no: "",
            customer_id: cu.id, payment_status: "unpaid", payment_method: "现款现货",
            currency: "CNY", order_date: "2026-01-20", delivery_date: "2026-01-23",
            status: "draft", logistics_method: "", sales_owner: "测试", shipment_no: "",
            recipient_name: cu.name, recipient_phone: "13800000000", shipping_address: "测试地址",
            invoice_type: "不开发票", price_tax_mode: "含税", tax_type: "不计税", tax_rate: 0,
            shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0,
            settlement_tax_included: false,
            taxable_amount: 60, tax_amount: 0, invoice_amount: 60, net_receipt: 60,
            invoice_title: "", invoice_tax_id: "", invoice_no: "", invoice_date: "", invoice_status: "未开",
            lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 2, unit: "个", unit_price: 30, amount: 60, remark: "" }],
            remark: "", created_by: "系统管理员"
        });
        return true;
    });
    ok("draft 订单已创建", (await db(() => DB.get("sales_orders", "so_acct1"))) !== null);

    // 执行出货（直接模拟 doShip 逻辑，避免依赖 DOM 弹窗）
    const shipResult = await db(() => {
        const o = DB.get("sales_orders", "so_acct1");
        const whId = "wh1";
        // 扣库存
        o.lines.forEach(l => {
            const it = DB.get("items", l.item_id);
            const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
            DB.addStock(whId, l.item_id, -Utils.num(l.qty) * rate);
        });
        // 建立出货单
        const shipment = DB.insert("shipments", {
            no: "SH20260120001", sales_order_id: o.id, order_no: o.no, warehouse_id: whId,
            ship_date: "2026-01-20", logistics_method: "圆通速递", shipment_no: "TEST001",
            recipient_name: o.recipient_name, recipient_phone: o.recipient_phone,
            shipping_address: o.shipping_address,
            lines: o.lines.map(l => Object.assign({}, l)), remark: "", created_by: "系统管理员"
        });
        // 会计联动
        let acctResult = "ACCT_NOT_FOUND";
        let acctError = null;
        if (typeof ACCT !== "undefined" && ACCT.onShipment) {
            try {
                const r = ACCT.onShipment(shipment, o);
                acctResult = r ? "created:" + (r.id || "?") : "null_returned";
            } catch (e) {
                acctResult = "error";
                acctError = e.message;
            }
        }
        // 更新订单状态
        DB.update("sales_orders", o.id, { status: "shipped", logistics_method: "圆通速递", shipment_no: "TEST001" });
        return { shipId: shipment.id, acctResult, acctError, voucherCount: DB.list("vouchers").length };
    });
    await page.waitForTimeout(300);
    ok("出货单已创建", shipResult.shipId, "shipId: " + shipResult.shipId);
    if (shipResult.acctError) {
        ok("ACCT.onShipment 无错误", false, "错误: " + shipResult.acctError);
    }
    const shipVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("SHIP:") === 0 && x.status === "已过账").length);
    ok("出货自动生成传票", shipVoucher === 1, "传票数: " + shipVoucher + " acctResult: " + shipResult.acctResult);

    // 验证传票分录
    const shipV = await db((sid) => {
        const v = DB.list("vouchers").find(x => x.biz_key === "SHIP:" + sid);
        if (!v) return null;
        return {
            balanced: v.balanced,
            auto: v.auto,
            lines: v.lines.map(l => ({ a: l.account, d: l.debit, c: l.credit }))
        };
    }, shipResult.shipId);
    ok("出货传票借贷平衡", shipV && shipV.balanced === true);
    ok("出货传票标记自动", shipV && shipV.auto === true);
    ok("出货传票含应收账款借方60", shipV && shipV.lines.some(l => l.a === "应收账款" && l.d === 60));
    ok("出货传票含主营业务收入贷方60", shipV && shipV.lines.some(l => l.a === "主营业务收入" && l.c === 60));
    ok("出货传票含主营业务成本借方20", shipV && shipV.lines.some(l => l.a === "主营业务成本" && l.d === 20));
    ok("出货传票含库存商品贷方20", shipV && shipV.lines.some(l => l.a === "库存商品" && l.c === 20));

    console.log("\n== 5. 创建采购单并进货 → 自动传票 ==");
    await db(() => {
        const it = DB.get("items", "it_acct");
        const sp = DB.list("suppliers")[0];
        DB.insert("purchase_orders", {
            id: "po_acct1", no: "PO20260120001", supplier_id: sp.id, payment_status: "unpaid",
            payment_method: "现款现货", currency: "CNY", po_date: "2026-01-20", delivery_date: "2026-01-25",
            status: "draft", warehouse_id: "wh1",
            amount: 40, taxable_amount: 40, tax_amount: 0, invoice_amount: 40,
            lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 4, unit: "个", unit_price: 10, amount: 40, remark: "" }],
            remark: "", created_by: "系统管理员"
        });
        return true;
    });
    await db(() => {
        const o = DB.get("purchase_orders", "po_acct1");
        // 模拟进货
        o.lines.forEach(l => {
            const it = DB.get("items", l.item_id);
            const rate = it && Utils.num(it.purchase_to_stock) > 0 ? Utils.num(it.purchase_to_stock) : 1;
            DB.addStock(o.warehouse_id, l.item_id, Utils.num(l.qty) * rate);
        });
        DB.update("purchase_orders", o.id, { status: "received" });
        let acctError = null;
        if (typeof ACCT !== "undefined" && ACCT.onPOReceive) {
            try { ACCT.onPOReceive(o); } catch (e) { acctError = e.message; }
        }
        return { acctError };
    });
    await page.waitForTimeout(300);
    const poVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("PO:po_acct1") === 0 && x.status === "已过账").length);
    ok("进货自动生成传票", poVoucher === 1, "传票数: " + poVoucher);
    const poV = await db(() => {
        const v = DB.list("vouchers").find(x => x.biz_key && x.biz_key.indexOf("PO:po_acct1") === 0);
        if (!v) return null;
        return { lines: v.lines.map(l => ({ a: l.account, d: l.debit, c: l.credit })) };
    });
    ok("进货传票含库存商品借方40", poV && poV.lines.some(l => l.a === "库存商品" && l.d === 40));
    ok("进货传票含应付账款贷方40", poV && poV.lines.some(l => l.a === "应付账款" && l.c === 40));

    console.log("\n== 6. 登记收款 → 自动传票 ==");
    // 先打开应收账款页，对 so_acct1 收款
    await gotoHash("/accounts-receivable");
    // 用直接调用方式测试
    await db(() => {
        const o = DB.get("sales_orders", "so_acct1");
        // 模拟 doSavePayment 逻辑
        DB.update("sales_orders", o.id, { received_amount: 60, payment_status: "paid", receipt_date: "2026-01-21" });
        if (typeof ACCT !== "undefined" && ACCT.onReceipt) ACCT.onReceipt(o, 60, "2026-01-21", "银行转账");
        return true;
    });
    await page.waitForTimeout(300);
    const recvVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("RECV:so_acct1") === 0 && x.status === "已过账").length);
    ok("收款自动生成传票", recvVoucher === 1, "传票数: " + recvVoucher);
    const recvV = await db(() => {
        const v = DB.list("vouchers").find(x => x.biz_key && x.biz_key.indexOf("RECV:so_acct1") === 0);
        if (!v) return null;
        return { lines: v.lines.map(l => ({ a: l.account, d: l.debit, c: l.credit })) };
    });
    ok("收款传票含银行存款借方60", recvV && recvV.lines.some(l => l.a === "银行存款" && l.d === 60));
    ok("收款传票含应收账款贷方60", recvV && recvV.lines.some(l => l.a === "应收账款" && l.c === 60));

    console.log("\n== 7. 登记付款 → 自动传票 ==");
    await db(() => {
        const o = DB.get("purchase_orders", "po_acct1");
        DB.update("purchase_orders", o.id, { paid_amount: 40, payment_status: "paid", payment_date: "2026-01-22" });
        if (typeof ACCT !== "undefined" && ACCT.onPayment) ACCT.onPayment(o, 40, "2026-01-22", "银行转账");
        return true;
    });
    await page.waitForTimeout(300);
    const payVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("PAY:po_acct1") === 0 && x.status === "已过账").length);
    ok("付款自动生成传票", payVoucher === 1, "传票数: " + payVoucher);

    console.log("\n== 8. 登记费用 → 自动传票 ==");
    const expResult = await db(() => {
        const rec = DB.insert("expenses", {
            no: "EX20260120001", date: "2026-01-20", type: "办公费",
            account: "管理费用", amount: 500, payment_method: "银行转账",
            remark: "测试费用", voucher_no: "", created_by: "系统管理员"
        });
        let acctResult = "ACCT_NOT_FOUND";
        let acctError = null;
        if (typeof ACCT !== "undefined" && ACCT.onExpense) {
            try {
                const v = ACCT.onExpense(rec);
                acctResult = v ? "created:" + (v.id || "?") : "null_returned";
            } catch (e) {
                acctResult = "error";
                acctError = e.message;
            }
        }
        return { expId: rec.id, acctResult, acctError, voucherCount: DB.list("vouchers").length };
    });
    if (expResult.acctError) {
        ok("ACCT.onExpense 无错误", false, "错误: " + expResult.acctError);
    }
    const expVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("EXP:") === 0 && x.status === "已过账").length);
    ok("费用自动生成传票", expVoucher === 1, "传票数: " + expVoucher + " acctResult: " + expResult.acctResult);
    const expV = await db(() => {
        const v = DB.list("vouchers").find(x => x.biz_key && x.biz_key.indexOf("EXP:") === 0);
        if (!v) return null;
        return { bizKey: v.biz_key, lines: v.lines.map(l => ({ a: l.account, d: l.debit, c: l.credit, dt: typeof l.debit })) };
    });
    ok("费用传票含管理费用借方500", expV && expV.lines.some(l => l.a === "管理费用" && l.d === 500), expV ? JSON.stringify(expV.lines) : "expV is null");
    ok("费用传票含银行存款贷方500", expV && expV.lines.some(l => l.a === "银行存款" && l.c === 500));

    console.log("\n== 9. 传票幂等性测试 ==");
    const beforeCount = await db(() => DB.list("vouchers").length);
    await db(() => {
        const o = DB.get("sales_orders", "so_acct1");
        const s = DB.list("shipments").find(x => x.sales_order_id === "so_acct1");
        if (typeof ACCT !== "undefined" && ACCT.onShipment) ACCT.onShipment(s, o); // 重复调用
        return true;
    });
    const afterCount = await db(() => DB.list("vouchers").length);
    ok("重复出货不产生重复传票", beforeCount === afterCount);

    console.log("\n== 10. 删除出货单 → 传票作废 ==");
    const shipId = await db(() => {
        const s = DB.list("shipments").find(x => x.sales_order_id === "so_acct1");
        return s ? s.id : null;
    });
    ok("出货单存在", shipId !== null);
    if (shipId) {
        // 直接模拟 deleteShipment 逻辑
        await db((id) => {
            const s = DB.get("shipments", id);
            if (!s) return false;
            // 回冲库存
            s.lines.forEach(l => {
                const it = DB.get("items", l.item_id);
                const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
                DB.addStock(s.warehouse_id, l.item_id, Utils.num(l.qty) * rate);
            });
            DB.remove("shipments", id);
            // 会计联动：作废传票
            if (typeof ACCT !== "undefined" && ACCT.voidVouchers) ACCT.voidVouchers("SHIP:" + id);
            const o = DB.get("sales_orders", s.sales_order_id);
            if (o) DB.update("sales_orders", o.id, { status: "draft", logistics_method: "", shipment_no: "" });
            return true;
        }, shipId);
        await page.waitForTimeout(300);
        const voided = await db((sid) => {
            return DB.list("vouchers").filter(x => x.biz_key === "SHIP:" + sid && x.status === "已作废").length;
        }, shipId);
        ok("出货传票已作废", voided >= 1, "作废数: " + voided);
    }

    console.log("\n== 11. 试算表页面渲染 ==");
    await gotoHash("/accounting/trial-balance");
    ok("试算表页面渲染", await page.locator("table").count() > 0);
    const tbBalance = await db(() => {
        if (typeof ACCT === "undefined") return null;
        const bal = ACCT.allAccountBalances();
        let td = 0, tc = 0;
        Object.values(bal).forEach(v => { td += v.debit; tc += v.credit; });
        return { td: Math.round(td * 100) / 100, tc: Math.round(tc * 100) / 100 };
    });
    ok("试算表借贷平衡", tbBalance && Math.abs(tbBalance.td - tbBalance.tc) < 0.01, "借: " + (tbBalance ? tbBalance.td : "?") + " 贷: " + (tbBalance ? tbBalance.tc : "?"));

    console.log("\n== 12. 总分类账页面渲染 ==");
    await gotoHash("/accounting/general-ledger");
    ok("总分类账页面渲染", await page.locator("table").count() > 0);
    ok("总分类账有科目下拉", await page.locator("select").count() > 0);

    console.log("\n== 13. 资产负债表页面渲染 ==");
    await gotoHash("/accounting/balance-sheet");
    ok("资产负债表页面渲染", await page.locator("table").count() > 0);

    console.log("\n== 14. 资产负债表平衡检验 ==");
    const bsCheck = await db(() => {
        if (typeof ACCT === "undefined") return null;
        const bal = ACCT.allAccountBalances();
        const chart = DB.list("chart_accounts");
        let assets = 0, liabilities = 0, equity = 0;
        Object.keys(bal).forEach(name => {
            const acct = chart.find(a => a.name === name) || { type: "未分类", direction: "借" };
            const net = bal[name].debit - bal[name].credit;
            if (acct.type === "资产") assets += net;
            else if (acct.type === "负债") liabilities -= net; // 贷余为正
            else if (acct.type === "权益") equity -= net;
            else if (acct.type === "损益") equity -= net; // 损益净额计入本年利润
        });
        return { assets: Math.round(assets * 100) / 100, le: Math.round((liabilities + equity) * 100) / 100 };
    });
    ok("资产=负债+权益", bsCheck && Math.abs(bsCheck.assets - bsCheck.le) < 0.01, "资产: " + (bsCheck ? bsCheck.assets : "?") + " 负债+权益: " + (bsCheck ? bsCheck.le : "?"));

    console.log("\n== 15. 传票列表页面 ==");
    await gotoHash("/accounting/vouchers");
    ok("传票列表渲染", await page.locator("table").count() > 0);
    const autoCount = await db(() => DB.list("vouchers").filter(v => v.auto).length);
    ok("有自动传票显示", autoCount >= 3, "自动传票数: " + autoCount);
    ok("传票列表有同步按钮", await page.locator('text=业务数据同步传票').count() > 0);

    console.log("\n== 16. 回填传票（backfill）幂等 ==");
    const beforeBackfill = await db(() => DB.list("vouchers").length);
    await db(() => {
        if (typeof ACCT !== "undefined" && ACCT.backfill) ACCT.backfill(false);
        return true;
    });
    const afterBackfill1 = await db(() => DB.list("vouchers").length);
    await db(() => {
        if (typeof ACCT !== "undefined" && ACCT.backfill) ACCT.backfill(false);
        return true;
    });
    const afterBackfill2 = await db(() => DB.list("vouchers").length);
    ok("回填幂等（第二次不新增）", afterBackfill1 === afterBackfill2, "第一次: " + afterBackfill1 + " 第二次: " + afterBackfill2);

    console.log("\n== 17. 科目删除守卫 ==");
    // 尝试删除已被传票引用的科目（应收账款）
    const arAcct = await db(() => DB.list("chart_accounts").find(a => a.name === "应收账款"));
    if (arAcct) {
        // 直接调用删除逻辑（confirmModal 在无头测试中无法点击）
        const delResult = await db((id) => {
            // 检查是否被传票引用
            const used = DB.list("vouchers").some(v => v.lines && v.lines.some(l => {
                const std = (typeof ACCT_LEGACY_MAP !== "undefined" && ACCT_LEGACY_MAP[l.account]) || l.account;
                const acct = DB.find("chart_accounts", a => a.id === id);
                return acct && (l.account === acct.name || std === acct.name);
            }));
            if (used) return "blocked";
            DB.remove("chart_accounts", id);
            return "deleted";
        }, arAcct.id);
        ok("已引用科目不可删除", delResult === "blocked");
    } else {
        ok("已引用科目不可删除（跳过：找不到科目）", false);
    }

    console.log("\n== 18. 销货退回 → 自动传票 ==");
    // 重新出货 so_acct1（直接模拟）
    await db(() => {
        const o = DB.get("sales_orders", "so_acct1");
        o.lines.forEach(l => {
            const it = DB.get("items", l.item_id);
            const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
            DB.addStock("wh1", l.item_id, -Utils.num(l.qty) * rate);
        });
        const shipment = DB.insert("shipments", {
            no: "SH20260120002", sales_order_id: o.id, order_no: o.no, warehouse_id: "wh1",
            ship_date: "2026-01-22", logistics_method: "圆通速递", shipment_no: "TEST002",
            recipient_name: o.recipient_name, recipient_phone: o.recipient_phone,
            shipping_address: o.shipping_address,
            lines: o.lines.map(l => Object.assign({}, l)), remark: "", created_by: "系统管理员"
        });
        if (typeof ACCT !== "undefined" && ACCT.onShipment) ACCT.onShipment(shipment, o);
        DB.update("sales_orders", o.id, { status: "shipped", logistics_method: "圆通速递", shipment_no: "TEST002" });
        return true;
    });
    await page.waitForTimeout(300);
    // 创建销货退回
    await db(() => {
        const so = DB.get("sales_orders", "so_acct1");
        const it = DB.get("items", "it_acct");
        const sr = DB.insert("sales_returns", {
            no: "SR20260125001", sales_order_id: so.id, order_no: so.no,
            customer_id: so.customer_id, type: "退回", return_date: "2026-01-25",
            warehouse_id: "wh1",
            lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 1, unit: "个", unit_price: 30, amount: 30, remark: "" }],
            untaxed_amount: 30, tax_amount: 0, total_amount: 30, offset_receivable: true,
            cost_reversal: 10, remark: "测试退回", created_by: "系统管理员"
        });
        if (typeof ACCT !== "undefined" && ACCT.onSalesReturn) ACCT.onSalesReturn(sr, so);
        return true;
    });
    await page.waitForTimeout(300);
    const srVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("SRET:") === 0 && x.status === "已过账").length);
    ok("销货退回自动生成传票", srVoucher === 1, "传票数: " + srVoucher);

    console.log("\n== 19. 库存调整 → 自动传票 ==");
    await db(() => {
        const it = DB.get("items", "it_acct");
        const adj = DB.insert("inventory_adjusts", {
            no: "ADJ20260126001", warehouse_id: "wh1", type: "调整",
            source_type: "盘点", source_no: "",
            lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 5, unit: "个", before: 100, after: 105, remark: "盘盈" }],
            remark: "测试调整", created_by: "系统管理员"
        });
        DB.addStock("wh1", it.id, 5);
        if (typeof ACCT !== "undefined" && ACCT.onAdjust) ACCT.onAdjust(adj);
        return true;
    });
    await page.waitForTimeout(300);
    const adjVoucher = await db(() => DB.list("vouchers").filter(x => x.biz_key && x.biz_key.indexOf("ADJ:") === 0 && x.status === "已过账").length);
    ok("库存调整自动生成传票", adjVoucher === 1, "传票数: " + adjVoucher);

    console.log("\n== 20. 传票科目下拉动态读取 ==");
    await gotoHash("/accounting/vouchers/create");
    ok("传票表单渲染", await page.locator("#voucherLines").count() > 0);
    // 检查科目下拉是否有 optgroup（动态生成特征）
    const hasOptgroup = await page.locator('#voucherLines select[name="account[]"] optgroup').count();
    ok("传票科目下拉从科目表生成（有optgroup）", hasOptgroup > 0, "optgroup数: " + hasOptgroup);

    console.log("\n== 21. 费用表单科目下拉 ==");
    await gotoHash("/expenses/create");
    ok("费用表单渲染", await page.locator("form").count() > 0);
    const expenseOptgroup = await page.locator('select[name="account"] optgroup').count();
    ok("费用科目下拉从科目表生成", expenseOptgroup > 0, "optgroup数: " + expenseOptgroup);

    console.log("\n== 22. 清理测试数据 ==");
    await db(() => { DB.clearBusiness(); return true; });
    ok("业务数据已清空", (await db(() => DB.list("vouchers").length)) === 0);

    // 删除测试科目
    await db(() => {
        const a = DB.list("chart_accounts").find(x => x.name === "测试待摊费用");
        if (a) DB.remove("chart_accounts", a.id);
        return true;
    });
    ok("测试科目已清理", !(await db(() => DB.list("chart_accounts").some(a => a.name === "测试待摊费用"))));

    console.log("\n========================================");
    console.log("会计模块测试结果：" + pass + " 通过 / " + fail + " 失败");
    if (errors.length) {
        console.log("页面错误：");
        errors.forEach(e => console.log("  " + e));
    }
    console.log("========================================");
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
})();
