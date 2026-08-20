// 线上站点端到端验证（GitHub Pages）
const { chromium } = require('playwright');

(async () => {
  const URL = 'https://tycompnies.github.io/taiyuan-erp/';
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', err => errors.push(err.message));

  let pass = 0, fail = 0;
  const check = (cond, msg) => { if (cond) { pass++; console.log('  PASS:', msg); } else { fail++; console.error('  FAIL:', msg); } };

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  check(await page.locator('input[type=password]').count() > 0, '线上登录页渲染');

  const inputs = page.locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder') || '';
    if (/用户|账号|帐号|username/i.test(ph)) await inputs.nth(i).fill('admin');
    if (/密码|password/i.test(ph)) await inputs.nth(i).fill('admin123');
  }
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(1500);

  let body = await page.textContent('body');
  check(body.includes('仪表板'), '线上登录成功并显示仪表板');
  check(body.includes('钛沅商贸'), '线上页面显示公司名');

  // 展开菜单并进入销货订单
  const g = page.locator('.menu-main').filter({ hasText: '日常作业' });
  if (await g.count()) {
    const open = await g.first().evaluate(el => el.parentElement.classList.contains('open'));
    if (!open) { await g.first().click(); await page.waitForTimeout(300); }
  }
  await page.locator('.menu-link').filter({ hasText: '销货订单' }).first().click();
  await page.waitForTimeout(1000);
  body = await page.textContent('body');
  check(body.includes('销货订单') && !body.includes('SO2026') && body.includes('共 0 笔销货订单'), '线上销货订单页为空（业务数据已清空）');
  check(errors.length === 0, '线上无 JS 错误' + (errors.length ? ' -> ' + errors.join(' | ') : ''));

  console.log(`\n== 线上验证: ${pass} 通过, ${fail} 失败 ==`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
