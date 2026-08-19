/* 实测：销货订单查看页 + 销货订单/出货单打印窗口 */
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8902/";

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", e => console.log("PAGEERROR:", e.message));

    await page.goto(BASE + "#/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });

    // ===== 1. 销货订单列表 → 查看页 =====
    await page.goto(BASE + "#/sales-orders");
    await page.waitForTimeout(500);
    // 第一行操作列应有 查看/编辑/打印
    const actions = await page.locator('tbody tr:first-child .action-col').innerText();
    console.log("销货订单操作列:", actions.replace(/\s+/g, " ").trim());

    await page.click('tbody tr:first-child td:nth-child(1) a');
    await page.waitForTimeout(600);
    const h1 = await page.locator(".content h1").first().textContent();
    console.log("查看页 H1:", h1);
    const isForm = await page.locator("form").count();
    console.log("查看页是否表单(应为0):", isForm);
    const printBtns = await page.locator('.content button:has-text("打印")').count();
    console.log("查看页打印按钮数:", printBtns);
    await page.screenshot({ path: "shots/view-sales-order.png", fullPage: true });

    // ===== 2. 查看页点打印 → 弹出打印窗口 =====
    const popupP = page.waitForEvent("popup", { timeout: 5000 });
    await page.click('.content button:has-text("打印")');
    const popup = await popupP;
    await popup.waitForLoadState("domcontentloaded");
    await popup.waitForTimeout(600);
    const pt = await popup.title();
    const pHead = await popup.locator(".doc-head .company").textContent();
    const pTitle = await popup.locator(".doc-title").textContent();
    const pUp = await popup.locator(".totals .up").textContent();
    const pRows = await popup.locator("table tbody tr").count();
    console.log("打印窗口标题:", pt);
    console.log("打印抬头:", pHead, "| 单据名:", pTitle.replace(/\s+/g, ""));
    console.log("大写金额:", pUp);
    console.log("明细行数:", pRows);
    await popup.screenshot({ path: "shots/print-sales-order.png", fullPage: true });
    await popup.close();

    // ===== 3. 出货单详情 → 打印 =====
    await page.goto(BASE + "#/shipments/sh1");
    await page.waitForTimeout(600);
    const h2 = await page.locator(".content h1").first().textContent();
    console.log("出货单详情 H1:", h2);
    const shPrint = page.locator('.content button:has-text("打印")').count();
    console.log("出货单详情打印按钮数:", shPrint);

    const popup2P = page.waitForEvent("popup", { timeout: 5000 });
    await page.click('.content button:has-text("打印")');
    const popup2 = await popup2P;
    await popup2.waitForLoadState("domcontentloaded");
    await popup2.waitForTimeout(600);
    const p2Head = await popup2.locator(".doc-head .company").textContent();
    const p2Title = await popup2.locator(".doc-title").textContent();
    const p2Meta = await popup2.locator(".meta").first().innerText();
    const p2Up = await popup2.locator(".totals .up").textContent();
    const p2Sign = await popup2.locator(".sign").innerText();
    console.log("出货单打印抬头:", p2Head, "| 单据名:", p2Title.replace(/\s+/g, ""));
    console.log("出货单打印 meta:", p2Meta.replace(/\s+/g, " "));
    console.log("出货单大写:", p2Up);
    console.log("签收栏:", p2Sign.replace(/\s+/g, " "));
    await popup2.screenshot({ path: "shots/print-shipment.png", fullPage: true });
    await popup2.close();

    // ===== 4. 出货单列表操作列 =====
    await page.goto(BASE + "#/shipments");
    await page.waitForTimeout(500);
    const shActions = await page.locator('tbody tr:first-child .action-col').innerText();
    console.log("出货单列表操作列:", shActions.replace(/\s+/g, " ").trim());

    await browser.close();
    console.log("DONE");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
