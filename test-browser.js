// ERP 复刻系统浏览器冒烟测试（v2 - 修复侧边栏分组折叠问题）
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8902';

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

  const shots = 'C:/Users/CK302/WorkBuddy/2026-08-19-09-19-03/erp-clone/shots';
  const fs = require('fs');
  if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });

  let pass = 0, fail = 0;
  const check = (cond, msg) => {
    if (cond) { pass++; console.log('  PASS:', msg); }
    else { fail++; console.error('  FAIL:', msg); }
  };

  // 展开侧边栏分组后点击菜单链接（菜单分组默认折叠）
  async function navTo(group, label) {
    const groupBtn = page.locator('.menu-main').filter({ hasText: group });
    if (await groupBtn.count()) {
      const isOpen = await groupBtn.first().evaluate(el => el.parentElement.classList.contains('open'));
      if (!isOpen) { await groupBtn.first().click(); await page.waitForTimeout(300); }
    }
    await page.locator('.menu-link').filter({ hasText: label }).first().click();
    await page.waitForTimeout(900);
  }

  // 1. 打开登录页
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check(await page.locator('text=登录').count() > 0 || await page.locator('input[type=password]').count() > 0, '登录页渲染（有登录表单）');
  check((await page.content()).includes('义乌市钛沅商贸有限公司') || (await page.content()).includes('钛沅商贸'), '登录页显示公司名');
  await page.screenshot({ path: shots + '/01-login.png', fullPage: true });

  // 2. 登录
  const inputs = page.locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder') || '';
    if (/用户|账号|帐号|username|admin/i.test(ph)) await inputs.nth(i).fill('admin');
    if (/密码|password/i.test(ph)) await inputs.nth(i).fill('admin123');
  }
  await page.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await page.waitForTimeout(1200);

  // 3. 仪表板
  let bodyText = await page.textContent('body');
  check(bodyText.includes('仪表板') || bodyText.includes('看板') || bodyText.includes('检核'), '登录后进入仪表板');
  check(bodyText.includes('钛沅商贸') || bodyText.includes('义乌市钛沅商贸'), '仪表板显示公司名');
  check(bodyText.includes('销货') && bodyText.includes('采购'), '仪表板含业务模块入口');
  check(await page.locator('.sidebar').count() === 1, '侧边栏渲染');
  await page.screenshot({ path: shots + '/02-dashboard.png', fullPage: true });

  // 4. 销货订单（日常作业组，业务数据已清空应显示空态）
  await navTo('日常作业', '销货订单');
  let t2 = await page.textContent('body');
  check(t2.includes('销货订单') && t2.includes('新增'), '销货订单列表页渲染');
  check(!t2.includes('SO2026') && t2.includes('共 0 笔销货订单'), '销货订单列表为空（业务数据已清空）');
  await page.screenshot({ path: shots + '/03-sales-orders.png', fullPage: true });

  // 5. 采购单页（日常作业组，菜单文案为"采购单"）
  await navTo('日常作业', '采购单');
  t2 = await page.textContent('body');
  check(t2.includes('采购') && !t2.includes('PO2026') && t2.includes('暂无采购单'), '采购单列表为空（业务数据已清空）');
  await page.screenshot({ path: shots + '/04-purchase.png', fullPage: true });

  // 6. 商品主档（基本资料组，商品已清空应显示空态）
  await navTo('基本资料', '商品主档');
  t2 = await page.textContent('body');
  check(!t2.includes('越南') && t2.includes('没有符合的商品'), '商品主档列表为空（商品已清空）');
  await page.screenshot({ path: shots + '/05-items.png', fullPage: true });

  // 7. 库存总览（报表查询组）
  await navTo('报表查询', '库存总览');
  t2 = await page.textContent('body');
  check(t2.includes('库存'), '库存总览页渲染');
  await page.screenshot({ path: shots + '/06-inventory.png', fullPage: true });

  // 8. 应收账款（进销存账款组）
  await navTo('进销存账款', '应收账款');
  t2 = await page.textContent('body');
  check(t2.includes('应收账款') && t2.includes('收款'), '应收账款页渲染');
  await page.screenshot({ path: shots + '/07-ar.png', fullPage: true });

  // 9. 用户管理（系统设置组）
  await navTo('系统设置', '用户管理');
  t2 = await page.textContent('body');
  check(t2.includes('系统管理员') && t2.includes('admin'), '用户管理页渲染');
  await page.screenshot({ path: shots + '/08-users.png', fullPage: true });

  // 10. 退出登录（顶部按钮文案为"登出"）
  await page.locator('.logout').first().click();
  await page.waitForTimeout(800);
  check(await page.locator('input[type=password]').count() > 0, '退出后回到登录页');
  await page.screenshot({ path: shots + '/09-logout.png', fullPage: true });

  // 11. 繁体检查（页面文本）
  const tradChars = '銷貨採購帳庫單據傳應營費損憑證幣別類倉戶員碼權維護異動過沖讓贈稅額計刪儲匯還遷調滯週轉淨進開報價訂審認確備';
  let found = [];
  for (const ch of tradChars) {
    if (bodyText.includes(ch)) found.push(ch);
  }
  check(found.length === 0, '页面无繁体字' + (found.length ? ' 发现:' + found.join('') : ''));

  // 12. 控制台错误
  check(errors.length === 0, '无控制台错误' + (errors.length ? '\n' + errors.join('\n') : ''));

  console.log(`\n== 冒烟测试: ${pass} 通过, ${fail} 失败 ==`);
  if (errors.length) console.log('控制台错误:\n' + errors.join('\n'));
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
