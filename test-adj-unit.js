/* ============================================================
   test-adj-unit.js — 样品领料：多单位领用 + 库存自动换算（v20260906a）
   需求：样品领料「可领单位为盒、包」，输入领几盒或领几包，库存自动换算。
   实现：明细「单位」改为下拉（商品可用单位：库存/销售/采购/最小单位，含换算率），
   领用数量 × 换算率 = 库存单位异动量；line.qty 存库存单位数量，
   另存 claim_qty/claim_unit/rate；列表显示领用数量与换算结果。
   验证：
   A1 表头「领用数量(+/-)/领用单位」；行内单位为下拉
   A2 选商品后单位下拉选项与换算率（盒=1 / 箱=24 / 包=1÷12）
   A3 领 -24 包 → 预览 10 盒 → 8 盒 + 换算提示
   A4 切换单位为箱 → 预览按 24 换算
   A5 保存 → 落库 qty=-2(盒)、claim_qty=-24、claim_unit=包；库存 8
   A6 列表页显示「-24 包」与「= -2 盒」
   A7 再领 1 箱（采购单位）→ 库存 8+24=32
   A8 删除两笔 → 库存回冲至 10
   A9 旧格式记录（无 claim 字段）列表兼容渲染
   A10 默认库存单位领用（rate=1）行为不变
   ============================================================ */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8904";

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
        await page.evaluate(h => { if (location.hash === h && typeof route === "function") { route(location.hash); } else { location.hash = h; } }, hash);
        await page.waitForTimeout(1100);
    }
    const db = (fn, arg) => page.evaluate(({ src, a }) => eval("(" + src + ")")(a), { src: fn.toString(), a: arg });

    console.log("== 注入数据：CL0001（库存=盒；1 盒=12 包；1 箱(采购)=24 盒）初始 10 盒 ==");
    await db(() => {
        ["盒", "包", "箱"].forEach(u => { if (!DB.find("units", x => x.name === u)) DB.insert("units", { name: u }); });
        DB.remove("items", "it_cl001");
        DB.list("inventory_adjusts").filter(a => /CLTEST/.test(a.source_no || "") || a.remark === "adj-unit-test").forEach(a => DB.remove("inventory_adjusts", a.id));
        DB.insert("items", {
            id: "it_cl001", code: "CL0001", name: "多单位领用测试品", spec: "1盒=12包",
            brand: "测试", category_id: "", product_type: "成品",
            sales_unit: "盒", purchase_unit: "箱", stock_unit: "盒",
            sales_unit2: "包", stock_unit2: "包",
            sales_to_stock: 1, purchase_to_stock: 24,
            sales_to_stock2: 12, purchase_to_stock2: 288,
            cost: 2, price: 5, min_price: 4, purchase_currency: "CNY",
            safety_stock: 0, max_stock: 9999, safety_stock2: 0, max_stock2: 99999,
            weight: 0, volume: 0, length_cm: 0, width_cm: 0, height_cm: 0,
            barcode: "", qrcode: "", remark: "", disabled: false
        });
        const wh = DB.list("warehouses")[0];
        const cur = DB.stockOf(wh.id, "it_cl001");
        if (cur) DB.addStock(wh.id, "it_cl001", -cur);
        DB.addStock(wh.id, "it_cl001", 10); // 10 盒
        return true;
    });

    console.log("== A1 表单结构 ==");
    await gotoHash("#/inventory/inventory_adjust/create");
    const a1 = await page.evaluate(() => {
        const ths = [...document.querySelectorAll("#adjLines thead th")].map(t => t.textContent.trim());
        const unitEl = document.querySelector('#adjLines tbody tr [name="unit[]"]');
        return { ths, isSelect: unitEl ? unitEl.tagName : "none" };
    });
    check(a1.ths.includes("领用数量(+)".replace("+", "(+/-)")) || a1.ths.includes("领用数量(+/-)"), `A1 明细表头含「领用数量(+/-)」（实际: ${a1.ths.join("|")}）`);
    check(a1.ths.includes("领用单位"), `A1 明细表头含「领用单位」`);
    check(a1.isSelect === "SELECT", `A1 单位列为下拉 select（实际: ${a1.isSelect}）`);

    console.log("== A2 选商品后可领单位与换算率 ==");
    const whId = await db(() => DB.list("warehouses")[0].id);
    await page.evaluate(({ wh }) => {
        const sel = document.querySelector("#adjLines [name='item_id[]']");
        const opt = [...sel.options].find(o => o.value === "it_cl001");
        if (opt) { sel.value = "it_cl001"; Pages.syncAdjItem(sel); }
        const whSel = document.querySelector('[name="warehouse_id"]');
        if (whSel && whSel.value !== wh) { whSel.value = wh; }
    }, { wh: whId });
    await page.waitForTimeout(400);
    const a2 = await page.evaluate(() => {
        const us = document.querySelector('#adjLines tbody tr [name="unit[]"]');
        return [...us.options].map(o => ({ v: o.value, rate: o.dataset.rate, t: o.textContent.trim(), sel: o.selected }));
    });
    console.log("  单位选项:", JSON.stringify(a2));
    const optOf = (u) => a2.find(o => o.v === u);
    check(a2.length === 3, `A2 共 3 个可领单位：盒/箱/包（实际: ${a2.map(o => o.v).join(",")}）`);
    check(optOf("盒") && Number(optOf("盒").rate) === 1 && optOf("盒").sel, `A2 默认库存单位「盒」rate=1`);
    check(optOf("箱") && Number(optOf("箱").rate) === 24, `A2 采购单位「箱」rate=24`);
    check(optOf("包") && Math.abs(Number(optOf("包").rate) - 1 / 12) < 1e-9, `A2 最小单位「包」rate=1/12`);
    check(optOf("包") && /最小单位/.test(optOf("包").t), `A2 「包」标注（最小单位）`);

    console.log("== A3 领 -24 包 → 预览 10 盒 → 8 盒 ==");
    await page.selectOption('#adjLines tbody tr [name="unit[]"]', "包");
    await page.fill('#adjLines tbody tr [name="qty[]"]', "-24");
    await page.waitForTimeout(400);
    const a3 = await page.evaluate(() => {
        const row = document.querySelector("#adjLines tbody tr");
        return { before: row.querySelector(".before-qty").textContent, after: row.querySelector(".after-qty").textContent, hint: (row.querySelector(".adj-conv") || {}).textContent || "" };
    });
    console.log("  预览:", JSON.stringify(a3));
    check(a3.before === "10 盒", `A3 异动前 10 盒（实际: ${a3.before}）`);
    check(a3.after === "8 盒", `A3 异动后 8 盒（实际: ${a3.after}）`);
    check(a3.hint.includes("-24 包") && a3.hint.includes("= -2 盒"), `A3 换算提示「-24 包 × … = -2 盒」（实际: ${a3.hint}）`);

    console.log("== A4 切单位为箱 → 按 24 换算 ==");
    await page.selectOption('#adjLines tbody tr [name="unit[]"]', "箱");
    await page.fill('#adjLines tbody tr [name="qty[]"]', "1");
    await page.waitForTimeout(400);
    const a4 = await page.evaluate(() => {
        const row = document.querySelector("#adjLines tbody tr");
        return { after: row.querySelector(".after-qty").textContent, hint: (row.querySelector(".adj-conv") || {}).textContent || "" };
    });
    console.log("  预览:", JSON.stringify(a4));
    check(a4.after === "34 盒", `A4 1 箱 → 10+24=34 盒（实际: ${a4.after}）`);
    check(a4.hint.includes("1 箱") && a4.hint.includes("= 24 盒"), `A4 换算提示「1 箱 × 24 = 24 盒」（实际: ${a4.hint}）`);

    console.log("== A5 保存「-24 包」→ 落库换算 + 库存 8 盒 ==");
    await page.selectOption('#adjLines tbody tr [name="unit[]"]', "包");
    await page.fill('#adjLines tbody tr [name="qty[]"]', "-24");
    await page.waitForTimeout(300);
    await page.evaluate(() => { const b = document.querySelector('#adjForm button[type=submit]'); if (b) b.scrollIntoView({ block: "center" }); });
    await page.waitForTimeout(400);
    await page.click('#adjForm button[type=submit]');
    await page.waitForTimeout(900);
    const a5 = await db(() => {
        const a = DB.list("inventory_adjusts").sort((x, y) => y.no.localeCompare(x.no))[0];
        const wh = DB.list("warehouses")[0];
        return a ? { l: a.lines[0], stock: DB.stockOf(wh.id, "it_cl001") } : null;
    });
    console.log("  落库:", JSON.stringify(a5));
    check(a5 && a5.l.qty === -2 && a5.l.unit === "盒", `A5 line.qty=-2 盒（实际: ${a5 && a5.l.qty} ${a5 && a5.l.unit}）`);
    check(a5 && a5.l.claim_qty === -24 && a5.l.claim_unit === "包", `A5 claim_qty=-24 包（实际: ${a5 && a5.l.claim_qty} ${a5 && a5.l.claim_unit}）`);
    check(a5 && Math.abs(a5.l.rate - 1 / 12) < 1e-9, `A5 rate=1/12（实际: ${a5 && a5.l.rate}）`);
    check(a5 && a5.l.after === 8, `A5 after=8（实际: ${a5 && a5.l.after}）`);
    check(a5 && a5.stock === 8, `A5 库存 10-2=8 盒（实际: ${a5 && a5.stock}）`);

    console.log("== A6 列表页显示领用数量与换算结果 ==");
    await gotoHash("#/inventory/inventory_adjust");
    const a6 = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".table tbody tr")];
        const row = rows.find(r => r.textContent.includes("CL0001"));
        return row ? row.textContent.replace(/\s+/g, " ") : "";
    });
    console.log("  列表行:", a6);
    check(/-24 包/.test(a6), `A6 列表显示「-24 包」`);
    check(/= -2 盒/.test(a6), `A6 列表显示换算「= -2 盒」`);

    console.log("== A7 再领 1 箱 → 库存 32 盒 ==");
    await gotoHash("#/inventory/inventory_adjust/create");
    await page.evaluate(() => {
        const sel = document.querySelector("#adjLines [name='item_id[]']");
        const opt = [...sel.options].find(o => o.value === "it_cl001");
        if (opt) { sel.value = "it_cl001"; Pages.syncAdjItem(sel); }
    });
    await page.waitForTimeout(400);
    await page.selectOption('#adjLines tbody tr [name="unit[]"]', "箱");
    await page.fill('#adjLines tbody tr [name="qty[]"]', "1");
    await page.waitForTimeout(300);
    await page.evaluate(() => { const b = document.querySelector('#adjForm button[type=submit]'); if (b) b.scrollIntoView({ block: "center" }); });
    await page.waitForTimeout(400);
    await page.click('#adjForm button[type=submit]');
    await page.waitForTimeout(900);
    const a7 = await db(() => {
        const wh = DB.list("warehouses")[0];
        const list = DB.list("inventory_adjusts").sort((x, y) => y.no.localeCompare(x.no));
        return { stock: DB.stockOf(wh.id, "it_cl001"), latest: list[0].lines[0] };
    });
    console.log("  ", JSON.stringify(a7));
    check(a7.stock === 32, `A7 库存 8+24=32 盒（实际: ${a7.stock}）`);
    check(a7.latest.qty === 24 && a7.latest.claim_unit === "箱" && a7.latest.claim_qty === 1, `A7 第二笔 claim=1 箱 → qty=24 盒`);

    console.log("== A8 删除两笔 → 库存回冲至 10 盒 ==");
    const twoIds = await db(() => DB.list("inventory_adjusts").sort((x, y) => y.no.localeCompare(x.no)).slice(0, 2).map(a => a.id));
    for (const id of twoIds) {
        await page.evaluate(i => Pages.deleteAdj(i), id);
        await page.waitForTimeout(300);
        await page.click("#confirmOkBtn");
        await page.waitForTimeout(700);
    }
    const a8 = await db(() => DB.stockOf(DB.list("warehouses")[0].id, "it_cl001"));
    check(a8 === 10, `A8 删除后库存回冲 10 盒（实际: ${a8}）`);

    console.log("== A9 旧格式记录（无 claim 字段）列表兼容 ==");
    await db(() => {
        DB.insert("inventory_adjusts", {
            no: "ADJOLD001", warehouse_id: DB.list("warehouses")[0].id, type: "调整",
            source_type: "盘点", source_no: "CLTEST-OLD", lines: [
                { item_id: "it_cl001", code: "CL0001", name: "多单位领用测试品", qty: 3, unit: "盒", before: 10, after: 13, remark: "" }
            ], remark: "adj-unit-test", created_by: "测试", created_at: new Date().toISOString()
        });
        return true;
    });
    await gotoHash("#/inventory/inventory_adjust");
    const a9ok = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".table tbody tr")];
        const row = rows.find(r => r.textContent.includes("ADJOLD001"));
        return row ? !/undefined|NaN/.test(row.textContent) && /\+3 盒/.test(row.textContent.replace(/\s+/g, " ")) : false;
    });
    check(a9ok, `A9 旧格式记录正常渲染「+3 盒」无 undefined/NaN`);
    await db(() => { const a = DB.list("inventory_adjusts").find(x => x.no === "ADJOLD001"); if (a) DB.remove("inventory_adjusts", a.id); return true; });

    console.log("== A10 默认库存单位领用（rate=1）行为不变 ==");
    await gotoHash("#/inventory/inventory_adjust/create");
    await page.evaluate(() => {
        const sel = document.querySelector("#adjLines [name='item_id[]']");
        const opt = [...sel.options].find(o => o.value === "it_cl001");
        if (opt) { sel.value = "it_cl001"; Pages.syncAdjItem(sel); }
    });
    await page.waitForTimeout(400);
    await page.fill('#adjLines tbody tr [name="qty[]"]', "5");
    await page.waitForTimeout(300);
    await page.evaluate(() => { const b = document.querySelector('#adjForm button[type=submit]'); if (b) b.scrollIntoView({ block: "center" }); });
    await page.waitForTimeout(400);
    await page.click('#adjForm button[type=submit]');
    await page.waitForTimeout(900);
    const a10 = await db(() => {
        const wh = DB.list("warehouses")[0];
        const a = DB.list("inventory_adjusts").sort((x, y) => y.no.localeCompare(x.no))[0];
        return { stock: DB.stockOf(wh.id, "it_cl001"), qty: a.lines[0].qty, claim_unit: a.lines[0].claim_unit };
    });
    console.log("  ", JSON.stringify(a10));
    check(a10.stock === 15 && a10.qty === 5 && a10.claim_unit === "盒", `A10 默认单位 +5 盒 → 库存 15（实际: ${a10.stock}, qty=${a10.qty}, unit=${a10.claim_unit}）`);
    // 清理：删除最后一笔，库存回 10
    await db(() => {
        const a = DB.list("inventory_adjusts").sort((x, y) => y.no.localeCompare(x.no))[0];
        DB.addStock(a.warehouse_id, a.lines[0].item_id, -a.lines[0].qty);
        DB.remove("inventory_adjusts", a.id);
        return true;
    });

    console.log("\n========== 结果: " + pass + " 通过 / " + fail + " 失败 ==========");
    await browser.close();
    process.exit(fail ? 1 : 0);
})();
