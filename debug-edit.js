// 调试：编辑销货订单流程
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8902';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });

  // 登录
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const inputs = page.locator('#loginForm input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder') || '';
    if (/账号|用户/i.test(ph)) await inputs.nth(i).fill('admin');
    if (/密码/i.test(ph)) await inputs.nth(i).fill('admin123');
  }
  await page.locator('#loginForm button[type=submit]').click();
  await page.waitForTimeout(1000);

  // 找最新订单 id
  const so = await page.evaluate(() => {
    const o = DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, qty: o.lines[0].qty } : null;
  });
  console.log('最新订单:', JSON.stringify(so));

  // 进入编辑页
  await page.evaluate(h => { location.hash = h; }, '#/sales-orders/' + so.id + '/edit');
  await page.waitForTimeout(800);

  console.log('URL:', page.url());
  console.log('H1/H2:', await page.evaluate(() => Array.from(document.querySelectorAll('h1,h2')).map(e => e.textContent.trim()).join(' | ')));
  console.log('保存按钮:', await page.locator('button:has-text("保存销货订单")').count());
  console.log('标题含编辑:', (await page.textContent('body')).includes('编辑'));

  // dump 明细行
  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#salesLines tbody tr')).map(tr => {
      const qty = tr.querySelector('[name="qty[]"]');
      const item = tr.querySelector('[name="item_id[]"]');
      return { qty: qty ? qty.value : null, item: item ? item.value : null };
    });
  });
  console.log('明细行:', JSON.stringify(rows));

  // 修改第一行 qty
  await page.locator('#salesLines tbody tr').first().locator('[name="qty[]"]').fill('4');
  await page.waitForTimeout(400);
  const afterFill = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#salesLines tbody tr')).map(tr => {
      const qty = tr.querySelector('[name="qty[]"]');
      return qty ? qty.value : null;
    });
  });
  console.log('fill 后 qty:', JSON.stringify(afterFill));
  console.log('line-amount:', await page.evaluate(() => Array.from(document.querySelectorAll('#salesLines .line-amount')).map(e => e.textContent)));

  // 提交
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(1000);
  const saved = await page.evaluate(id => {
    const o = DB.get('sales_orders', id);
    return { qty: o.lines[0].qty, inv: o.invoice_amount, taxable: o.taxable_amount, tax: o.tax_amount };
  }, so.id);
  console.log('保存后:', JSON.stringify(saved));
  console.log('toast:', (await page.locator('.toast').allTextContents()).join(' '));

  await browser.close();
})();
