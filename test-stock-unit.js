/* ============================================================
   test-stock-unit.js — 库存数量与单位标注回归测试
   场景：商品「VIET COFFEE麝香貓咖啡」1箱=12袋（换算率12），
   采购 10 箱入库 → 库存应为 120 袋。
   验证：商品主档列表/库存总览/仪表板低库存提醒 均显示单位「袋」，
   数字不再被误读为销售单位「箱」。
   ============================================================ */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8902";

let pass = 0, fail = 0;
const check = (cond, msg) => {
    if (cond) { pass++; console.log("  PASS " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
};

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const inputs = page.locator("#loginForm input");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
        const ph = await inputs.nth(i).getAttribute("placeholder") || "";
        if (/账号|用户/i.test(ph)) await inputs.nth(i).fill("admin");
        if (/密码/i.test(ph)) await inputs.nth(i).fill("admin123");
    }
    await page.locator("#loginForm button[type=submit]").click();
    await page.waitForTimeout(1000);

    async function gotoHash(hash) {
        await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach(m => m.remove()));
        await page.evaluate(h => { location.hash = h; }, hash);
        await page.waitForTimeout(1100);
    }
    const db = (fn, arg) => page.evaluate(({ src, a }) => eval("(" + src + ")")(a), { src: fn.toString(), a: arg });

    console.log("== 注入数据：VIET COFFEE麝香貓咖啡（1箱12袋）+ 采购单 10 箱 + 进货入库 ==");
    await db(() => {
        // 清理可能残留的同名测试数据
        ["it_civet", "po_civet"].forEach(id => {
            DB.remove("items", id); DB.remove("purchase_orders", id);
        });
        DB.insert("items", {
            id: "it_civet", code: "605900002", name: "VIET COFFEE麝香貓咖啡", english_name: "VIET COFFEE Civet",
            spec: "100g*12罐/箱", brand: "VIET COFFEE", model: "", category_id: DB.list("categories")[0].id,
            product_type: "成品", sales_unit: "箱", purchase_unit: "箱", stock_unit: "袋",
            sales_to_stock: 12, purchase_to_stock: 12, cost: 350, price: 520, min_price: 480,
            purchase_currency: "CNY", safety_stock: 50, max_stock: 1000, weight: 0, volume: 0,
            remark: "库存单位标注测试", disabled: false
        });
        const wh = DB.list("warehouses")[0];
        const sp = DB.list("suppliers")[0];
        DB.insert("purchase_orders", {
            id: "po_civet", no: "PO20260820001", supplier_id: sp.id, warehouse_id: wh.id,
            order_date: "2026-08-20", delivery_date: "", status: "received", currency: "CNY",
            price_tax_mode: "含税", tax_type: "不计税", tax_rate: 0, shipping_fee: 0,
            taxable_amount: 3500, tax_amount: 0, amount: 3500,
            lines: [{ item_id: "it_civet", code: "605900002", name: "VIET COFFEE麝香貓咖啡", qty: 10, unit: "箱", unit_price: 350, amount: 3500, remark: "" }],
            remark: "", created_by: "系统管理员", created_at: "2026-08-20 09:00:00"
        });
        DB.addStock(wh.id, "it_civet", 120); // 进货 10 箱 × 12 = 120 袋
        return true;
    });

    console.log("== 1. 商品主档列表：库存 / 安全 列应显示「120 袋 / 50 袋」 ==");
    await gotoHash("#/master/items");
    const itemRow = await page.evaluate(() => {
        const tr = [...document.querySelectorAll("#app table tbody tr")].find(r => r.textContent.includes("605900002"));
        if (!tr) return null;
        return tr.querySelector("td:nth-child(9)").textContent.replace(/\s+/g, " ").trim();
    });
    console.log("  库存/安全单元格:", JSON.stringify(itemRow));
    check(itemRow && /120\s*袋/.test(itemRow), `商品列表库存含「袋」单位（实际: ${itemRow || "未找到行"}}）`);
    check(itemRow && /50\s*袋/.test(itemRow), `商品列表安全库存含「袋」单位（实际: ${itemRow}）`);

    console.log("== 2. 库存总览：VIET COFFEE 行显示 120 袋 ==");
    await gotoHash("#/inventory/inventory_overview");
    const invCell = await page.evaluate(() => {
        const tr = [...document.querySelectorAll("#app table tbody tr")].find(r => r.textContent.includes("605900002"));
        if (!tr) return null;
        const cells = [...tr.querySelectorAll("td")];
        return { unit: cells[7].textContent.trim(), qty: cells[8].textContent.replace(/\s+/g, " ").trim() };
    });
    console.log("  库存总览:", JSON.stringify(invCell));
    check(invCell && invCell.unit === "袋", `库存单位列显示「袋」（实际: ${invCell && invCell.unit}）`);
    check(invCell && /^120/.test(invCell.qty), `库存 120 袋（实际: ${invCell && invCell.qty}）`);

    console.log("== 3. 仪表板低库存提醒：数字带单位 ==");
    // 安全库存 50，库存 120 > 50，不触发低库存；改用另一商品验证负库存区单位
    await db(() => {
        const it = DB.get("items", "it_civet");
        DB.update("items", "it_civet", { safety_stock: 500 }); // 让 120 < 500 → 触发低库存提醒
        DB.addStock(DB.list("warehouses")[0].id, "it_civet", -240); // 库存 → -120 → 触发负库存
        return true;
    });
    await gotoHash("#/dashboard");
    const dashText = await page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
    check(/605900002[^：]*：-120 袋|605900002[^/]*袋/.test(dashText), `仪表板负库存/低库存带「袋」单位`);
    const dashHit = dashText.match(/605900002[^。]*?(袋|箱)/);
    console.log("  仪表板命中:", dashHit ? dashHit[0] : "（未在仪表板文本中找到）");

    console.log("== 4. 样品领料单：异动前/后预览带单位 ==");
    await gotoHash("#/inventory/inventory_adjust/create");
    const whSel = page.locator('[name="warehouse_id"]');
    if (await whSel.count()) {
        await whSel.first().selectOption({ index: 1 });
        await page.waitForTimeout(300);
    }
    await page.evaluate(() => {
        const sel = document.querySelector("#adjLines [name='item_id[]']");
        const opt = [...sel.options].find(o => o.value === "it_civet");
        if (opt) { sel.value = "it_civet"; Pages.syncAdjItem(sel); }
    });
    await page.waitForTimeout(300);
    const qtyInp = page.locator("#adjLines [name='qty[]']");
    await qtyInp.fill("12");
    await page.waitForTimeout(300);
    const preview = await page.evaluate(() => {
        const row = document.querySelector("#adjLines tbody tr");
        return { before: row.querySelector(".before-qty").textContent, after: row.querySelector(".after-qty").textContent };
    });
    console.log("  调整预览:", JSON.stringify(preview));
    check(preview.before.includes("袋") && preview.after.includes("袋"), `调整单异动前/后带「袋」单位（实际: ${preview.before} → ${preview.after}）`);

    console.log("\n========== 结果: " + pass + " 通过 / " + fail + " 失败 ==========");
    await browser.close();
    process.exit(fail ? 1 : 0);
})();
