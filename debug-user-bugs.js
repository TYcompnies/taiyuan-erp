// 验证用户报告的两个 bug 场景
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8902';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let pass = 0, fail = 0;
  const check = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

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

  // ===== 场景1：编辑销货订单不跳回主页 =====
  console.log('\n[场景1] 编辑销货订单');
  await page.evaluate(h => { location.hash = h; }, '#/sales-orders');
  await page.waitForTimeout(700);
  // 点击第一行的编辑链接
  await page.locator('a:has-text("编辑")').first().click();
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('销货订单｜编辑'), '点编辑进入编辑表单页（未跳回主页）');
  check((await page.textContent('body')).includes('保存销货订单'), '编辑页有保存按钮');

  // ===== 场景2：点击出货单号显示详情 =====
  console.log('\n[场景2] 出货单详情');
  await page.evaluate(h => { location.hash = h; }, '#/shipments');
  await page.waitForTimeout(700);
  const shLink = await page.locator('a[href^="#/shipments/"]').count();
  check(shLink > 0, `出货单号是可点击链接 (${shLink} 个)`);
  await page.locator('a[href^="#/shipments/"]').first().click();
  await page.waitForTimeout(700);
  const body = await page.textContent('body');
  check(body.includes('出货单｜SH'), '出货单详情页渲染');
  check(body.includes('收件人'), '详情含收件人资料');
  check(body.includes('出货金额'), '详情含金额统计');

  // ===== 场景3：直接访问编辑路由不跳回主页 =====
  console.log('\n[场景3] 编辑路由直达');
  const soId = await page.evaluate(() => DB.list('sales_orders')[0].id);
  await page.evaluate(id => { location.hash = '#/sales-orders/' + id + '/edit'; }, soId);
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('销货订单｜编辑'), '直达 /sales-orders/<id>/edit 显示编辑页');

  // ===== 场景4：出货单详情路由直达 =====
  console.log('\n[场景4] 出货单详情直达');
  const shId = await page.evaluate(() => DB.list('shipments')[0].id);
  await page.evaluate(id => { location.hash = '#/shipments/' + id; }, shId);
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('出货单｜SH'), '直达 /shipments/<id> 显示详情页');

  console.log(`\n== 用户场景验证: ${pass} 通过, ${fail} 失败 ==`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
