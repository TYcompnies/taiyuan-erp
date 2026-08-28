/* ============================================================
   全功能遍历测试 test-everywhere.js
   覆盖：全部页面渲染、编辑/详情路由、删除保护、收款/付款、
   收款/付款、传票作业已移除验证、本位币唯一、库存调整回冲、权限路由、搜索、未知路由
   ============================================================ */
const { chromium } = require("playwright");
const BASE = (process.env.BASE || "http://127.0.0.1:8902") + "/";

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

    console.log("== 0. 登录 ==");
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    ok("admin 登录成功", await page.locator(".erp-shell").count() > 0);

    console.log("== 0b. 准备最小测试数据（业务数据初始为空） ==");
    await db(() => {
        const it = DB.insert("items", { id: "it_test", code: "TEST0001", name: "测试商品", english_name: "Test Item", spec: "", brand: "测试", model: "", category_id: DB.list("categories")[0].id, product_type: "成品", sales_unit: "个", purchase_unit: "个", stock_unit: "个", sales_to_stock: 1, purchase_to_stock: 1, cost: 10, price: 25, min_price: 20, purchase_currency: "CNY", safety_stock: 5, max_stock: 100, weight: 0, volume: 0, remark: "测试" });
        DB.addStock("wh1", it.id, 100);
        const so = DB.insert("sales_orders", {
            id: "so_seed1", no: "SO20260101001", channel: "一般销货", platform_no: "", customer_id: DB.list("customers")[0].id,
            payment_status: "unpaid", payment_method: "现款现货", currency: "CNY", order_date: "2026-01-01", delivery_date: "2026-01-04",
            status: "shipped", logistics_method: "圆通速递", sales_owner: "业务人员", shipment_no: "TEST001",
            recipient_name: "测试客户", recipient_phone: "13800000000", shipping_address: "测试地址",
            invoice_type: "不开发票", price_tax_mode: "含税", tax_type: "不计税", tax_rate: 0,
            shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, settlement_tax_included: false,
            taxable_amount: 50, tax_amount: 0, invoice_amount: 50, net_receipt: 50,
            invoice_title: "", invoice_tax_id: "", invoice_no: "", invoice_date: "", invoice_status: "未开",
            lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 2, unit: "个", unit_price: 25, amount: 50, remark: "" }],
            remark: "", created_by: "系统管理员"
        });
        DB.insert("shipments", {
            id: "sh_seed1", no: "SH20260102001", sales_order_id: so.id, order_no: so.no, warehouse_id: "wh1",
            ship_date: "2026-01-02", logistics_method: "圆通速递", shipment_no: "TEST001",
            recipient_name: "测试客户", recipient_phone: "13800000000", shipping_address: "测试地址",
            lines: so.lines.map(l => Object.assign({}, l)), remark: "", created_by: "李仓管"
        });
        return true;
    });
    ok("测试商品/订单/出货单已插入", (await db(() => ({ items: DB.list("items").length, so: DB.list("sales_orders").length, sh: DB.list("shipments").length }))).items >= 1);

    console.log("== 1. 全部页面遍历渲染 ==");
    const routes = [
        ["#/dashboard", "仪表板"],
        ["#/daily-workflow", "日常流程"],
        ["#/sales-orders", "销货订单"],
        ["#/sales-orders/create", "销货订单-新增"],
        ["#/shipments", "出货单"],
        ["#/purchase-orders", "采购单"],
        ["#/purchase-orders/create", "采购单-新增"],
        ["#/inventory/inventory_adjust", "库存调整"],
        ["#/inventory/inventory_adjust/create", "库存调整-新增"],
        ["#/sales-returns", "销货退回/折让"],
        ["#/sales-returns/create", "销货退回-新增"],
        ["#/purchase-returns", "采购退回/折让"],
        ["#/purchase-returns/create", "采购退回-新增"],
        ["#/accounting/accounts-receivable", "应收账款"],
        ["#/accounting/accounts-payable", "应付账款"],
        ["#/master/items", "商品主档"],
        ["#/master/items/create", "商品主档-新增"],
        ["#/master/customers", "客户主档"],
        ["#/master/customers/create", "客户主档-新增"],
        ["#/master/suppliers", "供应商主档"],
        ["#/master/suppliers/create", "供应商主档-新增"],
        ["#/master/warehouses", "仓库主档"],
        ["#/master/warehouses/create", "仓库主档-新增"],
        ["#/master/units", "单位管理"],
        ["#/master/currencies", "币别管理"],
        ["#/master/categories", "商品分类"],
        ["#/master/shipping_methods", "物流方式"],
        ["#/master/payment_terms", "付款条件"],
        ["#/inventory/inventory_overview", "库存总览"],
        ["#/inventory/inventory_safety", "安全库存"],
        ["#/tools/migration-center", "Excel导入中心"],
        ["#/tools/system-backup", "系统备份"],
        ["#/users", "用户管理"],
        ["#/users/create", "用户管理-新增"],
        ["#/roles", "角色管理"],
        ["#/roles/create", "角色管理-新增"],
        ["#/permissions", "权限管理"]
    ];
    for (const [hash, label] of routes) {
        const before = errors.length;
        await page.goto(BASE + hash);
        await page.waitForTimeout(350);
        const h1 = await page.locator(".content h1, .content h2").first().textContent().catch(() => "");
        const err = errors.slice(before);
        ok(`${label} 渲染`, !!h1 && h1.trim().length > 0, "无标题或内容为空");
        if (err.length) { ok(`${label} 无JS错误`, false, err.join(" | ")); }
        else { pass++; console.log("  PASS " + label + " 无JS错误"); }
    }

    console.log("== 2. 销货订单查看页 + 编辑路由 ==");
    await page.goto(BASE + "#/sales-orders");
    await page.waitForTimeout(300);
    const viewHref = await page.locator('#soBody a[href^="#/sales-orders/"]').first().getAttribute("href");
    const soId = viewHref.split("/")[2];
    await page.goto(BASE + viewHref);
    await page.waitForTimeout(400);
    ok("销货订单查看页正常", (await page.locator(".content h1").first().textContent().catch(() => "")).includes("销货订单"), "跳回主页或异常");
    ok("查看页为只读（无表单）", await page.locator(".content form").count() === 0, "仍有表单");
    ok("查看页有打印按钮", await page.locator('.content button:has-text("打印")').count() > 0, "无打印按钮");
    // 从查看页点编辑，验证编辑路由不跳主页
    await page.click('.content a[href$="/edit"]');
    await page.waitForTimeout(400);
    ok("编辑页不跳主页", !(await page.locator(".content h1").first().textContent().catch(() => "")).includes("检核仪表板"));
    ok("编辑页正常", (await page.locator(".content h2").first().textContent().catch(() => "")).includes("编辑"), "不是编辑页");

    console.log("== 3. 出货单详情页 ==");
    await page.goto(BASE + "#/shipments");
    await page.waitForTimeout(300);
    const shipLink = await page.locator('a[href^="#/shipments/"]').first().getAttribute("href").catch(() => "");
    if (shipLink) {
        await page.goto(BASE + shipLink);
        await page.waitForTimeout(400);
        ok("出货单详情渲染", (await page.locator(".content h1").first().textContent().catch(() => "")).includes("出货单"));
    } else {
        ok("出货单详情渲染", false, "列表无出货单链接");
    }

    console.log("== 4. 新增销货订单 → 保存跳列表 ==");
    await page.goto(BASE + "#/sales-orders/create");
    await page.waitForTimeout(300);
    await page.selectOption('[name="customer_id"]', { index: 1 });
    await page.selectOption('[name="sales_owner"]', { index: 1 });
    await page.selectOption('#salesLines tbody tr select', { index: 1 });
    await page.fill('#salesLines tbody tr [name="qty[]"]', "2");
    await page.fill('#salesLines tbody tr [name="unit_price[]"]', "10");
    await page.click('button:has-text("保存销货订单")');
    await page.waitForTimeout(800);
    ok("保存后跳回列表页", page.url().includes("#/sales-orders"), page.url());
    const newSoCount = await db(() => DB.list("sales_orders").length);
    ok("订单已插入", newSoCount === 2, "count=" + newSoCount);

    console.log("== 5. 空明细保存被拦截 ==");
    await page.goto(BASE + "#/sales-orders/create");
    await page.waitForTimeout(300);
    await page.selectOption('[name="customer_id"]', { index: 1 });
    await page.selectOption('[name="sales_owner"]', { index: 1 });
    await page.click('button:has-text("保存销货订单")');
    await page.waitForTimeout(400);
    ok("空明细提示", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("至少新增一笔"), "无提示");

    console.log("== 6. 出货 → 已出货订单删除被拒 ==");
    await page.goto(BASE + "#/sales-orders");
    await page.waitForTimeout(300);
    // 取第一笔 draft 订单出货
    const firstRow = page.locator('#soBody tr').first();
    const shipBtn = firstRow.locator('button:has-text("出货")');
    if (await shipBtn.count()) {
        await shipBtn.click();
        await page.waitForTimeout(300);
        await page.selectOption("#shipWh", { index: 0 });
        await page.click('button:has-text("确认出货")');
        await page.waitForTimeout(600);
        // 尝试删除已出货订单
        await page.goto(BASE + "#/sales-orders");
        await page.waitForTimeout(300);
        await page.locator('#soBody tr').first().locator('button:has-text("删除")').click();
        await page.waitForTimeout(400);
        const toastText = await page.locator("#toastWrap").textContent().catch(() => "");
        ok("已出货订单删除被拒", toastText.includes("不能删除"), toastText);
        const modalCount = await page.locator(".modal-mask").count();
        ok("未弹出确认框", modalCount === 0);
    } else {
        ok("出货操作", false, "列表无出货按钮");
    }

    console.log("== 7. 收款：超限被拒 + 正常收款 ==");
    await page.goto(BASE + "#/accounting/accounts-receivable");
    await page.waitForTimeout(300);
    const payBtn = page.locator('button:has-text("登记收款")').first();
    if (await payBtn.count()) {
        await payBtn.click();
        await page.waitForTimeout(300);
        const amt = await page.locator("#payAmount").inputValue();
        await page.fill("#payAmount", "99999999");
        await page.click('button:has-text("确认收款")');
        await page.waitForTimeout(400);
        ok("超限收款被拒", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("不能超过未收金额"));
        await page.fill("#payAmount", amt);
        await page.click('button:has-text("确认收款")');
        await page.waitForTimeout(400);
        ok("正常收款成功", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("收款登记成功"));
    } else {
        ok("收款操作", false, "无可收款订单（需先有出货订单）");
    }

    console.log("== 8. 传票作业已移除：路由回首页 ==");
    await page.goto(BASE + "#/accounting/vouchers/create");
    await page.waitForTimeout(400);
    ok("传票新增路由已移除", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("找不到该页面") || (await page.locator("#app").textContent()).includes("上线检核仪表板"));
    await page.goto(BASE + "#/accounting/vouchers");
    await page.waitForTimeout(400);
    ok("传票列表路由已移除", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("找不到该页面") || (await page.locator("#app").textContent()).includes("上线检核仪表板"));
    const vouchersGone = await db(() => DB.list("vouchers").length === 0);
    ok("vouchers 集合已清空", vouchersGone);

    console.log("== 9. 本位币唯一 ==");
    const baseCount = await db(() => DB.list("currencies").filter(c => c.is_base).length);
    ok("种子仅一个本位币", baseCount === 1, "count=" + baseCount);
    await page.goto(BASE + "#/master/currencies");
    await page.waitForTimeout(300);
    await page.click('button:has-text("新增币别")');
    await page.waitForTimeout(300);
    await page.fill('#smForm [name="code"]', "TESTCUR");
    await page.fill('#smForm [name="name"]', "测试币");
    await page.fill('#smForm [name="rate"]', "7.5");
    await page.check('#smForm [name="is_base"]');
    await page.click('.modal-mask button:has-text("保存")');
    await page.waitForTimeout(400);
    const baseAfter = await db(() => DB.list("currencies").filter(c => c.is_base).length);
    ok("设新本位币后唯一", baseAfter === 1, "count=" + baseAfter);
    const newBase = await db(() => { const c = DB.find("currencies", x => x.code === "TESTCUR"); return c ? c.is_base : null; });
    ok("TESTCUR 为本位币", newBase === true);
    // 清理测试币别
    await page.goto(BASE + "#/master/currencies");
    await page.waitForTimeout(300);
    const rows = await page.locator("#app .table tbody tr").count();
    await page.locator("#app .table tbody tr").last().locator('button:has-text("删除")').click();
    await page.waitForTimeout(300);
    await page.click('.modal-mask button:has-text("确定")');
    await page.waitForTimeout(400);
    // 恢复 CNY 为本位币
    await db(() => { const c = DB.find("currencies", x => x.code === "CNY"); DB.update("currencies", c.id, { is_base: true }); });

    console.log("== 10. 库存调整：创建 → 删除回冲 ==");
    await page.goto(BASE + "#/inventory/inventory_adjust/create");
    await page.waitForTimeout(300);
    const itId1 = await db(() => DB.list("items")[0].id);
    const whId1 = await db(() => DB.list("warehouses")[0].id);
    const stockBefore = await db(({ wh, it }) => DB.stockOf(wh, it), { wh: whId1, it: itId1 });
    await page.selectOption('[name="warehouse_id"]', whId1);
    await page.selectOption('#adjLines tbody tr select', itId1);
    await page.fill('#adjLines tbody tr [name="qty[]"]', "7");
    await page.click('button:has-text("保存库存调整")');
    await page.waitForTimeout(800);
    const stockMid = await db(({ wh, it }) => DB.stockOf(wh, it), { wh: whId1, it: itId1 });
    ok("调整后库存 +7", stockMid === stockBefore + 7, stockBefore + " -> " + stockMid);
    // 删除该调整单 → 回冲
    await page.goto(BASE + "#/inventory/inventory_adjust");
    await page.waitForTimeout(300);
    await page.locator('button:has-text("删除")').first().click();
    await page.waitForTimeout(300);
    await page.click('.modal-mask button:has-text("确定")');
    await page.waitForTimeout(500);
    const stockAfter = await db(({ wh, it }) => DB.stockOf(wh, it), { wh: whId1, it: itId1 });
    ok("删除调整回冲库存", stockAfter === stockBefore, stockMid + " -> " + stockAfter);

    console.log("== 11. 未知路由提示 ==");
    await page.goto(BASE + "#/no-such-page-xyz");
    await page.waitForTimeout(500);
    ok("未知路由提示", (await page.locator("#toastWrap").textContent().catch(() => "")).includes("找不到该页面"));
    ok("未知路由回首页", (await page.locator(".content h1").first().textContent().catch(() => "")).includes("检核仪表板"));

    console.log("== 12. 权限路由拦截 ==");
    // 用销售角色登录，直接访问 users 被拒
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + "#/login");
    await page.fill('input[name="username"]', "sales");
    await page.fill('input[name="password"]', "123456");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    await page.goto(BASE + "#/users");
    await page.waitForTimeout(500);
    const deniedText = await page.locator("#toastWrap").textContent().catch(() => "");
    ok("无权限访问被拒", deniedText.includes("没有访问该页面的权限"), deniedText);
    ok("被拒后回首页", (await page.locator(".content h1").first().textContent().catch(() => "")).includes("检核仪表板"));

    console.log("== 13. 客户/商品搜索 ==");
    await page.goto(BASE + "#/master/customers");
    await page.waitForTimeout(300);
    await page.fill('.toolbar input', "不存在的客户名XYZ");
    await page.waitForTimeout(400);
    ok("客户搜索过滤", (await page.locator("#app .master-grid").textContent().catch(() => "")).includes("没有符合的客户"));
    await page.goto(BASE + "#/master/items");
    await page.waitForTimeout(300);
    await page.fill('.toolbar input', "ZZZZ不存在");
    await page.waitForTimeout(400);
    ok("商品搜索过滤", (await page.locator("#app .table").textContent().catch(() => "")).includes("没有符合的商品"));

    console.log("== 14. 侧边栏折叠持久化 ==");
    await page.goto(BASE + "#/dashboard");
    await page.waitForTimeout(300);
    await page.click('.topbar .icon-btn');
    await page.waitForTimeout(200);
    const collapsed1 = await page.evaluate(() => document.body.classList.contains("sidebar-collapsed"));
    ok("折叠生效", collapsed1);
    await page.goto(BASE + "#/sales-orders");
    await page.waitForTimeout(400);
    const collapsed2 = await page.evaluate(() => document.body.classList.contains("sidebar-collapsed"));
    ok("刷新/导航后折叠保持", collapsed2);
    // 恢复
    await page.click('.topbar .icon-btn');

    console.log("== 15. 深色模式切换 ==");
    await page.goto(BASE + "#/dashboard");
    await page.waitForTimeout(300);
    await page.click('.top-actions .icon-btn');
    await page.waitForTimeout(300);
    const dark1 = await page.evaluate(() => document.body.classList.contains("dark"));
    ok("深色模式开启", dark1);
    await page.click('.top-actions .icon-btn');
    await page.waitForTimeout(300);

    console.log("== 16. 菜单搜索 ==");
    // 重新以 admin 登录（admin 拥有全部菜单权限）
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + "#/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    await page.goto(BASE + "#/dashboard");
    await page.waitForTimeout(400);
    await page.fill("#sideSearch", "应收");
    await page.waitForTimeout(200);
    const menuVisible = await page.evaluate(() => {
        const links = [...document.querySelectorAll(".menu-link")];
        return links.filter(a => a.style.display !== "none").map(a => a.textContent.trim());
    });
    ok("菜单搜索过滤", menuVisible.length >= 1 && menuVisible.every(t => t.includes("应收")), JSON.stringify(menuVisible));
    await page.fill("#sideSearch", "");

    console.log("\n===== 结果：" + pass + " 通过 / " + fail + " 失败 =====");
    if (errors.length) {
        console.log("--- 页面 JS 错误汇总 ---");
        errors.slice(0, 10).forEach(e => console.log("  " + e));
    }
    await browser.close();
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(2); });
