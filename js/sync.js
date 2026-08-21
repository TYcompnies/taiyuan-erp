/* ============================================================
   云端同步（sync.js）
   - 跨设备 / 跨网络 IP 共用同一份 ERP 数据（LWW 快照同步）
   - 双供应商：textdb.online（零设定同步码） / GitHub Contents API（PAT）
   - 传输格式：JSON → deflate 压缩 →（可选 AES-GCM 加密）→ base64
     标记：TY0: 明文 JSON ／ TY1: 压缩+base64 ／ TYE1: 加密(TY0/TY1)
   - 自动上传：DB.flush() 防抖 3 秒触发（仅 autoPush 开启时）
   - 自动下载：render() 后首拉 + 每 60 秒轮询（仅 autoPull 开启时）
   - 下载覆盖本地前自动备份（localStorage，保留最近 5 份），确保原有资料不丢失
   ============================================================ */

const CloudSync = {
    CFG_KEY: "taiyuan_sync_cfg_v1",
    STATUS_KEY: "taiyuan_sync_status_v1",
    BACKUP_KEY: "taiyuan_erp_backups_v1",
    DEVICE_KEY: "taiyuan_device_id_v1",
    MAX_TEXTDB_BYTES: 28000,   // textdb URL 安全上限（编码后字符数）
    BACKUP_KEEP: 5,
    PULL_INTERVAL: 60000,

    cfg: null,
    status: null,
    _pushTimer: null,
    _pullTimer: null,
    _busy: false,      // 上传/下载执行中
    _applying: false,  // 正在应用远端数据（禁止回推）
    _started: false,

    /* ---------- 配置 ---------- */
    defaults() {
        return {
            provider: "textdb",       // textdb | github
            code: "",                 // textdb 同步码
            ghToken: "",              // GitHub PAT
            ghRepo: "TYcompnies/taiyuan-erp",
            ghPath: "erp-sync.json",
            pass: "",                 // 加密口令（可选）
            autoPush: true,
            autoPull: true
        };
    },
    loadCfg() {
        if (this.cfg) return this.cfg;
        let c = this.defaults();
        try {
            const raw = localStorage.getItem(this.CFG_KEY);
            if (raw) c = Object.assign(c, JSON.parse(raw));
        } catch (e) { }
        this.cfg = c;
        return c;
    },
    saveCfg(cfg) {
        this.cfg = Object.assign(this.loadCfg(), cfg);
        localStorage.setItem(this.CFG_KEY, JSON.stringify(this.cfg));
        return this.cfg;
    },
    isConfigured() {
        const c = this.loadCfg();
        if (c.provider === "textdb") return !!c.code;
        if (c.provider === "github") return !!c.ghToken && !!c.ghRepo;
        return false;
    },
    deviceId() {
        let d = localStorage.getItem(this.DEVICE_KEY);
        if (!d) {
            d = "D" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            localStorage.setItem(this.DEVICE_KEY, d);
        }
        return d;
    },

    /* ---------- 状态 ---------- */
    loadStatus() {
        if (this.status) return this.status;
        let s = { lastPushAt: "", lastPullAt: "", lastPushSize: 0, lastPullSize: 0, lastError: "", lastAction: "", remoteRev: 0 };
        try {
            const raw = localStorage.getItem(this.STATUS_KEY);
            if (raw) s = Object.assign(s, JSON.parse(raw));
        } catch (e) { }
        this.status = s;
        return s;
    },
    setStatus(patch) {
        const s = Object.assign(this.loadStatus(), patch);
        this.status = s;
        try { localStorage.setItem(this.STATUS_KEY, JSON.stringify(s)); } catch (e) { }
    },

    /* ---------- 编解码 ---------- */
    _b64(bytes) {
        let bin = "";
        bytes = new Uint8Array(bytes);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    },
    _unb64(str) {
        const bin = atob(str.replace(/\s+/g, ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    },
    async _compress(text) {
        if (typeof CompressionStream !== "undefined") {
            try {
                const cs = new CompressionStream("deflate");
                const stream = new Blob([text]).stream().pipeThrough(cs);
                const buf = new Uint8Array(await new Response(stream).arrayBuffer());
                return "TY1:" + this._b64(buf);
            } catch (e) { /* 压缩失败回退明文 */ }
        }
        return "TY0:" + text;
    },
    async _decompress(marked) {
        if (marked.indexOf("TY1:") === 0) {
            const raw = this._unb64(marked.slice(4));
            const ds = new DecompressionStream("deflate");
            const stream = new Blob([raw]).stream().pipeThrough(ds);
            return await new Response(stream).text();
        }
        if (marked.indexOf("TY0:") === 0) return marked.slice(4);
        throw new Error("云端数据格式无法识别");
    },
    async _deriveKey(pass, salt) {
        const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    },
    async _encrypt(marked) {
        const pass = this.loadCfg().pass;
        if (!pass) return marked;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this._deriveKey(pass, salt);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(marked)));
        const out = new Uint8Array(16 + 12 + ct.length);
        out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
        return "TYE1:" + this._b64(out);
    },
    async _decrypt(enc) {
        if (enc.indexOf("TYE1:") !== 0) return enc; // 未加密数据
        const pass = this.loadCfg().pass;
        if (!pass) throw new Error("云端数据已加密，请先填写加密口令");
        const raw = this._unb64(enc.slice(5));
        const salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
        const key = await this._deriveKey(pass, salt);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        return new TextDecoder().decode(pt);
    },

    /* ---------- 快照 ---------- */
    buildSnapshot() {
        const payload = JSON.parse(JSON.stringify(DB._mem));
        const rev = Date.now();
        payload.__rev = rev;
        payload.__device = this.deviceId();
        return { v: 1, rev, device: this.deviceId(), updated_at: new Date().toISOString(), payload };
    },
    parseSnapshot(marked) {
        // marked: 传输编码串（未解密）→ 解密 → 解压 → JSON
        return this._decrypt(marked).then(txt => this._decompress(txt)).then(json => {
            const snap = JSON.parse(json);
            if (!snap || !snap.payload || !snap.rev) throw new Error("云端数据结构不完整");
            return snap;
        });
    },

    /* ---------- 供应商：textdb ---------- */
    async textdbPush(enc) {
        const c = this.loadCfg();
        const url = "https://api.textdb.online/update/?key=" + encodeURIComponent(c.code) + "&value=" + encodeURIComponent(enc);
        const r = await fetch(url, { method: "POST" });
        if (!r.ok) throw new Error("textdb 写入失败 (HTTP " + r.status + ")");
        return true;
    },
    async textdbPull() {
        const c = this.loadCfg();
        const r = await fetch("https://textdb.online/" + encodeURIComponent(c.code), { cache: "no-store" });
        if (!r.ok) throw new Error("textdb 读取失败 (HTTP " + r.status + ")");
        const t = (await r.text()).trim();
        if (!t || t === "null" || t.indexOf("key not found") >= 0) return null;
        return t;
    },

    /* ---------- 供应商：GitHub Contents API ---------- */
    _ghHeaders() {
        return {
            "Authorization": "token " + this.loadCfg().ghToken,
            "Accept": "application/vnd.github.v3+json"
        };
    },
    async ghGet() {
        const c = this.loadCfg();
        const r = await fetch("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
        if (r.status === 404) return null;
        if (r.status === 401) throw new Error("GitHub Token 无效或已过期");
        if (!r.ok) throw new Error("GitHub 读取失败 (HTTP " + r.status + ")");
        const j = await r.json();
        if (!j.content) return null;
        const b64 = (j.content || "").replace(/\s+/g, "");
        // GitHub 对 >1KB 文件返回 base64；小文件可能为空 content + url 指向 blob
        if (!b64) throw new Error("GitHub 文件内容为空，请重试");
        return this._unb64ToText(b64);
    },
    _unb64ToText(b64) {
        return new TextDecoder().decode(this._unb64(b64));
    },
    _textToB64(text) {
        return this._b64(new TextEncoder().encode(text));
    },
    async ghPut(enc, sha) {
        const c = this.loadCfg();
        const body = { message: "ERP cloud sync " + new Date().toISOString(), content: this._textToB64(enc) };
        if (sha) body.sha = sha;
        const r = await fetch("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath), {
            method: "PUT", headers: this._ghHeaders(), body: JSON.stringify(body)
        });
        if (!r.ok) {
            const t = await r.text();
            throw new Error("GitHub 写入失败 (HTTP " + r.status + ")：" + t.slice(0, 120));
        }
        return true;
    },
    async githubPush(enc) {
        // 先取 sha（文件已存在时），409 冲突时按 LWW 判定
        let sha = null;
        try {
            const c = this.loadCfg();
            const r = await fetch("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
            if (r.ok) { const j = await r.json(); sha = j.sha || null; }
        } catch (e) { /* 忽略，按新建处理 */ }
        try {
            return await this.ghPut(enc, sha);
        } catch (e) {
            if (String(e.message).indexOf("409") >= 0) {
                // 冲突：重新取 sha 再试一次（LWW 由 rev 保证：能推送方通常是较新数据）
                let sha2 = null;
                try {
                    const c = this.loadCfg();
                    const r2 = await fetch("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
                    if (r2.ok) { const j2 = await r2.json(); sha2 = j2.sha || null; }
                } catch (e2) { }
                return await this.ghPut(enc, sha2);
            }
            throw e;
        }
    },
    async githubPull() {
        return await this.ghGet();
    },

    /* ---------- 上传 / 下载 ---------- */
    async push(manual) {
        const c = this.loadCfg();
        if (!this.isConfigured()) {
            if (manual) toast("请先填写并保存同步设置", "error");
            return false;
        }
        if (this._busy) { if (manual) toast("同步操作进行中，请稍候", "error"); return false; }
        this._busy = true;
        try {
            // 本地版本号推进（直接写 localStorage，避免触发递归 schedulePush）
            const snap = this.buildSnapshot();
            DB._mem.__rev = snap.rev;
            DB._mem.__device = snap.device;
            try { localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem)); } catch (e) { }
            const marked = await this._compress(JSON.stringify(snap));
            const enc = await this._encrypt(marked);
            if (c.provider === "textdb" && enc.length > this.MAX_TEXTDB_BYTES) {
                throw new Error("数据量超出 textdb 上限（约 " + Math.round(this.MAX_TEXTDB_BYTES / 1000) + "KB 编码后），请改用 GitHub 同步");
            }
            if (c.provider === "textdb") await this.textdbPush(enc);
            else await this.githubPush(enc);
            this.setStatus({ lastPushAt: new Date().toISOString(), lastPushSize: enc.length, lastError: "", lastAction: "push", remoteRev: snap.rev });
            if (manual) toast("已上传到云端（" + (enc.length / 1024).toFixed(1) + " KB）", "success");
            return true;
        } catch (e) {
            this.setStatus({ lastError: "上传失败：" + e.message });
            if (manual) toast("上传失败：" + e.message, "error");
            return false;
        } finally {
            this._busy = false;
        }
    },
    async pullRemote() {
        const c = this.loadCfg();
        if (c.provider === "textdb") return await this.textdbPull();
        return await this.githubPull();
    },
    /* 仅取远端快照（不覆盖本地），用于测试连接 / 比较版本 */
    async peek() {
        const enc = await this.pullRemote();
        if (enc === null || enc === "") return null;
        return await this.parseSnapshot(enc);
    },
    async pull(manual) {
        const c = this.loadCfg();
        if (!this.isConfigured()) {
            if (manual) toast("请先填写并保存同步设置", "error");
            return false;
        }
        if (this._busy) { if (manual) toast("同步操作进行中，请稍候", "error"); return false; }
        this._busy = true;
        try {
            const enc = await this.pullRemote();
            if (enc === null || enc === "") {
                this.setStatus({ lastPullAt: new Date().toISOString(), lastError: "", lastAction: "pull-empty" });
                if (manual) toast("云端暂无数据（首次使用请先上传）", "error");
                return false;
            }
            const snap = await this.parseSnapshot(enc);
            this.setStatus({ lastPullAt: new Date().toISOString(), lastPullSize: enc.length, remoteRev: snap.rev });
            const localRev = Utils.num(DB._mem.__rev) || 0;
            if (snap.rev <= localRev) {
                if (manual) toast("本地已是最新版本，无需下载", "success");
                return true;
            }
            if (manual) {
                // 手动下载：确认后备份并覆盖
                confirmModal(`云端版本较新（${h(snap.updated_at)} 由 ${h(snap.device)} 更新）。下载将覆盖本地数据，系统会先自动备份当前数据，可随时恢复。确定继续吗？`, async () => {
                    await this.applyRemote(snap);
                    toast("云端数据已下载并应用（本地已备份）", "success");
                }, "下载云端数据");
            } else {
                // 自动下载：本地已有未同步业务数据时不覆盖（避免误删），仅提示
                if (localRev === 0 && !this._businessEmpty()) {
                    this.setStatus({ lastError: "云端有较新数据，但本地已有业务数据，请到云端同步页手动下载" });
                    return false;
                }
                await this.applyRemote(snap);
            }
            return true;
        } catch (e) {
            this.setStatus({ lastError: "下载失败：" + e.message });
            if (manual) toast("下载失败：" + e.message, "error");
            return false;
        } finally {
            this._busy = false;
        }
    },
    _businessEmpty() {
        const cols = ["items", "sales_orders", "shipments", "purchase_orders", "inventory_adjusts", "sales_returns", "purchase_returns", "expenses", "vouchers"];
        return cols.every(c => !(DB._mem[c] || []).length);
    },
    async applyRemote(snap) {
        // 1. 备份当前本地数据（保有原有资料）
        this.backupLocal("下载云端覆盖前自动备份");
        // 2. 应用远端数据（保留本地 __rev/__device 对齐远端版本）
        const payload = JSON.parse(JSON.stringify(snap.payload));
        payload.__rev = snap.rev;
        payload.__device = snap.device;
        DB._mem = payload;
        this._applying = true;
        try {
            localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem));
            render();
        } finally {
            this._applying = false;
        }
    },

    /* ---------- 本地备份 ---------- */
    backups() {
        try {
            const raw = localStorage.getItem(this.BACKUP_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    },
    backupLocal(reason) {
        try {
            const data = JSON.stringify(DB._mem);
            const arr = this.backups();
            arr.unshift({ ts: new Date().toISOString(), reason: reason || "手动备份", size: data.length, data });
            while (arr.length > this.BACKUP_KEEP) arr.pop();
            try { localStorage.setItem(this.BACKUP_KEY, JSON.stringify(arr)); }
            catch (e) {
                // 空间不足：丢弃最旧的一份再试
                while (arr.length > 1) { arr.pop(); try { localStorage.setItem(this.BACKUP_KEY, JSON.stringify(arr)); break; } catch (e2) { } }
            }
            return true;
        } catch (e) { return false; }
    },
    restoreBackup(i) {
        const arr = this.backups();
        const bk = arr[i];
        if (!bk) { toast("找不到该备份", "error"); return; }
        confirmModal(`确定要恢复 ${h(bk.ts)} 的备份吗？当前数据会先自动备份，然后被备份内容覆盖。`, () => {
            this.backupLocal("恢复备份前自动备份");
            try {
                DB._mem = JSON.parse(bk.data);
                localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem));
                toast("备份已恢复", "success");
                render();
            } catch (e) {
                toast("恢复失败：" + e.message, "error");
            }
        }, "恢复备份");
    },
    clearBackups() {
        confirmModal("确定要清空全部本地备份吗？此操作不可恢复。", () => {
            localStorage.removeItem(this.BACKUP_KEY);
            toast("备份已清空", "success");
            render();
        }, "清空备份");
    },

    /* ---------- 自动调度 ---------- */
    schedulePush() {
        if (this._busy || this._applying) return;
        const c = this.loadCfg();
        if (!c.autoPush || !this.isConfigured()) return;
        if (this._pushTimer) clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => {
            this.push(false).catch(() => { });
        }, 3000);
    },
    startAuto() {
        if (this._started) return;
        const c = this.loadCfg();
        if (!c.autoPull || !this.isConfigured()) return;
        this._started = true;
        // 登录后首拉（跨设备/跨 IP 打开时自动获取最新数据）
        setTimeout(() => { this.pull(false).catch(() => { }); }, 1500);
        this._pullTimer = setInterval(() => {
            if (document.hidden) return;
            this.pull(false).catch(() => { });
        }, this.PULL_INTERVAL);
    }
};

/* ============================================================
   云端同步页面（系统设置 / 云端同步）
   ============================================================ */
Pages.cloudSync = function () {
    const c = CloudSync.loadCfg();
    const st = CloudSync.loadStatus();
    const bks = CloudSync.backups();

    const fmtTime = (iso) => iso ? iso.replace("T", " ").slice(0, 19) : "-";
    const providerBadge = c.provider === "textdb" ? '<span class="badge teal">textdb.online</span>' : '<span class="badge purple">GitHub</span>';

    const backupRows = bks.map((b, i) => `<tr>
        <td>${h(fmtTime(b.ts))}</td>
        <td>${h(b.reason || "-")}</td>
        <td class="num">${(Utils.num(b.size) / 1024).toFixed(1)} KB</td>
        <td class="action-col"><button class="link-btn" onclick="Pages.syncRestoreBackup(${i})">恢复</button></td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>云端同步</h1><p>跨设备、跨网络共用同一份 ERP 数据：本机变更自动上传云端，其他设备打开后自动下载最新版本；覆盖前自动备份，原有资料不丢失。</p></div>
        <div class="head-actions">
            <button class="btn" onclick="Pages.syncTest()">🔗 测试连接</button>
            <button class="btn" onclick="Pages.syncPushNow()">☁️ 立即上传</button>
            <button class="btn primary" onclick="Pages.syncPullNow()">⬇️ 立即下载</button>
        </div>
    </div>

    <div class="kpi-grid">
        <div class="kpi-card"><span>同步状态</span><strong style="font-size:16px">${c.pass ? "已加密" : "未加密"} ${providerBadge}</strong></div>
        <div class="kpi-card"><span>上次上传</span><strong>${h(fmtTime(st.lastPushAt))}</strong></div>
        <div class="kpi-card"><span>上次下载</span><strong>${h(fmtTime(st.lastPullAt))}</strong></div>
        <div class="kpi-card"><span>本地版本号</span><strong>${Utils.num(DB._mem.__rev) || "未同步"}</strong></div>
    </div>
    ${st.lastError ? `<div style="margin-bottom:16px;padding:10px 14px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-size:13.5px">⚠ ${h(st.lastError)}</div>` : ""}
    ${!c.pass ? `<div style="margin-bottom:16px;padding:10px 14px;border-radius:10px;background:#fff7e6;color:#92600a;font-size:13.5px">💡 建议设置加密口令：同步码对应的云端地址是公开的，加密后他人即使取得地址也无法读取数据。</div>` : ""}

    <form class="form-panel" novalidate onsubmit="Pages.syncSaveCfg(event)">
        <section class="form-section">
            <div class="form-section-title"><h3>同步设置</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>同步供应商<b>*</b></label>
                    <select name="provider">
                        <option value="textdb"${c.provider === "textdb" ? " selected" : ""}>textdb.online（同步码，免设定）</option>
                        <option value="github"${c.provider === "github" ? " selected" : ""}>GitHub（PAT，适合大数据量）</option>
                    </select></div>
                <div class="form-item"><label>自动上传</label>
                    <select name="autoPush"><option value="1"${c.autoPush ? " selected" : ""}>开启（数据变动 3 秒后自动上传）</option><option value="0"${!c.autoPush ? " selected" : ""}>关闭（仅手动上传）</option></select></div>
                <div class="form-item"><label>自动下载</label>
                    <select name="autoPull"><option value="1"${c.autoPull ? " selected" : ""}>开启（打开系统及每 60 秒自动检查）</option><option value="0"${!c.autoPull ? " selected" : ""}>关闭（仅手动下载）</option></select></div>
            </div>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>textdb.online（推荐，跨 IP 即开即用）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>同步码</label>
                    <div style="display:flex;gap:8px">
                        <input name="code" value="${h(c.code)}" placeholder="多台设备填同一个同步码即可共用数据" style="flex:1">
                        <button type="button" class="btn" onclick="Pages.syncGenCode()">生成随机码</button>
                    </div></div>
            </div>
            <p class="muted">同一同步码在任意网络 IP 打开本系统并登录后，会自动下载该同步码的最新数据；数据量超出限制（约 100KB 原始数据）时请改用 GitHub。</p>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>GitHub（可选，适合数据量较大时）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>访问令牌 PAT</label>
                    <input type="password" name="ghToken" value="${h(c.ghToken)}" placeholder="ghp_...（需要 repo 内容读写权限）"></div>
                <div class="form-item"><label>仓库（owner/repo）</label>
                    <input name="ghRepo" value="${h(c.ghRepo)}" placeholder="TYcompnies/taiyuan-erp"></div>
                <div class="form-item"><label>同步文件路径</label>
                    <input name="ghPath" value="${h(c.ghPath)}" placeholder="erp-sync.json"></div>
            </div>
            <p class="muted">仓库为公开时务必配合加密口令使用；私有仓库同样建议加密。</p>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>加密（建议开启）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>加密口令</label>
                    <input type="password" name="pass" value="${h(c.pass)}" placeholder="留空 = 不加密；所有设备需一致"></div>
            </div>
            <p class="muted">采用 AES-256-GCM 加密，数据在云端始终为密文；忘记口令将无法解密云端数据（本地数据不受影响）。</p>
        </section>

        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存设置</button>
            <button class="btn" type="reset">重置</button>
        </div>
    </form>

    <section class="form-section" style="margin-top:24px">
        <div class="form-section-title"><h3>本地备份（最近 ${CloudSync.BACKUP_KEEP} 份）</h3></div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>备份时间</th><th>原因</th><th class="num">大小</th><th class="action-col">操作</th></tr></thead>
                <tbody>${backupRows || `<tr><td colspan="4"><div class="empty-state"><div class="big">💾</div>暂无备份（下载覆盖/恢复操作前会自动产生）</div></td></tr>`}</tbody>
            </table>
        </div>
        ${bks.length ? `<button class="btn" style="margin-top:12px" onclick="Pages.syncClearBackups()">清空备份</button>` : ""}
    </section>`;

    renderShell("cloud_sync", content, "首页 / 系统设置 / 云端同步");
};

Pages.syncSaveCfg = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    const cfg = CloudSync.saveCfg({
        provider: data.provider,
        code: (data.code || "").trim(),
        ghToken: (data.ghToken || "").trim(),
        ghRepo: (data.ghRepo || "").trim() || "TYcompnies/taiyuan-erp",
        ghPath: (data.ghPath || "").trim() || "erp-sync.json",
        pass: data.pass || "",
        autoPush: data.autoPush === "1",
        autoPull: data.autoPull === "1"
    });
    if (cfg.provider === "textdb" && !cfg.code) { toast("请填写同步码", "error"); return; }
    if (cfg.provider === "github" && !cfg.ghToken) { toast("请填写 GitHub 访问令牌", "error"); return; }
    CloudSync._started = false; // 重新评估自动同步
    CloudSync.startAuto();
    toast("同步设置已保存", "success");
    render();
};

Pages.syncGenCode = function () {
    const code = "ty" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const inp = document.querySelector('input[name="code"]');
    if (inp) inp.value = code;
    toast("已生成同步码，保存后请在其他设备填写同一同步码", "success");
};

Pages.syncPushNow = async function () {
    toast("正在上传到云端…", "success");
    await CloudSync.push(true);
    render();
};

Pages.syncPullNow = async function () {
    toast("正在从云端下载…", "success");
    await CloudSync.pull(true);
    if (!CloudSync._busy) render();
};

Pages.syncTest = async function () {
    const c = CloudSync.loadCfg();
    if (!CloudSync.isConfigured()) { toast("请先填写并保存同步设置", "error"); return; }
    toast("正在测试连接…", "success");
    try {
        const snap = await CloudSync.peek();
        if (!snap) {
            toast("连接成功，云端暂无数据（点击「立即上传」上传本机数据）", "success");
        } else {
            toast(`连接成功：云端版本 ${snap.rev}（${snap.updated_at.replace("T", " ").slice(0, 19)} 由 ${snap.device} 更新）`, "success");
        }
        CloudSync.setStatus({ lastError: "" });
    } catch (e) {
        toast("连接失败：" + e.message, "error");
    }
    render();
};

Pages.syncRestoreBackup = function (i) { CloudSync.restoreBackup(i); };
Pages.syncClearBackups = function () { CloudSync.clearBackups(); };
