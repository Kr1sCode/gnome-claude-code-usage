import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Same OAuth surface Claude Code's CLI itself uses; discovered by reading the
// reference extensions listed on extensions.gnome.org (dvdstelt/ClaudeCodeUsage).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA_HEADER = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';
const USAGE_PAGE_URL = 'https://claude.ai/settings/usage';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const POLL_SECONDS = 120;
const MIN_REFRESH_MS = 30 * 1000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

function readCredentials() {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(credentialsPath());
        file.load_contents_async(null, (f, res) => {
            try {
                const [ok, data] = f.load_contents_finish(res);
                if (!ok) {
                    resolve(null);
                    return;
                }
                const root = JSON.parse(decoder.decode(data));
                resolve(root?.claudeAiOauth?.accessToken ? root : null);
            } catch {
                resolve(null);
            }
        });
    });
}

function writeCredentials(root) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(credentialsPath());
        const data = encoder.encode(JSON.stringify(root, null, 2));
        file.replace_contents_bytes_async(
            new GLib.Bytes(data), null, false,
            Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

class UsageError extends Error {
    constructor(message, status = 0, retryAfterSeconds = 0) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

class SignedOutError extends UsageError {
    constructor() {
        super('Brak zalogowania Claude Code (~/.claude/.credentials.json)', 401);
        this.name = 'SignedOutError';
    }
}

class UsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 15;
        this._tokenPromise = null;
    }

    _request(method, url, {token, jsonBody} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            const headers = msg.get_request_headers();
            headers.append('anthropic-beta', BETA_HEADER);
            headers.append('anthropic-version', API_VERSION);
            headers.append('Accept', 'application/json');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);
            if (jsonBody !== undefined) {
                const raw = encoder.encode(JSON.stringify(jsonBody));
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
            }
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        const retryAfter = Number(msg.get_response_headers().get_one('Retry-After')) || 0;
                        reject(new UsageError(`HTTP ${status} z ${url}`, status, retryAfter));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _refreshToken(root) {
        const oauth = root.claudeAiOauth;
        let data;
        try {
            data = await this._request('POST', TOKEN_URL, {
                jsonBody: {grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID},
            });
        } catch (e) {
            // Duck-typed on .status rather than `instanceof UsageError`: GNOME's
            // extension loader can end up with two live copies of this module
            // (old instance tearing down, new one starting), and errors thrown
            // by one don't pass instanceof checks against the other's class.
            if (e?.status === 400 || e?.status === 401)
                throw new UsageError('Sesja wygasła — zaloguj się ponownie w Claude Code', 401);
            throw e;
        }
        if (!data.access_token)
            throw new UsageError('Brak access_token w odpowiedzi odświeżania');
        oauth.accessToken = data.access_token;
        if (data.refresh_token)
            oauth.refreshToken = data.refresh_token;
        if (data.expires_in)
            oauth.expiresAt = Date.now() + data.expires_in * 1000;
        await writeCredentials(root);
        return oauth.accessToken;
    }

    _validToken() {
        if (!this._tokenPromise) {
            this._tokenPromise = this._resolveToken()
                .finally(() => (this._tokenPromise = null));
        }
        return this._tokenPromise;
    }

    async _resolveToken() {
        const root = await readCredentials();
        if (!root)
            throw new SignedOutError();
        const oauth = root.claudeAiOauth;
        const expiresAt = Number(oauth.expiresAt) || 0;
        if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
            return oauth.accessToken;
        return this._refreshToken(root);
    }

    async fetchUsage() {
        const token = await this._validToken();
        return this._request('GET', USAGE_URL, {token});
    }
}

// Reduces the API's self-describing limits[] array to the two windows this
// compact tile cares about: the rolling 5-hour session and the 7-day (all
// models) window. Scoped per-model 7-day windows are left out to keep the
// quick-settings tile short; the full breakdown lives on claude.ai/settings/usage.
function normalizeWindows(usage) {
    const limits = Array.isArray(usage?.limits) ? usage.limits : [];
    const out = [];
    for (const l of limits) {
        if (l?.percent == null || !Number.isFinite(Number(l.percent)))
            continue;
        let label = null;
        if (l.kind === 'session')
            label = 'Sesja (5h)';
        else if (l.kind === 'weekly_all')
            label = 'Tydzień (7d)';
        if (!label)
            continue;
        out.push({
            key: l.kind,
            label,
            percent: Number(l.percent),
            resetsAt: l.resets_at ?? null,
            severity: l.severity ?? 'normal',
        });
    }
    return out;
}

function relativeReset(iso) {
    const t = Date.parse(iso ?? '');
    if (Number.isNaN(t))
        return '';
    const diff = t - Date.now();
    if (diff <= 0)
        return 'reset teraz';
    const mins = Math.round(diff / 60000);
    if (mins < 60)
        return `reset za ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `reset za ${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `reset za ${days}d ${hrs % 24}h`;
}

function levelClass(percent, severity) {
    if (severity === 'critical' || percent >= 90)
        return 'crit';
    if (severity === 'warning' || percent >= 75)
        return 'warn';
    return 'ok';
}

// One profile's session/weekly percentages as a single compact panel
// subtitle, e.g. "37% 5h · 12% 7d".
function panelSubtitle(windows) {
    if (!windows.length)
        return '—';
    return windows.map(w => `${Math.round(w.percent)}% ${w.key === 'session' ? '5h' : '7d'}`).join(' · ');
}

const ClaudeUsageToggle = GObject.registerClass(
class ClaudeUsageToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: 'Claude Code',
            subtitle: 'Ładowanie…',
            iconName: 'utilities-terminal-symbolic',
            toggleMode: false,
        });

        this.menu.setHeader('utilities-terminal-symbolic', 'Claude Code — użycie', '');

        this._metersSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._metersSection);
        this._meterItems = new Map();

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'claude-usage-status'});
        this._statusItem.visible = false;
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Odśwież teraz', () => this._refresh(true));
        this.menu.addAction('Otwórz stronę użycia', () => {
            Gio.AppInfo.launch_default_for_uri(USAGE_PAGE_URL, null);
        });

        this._client = new UsageClient();
        this._busy = false;
        this._lastFetchMs = 0;
        this._timerId = null;
        this._hasData = false;
        this._backoffUntilMs = 0;
        this._consecutive429 = 0;

        this.connect('clicked', () => this._refresh());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        });
        this.connect('destroy', () => this._onDestroy());

        this._refresh(true);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onDestroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _refresh(force = false) {
        if (this._busy)
            return;
        if (Date.now() < this._backoffUntilMs)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();
        this._client.fetchUsage()
            .then(usage => this._render(usage))
            .catch(e => this._renderError(e))
            .finally(() => (this._busy = false));
    }

    _ensureMeter(key, label) {
        let item = this._meterItems.get(key);
        if (item)
            return item;
        item = new PopupMenu.PopupMenuItem('', {reactive: false});
        item.label.text = '';
        this._metersSection.addMenuItem(item);
        this._meterItems.set(key, item);
        return item;
    }

    _render(usage) {
        this._statusItem.visible = false;
        const windows = normalizeWindows(usage);

        const seen = new Set();
        for (const w of windows) {
            seen.add(w.key);
            const item = this._ensureMeter(w.key, w.label);
            const pct = Math.round(w.percent);
            const cls = levelClass(w.percent, w.severity);
            item.label.text = `${w.label}: ${pct}% — ${relativeReset(w.resetsAt)}`;
            item.label.style_class = `claude-usage-meter claude-usage-${cls}`;
        }
        for (const [key, item] of this._meterItems) {
            if (!seen.has(key)) {
                item.destroy();
                this._meterItems.delete(key);
            }
        }

        this.subtitle = panelSubtitle(windows);
        const worst = windows.reduce((a, b) => (b.percent > (a?.percent ?? -1) ? b : a), null);
        this.checked = false;
        if (worst)
            this._panelLevel = levelClass(worst.percent, worst.severity);
        this._hasData = true;
        this._consecutive429 = 0;
        this._backoffUntilMs = 0;
    }

    _renderError(e) {
        if (e?.name === 'SignedOutError') {
            this.subtitle = 'Niezalogowany';
            this._statusItem.label.text = 'Zaloguj się w Claude Code (claude /login), aby zobaczyć limity.';
            this._statusItem.visible = true;
            return;
        }
        if (e?.status === 429) {
            this._consecutive429 += 1;
            const backoffSeconds = e.retryAfterSeconds > 0
                ? e.retryAfterSeconds
                : Math.min(600, 30 * 2 ** (this._consecutive429 - 1));
            this._backoffUntilMs = Date.now() + backoffSeconds * 1000;
            if (this._hasData) {
                logError(e, `claude-quick-settings: rate limited, backing off ${backoffSeconds}s, keeping last values`);
                return;
            }
            logError(e, `claude-quick-settings: rate limited, backing off ${backoffSeconds}s`);
        } else {
            logError(e, 'claude-quick-settings: refresh failed');
        }
        this.subtitle = 'Błąd';
        const msg = String(e?.message ?? e);
        this._statusItem.label.text = msg;
        this._statusItem.visible = true;
    }
});

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._toggle = new ClaudeUsageToggle();
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ClaudeQuickSettingsExtension extends Extension {
    enable() {
        this._indicator = new ClaudeUsageIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
