/* =========================================================
 * 外贸记账财务系统（外挂嵌入页）
 * 「41大叔外贸记账系统」为独立部署的外部复式记账 SPA：
 * - 免登录：开启即用，任何网域/装置开启即自动同步（MQTT 即时云同步，无需同步码）
 * - 独立云端帐本（凭证/科目/财务报表/损益图表/出口退税），与 ERP 本地数据完全隔离
 * - 本页仅负责在 ERP 框架内以 iframe 嵌入展示，不改动该系统任何逻辑
 * - 若系统网址日后更换，只需修改下方 BOOKKEEPING_URL
 * ========================================================= */

const BOOKKEEPING_URL = "https://95d7803cee5b42be927e0212e9f5ebb1.app.workbuddy.link/";

Pages.bookkeepingPage = function () {
    const html = `
    <div class="bk-embed">
        <div class="bk-toolbar">
            <div class="bk-toolbar-info">
                <strong>41大叔外贸记账系统（复式记账）</strong>
                <span>免登录直接使用 · 凭证/科目/财务报表/损益图表 · MQTT 即时云同步（所有装置读写同一份云端帐本）</span>
            </div>
            <div class="bk-toolbar-actions">
                <a class="btn" href="${BOOKKEEPING_URL}" target="_blank" rel="noopener" title="在新窗口独立打开外贸记账系统">↗ 新窗口打开</a>
            </div>
        </div>
        <div class="bk-frame-wrap">
            <iframe id="bookkeepingFrame" src="${BOOKKEEPING_URL}" title="41大叔外贸记账系统"
                referrerpolicy="no-referrer-when-downgrade" allow="clipboard-write"></iframe>
        </div>
    </div>`;
    renderShell("finance.bookkeeping", html, "首页 / 账款财务 / 外贸记账");
};
